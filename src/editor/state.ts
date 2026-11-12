/**
 * The editor state: everything that decides what the collage looks like, as
 * one plain, JSON-serialisable snapshot, changed only by the pure actions in
 * this module. No DOM, no blobs, no class instances, so it is unit-testable
 * in Node and later issues get the following almost for free:
 *
 * - Undo and redo (#10): a stack of snapshots, restored with
 *   EditorStore.restore. Every action returns a new object and never mutates
 *   its input; an action that changes nothing returns its input itself, so
 *   `next === state` means "nothing happened".
 * - Save and load (#12): `JSON.stringify(state)` and
 *   `validateEditorState(JSON.parse(text), { photoIds })`, then
 *   EditorStore.restore. The plan and the assignment are stored, not
 *   re-derived from the seed, as the layout library asks (its results depend
 *   on floating-point details that may differ between browsers).
 * - Export (#11): render.ts draws a snapshot at any size.
 *
 * The state refers to photos only by id, and keeps the included photos' ids
 * and aspect ratios (`photos`), which is all layout and assignment need. How
 * it is kept in step with the PhotoStore is described in store.ts.
 *
 * Re-roll rules (spec.md): a re-roll replaces the plan and the assignment.
 *
 * - Re-roll: shuffle (new seed), setVariation (new value), setCanvasSize
 *   when the ratio changes, and setPhotos when the set of included photos
 *   changes.
 * - No re-roll: setBorder, setBackground, setCrop, and setCanvasSize at the
 *   same ratio (within RATIO_TOLERANCE, so changing DPI at a fixed paper
 *   size, which rounds to slightly different ratios, keeps the layout),
 *   setPhysicalSize at the same ratio, switchToPhysical and switchToPixels.
 * - Crops belong to the photo and survive re-rolls (and exclusion). They are
 *   dropped only when the photo leaves the store (forgetPhotos).
 * - Manual swaps (#8: `swapSlots` on `assignment`) do not survive a re-roll,
 *   but survive every action that does not re-roll, including setting the
 *   dial to the value it already has.
 * - Hand resizing (#16: moveDivider, which changes one split's fraction in
 *   `plan`) is like a manual swap: every re-roll replaces the plan with a
 *   fresh one and discards it (the dial too: setVariation plans from the
 *   seed and never reads the current plan, so no hand-set fraction is
 *   carried into or interpolated by a dial move), and every action that
 *   does not re-roll keeps it, including setting the dial to the value it
 *   already has. moveDivider moves no photo, featured or not.
 * - Featured photos (#14, `featured`): every re-roll puts the k featured
 *   photos in the collage in the k largest tiles as drawn (see arrange). The
 *   mark belongs to the photo, like a crop: it survives re-rolls and
 *   exclusion and is dropped only by forgetPhotos. setFeatured marks or
 *   unmarks one photo; marking moves it into a large tile with at most one
 *   swap. The guarantee holds at each re-roll and at the moment of
 *   featuring. A change that alters tile sizes without re-rolling (the
 *   border, or another pixel size at the same ratio) moves no photo, as for
 *   swaps; the next re-roll ranks the tiles again.
 *
 * - Layout (#20, `layout` and `columns`): Mosaic (the default) or Grid. Every
 *   re-roll above runs the planner the layout asks for (see arrange), so a
 *   grid stays a grid through Shuffle, the photos changing and the canvas
 *   ratio changing. setLayout re-rolls whenever the layout changes;
 *   setColumns re-rolls in a grid whenever the setting changes (even to a
 *   setting giving the same column count) and only records the setting in
 *   a mosaic. In a grid the dial has no effect
 *   (the plan does not depend on it) but its value stays in the state, for
 *   when the user returns to Mosaic. Shuffle changes which photo is in which
 *   cell. A column setting above the photo count is kept as the user set it
 *   and clamped only for planning.
 *
 * Determinism: after any re-roll the plan and the assignment are a function
 * of (canvas, photos, variation, seed, featured, layout, columns) only,
 * never of the previous
 * state. Without featured photos only the canvas ratio matters; with them,
 * the canvas's pixel size and border decide which drawn tiles are largest. See {@link arrange}. With nothing featured they are exactly
 * what they were before featuring existed, and in a mosaic (no `layout`
 * key) exactly what they were before grids existed.
 */
import {
  arrangementStep,
  assignPhotos,
  autoColumns,
  checkTileSizes,
  clampColumns,
  gridColumnsOf,
  listDividers,
  maxBorder,
  maxBorderForAspect,
  MAX_PLAN_ASPECT,
  placeLayout,
  planAspectLimit,
  planGrid,
  planLayout,
  setDividerFraction,
  slotsBySize,
  swapSlots,
  validateAssignment,
  validatePlan,
  type Divider,
  type LayoutNode,
  type LayoutPlan,
  type PhotoShape,
  type Tile,
} from '../layout';
import { DEFAULT_CROP, isDefaultCrop, normaliseCrop, type Crop } from './crop';
import {
  checkPhysical,
  DEFAULT_DPI,
  physicalFor,
  pixelSizeOf,
  samePhysical,
  type PhysicalSize,
} from './physical';

/** The output canvas. Lengths are in output pixels. */
export interface CanvasSettings {
  /** Output width in whole pixels, 1 to MAX_CANVAS_SIDE. */
  readonly width: number;
  /** Output height in whole pixels, 1 to MAX_CANVAS_SIDE. */
  readonly height: number;
  /**
   * Outer margin and gap between tiles, as a fraction of the canvas's
   * shorter side (0 to MAX_BORDER_FRACTION): 0.01 on a 1920 × 1080 canvas
   * is 10.8 px. A fraction keeps the border the same physical width when
   * only the pixel size changes (another DPI at the same paper size, #7),
   * and makes it independent of the output resolution.
   *
   * This is the border the user asked for, and no action other than
   * setBorder changes it. What is drawn is clamped to what the current
   * arrangement allows (see borderAt), so re-rolls, drags and size changes
   * never lose the user's setting. The border control shows both, from
   * borderAt.
   */
  readonly borderFraction: number;
  /** Shown in the border and gaps: a lower-case `#rrggbb` colour. */
  readonly background: string;
  /**
   * How the size was specified when the user gave it in millimetres and
   * DPI (#7); absent for a size given in pixels (the key is then missing,
   * not undefined, so the snapshot stays plain JSON). It only describes
   * `width` and `height`, which stay the single source of truth for layout
   * and rendering: `width === Math.round(widthMm * dpi / 25.4)` always
   * (see PhysicalSize), so a project reopens in the same mode with the same
   * numbers, which deriving millimetres from pixels could not promise.
   *
   * What happens to it: setPhysicalSize sets it; switchToPhysical adds it
   * for the current pixels; switchToPixels and setCanvasSize (any pixel
   * size) drop it; setBorder, setBackground and every re-roll keep it.
   */
  readonly physical?: PhysicalSize;
}

/** The largest border: a quarter of the canvas's shorter side. */
export const MAX_BORDER_FRACTION = 0.25;

