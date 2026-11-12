import { describe, expect, it } from 'vitest';
import {
  checkTileSizes,
  dividerAt,
  dividerRange,
  fractionAt,
  listDividers,
  MIN_TILE_FRACTION,
  minTileSide,
  setDividerFraction,
  tilesBeside,
  type Divider,
} from './dividers';
import { maxBorder, placeLayout } from './place';
import { planAspectLimit, planLayout } from './plan';
import { tilingError } from './test-helpers';
import type { LayoutNode, LayoutPlan, Tile } from './types';

/** A small seeded generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATIOS = [
  [1920, 1080],
  [1080, 1920],
  [1000, 1000],
  [7016, 4961],
  [3000, 1000],
] as const;

/** A random plan: planned (often), or a random tree (any fractions). */
function randomPlan(rnd: () => number): LayoutPlan {
  const [width, height] = RATIOS[Math.floor(rnd() * RATIOS.length)] ?? [1, 1];
  const count = 1 + Math.floor(rnd() ** 2 * 120);
  if (rnd() < 0.7) {
    return planLayout({
      width,
      height,
      count,
      variation: rnd(),
      seed: Math.floor(rnd() * 1e6),
    });
  }
  // A random tree, any shape the planner would not make, with fractions
  // anywhere from 0.15 to 0.85 (and no tile under a pixel at 1920 wide).
  let slot = 0;
  const build = (n: number): LayoutNode => {
    if (n === 1) return { kind: 'leaf', slot: slot++ };
    const k = Math.min(n - 1, Math.max(1, Math.round(n * (0.25 + rnd() / 2))));
    return {
      kind: 'split',
      axis: rnd() < 0.5 ? 'x' : 'y',
      fraction: 0.15 + rnd() * 0.7,
      first: build(k),
      second: build(n - k),
    };
  };
  const plan: LayoutPlan = {
    aspect: width / height,
    count: Math.min(count, 40),
    variation: 0.5,
    seed: 1,
    root: build(Math.min(count, 40)),
  };
  // Keep trees whose every tile is at least 1% of the shorter side, so all
  // are drawn at 1920 px wide; try again otherwise.
  const short = Math.min(plan.aspect, 1);
  const ok = placeLayout(plan, { width: plan.aspect, height: 1 }).every(
    (t) => Math.min(t.width, t.height) >= 0.01 * short,
  );
  return ok ? plan : randomPlan(rnd);
}

/** Tiles in the plan's own geometry (aspect × 1, no border). */
const own = (plan: LayoutPlan): Tile[] =>
  placeLayout(plan, { width: plan.aspect, height: 1 });

function pathsOf(plan: LayoutPlan): string[] {
  return listDividers(plan, { width: plan.aspect, height: 1 }).map(
    (d) => d.path,
  );
}

function nodeAt(plan: LayoutPlan, path: string): LayoutNode {
  let node = plan.root as LayoutNode;
  for (const step of path) {
    if (node.kind !== 'split') throw new Error('not a split');
    node = step === '0' ? node.first : node.second;
  }
  return node;
}

function slotsUnder(node: LayoutNode): number[] {
  return node.kind === 'leaf'
    ? [node.slot]
    : [...slotsUnder(node.first), ...slotsUnder(node.second)];
}

describe('listDividers', () => {
  it('lists one divider per split, where placeLayout draws the gaps', () => {
    const rnd = random(7);
    for (let run = 0; run < 60; run++) {
      const plan = randomPlan(rnd);
      const width = 1000 + Math.floor(rnd() * 2000);
      const height = Math.round(width / plan.aspect);
      const border = Math.min(
        Math.round(rnd() * 20),
        maxBorder(plan, width, height, { snap: true }),
      );
      const options = { width, height, border, snap: true };
      const tiles = placeLayout(plan, options);
      const dividers = listDividers(plan, options);
      expect(dividers).toHaveLength(plan.count - 1);
      for (const d of dividers) {
        const node = nodeAt(plan, d.path);
        if (node.kind !== 'split') throw new Error('leaf');
        expect(d.axis).toBe(node.axis);
        expect(d.fraction).toBe(node.fraction);
        expect(d.border).toBe(border);
        // Every tile on the first side ends at the cut, or before it; every
        // tile on the second starts at or after the gap, and some touch it.
        const x = d.axis === 'x';
        const end = (t: Tile): number => (x ? t.x + t.width : t.y + t.height);
        const start = (t: Tile): number => (x ? t.x : t.y);
        const first = slotsUnder(node.first).map((s) => tiles[s] as Tile);
        const second = slotsUnder(node.second).map((s) => tiles[s] as Tile);
        expect(Math.max(...first.map(end))).toBe(d.cut);
        expect(Math.min(...second.map(start))).toBe(d.cut + border);
        // The line spans the node's region across.
        const across = [...first, ...second];
        const lo = (t: Tile): number => (x ? t.y : t.x);
        const hi = (t: Tile): number => (x ? t.y + t.height : t.x + t.width);
        expect(Math.min(...across.map(lo))).toBe(d.from);
        expect(Math.max(...across.map(hi))).toBe(d.to);
      }
    }
  });

  it('maps a gap centre back to its fraction', () => {
    const plan = planLayout({
      width: 16,
      height: 9,
      count: 20,
      variation: 0.6,
      seed: 3,
    });
    for (const d of listDividers(plan, {
      width: 1600,
      height: 900,
      border: 12,
    })) {
      expect(fractionAt(d, d.cut + d.border / 2)).toBeCloseTo(d.fraction, 12);
    }
  });

  it('lists nothing for one tile or none', () => {
    for (const count of [0, 1]) {
      const plan = planLayout({
        width: 4,
        height: 3,
        count,
        variation: 0.5,
        seed: 1,
      });
      expect(listDividers(plan, { width: 400, height: 300 })).toEqual([]);
    }
  });
});

