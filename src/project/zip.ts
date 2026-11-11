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
 * DecompressionStream, with a hard cap, so a zip bomb cannot expand.
 */
import { Zip, ZipPassThrough } from 'fflate';
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
            const { value, done } = await current.reader.read();
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
  const buffer = await blob.slice(start, start + length).arrayBuffer();
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
  if (blob.size < EOCD_SIZE) throw new ProjectError(NOT_A_ZIP);
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new ProjectError('This zip is too large (4 GB or more) to open.');
  }
  const tailLength = Math.min(blob.size, EOCD_SIZE + MAX_COMMENT);
  const tail = await bytesAt(blob, blob.size - tailLength, tailLength);
  let eocd = -1;
  for (let at = tailLength - EOCD_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    // The comment length must account for the rest of the file.
    if (at + EOCD_SIZE + tail.getUint16(at + 20, true) === tailLength) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ProjectError(NOT_A_ZIP);

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

/** An entry's content as text (UTF-8), for project.json. */
export async function readZipText(
  archive: Blob,
  entry: ZipEntry,
): Promise<string> {
  const blob = await readZipEntry(archive, entry);
  return new TextDecoder('utf-8').decode(await blob.arrayBuffer());
}
