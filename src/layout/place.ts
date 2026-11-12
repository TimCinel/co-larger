import type {
  LayoutNode,
  LayoutPlan,
  PlaceOptions,
  SplitNode,
  Tile,
} from './types';
import { validatePlan } from './validate';

/**
 * How far the canvas's aspect ratio may differ from the plan's before
 * placeLayout refuses (2%). Rounding a preview to whole pixels stays well
 * inside this; a genuinely different ratio needs a new plan.
 */
const ASPECT_TOLERANCE = Math.log(1.02);

/**
 * Turns a plan into rectangles on a concrete canvas.
 *
 * The canvas is inset by `border` on every side, then each cut in the tree
 * removes one `border`-wide gap and shares the rest of the length between its
 * two children by the cut's fraction. So the tiles, the gaps and the outer
 * margin always fill the canvas exactly, and the border never changes the
 * arrangement.
 *
 * Without `snap`, coordinates are real numbers and placing the same plan at
 * a different size gives exactly the same picture scaled (when the border is
 * scaled with it). With `snap`, the canvas size and border are rounded to
 * whole numbers and every cut is rounded to the nearest whole unit, so each
 * edge is within half a unit of its unsnapped position, every gap is exactly
 * the rounded border, and the tiles still fill the canvas with no gaps or
 * overlaps.
 *
 * Throws a RangeError if the plan is malformed (see validatePlan), if the
 * canvas's ratio differs from the plan's by more than 2%, or if the border
 * would leave a tile with no area: above `maxBorder(plan, width, height,
 * { snap, minTileSize: 0 })` unsnapped, or above `maxBorder(plan, width,
 * height, { snap: true })` (every tile at least 1 unit) snapped. A border of 0
 * is always accepted; on an absurdly small snapped canvas (fewer pixels than
 * tiles) some tiles may then be 0 wide.
 *
 * Tiles are returned indexed by slot: `tiles[i].slot === i`. An empty plan
 * (count 0) gives an empty array.
 */
export function placeLayout(plan: LayoutPlan, options: PlaceOptions): Tile[] {
  const tiles = new Array<Tile>(plan.count);
  walkPlaced(plan, options, (tile) => {
    tiles[tile.slot] = tile;
  });
  return tiles;
}

/** A split node as placed: see walkPlaced. */
export interface PlacedSplit {
  readonly node: SplitNode;
  /**
   * The node's path from the root: one character per level, '0' for
   * `first` and '1' for `second` ('' is the root).
   */
  readonly path: string;
  /** Nesting depth: 0 for the root. */
  readonly depth: number;
  /** The node's region as drawn (snapped when placing with `snap`). */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /**
   * The node's region along its axis before snapping: the cut's unsnapped
   * position is `start + (end - start - border) * fraction`, or in a grid
   * plan (#20) `start + (end - start + border) * fraction - border`.
   */
  readonly start: number;
  readonly end: number;
  /** The drawn cut: the gap runs from `cut` to `cut + border` along the axis. */
  readonly cut: number;
  /** The gap width as placed (rounded when placing with `snap`). */
  readonly border: number;
}

/**
 * The traversal behind placeLayout, with exactly its checks and geometry:
 * calls `leaf` with every tile and `split` (if given) with every split node,
 * parents before children and `first` before `second`. For code that needs
 * the cuts as drawn (the dividers of #16).
 */
