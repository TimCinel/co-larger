/**
 * The editor state: everything that decides what the collage looks like, as
 * one plain, JSON-serialisable snapshot, changed only by the pure actions in
 * this module. No DOM, no blobs, no class instances, so it is unit-testable
 * in Node and later issues get the following almost for free:
 *
 * - Undo and redo (#10): a stack of snapshots. Every action returns a new
 *   object and never mutates its input, and unchanged parts keep their
 *   identity, so snapshots are cheap to keep.
 * - Save and load (#12): `JSON.stringify(state)` and
 *   `validateEditorState(JSON.parse(text))`. The plan and the assignment are
 *   stored, not re-derived from the seed, as the layout library asks (its
 *   results depend on floating-point details that may differ between
 *   browsers).
 * - Export (#11): renderCollage (render.ts) draws a snapshot at any size.
 *
 * Relation to PhotoStore: the PhotoStore owns the photos themselves (the
 * original files, the preview and thumbnail blobs, the tray's include
 * toggles) and is the source of truth for which photos exist and which are
 * included. The editor state refers to photos only by id, and keeps the
 * included photos' ids and aspect ratios (`photos`), which is all layout and
 * assignment need. The app copies the included set from the store into the
 * state (setPhotos) whenever the store changes. Keeping the ids and aspects
 * here rather than reading the store makes every action a pure function of
 * the snapshot, makes a snapshot self-describing (an undo step that removed
 * a photo knows which photos it had; #10 then sets the store's include flags
 * back from `photos`), and lets the JSON be validated without the files.
 *
 * Re-roll rules (spec.md): a re-roll replaces the plan and the assignment.
 *
 * - Re-roll: shuffle (new seed), setVariation, setCanvasSize when the ratio
 *   changes, and setPhotos when the set of included photos changes.
 * - No re-roll: setBorder, setBackground, setCanvasSize at the same ratio,
 *   setCrop.
 * - Crops belong to the photo and survive re-rolls (and exclusion). They are
 *   dropped only when the photo leaves the store (forgetPhotos).
 * - Manual swaps (#8: `swapSlots` on `assignment`) do not survive a re-roll.
 *
 * Determinism: after any re-roll the plan and the assignment are a function
 * of (canvas ratio, photos, variation, seed) only, never of the previous
 * state. See {@link arrange}.
 */
import {
  arrangementStep,
  assignPhotos,
  placeLayout,
  planLayout,
  validateAssignment,
  validatePlan,
  type LayoutPlan,
  type PhotoShape,
} from '../layout';
import { DEFAULT_CROP, isDefaultCrop, normaliseCrop, type Crop } from './crop';

/** The output canvas. Lengths are in output pixels. */
export interface CanvasSettings {
  /** Output width in pixels. */
  readonly width: number;
  /** Output height in pixels. */
  readonly height: number;
  /**
   * Outer margin and gap between tiles, in output pixels. The renderer
   * scales it with the output and clamps it so no tile vanishes; the
   * settings UI (#6, #7) should clamp it with maxBorderForAspect.
   */
  readonly border: number;
  /** Shown in the border and gaps: a `#rrggbb` colour. */
  readonly background: string;
}

/**
 * Until the canvas settings UI (#6) exists: 1920 × 1080, no border, white.
 */
export const DEFAULT_CANVAS: CanvasSettings = Object.freeze({
  width: 1920,
  height: 1080,
  border: 0,
  background: '#ffffff',
});

/** The dial's starting position: halfway between uniform and varied. */
export const DEFAULT_VARIATION = 0.5;

/** One snapshot of the editor. Plain data: see the module comment. */
export interface EditorState {
  readonly canvas: CanvasSettings;
  /** The size-variation dial, 0 (uniform) to 1 (varied). */
  readonly variation: number;
  /** The seed for the plan and the assignment. Shuffle replaces it. */
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
   * Crops by photo id. Photos without an entry use DEFAULT_CROP. Entries
   * are kept for excluded photos so a crop survives excluding and including
   * again.
   */
  readonly crops: Readonly<Record<string, Crop>>;
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
  return {
    canvas,
    variation,
    seed,
    photos,
    ...arrange(canvas, photos, variation, seed),
    crops: {},
  };
}

/** Re-rolls with a new seed (the Shuffle button). */
export function shuffle(state: EditorState, seed: number): EditorState {
  checkSeed(seed);
  return reroll(state, { seed });
}

export interface SetVariationOptions {
  /**
   * Replace the plan but keep the current assignment, deferring the costly
   * re-assignment (cubic in the photo count) while the dial is dragged.
   * The result is provisional: commit with a plain setVariation when the
   * drag ends. Every photo still has exactly one tile (the slots keep their
   * numbers), but photos may sit in tiles of the wrong shape.
   */
  readonly keepAssignment?: boolean;
}

