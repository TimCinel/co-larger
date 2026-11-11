/**
 * Zip writing and reading for projects (#12). No DOM; runs in the browser
 * and in Node, which is how the unit tests exercise it.
 *
 * Writing streams: each file is read in chunks, run through fflate's
 * streaming `Zip` with `ZipPassThrough` (the "store" method: no
 * recompression, just a CRC), and handed on as a ReadableStream, so memory
 * stays at a few chunks however large the photos are.
 *
 * Reading does not use fflate's readers, which want the whole archive in
 * memory as one array. It reads the end-of-central-directory record and the
 * central directory from the Blob (a few KB), checks every entry against
 * the limits before touching any data, and hands out each stored entry as a
 * Blob slice of the archive: zero copies, nothing in memory until a photo is
 * decoded. Entries stored with deflate are decompressed with the platform's
 * DecompressionStream, with a hard cap, so a zip bomb cannot expand. A
 * deflated photo is inflated once, by `inflateZipEntry`, which checks its
 * length and CRC-32 on the way and returns the bytes as a Blob.
 */
import { Zip, ZipPassThrough } from 'fflate';
import { BackingFileError } from '../photos/backing';
import { isSafePath, ProjectError } from './format';

/** What to put in the archive. */
export interface ZipSource {
  readonly path: string;
  readonly data: Blob;
  /** Ms since the epoch. The zip's DOS date can only say 1980 to 2099. */
  readonly lastModified: number;
}

/** Zips this build can write or read are below 4 GB (no ZIP64). */
export const MAX_ARCHIVE_BYTES = 0xffff_ffff;
/** Most entries a zip may have. */
export const MAX_ENTRIES = 10_000;
/** The central directory is read whole, so it is capped. */
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

const MIN_DOS_TIME = Date.UTC(1980, 0, 2);
const MAX_DOS_TIME = Date.UTC(2099, 11, 30);

export interface ZipStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Called as bytes of the sources have been read: `bytes` so far in total,
   * and `entry` the number of sources finished.
   */
  readonly onProgress?: (bytes: number, entry: number) => void;
}

/**
 * The archive as a stream of chunks: the files in the order given, each
 * stored without compression. Pulling is what reads the sources, so a slow
 * consumer slows the reading and memory stays bounded. Aborting (or
 * cancelling the stream) stops reading; the stream then errors with the
 * signal's reason.
 */
