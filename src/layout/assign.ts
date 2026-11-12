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
 * What is minimised ({@link placementCost}): each photo's crop fraction
 * squared, weighted by its slot's share of the total slot area.
 *
 * - Area weighting: a badly cropped photo in a large feature tile is far more
 *   visible than one in a thumbnail, so the large slots get the best fits.
 * - Squaring: with the plain crop fraction, the optimum happily sacrifices a
 *   photo that fits nowhere (cropping it by 60% or more) so that another
 *   fits perfectly. Squared, one photo cropped by 60% costs twice as much as
 *   two cropped by 30%, so unavoidable cropping is spread out. Measured on a
 *   typical camera mix this cut photos cropped by more than half from about
 *   1.2% to 0.06% and the worst crop from 73% to 56%, for 0.4 percentage
 *   points more mean crop.
 *
 * {@link weightedCrop} reports the plain area-weighted crop fraction, the
 * human-readable figure ("14% of the collage's photo area is cropped").
 *
 * Variety: Shuffle must change which photos are featured, so this is not a
 * single global optimum. Each pairing's cost gets a small seeded random
 * surcharge of up to {@link PLACEMENT_NOISE} (in the same squared units, also
 * weighted by slot area), and the assignment that minimises the perturbed
 * total is found exactly (Hungarian algorithm). That gives two guarantees:
 *
 * - The placement cost is never more than PLACEMENT_NOISE above the best
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
 * Featured photos (#14): with k featured photos (`AssignOptions.featured`),
 * the problem splits in two. The featured photos are matched to the k
 * largest slots ({@link largestSlots}: by area, ties in slot order) and every
 * other photo to the remaining slots, each half solved exactly with the same
 * costs and the same seeded surcharge. With nothing featured, or every photo
 * featured, the result is exactly the plain assignment.
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
   * The largest seeded surcharge per pairing, in placement-cost units. Defaults
   * to {@link PLACEMENT_NOISE}; 0 gives the exact optimum (with ties broken
   * by photo order). Mainly for tests and tuning.
   */
  readonly noise?: number;
  /**
   * Ids of featured photos (#14). With k of them among `photos`, they take
   * the k largest slots ({@link largestSlots}), matched among those slots by
   * the same cost; the other photos fill the other slots, also by the same
   * cost. Ids not among `photos` (an excluded featured photo) are ignored.
   * Empty, absent, or every photo featured: exactly the plain assignment.
   */
  readonly featured?: Iterable<string>;
  /**
   * The slots the featured photos take, one per featured photo among
   * `photos`. Defaults to `largestSlots(slots, k)`. The editor passes the
   * largest slots of the plan it shows, which can differ slightly in size
   * from the slots it assigns on (see arrange in src/editor/state.ts).
   */
  readonly featuredSlots?: readonly number[];
}

/**
 * The largest seeded surcharge added to any pairing, in placement-cost units
 * (crop fraction squared). The result's placement cost is at most this much
 * above the optimum; in practice it is far closer (measured: 0.005 at worst).
 *
 * Tuned so the largest slots get as much variety as the earlier linear cost
 * gave with 0.08: over 20 seeds on a fixed 40-tile layout, about 9 different
 * photos in the largest slot for a typical camera mix, 7.5 for a phone mix
 * and 6.6 when no two aspects are equal. In squared units an exact fit costs
 * 0, a 4:3 photo in a 3:2 slot (11% cropped) 0.012 and a 25% crop 0.0625,
 * so an exact fit can lose a big slot to a photo cropped by up to 20%, but
 * never to a wrong-orientation one (4:3 in 3:4 is 44% cropped, 0.19).
 * Raising it to 0.08 adds a little variety but gives back part of the tail
 * improvement (worst crop 59% instead of 56%).
 */
export const PLACEMENT_NOISE = 0.04;

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
  return weightedMean(slots, photos, assignment, (crop) => crop);
}

/**
 * What {@link assignPhotos} minimises (before its seeded surcharge): the
 * area-weighted mean of each photo's crop fraction squared. Squaring makes
 * one photo cropped by 60% cost far more than two cropped by 30%, so the
 * optimum spreads unavoidable cropping instead of sacrificing a few photos.
 */
export function placementCost(
  slots: readonly SlotShape[],
  photos: readonly PhotoShape[],
  assignment: readonly string[],
): number {
  return weightedMean(slots, photos, assignment, (crop) => crop * crop);
}

