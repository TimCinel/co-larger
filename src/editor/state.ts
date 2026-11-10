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
 *   size, which rounds to slightly different ratios, keeps the layout).
 * - Crops belong to the photo and survive re-rolls (and exclusion). They are
 *   dropped only when the photo leaves the store (forgetPhotos).
 * - Manual swaps (#8: `swapSlots` on `assignment`) do not survive a re-roll,
 *   but survive every action that does not re-roll, including setting the
 *   dial to the value it already has.
 *
 * Determinism: after any re-roll the plan and the assignment are a function
 * of (canvas ratio, photos, variation, seed) only, never of the previous
 * state. See {@link arrange}.
 */
import {
  arrangementStep,
  assignPhotos,
  maxBorder,
  maxBorderForAspect,
  placeLayout,
  planAspectLimit,
  planLayout,
  validateAssignment,
  validatePlan,
  type LayoutNode,
  type LayoutPlan,
  type PhotoShape,
} from '../layout';
import { DEFAULT_CROP, isDefaultCrop, normaliseCrop, type Crop } from './crop';

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
}

export interface CreateOptions {
  /** Defaults to a random seed: pass one for reproducible states. */
  readonly seed?: number;
  readonly canvas?: Partial<CanvasSettings>;
  readonly variation?: number;
  readonly photos?: readonly PhotoShape[];
}

/** A new state, arranged for `photos` (none by default). */
export function createEditorState(options: CreateOptions = {}): EditorState {
  const canvas = checkCanvas({ ...DEFAULT_CANVAS, ...options.canvas });
  const variation = clampVariation(options.variation ?? DEFAULT_VARIATION);
  const seed = checkSeed(options.seed ?? randomSeed());
  const photos = [...(options.photos ?? [])];
  const arrangement = arrange(canvas, photos, variation, seed);
  return {
    canvas,
    variation,
    seed,
    photos,
    ...arrangement,
    crops: emptyCrops(),
  };
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
  if (options.keepAssignment) {
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
  const next = crops === state.crops ? state : { ...state, crops };
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
  const canvas = checkCanvas({ ...state.canvas, width, height });
  if (
    canvas.width === state.canvas.width &&
    canvas.height === state.canvas.height
  ) {
    return state;
  }
  if (sameRatio(canvas.width / canvas.height, state.plan.aspect)) {
    return { ...state, canvas };
  }
  return reroll(state, { canvas });
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
   * snapping. Infinity when empty. The border control's range ends here, so
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
  state: EditorState,
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
          }),
        );
  return { requested, effective: Math.min(Math.round(requested), max), max };
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
 * Assignment costs O(n³), so the last few results are cached; the cache never
 * changes a result (see clearArrangementCache).
 */
export function arrange(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
): { plan: LayoutPlan; assignment: string[] } {
  const v = clampVariation(variation);
  const plan = planFor(canvas, photos.length, v, seed);
  return {
    plan,
    assignment: [...canonicalAssignment(canvas, photos, v, seed)],
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
  return assignmentCache.has(
    assignmentKey(
      state.canvas,
      state.photos,
      clampVariation(variation),
      state.seed,
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
 *   is 0 to MAX_BORDER_FRACTION;
 * - the variation is 0..1 and the seed a non-negative safe integer;
 * - every photo has a unique, non-empty string id and an aspect within
 *   1:MAX_PHOTO_ASPECT and MAX_PHOTO_ASPECT:1;
 * - the plan is well-formed, matches the photo count, variation and seed and
 *   (within RATIO_TOLERANCE) the canvas ratio, and keeps every tile within
 *   the planner's own aspect limit (planAspectLimit), which every plan
 *   planLayout makes satisfies, so a tampered plan cannot hide tiles by
 *   squashing them to nothing. The rule depends only on the plan, so any
 *   state the actions produce validates, however small the canvas;
 * - the assignment places every photo exactly once;
 * - every crop is in range and names a known photo (see ValidateOptions).
 */
export function validateEditorState(
  value: unknown,
  options: ValidateOptions = {},
): EditorState {
  if (!isRecord(value)) throw new RangeError('state must be an object');
  const { canvas, variation, seed, photos, plan, assignment, crops } = value;
  if (!isRecord(canvas)) throw new RangeError('canvas must be an object');
  const checkedCanvas = checkCanvas({
    width: canvas.width as number,
    height: canvas.height as number,
    borderFraction: canvas.borderFraction as number,
    background: canvas.background as string,
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
  if (checkedPlan.root !== null) {
    // Placed in its own ratio with no border, every tile of a plan from
    // planLayout is within planAspectLimit (measured to float precision).
    const limit =
      planAspectLimit(checkedPlan.aspect, 1, checkedPlan.count) *
      (1 + PLAN_ASPECT_SLACK);
    const tiles = placeLayout(checkedPlan, {
      width: checkedPlan.aspect,
      height: 1,
    });
    for (const tile of tiles) {
      const long = Math.max(tile.width, tile.height);
      const short = Math.min(tile.width, tile.height);
      if (!(short > 0) || long / short > limit) {
        throw new RangeError('plan has tiles squashed beyond the aspect limit');
      }
    }
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
  return {
    canvas: checkedCanvas,
    variation,
    seed: checkedSeed,
    photos: checkedPhotos,
    plan: checkedPlan,
    assignment: [...assignment],
    crops: checkedCrops,
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
  );
  return { ...next, ...arrangement };
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
): string {
  const shapes = photos.map((p) => `${p.id}:${String(p.aspect)}`).join('|');
  return `${String(canvas.width / canvas.height)}/${String(arrangementStep(variation))}/${String(seed)}/${shapes}`;
}

function canonicalAssignment(
  canvas: CanvasSettings,
  photos: readonly PhotoShape[],
  variation: number,
  seed: number,
): readonly string[] {
  if (photos.length === 0) return [];
  const key = assignmentKey(canvas, photos, variation, seed);
  const cached = assignmentCache.get(key);
  if (cached) {
    // Refresh its place in the least-recently-used order.
    assignmentCache.delete(key);
    assignmentCache.set(key, cached);
    return cached;
  }
  const stepPlan = planFor(
    canvas,
    photos.length,
    arrangementStep(variation),
    seed,
  );
  // No border: the border must never change which photo goes where.
  const slots = placeLayout(stepPlan, {
    width: canvas.width,
    height: canvas.height,
  });
  const assignment = Object.freeze(assignPhotos(slots, photos, { seed }));
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
  return { width, height, borderFraction, background };
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
