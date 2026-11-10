import type { LayoutNode, LayoutPlan, PlaceOptions, Tile } from './types';

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
 * scaled with it). With `snap`, the border is rounded to a whole number and
 * every cut is rounded to the nearest whole unit, so each edge is within half
 * a unit of its unsnapped position, every gap is exactly the rounded border,
 * and the tiles still fill the canvas with no gaps or overlaps.
 *
 * Tiles are returned indexed by slot: `tiles[i].slot === i`.
 */
export function placeLayout(plan: LayoutPlan, options: PlaceOptions): Tile[] {
  const snap = options.snap ?? false;
  const width = snap ? Math.round(options.width) : options.width;
  const height = snap ? Math.round(options.height) : options.height;
  const rawBorder = options.border ?? 0;
  const border = snap ? Math.round(rawBorder) : rawBorder;
  if (!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) {
    throw new RangeError('width and height must be positive finite numbers');
  }
  if (!(border >= 0) || !isFinite(border)) {
    throw new RangeError('border must be a non-negative finite number');
  }

  const tiles = new Array<Tile>(plan.count);
  if (plan.root === null) return tiles;

  const limit = maxBorder(plan, width, height);
  if (border > 0 && border >= limit) {
    throw new RangeError(
      `border ${String(border)} is too large for ${String(plan.count)} tiles on a ` +
        `${String(width)} × ${String(height)} canvas; it must be less than ${String(limit)}`,
    );
  }

  const round = snap ? Math.round : (v: number) => v;
  // Each rectangle is carried as its unsnapped edges plus its actual (possibly
  // snapped) edges. Cuts are rounded from the unsnapped position, so rounding
  // errors never accumulate down the tree; children inherit the parent's
  // actual outer edges, so neighbours always share an edge exactly.
  const visit = (
    node: LayoutNode,
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
      tiles[node.slot] = {
        slot: node.slot,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      };
      return;
    }
    const f = node.fraction;
    if (node.axis === 'x') {
      const cut = fx0 + (fx1 - fx0 - border) * f;
      const c = Math.min(x1 - border, Math.max(x0, round(cut)));
      visit(node.first, fx0, fy0, cut, fy1, x0, y0, c, y1);
      visit(node.second, cut + border, fy0, fx1, fy1, c + border, y0, x1, y1);
    } else {
      const cut = fy0 + (fy1 - fy0 - border) * f;
      const c = Math.min(y1 - border, Math.max(y0, round(cut)));
      visit(node.first, fx0, fy0, fx1, cut, x0, y0, x1, c);
      visit(node.second, fx0, cut + border, fx1, fy1, x0, c + border, x1, y1);
    }
  };
  const right = width - border;
  const bottom = height - border;
  visit(
    plan.root,
    border,
    border,
    right,
    bottom,
    border,
    border,
    right,
    bottom,
  );
  return tiles;
}

/**
 * The supremum of borders that leave every tile with a positive width and
 * height on a `width` × `height` canvas. Any border below it is valid; UI
 * controls will want to stay well below it. `Infinity` for an empty plan.
 */
export function maxBorder(
  plan: LayoutPlan,
  width: number,
  height: number,
): number {
  if (plan.root === null) return Infinity;
  // Every length in the tree is a linear function of the border g, a - b*g.
  let limit = Infinity;
  const visit = (
    node: LayoutNode,
    wa: number,
    wb: number,
    ha: number,
    hb: number,
  ): void => {
    if (node.kind === 'leaf') {
      limit = Math.min(limit, wa / wb, ha / hb);
      return;
    }
    const f = node.fraction;
    if (node.axis === 'x') {
      visit(node.first, wa * f, (wb + 1) * f, ha, hb);
      visit(node.second, wa * (1 - f), (wb + 1) * (1 - f), ha, hb);
    } else {
      visit(node.first, wa, wb, ha * f, (hb + 1) * f);
      visit(node.second, wa, wb, ha * (1 - f), (hb + 1) * (1 - f));
    }
  };
  visit(plan.root, width, 2, height, 2);
  return limit;
}
