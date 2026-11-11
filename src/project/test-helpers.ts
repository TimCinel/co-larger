import { strToU8, zipSync } from 'fflate';
import { createEditorState, type EditorState } from '../editor/state';
import type { Decoder } from '../photos/decode';
import type { Photo } from '../photos';
import { saveProjectStream, planSave } from './save';
import { streamToBlob } from './zip';

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
