import { strToU8, zipSync } from 'fflate';
import { createEditorState, type EditorState } from '../editor/state';
import type { Decoder } from '../photos/decode';
import type { Photo } from '../photos';
import { saveProjectStream, planSave } from './save';
import { Crc32, streamToBlob } from './zip';

/**
 * A photo whose file text is "WxH", so the fake decoder can read the size
 * back. `bytes` pads the file so photos differ.
 */
export function makePhoto(
  id: string,
  name: string,
  width: number,
  height: number,
  included = true,
  lastModified = 1_700_000_000_000,
): Photo {
  const text = `${String(width)}x${String(height)}:${id}:${name}`;
  return {
    id,
    file: new File([text], name, { type: 'image/jpeg', lastModified }),
    width,
    height,
    aspect: width / height,
    preview: new Blob(['p']),
    thumbnail: new Blob(['t']),
    included,
  };
}

/** Reads the "WxH" the file starts with. */
export const fakeDecode: Decoder = async (file) => {
  const text = await file.text();
  const match = /^(\d+)x(\d+)/.exec(text);
  if (!match) throw new Error('not an image');
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    preview: new Blob(['preview']),
    thumbnail: new Blob(['thumb']),
  };
};

export function stateFor(photos: readonly Photo[]): EditorState {
  return createEditorState({
    seed: 7,
    canvas: { width: 1200, height: 900, borderFraction: 0.02 },
    photos: photos
      .filter((photo) => photo.included)
      .map(({ id, aspect }) => ({ id, aspect })),
  });
}

export async function saveToBlob(
  state: EditorState,
  photos: readonly Photo[],
): Promise<Blob> {
  return streamToBlob(saveProjectStream(planSave(state, photos)));
}

/** A zip of the given files made by fflate, stored. */
export function makeZip(files: Record<string, string | Uint8Array>): Blob {
  const data: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) {
    data[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return new Blob([zipSync(data, { level: 0 })]);
}

export interface RawEntry {
  readonly name: string | Uint8Array;
  readonly data?: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  /** Override what the directory claims. */
  readonly crc?: number;
  readonly compressedSize?: number;
  readonly size?: number;
}

export interface RawOptions {
  readonly comment?: string;
  readonly trailing?: Uint8Array;
  /** Entry count the end record claims. */
  readonly count?: number;
  /** Put a ZIP64 locator before the end record. */
  readonly zip64Locator?: boolean;
}

/** A hand-built zip, so tests can make every kind of hostile header. */
export function rawZip(
  entries: readonly RawEntry[],
  options: RawOptions = {},
): Blob {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array<ArrayBuffer>): void => {
    parts.push(bytes);
    offset += bytes.length;
  };
  for (const entry of entries) {
    const name =
      typeof entry.name === 'string' ? strToU8(entry.name) : entry.name;
    const data = entry.data ?? new Uint8Array(0);
    const crc = entry.crc ?? crcOf(data);
    const compressedSize = entry.compressedSize ?? data.length;
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0;
    const method = entry.method ?? 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, flags & 8 ? 0 : crc, true);
    lv.setUint32(18, flags & 8 ? 0 : compressedSize, true);
    lv.setUint32(22, flags & 8 ? 0 : size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    push(local);
    push(new Uint8Array(data));
  }
  const directoryOffset = offset;
  let directorySize = 0;
  for (const header of central) {
    push(new Uint8Array(header));
    directorySize += header.length;
  }
  if (options.zip64Locator) push(new Uint8Array(20).fill(0));
  if (options.zip64Locator) {
    // Make the locator signature the first four bytes of those 20.
    const last = parts.pop() as Uint8Array;
    new DataView(last.buffer).setUint32(0, 0x07064b50, true);
    parts.push(last as Uint8Array<ArrayBuffer>);
  }
  const comment = strToU8(options.comment ?? '');
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.count ?? entries.length, true);
  ev.setUint16(10, options.count ?? entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, directoryOffset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  parts.push(end);
  if (options.trailing) parts.push(options.trailing as Uint8Array<ArrayBuffer>);
  return new Blob(parts);
}

function crcOf(data: Uint8Array): number {
  const crc = new Crc32();
  crc.update(data);
  return crc.value;
}

/** A copy of `blob` with the byte at `offset` changed. */
export async function withByte(
  blob: Blob,
  offset: number,
  change: (byte: number) => number,
): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[offset] = change(bytes[offset] as number);
  return new Blob([bytes]);
}
