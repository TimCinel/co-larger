import { describe, expect, it } from 'vitest';
import {
  assignPhotos,
  autoColumns,
  checkTileSizes,
  gridColumnsOf,
  gridCost,
  gridRows,
  listDividers,
  maxBorder,
  placementCost,
  placeLayout,
  planGrid,
  planLayout,
  setDividerFraction,
  validatePlan,
  withinPlannerShape,
  type LayoutNode,
  type Tile,
} from '.';
import { fractionAt } from './dividers';
import { RATIO_PRESETS, tilingError } from './test-helpers';

/** The ratio presets plus a few extreme canvases. */
const CANVASES: readonly (readonly [number, number])[] = [
  ...RATIO_PRESETS,
  [10, 1],
  [1, 10],
  [40, 1],
];
const BORDERS = [0, 0.01, 0.03, 0.1];

/** Pixel size of a canvas whose longer side is `long` px. */
function pixels(
  [w, h]: readonly [number, number],
  long: number,
): [number, number] {
  return w >= h
    ? [long, Math.max(1, Math.round((long * h) / w))]
    : [Math.max(1, Math.round((long * w) / h)), long];
}

/** Tiles grouped into rows, as planGrid numbers slots (row by row). */
function rowsOf(tiles: readonly Tile[], count: number, columns: number) {
  const out: Tile[][] = [];
  let slot = 0;
  for (const cells of gridRows(count, columns)) {
    out.push(tiles.slice(slot, slot + cells));
    slot += cells;
  }
  return out;
}

const spread = (values: readonly number[]): number =>
  Math.max(...values) - Math.min(...values);

/**
 * Checks one grid placement: tiles fill the canvas exactly, every row has
 * the same height, every row's cells the same width, and every row spans
 * the full width. `tolerance` is the largest difference allowed (0 for
 * exact, 1 for snapped pixels). Returns a description of the first failure.
 */
function gridError(
  tiles: readonly Tile[],
  count: number,
  columns: number,
  width: number,
  height: number,
  border: number,
  tolerance: number,
  snap: boolean,
): string | null {
  const tiling = tilingError(
    tiles,
    width,
    height,
    border,
    snap ? 0 : 1e-6 * Math.max(width, height),
  );
  if (tiling) return tiling;
  const rows = rowsOf(tiles, count, columns);
  const heights = rows.map((r) => (r[0] as Tile).height);
  if (spread(heights) > tolerance) {
    return `row heights differ by ${String(spread(heights))}`;
  }
  for (const [i, row] of rows.entries()) {
    if (row.some((t) => t.y !== (row[0] as Tile).y)) {
      return `row ${String(i)} is not level`;
    }
    const widths = row.map((t) => t.width);
    if (spread(widths) > tolerance) {
      return `row ${String(i)} widths differ by ${String(spread(widths))}`;
    }
    const first = row[0] as Tile;
    const last = row[row.length - 1] as Tile;
    const eps = snap ? 0 : 1e-6 * width;
    if (
      Math.abs(first.x - border) > eps ||
      Math.abs(last.x + last.width - (width - border)) > eps
    ) {
      return `row ${String(i)} does not span the width`;
    }
  }
  // Full rows all have the same cell width.
  const full = rows.filter((r) => r.length === rows[0]?.length);
  const fullWidths = full.flatMap((r) => r.map((t) => t.width));
  if (spread(fullWidths) > tolerance) {
    return `full-row cells differ by ${String(spread(fullWidths))}`;
  }
  return null;
}

describe('gridRows', () => {
  it('fills rows of `columns` cells and puts the rest in a last row', () => {
    expect(gridRows(0, 3)).toEqual([]);
    expect(gridRows(1, 1)).toEqual([1]);
    expect(gridRows(7, 3)).toEqual([3, 3, 1]);
    expect(gridRows(6, 3)).toEqual([3, 3]);
    expect(gridRows(5, 9)).toEqual([5]);
    expect(gridRows(4, 1)).toEqual([1, 1, 1, 1]);
  });
});