describe('moving a divider (property tests)', () => {
  const RUNS = Array.from({ length: 30 }, (_, run) => run);
  it.each(RUNS)('random plans, dividers and positions, seed %i', (run) => {
    const rnd = random(1000 + run);
    for (let i = 0; i < 25; i++) {
      const plan = randomPlan(rnd);
      const paths = pathsOf(plan);
      if (paths.length === 0) continue;
      const path = paths[Math.floor(rnd() * paths.length)] as string;
      // Anywhere, including far outside 0..1, or right at the edges.
      const wanted = [-1, 0, 1, 2, rnd(), rnd(), rnd() * 3 - 1][
        Math.floor(rnd() * 7)
      ] as number;
      const before = own(plan);
      const range = dividerRange(plan, path);
      const moved = setDividerFraction(plan, path, wanted);
      const node = nodeAt(moved, path);
      if (node.kind !== 'split') throw new Error('leaf');
      const context = `run ${String(run)}.${String(i)} ${path} -> ${String(wanted)}`;

      // Clamped to the range, which contains the current position and lies
      // strictly inside (0, 1).
      expect(range.min, context).toBeLessThanOrEqual(range.fraction);
      expect(range.max, context).toBeGreaterThanOrEqual(range.fraction);
      expect(range.min, context).toBeGreaterThan(0);
      expect(range.max, context).toBeLessThan(1);
      expect(node.fraction, context).toBe(
        Math.min(range.max, Math.max(range.min, wanted)),
      );

      // The tiles tile the canvas exactly, with no gaps or overlaps, with
      // snapping and borders of 0, 1%, 3% and 10% (as far as allowed).
      const width = 1920;
      const height = Math.round(width / plan.aspect);
      for (const b of [0, 0.01, 0.03, 0.1]) {
        const border = Math.min(
          Math.round(b * Math.min(width, height)),
          maxBorder(moved, width, height, { snap: true }),
        );
        const tiles = placeLayout(moved, {
          width,
          height,
          border,
          snap: true,
        });
        expect(
          tilingError(tiles, width, height, border, 1e-9),
          `${context} border ${String(border)}`,
        ).toBeNull();
      }

      // No tile, on either side at any depth, is smaller than the minimum,
      // or than it already was.
      const m = minTileSide(plan);
      const after = own(moved);
      for (const [slot, t] of after.entries()) {
        const b = before[slot] as Tile;
        const tol = 1 - 1e-9;
        expect(t.width, `${context} slot ${String(slot)}`).toBeGreaterThan(
          Math.min(m, b.width) * tol,
        );
        expect(t.height, `${context} slot ${String(slot)}`).toBeGreaterThan(
          Math.min(m, b.height) * tol,
        );
      }
      // A plan that met the size rule still does.
      if (checkTileSizes(plan) !== 'invalid') {
        expect(checkTileSizes(moved), context).not.toBe('invalid');
      }

      // Each side keeps its internal proportions: every tile's share of its
      // side along the axis, and its length across, are unchanged.
      const old = nodeAt(plan, path);
      if (old.kind !== 'split') throw new Error('leaf');
      const x = node.axis === 'x';
      for (const [side, f0, f1] of [
        [old.first, old.fraction, node.fraction],
        [old.second, 1 - old.fraction, 1 - node.fraction],
      ] as const) {
        for (const slot of slotsUnder(side)) {
          const b = before[slot] as Tile;
          const a = after[slot] as Tile;
          const along = (t: Tile): number => (x ? t.width : t.height);
          const across = (t: Tile): number => (x ? t.height : t.width);
          expect(along(a) / f1, context).toBeCloseTo(along(b) / f0, 9);
          expect(across(a), context).toBeCloseTo(across(b), 12);
        }
      }
      // Only that one node changed: the subtrees are the same objects.
      expect(node.first).toBe(old.first);
      expect(node.second).toBe(old.second);

      // Moving to the current position changes nothing.
      expect(setDividerFraction(plan, path, range.fraction)).toBe(plan);
      expect(setDividerFraction(moved, path, node.fraction)).toBe(moved);
    }
  });

  it('the range is tight: at each end some tile is at its limit', () => {
    const rnd = random(99);
    for (let i = 0; i < 200; i++) {
      const plan = randomPlan(rnd);
      const paths = pathsOf(plan);
      if (paths.length === 0) continue;
      const path = paths[Math.floor(rnd() * paths.length)] as string;
      const range = dividerRange(plan, path);
      const m = minTileSide(plan);
      const cap = planAspectLimit(plan.aspect, 1, plan.count);
      const before = own(plan);
      for (const end of [range.min, range.max]) {
        if (end === range.fraction) continue;
        const tiles = own(setDividerFraction(plan, path, end));
        // Some tile is at the minimum (or where it was), or at the
        // planner's aspect limit with its other side below the minimum.
        const atLimit = tiles.some((t, slot) => {
          const b = before[slot] as Tile;
          const near = (v: number, w: number): boolean =>
            Math.abs(v - w) <= 1e-9 * Math.max(1, w);
          const long = Math.max(t.width, t.height);
          const short = Math.min(t.width, t.height);
          return (
            near(t.width, Math.min(m, b.width)) ||
            near(t.height, Math.min(m, b.height)) ||
            (short < m && near(long, short * cap))
          );
        });
        expect(atLimit, `${String(i)} ${path} at ${String(end)}`).toBe(true);
      }
    }
  });

  it('never jumps on first touch, even with 300 photos', () => {
    for (const variation of [0, 0.5, 1]) {
      const plan = planLayout({
        width: 1920,
        height: 1080,
        count: 300,
        variation,
        seed: 12,
      });
      const tiles = own(plan);
      const m = minTileSide(plan);
      // The planner does make tiles below the 4% minimum here.
      if (variation === 1) {
        expect(tiles.some((t) => Math.min(t.width, t.height) < m)).toBe(true);
      }
      for (const path of pathsOf(plan)) {
        const range = dividerRange(plan, path);
        expect(range.min).toBeLessThanOrEqual(range.fraction);
        expect(range.max).toBeGreaterThanOrEqual(range.fraction);
        expect(setDividerFraction(plan, path, range.fraction)).toBe(plan);
      }
    }
  });

  it('refuses a path with no divider and a fraction that is not finite', () => {
    const plan = planLayout({
      width: 4,
      height: 3,
      count: 5,
      variation: 0.5,
      seed: 2,
    });
    expect(() => setDividerFraction(plan, '0000000', 0.5)).toThrow(RangeError);
    expect(() => setDividerFraction(plan, 'x', 0.5)).toThrow(RangeError);
    expect(() => setDividerFraction(plan, '', Number.NaN)).toThrow(RangeError);
    expect(() =>
      setDividerFraction(plan, '', Number.POSITIVE_INFINITY),
    ).toThrow(RangeError);
  });

  it('counts the tiles on each side', () => {
    const plan = planLayout({
      width: 4,
      height: 3,
      count: 9,
      variation: 0.5,
      seed: 2,
    });
    const sides = tilesBeside(plan, '');
    expect(sides.first + sides.second).toBe(9);
  });
});

