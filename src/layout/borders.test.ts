import { describe, expect, it } from 'vitest';
import {
  layoutMosaic,
  MAX_PLAN_ASPECT,
  maxBorder,
  maxBorderForAspect,
  placeLayout,
  planAspectLimit,
  planLayout,
} from './index';
import { maxAspect, RATIO_PRESETS, tilingError } from './test-helpers';

const SEEDS = [1, 2, 3, 7919, 15838];

describe('extreme canvas shapes', () => {
  it('never throws, and does the best possible, on long thin canvases', () => {
    // Aspects from square to 10,000:1, both ways round, with few and many
    // tiles. Once the canvas is more than MAX_PLAN_ASPECT times the count
    // long, even a row of equal tiles is more stretched than that, so the
    // limit rises to exactly what the canvas forces.
    for (const long of [1, 2.5, 5, 7.016, 12, 30, 100, 1000, 10_000]) {
      for (const count of [1, 2, 3, 4, 7, 12, 50, 200]) {
        for (const variation of [0, 0.5, 1]) {
          for (const [width, height] of [
            [long * 1000, 1000],
            [1000, long * 1000],
          ] as const) {
            const label = `${String(width)}×${String(height)} count ${String(count)}`;
            const plan = planLayout({
              width,
              height,
              count,
              variation,
              seed: 1,
            });
            const tiles = placeLayout(plan, { width, height });
            expect(
              tilingError(tiles, width, height, 0, 1e-6),
              label,
            ).toBeNull();
            const limit = planAspectLimit(width, height, count);
            expect(limit).toBe(Math.max(MAX_PLAN_ASPECT, long / count));
            expect(maxAspect(tiles), label).toBeLessThanOrEqual(
              limit * (1 + 1e-9),
            );
          }
        }
      }
    }
  });

  it('handles the custom sizes that used to crash', () => {
    for (const [width, height, count] of [
      [6000, 1000, 2],
      [1200, 100, 4],
      [7016, 1000, 2],
      [1500, 300, 2],
      [3000, 1000, 1],
    ] as const) {
      const tiles = layoutMosaic({
        width,
        height,
        count,
        variation: 0.5,
        seed: 1,
      });
      expect(tiles).toHaveLength(count);
      expect(tilingError(tiles, width, height, 0, 1e-6)).toBeNull();
      expect(maxAspect(tiles)).toBeLessThanOrEqual(
        planAspectLimit(width, height, count) * (1 + 1e-9),
      );
    }
  });
});

describe('maxBorder', () => {
  it('is safe when snapping: no tile under one pixel at any border it allows', () => {
    // The case from review: the old unsnapped limit was 7.63, and a border
    // of 7 gave a tile 0 px tall once snapped.
    const plan = planLayout({
      width: 1,
      height: 1,
      count: 30,
      variation: 1,
      seed: 2,
    });
    const limit = maxBorder(plan, 100, 100, { snap: true });
    expect(Number.isInteger(limit)).toBe(true);
    for (let border = 0; border <= limit; border++) {
      const tiles = placeLayout(plan, {
        width: 100,
        height: 100,
        border,
        snap: true,
      });
      expect(
        Math.min(...tiles.map((t) => Math.min(t.width, t.height))),
      ).toBeGreaterThanOrEqual(1);
      expect(tilingError(tiles, 100, 100, border, 0)).toBeNull();
    }
    expect(() =>
      placeLayout(plan, {
        width: 100,
        height: 100,
        border: limit + 1,
        snap: true,
      }),
    ).toThrow(RangeError);
  });

  it('holds across sizes, counts and a requested minimum tile size', () => {
    for (const count of [5, 30, 120]) {
      for (const [r, ratio] of RATIO_PRESETS.entries()) {
        const plan = planLayout({
          width: ratio[0],
          height: ratio[1],
          count,
          variation: (r % 3) / 2,
          seed: SEEDS[r % SEEDS.length] as number,
        });
        for (const long of [300, 1000, 7016]) {
          const scale = long / Math.max(...ratio);
          const width = Math.round(ratio[0] * scale);
          const height = Math.round(ratio[1] * scale);
          for (const minTileSize of [1, 5]) {
            const limit = maxBorder(plan, width, height, {
              snap: true,
              minTileSize,
            });
            for (const border of [0, Math.floor(limit / 2), limit]) {
              const tiles = placeLayout(plan, {
                width,
                height,
                border,
                snap: true,
              });
              const smallest = Math.min(
                ...tiles.map((t) => Math.min(t.width, t.height)),
              );
              if (limit > 0)
                expect(smallest).toBeGreaterThanOrEqual(minTileSize);
              expect(tilingError(tiles, width, height, border, 0)).toBeNull();
            }
          }
        }
      }
    }
  });
});