/** The largest canvas side accepted, in pixels (export tops out at 7016). */
export const MAX_CANVAS_SIDE = 20000;

/**
 * Two canvas ratios within this relative difference count as the same
 * ratio: the plan is kept and only rescaled. 0.5% absorbs rounding
 * millimetres × DPI to whole pixels (A-series paper at 72 dpi and above) and
 * stays well inside the 2% the layout engine accepts between a plan and the
 * canvas it is placed on. Measured against the plan's own ratio, so small
 * changes cannot accumulate.
 */
export const RATIO_TOLERANCE = 0.005;

/** Photo aspect ratios accepted in a loaded state: 1:1000 to 1000:1. */
export const MAX_PHOTO_ASPECT = 1000;

/** A new canvas: 1920 × 1080, no border, white. */
export const DEFAULT_CANVAS: CanvasSettings = Object.freeze({
  width: 1920,
  height: 1080,
  borderFraction: 0,
  background: '#ffffff',
});

/** The dial's starting position: halfway between uniform and varied. */
export const DEFAULT_VARIATION = 0.5;

/** The two layouts (#20). */
export type LayoutKind = 'mosaic' | 'grid';

/** The Columns control (#20): Auto, or a whole number of columns. */
export type ColumnSetting = 'auto' | number;

/**
 * The largest column count accepted (#20). The control offers 1 to the
 * photo count; this only bounds what a saved project may contain.
 */
export const MAX_COLUMNS = 10000;

/** Crops by photo id: an object with no prototype (see cropOf). */
export type CropMap = Readonly<Record<string, Crop>>;

/** One snapshot of the editor. Plain data: see the module comment. */
export interface EditorState {
  readonly canvas: CanvasSettings;
  /** The size-variation dial, 0 (uniform) to 1 (varied). */
  readonly variation: number;
  /** The seed for the plan and the assignment: a non-negative integer. */
  readonly seed: number;
  /**
   * The photos in the collage (the store's included photos), in tray order.
   * `plan.count === photos.length`.
   */
  readonly photos: readonly PhotoShape[];
  /** The arrangement: which slots exist (from the layout library). */
  readonly plan: LayoutPlan;
  /** `assignment[slot]` is the id of the photo shown in that slot. */
  readonly assignment: readonly string[];
  /**
   * Crops by photo id, with no prototype, so ids like `constructor` or
   * `__proto__` are safe. Photos without an entry use DEFAULT_CROP. Entries
   * are kept for excluded photos so a crop survives excluding and including
   * again. Read it with cropOf.
   */
  readonly crops: CropMap;
  /**
   * Ids of the featured photos (#14), sorted, no repeats; the key is absent
   * (not an empty array) when none is featured, so a state with nothing
   * featured is exactly what it was before the feature existed. Like crops,
   * entries stay for excluded photos (an excluded photo takes no tile, and is
   * featured again when included) and are dropped by forgetPhotos. Read it
   * with featuredOf or isFeatured.
   */
  readonly featured?: readonly string[];
  /**
   * The layout (#20): `'grid'`, or absent for the mosaic (the key is missing,
   * not undefined, so a mosaic state is exactly what it was before grids
   * existed). The plan is a grid plan exactly when this is `'grid'`. Read it
   * with layoutOf.
   */
  readonly layout?: 'grid';
  /**
   * The Columns setting (#20): a whole number from 1 to MAX_COLUMNS, or
   * absent for Auto. Kept whatever the layout, so it survives switching to
   * Mosaic and back, and kept when it exceeds the photo count (the grid
   * then uses one column per photo). Read it with columnsOf.
   */
  readonly columns?: number;
}

export interface CreateOptions {
  /** Defaults to a random seed: pass one for reproducible states. */
  readonly seed?: number;
  readonly canvas?: Partial<CanvasSettings>;
  readonly variation?: number;
  readonly photos?: readonly PhotoShape[];
  /** Featured photo ids (#14). Defaults to none. */
  readonly featured?: readonly string[];
  /** The layout (#20). Defaults to the mosaic. */
  readonly layout?: LayoutKind;
  /** The Columns setting (#20). Defaults to Auto. */
  readonly columns?: ColumnSetting;
}

/** A new state, arranged for `photos` (none by default). */
export function createEditorState(options: CreateOptions = {}): EditorState {
  const canvas = checkCanvas({ ...DEFAULT_CANVAS, ...options.canvas });
  const variation = clampVariation(options.variation ?? DEFAULT_VARIATION);
  const seed = checkSeed(options.seed ?? randomSeed());
  const photos = [...(options.photos ?? [])];
  const featured = normaliseFeatured(options.featured ?? []);
  const setting = checkSetting(
    options.layout ?? 'mosaic',
    options.columns ?? 'auto',
  );
  const arrangement = arrange(
    canvas,
    photos,
    variation,
    seed,
    featured,
    setting,
  );
  return {
    canvas,
    variation,
    seed,
    photos,
    ...arrangement,
    crops: emptyCrops(),
    ...withFeatured(featured),
    ...withSetting(setting),
  };
}

/** The layout and Columns setting that decide which planner runs (#20). */
export interface LayoutSetting {
  readonly layout: LayoutKind;
  readonly columns: ColumnSetting;
}

const LAYOUTS: readonly string[] = ['mosaic', 'grid'];

/** The mosaic with Auto columns: what every state had before #20. */
export const MOSAIC: LayoutSetting = Object.freeze({
  layout: 'mosaic',
  columns: 'auto',
});

/** The state's layout (#20): `'grid'` or `'mosaic'`. */
export function layoutOf(state: Pick<EditorState, 'layout'>): LayoutKind {
  return state.layout === 'grid' ? 'grid' : 'mosaic';
}

/** The state's Columns setting (#20): a number, or `'auto'`. */
export function columnsOf(state: Pick<EditorState, 'columns'>): ColumnSetting {
  return state.columns ?? 'auto';
}

/** The state's layout and Columns setting together. */
export function settingOf(
  state: Pick<EditorState, 'layout' | 'columns'>,
): LayoutSetting {
  return { layout: layoutOf(state), columns: columnsOf(state) };
}

/**
 * The number of columns a grid of these photos has (#20): the setting
 * clamped to 1..the photo count, or for Auto the column count autoColumns
 * picks. 0 for no photos. For the Columns control ("Auto (4)").
 */
export function gridColumnsFor(
  canvas: Pick<CanvasSettings, 'width' | 'height'>,
  photos: readonly PhotoShape[],
  columns: ColumnSetting,
): number {
  if (photos.length === 0) return 0;
  return columns === 'auto'
    ? autoColumns(
        canvas.width / canvas.height,
        photos.map((photo) => photo.aspect),
      )
    : clampColumns(columns, photos.length);
}

/**
 * Switches between Mosaic and Grid (#20). Re-rolls (one undo step); returns
 * `state` itself if it is already in that layout. The dial's value and the
 * Columns setting are kept, so returning to Mosaic restores the dial's
 * arrangement for the seed.
 */
