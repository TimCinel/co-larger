/**
 * Per-photo crops and the "cover" maths: the single implementation of which
 * part of a photo a tile shows. The editor preview and the export (#11) both
 * draw through {@link coverSource}, so they always show the same region,
 * whatever the resolution of the image they draw from.
 */

/**
 * Which part of a photo a tile shows. It belongs to the photo, not the tile:
 * when a re-roll moves the photo to a slot of another shape, the same crop is
 * re-fitted around the same focal point.
 */
export interface Crop {
  /**
   * The point of the photo to keep at the centre of the tile, as a fraction
   * of the photo's width (0 = left edge, 1 = right edge). When the tile
   * cannot be centred on it without showing past the photo's edge, the
   * visible region is pushed back inside the photo.
   */
  readonly x: number;
  /** As `x`, for the height (0 = top edge, 1 = bottom edge). */
  readonly y: number;
  /**
   * Magnification relative to "cover" (the photo just filling the tile).
   * At least 1: zooming out further would expose empty space.
   */
  readonly zoom: number;
}

/** Centred, filling the tile: the crop every photo starts with. */
export const DEFAULT_CROP: Crop = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });

/** The largest zoom a crop may have (5x the "cover" size). */
export const MAX_ZOOM = 5;

/**
 * Returns `crop` with the focal point clamped to the photo (0..1) and the
 * zoom clamped to 1..{@link MAX_ZOOM}. Non-finite values fall back to the
 * default. Use it on every crop that enters the editor state.
 */
export function normaliseCrop(crop: Partial<Crop>): Crop {
  const unit = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 0.5;
  const zoom =
    crop.zoom !== undefined && Number.isFinite(crop.zoom)
      ? Math.min(MAX_ZOOM, Math.max(1, crop.zoom))
      : 1;
  return { x: unit(crop.x), y: unit(crop.y), zoom };
}

/** True when `crop` is the default (centred, zoom 1). */
export function isDefaultCrop(crop: Crop): boolean {
  return crop.x === 0.5 && crop.y === 0.5 && crop.zoom === 1;
}

/** A rectangle in the source image's pixels, as `drawImage` takes it. */
export interface SourceRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * The rectangle of an `imageWidth` × `imageHeight` image to draw into a
 * `tileWidth` × `tileHeight` tile so that the photo covers the tile with
 * `crop` applied:
 *
 * - The rectangle has exactly the tile's aspect ratio, so nothing is
 *   distorted.
 * - It always lies inside the image, so no empty space is ever shown.
 * - At zoom 1 it is as large as possible (the photo just covers the tile);
 *   at zoom z its sides are 1/z of that.
 * - It is centred on the focal point where possible, otherwise moved the
 *   least distance needed to stay inside the image.
 *
 * Everything is proportional, so the same crop gives the same region of the
 * photo from a 256 px thumbnail, a 1024 px preview or the original.
 *
 * Returns null if any size is not a positive finite number.
 */
export function coverSource(
  imageWidth: number,
  imageHeight: number,
  tileWidth: number,
  tileHeight: number,
  crop: Crop = DEFAULT_CROP,
): SourceRect | null {
  if (
    !isPositive(imageWidth) ||
    !isPositive(imageHeight) ||
    !isPositive(tileWidth) ||
    !isPositive(tileHeight)
  ) {
    return null;
  }
  const { x, y, zoom } = normaliseCrop(crop);
  const tileAspect = tileWidth / tileHeight;
  // The largest rectangle of the tile's shape that fits in the image.
  let sw: number;
  let sh: number;
  if (imageWidth / imageHeight > tileAspect) {
    sh = imageHeight;
    sw = imageHeight * tileAspect;
  } else {
    sw = imageWidth;
    sh = imageWidth / tileAspect;
  }
  sw = Math.min(imageWidth, sw / zoom);
  sh = Math.min(imageHeight, sh / zoom);
  const sx = clamp(x * imageWidth - sw / 2, 0, imageWidth - sw);
  const sy = clamp(y * imageHeight - sh / 2, 0, imageHeight - sh);
  return { sx, sy, sw, sh };
}

