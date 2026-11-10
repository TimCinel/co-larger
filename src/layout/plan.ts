import {
  createRandom,
  hashUnit,
  mix32,
  shuffledIndices,
  toSeed,
} from './random';
import type { Axis, LayoutNode, LayoutPlan, PlanOptions } from './types';

/**
 * The most stretched a tile can be in a plan: long side over short side.
 * Every leaf respects it exactly when placed with no border, unless the
 * canvas is so long and thin for the tile count that even equal tiles in a
 * row would exceed it (see planAspectLimit). Borders take the same width off
 * both sides of a tile, so they stretch tiles a little more; this limit
 * leaves room for that below 3:1, and maxBorderForAspect reports how much.
 */
export const MAX_PLAN_ASPECT = 2.5;

/**
 * The exponent of the area distribution at variation 1. A slot's target area
 * weight is `jitter * q ** -(TAIL * variation)`, where q is its fixed
 * quantile in (0, 1).
 */
const TAIL = 0.9;

/**
 * Each slot's target area is also scaled by a fixed seeded factor between
 * e^-JITTER and e^JITTER (about ±12%). Without it, at variation 0 every
 * target is equal and the best arrangement is often the same grid whatever
 * the seed, so Shuffle would change nothing visible.
 */
const JITTER = 0.12;

/** Above this aspect a single tile starts to look stretched. */
const COMFORT_ASPECT = 2;

/** How much the planner minds giving a tile more or less than its target area. */
const AREA_WEIGHT = 6;
/** How much it minds stretched tiles (and small groups, which it solves). */
const LEAF_SHAPE_WEIGHT = 1;
/** How much it minds larger groups that look hard to divide nicely. */
const GROUP_SHAPE_WEIGHT = 0.5;
/** Groups up to this many tiles are costed by solving them, not estimating. */
const LOOKAHEAD = 3;
/**
 * The dial is divided into this many steps for choosing the tree's
 * structure. See planLayout.
 */
const STRUCTURE_STEPS = 10;

/** Seeded noise added to each candidate cut, for variety between seeds. */
const NOISE = 0.35;

/**
 * The aspect limit a plan for this canvas keeps every tile within (with no
 * border): MAX_PLAN_ASPECT, unless the canvas is so long and thin for the
 * number of tiles that even a row of equal tiles would be more stretched.
 * Then it is the canvas's own aspect divided by the count, the best possible.
 */
export function planAspectLimit(
  width: number,
  height: number,
  count: number,
): number {
  const aspect = width >= height ? width / height : height / width;
  return Math.max(MAX_PLAN_ASPECT, aspect / Math.max(1, count));
}

/**
 * The dial value at which planLayout chooses the tree's structure for
 * `variation`: the nearest tenth (after clamping to 0..1). Two variations
 * with the same step, and otherwise the same inputs, give plans with the same
 * structure and the same slot numbers; only the cut positions differ. So an
 * editor can keep which photo is in which slot while the dial moves within a
 * step, and must re-assign photos when the step changes.
 */
export function arrangementStep(variation: number): number {
  const v = Math.min(1, Math.max(0, variation));
  return Math.round(v * STRUCTURE_STEPS) / STRUCTURE_STEPS;
}

/**
 * Builds a mosaic plan: a guillotine tree with one leaf per slot. The plan
 * depends on the canvas's aspect ratio, the count, the variation and the
 * seed; never on the canvas's absolute size or the border.
 */
export function planLayout(options: PlanOptions): LayoutPlan {
  const { width, height, count, seed } = options;
  if (!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) {
    throw new RangeError('width and height must be positive finite numbers');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(
      `count must be a non-negative integer, got ${String(count)}`,
    );
  }
  if (Number.isNaN(options.variation)) {
    throw new RangeError('variation must be a number');
  }
  const variation = Math.min(1, Math.max(0, options.variation));
  const aspect = width / height;
  const seed32 = toSeed(seed);

  if (count === 0) {
    return { aspect, count, variation, seed, root: null };
  }

  const random = createRandom(seed32);
  const quantiles = targetQuantiles(count, random);
  const jitter = quantiles.map(() => Math.exp(JITTER * (2 * random() - 1)));
  const weightsAt = (v: number) =>
    quantiles.map(
      (q, slot) => (jitter[slot] as number) * Math.pow(q, -TAIL * v),
    );
  // The seeded order in which slots are laid out, which decides which slots
  // tend to end up as neighbours.
  const order = shuffledIndices(count, random);

  // Choose the tree's structure (which tiles go together, and which way each
  // cut runs) at the nearest step of the dial, then fit the cut positions to
  // the exact variation. Between steps the tiles grow and shrink smoothly;
  // only crossing a step boundary rearranges them.
  const step = arrangementStep(variation);
  const limit = planAspectLimit(width, height, count);
  const structure = new Planner(
    weightsAt(step),
    quantiles,
    order,
    seed32,
    limit,
  ).build(order, aspect, 1);
  const fitter = new Planner(
    weightsAt(variation),
    quantiles,
    order,
    seed32,
    limit,
  );
  const root = fitter.refit(structure, aspect, 1);
  return { aspect, count, variation, seed, root };
}