export function setLayout(state: EditorState, layout: LayoutKind): EditorState {
  // Checked at run time too: the value may come from untyped code.
  if (!LAYOUTS.includes(layout)) {
    throw new RangeError("layout must be 'mosaic' or 'grid'");
  }
  if (layout === layoutOf(state)) return state;
  return reroll(replaceSetting(state, { ...settingOf(state), layout }), {});
}

/**
 * Sets the Columns setting (#20): `'auto'` or a whole number from 1 to
 * MAX_COLUMNS. In a grid every change of setting re-rolls (one undo step),
 * even when the column count it gives is the one shown (Auto already
 * picking that count, or two settings both beyond the photo count): like
 * every re-roll it lays out a fresh, equal grid, discarding hand-moved
 * dividers and swaps. In a mosaic only the setting changes. Returns `state`
 * itself if the setting is unchanged. Throws a RangeError for anything else.
 */
export function setColumns(
  state: EditorState,
  columns: ColumnSetting,
): EditorState {
  const setting = checkSetting(layoutOf(state), columns);
  if (setting.columns === columnsOf(state)) return state;
  const next = replaceSetting(state, setting);
  return layoutOf(state) === 'grid' ? reroll(next, {}) : next;
}

/** Re-rolls with a new seed (the Shuffle button). No-op for the same seed. */
export function shuffle(state: EditorState, seed: number): EditorState {
  checkSeed(seed);
  if (seed === state.seed) return state;
  return reroll(state, { seed });
}

export interface SetVariationOptions {
  /**
   * Replace the plan but keep the current assignment, deferring the costly
   * re-assignment (cubic in the photo count) while the dial is dragged.
   * The result is provisional: settle it with {@link rearrange} (EditorStore
   * does this). Every photo still has exactly one tile (the slots keep their
   * numbers), but photos may sit in tiles of the wrong shape.
   */
  readonly keepAssignment?: boolean;
}

/**
 * Moves the size-variation dial (re-rolls). Returns `state` itself if the
 * value is unchanged, so a manual swap survives "committing" the dial at the
 * value it already has.
 *
 * Within one tenth of the dial (one arrangementStep) the plan keeps its
 * structure and slot numbers and only its tiles grow and shrink, and the
 * assignment is chosen for the step, not the exact value (see arrange). So
 * while the dial moves within a tenth, photos stay in their tiles and only
 * the tile sizes change; crossing a tenth re-arranges both.
 */
export function setVariation(
  state: EditorState,
  variation: number,
  options: SetVariationOptions = {},
): EditorState {
  const v = clampVariation(variation);
  if (v === state.variation) return state;
  // A grid's plan does not depend on the dial, so nothing is deferred.
  if (options.keepAssignment && layoutOf(state) === 'mosaic') {
    const plan = planFor(state.canvas, state.photos.length, v, state.seed);
    return { ...state, variation: v, plan };
  }
  return reroll(state, { variation: v });
}

/**
 * Recomputes the plan and assignment for the state's own inputs: a re-roll
 * with nothing changed. Discards manual swaps. Used to settle a provisional
 * state (setVariation with keepAssignment); not a user action.
 */
export function rearrange(state: EditorState): EditorState {
  return reroll(state, {});
}

/**
 * Sets which photos are in the collage (in tray order). Re-rolls if the set
 * of ids changed; returns `state` itself if it did not.
 */
export function setPhotos(
  state: EditorState,
  photos: readonly PhotoShape[],
): EditorState {
  if (sameIdSet(state.photos, photos)) return state;
  return reroll(state, { photos: [...photos] });
}

/**
 * Forgets photos that were removed from the store: drops their crops, and
 * takes them out of the collage (re-rolling) if they were in it.
 */
export function forgetPhotos(
  state: EditorState,
  ids: Iterable<string>,
): EditorState {
  const doomed = new Set(ids);
  const keys = Object.keys(state.crops);
  const crops = keys.some((id) => doomed.has(id))
    ? cropsFrom(
        keys.filter((id) => !doomed.has(id)),
        state.crops,
      )
    : state.crops;
  const photos = state.photos.filter((photo) => !doomed.has(photo.id));
  let next = crops === state.crops ? state : { ...state, crops };
  const featured = featuredOf(state);
  if (featured.some((id) => doomed.has(id))) {
    next = replaceFeatured(
      next,
      featured.filter((id) => !doomed.has(id)),
    );
  }
  return setPhotos(next, photos);
}

/**
 * Sets the canvas size in whole output pixels. Re-rolls only if the ratio
 * changes by more than RATIO_TOLERANCE from the ratio the plan was made for;
 * otherwise (for example 1920 × 1080 to 3840 × 2160, or A4 at 300 dpi to
 * 200 dpi) the plan and assignment are kept.
 */
export function setCanvasSize(
  state: EditorState,
  width: number,
  height: number,
): EditorState {
  // A size in pixels is not a physical size: the description is dropped.
  const canvas = checkCanvas({
    ...withoutPhysical(state.canvas),
    width,
    height,
  });
  return resized(state, canvas);
}

/**
 * Sets the canvas from a physical size: millimetres and DPI, with the pixel
 * size derived (each side rounded to the nearest whole pixel, see
 * pixelsFromMm). Throws a RangeError if the numbers are out of range or give
 * a side outside 1 to MAX_CANVAS_SIDE px.
 *
 * Re-rolls only if the ratio changes by more than RATIO_TOLERANCE, like
 * setCanvasSize: the same paper at another DPI keeps the arrangement, and
 * since the border is a fraction of the shorter side its relative width
 * does too. A paper of another ratio (A4 portrait to landscape) re-rolls.
 * Returns `state` itself when nothing changes.
 */
export function setPhysicalSize(
  state: EditorState,
  widthMm: number,
  heightMm: number,
  dpi: number,
): EditorState {
  const physical = { widthMm, heightMm, dpi };
  const { width, height } = pixelSizeOf(physical);
  const canvas = checkCanvas({ ...state.canvas, width, height, physical });
  return resized(state, canvas);
}

/**
 * Switches to physical units, keeping the pixel size: the millimetres are
 * the current pixels at `dpi` (default 300). Never re-rolls. Returns `state`
 * itself if it is already in physical units (change the DPI with
 * setPhysicalSize). Throws a RangeError if the millimetres would be out of
 * range at this DPI.
 */
export function switchToPhysical(
  state: EditorState,
  dpi: number = DEFAULT_DPI,
): EditorState {
  if (state.canvas.physical !== undefined) return state;
  const { width, height } = state.canvas;
  const physical = physicalFor(width, height, dpi);
  if (physical === null) {
    throw new RangeError(
      `${String(width)} × ${String(height)} px is out of range in millimetres at ${String(dpi)} DPI`,
    );
  }
  return { ...state, canvas: checkCanvas({ ...state.canvas, physical }) };
}

/**
 * Switches to pixels, keeping the pixel size and dropping the physical
 * description. Never re-rolls. Returns `state` itself if it has none.
 */
