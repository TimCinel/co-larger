/**
 * Which stored image a tile should be drawn from, pure so it is testable in
 * Node (see ImageCache for how the choice is used).
 *
 * There are three sources for each photo:
 * - the 256 px thumbnail and the 1024 px preview, stored with the photo;
 * - a "detail" decode of the original at the size the tile needs, for tiles
 *   that show more pixels than the preview holds (a large tile on a
 *   high-density screen, or a zoomed crop, which samples a smaller part of
 *   the photo). Export decodes originals the same way (decodeSizeFor).
 */
import {
  fitLongSide,
  PREVIEW_LONG_SIDE,
  THUMBNAIL_LONG_SIDE,
} from '../photos/decode';
import { decodeSizeFor, type DecodeSize } from '../export/decode-size';
import type { Crop } from './crop';

export type Level = 'thumbnail' | 'preview' | 'detail';

/** Quality order: a higher rank is sharper. */
export const LEVEL_RANK: Readonly<Record<Level, number>> = {
  thumbnail: 0,
  preview: 1,
  detail: 2,
};

export interface SourcePhoto {
  /** Natural size, after EXIF orientation. */
  readonly width: number;
  readonly height: number;
}

export interface SourceTile {
  readonly width: number;
  readonly height: number;
}

export interface SourceChoice {
  readonly level: Level;
  /**
   * The size of the image at that level. For a detail, the size to decode
   * at: at least `needed`, rounded up a ladder so that a tile that changes
   * size a little does not need a new decode each time.
   */
  readonly size: DecodeSize;
  /** The size that draws the tile at one image pixel per output pixel. */
  readonly needed: DecodeSize;
}

/** Bytes of a decoded image (RGBA). */
export function bytesOf(size: DecodeSize): number {
  return size.width * size.height * 4;
}

/** The size of the stored thumbnail or preview of a photo. */
export function storedSize(
  photo: SourcePhoto,
  level: 'thumbnail' | 'preview',
): DecodeSize {
  return fitLongSide(
    photo.width,
    photo.height,
    level === 'thumbnail' ? THUMBNAIL_LONG_SIDE : PREVIEW_LONG_SIDE,
  );
}

/** Long sides a detail is decoded at, as multiples of the preview's. */
const LADDER = [1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** The largest single detail decode: a quarter of the default budget. */
export const MAX_DETAIL_BYTES = 64 * 1024 * 1024;

/** True if an image of `have` can draw a tile that needs `needed` sharply. */
export function supplies(have: DecodeSize, needed: DecodeSize): boolean {
  return have.width + 1 >= needed.width && have.height + 1 >= needed.height;
}

/**
 * The source for drawing `photo` into `tile` (in output pixels) with `crop`:
 * the smallest of thumbnail, preview and a detail decode of the original
 * that is not visibly enlarged, never decoding above the original and never
 * above `maxDetailBytes` (beyond that the tile is drawn a little soft from
 * the largest image allowed).
 */
export function chooseSource(
  photo: SourcePhoto,
  tile: SourceTile,
  crop: Crop,
  maxDetailBytes: number = MAX_DETAIL_BYTES,
): SourceChoice {
  const thumbnail = storedSize(photo, 'thumbnail');
  const preview = storedSize(photo, 'preview');
  const needed = decodeSizeFor(photo.width, photo.height, tile, crop) ?? {
    width: photo.width,
    height: photo.height,
  };
  // An unusable tile size: the cheapest image will do.
  if (!(tile.width > 0 && tile.height > 0)) {
    return { level: 'thumbnail', size: thumbnail, needed };
  }
  if (supplies(thumbnail, needed)) {
    return { level: 'thumbnail', size: thumbnail, needed };
  }
  if (supplies(preview, needed)) {
    return { level: 'preview', size: preview, needed };
  }
  const longest = Math.max(needed.width, needed.height);
  const rung = LADDER.find((step) => step * PREVIEW_LONG_SIDE >= longest);
  let size =
    rung === undefined
      ? { width: photo.width, height: photo.height }
      : fitLongSide(photo.width, photo.height, rung * PREVIEW_LONG_SIDE);
  const bytes = bytesOf(size);
  if (bytes > maxDetailBytes) {
    const shrink = Math.sqrt(maxDetailBytes / bytes);
    size = {
      width: Math.max(1, Math.floor(size.width * shrink)),
      height: Math.max(1, Math.floor(size.height * shrink)),
    };
  }
  if (size.width <= preview.width && size.height <= preview.height) {
    return { level: 'preview', size: preview, needed };
  }
  return { level: 'detail', size, needed };
}