export function createZipStream(
  sources: readonly ZipSource[],
  options: ZipStreamOptions = {},
): ReadableStream<Uint8Array> {
  const { signal, onProgress } = options;
  let zip: Zip | null = null;
  let index = 0;
  let current: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    file: ZipPassThrough;
  } | null = null;
  let bytes = 0;

  const finish = (): void => {
    // Cancelling also ends a read that is still pending.
    void current?.reader.cancel().catch(() => undefined);
    current = null;
    zip?.terminate();
    zip = null;
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const output = new Zip((error, chunk, final) => {
          if (error) {
            controller.error(error);
            return;
          }
          if (chunk.length > 0) controller.enqueue(chunk);
          if (final) controller.close();
        });
        zip = output;
        // Stop at once, dropping what is queued, when aborted.
        signal?.addEventListener(
          'abort',
          () => {
            finish();
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          if (!zip) return;
          for (;;) {
            if (!current) {
              const source = sources[index];
              if (!source) {
                const done = zip;
                zip = null;
                done.end();
                return;
              }
              const file = new ZipPassThrough(source.path);
              file.mtime = Math.min(
                MAX_DOS_TIME,
                Math.max(MIN_DOS_TIME, source.lastModified),
              );
              zip.add(file);
              current = { reader: source.data.stream().getReader(), file };
            }
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await current.reader.read();
            } catch {
              signal?.throwIfAborted();
              // A photo's file cannot be read (moved, deleted, replaced):
              // the whole save fails, and nothing is kept.
              throw new BackingFileError();
            }
            const { value, done } = chunk;
            signal?.throwIfAborted();
            if (done) {
              current.file.push(new Uint8Array(0), true);
              current.reader.releaseLock();
              current = null;
              index++;
              onProgress?.(bytes, index);
              continue;
            }
            bytes += value.length;
            current.file.push(value, false);
            onProgress?.(bytes, index);
            // One chunk per pull keeps the consumer in charge of the pace.
            return;
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Collects a stream into one Blob, handing chunks to the Blob machinery as
 * they arrive (the browser keeps large Blobs outside the page's memory,
 * on disk when needed) instead of holding the whole archive as arrays.
 */
export async function streamToBlob(
  stream: ReadableStream<Uint8Array>,
  type = 'application/zip',
  flushBytes = 8 * 1024 * 1024,
): Promise<Blob> {
  const reader = stream.getReader();
  let parts: BlobPart[] = [];
  let pending = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value as Uint8Array<ArrayBuffer>);
      pending += value.length;
      if (pending >= flushBytes) {
        parts = [new Blob(parts)];
        pending = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(parts, { type });
}

/** One file in an archive being read. */
export interface ZipEntry {
  readonly path: string;
  /** 0 for stored, 8 for deflated; no other method is read. */
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  /** Where the entry's data starts in the archive. */
  readonly dataOffset: number;
  /** Ms since the epoch, from the DOS date (read as local time). */
  readonly lastModified: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

async function bytesAt(
  blob: Blob,
  start: number,
  length: number,
): Promise<DataView> {
  let buffer: ArrayBuffer;
  try {
    buffer = await blob.slice(start, start + length).arrayBuffer();
  } catch {
    throw new BackingFileError();
  }
  if (buffer.byteLength !== length) {
    throw new ProjectError('This zip file is truncated or damaged.');
  }
  return new DataView(buffer);
}

function dosTime(date: number, time: number): number {
  const year = 1980 + (date >> 9);
  const month = ((date >> 5) & 0xf) - 1;
  const day = date & 0x1f;
  // fflate (like most tools) writes the local time on the machine that
  // saved; read it back the same way.
  return new Date(
    year,
    Math.max(0, Math.min(11, month)),
    Math.max(1, day),
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime();
}

export const NOT_A_ZIP = 'This file is not a zip archive.';

/**
 * Lists the files in a zip archive, checking it first. Throws a ProjectError
 * for: not a zip; ZIP64 or an archive of 4 GB or more; encryption; a
 * method other than store and deflate; more than MAX_ENTRIES entries; an
 * entry whose name is unsafe (absolute, `..`, backslashes), repeated, or
 * whose data lies outside the archive; or a declared size over
 * `maxEntryBytes` (checked before anything is read, which is what stops a
 * zip bomb). Folders are skipped.
 */
export async function readZipDirectory(
  blob: Blob,
  maxEntryBytes: number,
): Promise<ZipEntry[]> {
  try {
    return await readDirectory(blob, maxEntryBytes);
  } catch (error) {
    if (error instanceof ProjectError || error instanceof BackingFileError) {
      throw error;
    }
    throw new ProjectError('This zip file is damaged.');
  }
}

async function readDirectory(
  blob: Blob,
  maxEntryBytes: number,
): Promise<ZipEntry[]> {
  if (blob.size < EOCD_SIZE) throw new ProjectError(NOT_A_ZIP);
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new ProjectError('This zip is too large (4 GB or more) to open.');
  }
  const tailLength = Math.min(blob.size, EOCD_SIZE + MAX_COMMENT);
  const tail = await bytesAt(blob, blob.size - tailLength, tailLength);
  let eocd = -1;
  for (let at = tailLength - EOCD_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    // The comment must fit in the file; anything after it is ignored.
    if (at + EOCD_SIZE + tail.getUint16(at + 20, true) <= tailLength) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ProjectError(NOT_A_ZIP);

  // A ZIP64 end-of-central-directory locator sits just before the record.
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    throw new ProjectError('This zip uses ZIP64, which is not supported.');
  }
  const count = tail.getUint16(eocd + 10, true);
  const directorySize = tail.getUint32(eocd + 12, true);
  const directoryOffset = tail.getUint32(eocd + 16, true);
  if (
    count === 0xffff ||
    directorySize === 0xffff_ffff ||
    directoryOffset === 0xffff_ffff
  ) {
    throw new ProjectError('This zip uses ZIP64, which is not supported.');
  }
  if (count > MAX_ENTRIES) {
    throw new ProjectError(
      `This zip has ${String(count)} files; the limit is ${String(MAX_ENTRIES)}.`,
    );
  }
  if (
    directorySize > MAX_DIRECTORY_BYTES ||
    directoryOffset + directorySize > blob.size - tailLength + eocd
  ) {
    throw new ProjectError('This zip file is damaged: bad directory.');
  }

  const directory = await bytesAt(blob, directoryOffset, directorySize);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (
      at + 46 > directorySize ||
      directory.getUint32(at, true) !== CENTRAL_SIGNATURE
    ) {
      throw new ProjectError('This zip file is damaged: bad directory entry.');
    }
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const time = directory.getUint16(at + 12, true);
    const date = directory.getUint16(at + 14, true);
    const crc = directory.getUint32(at + 16, true);
    const compressedSize = directory.getUint32(at + 20, true);
    const size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const localOffset = directory.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directorySize) {
      throw new ProjectError('This zip file is damaged: bad directory entry.');
    }
    const path = decoder.decode(
      new Uint8Array(directory.buffer, at + 46, nameLength),
    );
    at = next;

    if (!isSafePath(path)) {
      throw new ProjectError(
        `This zip contains an unsafe file path: ${JSON.stringify(path.slice(0, 80))}.`,
      );
    }
    if (path.endsWith('/')) continue;
    if (seen.has(path)) {
      throw new ProjectError(`This zip lists "${path}" twice.`);
    }
    seen.add(path);
    if (flags & 1)
      throw new ProjectError('This zip is encrypted, which is not supported.');
    if (method !== 0 && method !== 8) {
      throw new ProjectError(
        `This zip uses an unsupported compression method for "${path}".`,
      );
    }
    if (size > maxEntryBytes) {
      throw new ProjectError(
        `"${path}" in this zip is too large (${String(size)} bytes declared).`,
      );
    }
    if (method === 0 && compressedSize !== size) {
      throw new ProjectError(
        `This zip file is damaged: "${path}" has inconsistent sizes.`,
      );
    }

    const local = await bytesAt(blob, localOffset, 30);
    if (local.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new ProjectError(
        `This zip file is damaged: bad header for "${path}".`,
      );
    }
    const dataOffset =
      localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (dataOffset + compressedSize > directoryOffset) {
      throw new ProjectError(
        `This zip file is damaged: "${path}" runs past the end of the data.`,
      );
    }
    entries.push({
      path,
      method,
      compressedSize,
      size,
      crc,
      dataOffset,
      lastModified: dosTime(date, time),
    });
  }
  return entries;
}

/**
 * The content of one entry as a Blob. A stored entry is a slice of the
 * archive (nothing is copied); a deflated one is decompressed, refusing to
 * produce more than its declared size.
 */
export async function readZipEntry(
  archive: Blob,
  entry: ZipEntry,
  type = '',
): Promise<Blob> {
  const raw = archive.slice(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  if (entry.method === 0) return type ? raw.slice(0, raw.size, type) : raw;
  const stream = raw
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > entry.size) {
        throw new ProjectError(
          `"${entry.path}" in this zip expands beyond its declared size.`,
        );
      }
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      `"${entry.path}" in this zip is damaged and cannot be unpacked.`,
    );
  }
  if (total !== entry.size) {
    throw new ProjectError(
      `"${entry.path}" in this zip is damaged: wrong size.`,
    );
  }
  return new Blob(parts as BlobPart[], { type });
}