export function switchToPixels(state: EditorState): EditorState {
  if (state.canvas.physical === undefined) return state;
  return { ...state, canvas: withoutPhysical(state.canvas) };
}

/**
 * Sets the border, as a fraction of the canvas's shorter side (0 to
 * MAX_BORDER_FRACTION), exactly as asked: it is clamped only when drawn
 * (see borderAt). Never re-rolls.
 */
export function setBorder(
  state: EditorState,
  borderFraction: number,
): EditorState {
  const canvas = checkCanvas({ ...state.canvas, borderFraction });
  if (canvas.borderFraction === state.canvas.borderFraction) return state;
  return { ...state, canvas };
}

/** The border in pixels at one output size. */
export interface BorderAt {
  /** What the user asked for: the fraction times the shorter side. */
  readonly requested: number;
  /** What is drawn: `requested`, clamped to `max` (whole pixels). */
  readonly effective: number;
  /**
   * The largest border the current arrangement allows (whole pixels):
   * every tile keeps at least one pixel (`maxBorder`) and none is more
   * stretched than MAX_TILE_ASPECT (`maxBorderForAspect`), both with
   * snapping. A tile stretched by hand (#16) beyond the planner's aspect
   * limit may instead be stretched by the border to 1.2 times its own
   * aspect (MAX_TILE_ASPECT / MAX_PLAN_ASPECT, the same headroom planned
   * tiles get), so a hand-resized layout keeps its border; planned tiles
   * are clamped exactly as before. Infinity when empty. The border control's range ends here, so
   * what it offers is what is drawn.
   */
  readonly max: number;
}

/**
 * No tile may be more stretched than this (long side over short side) by
 * the border: the planner keeps tiles within 2.5:1 with no border, and this
 * leaves room for a border to stretch them a little more.
 */
export const MAX_TILE_ASPECT = 3;

/**
 * The border at `size` (default: the canvas's own pixel size): requested,
 * drawn and the current maximum, in pixels at that size. The renderer draws
 * `effective`; the border control shows all three.
 */
export function borderAt(
  state: Pick<EditorState, 'plan' | 'canvas'>,
  size: { readonly width: number; readonly height: number } = state.canvas,
): BorderAt {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const requested = state.canvas.borderFraction * Math.min(width, height);
  const max =
    state.plan.root === null || width < 1 || height < 1
      ? Infinity
      : Math.min(
          maxBorder(state.plan, width, height, { snap: true }),
          maxBorderForAspect(state.plan, width, height, MAX_TILE_ASPECT, {
            snap: true,
            stretched: {
              above:
                planAspectLimit(state.plan.aspect, 1, state.plan.count) *
                (1 + PLAN_ASPECT_SLACK),
              factor: MAX_TILE_ASPECT / MAX_PLAN_ASPECT,
            },
          }),
        );
  return { requested, effective: Math.min(Math.round(requested), max), max };
}

/** Just inside placeLayout's 2% tolerance between canvas and plan ratio. */
const MAX_RATIO_ERROR = Math.log(1.019);

/**
 * Where each tile goes when `state` is drawn at `size` pixels: the state's
 * plan placed at that size, with the border (a fraction of the shorter
 * side) in whole pixels at that size and every edge snapped to whole pixels (so neighbouring
 * tiles share an edge exactly and no background shows through
 * anti-aliasing seams). The border drawn is borderAt(...).effective: the
 * requested border, clamped to what the arrangement allows (see borderAt).
 */
