import { describe, expect, it } from 'vitest';
import {
  layoutMosaic,
  MAX_PLAN_ASPECT,
  maxBorder,
  maxBorderForAspect,
  placeLayout,
  planLayout,
  type LayoutNode,
  type Tile,
} from './index';
import {
  area,
  areaSpread,
  aspect,
  maxAspect,
  RATIO_PRESETS,
  tilingError,
} from './test-helpers';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);
const VARIATIONS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];

/** Timeout for the heavy property tests: a few seconds locally, slower in CI. */
const HEAVY = 60_000;

/** A canvas of the given ratio about the size of an A2 poster at 300 DPI. */
function canvas([w, h]: readonly [number, number]): {
  width: number;
  height: number;
} {
  const scale = 7016 / Math.max(w, h);
  return { width: w * scale, height: h * scale };
}

function shortSide(c: { width: number; height: number }): number {
  return Math.min(c.width, c.height);
}

describe('property tests: 1 to 200 tiles on every ratio preset', () => {
  // One plan per tile count and ratio preset (2,200 plans), cycling through
  // variations and seeds so every count, ratio, variation and seed combination
  // class is covered. Each plan is checked for everything at once.
  it(
    'tiles the canvas exactly, without slivers, at any size and border',
    () => {
      let checked = 0;
      for (let count = 1; count <= 200; count++) {
        for (const [r, ratio] of RATIO_PRESETS.entries()) {
          const c = canvas(ratio);
          const variation = VARIATIONS[
            (count + r) % VARIATIONS.length
          ] as number;
          const seed = SEEDS[(count * 11 + r) % SEEDS.length] as number;
          const plan = planLayout({ ...c, count, variation, seed });
          const label = `count ${String(count)} ratio ${ratio.join(':')} variation ${String(variation)}`;

          // Exact tiling, unsnapped, with no border, and with borders of half
          // and all of the largest border that keeps every tile within 3:1.
          const plain = placeLayout(plan, c);
          expect(
            tilingError(plain, c.width, c.height, 0, 1e-6),
            label,
          ).toBeNull();
          expect(maxAspect(plain), label).toBeLessThanOrEqual(
            MAX_PLAN_ASPECT + 1e-9,
          );
          const limit = maxBorderForAspect(plan, c.width, c.height, 3);
          expect(limit, label).toBeGreaterThan(0);
          for (const border of [limit / 2, limit]) {
            const tiles = placeLayout(plan, { ...c, border });
            expect(
              tilingError(tiles, c.width, c.height, border, 1e-6),
              label,
            ).toBeNull();
            expect(maxAspect(tiles), label).toBeLessThanOrEqual(3 + 1e-9);
          }

          // Snapped to whole pixels, at poster size and at a small preview size.
          for (const size of [
            c,
            { width: c.width / 10, height: c.height / 10 },
          ]) {
            const width = Math.round(size.width);
            const height = Math.round(size.height);
            const border = Math.min(
              2,
              maxBorder(plan, width, height, { snap: true }),
            );
            const tiles = placeLayout(plan, {
              width,
              height,
              border,
              snap: true,
            });
            for (const t of tiles) {
              expect(Number.isInteger(t.x) && Number.isInteger(t.width)).toBe(
                true,
              );
              expect(Number.isInteger(t.y) && Number.isInteger(t.height)).toBe(
                true,
              );
            }
            expect(
              Math.min(...tiles.map((t) => Math.min(t.width, t.height))),
              label,
            ).toBeGreaterThanOrEqual(1);
            expect(
              tilingError(tiles, width, height, border, 0),
              label,
            ).toBeNull();
          }
          checked++;
        }
      }
      expect(checked).toBe(200 * RATIO_PRESETS.length);
    },
    HEAVY,
  );

  it(
    'tiles exactly across variations and seeds for typical counts',
    () => {
      for (const count of [2, 3, 5, 8, 13, 30, 64, 120]) {
        for (const ratio of RATIO_PRESETS) {
          const c = canvas(ratio);
          for (const variation of VARIATIONS) {
            for (const seed of SEEDS.slice(0, 3)) {
              const border = shortSide(c) * 0.002;
              const tiles = layoutMosaic({
                ...c,
                count,
                variation,
                seed,
                border,
              });
              expect(
                tilingError(tiles, c.width, c.height, border, 1e-6),
              ).toBeNull();
            }
          }
        }
      }
    },
    HEAVY,
  );

  it('places a single tile inside the border', () => {
    const tiles = layoutMosaic({
      width: 300,
      height: 200,
      count: 1,
      variation: 1,
      seed: 3,
      border: 10,
    });
    expect(tiles).toEqual([{ slot: 0, x: 10, y: 10, width: 280, height: 180 }]);
  });

  it('returns no tiles for a count of 0', () => {
    const plan = planLayout({
      width: 1,
      height: 1,
      count: 0,
      variation: 0.5,
      seed: 1,
    });
    expect(plan.root).toBeNull();
    expect(placeLayout(plan, { width: 100, height: 100, border: 5 })).toEqual(
      [],
    );
    expect(maxBorder(plan, 100, 100)).toBe(Infinity);
  });
});