/**
 * Inflates a deflated entry once, in a single streaming pass: the platform's
 * DecompressionStream does the inflating off the main thread, and each chunk
 * is counted and run through CRC-32 as it arrives and kept as it is. The
 * result is a Blob of exactly the entry's bytes, so a photo is never
 * inflated a second time to check it. Refuses (ProjectError) more bytes than
 * the entry declares, fewer, a CRC-32 mismatch, or a stream that is not valid
 * deflate; a BackingFileError if the archive cannot be read; and the
 * signal's reason if aborted. The caller bounds how much of this is held.
 */
export async function inflateZipEntry(
  archive: Blob,
  entry: ZipEntry,
  type = '',
  signal?: AbortSignal,
): Promise<Blob> {
  if (entry.method !== 8) throw new ProjectError(`"${entry.path}" is stored.`);
  const raw = archive.slice(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  const reader = raw
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const crc = new Crc32();
  let parts: BlobPart[] = [];
  let pending = 0;
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        signal?.throwIfAborted();
        // The compressed bytes were read from the archive; a failure here is
        // the stream being invalid, unless the archive itself went away.
        try {
          await archive
            .slice(entry.dataOffset, entry.dataOffset + 1)
            .arrayBuffer();
        } catch {
          throw new BackingFileError();
        }
        throw DAMAGED(entry.path);
      }
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > entry.size) throw DAMAGED(entry.path);
      crc.update(chunk.value);
      parts.push(chunk.value as Uint8Array<ArrayBuffer>);
      pending += chunk.value.length;
      if (pending >= INFLATE_FLUSH_BYTES) {
        // Fold small chunks into one Blob so the part list stays short.
        parts = [new Blob(parts)];
        pending = 0;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total !== entry.size || crc.value !== entry.crc) {
    throw DAMAGED(entry.path);
  }
  return new Blob(parts, { type });
}

