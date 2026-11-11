/**
 * Low-resolution warnings (#15), pure so they are testable in Node and cost
 * only arithmetic on data the editor already holds.
 *
 * A tile's **upscale factor** is its size in export pixels divided by the
 * size, in original-photo pixels, of the region its crop shows. A factor of 1
 * means the export copies the original's pixels one to one; 2 means each
 * original pixel is stretched over 2 × 2 export pixels. On a canvas with a
 * physical size the **effective DPI** is the canvas DPI divided by the factor.
 *
 * The warning is derived state: nothing here is saved, put in undo history
 * or drawn into the export. The result depends on the canvas pixel size, the
 * layout, the border, the assignment and each tile's crop, so it is
 * recomputed from the editor state whenever that changes.
 */
import { coverSource, type Crop } from './crop';
import { tilesFor } from './render';
import { cropOf, type EditorState } from './state';
import type { PhysicalSize } from './physical';

/** Above this factor a tile is "low" resolution (below 200 DPI at 300). */
export const LOW_FACTOR = 1.5;
/** Above this factor a tile is "very low" resolution (below 100 DPI at 300). */
export const VERY_LOW_FACTOR = 3;

/**
 * Floating-point slack when comparing with the thresholds: a crop whose
 * factor is exactly 1.5 on paper can come out as 1.5000000000000002 after
 * dividing by a zoom. Far below anything a pixel count can express.
 */
const EPSILON = 1e-9;

export type ResolutionLevel = 'ok' | 'low' | 'very-low';

/** The level for an upscale factor: a factor equal to a threshold is fine. */
export function levelForFactor(factor: number): ResolutionLevel {
  if (!(factor > LOW_FACTOR * (1 + EPSILON))) return 'ok';
  return factor > VERY_LOW_FACTOR * (1 + EPSILON) ? 'very-low' : 'low';
}

/** The size of a photo in pixels (after EXIF orientation). */
export interface PhotoSize {
  readonly width: number;
  readonly height: number;
}

/** What is known about one tile's resolution. */
export interface TileResolution {
  readonly slot: number;
  readonly photoId: string;
  readonly level: ResolutionLevel;
  /** Export pixels per original pixel (the larger of the two axes). */
  readonly factor: number;
  /** The tile's size in export pixels. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** The region of the original the tile shows, in original pixels. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Canvas DPI divided by the factor; null for a canvas sized in pixels. */
  readonly effectiveDpi: number | null;
}

/**
 * The resolution of one tile: the photo's pixel size, the tile's size in
 * export pixels, the tile's crop, and the canvas DPI if it has a physical
 * size. Null if any size is unusable (zero, negative or not finite).
 */
export function tileResolution(
  photo: PhotoSize,
  tile: { readonly width: number; readonly height: number },
  crop: Crop,
  dpi: number | null = null,
): Omit<TileResolution, 'slot' | 'photoId'> | null {
  const source = coverSource(
    photo.width,
    photo.height,
    tile.width,
    tile.height,
    crop,
  );
  if (!source) return null;
  // The region has the tile's aspect, so the two ratios are equal up to
  // rounding; the larger is the one that under-samples.
  const factor = Math.max(tile.width / source.sw, tile.height / source.sh);
  return {
    level: levelForFactor(factor),
    factor,
    tileWidth: tile.width,
    tileHeight: tile.height,
    sourceWidth: source.sw,
    sourceHeight: source.sh,
    effectiveDpi: dpi === null ? null : dpi / factor,
  };
}

/**
 * Every tile of `state`, exported at the canvas's own size, whose photo is
 * too small for it (level "low" or "very-low"), in slot order. Tiles are
 * placed with the same function the export uses (so the border and the
 * snapping to whole pixels match). Photos whose size `sizeOf` does not know
 * are skipped.
 */
export function resolutionWarnings(
  state: EditorState,
  sizeOf: (photoId: string) => PhotoSize | undefined,
): TileResolution[] {
  const { width, height, physical } = state.canvas;
  const dpi = physical?.dpi ?? null;
  const found: TileResolution[] = [];
  for (const tile of tilesFor(state, { width, height })) {
    const photoId = state.assignment[tile.slot];
    if (photoId === undefined) continue;
    const size = sizeOf(photoId);
    if (!size) continue;
    const result = tileResolution(size, tile, cropOf(state, photoId), dpi);
    if (result && result.level !== 'ok') {
      found.push({ slot: tile.slot, photoId, ...result });
    }
  }
  return found;
}

/** `2600 × 1733 px`, whole pixels. */
function pixels(width: number, height: number): string {
  return `${String(Math.round(width))} × ${String(Math.round(height))} px`;
}

/** One decimal, no trailing ".0": `2.2`, `3`. */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** The label of a level: "Low resolution" or "Very low resolution". */
export function levelLabel(level: ResolutionLevel): string {
  return level === 'very-low' ? 'Very low resolution' : 'Low resolution';
}

/**
 * Why a tile is flagged, in plain words, for the tooltip and for screen
 * readers: what the tile uses of the photo, what it is exported at, and
 * either the effective DPI (physical canvas) or the enlargement (pixels).
 */
export function describeResolution(
  warning: TileResolution,
  physical: PhysicalSize | undefined,
): string {
  const used = pixels(warning.sourceWidth, warning.sourceHeight);
  const tile = pixels(warning.tileWidth, warning.tileHeight);
  const head = `${levelLabel(warning.level)}: this tile uses ${used} of the photo`;
  if (physical && warning.effectiveDpi !== null) {
    return `${head} but prints at ${tile}, about ${String(Math.round(warning.effectiveDpi))} DPI at this size.`;
  }
  return `${head} but exports at ${tile}, so it will be enlarged ${oneDecimal(warning.factor)}×.`;
}

/** How many tiles are at each level. */
export function countLevels(warnings: readonly TileResolution[]): {
  readonly low: number;
  readonly veryLow: number;
} {
  let veryLow = 0;
  for (const warning of warnings) if (warning.level === 'very-low') veryLow++;
  return { low: warnings.length - veryLow, veryLow };
}

/**
 * The one-line summary: "2 photos are low resolution for this size", with
 * how many are very low when some are. Null when there are no warnings.
 */
export function summaryText(
  warnings: readonly TileResolution[],
): string | null {
  if (warnings.length === 0) return null;
  const { veryLow } = countLevels(warnings);
  const n = warnings.length;
  const base = `${String(n)} ${n === 1 ? 'photo is' : 'photos are'} low resolution for this size`;
  return veryLow > 0 ? `${base} (${String(veryLow)} very low)` : base;
}
