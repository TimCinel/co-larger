/**
 * The Grid layout (#20): rows of equal height, every full row with the same
 * number of equal-width cells, and a partial last row whose cells are wider
 * so that it still spans the canvas. One tile per photo, no empty cells.
 *
 * A grid is an ordinary LayoutPlan (a guillotine tree), so rendering,
 * export, crops, dividers and saving treat it like a mosaic:
 *
 * - The root is a chain of horizontal cuts, one row per link: the first cut
 *   gives the top row 1/R of the height, the next gives the second row
 *   1/(R-1) of what is left, and so on. Each row is the same chain of
 *   vertical cuts over its cells (1/C, 1/(C-1), ...). Slots are numbered row
 *   by row, left to right.
 * - The plan is marked `kind: 'grid'`. That changes one thing in placement
 *   (see LayoutPlan.kind and place.ts): each cut shares its region plus one
 *   gap, rather than its region minus one gap, so fractions of the form a/n
 *   give exactly equal tiles at every border. With the mosaic's rule the
 *   cells of a row would differ by up to a gap's width as soon as the border
 *   is not zero. With no border the two rules are the same.
 *
 * Plans are pure functions of the canvas ratio, the photo count and the
 * column count. The variation and seed are carried only so that a grid plan
 * matches the editor state it belongs to (the dial and Shuffle keep their
 * meaning in the state: Shuffle changes which photo is in which cell).
 *
 * Auto columns (autoColumns): the column count whose cells crop the
 * included photos least, by the measure the assignment itself minimises
 * (placementCost: each photo's crop fraction squared, weighted by its cell's
 * share of the area), with the photos placed optimally. A grid has at most
 * two cell shapes, a full row's and the partial last row's, and for two
 * shapes the optimal placement is exact and cheap: start with every photo in
 * a full-row cell and move the k photos that gain most into the k last-row
 * cells. O(n log n) per column count, so trying every count from 1 to n is
 * O(n² log n): about 1.3 ms for 300 photos (measured in Node).
 */
import { cropFraction } from './assign';
import { planAspectLimit } from './plan';
import type { LayoutNode, LayoutPlan } from './types';

/** Inputs for {@link planGrid}. */
export interface GridOptions {
  /** Canvas width, any unit; only the ratio matters. */
  readonly width: number;
  /** Canvas height, same unit. */
  readonly height: number;
  /** Number of tiles, a non-negative integer. */
  readonly count: number;
  /**
   * Cells in each full row: a whole number from 1. Larger than `count` is
   * clamped to `count` (one row).
   */
  readonly columns: number;
  /** Carried into the plan unchanged (0..1); it does not shape a grid. */
  readonly variation: number;
  /** Carried into the plan unchanged; it does not shape a grid. */
  readonly seed: number;
}

/**
 * The number of cells in each row, top to bottom, for `count` tiles in
 * `columns` columns (clamped to 1..count): full rows, then a partial last
 * row if the count does not fill it. Empty for no tiles.
 */
export function gridRows(count: number, columns: number): number[] {
  if (count === 0) return [];
  const c = clampColumns(columns, count);
  const rows: number[] = [];
  for (let left = count; left > 0; left -= c) rows.push(Math.min(c, left));
  return rows;
}

/** A grid plan: see the module comment. */
export function planGrid(options: GridOptions): LayoutPlan {
  const { width, height, count, seed } = options;
  if (!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) {
    throw new RangeError('width and height must be positive finite numbers');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(
      `count must be a non-negative integer, got ${String(count)}`,
    );
  }
  if (!Number.isInteger(options.columns) || options.columns < 1) {
    throw new RangeError('columns must be a whole number from 1');
  }
  if (Number.isNaN(options.variation)) {
    throw new RangeError('variation must be a number');
  }
  const variation = Math.min(1, Math.max(0, options.variation));
  const aspect = width / height;
  return {
    aspect,
    count,
    variation,
    seed,
    kind: 'grid',
    root: gridTree(count, options.columns),
  };
}

/**
 * The tree of a grid of `count` tiles in `columns` columns, or null for no
 * tiles. Exported for validation, which compares a stored grid's tree with
 * this one.
 */
export function gridTree(count: number, columns: number): LayoutNode | null {
  const rows = gridRows(count, columns);
  let slot = 0;
  const rowNodes = rows.map((cells) => {
    const leaves: LayoutNode[] = [];
    for (let i = 0; i < cells; i++) leaves.push({ kind: 'leaf', slot: slot++ });
    return chain(leaves, 'x');
  });
  return rowNodes.length === 0 ? null : chain(rowNodes, 'y');
}

/**
 * The column count of a grid plan's tree: the number of cells in its first
 * row (every row but a partial last one has that many). 0 for an empty plan.
 * Does not check that the tree is a grid (see checkGridTree).
 */
export function gridColumnsOf(plan: LayoutPlan): number {
  let node = plan.root;
  if (node === null) return 0;
  // The first row: the first child of the row chain, or the root itself
  // when there is a single row (then the root is a vertical cut or a leaf).
  if (node.kind === 'split' && node.axis === 'y') node = node.first;
  let cells = 1;
  while (node.kind === 'split' && node.axis === 'x') {
    cells++;
    node = node.second;
  }
  return cells;
}

/**
 * Throws a RangeError unless the tree of `plan` (a plan marked as a grid)
 * is exactly the grid tree for its count and the column count of its first
 * row, slot numbers included. Fractions are not compared: they may have
 * been moved by hand (#16). validatePlan calls this for every grid plan, so
 * the different cut rule of a grid only ever applies to a real grid.
 */
