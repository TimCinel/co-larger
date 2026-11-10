/**
 * Orientation-aware photo placement: decides which photo goes in which slot
 * so that as little of each photo as possible is cropped away.
 *
 * Photos fill their tile "cover" style, so a photo whose aspect ratio differs
 * from its slot's loses a strip off two sides. The fraction lost depends only
 * on the two aspect ratios (see {@link cropFraction}): putting a 4:3
 * landscape photo in a 3:4 portrait slot loses 44% of it; putting it in a 3:2
 * slot loses 11%.
 *
 * What is minimised: the crop fraction of each photo weighted by its slot's
 * area, as a share of the total slot area ({@link weightedCrop}). A badly
 * cropped photo in a large feature tile is far more visible than one in a
 * thumbnail, so the large slots get the best-fitting photos first.
 *
 * Variety: Shuffle must change which photos are featured, so this is not a
 * single global optimum. Each pairing's cost gets a small seeded random
 * surcharge of up to {@link PLACEMENT_NOISE} (as a crop fraction, also
 * weighted by slot area), and the assignment that minimises the perturbed
 * total is found exactly (Hungarian algorithm). That gives two guarantees:
 *
 * - The weighted crop is never more than PLACEMENT_NOISE above the best
 *   possible for those photos and slots.
 * - Photos that fit a slot about equally well (any two 4:3 photos, say, or a
 *   4:3 and a 1.4 one) are in effect drawn at random for it, so different
 *   seeds feature different photos in the largest slots.
 *
 * The surcharge is attached to the photo's id and the slot number, not to
 * the photos' order, so reordering the photo list does not change the
 * result.
 *
 * The result is plain data: `assignment[slot]` is the id of the photo in
 * that slot. Swapping two photos is swapping two entries ({@link swapSlots}),
 * and it serialises as a JSON array of strings. As with plans, store the
 * assignment itself rather than re-deriving it from the seed: the choice
 * depends on floating-point results that could differ in the last bit
 * between JavaScript engines.
 *
 * Pass slots from `placeLayout(plan, { width, height })` with no border, so
 * that changing the border never changes which photo goes where. The cost is
 * O(n³) in the worst case; 200 photos take a few milliseconds.
 */
import { hashUnit, mix32, toSeed } from './random';

/** A photo to place: only its shape matters here. */
export interface PhotoShape {
  /** Unique id. It is what the assignment stores. */
  readonly id: string;
  /** Width divided by height, after any EXIF rotation. */
  readonly aspect: number;
}

/** A slot's size. Any unit; only the ratio and relative areas matter. */
export interface SlotShape {
  readonly width: number;
  readonly height: number;
}

/**
 * `assignment[slot]` is the id of the photo shown in that slot. Every photo
 * appears exactly once.
 */
export type Assignment = string[];

/** Options for {@link assignPhotos}. */
export interface AssignOptions {
  /** Any finite number. The same seed and inputs give the same assignment. */
  readonly seed: number;
  /**
   * The largest seeded surcharge per pairing, as a crop fraction. Defaults
   * to {@link PLACEMENT_NOISE}; 0 gives the exact optimum (with ties broken
   * by photo order). Mainly for tests and tuning.
   */
  readonly noise?: number;
}

/**
 * The largest seeded surcharge added to any pairing, as a crop fraction. The
 * result's weighted crop is at most this much above the optimum; in
 * practice it is far closer (measured on 40-photo layouts: 0.1 percentage
 * points above the optimum on average for a typical camera mix, 0.5 for
 * photos with all-different aspects, 1.9 at worst).
 *
 * Large enough that photos within a few percent of each other in aspect
 * take turns in the large slots, even when no two aspects are equal; small
 * enough that an exact fit still usually beats a 4:3 photo in a 3:2 slot
 * (11% cropped), and well short of what a wrong-orientation photo costs
 * (25% or more).
 */
export const PLACEMENT_NOISE = 0.08;

/**
 * The fraction of a photo's area cropped away when it fills a slot "cover"
 * style: 0 when the aspects match, approaching 1 as they diverge.
 */
export function cropFraction(photoAspect: number, slotAspect: number): number {
  const r = photoAspect / slotAspect;
  return 1 - (r < 1 ? r : 1 / r);
}

/**
 * The area-weighted mean crop fraction of an assignment: each photo's crop
 * fraction weighted by its slot's share of the total slot area. 0 is a
 * perfect fit everywhere.
 */
export function weightedCrop(
  slots: readonly SlotShape[],
  photos: readonly PhotoShape[],
  assignment: readonly string[],
): number {
  const byId = indexPhotos(photos);
  if (assignment.length !== slots.length) {
    throw new RangeError('assignment and slots differ in length');
  }
  let total = 0;
  let cropped = 0;
  for (const [slot, s] of slots.entries()) {
    const id = assignment[slot] as string;
    const photo = byId.get(id);
    if (!photo) throw new RangeError(`unknown photo id ${JSON.stringify(id)}`);
    const area = s.width * s.height;
    total += area;
    cropped += area * cropFraction(photo.aspect, s.width / s.height);
  }
  return total > 0 ? cropped / total : 0;
}