export function tilesFor(
  state: Pick<EditorState, 'plan' | 'canvas'>,
  size: { readonly width: number; readonly height: number },
): Tile[] {
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

/**
 * The dividers (#16) of `state` drawn at `size`: exactly where tilesFor puts
 * the gaps (same border, same snapping), so hit-testing and highlights match
 * the drawn tiles. Empty whenever tilesFor draws nothing.
 */
export function dividersFor(
  state: Pick<EditorState, 'plan' | 'canvas'>,
  size: { readonly width: number; readonly height: number },
): Divider[] {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (state.plan.root === null || width < 1 || height < 1) return [];
  if (
    Math.abs(Math.log(width / height / state.plan.aspect)) > MAX_RATIO_ERROR
  ) {
    return [];
  }
  const border =
    state.canvas.borderFraction > 0
      ? borderAt(state, { width, height }).effective
      : 0;
  return listDividers(state.plan, { width, height, border, snap: true });
}

/** Sets the background colour (`#rrggbb`, any case). Never re-rolls. */
export function setBackground(
  state: EditorState,
  background: string,
): EditorState {
  const canvas = checkCanvas({ ...state.canvas, background });
  if (canvas.background === state.canvas.background) return state;
  return { ...state, canvas };
}

/**
 * Swaps the photos in two tiles (slots). Only those two entries of the
 * assignment change; the plan, the crops (which belong to photos, so each
 * photo keeps its crop in its new tile) and everything else stay. Swapping a
 * tile with itself returns `state`. Throws a RangeError for a slot that does
 * not exist.
 */
export function swapTiles(
  state: EditorState,
  slotA: number,
  slotB: number,
): EditorState {
  const assignment = swapSlots(state.assignment, slotA, slotB);
  return slotA === slotB ? state : { ...state, assignment };
}

/**
 * Moves the divider at `path` (#16; see listDividers in the layout library)
 * to `fraction` of its region, clamped so that no tile on either side, at
 * any depth, becomes smaller than the minimum (see dividerRange). Only the
 * plan changes, and only that one node's fraction, so the tiles on each side
 * keep their proportions and every photo keeps its slot; crops are re-fitted
 * around their focal points when drawn, as for any change of tile shape.
 * Never re-rolls, and nothing moves for featured photos. Returns `state`
 * itself if the clamped fraction is the current one. Throws a RangeError for
 * a path with no divider or a fraction that is not finite.
 *
 * The range depends on the tile sizes in `state` (a tile already below the
 * minimum may not shrink further, but may grow back to where it was), so a
 * gesture applies every step to the state it started from (see
 * sameButPlan): then the commit is one call at the final value, and a drag
 * can always return to where it began.
 */
export function moveDivider(
  state: EditorState,
  path: string,
  fraction: number,
): EditorState {
  const plan = setDividerFraction(state.plan, path, fraction);
  return plan === state.plan ? state : { ...state, plan };
}

/**
 * True when `a` and `b` differ at most in their plan's fractions: the same
 * objects for everything else (as moveDivider leaves them) and the same tree.
 * A divider gesture uses it to tell its own steps from a change made
 * elsewhere meanwhile.
 */
export function sameButPlan(a: EditorState, b: EditorState): boolean {
  if (a === b) return true;
  return (
    a.canvas === b.canvas &&
    a.variation === b.variation &&
    a.seed === b.seed &&
    a.photos === b.photos &&
    a.assignment === b.assignment &&
    a.crops === b.crops &&
    a.featured === b.featured &&
    a.layout === b.layout &&
    a.columns === b.columns &&
    onlyResized(a.plan, b.plan)
  );
}

/**
 * True when two plans are the same arrangement apart from hand resizing:
 * the same inputs and the same tree, with any fractions. Tile selection
 * uses it to keep the selection across a divider move (#16).
 */
export function onlyResized(a: LayoutPlan, b: LayoutPlan): boolean {
  return (
    a === b ||
    (a.aspect === b.aspect &&
      a.kind === b.kind &&
      a.count === b.count &&
      a.variation === b.variation &&
      a.seed === b.seed &&
      sameTree(a.root, b.root))
  );
}

function sameTree(a: LayoutNode | null, b: LayoutNode | null): boolean {
  if (a === b) return true;
  if (a?.kind !== b?.kind || a === null || b === null) return false;
  if (a.kind === 'leaf') return a.slot === (b as typeof a).slot;
  const s = b as typeof a;
  return (
    a.axis === s.axis &&
    sameTree(a.first, s.first) &&
    sameTree(a.second, s.second)
  );
}

/** The featured photo ids (#14), sorted; empty when none. */
export function featuredOf(state: EditorState): readonly string[] {
  return state.featured ?? NONE;
}

/** Whether a photo is featured (#14), whether or not it is in the collage. */
export function isFeatured(state: EditorState, photoId: string): boolean {
  return featuredOf(state).includes(photoId);
}

/**
 * Features or unfeatures one photo (#14). Returns `state` itself if the mark
 * is already as asked.
 *
 * Featuring a photo in the collage moves it at once into the largest tile not
 * held by another featured photo, by swapping with that tile's photo, unless
 * it is already in one of the k largest tiles (k: the featured photos in the
 * collage, this one included), when nothing moves. Tiles are ranked as
 * arrange ranks them (the shown plan as drawn and exported: tilesFor at the
 * canvas's pixel size, border and snapping included; ties in slot order), so
 * the photo lands where the next re-roll would keep it. At most one swap, so
 * one dispatch is one undo step with the swap in it.
 *
 * Unfeaturing never moves anything. Marking a photo that is not in the
 * collage (excluded) only marks it. Throws a RangeError for an empty id.
 */
export function setFeatured(
  state: EditorState,
  photoId: string,
  featured: boolean,
): EditorState {
  if (typeof photoId !== 'string' || photoId === '') {
    throw new RangeError('photo id must be a non-empty string');
  }
  const current = featuredOf(state);
  if (current.includes(photoId) === featured) return state;
  if (!featured) {
    return replaceFeatured(
      state,
      current.filter((id) => id !== photoId),
    );
  }
  const next = replaceFeatured(state, [...current, photoId]);
  const slot = state.assignment.indexOf(photoId);
  if (slot < 0) return next;
  const marked = new Set(featuredOf(next));
  const k = state.assignment.filter((id) => marked.has(id)).length;
  const order = slotOrder(state.plan, state.canvas);
  if (order.slice(0, k).includes(slot)) return next;
  // In a grid (#20) many cells are the same size: a photo already in a cell
  // as large as the kth largest is in one of the k largest, and moving it
  // to another cell of the same size would be a pointless swap.
  if (state.plan.kind === 'grid') {
    const sizes = gridSizes(state.plan, state.canvas);
    if ((sizes[slot] as number) >= (sizes[order[k - 1] as number] as number)) {
      return next;
    }
  }
  const target = order.find((s) => {
    const id = state.assignment[s] as string;
    return id === photoId || !marked.has(id);
  }) as number;
  return { ...next, assignment: swapSlots(state.assignment, slot, target) };
}

/** Sets one photo's crop (normalised). Never re-rolls. */
export function setCrop(
  state: EditorState,
  photoId: string,
  crop: Partial<Crop>,
): EditorState {
  const next = normaliseCrop(crop);
  const current = Object.hasOwn(state.crops, photoId)
    ? state.crops[photoId]
    : undefined;
  if (current ? sameCrop(current, next) : isDefaultCrop(next)) return state;
  const keys = Object.keys(state.crops).filter((id) => id !== photoId);
  const crops = cropsFrom(keys, state.crops) as Record<string, Crop>;
  if (!isDefaultCrop(next)) crops[photoId] = next;
  return { ...state, crops };
}

/** A photo's crop, or the default if it has none. */
export function cropOf(state: EditorState, photoId: string): Crop {
  return Object.hasOwn(state.crops, photoId)
    ? (state.crops[photoId] as Crop)
    : DEFAULT_CROP;
}

/** A fresh random seed (a 32-bit unsigned integer). */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] as number;
}

/**
 * The arrangement for these inputs: the plan at exactly `variation`, and the
 * canonical assignment for its step.
 *
 * The assignment is computed from the plan at the step value
 * (`arrangementStep(variation)`), which has the same structure and slot
 * numbers as the plan at `variation`, so it is the same for every variation
 * within a tenth. That is what keeps photos in their tiles while the dial is
 * dragged within a tenth, and it makes the result path-independent: it
 * depends only on the arguments, never on the state before.
 *
 * Grid (#20, `setting`): the plan is planGrid's for the setting's column
 * count (gridColumnsFor), the same for every variation and seed, and the
 * assignment is made on that plan itself; the seed still decides which of
 * the photos that fit a cell equally well goes where, so Shuffle moves
 * photos between cells. With the default setting (the mosaic) this is
 * exactly the arrangement from before grids existed.
 *
 * Featured photos (#14): with k of `featured` among `photos` (0 < k < the
 * photo count), they take the k largest tiles of the plan at `variation`
 * itself (the plan that is shown), ranked by the area of each tile as it is
 * drawn and exported: tilesFor at the canvas's pixel size, with the
 * effective border and snapped edges, which can reorder tiles of nearly
 * equal area. Ties (common in whole pixels) go in slot order. Within a tenth the step plan's tiles are a little larger or
 * smaller than the shown ones and can rank differently (about 4% of cases
 * measured, between tiles within a few percent of each other in area), so
 * ranking the step plan could leave a featured photo in the (k+1)th largest
 * tile; ranking the shown plan never does. The photos are then matched
 * within those tiles, and the rest within the others, by the usual cost on
 * the step plan's shapes. With nothing (or everything) featured this is the
 * plain assignment.
 *
 * Assignment costs O(n³), so the last few results are cached; the cache never
 * changes a result (see clearArrangementCache).
 */
export function arrange(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
  featured: readonly string[] = [],
  setting: LayoutSetting = MOSAIC,
): { plan: LayoutPlan; assignment: string[] } {
  const v = clampVariation(variation);
  const plan = shownPlan(canvas, photos, v, seed, setting);
  return {
    plan,
    assignment: [
      ...canonicalAssignment(
        canvas,
        photos,
        v,
        seed,
        featuredSlotsFor(canvas, photos, plan, featured),
        setting,
      ),
    ],
  };
}

/**
 * True when the assignment for these inputs is already cached, so that a
 * full setVariation will not run the costly assignment. The app uses it to
 * decide whether to defer re-assignment during a drag.
 */