describe('maxBorderForAspect', () => {
  it('keeps every tile within the limit at any border up to it, and is tight', () => {
    let tight = 0;
    let cases = 0;
    for (const count of [2, 10, 30, 60, 120, 200]) {
      for (const [r, ratio] of RATIO_PRESETS.entries()) {
        for (const variation of [0, 0.5, 1]) {
          const scale = 7016 / Math.max(...ratio);
          const width = ratio[0] * scale;
          const height = ratio[1] * scale;
          const plan = planLayout({
            width,
            height,
            count,
            variation,
            seed: SEEDS[(count + r) % SEEDS.length] as number,
          });
          for (const maxAspectLimit of [3, 4]) {
            const limit = maxBorderForAspect(
              plan,
              width,
              height,
              maxAspectLimit,
            );
            expect(limit).toBeGreaterThan(0);
            for (let i = 0; i <= 10; i++) {
              const border = (limit * i) / 10;
              const tiles = placeLayout(plan, { width, height, border });
              expect(maxAspect(tiles)).toBeLessThanOrEqual(
                maxAspectLimit + 1e-9,
              );
            }
            // Tight: just past the limit, some tile is past the aspect limit
            // (unless the limit was set by tiles running out of room).
            if (limit < maxBorder(plan, width, height, { minTileSize: 0 })) {
              const past = placeLayout(plan, {
                width,
                height,
                border: limit * 1.001,
              });
              if (maxAspect(past) > maxAspectLimit) tight++;
              cases++;
            }
          }
        }
      }
    }
    expect(tight).toBe(cases);
  }, 60_000);

  it('gives borders an editor can use: 3:1 limit as a share of the short side', () => {
    // On an A2 poster the 3:1 limit is a usable border even at 200 tiles.
    for (const count of [30, 200]) {
      for (const ratio of RATIO_PRESETS) {
        const scale = 7016 / Math.max(...ratio);
        const width = ratio[0] * scale;
        const height = ratio[1] * scale;
        for (const seed of SEEDS) {
          const plan = planLayout({ width, height, count, variation: 1, seed });
          const share =
            maxBorderForAspect(plan, width, height, 3) /
            Math.min(width, height);
          expect(share).toBeGreaterThan(count > 100 ? 0.004 : 0.01);
        }
      }
    }
  });

  it('allows for snapping', () => {
    for (const count of [30, 120]) {
      for (const ratio of RATIO_PRESETS) {
        for (const long of [1000, 7016]) {
          const scale = long / Math.max(...ratio);
          const width = Math.round(ratio[0] * scale);
          const height = Math.round(ratio[1] * scale);
          const plan = planLayout({
            width,
            height,
            count,
            variation: 1,
            seed: 3,
          });
          const limit = maxBorderForAspect(plan, width, height, 3, {
            snap: true,
          });
          expect(Number.isInteger(limit)).toBe(true);
          for (const border of [0, Math.floor(limit / 2), limit]) {
            if (limit === 0 && border > 0) continue;
            const tiles = placeLayout(plan, {
              width,
              height,
              border,
              snap: true,
            });
            if (limit > 0) expect(maxAspect(tiles)).toBeLessThanOrEqual(3);
          }
        }
      }
    }
  });

  it('returns 0 when no border can meet the limit, and Infinity when empty', () => {
    const plan = planLayout({
      width: 6000,
      height: 1000,
      count: 2,
      variation: 0,
      seed: 1,
    });
    expect(maxBorderForAspect(plan, 6000, 1000, 2.5)).toBe(0);
    const empty = planLayout({
      width: 1,
      height: 1,
      count: 0,
      variation: 0,
      seed: 1,
    });
    expect(maxBorderForAspect(empty, 100, 100)).toBe(Infinity);
    expect(maxBorder(empty, 100, 100)).toBe(Infinity);
    expect(() => maxBorderForAspect(plan, 6000, 1000, 0.5)).toThrow(RangeError);
  });
});

describe('placeLayout input checks', () => {
  const plan = planLayout({
    width: 4,
    height: 3,
    count: 12,
    variation: 0.5,
    seed: 1,
  });

  it('refuses a canvas of a different ratio, but allows pixel rounding', () => {
    expect(() => placeLayout(plan, { width: 400, height: 400 })).toThrow(
      RangeError,
    );
    expect(() => placeLayout(plan, { width: 401, height: 300 })).not.toThrow();
  });

  it('rejects bad sizes and borders', () => {
    for (const options of [
      { width: 0, height: 3 },
      { width: Infinity, height: 3 },
      { width: 4, height: Number.NaN },
      { width: 4, height: 3, border: -1 },
      { width: 4, height: 3, border: Number.NaN },
      { width: 4, height: 3, border: Infinity },
      { width: 0.4, height: 0.3, snap: true },
    ]) {
      expect(() => placeLayout(plan, options), JSON.stringify(options)).toThrow(
        RangeError,
      );
    }
  });

  it('rejects malformed plans', () => {
    expect(() =>
      placeLayout({ ...plan, root: null }, { width: 4, height: 3 }),
    ).toThrow(TypeError);
  });
});
