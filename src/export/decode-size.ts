/**
 * How large to decode an original for export (#11), pure so it is testable
 * in Node. A 24 megapixel original decoded in full is about 96 MB, and most
 * tiles show it far smaller, so each original is decoded at about the
 * resolution its tile samples it at, never more than the original.
 */
import { coverSource, type Crop } from '../editor/crop';

/** A size to decode an image at, in whole pixels. */
export interface DecodeSize {
  readonly width: number;
  readonly height: number;
}

/** A tile's size in output pixels. */
export interface TileSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size at which to decode a `photoWidth` × `photoHeight` original (after
 * EXIF orientation) to draw it into `tile` with `crop`, or null to decode it
 * at its own size (the tile samples it at 1:1 or finer, so any shrinking
 * would lose detail), or if the sizes are unusable.
 *
 * The visible region (coverSource) is drawn `scale` times its size in the
 * original. Scaling the whole photo by `scale`, rounded up, makes that
 * region exactly as many pixels as the tile needs, so drawing it is a 1:1
 * copy. Rounding up keeps it at least as sharp as needed; it makes the
 * bitmap's aspect differ from the original's by less than a pixel, which
 * moves the sampled region by less than a pixel of the bitmap (about one
 * output pixel).
 *
 * A zoomed crop samples a small region, so it needs a larger decode than the
 * same tile uncropped: the size follows the visible region, not the photo.
 */
export function decodeSizeFor(
  photoWidth: number,
  photoHeight: number,
  tile: TileSize,
  crop: Crop,
): DecodeSize | null {
  const source = coverSource(
    photoWidth,
    photoHeight,
    tile.width,
    tile.height,
    crop,
  );
  if (!source) return null;
  // The visible region has the tile's aspect, so both ratios are equal up to
  // rounding; take the larger so neither axis is under-sampled.
  const scale = Math.max(tile.width / source.sw, tile.height / source.sh);
  if (!(scale < 1)) return null;
  const width = Math.min(
    photoWidth,
    Math.max(1, Math.ceil(photoWidth * scale)),
  );
  const height = Math.min(
    photoHeight,
    Math.max(1, Math.ceil(photoHeight * scale)),
  );
  if (width >= photoWidth && height >= photoHeight) return null;
  return { width, height };
}

export type ExportFormat = 'png' | 'jpeg';

export const MIME_TYPES: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** `collage-4961x7016.png` or `.jpg`. */
export function exportFileName(
  width: number,
  height: number,
  format: ExportFormat,
): string {
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  return `collage-${String(Math.round(width))}x${String(Math.round(height))}.${extension}`;
}
