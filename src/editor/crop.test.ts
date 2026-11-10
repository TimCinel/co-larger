import { describe, expect, it } from 'vitest';
import { coverSource, normaliseCrop, type SourceRect } from './crop';

function expectInside(rect: SourceRect, width: number, height: number): void {
  const eps = 1e-9;
  expect(rect.sx).toBeGreaterThanOrEqual(-eps);
  expect(rect.sy).toBeGreaterThanOrEqual(-eps);
  expect(rect.sx + rect.sw).toBeLessThanOrEqual(width + eps);
  expect(rect.sy + rect.sh).toBeLessThanOrEqual(height + eps);
}

describe('coverSource', () => {
  it('crops the sides of a wide photo in a square tile, centred', () => {
    expect(coverSource(400, 300, 100, 100)).toEqual({
      sx: 50,
      sy: 0,
      sw: 300,
      sh: 300,
    });
  });

  it('crops the top and bottom of a tall photo in a wide tile', () => {
    expect(coverSource(300, 400, 200, 100)).toEqual({
      sx: 0,
      sy: 125,
      sw: 300,
      sh: 150,
    });
  });

  it('uses the whole photo when the shapes match', () => {
    expect(coverSource(800, 600, 40, 30)).toEqual({
      sx: 0,
      sy: 0,
      sw: 800,
      sh: 600,
    });
  });

  it('zooms around the focal point', () => {
    expect(coverSource(400, 400, 10, 10, { x: 0.5, y: 0.5, zoom: 2 })).toEqual({
      sx: 100,
      sy: 100,
      sw: 200,
      sh: 200,
    });
    expect(
      coverSource(400, 400, 10, 10, { x: 0.25, y: 0.75, zoom: 4 }),
    ).toEqual({ sx: 50, sy: 250, sw: 100, sh: 100 });
  });

  it('moves the region back inside the photo rather than show empty space', () => {
    expect(coverSource(400, 300, 100, 100, { x: 0, y: 0, zoom: 1 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 300,
      sh: 300,
    });
    expect(coverSource(400, 300, 100, 100, { x: 1, y: 1, zoom: 2 })).toEqual({
      sx: 250,
      sy: 150,
      sw: 150,
      sh: 150,
    });
  });

  it('never zooms out below cover', () => {
    expect(
      coverSource(400, 300, 100, 100, { x: 0.5, y: 0.5, zoom: 0.25 }),
    ).toEqual(coverSource(400, 300, 100, 100));
  });

  it('always has the tile shape and stays inside the photo', () => {
    // A deterministic sweep over extreme shapes, focal points and zooms.
    const sizes = [
      [4000, 3000],
      [3000, 4000],
      [10000, 300],
      [300, 10000],
      [1, 1],
      [1024, 1],
    ] as const;
    const tiles = [
      [100, 100],
      [500, 20],
      [20, 500],
      [1, 1],
      [333.3, 77.7],
    ] as const;
    for (const [w, h] of sizes) {
      for (const [tw, th] of tiles) {
        for (const x of [0, 0.13, 0.5, 0.97, 1]) {
          for (const zoom of [1, 1.7, 10]) {
            const rect = coverSource(w, h, tw, th, { x, y: 1 - x, zoom });
            expect(rect).not.toBeNull();
            const r = rect as SourceRect;
            expectInside(r, w, h);
            expect(r.sw / r.sh).toBeCloseTo(tw / th, 9);
            // At zoom 1 one side spans the whole photo (cover, not smaller).
            if (zoom === 1) {
              expect(
                Math.abs(r.sw - w) < 1e-9 || Math.abs(r.sh - h) < 1e-9,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('selects the same part of the photo at any resolution', () => {
    const crop = { x: 0.3, y: 0.6, zoom: 1.8 };
    const small = coverSource(256, 192, 140, 60, crop) as SourceRect;
    const large = coverSource(4096, 3072, 140, 60, crop) as SourceRect;
    expect(large.sx / 4096).toBeCloseTo(small.sx / 256, 12);
    expect(large.sy / 3072).toBeCloseTo(small.sy / 192, 12);
    expect(large.sw / 4096).toBeCloseTo(small.sw / 256, 12);
    expect(large.sh / 3072).toBeCloseTo(small.sh / 192, 12);
  });

  it('returns null for empty or invalid sizes', () => {
    expect(coverSource(0, 10, 10, 10)).toBeNull();
    expect(coverSource(10, 10, 0, 10)).toBeNull();
    expect(coverSource(10, 10, 10, Number.NaN)).toBeNull();
    expect(coverSource(10, Infinity, 10, 10)).toBeNull();
  });
});

describe('normaliseCrop', () => {
  it('clamps and fills in defaults', () => {
    expect(normaliseCrop({})).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
    expect(normaliseCrop({ x: -3, y: 9, zoom: 0 })).toEqual({
      x: 0,
      y: 1,
      zoom: 1,
    });
    expect(normaliseCrop({ x: Number.NaN, zoom: Infinity })).toEqual({
      x: 0.5,
      y: 0.5,
      zoom: 1,
    });
    expect(normaliseCrop({ zoom: 50 }).zoom).toBe(10);
  });
});