export function isAssignmentCached(
  state: EditorState,
  variation: number,
): boolean {
  const setting = settingOf(state);
  return assignmentCache.has(
    assignmentKey(
      state.canvas,
      state.photos,
      clampVariation(variation),
      state.seed,
      featuredSlotsFor(
        state.canvas,
        state.photos,
        () =>
          shownPlan(
            state.canvas,
            state.photos,
            clampVariation(variation),
            state.seed,
            setting,
          ),
        featuredOf(state),
      ),
      setting,
    ),
  );
}

/** Empties the assignment cache (for tests: results must not change). */
export function clearArrangementCache(): void {
  assignmentCache.clear();
}

export interface ValidateOptions {
  /**
   * Every photo id the project has, included or not (for a saved project:
   * the photos in the zip). Crops may only name these. Defaults to the
   * state's own (included) photos.
   */
  readonly photoIds?: Iterable<string>;
}

/**
 * Checks an untrusted value (a saved project, #12) and returns a freshly
 * built, clean EditorState: no extra fields, no shared references, crops
 * in a prototype-less object. Throws a RangeError unless:
 *
 * - the canvas is whole pixels from 1 to MAX_CANVAS_SIDE, the background is
 *   `#rrggbb` (any case; normalised to lower case), and the border fraction
 *   is 0 to MAX_BORDER_FRACTION; if it has a physical size, that is finite
 *   millimetres in range and a whole DPI in range, and gives these pixels
 *   (see checkPhysical);
 * - the variation is 0..1 and the seed a non-negative safe integer;
 * - every photo has a unique, non-empty string id and an aspect within
 *   1:MAX_PHOTO_ASPECT and MAX_PHOTO_ASPECT:1;
 * - the plan is well-formed, matches the photo count, variation and seed and
 *   (within RATIO_TOLERANCE) the canvas ratio, and keeps every tile within
 *   the planner's own aspect limit (planAspectLimit), which every plan
 *   planLayout makes satisfies, or, for a tile resized by hand (#16), at
 *   least MIN_TILE_FRACTION of the shorter side both ways (checkTileSizes),
 *   so a tampered plan cannot hide tiles by squashing them to nothing. The
 *   rule depends only on the plan, so any state the actions produce
 *   validates, however small the canvas;
 * - the assignment places every photo exactly once;
 * - every crop is in range and names a known photo (see ValidateOptions);
 * - `layout`, if present, is `'grid'`, and the plan is a grid exactly when it
 *   is (validatePlan has checked a grid's tree, and checkTileSizes allows
 *   its cells their own shape); `columns`, if present, is a whole number
 *   from 1 to MAX_COLUMNS and, in a grid, matches the plan's column count
 *   (clamped to the photo count). With Auto any column count is accepted:
 *   it was chosen for the photos, and the plan is stored, not re-derived.
 */
export function validateEditorState(
  value: unknown,
  options: ValidateOptions = {},
): EditorState {
  if (!isRecord(value)) throw new RangeError('state must be an object');
  const { canvas, variation, seed, photos, plan, assignment, crops } = value;
  const { featured, layout, columns } = value;
  if (!isRecord(canvas)) throw new RangeError('canvas must be an object');
  const checkedCanvas = checkCanvas({
    width: canvas.width as number,
    height: canvas.height as number,
    borderFraction: canvas.borderFraction as number,
    background: canvas.background as string,
    physical: canvas.physical as PhysicalSize | undefined,
  });
  if (typeof variation !== 'number' || !(variation >= 0 && variation <= 1)) {
    throw new RangeError('variation must be a number from 0 to 1');
  }
  const checkedSeed = checkSeed(seed as number);
  if (!Array.isArray(photos)) throw new RangeError('photos must be an array');
  const checkedPhotos: PhotoShape[] = photos.map((photo: unknown) => {
    if (!isRecord(photo) || typeof photo.id !== 'string' || photo.id === '') {
      throw new RangeError('each photo needs a non-empty string id');
    }
    const aspect = photo.aspect;
    if (
      typeof aspect !== 'number' ||
      !(aspect >= 1 / MAX_PHOTO_ASPECT && aspect <= MAX_PHOTO_ASPECT)
    ) {
      throw new RangeError(
        `photo ${JSON.stringify(photo.id)} has a bad aspect`,
      );
    }
    return { id: photo.id, aspect };
  });

  let checkedPlan: LayoutPlan;
  try {
    checkedPlan = clonePlan(validatePlan(plan));
  } catch (error) {
    throw new RangeError(`invalid plan: ${String(error)}`, { cause: error });
  }
  if (checkedPlan.count !== checkedPhotos.length) {
    throw new RangeError('plan and photos differ in count');
  }
  if (
    !sameRatio(checkedPlan.aspect, checkedCanvas.width / checkedCanvas.height)
  ) {
    throw new RangeError('plan was made for another canvas ratio');
  }
  if (checkedPlan.variation !== variation || checkedPlan.seed !== seed) {
    throw new RangeError('plan does not match the variation and seed');
  }
  // Placed in its own ratio with no border, every tile of a plan from
  // planLayout is within planAspectLimit (measured to float precision), and
  // every tile resized by hand (#16) that is beyond it is at least
  // MIN_TILE_FRACTION both ways (see checkTileSizes).
  if (checkTileSizes(checkedPlan) === 'invalid') {
    throw new RangeError('plan has tiles squashed beyond the aspect limit');
  }

  // Optional (#20): absent in projects saved before grids, and for the
  // mosaic and Auto. The plan is a grid exactly when the layout is, and a
  // grid with a number of columns has that many (clamped to the count).
  if (layout !== undefined && layout !== 'grid') {
    throw new RangeError("layout must be 'grid' or absent");
  }
  if (
    columns !== undefined &&
    !(
      typeof columns === 'number' &&
      Number.isInteger(columns) &&
      columns >= 1 &&
      columns <= MAX_COLUMNS
    )
  ) {
    throw new RangeError(
      `columns must be a whole number from 1 to ${String(MAX_COLUMNS)}`,
    );
  }
  if ((checkedPlan.kind === 'grid') !== (layout === 'grid')) {
    throw new RangeError('plan and layout disagree');
  }
  if (
    layout === 'grid' &&
    typeof columns === 'number' &&
    checkedPlan.count > 0 &&
    gridColumnsOf(checkedPlan) !== clampColumns(columns, checkedPlan.count)
  ) {
    throw new RangeError('grid plan and columns disagree');
  }

  if (!Array.isArray(assignment)) {
    throw new RangeError('assignment must be an array');
  }
  // Also checks that ids are unique.
  validateAssignment(assignment, checkedPhotos);

  if (!isRecord(crops)) throw new RangeError('crops must be an object');
  const known = new Set(
    options.photoIds ?? checkedPhotos.map((photo) => photo.id),
  );
  const checkedCrops = emptyCrops() as Record<string, Crop>;
  for (const id of Object.keys(crops)) {
    if (!known.has(id)) {
      throw new RangeError(`crop for unknown photo ${JSON.stringify(id)}`);
    }
    const crop = crops[id];
    if (
      !isRecord(crop) ||
      typeof crop.x !== 'number' ||
      typeof crop.y !== 'number' ||
      typeof crop.zoom !== 'number'
    ) {
      throw new RangeError(`crop for ${JSON.stringify(id)} is invalid`);
    }
    const normal = normaliseCrop(crop);
    if (!sameCrop(normal, crop as unknown as Crop)) {
      throw new RangeError(`crop for ${JSON.stringify(id)} is out of range`);
    }
    if (!isDefaultCrop(normal)) checkedCrops[id] = normal;
  }

  // Optional: absent in projects saved before #14, and when none is featured.
  let checkedFeatured: string[] = [];
  if (featured !== undefined) {
    if (!Array.isArray(featured)) {
      throw new RangeError('featured must be an array');
    }
    for (const id of featured as unknown[]) {
      if (typeof id !== 'string' || !known.has(id)) {
        throw new RangeError(
          `featured names an unknown photo ${JSON.stringify(id)}`,
        );
      }
    }
    checkedFeatured = normaliseFeatured(featured as string[]);
    if (checkedFeatured.length !== featured.length) {
      throw new RangeError('featured names a photo twice');
    }
  }
  return {
    canvas: checkedCanvas,
    variation,
    seed: checkedSeed,
    photos: checkedPhotos,
    plan: checkedPlan,
    assignment: [...assignment],
    crops: checkedCrops,
    ...withFeatured(checkedFeatured),
    ...withSetting({
      layout: layout === 'grid' ? 'grid' : 'mosaic',
      columns: typeof columns === 'number' ? columns : 'auto',
    }),
  };
}