/**
 * A fixed seeded quantile q in (0, 1) for each slot, stratified so that the
 * spread of sizes is similar for every seed. The quantiles do not depend on
 * the variation, so turning the dial changes each slot's target area
 * smoothly and never changes which slots are bigger than which.
 */
function targetQuantiles(count: number, random: () => number): number[] {
  const ranks = shuffledIndices(count, random);
  return ranks.map((rank) => (rank + 0.5 + (random() - 0.5) * 0.5) / count);
}

interface Candidate {
  axis: Axis;
  /** Identifies the group of tiles being cut, for seeded choices. */
  nodeHash: number;
  /** The tiles going to the first child; the rest go to the second. */
  first: readonly number[];
  fraction: number;
  cost: number;
}

class Planner {
  /** Each slot's position in the seeded order. */
  private readonly position: Int32Array;
  /** A per-slot hash, summed to identify a group of slots for seeded noise. */
  private readonly slotHash: Int32Array;

  constructor(
    private readonly weights: readonly number[],
    private readonly quantiles: readonly number[],
    order: readonly number[],
    private readonly seed: number,
    private readonly limit: number,
  ) {
    this.position = new Int32Array(order.length);
    for (const [i, slot] of order.entries()) this.position[slot] = i;
    this.slotHash = Int32Array.from(order, (_, slot) =>
      mix32(seed ^ mix32(slot + 1)),
    );
  }

  /** Lays out `items` (slots in seeded order) in a `w` × `h` rectangle. */
  build(items: readonly number[], w: number, h: number): LayoutNode {
    if (items.length === 1) {
      return { kind: 'leaf', slot: items[0] as number };
    }
    const best = this.bestCut(items, w, h);
    const { axis } = best;
    let [a, b] = this.divide(items, best.first);
    let fraction = best.fraction;
    // Mirror half of the cuts, chosen by seed. Costs are the same either way,
    // but without this the largest-first candidates always put big tiles in
    // the first (left or top) child.
    if (hashUnit(this.seed, best.nodeHash, 0x5eed) < 0.5) {
      [a, b] = [b, a];
      fraction = 1 - fraction;
    }
    const [w1, h1, w2, h2] = childSizes(axis, w, h, fraction);
    return {
      kind: 'split',
      axis,
      fraction,
      first: this.build(a, w1, h1),
      second: this.build(b, w2, h2),
    };
  }

  /**
   * Keeps `node`'s structure but re-chooses every cut's fraction for this
   * planner's weights, using the same costs and limits as `build`. Refitting
   * a tree with the weights it was built with returns the same fractions.
   */
  refit(node: LayoutNode, w: number, h: number): LayoutNode {
    if (node.kind === 'leaf') return node;
    const a = leafSlots(node.first);
    const b = leafSlots(node.second);
    let head = 0;
    let headMax = 0;
    for (const slot of a) {
      const weight = this.weights[slot] as number;
      head += weight;
      headMax = Math.max(headMax, weight);
    }
    let tail = 0;
    let tailMax = 0;
    for (const slot of b) {
      const weight = this.weights[slot] as number;
      tail += weight;
      tailMax = Math.max(tailMax, weight);
    }
    const { axis } = node;
    const along = axis === 'x' ? w : h;
    const across = axis === 'x' ? h : w;
    const ratio = across / along;
    const limits = hardLimits(this.limit, ratio, a.length, b.length);
    if (!limits) {
      // The parent's cut moved enough that this cut's direction no longer
      // works (it now runs along the short side). Plan this part afresh.
      const items = [...a, ...b].sort(
        (p, q) => (this.position[p] as number) - (this.position[q] as number),
      );
      return this.build(items, w, h);
    }
    const [lo, hi] = limits;
    const target = head / (head + tail);
    let best = node.fraction;
    let bestCost = Infinity;
    for (const fraction of fractionCandidates(
      target,
      lo,
      hi,
      ratio,
      a.length,
      b.length,
    )) {
      const [w1, h1, w2, h2] = childSizes(axis, w, h, fraction);
      const cost =
        AREA_WEIGHT * areaCost(fraction, target) +
        this.groupCost(a.length, () => a, w1, h1, headMax / head) +
        this.groupCost(b.length, () => b, w2, h2, tailMax / tail);
      if (cost < bestCost) {
        bestCost = cost;
        best = fraction;
      }
    }
    const [w1, h1, w2, h2] = childSizes(axis, w, h, best);
    return {
      kind: 'split',
      axis,
      fraction: best,
      first: this.refit(node.first, w1, h1),
      second: this.refit(node.second, w2, h2),
    };
  }

