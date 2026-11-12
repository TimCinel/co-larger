/**
 * Dividers (#16): every split node of a plan is one divider, the line (the
 * gap, as drawn) that runs the full width or height of the node's region.
 * Moving a divider changes only that node's fraction, so everything on one
 * side grows, everything on the other shrinks, and each side keeps its
 * internal proportions. No slot changes place.
 *
 * Pure functions, no DOM:
 *
 * - listDividers: where each divider is drawn on a concrete canvas.
 * - dividerAt: which divider a point picks (hit-testing).
 * - dividerRange: how far a divider may move (the minimum tile size).
 * - setDividerFraction: moves one divider, clamped to its range.
 * - checkTileSizes: the size rule a stored plan must satisfy.
 *
 * ## The minimum tile size
 *
 * Measured in the plan's own geometry (`aspect` × 1, no border), so it is
 * the same at every pixel size and every border: the border is drawn on top
 * and has its own clamp (maxBorder keeps every drawn tile at least a pixel).
 * MIN_TILE_FRACTION is 4% of the canvas's shorter side. A drag never makes a
 * tile narrower or shorter than that, or than it already is if it is smaller
 * (a plan for hundreds of photos has tiles below 4%): so a divider's range
 * always contains its current position (nothing jumps on first touch), and
 * a drag never makes the smallest tile smaller.
 *
 * There is no aspect limit on tiles of at least the minimum, which the user
 * may stretch as they like. A tile whose other side is already below the
 * minimum may not be stretched beyond the planner's own aspect limit
 * (planAspectLimit), or beyond what it already is: otherwise a sliver could
 * be pulled out of it. Together these keep checkTileSizes true: every tile is
 * either within the planner's aspect limit (as every planned tile is) or at
 * least the minimum both ways. So a saved project can still be checked for
 * tiles squashed to nothing, and every layout the user can make passes.
 */
import { planAspectLimit } from './plan';
import { walkPlaced } from './place';
import type {
  Axis,
  LayoutNode,
  LayoutPlan,
  PlaceOptions,
  SplitNode,
} from './types';
import { validatePlan } from './validate';

/** The smallest tile side a drag allows: 4% of the canvas's shorter side. */
export const MIN_TILE_FRACTION = 0.04;

/** Floating-point slack when checking a stored plan's tiles. */
const SLACK = 1e-6;

/** One divider as drawn on a canvas (see listDividers). */
export interface Divider {
  /**
   * Which split node: one character per level from the root, '0' for
   * `first` and '1' for `second` ('' is the root). Stable while the tree's
   * structure is (it changes only with a re-roll).
   */
  readonly path: string;
  /** 'x': a vertical line, moved left and right; 'y': horizontal. */
  readonly axis: Axis;
  /** Nesting depth: 0 for the root. */
  readonly depth: number;
  /** The node's current fraction. */
  readonly fraction: number;
  /**
   * The gap as drawn: from `cut` to `cut + border` along the axis, and
   * across it the node's whole region (`from` to `to`). With no border the
   * gap is empty and the line is the shared edge at `cut`.
   */
  readonly cut: number;
  readonly border: number;
  readonly from: number;
  readonly to: number;
  /**
   * The node's region along the axis before snapping. A gap centred at
   * position `p` along the axis is fraction
   * `(p - border / 2 - start) / (end - start - border)`: see fractionAt.
   */
  readonly start: number;
  readonly end: number;
}

/**
 * Every divider of `plan` placed exactly as placeLayout places it with the
 * same options (same checks, same snapping), parents before children: the
 * root first, then the first child's dividers, then the second's.
 */
export function listDividers(
  plan: LayoutPlan,
  options: PlaceOptions,
): Divider[] {
  const out: Divider[] = [];
  walkPlaced(
    plan,
    options,
    () => undefined,
    (s) => {
      const x = s.node.axis === 'x';
      out.push({
        path: s.path,
        axis: s.node.axis,
        depth: s.depth,
        fraction: s.node.fraction,
        cut: s.cut,
        border: s.border,
        from: x ? s.y0 : s.x0,
        to: x ? s.y1 : s.x1,
        start: s.start,
        end: s.end,
      });
    },
  );
  return out;
}