// --- Internals ---------------------------------------------------------------

function reroll(
  state: EditorState,
  changes: Partial<
    Pick<EditorState, 'canvas' | 'photos' | 'variation' | 'seed'>
  >,
): EditorState {
  const next = { ...state, ...changes };
  const arrangement = arrange(
    next.canvas,
    next.photos,
    next.variation,
    next.seed,
    featuredOf(next),
    settingOf(next),
  );
  return { ...next, ...arrangement };
}

/** Checks a layout and Columns setting (#20); returns it normalised. */
function checkSetting(
  layout: LayoutKind,
  columns: ColumnSetting,
): LayoutSetting {
  // Checked at run time too: the value may come from untyped code.
  if (!LAYOUTS.includes(layout)) {
    throw new RangeError("layout must be 'mosaic' or 'grid'");
  }
  if (
    columns !== 'auto' &&
    !(Number.isInteger(columns) && columns >= 1 && columns <= MAX_COLUMNS)
  ) {
    throw new RangeError(
      `columns must be 'auto' or a whole number from 1 to ${String(MAX_COLUMNS)}`,
    );
  }
  return { layout, columns };
}

/** `{ layout, columns }` with the defaults left out (absent keys). */
function withSetting(setting: LayoutSetting): {
  layout?: 'grid';
  columns?: number;
} {
  return {
    ...(setting.layout === 'grid' ? { layout: 'grid' as const } : {}),
    ...(setting.columns === 'auto' ? {} : { columns: setting.columns }),
  };
}

/** `state` with another layout setting (defaults as absent keys). */
function replaceSetting(
  state: EditorState,
  setting: LayoutSetting,
): EditorState {
  const rest: EditorState = { ...state };
  delete (rest as { layout?: 'grid' }).layout;
  delete (rest as { columns?: number }).columns;
  return { ...rest, ...withSetting(setting) };
}

/** The plan arrange shows for these inputs: a mosaic or a grid. */
function shownPlan(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
  setting: LayoutSetting,
): LayoutPlan {
  if (setting.layout === 'mosaic') {
    return planFor(canvas, photos.length, variation, seed);
  }
  return planGrid({
    width: canvas.width,
    height: canvas.height,
    count: photos.length,
    columns: Math.max(1, gridColumnsFor(canvas, photos, setting.columns)),
    variation,
    seed,
  });
}

const NONE: readonly string[] = Object.freeze([]);