  /** Splits `items` into the members of `first` and the rest, keeping seeded order. */
  private divide(
    items: readonly number[],
    first: readonly number[],
  ): [number[], number[]] {
    const chosen = new Set(first);
    const a: number[] = [];
    const b: number[] = [];
    for (const slot of items) (chosen.has(slot) ? a : b).push(slot);
    return [a, b];
  }

  /**
   * How awkward it will be to lay out a group in a `w` × `h` rectangle.
   * `items` is only needed (and only passed) for groups of up to LOOKAHEAD
   * tiles; `bigShare` is the largest tile's share of the group's weight.
   */
  private groupCost(
    count: number,
    items: (() => readonly number[]) | null,
    w: number,
    h: number,
    bigShare: number,
  ): number {
    const aspect = w >= h ? w / h : h / w;
    if (count === 1) {
      return LEAF_SHAPE_WEIGHT * stretchPenalty(aspect);
    }
    if (count <= LOOKAHEAD && items) {
      // Small groups are where the awkward cases hide (two tiles of very
      // different sizes in a square, say), and they are cheap to solve, so
      // look ahead and use the most stretched tile they would actually get.
      const sorted = [...items()].sort(
        (p, q) => (this.position[p] as number) - (this.position[q] as number),
      );
      return LEAF_SHAPE_WEIGHT * stretchPenalty(this.worstAspect(sorted, w, h));
    }
    // Larger groups get an estimate. Two things force stretched tiles: too
    // few tiles to fill a long thin rectangle, or a tile too big to fit as a
    // square across the short side. In units where the short side is 1 the
    // group's area is `aspect`, so its biggest tile's area is bigShare * aspect.
    const big = Math.max(1, bigShare * aspect);
    return (
      GROUP_SHAPE_WEIGHT *
      stretchPenalty(Math.max(gridAspect(aspect, count), big))
    );
  }

  /** The most stretched tile the planner would make for this group. */
  private worstAspect(items: readonly number[], w: number, h: number): number {
    if (items.length === 1) return w >= h ? w / h : h / w;
    if (items.length === 2)
      return this.pairWorstAspect(items[0] as number, items[1] as number, w, h);
    const { axis, first, fraction } = this.bestCut(items, w, h);
    const [a, b] = this.divide(items, first);
    return axis === 'x'
      ? Math.max(
          this.worstAspect(a, w * fraction, h),
          this.worstAspect(b, w * (1 - fraction), h),
        )
      : Math.max(
          this.worstAspect(a, w, h * fraction),
          this.worstAspect(b, w, h * (1 - fraction)),
        );
  }

