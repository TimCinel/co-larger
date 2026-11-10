import type { DecodedPhoto } from './decode';
import type { NewPhoto } from './store';

export function makeFile(name: string, size = 10, lastModified = 1000): File {
  return new File([new Uint8Array(size)], name, {
    type: 'image/jpeg',
    lastModified,
  });
}

export function makeDecoded(width = 400, height = 300): DecodedPhoto {
  return {
    width,
    height,
    preview: new Blob(['preview']),
    thumbnail: new Blob(['thumb']),
  };
}

export function makeNewPhoto(
  name: string,
  width = 400,
  height = 300,
): NewPhoto {
  return { file: makeFile(name), ...makeDecoded(width, height) };
}