/**
 * The fraction that puts the divider's gap centred at `position` along its
 * axis (canvas units), unclamped. Pointer drags map through this.
 */
export function fractionAt(divider: Divider, position: number): number {
  const length = divider.end - divider.start - divider.border;
  if (!(length > 0)) return divider.fraction;
  return (position - divider.border / 2 - divider.start) / length;
}

/**
 * The divider a point picks, or null. Each divider's hit zone is its gap,
 * widened to at least `tolerance` either side of its centre line (so a
 * divider with no border, or a thin one, can still be grabbed), along its
 * full length and no further. Where zones overlap (a T-junction with no
 * border, where a nested divider meets the line it ends at), the point picks
 * the divider whose centre line is nearest; on a tie the shallowest (the line
 * that runs on through the junction, and moves more), then the first in
 * listDividers order. Coordinates are in the canvas units of `dividers`.
 */
export function dividerAt(
  dividers: readonly Divider[],
  x: number,
  y: number,
  tolerance: number,
): Divider | null {
  let best: Divider | null = null;
  let bestDistance = Infinity;
  for (const d of dividers) {
    const along = d.axis === 'x' ? x : y;
    const across = d.axis === 'x' ? y : x;
    if (across < d.from || across > d.to) continue;
    const centre = d.cut + d.border / 2;
    const half = Math.max(d.border / 2, tolerance);
    const distance = Math.abs(along - centre);
    if (distance > half) continue;
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && d.depth < best.depth)
    ) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

/** How far a divider may move: see dividerRange. */
export interface DividerRange {
  /** The node's current fraction (always within min..max). */
  readonly fraction: number;
  readonly min: number;
  readonly max: number;
}

/**
 * The fractions the divider at `path` may take (see the module comment):
 * every tile on either side, at any depth, stays at least MIN_TILE_FRACTION
 * of the canvas's shorter side along the divider's axis, or as large as it
 * is now if it is smaller; and a tile whose other side is below the minimum
 * is not stretched beyond the planner's aspect limit or its current aspect.
 * The range always contains the current fraction and lies strictly inside
 * (0, 1). Throws a RangeError if `path` is not a split node of `plan`.
 */
export function dividerRange(plan: LayoutPlan, path: string): DividerRange {
  const found = findSplit(plan, path);
  const { node } = found;
  const f0 = node.fraction;
  const length = node.axis === 'x' ? found.width : found.height;
  const cross = node.axis === 'x' ? found.height : found.width;
  const m = minTileSide(plan);
  const cap = planAspectLimit(plan.aspect, 1, plan.count);
  let min = 0;
  let max = 1;
  // Every leaf's length along the axis is (its side's length) × p, and its
  // length across is fixed: both found by walking the side's subtree.
  const side = (child: LayoutNode, first: boolean): void => {
    const g0 = first ? f0 : 1 - f0;
    forEachLeafShare(child, node.axis, 1, cross, (p, e) => {
      const unit = length * p;
      // Never below the minimum, or below what it is now if smaller.
      const shrink = Math.min(m / unit, g0);
      // A tile thinner than the minimum the other way: no slivers.
      const grow = e < m ? Math.max((cap * e) / unit, g0) : Infinity;
      if (first) {
        min = Math.max(min, shrink);
        max = Math.min(max, grow);
      } else {
        max = Math.min(max, 1 - shrink);
        min = Math.max(min, 1 - grow);
      }
    });
  };
  side(node.first, true);
  side(node.second, false);
  // Rounding must never push the current position outside its own range.
  return {
    fraction: f0,
    min: Math.min(min, f0),
    max: Math.max(max, f0),
  };
}

/**
 * `plan` with the divider at `path` moved to `fraction`, clamped to
 * dividerRange. Only that node and its ancestors are copied; everything
 * else is shared. Returns `plan` itself if the clamped fraction is the
 * current one. Throws a RangeError for a path that is not a split node or a
 * fraction that is not a finite number.
 */
export function setDividerFraction(
  plan: LayoutPlan,
  path: string,
  fraction: number,
): LayoutPlan {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    throw new RangeError('fraction must be a finite number');
  }
  const range = dividerRange(plan, path);
  const next = Math.min(range.max, Math.max(range.min, fraction));
  if (next === range.fraction) return plan;
  const replace = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.kind !== 'split') throw new RangeError('no divider at that path');
    if (depth === path.length) return { ...node, fraction: next };
    return path[depth] === '0'
      ? { ...node, first: replace(node.first, depth + 1) }
      : { ...node, second: replace(node.second, depth + 1) };
  };
  return { ...plan, root: replace(plan.root as LayoutNode, 0) };
}