  /**
   * `worstAspect` for two tiles, `first` before `second` in seeded order.
   * Makes the same choice `bestCut` would, without allocating; this is the
   * innermost loop of the lookahead.
   */
  private pairWorstAspect(
    first: number,
    second: number,
    w: number,
    h: number,
  ): number {
    const nodeHash =
      ((this.slotHash[first] as number) + (this.slotHash[second] as number)) |
      0;
    const head = this.weights[first] as number;
    const target = head / (head + (this.weights[second] as number));
    let bestCost = Infinity;
    let worst = Infinity;
    for (const axis of ['x', 'y'] as const) {
      const ratio = axis === 'x' ? h / w : w / h;
      const limits = hardLimits(this.limit, ratio, 1, 1);
      if (!limits) continue;
      const [lo, hi] = limits;
      const noise =
        NOISE * hashUnit(this.seed, nodeHash, 0, 1, axis === 'x' ? 0 : 1);
      for (const fraction of fractionCandidates(target, lo, hi, ratio, 1, 1)) {
        // Each child's length along the cut over its length across it.
        const a1 = fraction / ratio;
        const a2 = (1 - fraction) / ratio;
        const aspect1 = a1 >= 1 ? a1 : 1 / a1;
        const aspect2 = a2 >= 1 ? a2 : 1 / a2;
        const cost =
          AREA_WEIGHT * areaCost(fraction, target) +
          LEAF_SHAPE_WEIGHT *
            (stretchPenalty(aspect1) + stretchPenalty(aspect2)) +
          noise;
        if (cost < bestCost) {
          bestCost = cost;
          worst = Math.max(aspect1, aspect2);
        }
      }
    }
    return worst;
  }

  /**
   * Finds the cheapest cut of `items` in a `w` × `h` rectangle. Candidates
   * divide the tiles at every point of two sequences: the seeded order, which
   * gives variety, and largest first, which can always separate big tiles
   * from small ones. Each is tried along both axes, with a few fractions.
   */
  private bestCut(items: readonly number[], w: number, h: number): Candidate {
    const count = items.length;
    let nodeHash = 0;
    for (const slot of items)
      nodeHash = (nodeHash + (this.slotHash[slot] as number)) | 0;
    const sequences: (readonly number[])[] = [items];
    if (count > 2) {
      // With two tiles, largest-first gives the same division as the seeded order.
      sequences.push(
        [...items].sort(
          (p, q) =>
            (this.quantiles[p] as number) - (this.quantiles[q] as number),
        ),
      );
    }

    const prefix = new Float64Array(count + 1);
    const headMax = new Float64Array(count + 1);
    const tailMax = new Float64Array(count + 1);
    let best: {
      cost: number;
      axis: Axis;
      sequence: number;
      k: number;
      fraction: number;
    } | null = null;
    for (const [sequenceIndex, sequence] of sequences.entries()) {
      // prefix[k]: total weight of the first k tiles. headMax[k]: the largest
      // weight among them. tailMax[k]: the largest weight among the rest.
      for (let i = 0; i < count; i++) {
        const weight = this.weights[sequence[i] as number] as number;
        prefix[i + 1] = (prefix[i] as number) + weight;
        headMax[i + 1] = Math.max(headMax[i] as number, weight);
      }
      tailMax[count] = 0;
      for (let i = count - 1; i >= 0; i--) {
        const weight = this.weights[sequence[i] as number] as number;
        tailMax[i] = Math.max(tailMax[i + 1] as number, weight);
      }
      const total = prefix[count] as number;

      for (const axis of ['x', 'y'] as const) {
        // Length being cut, and the length of the other side.
        const along = axis === 'x' ? w : h;
        const across = axis === 'x' ? h : w;
        const ratio = across / along;
        for (let k = 1; k < count; k++) {
          const n1 = k;
          const n2 = count - k;
          const limits = hardLimits(this.limit, ratio, n1, n2);
          if (!limits) continue;
          const [lo, hi] = limits;

          const head = prefix[k] as number;
          const target = head / total;
          const headBig = (headMax[k] as number) / head;
          const tailBig = (tailMax[k] as number) / (total - head);
          const headItems = () => sequence.slice(0, k);
          const tailItems = () => sequence.slice(k);
          const noise =
            NOISE *
            hashUnit(
              this.seed,
              nodeHash,
              sequenceIndex,
              k,
              axis === 'x' ? 0 : 1,
            );
          for (const fraction of fractionCandidates(
            target,
            lo,
            hi,
            ratio,
            n1,
            n2,
          )) {
            const [w1, h1, w2, h2] = childSizes(axis, w, h, fraction);
            const cost =
              AREA_WEIGHT * areaCost(fraction, target) +
              this.groupCost(n1, headItems, w1, h1, headBig) +
              this.groupCost(n2, tailItems, w2, h2, tailBig) +
              noise;
            if (best === null || cost < best.cost) {
              best = { cost, axis, sequence: sequenceIndex, k, fraction };
            }
          }
        }
      }
    }
    if (best === null) {
      // Unreachable: the cut across the long side is always feasible (see
      // hardLimits), so this would be a bug in the planner.
      throw new Error('layout planner found no valid cut');
    }
    const sequence = sequences[best.sequence] as readonly number[];
    return {
      axis: best.axis,
      nodeHash,
      first: sequence.slice(0, best.k),
      fraction: best.fraction,
      cost: best.cost,
    };
  }
}