describe('planGrid', () => {
  it('makes a valid plan whose tree is rows of cells, slots row by row', () => {
    const plan = planGrid({
      width: 3,
      height: 2,
      count: 7,
      columns: 3,
      variation: 0.4,
      seed: 9,
    });
    expect(validatePlan(plan)).toBe(plan);
    expect(plan).toMatchObject({
      aspect: 1.5,
      count: 7,
      variation: 0.4,
      seed: 9,
      kind: 'grid',
    });
    expect(gridColumnsOf(plan)).toBe(3);
    const tiles = placeLayout(plan, { width: 300, height: 200 });
    const r9 = (v: number): number => Math.round(v * 1e9) / 1e9;
    expect(tiles.map((t) => [r9(t.x), r9(t.y)])).toEqual([
      [0, 0],
      [100, 0],
      [200, 0],
      [0, r9(200 / 3)],
      [100, r9(200 / 3)],
      [200, r9(200 / 3)],
      [0, r9(400 / 3)],
    ]);
    expect(r9(tiles[6]?.width ?? 0)).toBe(300);
  });

  it('is one tile for one photo, and empty for none', () => {
    const one = planGrid({
      width: 16,
      height: 9,
      count: 1,
      columns: 4,
      variation: 0.5,
      seed: 1,
    });
    expect(one.root).toEqual({ kind: 'leaf', slot: 0 });
    expect(placeLayout(one, { width: 160, height: 90, border: 5 })).toEqual([
      { slot: 0, x: 5, y: 5, width: 150, height: 80 },
    ]);
    const none = planGrid({
      width: 16,
      height: 9,
      count: 0,
      columns: 4,
      variation: 0.5,
      seed: 1,
    });
    expect(none.root).toBeNull();
    expect(validatePlan(none)).toBe(none);
  });

  it('clamps a column count above the photo count to one row', () => {
    const plan = planGrid({
      width: 1,
      height: 1,
      count: 3,
      columns: 10,
      variation: 0,
      seed: 0,
    });
    expect(gridColumnsOf(plan)).toBe(3);
    expect(gridRows(3, 10)).toEqual([3]);
  });

  it('rejects bad inputs', () => {
    const base = {
      width: 1,
      height: 1,
      count: 3,
      columns: 2,
      variation: 0,
      seed: 0,
    };
    expect(() => planGrid({ ...base, columns: 0 })).toThrow(RangeError);
    expect(() => planGrid({ ...base, columns: 1.5 })).toThrow(RangeError);
    expect(() => planGrid({ ...base, count: -1 })).toThrow(RangeError);
    expect(() => planGrid({ ...base, width: 0 })).toThrow(RangeError);
  });
});