describe('determinism', () => {
  it('gives an identical layout for the same seed and inputs', () => {
    for (const count of [1, 7, 30, 200]) {
      for (const variation of [0, 0.37, 1]) {
        const options = { width: 3, height: 4, count, variation, seed: 42 };
        expect(planLayout(options)).toEqual(planLayout(options));
        expect(layoutMosaic({ ...options, border: 0.01 })).toEqual(
          layoutMosaic({ ...options, border: 0.01 }),
        );
      }
    }
  });

  it('does not depend on Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random was called');
    };
    try {
      expect(() =>
        layoutMosaic({
          width: 1,
          height: 1,
          count: 50,
          variation: 0.5,
          seed: 1,
        }),
      ).not.toThrow();
    } finally {
      Math.random = original;
    }
  });

  it('gives visibly different arrangements for different seeds', () => {
    for (const count of [5, 8, 12, 30, 120]) {
      // Rectangles are compared to the nearest quarter of a typical tile's
      // side, so small differences in size do not count as different.
      const unit = 0.25 / Math.sqrt(count);
      const key = (t: Tile) =>
        [t.x, t.y, t.width, t.height]
          .map((v) => Math.round(v / unit))
          .join(',');
      for (const variation of [0, 0.5, 1]) {
        const layouts = SEEDS.slice(0, 10).map(
          (seed) =>
            new Set(
              layoutMosaic({ width: 1, height: 1, count, variation, seed }).map(
                key,
              ),
            ),
        );
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < layouts.length; i++) {
          for (let j = i + 1; j < layouts.length; j++) {
            const a = layouts[i] ?? new Set<string>();
            const shared =
              [...(layouts[j] ?? [])].filter((k) => a.has(k)).length / count;
            // No two seeds give the same arrangement (except that with very
            // few tiles there are only a handful of good arrangements)...
            if (count >= 8) {
              expect(
                shared,
                `count ${String(count)} variation ${String(variation)}`,
              ).toBeLessThan(1);
            }
            total += shared;
            pairs++;
          }
        }
        // ...and on average they have few rectangles in common. (Five equal
        // tiles on a square share over half their rectangles on average.)
        const limit = count < 8 ? 0.7 : 0.35;
        expect(
          total / pairs,
          `count ${String(count)} variation ${String(variation)}`,
        ).toBeLessThan(limit);
      }
    }
  });
});

