/**
 * Drawing a collage, shared by the editor (screen size, from cached
 * previews: renderCollage, synchronous) and the export (#11: full size, from
 * the originals: renderCollageAsync, one image at a time). Both place tiles
 * with tilesFor and draw each with drawTile, which crops with coverSource,
 * so the export matches the editor apart from resolution. Only a handful of
 * 2D context methods are used, so it works on an HTMLCanvasElement, an
 * OffscreenCanvas or a recording fake in tests.
 */
import { placeLayout, type Tile } from '../layout';
import { coverSource } from './crop';
import { borderAt, cropOf, type EditorState } from './state';

/** An image ready to draw, with its size in pixels. */
export interface DrawableImage {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

/**
 * What a tile shows: an image, `null` while the image is not ready yet (a
 * plain placeholder), or `'failed'` if it cannot be decoded (an error
 * placeholder).
 */
export type TileImage = DrawableImage | null | 'failed';

/**
 * Supplies the image for a photo, synchronously (the editor, from a cache).
 * Called once per tile per render with the tile it will fill (in output
 * pixels), so a caller can pick a resolution to suit.
 */
export type ImageProvider = (photoId: string, tile: Tile) => TileImage;

/** An image obtained for one tile, released again once it is drawn. */
export interface LoadedImage extends DrawableImage {
  release?(): void;
}

/**
 * Supplies the image for a photo asynchronously (the export, #11: decode
 * one original at a time). Called once per tile, in turn; the image is
 * released as soon as its tile is drawn, so only one is held at a time.
 */
export type AsyncImageProvider = (
  photoId: string,
  tile: Tile,
) => Promise<LoadedImage | null | 'failed'>;

/** The subset of the 2D context API that the renderer uses. */
export type CollageContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'fillRect'
  | 'drawImage'
  | 'imageSmoothingEnabled'
  | 'imageSmoothingQuality'
  | 'strokeStyle'
  | 'lineWidth'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
>;

/** Output size in pixels. Rounded to whole pixels. */
export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

export interface RenderResult {
  /** The tiles as drawn (indexed by slot), for hit-testing with tileAt. */
  readonly tiles: Tile[];
  /** How many tiles were drawn as placeholders (loading or failed). */
  readonly missing: number;
}

/** Fill for a tile whose image is still loading. */
export const PLACEHOLDER_COLOUR = '#d4d6db';
/** Fill for a tile whose image could not be decoded (with a cross). */
export const ERROR_COLOUR = '#6b2a33';
const ERROR_MARK_COLOUR = '#e8a0a8';

/** Just inside placeLayout's 2% tolerance between canvas and plan ratio. */
const MAX_RATIO_ERROR = Math.log(1.019);

/**
 * Where each tile goes when `state` is drawn at `size` pixels: the state's
 * plan placed at that size, with the border (a fraction of the shorter
 * side) in whole pixels at that size and every edge snapped to whole pixels (so neighbouring
 * tiles share an edge exactly and no background shows through
 * anti-aliasing seams). The border drawn is borderAt(...).effective: the
 * requested border, clamped so that every tile keeps at least one pixel.
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
  const border =
    state.canvas.borderFraction > 0
      ? borderAt(state, { width, height }).effective
      : 0;
  return placeLayout(state.plan, { width, height, border, snap: true });
}

/** Fills the whole output with the state's background colour. */
export function drawBackground(
  ctx: CollageContext,
  state: EditorState,
  size: RenderSize,
): void {
  ctx.fillStyle = state.canvas.background;
  ctx.fillRect(0, 0, Math.round(size.width), Math.round(size.height));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

/**
 * Draws one tile: its photo covering the tile with the photo's crop (see
 * coverSource), or a placeholder. The single per-tile drawing code, shared
 * by renderCollage and renderCollageAsync. Returns false if it drew a
 * placeholder.
 */
export function drawTile(
  ctx: CollageContext,
  state: EditorState,
  tile: Tile,
  image: TileImage,
): boolean {
  const id = state.assignment[tile.slot];
  if (image === null || image === 'failed' || id === undefined) {
    drawPlaceholder(ctx, tile, image === 'failed');
    return false;
  }
  const source = coverSource(
    image.width,
    image.height,
    tile.width,
    tile.height,
    cropOf(state, id),
  );
  if (!source) {
    drawPlaceholder(ctx, tile, false);
    return false;
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
  return true;
}

/**
 * Draws `state` onto `ctx` at `size` pixels, starting at the context's
 * origin: the background, then every tile (drawTile). For the editor, which
 * draws from images already decoded; a tile whose image is not ready gets a
 * placeholder and is redrawn later.
 */
export function renderCollage(
  ctx: CollageContext,
  state: EditorState,
  size: RenderSize,
  getImage: ImageProvider,
): RenderResult {
  drawBackground(ctx, state, size);
  const tiles = tilesFor(state, size);
  let missing = 0;
  for (const tile of tiles) {
    const id = state.assignment[tile.slot];
    const image = id === undefined ? null : getImage(id, tile);
    if (!drawTile(ctx, state, tile, image)) missing++;
  }
  return { tiles, missing };
}

/**
 * As renderCollage, but obtains each tile's image asynchronously, one tile
 * at a time, and releases it as soon as the tile is drawn: for the export
 * (#11), which draws from full-resolution originals that cannot all be held
 * decoded at once. Same tiles, same drawTile, same output.
 */
export async function renderCollageAsync(
  ctx: CollageContext,
  state: EditorState,
  size: RenderSize,
  getImage: AsyncImageProvider,
): Promise<RenderResult> {
  drawBackground(ctx, state, size);
  const tiles = tilesFor(state, size);
  let missing = 0;
  for (const tile of tiles) {
    const id = state.assignment[tile.slot];
    const image = id === undefined ? null : await getImage(id, tile);
    try {
      if (!drawTile(ctx, state, tile, image)) missing++;
    } finally {
      if (image !== null && image !== 'failed') image.release?.();
    }
  }
  return { tiles, missing };
}

function drawPlaceholder(
  ctx: CollageContext,
  tile: Tile,
  failed: boolean,
): void {
  ctx.fillStyle = failed ? ERROR_COLOUR : PLACEHOLDER_COLOUR;
  ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
  if (failed) drawCross(ctx, tile);
}

function drawCross(ctx: CollageContext, tile: Tile): void {
  const size = Math.min(tile.width, tile.height) * 0.3;
  if (size < 4) return;
  const cx = tile.x + tile.width / 2;
  const cy = tile.y + tile.height / 2;
  ctx.strokeStyle = ERROR_MARK_COLOUR;
  ctx.lineWidth = Math.max(1, size / 8);
  ctx.beginPath();
  ctx.moveTo(cx - size / 2, cy - size / 2);
  ctx.lineTo(cx + size / 2, cy + size / 2);
  ctx.moveTo(cx + size / 2, cy - size / 2);
  ctx.lineTo(cx - size / 2, cy + size / 2);
  ctx.stroke();
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