/** Sorted (by code unit), without repeats. */
function normaliseFeatured(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `{ featured }`, or nothing for none: the key is absent when empty. */
function withFeatured(featured: readonly string[]): {
  featured?: readonly string[];
} {
  return featured.length === 0 ? {} : { featured: Object.freeze(featured) };
}

/** `state` with another featured list (normalised; absent when empty). */
function replaceFeatured(
  state: EditorState,
  featured: readonly string[],
): EditorState {
  const rest: EditorState = { ...state };
  delete (rest as { featured?: readonly string[] }).featured;
  return { ...rest, ...withFeatured(normaliseFeatured(featured)) };
}

/**
 * Every slot of a plan, largest first, as arrange and setFeatured rank them
 * (#14): by the area of the tile as it is drawn and exported, at the canvas's
 * own pixel size with its effective border and snapped edges (tilesFor, the
 * function the renderer and the export use). Equal areas, common with whole
 * pixels, are in slot order.
 */
function slotOrder(plan: LayoutPlan, canvas: CanvasSettings): number[] {
  if (plan.root === null) return [];
  if (plan.kind === 'grid') {
    const sizes = gridSizes(plan, canvas);
    return sizes
      .map((_, i) => i)
      .sort((a, b) => (sizes[b] as number) - (sizes[a] as number) || a - b);
  }
  let tiles = tilesFor({ plan, canvas }, canvas);
  // tilesFor draws nothing only for a canvas a few pixels across whose
  // rounding distorts the ratio; rank the exact geometry then.
  if (tiles.length !== plan.count) {
    tiles = placeLayout(plan, { width: canvas.width, height: canvas.height });
  }
  const bySlot: Tile[] = [];
  for (const tile of tiles) bySlot[tile.slot] = tile;
  return slotsBySize(bySlot);
}

/**
 * Each slot's tile area in a grid plan (#20), for ranking: the exact tiles
 * at the canvas's pixel size with its effective border, before snapping,
 * rounded to 9 significant digits of the largest. Rounding to whole pixels
 * makes cells of one row differ by a pixel, so ranking drawn pixels would
 * pick featured cells by rounding; in exact geometry a full row's cells are
 * equal (ties go in slot order) and a partial last row's are larger.
 */
function gridSizes(plan: LayoutPlan, canvas: CanvasSettings): number[] {
  const border =
    canvas.borderFraction > 0
      ? borderAt({ plan, canvas }, canvas).effective
      : 0;
  let tiles: Tile[];
  try {
    tiles = placeLayout(plan, {
      width: canvas.width,
      height: canvas.height,
      border,
    });
  } catch {
    tiles = placeLayout(plan, { width: canvas.width, height: canvas.height });
  }
  const areas = tiles.map((t) => t.width * t.height);
  const largest = Math.max(...areas);
  return areas.map((a) => Math.round((a / largest) * 1e9));
}

/** Which featured photos go where (for canonicalAssignment). */
interface FeaturedSlots {
  /** The featured photos in the collage, sorted. */
  readonly ids: readonly string[];
  /** The slots they take, in slot order. */
  readonly slots: readonly number[];
}

/**
 * The slots the featured photos among `photos` must take: the k largest of
 * the shown plan (`plan`, or a function making it, so it is only made when
 * needed). Null when there are none to place, or every photo is featured
 * (then the plain assignment applies).
 */
function featuredSlotsFor(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  plan: LayoutPlan | (() => LayoutPlan),
  featured: readonly string[],
): FeaturedSlots | null {
  if (featured.length === 0) return null;
  const marked = new Set(featured);
  const ids = photos.filter((p) => marked.has(p.id)).map((p) => p.id);
  if (ids.length === 0 || ids.length === photos.length) return null;
  const shown = typeof plan === 'function' ? plan() : plan;
  return {
    ids: normaliseFeatured(ids),
    slots: slotOrder(shown, canvas)
      .slice(0, ids.length)
      .sort((a, b) => a - b),
  };
}

/** Floating-point slack on the plan aspect limit when validating. */
const PLAN_ASPECT_SLACK = 1e-6;

function planFor(
  canvas: CanvasSettings,
  count: number,
  variation: number,
  seed: number,
): LayoutPlan {
  return planLayout({
    width: canvas.width,
    height: canvas.height,
    count,
    variation,
    seed,
  });
}

/** A deep copy of a plan with only the known fields. */
function clonePlan(plan: LayoutPlan): LayoutPlan {
  const node = (n: LayoutNode): LayoutNode =>
    n.kind === 'leaf'
      ? { kind: 'leaf', slot: n.slot }
      : {
          kind: 'split',
          axis: n.axis,
          fraction: n.fraction,
          first: node(n.first),
          second: node(n.second),
        };
  return {
    aspect: plan.aspect,
    count: plan.count,
    variation: plan.variation,
    seed: plan.seed,
    ...(plan.kind === 'grid' ? { kind: 'grid' as const } : {}),
    root: plan.root === null ? null : node(plan.root),
  };
}

const ASSIGNMENT_CACHE_SIZE = 8;
const assignmentCache = new Map<string, readonly string[]>();

function assignmentKey(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
  featured: FeaturedSlots | null,
  setting: LayoutSetting,
): string {
  const shapes = photos.map((p) => `${p.id}:${String(p.aspect)}`).join('|');
  // A grid's assignment does not depend on the dial: its key names the
  // columns instead. A mosaic's key is unchanged.
  const step =
    setting.layout === 'grid'
      ? `grid:${String(gridColumnsFor(canvas, photos, setting.columns))}`
      : String(arrangementStep(variation));
  const key = `${String(canvas.width / canvas.height)}/${step}/${String(seed)}/${shapes}`;
  // Unchanged when nothing is featured. JSON keeps any id unambiguous.
  return featured === null
    ? key
    : `${key}/featured:${JSON.stringify([featured.ids, featured.slots])}`;
}

function canonicalAssignment(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
  featured: FeaturedSlots | null,
  setting: LayoutSetting,
): readonly string[] {
  if (photos.length === 0) return [];
  const key = assignmentKey(canvas, photos, variation, seed, featured, setting);
  const cached = assignmentCache.get(key);
  if (cached) {
    // Refresh its place in the least-recently-used order.
    assignmentCache.delete(key);
    assignmentCache.set(key, cached);
    return cached;
  }
  const stepPlan =
    setting.layout === 'grid'
      ? shownPlan(canvas, photos, variation, seed, setting)
      : planFor(canvas, photos.length, arrangementStep(variation), seed);
  // No border: the border must never change which photo goes where.
  const slots = placeLayout(stepPlan, {
    width: canvas.width,
    height: canvas.height,
  });
  const assignment = Object.freeze(
    assignPhotos(
      slots,
      photos,
      featured === null
        ? { seed }
        : { seed, featured: featured.ids, featuredSlots: featured.slots },
    ),
  );
  assignmentCache.set(key, assignment);
  while (assignmentCache.size > ASSIGNMENT_CACHE_SIZE) {
    assignmentCache.delete(assignmentCache.keys().next().value as string);
  }
  return assignment;
}

/** A crop map with no prototype. */
function emptyCrops(): CropMap {
  return Object.create(null) as CropMap;
}

/** A new prototype-less crop map with `keys` copied from `from`. */
function cropsFrom(keys: readonly string[], from: CropMap): CropMap {
  const out = emptyCrops() as Record<string, Crop>;
  for (const key of keys) out[key] = from[key] as Crop;
  return out;
}

/** Applies a checked canvas: re-rolls only if its ratio changed. */
function resized(state: EditorState, canvas: CanvasSettings): EditorState {
  const same =
    canvas.width === state.canvas.width &&
    canvas.height === state.canvas.height;
  if (same && samePhysical(canvas.physical, state.canvas.physical)) {
    return state;
  }
  if (same || sameRatio(canvas.width / canvas.height, state.plan.aspect)) {
    return { ...state, canvas };
  }
  return reroll(state, { canvas });
}

/** The canvas without its physical description (the key is removed). */
function withoutPhysical(canvas: CanvasSettings): CanvasSettings {
  const { width, height, borderFraction, background } = canvas;
  return { width, height, borderFraction, background };
}

function checkCanvas(canvas: CanvasSettings): CanvasSettings {
  const { width, height, borderFraction } = canvas;
  for (const side of [width, height]) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_CANVAS_SIDE) {
      throw new RangeError(
        `canvas width and height must be whole numbers from 1 to ${String(MAX_CANVAS_SIDE)}`,
      );
    }
  }
  if (
    typeof borderFraction !== 'number' ||
    !(borderFraction >= 0 && borderFraction <= MAX_BORDER_FRACTION)
  ) {
    throw new RangeError(
      `border must be a fraction from 0 to ${String(MAX_BORDER_FRACTION)}`,
    );
  }
  const background =
    typeof canvas.background === 'string'
      ? canvas.background.toLowerCase()
      : '';
  if (!/^#[0-9a-f]{6}$/.test(background)) {
    throw new RangeError('background must be a #rrggbb colour');
  }
  const checked = { width, height, borderFraction, background };
  return canvas.physical === undefined
    ? checked
    : { ...checked, physical: checkPhysical(canvas.physical, width, height) };
}

function checkSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError('seed must be a non-negative integer');
  }
  return seed;
}

function clampVariation(variation: number): number {
  if (typeof variation !== 'number' || Number.isNaN(variation)) {
    throw new RangeError('variation must be a number');
  }
  return Math.min(1, Math.max(0, variation));
}

function sameIdSet(
  a: readonly PhotoShape[],
  b: readonly PhotoShape[],
): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((photo) => photo.id));
  return b.every((photo) => ids.has(photo.id));
}

function sameRatio(a: number, b: number): boolean {
  return Math.abs(a / b - 1) <= RATIO_TOLERANCE;
}

function sameCrop(a: Crop, b: Crop): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