describe('grid placement (property)', () => {
  /**
   * Column counts to try for N tiles: every count up to 40 tiles, then a
   * spread (1, 2, 3, about √N, N/2, N-1, N, beyond N) plus Auto for mixed
   * photos.
   */
  function columnsFor(n: number, aspect: number): number[] {
    const auto = autoColumns(
      aspect,
      Array.from({ length: n }, (_, i) => [1.5, 0.67, 1, 1.33][i % 4] ?? 1),
    );
    if (n <= 40) return [...Array.from({ length: n }, (_, i) => i + 1), auto];
    const root = Math.round(Math.sqrt(n * aspect));
    return [
      ...new Set([
        1,
        2,
        3,
        root,
        root + 1,
        Math.ceil(n / 2),
        n - 1,
        n,
        n + 7,
        auto,
      ]),
    ].filter((c) => c >= 1);
  }

  it('fills the canvas exactly with equal rows and equal cells, N = 1..300, every ratio, borders 0 to 10%', () => {
    let placements = 0;
    let skipped = 0;
    for (const canvas of CANVASES) {
      const [width, height] = pixels(canvas, 1920);
      for (let n = 1; n <= 300; n++) {
        for (const columns of columnsFor(n, width / height)) {
          const rows = gridRows(n, columns);
          // Fewer pixels than rows or cells: some tile must be 0 wide when
          // snapped (placeLayout documents this), so only the exact
          // placement is checked.
          const fits = rows.length <= height && (rows[0] ?? 0) <= width;
          if (!fits) skipped++;
          const plan = planGrid({
            width,
            height,
            count: n,
            columns,
            variation: 0.5,
            seed: 1,
          });
          for (const fraction of BORDERS) {
            // The border as the editor draws it: the requested width,
            // clamped so that every tile keeps a pixel.
            const requested = Math.round(fraction * Math.min(width, height));
            const snapLimit = maxBorder(plan, width, height, { snap: true });
            const border = Math.min(requested, snapLimit);
            const exact = placeLayout(plan, { width, height, border });
            const e1 = gridError(
              exact,
              n,
              columns,
              width,
              height,
              border,
              1e-9 * Math.max(width, height),
              false,
            );
            if (e1) {
              throw new Error(
                `${String(canvas)} N=${String(n)} C=${String(columns)} border ${String(border)}: ${e1}`,
              );
            }
            placements++;
            if (!fits) continue;
            const snapped = placeLayout(plan, {
              width,
              height,
              border,
              snap: true,
            });
            const e2 = gridError(
              snapped,
              n,
              columns,
              width,
              height,
              border,
              1,
              true,
            );
            if (e2) {
              throw new Error(
                `${String(canvas)} N=${String(n)} C=${String(columns)} border ${String(border)} snapped: ${e2}`,
              );
            }
            placements++;
          }
        }
      }
    }
    // Only a column of more tiles than the 10:1 and 40:1 canvases' shorter
    // side (192 and 48 px) has pixels.
    expect(skipped).toBeLessThan(placements / 50);
    expect(placements).toBeGreaterThan(100_000);
  });

  it('snapped cells are exactly equal whenever the pixels divide evenly', () => {
    // 1920 × 1080, borders 0, 10, 12 and 30 px.
    for (const border of [0, 10, 12, 30]) {
      for (let n = 1; n <= 60; n++) {
        for (let columns = 1; columns <= n; columns++) {
          const plan = planGrid({
            width: 1920,
            height: 1080,
            count: n,
            columns,
            variation: 0.5,
            seed: 0,
          });
          if (border > maxBorder(plan, 1920, 1080, { snap: true })) continue;
          const tiles = placeLayout(plan, {
            width: 1920,
            height: 1080,
            border,
            snap: true,
          });
          const rows = rowsOf(tiles, n, columns);
          const r = rows.length;
          const innerH = 1080 - (r + 1) * border;
          const heights = rows.map((row) => (row[0] as Tile).height);
          if (innerH % r === 0) expect(spread(heights)).toBe(0);
          else expect(spread(heights)).toBeLessThanOrEqual(1);
          for (const row of rows) {
            const innerW = 1920 - (row.length + 1) * border;
            const widths = row.map((t) => t.width);
            if (innerW % row.length === 0) expect(spread(widths)).toBe(0);
            else expect(spread(widths)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('a partial last row has wider cells that still span the canvas', () => {
    const plan = planGrid({
      width: 1200,
      height: 900,
      count: 10,
      columns: 4,
      variation: 0.5,
      seed: 0,
    });
    const tiles = placeLayout(plan, {
      width: 1200,
      height: 900,
      border: 12,
      snap: true,
    });
    const rows = rowsOf(tiles, 10, 4);
    expect(rows.map((r) => r.length)).toEqual([4, 4, 2]);
    const full = (rows[0]?.[0] as Tile).width;
    const wide = (rows[2]?.[0] as Tile).width;
    expect(wide).toBeGreaterThan(full);
    expect(rows[2]?.[1]?.x).toBe(12 + wide + 12);
    expect((rows[2]?.[1]?.x ?? 0) + (rows[2]?.[1]?.width ?? 0)).toBe(1188);
  });

  it("a mosaic plan's tiles are placed exactly as before (no kind, old cut rule)", () => {
    const plan = planLayout({
      width: 1600,
      height: 900,
      count: 23,
      variation: 0.7,
      seed: 4,
    });
    expect('kind' in plan).toBe(false);
    // The old rule, written out: first = f * (L - g).
    const visit = (
      node: LayoutNode,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      out: Tile[],
      g: number,
    ): void => {
      if (node.kind === 'leaf') {
        out[node.slot] = {
          slot: node.slot,
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
        };
        return;
      }
      if (node.axis === 'x') {
        const c = x0 + (x1 - x0 - g) * node.fraction;
        visit(node.first, x0, y0, c, y1, out, g);
        visit(node.second, c + g, y0, x1, y1, out, g);
      } else {
        const c = y0 + (y1 - y0 - g) * node.fraction;
        visit(node.first, x0, y0, x1, c, out, g);
        visit(node.second, x0, c + g, x1, y1, out, g);
      }
    };
    const expected: Tile[] = [];
    visit(plan.root as LayoutNode, 7, 7, 1593, 893, expected, 7);
    expect(placeLayout(plan, { width: 1600, height: 900, border: 7 })).toEqual(
      expected,
    );
  });
});

describe('grid validation', () => {
  const plan = planGrid({
    width: 16,
    height: 9,
    count: 11,
    columns: 4,
    variation: 0.5,
    seed: 3,
  });
  // A mutable copy, as a hostile file could hold.
  interface Mutable {
    root: {
      fraction: number;
      first: {
        axis: string;
        first: { slot: number };
        second: { first: { slot: number } };
      };
    };
  }
  const json = (): Mutable & Record<string, unknown> =>
    JSON.parse(JSON.stringify(plan)) as Mutable & Record<string, unknown>;

  it('accepts a grid round-tripped through JSON', () => {
    expect(() => validatePlan(json())).not.toThrow();
  });

  it('refuses an unknown kind', () => {
    expect(() => validatePlan({ ...json(), kind: 'brick' })).toThrow(TypeError);
  });

  it('refuses a plan marked as a grid whose tree is not a grid', () => {
    const mosaic = planLayout({
      width: 16,
      height: 9,
      count: 11,
      variation: 0.5,
      seed: 3,
    });
    expect(() => validatePlan({ ...mosaic, kind: 'grid' })).toThrow(RangeError);
    // Two slots swapped.
    const swapped = json();
    swapped.root.first.first.slot = 1;
    swapped.root.first.second.first.slot = 0;
    expect(() => validatePlan(swapped)).toThrow(RangeError);
    // A cut turned the other way.
    const turned = json();
    turned.root.first.axis = 'y';
    expect(() => validatePlan(turned)).toThrow(RangeError);
  });

  it('accepts moved fractions (hand resizing) but not tiles squashed to nothing', () => {
    const resized = setDividerFraction(plan, '', 0.5);
    expect(validatePlan(resized)).toBe(resized);
    expect(checkTileSizes(resized)).not.toBe('invalid');
    const squashed = json();
    squashed.root.fraction = 1e-9;
    expect(checkTileSizes(validatePlan(squashed))).toBe('invalid');
  });

  it('accepts grids whose cells are beyond the mosaic limit, and reports them to versionFor', () => {
    // One column of 30 on a wide canvas: cells 53:1.
    const strip = planGrid({
      width: 16,
      height: 9,
      count: 30,
      columns: 1,
      variation: 0.5,
      seed: 0,
    });
    expect(checkTileSizes(strip)).toBe('planned');
    expect(withinPlannerShape(strip)).toBe(false);
    // A grid whose cells are within 2.5:1: release 2026.11.0 accepts it.
    const square = planGrid({
      width: 1,
      height: 1,
      count: 9,
      columns: 3,
      variation: 0.5,
      seed: 0,
    });
    expect(withinPlannerShape(square)).toBe(true);
  });
});

describe('grid dividers', () => {
  it('fractionAt inverts where a grid divider is drawn, at any border', () => {
    const plan = planGrid({
      width: 1000,
      height: 600,
      count: 9,
      columns: 4,
      variation: 0.5,
      seed: 0,
    });
    for (const border of [0, 6, 20]) {
      for (const d of listDividers(plan, {
        width: 1000,
        height: 600,
        border,
      })) {
        expect(d.grid).toBe(true);
        expect(fractionAt(d, d.cut + border / 2)).toBeCloseTo(d.fraction, 12);
      }
    }
    const mosaic = planLayout({
      width: 1000,
      height: 600,
      count: 9,
      variation: 0.5,
      seed: 0,
    });
    for (const d of listDividers(mosaic, {
      width: 1000,
      height: 600,
      border: 6,
    })) {
      expect('grid' in d).toBe(false);
    }
  });
});

describe('autoColumns', () => {
  const same = (n: number, aspect: number): number[] =>
    Array.from({ length: n }, () => aspect);
  /** Cell shape (width / height) of a full row. */
  const cellShape = (canvas: number, n: number, c: number): number =>
    (canvas * gridRows(n, c).length) / Math.min(c, n);

  it('gives square cells for square photos on a square canvas when N is a square', () => {
    for (const k of [2, 3, 4, 5, 8, 12, 17]) {
      expect(autoColumns(1, same(k * k, 1))).toBe(k);
    }
  });

  it('gives landscape cells for landscape photos and portrait cells for portrait ones', () => {
    let strict = 0;
    let cases = 0;
    for (const canvas of [16 / 9, 1, 3 / 4, 1 / 2]) {
      for (const n of [6, 12, 20, 35, 60, 150, 300]) {
        const land = autoColumns(canvas, same(n, 3 / 2));
        const port = autoColumns(canvas, same(n, 2 / 3));
        const sq = autoColumns(canvas, same(n, 1));
        const l = cellShape(canvas, n, land);
        const q = cellShape(canvas, n, sq);
        const p = cellShape(canvas, n, port);
        // Never the wrong way round; usually strictly (a few photos on a
        // long canvas can leave one grid best for every shape).
        expect(l).toBeGreaterThanOrEqual(q);
        expect(q).toBeGreaterThanOrEqual(p);
        cases++;
        if (l > p) strict++;
        // Each choice is at least as good for its own photos as the others.
        for (const [mine, aspect] of [
          [land, 3 / 2],
          [port, 2 / 3],
          [sq, 1],
        ] as const) {
          for (const other of [land, port, sq]) {
            expect(gridCost(canvas, same(n, aspect), mine)).toBeLessThanOrEqual(
              gridCost(canvas, same(n, aspect), other),
            );
          }
        }
      }
    }
    expect(strict / cases).toBeGreaterThan(0.75);
  });

  it('matches the photo shape exactly when a grid can', () => {
    // 12 photos of 4:3 on a 16:9 canvas: 3 rows of 4 cells are exactly 4:3.
    expect(autoColumns(16 / 9, same(12, 4 / 3))).toBe(4);
    expect(gridCost(16 / 9, same(12, 4 / 3), 4)).toBeCloseTo(0, 12);
    // 2 photos of 1:2 on a square canvas: side by side.
    expect(autoColumns(1, same(2, 1 / 2))).toBe(2);
  });

  it('is the minimum of the cost over every column count, for mixed photos', () => {
    const mixed = [1.5, 0.67, 1, 1.33, 0.75, 1.78, 0.56, 1.25];
    for (const canvas of [16 / 9, 1, 2 / 3]) {
      for (let n = 1; n <= 60; n++) {
        const aspects = Array.from(
          { length: n },
          (_, i) => mixed[(i * 5) % mixed.length] as number,
        );
        const chosen = autoColumns(canvas, aspects);
        const best = Math.min(
          ...Array.from({ length: n }, (_, c) =>
            gridCost(canvas, aspects, c + 1),
          ),
        );
        expect(gridCost(canvas, aspects, chosen)).toBe(best);
        // The first column count reaching the minimum: deterministic ties.
        for (let c = 1; c < chosen; c++) {
          expect(gridCost(canvas, aspects, c)).toBeGreaterThan(best);
        }
        // The photos' order does not matter.
        expect(autoColumns(canvas, [...aspects].reverse())).toBe(chosen);
      }
    }
  });

  it("gridCost is exactly the assignment's optimum (placementCost with no noise)", () => {
    const mixed = [1.5, 0.67, 1, 1.33, 0.75, 2.4, 0.5, 1.25];
    for (const canvas of [16 / 9, 1, 3 / 4]) {
      for (let n = 1; n <= 14; n++) {
        const photos = Array.from({ length: n }, (_, i) => ({
          id: `p${String(i)}`,
          aspect: mixed[(i * 3) % mixed.length] as number,
        }));
        for (let c = 1; c <= n; c++) {
          const plan = planGrid({
            width: canvas,
            height: 1,
            count: n,
            columns: c,
            variation: 0,
            seed: 0,
          });
          const slots = placeLayout(plan, { width: canvas, height: 1 });
          const best = assignPhotos(slots, photos, { seed: 0, noise: 0 });
          const cost = gridCost(
            canvas,
            photos.map((p) => p.aspect),
            c,
          );
          expect(cost).toBeCloseTo(placementCost(slots, photos, best), 10);
        }
      }
    }
  });

  it('is 1 for zero or one photo', () => {
    expect(autoColumns(16 / 9, [])).toBe(1);
    expect(autoColumns(16 / 9, [0.5])).toBe(1);
  });

  it('is cheap with 300 photos', () => {
    const aspects = Array.from(
      { length: 300 },
      (_, i) => [1.5, 0.67, 1, 1.33, 0.75][i % 5] as number,
    );
    autoColumns(16 / 9, aspects);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      autoColumns(16 / 9, aspects);
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    console.log(
      `autoColumns, 300 photos: median ${runs[2]?.toFixed(1) ?? '?'} ms`,
    );
    expect(runs[2]).toBeLessThan(100);
  });
});