describe('the size rule for stored plans', () => {
  const row = (fractions: [number, number]): LayoutPlan => ({
    aspect: 1,
    count: 3,
    variation: 0.5,
    seed: 1,
    root: {
      kind: 'split',
      axis: 'x',
      fraction: fractions[0],
      first: { kind: 'leaf', slot: 0 },
      second: {
        kind: 'split',
        axis: 'x',
        fraction: fractions[1],
        first: { kind: 'leaf', slot: 1 },
        second: { kind: 'leaf', slot: 2 },
      },
    },
  });

  it('accepts planned plans', () => {
    const rnd = random(5);
    for (let i = 0; i < 100; i++) {
      const plan = randomPlan(rnd);
      if (plan.variation === 0.5 && plan.seed === 1) continue; // random tree
      expect(checkTileSizes(plan)).toBe('planned');
    }
  });

  it('tells a stretched tile of at least the minimum from a sliver', () => {
    // 1:1 canvas, a column 10% wide (10:1) is a hand-resized tile...
    expect(checkTileSizes(row([0.1, 0.5]))).toBe('resized');
    // ... and one under 4% wide is not allowed.
    expect(checkTileSizes(row([MIN_TILE_FRACTION * 0.9, 0.5]))).toBe('invalid');
    // Three equal columns are 3:1, beyond the planner's 2.5:1.
    expect(checkTileSizes(row([1 / 3, 0.5]))).toBe('resized');
    expect(checkTileSizes(row([0.5, 0.5]))).toBe('resized');
  });

  it('lets a divider stretch tiles of at least the minimum without limit', () => {
    const plan = row([1 / 3, 0.5]);
    const moved = setDividerFraction(plan, '', 0);
    const node = moved.root as LayoutNode & { fraction: number };
    // Down to the minimum: 4% of the canvas.
    expect(node.fraction).toBeCloseTo(MIN_TILE_FRACTION, 12);
    expect(checkTileSizes(moved)).toBe('resized');
  });
});