/** What checkTileSizes found. */
export type TileSizes =
  /** Every tile is within the planner's aspect limit, as planned. */
  | 'planned'
  /**
   * Some tile is beyond the planner's aspect limit but at least
   * MIN_TILE_FRACTION both ways: only a hand-resized plan is like this.
   */
  | 'resized'
  /** Some tile is beyond the aspect limit and below the minimum. */
  | 'invalid';

/**
 * Checks the size rule every plan the editor can make satisfies (see the
 * module comment), in the plan's own geometry: each tile is either within
 * planAspectLimit, or at least MIN_TILE_FRACTION of the shorter side both
 * ways (each with a little floating-point slack). Throws for a malformed plan.
 */
export function checkTileSizes(plan: LayoutPlan): TileSizes {
  validatePlan(plan);
  if (plan.root === null) return 'planned';
  const limit = planAspectLimit(plan.aspect, 1, plan.count) * (1 + SLACK);
  const m = minTileSide(plan) * (1 - SLACK);
  let result: TileSizes = 'planned';
  walkPlaced(plan, { width: plan.aspect, height: 1 }, (tile) => {
    const long = Math.max(tile.width, tile.height);
    const short = Math.min(tile.width, tile.height);
    if (short > 0 && long / short <= limit) return;
    if (short >= m) {
      if (result === 'planned') result = 'resized';
      return;
    }
    result = 'invalid';
  });
  return result;
}

/** The minimum tile side, in the plan's own geometry (`aspect` × 1). */
export function minTileSide(plan: LayoutPlan): number {
  return MIN_TILE_FRACTION * Math.min(plan.aspect, 1);
}

// --- Internals ---------------------------------------------------------------

/** The split node at `path` and its region in the plan's own geometry. */
function findSplit(
  plan: LayoutPlan,
  path: string,
): { node: SplitNode; width: number; height: number } {
  validatePlan(plan);
  if (typeof path !== 'string' || !/^[01]*$/.test(path)) {
    throw new RangeError('a divider path is a string of 0s and 1s');
  }
  let node = plan.root;
  let width = plan.aspect;
  let height = 1;
  for (const step of path) {
    if (node?.kind !== 'split') break;
    const f = step === '0' ? node.fraction : 1 - node.fraction;
    if (node.axis === 'x') width *= f;
    else height *= f;
    node = step === '0' ? node.first : node.second;
  }
  if (node?.kind !== 'split') {
    throw new RangeError(`no divider at path ${JSON.stringify(path)}`);
  }
  return { node, width, height };
}

/**
 * Calls `leaf(p, e)` for every leaf under `node`: its length along `axis`
 * as a share `p` of the node's, and its absolute length `e` across `axis`
 * (starting from `cross` for the node).
 */
function forEachLeafShare(
  node: LayoutNode,
  axis: Axis,
  p: number,
  cross: number,
  leaf: (p: number, e: number) => void,
): void {
  if (node.kind === 'leaf') {
    leaf(p, cross);
    return;
  }
  const f = node.fraction;
  if (node.axis === axis) {
    forEachLeafShare(node.first, axis, p * f, cross, leaf);
    forEachLeafShare(node.second, axis, p * (1 - f), cross, leaf);
  } else {
    forEachLeafShare(node.first, axis, p, cross * f, leaf);
    forEachLeafShare(node.second, axis, p, cross * (1 - f), leaf);
  }
}

/**
 * How many tiles lie on each side of the divider at `path`: first (left or
 * top) and second. For a divider's accessible name. Throws like
 * dividerRange.
 */
export function tilesBeside(
  plan: LayoutPlan,
  path: string,
): { readonly first: number; readonly second: number } {
  const { node } = findSplit(plan, path);
  return { first: countLeaves(node.first), second: countLeaves(node.second) };
}

function countLeaves(node: LayoutNode): number {
  return node.kind === 'leaf'
    ? 1
    : countLeaves(node.first) + countLeaves(node.second);
}
