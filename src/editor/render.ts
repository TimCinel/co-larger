/**
 * Drawing a collage: the one rendering function shared by the editor (screen
 * size, from previews) and the export (#11: full size, from the originals).
 * It only calls a handful of 2D context methods, so it works on an
 * HTMLCanvasElement, an OffscreenCanvas or a recording fake in tests.
 */
import { maxBorder, placeLayout, type Tile } from '../layout';
import { coverSource } from './crop';
import { cropOf, type EditorState } from './state';

/** An image ready to draw, with its size in pixels. */
export interface DrawableImage {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

/**
 * Supplies the image for a photo. Called once per tile per render with the
 * tile it will fill (in output pixels), so a caller can pick a resolution to
 * suit. Return null if the image is not ready; the tile is then filled with
 * the placeholder colour.
 */
export type ImageProvider = (
  photoId: string,
  tile: Tile,
) => DrawableImage | null;

/** The subset of the 2D context API that renderCollage uses. */
export type CollageContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'fillRect'
  | 'drawImage'
  | 'imageSmoothingEnabled'
  | 'imageSmoothingQuality'
>;

/** Output size in pixels. Rounded to whole pixels. */
export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

export interface RenderOptions {
  /** Fill for tiles whose image is not ready. Defaults to a light grey. */
  readonly placeholder?: string;
}

export interface RenderResult {
  /** The tiles as drawn (indexed by slot), for hit-testing with tileAt. */
  readonly tiles: Tile[];
  /** How many tiles were drawn as placeholders. */
  readonly missing: number;
}

export const PLACEHOLDER_COLOUR = '#d4d6db';

/** Just inside placeLayout's 2% tolerance between canvas and plan ratio. */
const MAX_RATIO_ERROR = Math.log(1.019);

/**
 * Where each tile goes when `state` is drawn at `size` pixels: the state's
 * plan placed at that size, with the border scaled from canvas pixels to
 * output pixels and every edge snapped to whole pixels (so neighbouring
 * tiles share an edge exactly and no background shows through
 * anti-aliasing seams). The border is clamped so that every tile keeps at
 * least one pixel.
 */
export function tilesFor(state: EditorState, size: RenderSize): Tile[] {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (state.plan.root === null || width < 1 || height < 1) return [];
  // Rounding a tiny size (a few pixels) can distort the ratio beyond what
  // placeLayout accepts; there is nothing useful to draw at that size.
  if (
    Math.abs(Math.log(width / height / state.plan.aspect)) > MAX_RATIO_ERROR
  ) {
    return [];
  }
  const scale = width / state.canvas.width;
  const wanted = state.canvas.border * scale;
  const border =
    wanted > 0
      ? Math.min(wanted, maxBorder(state.plan, width, height, { snap: true }))
      : 0;
  return placeLayout(state.plan, { width, height, border, snap: true });
}

/**
 * Draws `state` onto `ctx` at `size` pixels, starting at the context's
 * origin: the background, then each tile's photo covering its tile with the
 * photo's crop (see coverSource). The editor and the export both call this,
 * so the export matches the editor apart from resolution.
 */
export function renderCollage(
  ctx: CollageContext,
  state: EditorState,
  size: RenderSize,
  getImage: ImageProvider,
  options: RenderOptions = {},
): RenderResult {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  ctx.fillStyle = state.canvas.background;
  ctx.fillRect(0, 0, width, height);
  const tiles = tilesFor(state, { width, height });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  let missing = 0;
  for (const tile of tiles) {
    if (tile.width <= 0 || tile.height <= 0) continue;
    const id = state.assignment[tile.slot];
    const image = id === undefined ? null : getImage(id, tile);
    const source =
      image &&
      id !== undefined &&
      coverSource(
        image.width,
        image.height,
        tile.width,
        tile.height,
        cropOf(state, id),
      );
    if (!image || !source) {
      missing++;
      ctx.fillStyle = options.placeholder ?? PLACEHOLDER_COLOUR;
      ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
      continue;
    }
    ctx.drawImage(
      image.image,
      source.sx,
      source.sy,
      source.sw,
      source.sh,
      tile.x,
      tile.y,
      tile.width,
      tile.height,
    );
  }
  return { tiles, missing };
}

/**
 * The tile containing the point (`x`, `y`), in the same pixels as `tiles`,
 * or null if the point is in a gap, the border or outside the canvas. For
 * selecting a tile to swap (#8) or crop (#9).
 */
export function tileAt(
  tiles: readonly Tile[],
  x: number,
  y: number,
): Tile | null {
  for (const tile of tiles) {
    if (
      x >= tile.x &&
      x < tile.x + tile.width &&
      y >= tile.y &&
      y < tile.y + tile.height
    ) {
      return tile;
    }
  }
  return null;
}

/**
 * The largest size with the canvas's aspect ratio that fits in `maxWidth` ×
 * `maxHeight`, in whole units and at least 1 × 1.
 */
export function fitSize(
  canvasWidth: number,
  canvasHeight: number,
  maxWidth: number,
  maxHeight: number,
): RenderSize {
  const scale = Math.min(maxWidth / canvasWidth, maxHeight / canvasHeight);
  if (!(scale > 0) || !Number.isFinite(scale)) return { width: 1, height: 1 };
  return {
    width: Math.max(1, Math.floor(canvasWidth * scale)),
    height: Math.max(1, Math.floor(canvasHeight * scale)),
  };
}