describe('dividerAt', () => {
  // A 100 × 100 canvas: a vertical root divider at 50, and a horizontal
  // divider on each side, both at 50 (collinear), the left one with a
  // vertical divider below it (a T-junction).
  const plan: LayoutPlan = {
    aspect: 1,
    count: 5,
    variation: 0.5,
    seed: 1,
    root: {
      kind: 'split',
      axis: 'x',
      fraction: 0.5,
      first: {
        kind: 'split',
        axis: 'y',
        fraction: 0.5,
        first: { kind: 'leaf', slot: 0 },
        second: {
          kind: 'split',
          axis: 'x',
          fraction: 0.5,
          first: { kind: 'leaf', slot: 1 },
          second: { kind: 'leaf', slot: 2 },
        },
      },
      second: {
        kind: 'split',
        axis: 'y',
        fraction: 0.5,
        first: { kind: 'leaf', slot: 3 },
        second: { kind: 'leaf', slot: 4 },
      },
    },
  };
  const none = listDividers(plan, { width: 100, height: 100, snap: true });
  const gapped = listDividers(plan, {
    width: 100,
    height: 100,
    border: 4,
    snap: true,
  });
  const at = (list: Divider[], x: number, y: number, tol = 3): string | null =>
    dividerAt(list, x, y, tol)?.path ?? null;

  it('picks the divider whose band contains the point', () => {
    expect(at(none, 50, 20)).toBe('');
    expect(at(none, 52, 20)).toBe('');
    expect(at(none, 20, 49)).toBe('0');
    expect(at(none, 80, 51)).toBe('1');
    expect(at(none, 25, 80)).toBe('01');
  });

  it('picks nothing away from every band', () => {
    expect(at(none, 20, 20)).toBeNull();
    expect(at(none, 46, 20)).toBeNull();
    // Beyond a divider's ends: the lower-left vertical divider stops at 50.
    expect(at(none, 25, 30)).toBeNull();
  });

  it('with a border, the band is the gap', () => {
    const root = gapped.find((d) => d.path === '') as Divider;
    const centre = root.cut + root.border / 2;
    expect(at(gapped, centre, 20, 1)).toBe('');
    expect(at(gapped, root.cut, 20, 1)).toBe('');
    expect(at(gapped, root.cut + root.border, 20, 1)).toBe('');
    expect(at(gapped, root.cut - 1, 20, 1)).toBeNull();
    // Inside the root's gap, level with the collinear horizontal dividers,
    // only the root's band holds the point: theirs end at the gap's edges.
    const left = gapped.find((d) => d.path === '0') as Divider;
    expect(at(gapped, centre, left.cut + left.border / 2, 1)).toBe('');
  });

  it('at a T-junction the nearest centre line wins, ties to the shallowest', () => {
    // Where the lower-left vertical divider (depth 2) meets the horizontal
    // one above it (depth 1), with no border: just below the horizontal
    // line, on the vertical one.
    expect(at(none, 25, 51)).toBe('01');
    expect(at(none, 27, 51)).toBe('0');
    expect(at(none, 24, 53)).toBe('01');
    // Exactly on both lines: the shallower, which runs on through.
    expect(at(none, 25, 50)).toBe('0');
    // Where the left horizontal divider meets the root, exactly on both.
    expect(at(none, 50, 50)).toBe('');
    // Collinear dividers either side of the root, each picked on its side.
    expect(at(none, 48, 45)).toBe('');
    expect(at(none, 40, 50)).toBe('0');
    expect(at(none, 60, 50)).toBe('1');
  });
});