/**
 * Throws a RangeError unless `assignment` puts each of `photos` in exactly
 * one slot: same length, no unknown ids, no repeats. Use it on assignments
 * loaded from saved projects. Also checks the photos as assignPhotos does.
 */
export function validateAssignment(
  assignment: readonly unknown[],
  photos: readonly PhotoShape[],
): asserts assignment is Assignment {
  const byId = indexPhotos(photos);
  if (assignment.length !== photos.length) {
    throw new RangeError(
      `assignment has ${String(assignment.length)} slots for ${String(photos.length)} photos`,
    );
  }
  const seen = new Set<string>();
  for (const id of assignment) {
    if (typeof id !== 'string' || !byId.has(id)) {
      throw new RangeError(`unknown photo id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new RangeError(`photo id ${JSON.stringify(id)} appears twice`);
    }
    seen.add(id);
  }
}

function weightedMean(
  slots: readonly SlotShape[],
  photos: readonly PhotoShape[],
  assignment: readonly string[],
  measure: (crop: number) => number,
): number {
  if (assignment.length !== slots.length) {
    throw new RangeError('assignment and slots differ in length');
  }
  validateAssignment(assignment, photos);
  const aspectOf = new Map(photos.map((p) => [p.id, p.aspect]));
  let total = 0;
  let sum = 0;
  for (const [slot, s] of slots.entries()) {
    const aspect = aspectOf.get(assignment[slot] as string) as number;
    const area = s.width * s.height;
    total += area;
    sum += area * measure(cropFraction(aspect, s.width / s.height));
  }
  return total > 0 ? sum / total : 0;
}

/**
 * The `k` largest slots by area, largest first; equal areas in slot order.
 * Featured photos take these slots (see AssignOptions.featured). Pure and
 * deterministic: the order depends only on the areas and slot numbers.
 */
export function largestSlots(slots: readonly SlotShape[], k: number): number[] {
  return slotsBySize(slots).slice(0, Math.max(0, Math.min(k, slots.length)));
}

/** Every slot number, largest area first; equal areas in slot order. */
export function slotsBySize(slots: readonly SlotShape[]): number[] {
  const areas = slots.map((s) => s.width * s.height);
  return areas
    .map((_, i) => i)
    .sort((a, b) => (areas[b] as number) - (areas[a] as number) || a - b);
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
 * Assigns each photo to one slot, minimising the placement cost with
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
      const crop = cropFraction(photo.aspect, slotAspects[s] as number);
      cost[p * n + s] =
        ((areas[s] as number) / totalArea) * (crop * crop + noise);
    }
  }

  const assignment: Assignment = new Array<string>(n);
  const featured = new Set(options.featured ?? []);
  const rows = photos.map((_, p) => p);
  const isFeatured = (p: number): boolean =>
    featured.has((photos[p] as PhotoShape).id);
  const k = rows.filter(isFeatured).length;
  if (k === 0 || k === n) {
    // Nothing (or everything) featured: the plain assignment, unchanged.
    const slotOfPhoto = solveAssignment(cost, n);
    for (const [p, photo] of photos.entries()) {
      assignment[slotOfPhoto[p] as number] = photo.id;
    }
    return assignment;
  }
  // Featured photos among the k largest slots, the rest among the others:
  // two independent problems with the same costs (and the same noise).
  const large = new Set(options.featuredSlots ?? largestSlots(slots, k));
  if (
    large.size !== k ||
    [...large].some((s) => !Number.isInteger(s) || s < 0 || s >= n)
  ) {
    throw new RangeError(
      `featuredSlots must be ${String(k)} distinct slots, one per featured photo`,
    );
  }
  const columns = rows.filter((s) => large.has(s));
  const others = rows.filter((s) => !large.has(s));
  for (const [subRows, subColumns] of [
    [rows.filter(isFeatured), columns],
    [rows.filter((p) => !isFeatured(p)), others],
  ] as const) {
    const m = subRows.length;
    const sub = new Float64Array(m * m);
    for (const [r, p] of subRows.entries()) {
      for (const [c, s] of subColumns.entries()) {
        sub[r * m + c] = cost[p * n + s] as number;
      }
    }
    const columnOfRow = solveAssignment(sub, m);
    for (const [r, p] of subRows.entries()) {
      const slot = subColumns[columnOfRow[r] as number] as number;
      assignment[slot] = (photos[p] as PhotoShape).id;
    }
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