/** The shape of the photo and of the tile it is shown in, in any units. */
export interface CropGeometry {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

/**
 * The part of the photo a tile shows at `zoom`, as fractions of the photo's
 * width and height (the same rectangle {@link coverSource} computes).
 */
export function visibleFractions(
  geometry: CropGeometry,
  zoom: number,
): { readonly fw: number; readonly fh: number } | null {
  const { imageWidth, imageHeight, tileWidth, tileHeight } = geometry;
  const rect = coverSource(imageWidth, imageHeight, tileWidth, tileHeight, {
    x: 0.5,
    y: 0.5,
    zoom,
  });
  return rect ? { fw: rect.sw / imageWidth, fh: rect.sh / imageHeight } : null;
}

/**
 * The crop as {@link coverSource} will use it: the focal point moved to the
 * nearest one at which the tile is exactly centred on it (so the visible
 * region's centre, which is what the user sees). Storing crops in this form
 * means a drag back from an edge responds at once, with no dead zone made of
 * out-of-range stored values. Zoom is clamped to 1..MAX_ZOOM. Returns the
 * default for invalid geometry.
 */
export function fitCrop(geometry: CropGeometry, crop: Partial<Crop>): Crop {
  const { x, y, zoom } = normaliseCrop(crop);
  const visible = visibleFractions(geometry, zoom);
  if (!visible) return DEFAULT_CROP;
  return {
    x: clamp(x, visible.fw / 2, 1 - visible.fw / 2),
    y: clamp(y, visible.fh / 2, 1 - visible.fh / 2),
    zoom,
  };
}

/**
 * Pans: the photo moves by (`dx`, `dy`) tile pixels (the direction the
 * pointer moved), so the point of the photo that was under the pointer stays
 * under it. The result is fitted, so it never exposes empty space.
 */
export function panCrop(
  geometry: CropGeometry,
  crop: Crop,
  dx: number,
  dy: number,
): Crop {
  const from = fitCrop(geometry, crop);
  const visible = visibleFractions(geometry, from.zoom);
  if (!visible || !Number.isFinite(dx) || !Number.isFinite(dy)) return from;
  return fitCrop(geometry, {
    x: from.x - (dx * visible.fw) / geometry.tileWidth,
    y: from.y - (dy * visible.fh) / geometry.tileHeight,
    zoom: from.zoom,
  });
}

/**
 * Zooms to `zoom` (clamped to 1..MAX_ZOOM) about the point (`px`, `py`) of
 * the tile, given as fractions of the tile (0.5, 0.5 is its centre): the
 * point of the photo under it stays under it, as far as the edges of the
 * photo allow.
 */
export function zoomCropAt(
  geometry: CropGeometry,
  crop: Crop,
  zoom: number,
  px: number,
  py: number,
): Crop {
  const from = fitCrop(geometry, crop);
  const before = visibleFractions(geometry, from.zoom);
  const target = normaliseCrop({ zoom: Number.isFinite(zoom) ? zoom : 1 }).zoom;
  const after = visibleFractions(geometry, target);
  if (!before || !after) return from;
  const fx = Number.isFinite(px) ? clamp(px, 0, 1) : 0.5;
  const fy = Number.isFinite(py) ? clamp(py, 0, 1) : 0.5;
  // The photo point under the pointer, then the focal point that keeps it
  // there at the new zoom.
  const ux = from.x - before.fw / 2 + fx * before.fw;
  const uy = from.y - before.fh / 2 + fy * before.fh;
  return fitCrop(geometry, {
    x: ux - fx * after.fw + after.fw / 2,
    y: uy - fy * after.fh + after.fh / 2,
    zoom: target,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isPositive(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}