/** Returns a copy of `assignment` with the photos in slots `a` and `b` swapped. */
export function swapSlots(
  assignment: readonly string[],
  a: number,
  b: number,
): Assignment {
  for (const slot of [a, b]) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= assignment.length) {
      throw new RangeError(`slot ${String(slot)} is out of range`);
    }
  }
  const out = [...assignment];
  out[a] = assignment[b] as string;
  out[b] = assignment[a] as string;
  return out;
}

/**
 * Assigns each photo to one slot, minimising area-weighted cropping with
 * seeded variety (see the module comment). `slots[i]` is slot `i`, so the
 * tiles from placeLayout can be passed directly.
 *
 * Throws a RangeError if the number of photos differs from the number of
 * slots, if photo ids repeat, or if any aspect or slot size is not a
 * positive finite number.
 */
export function assignPhotos(
  slots: readonly SlotShape[],
  photos: readonly PhotoShape[],
  options: AssignOptions,
): Assignment {
  const n = slots.length;
  if (photos.length !== n) {
    throw new RangeError(
      `need exactly one photo per slot: ${String(photos.length)} photos for ${String(n)} slots`,
    );
  }
  const seed = toSeed(options.seed);
  const noiseScale = options.noise ?? PLACEMENT_NOISE;
  if (!(noiseScale >= 0) || !Number.isFinite(noiseScale)) {
    throw new RangeError('noise must be a non-negative finite number');
  }
  indexPhotos(photos);

  const areas = new Float64Array(n);
  const slotAspects = new Float64Array(n);
  let totalArea = 0;
  for (const [i, s] of slots.entries()) {
    if (!isPositive(s.width) || !isPositive(s.height)) {
      throw new RangeError(
        `slot ${String(i)} must have a positive finite width and height`,
      );
    }
    areas[i] = s.width * s.height;
    slotAspects[i] = s.width / s.height;
    totalArea += areas[i];
  }

  // cost[p * n + s]: photo p in slot s, as a share of the total area, so the
  // numbers stay near 1 whatever the units.
  const cost = new Float64Array(n * n);
  for (const [p, photo] of photos.entries()) {
    const key = hashString(photo.id);
    for (let s = 0; s < n; s++) {
      const noise = noiseScale * hashUnit(seed, key, s);
      cost[p * n + s] =
        ((areas[s] as number) / totalArea) *
        (cropFraction(photo.aspect, slotAspects[s] as number) + noise);
    }
  }

  const slotOfPhoto = solveAssignment(cost, n);
  const assignment: Assignment = new Array<string>(n);
  for (const [p, photo] of photos.entries()) {
    assignment[slotOfPhoto[p] as number] = photo.id;
  }
  return assignment;
}

function isPositive(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}

function indexPhotos(photos: readonly PhotoShape[]): Map<string, PhotoShape> {
  const byId = new Map<string, PhotoShape>();
  for (const photo of photos) {
    if (!isPositive(photo.aspect)) {
      throw new RangeError(
        `photo ${JSON.stringify(photo.id)} must have a positive finite aspect`,
      );
    }
    if (byId.has(photo.id)) {
      throw new RangeError(`duplicate photo id ${JSON.stringify(photo.id)}`);
    }
    byId.set(photo.id, photo);
  }
  return byId;
}

/** A 32-bit hash of a string (FNV-1a over UTF-16 code units, then mixed). */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return mix32(h);
}

/**
 * Solves the square assignment problem exactly: returns, for each row, the
 * column that minimises the total of `cost[row * n + column]`. The Hungarian
 * algorithm with potentials (Kuhn–Munkres, Jonker–Volgenant style), O(n³).
 */
function solveAssignment(cost: Float64Array, n: number): Int32Array {
  // 1-based internally; index 0 is a sentinel column/row.
  const u = new Float64Array(n + 1); // row potentials
  const v = new Float64Array(n + 1); // column potentials
  const rowOfColumn = new Int32Array(n + 1); // 0 = unmatched
  const way = new Int32Array(n + 1);
  const minv = new Float64Array(n + 1);
  const used = new Uint8Array(n + 1);

  for (let row = 1; row <= n; row++) {
    rowOfColumn[0] = row;
    let column0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[column0] = 1;
      const row0 = rowOfColumn[column0] as number;
      const base = (row0 - 1) * n - 1;
      const u0 = u[row0] as number;
      let delta = Infinity;
      let column1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const reduced = (cost[base + j] as number) - u0 - (v[j] as number);
        if (reduced < (minv[j] as number)) {
          minv[j] = reduced;
          way[j] = column0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          column1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          const r = rowOfColumn[j] as number;
          u[r] = (u[r] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      column0 = column1;
    } while (rowOfColumn[column0] !== 0);
    do {
      const column1 = way[column0] as number;
      rowOfColumn[column0] = rowOfColumn[column1] as number;
      column0 = column1;
    } while (column0 !== 0);
  }

  const columnOfRow = new Int32Array(n);
  for (let j = 1; j <= n; j++) {
    columnOfRow[(rowOfColumn[j] as number) - 1] = j - 1;
  }
  return columnOfRow;
}
