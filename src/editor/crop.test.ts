import { describe, expect, it } from 'vitest';
import {
  coverSource,
  DEFAULT_CROP,
  fitCrop,
  isDefaultCrop,
  MAX_ZOOM,
  normaliseCrop,
  panCrop,
  visibleFractions,
  zoomCropAt,
  type Crop,
  type CropGeometry,
  type SourceRect,
} from './crop';

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
          for (const zoom of [1, 1.7, 5]) {
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
    expect(normaliseCrop({ zoom: 50 }).zoom).toBe(5);
  });
});

describe('pan and zoom maths', () => {
  // A small deterministic generator, so failures reproduce.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const between = (lo: number, hi: number): number => lo + (hi - lo) * rand();
  const randomGeometry = (): CropGeometry => ({
    imageWidth: Math.exp(between(Math.log(50), Math.log(8000))),
    imageHeight: Math.exp(between(Math.log(50), Math.log(8000))),
    tileWidth: Math.exp(between(Math.log(5), Math.log(2000))),
    tileHeight: Math.exp(between(Math.log(5), Math.log(2000))),
  });
  const randomCrop = (): Crop => ({
    x: rand(),
    y: rand(),
    zoom: between(1, MAX_ZOOM),
  });
  /** The photo point (fractions) under tile point (px, py), via coverSource. */
  const photoPointAt = (
    g: CropGeometry,
    crop: Crop,
    px: number,
    py: number,
  ): { x: number; y: number } => {
    const r = coverSource(
      g.imageWidth,
      g.imageHeight,
      g.tileWidth,
      g.tileHeight,
      crop,
    ) as SourceRect;
    return {
      x: (r.sx + px * r.sw) / g.imageWidth,
      y: (r.sy + py * r.sh) / g.imageHeight,
    };
  };
  const inBounds = (g: CropGeometry, c: Crop): boolean => {
    const r = coverSource(
      g.imageWidth,
      g.imageHeight,
      g.tileWidth,
      g.tileHeight,
      c,
    ) as SourceRect;
    expectInside(r, g.imageWidth, g.imageHeight);
    return c.zoom >= 1 && c.zoom <= MAX_ZOOM;
  };

  it('keeps the grabbed point under the pointer while the edges allow', () => {
    for (let i = 0; i < 300; i++) {
      const g = randomGeometry();
      const crop = fitCrop(g, randomCrop());
      const dx = between(-0.2, 0.2) * g.tileWidth;
      const dy = between(-0.2, 0.2) * g.tileHeight;
      const next = panCrop(g, crop, dx, dy);
      // Where the pointer was: the photo point there must now be under
      // (pointer + movement), unless the edge stopped the photo.
      const px = 0.5;
      const py = 0.5;
      const grabbed = photoPointAt(g, crop, px, py);
      const after = photoPointAt(
        g,
        next,
        px + dx / g.tileWidth,
        py + dy / g.tileHeight,
      );
      const moved = next.x !== crop.x || next.y !== crop.y;
      if (!moved) continue;
      const visible = visibleFractions(g, crop.zoom) as {
        fw: number;
        fh: number;
      };
      // On an axis that was not stopped by an edge the point is exact.
      const freeX =
        next.x - crop.x === -(dx * visible.fw) / g.tileWidth ||
        Math.abs(next.x - crop.x + (dx * visible.fw) / g.tileWidth) < 1e-9;
      const freeY =
        Math.abs(next.y - crop.y + (dy * visible.fh) / g.tileHeight) < 1e-9;
      if (freeX) expect(after.x).toBeCloseTo(grabbed.x, 9);
      if (freeY) expect(after.y).toBeCloseTo(grabbed.y, 9);
    }
  });

  it('pans by exactly the pointer movement on a simple case', () => {
    const g = {
      imageWidth: 400,
      imageHeight: 400,
      tileWidth: 100,
      tileHeight: 100,
    };
    // Zoom 2: the tile shows 200 source px, so 100 tile px = 200 source px.
    const next = panCrop(g, { x: 0.5, y: 0.5, zoom: 2 }, 10, -5);
    expect(next.x).toBeCloseTo(0.5 - 0.05, 12);
    expect(next.y).toBeCloseTo(0.5 + 0.025, 12);
  });

  it('keeps the point under the pointer fixed when zooming about it', () => {
    for (let i = 0; i < 500; i++) {
      const g = randomGeometry();
      const crop = fitCrop(g, randomCrop());
      const px = rand();
      const py = rand();
      const zoom = between(1, MAX_ZOOM);
      const next = zoomCropAt(g, crop, zoom, px, py);
      expect(next.zoom).toBeCloseTo(zoom, 12);
      const before = photoPointAt(g, crop, px, py);
      const after = photoPointAt(g, next, px, py);
      // Exact unless a photo edge intervened; then the region only moved
      // inward, never outward. Check the exact case when interior.
      const vb = visibleFractions(g, crop.zoom) as { fw: number; fh: number };
      const va = visibleFractions(g, next.zoom) as { fw: number; fh: number };
      const ux = before.x - px * va.fw;
      const uy = before.y - py * va.fh;
      if (ux >= 0 && ux + va.fw <= 1) expect(after.x).toBeCloseTo(before.x, 9);
      if (uy >= 0 && uy + va.fh <= 1) expect(after.y).toBeCloseTo(before.y, 9);
      expect(vb.fw).toBeGreaterThan(0);
    }
  });

  it('always stays inside the photo and within the zoom limits', () => {
    for (let i = 0; i < 1000; i++) {
      const g = randomGeometry();
      let crop = randomCrop();
      expect(inBounds(g, fitCrop(g, crop))).toBe(true);
      crop = panCrop(g, crop, between(-5000, 5000), between(-5000, 5000));
      expect(inBounds(g, crop)).toBe(true);
      crop = zoomCropAt(
        g,
        crop,
        between(-3, 12),
        between(-1, 2),
        between(-1, 2),
      );
      expect(inBounds(g, crop)).toBe(true);
    }
  });

  it('never zooms below cover or above the limit', () => {
    const g = {
      imageWidth: 400,
      imageHeight: 300,
      tileWidth: 100,
      tileHeight: 100,
    };
    expect(zoomCropAt(g, DEFAULT_CROP, 0.1, 0.3, 0.3).zoom).toBe(1);
    expect(zoomCropAt(g, DEFAULT_CROP, 99, 0.3, 0.3).zoom).toBe(MAX_ZOOM);
  });

  it('has no dead zone: dragging back from an edge responds at once', () => {
    const g = {
      imageWidth: 400,
      imageHeight: 300,
      tileWidth: 100,
      tileHeight: 100,
    };
    let crop: Crop = { x: 0.5, y: 0.5, zoom: 2 };
    // Drag far past the left/top limit...
    crop = panCrop(g, crop, 5000, 5000);
    const atEdge = crop;
    // ...then a 1px drag back changes the crop immediately.
    const back = panCrop(g, crop, -1, -1);
    expect(back.x).toBeGreaterThan(atEdge.x);
    expect(back.y).toBeGreaterThan(atEdge.y);
    // The stored focal point is the centre of the edge-most region.
    const v = visibleFractions(g, 2) as { fw: number; fh: number };
    expect(atEdge.x).toBeCloseTo(v.fw / 2, 12);
    expect(atEdge.y).toBeCloseTo(v.fh / 2, 12);
  });

  it('fitting does not change what coverSource shows', () => {
    for (let i = 0; i < 300; i++) {
      const g = randomGeometry();
      const crop = randomCrop();
      const a = coverSource(
        g.imageWidth,
        g.imageHeight,
        g.tileWidth,
        g.tileHeight,
        crop,
      ) as SourceRect;
      const b = coverSource(
        g.imageWidth,
        g.imageHeight,
        g.tileWidth,
        g.tileHeight,
        fitCrop(g, crop),
      ) as SourceRect;
      expect(b.sx).toBeCloseTo(a.sx, 6);
      expect(b.sy).toBeCloseTo(a.sy, 6);
      expect(b.sw).toBeCloseTo(a.sw, 6);
    }
  });

  it('resetting gives the default', () => {
    expect(isDefaultCrop(DEFAULT_CROP)).toBe(true);
    const g = {
      imageWidth: 400,
      imageHeight: 300,
      tileWidth: 100,
      tileHeight: 100,
    };
    expect(isDefaultCrop(zoomCropAt(g, DEFAULT_CROP, 1, 0.2, 0.2))).toBe(true);
  });
});