/**
 * The range of fractions a cut may use. A child holding n tiles may have an
 * aspect of at most `limit * n`, which keeps every leaf within `limit`.
 * Because `limit >= 2`, a cut across the long side of any rectangle within
 * its own limit always has a valid fraction, whatever the tile counts on each
 * side; and the root is within its limit by the choice of `limit` (see
 * planAspectLimit). So the planner can never get stuck. Returns null when no
 * fraction works. `ratio` is the length across the cut over the
 * length along it.
 */
function hardLimits(
  limit: number,
  ratio: number,
  n1: number,
  n2: number,
): [number, number] | null {
  const lo = Math.max(ratio / (limit * n1), 1 - limit * n2 * ratio);
  const hi = Math.min(limit * n1 * ratio, 1 - ratio / (limit * n2));
  // The limits can be met exactly at the edge, so allow for rounding.
  if (!(lo <= hi + 1e-9)) return null;
  return lo > hi ? [(lo + hi) / 2, (lo + hi) / 2] : [lo, hi];
}

function childSizes(
  axis: Axis,
  w: number,
  h: number,
  fraction: number,
): [number, number, number, number] {
  return axis === 'x'
    ? [w * fraction, h, w * (1 - fraction), h]
    : [w, h * fraction, w, h * (1 - fraction)];
}

function leafSlots(node: LayoutNode, out: number[] = []): number[] {
  if (node.kind === 'leaf') out.push(node.slot);
  else {
    leafSlots(node.first, out);
    leafSlots(node.second, out);
  }
  return out;
}

/**
 * The fractions worth trying for one cut: the exact target, plus, when a
 * child is a single tile, the nearest fraction that keeps that tile within
 * COMFORT_ASPECT and a compromise halfway between. All are clamped to the
 * hard limits [lo, hi]. `ratio` is the length across the cut over the length
 * along it.
 */
function fractionCandidates(
  target: number,
  lo: number,
  hi: number,
  ratio: number,
  n1: number,
  n2: number,
): number[] {
  const clamp = (f: number) => Math.min(hi, Math.max(lo, f));
  const exact = clamp(target);
  let comfortLo = 0;
  let comfortHi = 1;
  if (n1 === 1) {
    comfortLo = Math.max(comfortLo, ratio / COMFORT_ASPECT);
    comfortHi = Math.min(comfortHi, COMFORT_ASPECT * ratio);
  }
  if (n2 === 1) {
    comfortLo = Math.max(comfortLo, 1 - COMFORT_ASPECT * ratio);
    comfortHi = Math.min(comfortHi, 1 - ratio / COMFORT_ASPECT);
  }
  if (comfortLo > comfortHi) return [exact];
  const comfort = clamp(Math.min(comfortHi, Math.max(comfortLo, target)));
  if (comfort === exact) return [exact];
  return [exact, comfort, clamp((exact + comfort) / 2)];
}

/** Squared log error between the area a child gets and the area it wanted. */
function areaCost(fraction: number, target: number): number {
  const a = Math.log(fraction / target);
  const b = Math.log((1 - fraction) / (1 - target));
  return a * a + b * b;
}

/** Grows gently up to COMFORT_ASPECT, then steeply. */
function stretchPenalty(aspect: number): number {
  const l = Math.log(aspect);
  const over = Math.max(0, Math.log(aspect / COMFORT_ASPECT));
  return l * l + 20 * over * over;
}

/**
 * Estimates the tile aspect if `count` equal tiles were arranged as a grid in
 * a rectangle of the given aspect (long side over short side, at least 1).
 */
function gridAspect(aspect: number, count: number): number {
  const ideal = Math.sqrt(count / aspect);
  let best = Infinity;
  for (const rows of [Math.floor(ideal), Math.ceil(ideal)]) {
    if (rows < 1 || rows > count) continue;
    const a = (aspect * rows * rows) / count;
    best = Math.min(best, a >= 1 ? a : 1 / a);
  }
  return best === Infinity ? aspect / count : best;
}