const INFLATE_FLUSH_BYTES = 8 * 1024 * 1024;

/** An entry's content as text (UTF-8), for project.json. */
export async function readZipText(
  archive: Blob,
  entry: ZipEntry,
): Promise<string> {
  const blob = await readZipEntry(archive, entry);
  return new TextDecoder('utf-8').decode(await blob.arrayBuffer());
}

const CRC_TABLE = (() => {
  // Slicing-by-8: eight 256-entry tables, one per byte position.
  const table = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = table[n] as number;
    for (let k = 1; k < 8; k++) {
      c = (table[c & 255] as number) ^ (c >>> 8);
      table[k * 256 + n] = c;
    }
  }
  return table;
})();

/** A streaming CRC-32 (the zip checksum): feed chunks, then read `value`. */
export class Crc32 {
  private crc = 0xffff_ffff;

  update(data: Uint8Array): void {
    const t = CRC_TABLE;
    let c = this.crc;
    let i = 0;
    const end = data.length - 8;
    for (; i <= end; i += 8) {
      const a =
        c ^
        ((data[i] as number) |
          ((data[i + 1] as number) << 8) |
          ((data[i + 2] as number) << 16) |
          ((data[i + 3] as number) << 24));
      c =
        (t[1792 + (a & 255)] as number) ^
        (t[1536 + ((a >>> 8) & 255)] as number) ^
        (t[1280 + ((a >>> 16) & 255)] as number) ^
        (t[1024 + (a >>> 24)] as number) ^
        (t[768 + (data[i + 4] as number)] as number) ^
        (t[512 + (data[i + 5] as number)] as number) ^
        (t[256 + (data[i + 6] as number)] as number) ^
        (t[data[i + 7] as number] as number);
    }
    for (; i < data.length; i++) {
      c = (t[(c ^ (data[i] as number)) & 255] as number) ^ (c >>> 8);
    }
    this.crc = c >>> 0;
  }

  get value(): number {
    return (this.crc ^ 0xffff_ffff) >>> 0;
  }
}

export const DAMAGED = (path: string): ProjectError =>
  new ProjectError(
    `This project file is damaged: "${path}" does not match its checksum. Save it again from the original, or use a good copy.`,
  );

/**
 * Checks an entry's CRC-32 and size by streaming its content once, a chunk
 * at a time (a deflated entry is checked after decompression, never past
 * its declared size), so no photo is ever held in memory. Throws a
 * ProjectError for a mismatch, a BackingFileError if the archive cannot be
 * read, and the signal's reason if aborted.
 */
export async function checkZipEntry(
  archive: Blob,
  entry: ZipEntry,
  signal?: AbortSignal,
): Promise<void> {
  const raw = archive.slice(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let stream: ReadableStream<Uint8Array<ArrayBuffer>> = raw.stream();
  if (entry.method === 8) {
    stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  }
  const reader = stream.getReader();
  const crc = new Crc32();
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        signal?.throwIfAborted();
        if (entry.method === 8) throw DAMAGED(entry.path);
        throw new BackingFileError();
      }
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > entry.size) throw DAMAGED(entry.path);
      crc.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total !== entry.size || crc.value !== entry.crc) {
    throw DAMAGED(entry.path);
  }
}