export function checkGridTree(plan: LayoutPlan): void {
  const columns = gridColumnsOf(plan);
  if (plan.count === 0) return;
  if (columns < 1 || columns > plan.count) {
    throw new RangeError('plan is marked as a grid but is not one');
  }
  if (!sameShape(plan.root, gridTree(plan.count, columns))) {
    throw new RangeError('plan is marked as a grid but is not one');
  }
}

/**
 * The most stretched tile (long side over short side) of the unresized grid
 * with the tree of `plan`, in its own geometry: the shape limit a grid
 * implies, since a grid's cells can be far beyond the mosaic planner's
 * limit (one column on a wide canvas, say). 1 for an empty plan.
 */
export function gridShapeLimit(plan: LayoutPlan): number {
  if (plan.count === 0) return 1;
  const rows = gridRows(plan.count, gridColumnsOf(plan));
  let worst = 1;
  for (const cells of new Set(rows)) {
    const a = (plan.aspect * rows.length) / cells;
    worst = Math.max(worst, a, 1 / a);
  }
  return worst;
}

/**
 * The shape limit stored plans are checked against (see checkTileSizes):
 * planAspectLimit for a mosaic, and for a grid the larger of that and its
 * own cells' shape (gridShapeLimit).
 */
export function shapeLimit(plan: LayoutPlan): number {
  const limit = planAspectLimit(plan.aspect, 1, plan.count);
  return plan.kind === 'grid' ? Math.max(limit, gridShapeLimit(plan)) : limit;
}

/**
 * The placement cost of a grid of `aspects.length` photos in `columns`
 * columns on a canvas of width/height `canvasAspect`, with every photo in
 * its best cell: the area-weighted mean of each photo's crop fraction
 * squared (placementCost in assign.ts, which assignPhotos minimises, here
 * with no seeded surcharge). Cells are measured with no border, as the
 * assignment measures them. 0 for no photos.
 */
export function gridCost(
  canvasAspect: number,
  aspects: readonly number[],
  columns: number,
): number {
  const n = aspects.length;
  if (n === 0) return 0;
  const rows = gridRows(n, columns);
  const r = rows.length;
  const c = rows[0] as number;
  const last = rows[r - 1] as number;
  // Shares of the canvas area: a full-row cell and a last-row cell.
  const fullShape = (canvasAspect * r) / c;
  const fullWeight = 1 / (c * r);
  let total = 0;
  if (last === c) {
    for (const a of aspects) total += squaredCrop(a, fullShape);
    return total * fullWeight;
  }
  const lastShape = (canvasAspect * r) / last;
  const lastWeight = 1 / (last * r);
  // Everyone in a full-row cell, then the `last` photos that gain most move
  // to the last row. Exact for two cell shapes: the choice of which photos
  // go to the last row is independent of everything else.
  const gains = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = aspects[i] as number;
    const full = fullWeight * squaredCrop(a, fullShape);
    total += full;
    gains[i] = lastWeight * squaredCrop(a, lastShape) - full;
  }
  gains.sort();
  for (let i = 0; i < last; i++) total += gains[i] as number;
  return total;
}

/**
 * Auto columns: the column count from 1 to the photo count whose grid has
 * the smallest gridCost for these photos, the fewest columns on an exact
 * tie. 1 for no photos. Deterministic: a pure function of the canvas ratio
 * and the photos' aspects, in any order.
 */
export function autoColumns(
  canvasAspect: number,
  aspects: readonly number[],
): number {
  const n = aspects.length;
  if (n <= 1) return 1;
  // Sorted, so the result never depends on the photos' order (sums are
  // taken in one order).
  const sorted = [...aspects].sort((a, b) => a - b);
  let best = 1;
  let bestCost = Infinity;
  for (let c = 1; c <= n; c++) {
    const cost = gridCost(canvasAspect, sorted, c);
    if (cost < bestCost) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

/** Clamps a column setting to what `count` tiles can use: 1..count. */
export function clampColumns(columns: number, count: number): number {
  return Math.max(1, Math.min(columns, count));
}

// --- Internals ---------------------------------------------------------------

function squaredCrop(photo: number, cell: number): number {
  const crop = cropFraction(photo, cell);
  return crop * crop;
}

/** `items` side by side along `axis`, in equal shares. */
function chain(items: readonly LayoutNode[], axis: 'x' | 'y'): LayoutNode {
  // Built from the end, so a long chain needs no deep recursion.
  let node = items[items.length - 1] as LayoutNode;
  for (let i = items.length - 2; i >= 0; i--) {
    node = {
      kind: 'split',
      axis,
      fraction: 1 / (items.length - i),
      first: items[i] as LayoutNode,
      second: node,
    };
  }
  return node;
}

/** Same tree shape and slots, any fractions. Iterative (trees may be deep). */
function sameShape(a: LayoutNode | null, b: LayoutNode | null): boolean {
  const stack: [LayoutNode | null, LayoutNode | null][] = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [LayoutNode | null, LayoutNode | null];
    if (x === null || y === null) {
      if (x !== y) return false;
      continue;
    }
    if (x.kind !== y.kind) return false;
    if (x.kind === 'leaf') {
      if (x.slot !== (y as typeof x).slot) return false;
      continue;
    }
    const s = y as typeof x;
    if (x.axis !== s.axis) return false;
    stack.push([x.first, s.first], [x.second, s.second]);
  }
  return true;
}