/**
 * Moves the size-variation dial (re-rolls).
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
  if (options.keepAssignment) {
    if (v === state.variation) return state;
    const plan = planFor(state.canvas, state.photos.length, v, state.seed);
    return { ...state, variation: v, plan };
  }
  return reroll(state, { variation: v });
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
  let crops = state.crops;
  if (Object.keys(crops).some((id) => doomed.has(id))) {
    crops = Object.fromEntries(
      Object.entries(crops).filter(([id]) => !doomed.has(id)),
    );
  }
  const photos = state.photos.filter((photo) => !doomed.has(photo.id));
  const next = crops === state.crops ? state : { ...state, crops };
  return setPhotos(next, photos);
}

/**
 * Sets the canvas size in output pixels. Re-rolls only if the ratio changes;
 * at the same ratio (for example 1920 × 1080 to 3840 × 2160) the plan and
 * assignment are kept.
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
  if (sameRatio(canvas, state.canvas)) return { ...state, canvas };
  return reroll(state, { canvas });
}

/** Sets the border in output pixels. Never re-rolls. */
export function setBorder(state: EditorState, border: number): EditorState {
  const canvas = checkCanvas({ ...state.canvas, border });
  if (canvas.border === state.canvas.border) return state;
  return { ...state, canvas };
}

/** Sets the background colour (`#rrggbb`). Never re-rolls. */
export function setBackground(
  state: EditorState,
  background: string,
): EditorState {
  const canvas = checkCanvas({
    ...state.canvas,
    background: background.toLowerCase(),
  });
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
  const current = state.crops[photoId];
  if (current ? sameCrop(current, next) : isDefaultCrop(next)) return state;
  const crops = { ...state.crops };
  if (isDefaultCrop(next)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete crops[photoId];
  } else {
    crops[photoId] = next;
  }
  return { ...state, crops };
}

/** A photo's crop, or the default if it has none. */
export function cropOf(state: EditorState, photoId: string): Crop {
  return state.crops[photoId] ?? DEFAULT_CROP;
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

/**
 * Checks a value loaded from JSON (a saved project, #12) and returns it as
 * a clean EditorState. Throws a RangeError if it is not a consistent state:
 * the plan must match the canvas ratio, photo count, variation and seed, and
 * the assignment must place every photo exactly once.
 */
export function validateEditorState(value: unknown): EditorState {
  if (!isRecord(value)) throw new RangeError('state must be an object');
  const { canvas, variation, seed, photos, plan, assignment, crops } = value;
  if (!isRecord(canvas)) throw new RangeError('canvas must be an object');
  const checkedCanvas = checkCanvas({
    width: canvas.width as number,
    height: canvas.height as number,
    border: canvas.border as number,
    background: canvas.background as string,
  });
  if (typeof variation !== 'number' || !(variation >= 0 && variation <= 1)) {
    throw new RangeError('variation must be a number from 0 to 1');
  }
  const checkedSeed = checkSeed(seed as number);
  if (!Array.isArray(photos)) throw new RangeError('photos must be an array');
  const checkedPhotos: PhotoShape[] = photos.map((photo: unknown) => {
    if (!isRecord(photo) || typeof photo.id !== 'string') {
      throw new RangeError('each photo needs a string id');
    }
    return { id: photo.id, aspect: photo.aspect as number };
  });
  const checkedPlan = validatePlan(plan);
  if (checkedPlan.count !== checkedPhotos.length) {
    throw new RangeError('plan and photos differ in count');
  }
  if (
    !sameAspect(checkedPlan.aspect, checkedCanvas.width / checkedCanvas.height)
  ) {
    throw new RangeError('plan was made for another canvas ratio');
  }
  if (checkedPlan.variation !== variation || checkedPlan.seed !== seed) {
    throw new RangeError('plan does not match the variation and seed');
  }
  if (!Array.isArray(assignment)) {
    throw new RangeError('assignment must be an array');
  }
  // Also checks every photo's aspect and that ids are unique.
  validateAssignment(assignment, checkedPhotos);
  if (!isRecord(crops)) throw new RangeError('crops must be an object');
  const checkedCrops: Record<string, Crop> = {};
  for (const [id, crop] of Object.entries(crops)) {
    if (!isRecord(crop)) throw new RangeError(`crop for ${id} is invalid`);
    const normal = normaliseCrop(crop);
    if (!sameCrop(normal, crop as unknown as Crop)) {
      throw new RangeError(`crop for ${id} is out of range`);
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
  return {
    ...next,
    ...arrange(next.canvas, next.photos, next.variation, next.seed),
  };
}

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

function checkCanvas(canvas: CanvasSettings): CanvasSettings {
  const { width, height, border, background } = canvas;
  if (!isPositive(width) || !isPositive(height)) {
    throw new RangeError('canvas width and height must be positive numbers');
  }
  if (!(border >= 0) || !Number.isFinite(border)) {
    throw new RangeError('border must be a non-negative number');
  }
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/.test(background)) {
    throw new RangeError('background must be a #rrggbb colour');
  }
  return { width, height, border, background };
}

function checkSeed(seed: number): number {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new RangeError('seed must be a finite number');
  }
  return seed;
}

function clampVariation(variation: number): number {
  if (Number.isNaN(variation))
    throw new RangeError('variation must be a number');
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

function sameRatio(a: CanvasSettings, b: CanvasSettings): boolean {
  return sameAspect(a.width / a.height, b.width / b.height);
}

function sameAspect(a: number, b: number): boolean {
  return Math.abs(a / b - 1) < 1e-9;
}

function sameCrop(a: Crop, b: Crop): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function isPositive(value: number): boolean {
  return typeof value === 'number' && value > 0 && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