describe('size variation', () => {
  it('keeps tile areas within 2× of each other at variation 0 with 30 tiles', () => {
    let worst = 0;
    for (const ratio of RATIO_PRESETS) {
      for (const seed of SEEDS) {
        const tiles = layoutMosaic({
          ...canvas(ratio),
          count: 30,
          variation: 0,
          seed,
        });
        worst = Math.max(worst, areaSpread(tiles));
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it(
    'keeps tile areas within about 2× at variation 0 for any count',
    () => {
      for (let count = 1; count <= 200; count++) {
        for (const [r, ratio] of RATIO_PRESETS.entries()) {
          if ((count + r) % 3 !== 0) continue;
          const tiles = layoutMosaic({
            ...canvas(ratio),
            count,
            variation: 0,
            seed: count,
          });
          expect(
            areaSpread(tiles),
            `count ${String(count)}`,
          ).toBeLessThanOrEqual(2);
        }
      }
    },
    HEAVY,
  );

  it('makes the largest tile at least 15× the smallest at variation 1 with 30 tiles', () => {
    let worst = Infinity;
    for (const ratio of RATIO_PRESETS) {
      for (const seed of SEEDS) {
        const tiles = layoutMosaic({
          ...canvas(ratio),
          count: 30,
          variation: 1,
          seed,
        });
        worst = Math.min(worst, areaSpread(tiles));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(15);
  });

  it('has a few very large tiles and many small ones at variation 1', () => {
    for (const ratio of RATIO_PRESETS) {
      for (const seed of SEEDS.slice(0, 10)) {
        const tiles = layoutMosaic({
          ...canvas(ratio),
          count: 30,
          variation: 1,
          seed,
        });
        const areas = tiles.map(area).sort((a, b) => b - a);
        const total = areas.reduce((a, b) => a + b, 0);
        const median = areas[15] ?? 0;
        // The top three cover over a third of the canvas...
        expect(
          ((areas[0] ?? 0) + (areas[1] ?? 0) + (areas[2] ?? 0)) / total,
        ).toBeGreaterThan(1 / 3);
        // ...and the largest is many times a typical tile.
        expect((areas[0] ?? 0) / median).toBeGreaterThan(5);
      }
    }
  });

  it(
    'grows the area spread monotonically with the dial, on average over seeds',
    () => {
      // The geometric mean of largest/smallest over seeds, in dial steps of
      // 0.05 for 30 tiles on every preset, and 0.1 for 10 and 100 tiles. (For
      // small counts the first 0.05 is flat: shape compromises at variation 0
      // already spread areas by about 1.3×, as much as the dial adds there.)
      const cases = [
        ...RATIO_PRESETS.map((ratio) => ({ count: 30, ratio, step: 0.05 })),
        ...[RATIO_PRESETS[0], RATIO_PRESETS[3], RATIO_PRESETS[10]].flatMap(
          (ratio) =>
            ratio
              ? [10, 100].map((count) => ({ count, ratio, step: 0.1 }))
              : [],
        ),
      ];
      for (const { count, ratio, step } of cases) {
        const dials = Array.from(
          { length: Math.round(1 / step) + 1 },
          (_, i) => i * step,
        );
        const seeds = SEEDS.slice(0, 20);
        const means = dials.map((variation) => {
          let sum = 0;
          for (const seed of seeds) {
            sum += Math.log(
              areaSpread(
                layoutMosaic({ ...canvas(ratio), count, variation, seed }),
              ),
            );
          }
          return sum / seeds.length;
        });
        for (let i = 1; i < means.length; i++) {
          expect(
            means[i],
            `count ${String(count)} ratio ${ratio.join(':')} dial ${String(dials[i])}`,
          ).toBeGreaterThan(means[i - 1] as number);
        }
      }
    },
    HEAVY,
  );
});

describe('tile shapes', () => {
  it('keeps every tile within 3:1 in whole pixels up to the snapped limit', () => {
    for (const count of [30, 100, 200]) {
      for (const ratio of RATIO_PRESETS) {
        for (const seed of SEEDS.slice(0, 5)) {
          const c = canvas(ratio);
          const plan = planLayout({ ...c, count, variation: 1, seed });
          const width = Math.round(c.width);
          const height = Math.round(c.height);
          const border = maxBorderForAspect(plan, width, height, 3, {
            snap: true,
          });
          // At poster size the snapped limit is still a usable border.
          expect(border).toBeGreaterThanOrEqual(count > 100 ? 10 : 20);
          const tiles = placeLayout(plan, {
            width,
            height,
            border,
            snap: true,
          });
          expect(maxAspect(tiles)).toBeLessThanOrEqual(3);
          expect(tilingError(tiles, width, height, border, 0)).toBeNull();
        }
      }
    }
  });

  /** Shares of portrait and landscape tiles (square within 10% excluded). */
  function orientationMix(ratio: readonly [number, number], variation: number) {
    let portrait = 0;
    let landscape = 0;
    let total = 0;
    for (const seed of SEEDS.slice(0, 20)) {
      for (const t of layoutMosaic({
        ...canvas(ratio),
        count: 30,
        variation,
        seed,
      })) {
        total++;
        if (aspect(t) < 1.1) continue;
        if (t.height > t.width) portrait++;
        else landscape++;
      }
    }
    return { portrait: portrait / total, landscape: landscape / total };
  }

  it('makes a healthy mix of portrait and landscape slots from dial 0.5 up', () => {
    for (const ratio of RATIO_PRESETS) {
      for (const variation of [0.5, 1]) {
        const mix = orientationMix(ratio, variation);
        const label = `${ratio.join(':')} variation ${String(variation)}`;
        expect(mix.portrait, label).toBeGreaterThan(0.3);
        expect(mix.landscape, label).toBeGreaterThan(0.3);
      }
    }
  });

  it('makes some of each orientation at dial 0 on every preset', () => {
    // At dial 0 equal tiles lean towards the canvas's own orientation: the
    // minority orientation is only 7-15% of tiles on 3:4, 4:3, 4:5 and 5:4
    // (and 25-50% on the other presets). See the PR for why this is left.
    for (const ratio of RATIO_PRESETS) {
      const mix = orientationMix(ratio, 0);
      expect(mix.portrait, ratio.join(':')).toBeGreaterThan(0.05);
      expect(mix.landscape, ratio.join(':')).toBeGreaterThan(0.05);
    }
  });

  it('puts the largest tile anywhere: spread evenly over the quadrants', () => {
    // A big tile often spans the full width or height, so its centre lies
    // exactly on the midline; those count as neither side.
    const quadrants = { TL: 0, TR: 0, BL: 0, BR: 0 };
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    for (const [w, h] of [
      [1, 1],
      [3, 4],
      [16, 9],
    ] as const) {
      for (let i = 0; i < 100; i++) {
        for (const count of [10, 30]) {
          const tiles = layoutMosaic({
            width: w,
            height: h,
            count,
            variation: 1,
            seed: 1_000_003 + i * 104_729,
          });
          const big = tiles.reduce((a, b) => (area(b) > area(a) ? b : a));
          const dx = (big.x + big.width / 2) / w - 0.5;
          const dy = (big.y + big.height / 2) / h - 0.5;
          const e = 1e-9;
          if (dx < -e) left++;
          if (dx > e) right++;
          if (dy < -e) top++;
          if (dy > e) bottom++;
          if (Math.abs(dx) > e && Math.abs(dy) > e) {
            quadrants[`${dy < 0 ? 'T' : 'B'}${dx < 0 ? 'L' : 'R'}`]++;
          }
        }
      }
    }
    expect(left / (left + right)).toBeGreaterThan(0.4);
    expect(left / (left + right)).toBeLessThan(0.6);
    expect(top / (top + bottom)).toBeGreaterThan(0.4);
    expect(top / (top + bottom)).toBeLessThan(0.6);
    const total = Object.values(quadrants).reduce((a, b) => a + b, 0);
    for (const [quadrant, n] of Object.entries(quadrants)) {
      expect(n / total, quadrant).toBeGreaterThan(0.18);
      expect(n / total, quadrant).toBeLessThan(0.32);
    }
  });
});

describe('resolution independence and borders', () => {
  const plan = planLayout({
    width: 4961,
    height: 7016,
    count: 120,
    variation: 0.7,
    seed: 9,
  });

  it('scales exactly: the same plan at another size is the same picture scaled', () => {
    const big = placeLayout(plan, { width: 4961, height: 7016, border: 12 });
    const small = placeLayout(plan, {
      width: 496.1,
      height: 701.6,
      border: 1.2,
    });
    for (const [i, t] of big.entries()) {
      const s = small[i] as Tile;
      expect(s.x * 10).toBeCloseTo(t.x, 6);
      expect(s.y * 10).toBeCloseTo(t.y, 6);
      expect(s.width * 10).toBeCloseTo(t.width, 6);
      expect(s.height * 10).toBeCloseTo(t.height, 6);
    }
  });

  it('plans the same arrangement for any canvas size with the same ratio', () => {
    const a = planLayout({
      width: 4961 * 2,
      height: 7016 * 2,
      count: 120,
      variation: 0.7,
      seed: 9,
    });
    expect(a.root).toEqual(plan.root);
  });

  it('keeps every snapped edge within half a pixel of the exact edge', () => {
    for (const scale of [0.05, 0.1, 0.37, 1]) {
      const width = Math.round(4961 * scale);
      const height = Math.round(7016 * scale);
      const border = Math.round(12 * scale);
      const exact = placeLayout(plan, { width, height, border });
      const snapped = placeLayout(plan, { width, height, border, snap: true });
      for (const [i, e] of exact.entries()) {
        const s = snapped[i] as Tile;
        expect(Math.abs(s.x - e.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(s.y - e.y)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(s.x + s.width - (e.x + e.width))).toBeLessThanOrEqual(
          0.5,
        );
        expect(Math.abs(s.y + s.height - (e.y + e.height))).toBeLessThanOrEqual(
          0.5,
        );
      }
      expect(tilingError(snapped, width, height, border, 0)).toBeNull();
    }
  });

  it('does not change the arrangement when the border changes', () => {
    // Tiles that touch with no border sit exactly one border apart with one,
    // and nearly all still face each other. (Two cuts in different branches
    // of the tree can line up by chance with no border; each subtracts its
    // own gaps, so with a border they part slightly, and tiles that only
    // just touched past such a line can stop facing. Only the gaps change.)
    const none = placeLayout(plan, { width: 4961, height: 7016 });
    let neighbours = 0;
    let stillFacing = 0;
    for (const border of [5, 20, 40]) {
      const bordered = placeLayout(plan, { width: 4961, height: 7016, border });
      for (const [i, a] of none.entries()) {
        for (const [j, b] of none.entries()) {
          const p = bordered[i] as Tile;
          const q = bordered[j] as Tile;
          const facingX =
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >
            1e-6;
          const facingY =
            Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-6;
          if (facingX && Math.abs(a.x + a.width - b.x) < 1e-6) {
            neighbours++;
            expect(q.x - (p.x + p.width)).toBeCloseTo(border, 6);
            if (
              Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y) >
              0
            )
              stillFacing++;
          }
          if (facingY && Math.abs(a.y + a.height - b.y) < 1e-6) {
            neighbours++;
            expect(q.y - (p.y + p.height)).toBeCloseTo(border, 6);
            if (Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x) > 0)
              stillFacing++;
          }
        }
      }
    }
    expect(neighbours).toBeGreaterThan(3 * 120);
    expect(stillFacing / neighbours).toBeGreaterThan(0.95);
  });

  it('reports the largest usable border and rejects borders beyond it', () => {
    const limit = maxBorder(plan, 1000, 1414, { minTileSize: 0 });
    expect(limit).toBeGreaterThan(0);
    const tiles = placeLayout(plan, {
      width: 1000,
      height: 1414,
      border: limit * 0.999,
    });
    const smallest = Math.min(...tiles.map((t) => Math.min(t.width, t.height)));
    expect(smallest).toBeGreaterThan(0);
    expect(smallest).toBeLessThan(limit * 0.01);
    expect(() =>
      placeLayout(plan, { width: 1000, height: 1414, border: limit }),
    ).toThrow(RangeError);
    // The default keeps every tile at least one unit across.
    const safe = maxBorder(plan, 1000, 1414);
    const atSafe = placeLayout(plan, {
      width: 1000,
      height: 1414,
      border: safe,
    });
    expect(
      Math.min(...atSafe.map((t) => Math.min(t.width, t.height))),
    ).toBeCloseTo(1, 6);
  });
});

describe('dial continuity', () => {
  /** The furthest any tile edge moves, as a fraction of the canvas side. */
  function maxMove(a: readonly Tile[], b: readonly Tile[]): number {
    let worst = 0;
    for (const [i, t] of a.entries()) {
      const u = b[i] as Tile;
      worst = Math.max(
        worst,
        Math.abs(t.x - u.x),
        Math.abs(t.y - u.y),
        Math.abs(t.x + t.width - u.x - u.width),
        Math.abs(t.y + t.height - u.y - u.height),
      );
    }
    return worst;
  }

  it('changes the layout gradually between structure steps', () => {
    // The structure is chosen at the nearest tenth of the dial, so 0.31 to
    // 0.34 stays on one structure while the tiles grow and shrink.
    for (const count of [30, 120]) {
      for (const seed of SEEDS.slice(0, 10)) {
        const options = { width: 1, height: 1, count, seed };
        let previous = layoutMosaic({ ...options, variation: 0.31 });
        for (const variation of [0.32, 0.33, 0.34]) {
          const next = layoutMosaic({ ...options, variation });
          expect(maxMove(previous, next)).toBeLessThan(0.05);
          previous = next;
        }
      }
    }
  });

  it('keeps slot identity: a slot that grows with the dial keeps growing', () => {
    const at = (variation: number) =>
      layoutMosaic({ width: 1, height: 1, count: 30, variation, seed: 5 });
    const low = at(0);
    const high = at(1);
    const biggest = high.reduce((a, b) => (area(b) > area(a) ? b : a));
    expect(area(biggest)).toBeGreaterThan(area(low[biggest.slot] as Tile) * 3);
  });
});

describe('performance', () => {
  it('plans and places a 200-tile layout in under 100 ms', () => {
    // Noise only adds time: take each preset's minimum of 5 runs after a
    // warm-up, so a shared CI runner cannot flake it but a real slowdown fails.
    const time = (ratio: readonly [number, number], i: number): number => {
      const started = performance.now();
      layoutMosaic({
        ...canvas(ratio),
        count: 200,
        variation: i / 10,
        seed: i,
        border: 10,
      });
      return performance.now() - started;
    };
    time([1, 1], 0);
    let worst = 0;
    for (const [i, ratio] of RATIO_PRESETS.entries()) {
      const best = Math.min(...Array.from({ length: 5 }, () => time(ratio, i)));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(100);
  });
});

describe('input validation', () => {
  it('rejects bad inputs', () => {
    const ok = { width: 1, height: 1, count: 3, variation: 0.5, seed: 1 };
    expect(() => planLayout({ ...ok, width: 0 })).toThrow(RangeError);
    expect(() => planLayout({ ...ok, height: Number.NaN })).toThrow(RangeError);
    expect(() => planLayout({ ...ok, count: 1.5 })).toThrow(RangeError);
    expect(() => planLayout({ ...ok, count: -1 })).toThrow(RangeError);
    expect(() => planLayout({ ...ok, variation: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => planLayout({ ...ok, seed: Infinity })).toThrow(RangeError);
    const plan = planLayout(ok);
    expect(() =>
      placeLayout(plan, { width: 10, height: 10, border: -1 }),
    ).toThrow(RangeError);
  });

  it('clamps the variation to 0..1', () => {
    const base = { width: 1, height: 1, count: 20, seed: 1 };
    expect(planLayout({ ...base, variation: 3 }).root).toEqual(
      planLayout({ ...base, variation: 1 }).root,
    );
    expect(planLayout({ ...base, variation: -1 }).root).toEqual(
      planLayout({ ...base, variation: 0 }).root,
    );
  });

  it('produces a plan that survives a JSON round trip', () => {
    const plan = planLayout({
      width: 4,
      height: 3,
      count: 40,
      variation: 0.8,
      seed: 77,
    });
    const copy = JSON.parse(JSON.stringify(plan)) as typeof plan;
    expect(placeLayout(copy, { width: 400, height: 300 })).toEqual(
      placeLayout(plan, { width: 400, height: 300 }),
    );
    const slots: number[] = [];
    const walk = (n: LayoutNode): void => {
      if (n.kind === 'leaf') slots.push(n.slot);
      else {
        walk(n.first);
        walk(n.second);
      }
    };
    if (plan.root) walk(plan.root);
    expect(slots.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
  });
});