export function walkPlaced(
  plan: LayoutPlan,
  options: PlaceOptions,
  leaf: (tile: Tile) => void,
  split?: (placed: PlacedSplit) => void,
): void {
  validatePlan(plan);
  const snap = options.snap ?? false;
  checkCanvas(options.width, options.height);
  const width = snap ? Math.round(options.width) : options.width;
  const height = snap ? Math.round(options.height) : options.height;
  checkCanvas(width, height);
  const rawBorder = options.border ?? 0;
  if (!(rawBorder >= 0) || !isFinite(rawBorder)) {
    throw new RangeError('border must be a non-negative finite number');
  }
  const border = snap ? Math.round(rawBorder) : rawBorder;

  if (plan.root === null) return;
  if (Math.abs(Math.log(width / height / plan.aspect)) > ASPECT_TOLERANCE) {
    throw new RangeError(
      `the plan was made for a width/height ratio of ${plan.aspect.toFixed(4)}, ` +
        `not ${(width / height).toFixed(4)}; plan again for this canvas`,
    );
  }
  if (border > 0) {
    const limit = snap
      ? Math.floor(borderLimit(plan, width, height, 1))
      : borderLimit(plan, width, height, 0);
    if (snap ? border > limit : border >= limit) {
      throw new RangeError(
        `border ${String(border)} is too large for ${String(plan.count)} tiles on a ` +
          `${String(width)} × ${String(height)} canvas (see maxBorder)`,
      );
    }
  }

  const round = snap ? Math.round : (v: number) => v;
  // Where a cut falls in a region from `a` to `b` (unsnapped): a mosaic
  // shares the region minus the gap; a grid (#20) shares the region plus
  // one gap, so that cuts at a/n give equal tiles at any border.
  const grid = plan.kind === 'grid';
  const cutAt = (a: number, b: number, f: number): number =>
    grid ? a + (b - a + border) * f - border : a + (b - a - border) * f;
  // Each rectangle is carried as its unsnapped edges plus its actual (possibly
  // snapped) edges. Cuts are rounded from the unsnapped position, so rounding
  // errors never accumulate down the tree; children inherit the parent's
  // actual outer edges, so neighbours always share an edge exactly.
  const visit = (
    node: LayoutNode,
    path: string,
    fx0: number,
    fy0: number,
    fx1: number,
    fy1: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void => {
    if (node.kind === 'leaf') {
      leaf({
        slot: node.slot,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      });
      return;
    }
    const f = node.fraction;
    const depth = path.length;
    if (node.axis === 'x') {
      const cut = cutAt(fx0, fx1, f);
      const c = Math.min(x1 - border, Math.max(x0, round(cut)));
      split?.({
        node,
        path,
        depth,
        x0,
        y0,
        x1,
        y1,
        start: fx0,
        end: fx1,
        cut: c,
        border,
      });
      visit(node.first, `${path}0`, fx0, fy0, cut, fy1, x0, y0, c, y1);
      visit(
        node.second,
        `${path}1`,
        cut + border,
        fy0,
        fx1,
        fy1,
        c + border,
        y0,
        x1,
        y1,
      );
    } else {
      const cut = cutAt(fy0, fy1, f);
      const c = Math.min(y1 - border, Math.max(y0, round(cut)));
      split?.({
        node,
        path,
        depth,
        x0,
        y0,
        x1,
        y1,
        start: fy0,
        end: fy1,
        cut: c,
        border,
      });
      visit(node.first, `${path}0`, fx0, fy0, fx1, cut, x0, y0, x1, c);
      visit(
        node.second,
        `${path}1`,
        fx0,
        cut + border,
        fx1,
        fy1,
        x0,
        c + border,
        x1,
        y1,
      );
    }
  };
  const right = width - border;
  const bottom = height - border;
  visit(
    plan.root,
    '',
    border,
    border,
    right,
    bottom,
    border,
    border,
    right,
    bottom,
  );
}

/** Options for the border limit functions. */
export interface BorderLimitOptions {
  /** Whether the layout will be placed with `snap: true`. Defaults to false. */
  readonly snap?: boolean;
  /**
   * The smallest width and height any tile may have, in canvas units.
   * Defaults to 1 (one pixel when the canvas is in pixels).
   */
  readonly minTileSize?: number;
  /**
   * maxBorderForAspect only: tiles that are already more stretched than
   * `above` with no border (measured in the plan's own geometry, as
   * validateEditorState measures them) may be stretched by the border up to
   * `factor` times their own aspect instead of `maxAspect`, when that is
   * more. For tiles stretched by hand (dividers, #16), which no aspect limit
   * applies to: without this, one such tile would forbid any border at all.
   * Tiles at or below `above` keep `maxAspect` exactly.
   */
  readonly stretched?: { readonly above: number; readonly factor: number };
}

/**
 * The largest border at which every tile is at least `minTileSize` wide and
 * tall. Any border from 0 up to this value is safe: tiles only shrink as the
 * border grows. With `snap`, the result is a whole number and the guarantee
 * holds for the snapped tiles (`minTileSize` is rounded up to a whole number).
 *
 * Returns 0 if even with no border some tile is smaller than `minTileSize`,
 * and `Infinity` for an empty plan.
 */
export function maxBorder(
  plan: LayoutPlan,
  width: number,
  height: number,
  options: BorderLimitOptions = {},
): number {
  validatePlan(plan);
  checkCanvas(width, height);
  if (plan.root === null) return Infinity;
  const snap = options.snap ?? false;
  const min = Math.max(0, options.minTileSize ?? 1);
  if (!snap) return Math.max(0, borderLimit(plan, width, height, min));
  // A snapped edge is within half a unit of its unsnapped position, and
  // rounding preserves whole-number distances, so an unsnapped tile at least
  // k units across (k whole) is also at least k units across once snapped.
  const limit = borderLimit(
    plan,
    Math.round(width),
    Math.round(height),
    Math.ceil(min),
  );
  return Math.max(0, Math.floor(limit));
}

/**
 * The largest border at which no tile is more stretched than `maxAspect`
 * (long side over short side), for an editor to clamp its border control.
 * Borders take the same width off both sides of a tile, so they stretch
 * every tile a little; small tiles most.
 *
 * Any border from 0 up to the result keeps every tile within `maxAspect`
 * and at least `minTileSize` across (default 1 unit), so it is never above
 * maxBorder with the same options. With `snap`, the result is a whole number
 * and allows for each snapped side being up to one unit off.
 *
 * Returns 0 if even with no border some tile is beyond `maxAspect` (possible
 * only for a limit below MAX_PLAN_ASPECT, or for a canvas so long and thin
 * that the plan itself had to exceed it), and `Infinity` for an empty plan.
 */
export function maxBorderForAspect(
  plan: LayoutPlan,
  width: number,
  height: number,
  maxAspect = 3,
  options: BorderLimitOptions = {},
): number {
  validatePlan(plan);
  checkCanvas(width, height);
  if (!(maxAspect >= 1)) {
    throw new RangeError('maxAspect must be at least 1');
  }
  if (plan.root === null) return Infinity;
  const snap = options.snap ?? false;
  const w = snap ? Math.round(width) : width;
  const h = snap ? Math.round(height) : height;
  // Snapped sides may each be one unit off, so require (long + 1) <=
  // maxAspect * (short - 1): the unsnapped condition with this much slack.
  const stretched = options.stretched;
  let limit = Infinity;
  forEachLeafLength(plan, w, h, (wa, wb, ha, hb) => {
    // A tile stretched by hand beyond `stretched.above` (measured in the
    // plan's own geometry, so the same at every size) has its own limit.
    let tileMax = maxAspect;
    if (stretched) {
      const pw = (wa / w) * plan.aspect;
      const ph = ha / h;
      const own = Math.max(pw, ph) / Math.min(pw, ph);
      if (own > stretched.above) {
        tileMax = Math.max(maxAspect, own * stretched.factor);
      }
    }
    const slack = snap ? tileMax + 1 : 0;
    // width(g) = wa - wb*g and height(g) = ha - hb*g. width <= maxAspect *
    // height becomes g * (maxAspect*hb - wb) <= maxAspect*ha - wa - slack,
    // and the same with width and height swapped.
    for (const [la, lb, sa, sb] of [
      [wa, wb, ha, hb],
      [ha, hb, wa, wb],
    ] as const) {
      const c = tileMax * sb - lb;
      const d = tileMax * sa - la - slack;
      if (d < 0) limit = -Infinity;
      else if (c > 0) limit = Math.min(limit, d / c);
    }
  });
  if (!(limit > 0)) return 0;
  return Math.min(
    snap ? Math.floor(limit) : limit,
    maxBorder(plan, w, h, { snap, minTileSize: options.minTileSize ?? 1 }),
  );
}

function checkCanvas(width: number, height: number): void {
  if (!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) {
    throw new RangeError('width and height must be positive finite numbers');
  }
}

/**
 * The largest border g at which every tile is at least `min` wide and tall
 * (unsnapped). May be negative when no border achieves it.
 */
function borderLimit(
  plan: LayoutPlan,
  width: number,
  height: number,
  min: number,
): number {
  let limit = Infinity;
  forEachLeafLength(plan, width, height, (wa, wb, ha, hb) => {
    limit = Math.min(limit, (wa - min) / wb, (ha - min) / hb);
  });
  return limit;
}

/**
 * Every length in a placed tree is a linear function of the border g. Calls
 * `leaf` with each tile's width and height as `a - b*g`, given as (wa, wb,
 * ha, hb).
 */
function forEachLeafLength(
  plan: LayoutPlan,
  width: number,
  height: number,
  leaf: (wa: number, wb: number, ha: number, hb: number) => void,
): void {
  const visit = (
    node: LayoutNode,
    wa: number,
    wb: number,
    ha: number,
    hb: number,
  ): void => {
    if (node.kind === 'leaf') {
      leaf(wa, wb, ha, hb);
      return;
    }
    const f = node.fraction;
    if (grid) {
      // A grid cut (#20): first = f * (L + g) - g, second = L - g - first.
      if (node.axis === 'x') {
        visit(node.first, wa * f, wb * f + (1 - f), ha, hb);
        visit(node.second, wa * (1 - f), wb * (1 - f) + f, ha, hb);
      } else {
        visit(node.first, wa, wb, ha * f, hb * f + (1 - f));
        visit(node.second, wa, wb, ha * (1 - f), hb * (1 - f) + f);
      }
    } else if (node.axis === 'x') {
      visit(node.first, wa * f, (wb + 1) * f, ha, hb);
      visit(node.second, wa * (1 - f), (wb + 1) * (1 - f), ha, hb);
    } else {
      visit(node.first, wa, wb, ha * f, (hb + 1) * f);
      visit(node.second, wa, wb, ha * (1 - f), (hb + 1) * (1 - f));
    }
  };
  if (plan.root === null) return;
  const grid = plan.kind === 'grid';
  // The outer border takes 2g off each side of the canvas.
  visit(plan.root, width, 2, height, 2);
}
