import { describe, expect, it } from 'vitest';
import { coverSource, DEFAULT_CROP } from '../editor/crop';
import { decodeSizeFor, exportFileName } from './decode-size';

describe('decodeSizeFor', () => {
  it('decodes at the original size when the tile samples it 1:1 or finer', () => {
    expect(
      decodeSizeFor(4000, 3000, { width: 4000, height: 3000 }, DEFAULT_CROP),
    ).toBeNull();
    expect(
      decodeSizeFor(800, 600, { width: 2000, height: 1500 }, DEFAULT_CROP),
    ).toBeNull();
  });

  it('shrinks a large original for a small tile, keeping the aspect', () => {
    const size = decodeSizeFor(
      6000,
      4000,
      { width: 600, height: 400 },
      DEFAULT_CROP,
    );
    expect(size).toEqual({ width: 600, height: 400 });
  });

  it('never exceeds the original and is at least what the tile samples', () => {
    for (const [w, h] of [
      [6000, 4000],
      [4000, 6000],
      [5000, 5000],
      [9000, 1500],
      [1500, 9000],
      [333, 777],
    ] as const) {
      for (const tile of [
        { width: 7, height: 5 },
        { width: 300, height: 200 },
        { width: 1234, height: 1999 },
        { width: 4961, height: 3000 },
      ]) {
        for (const crop of [
          DEFAULT_CROP,
          { x: 0.1, y: 0.9, zoom: 2.5 },
          { x: 0.5, y: 0.5, zoom: 5 },
        ]) {
          const size = decodeSizeFor(w, h, tile, crop);
          const source = coverSource(w, h, tile.width, tile.height, crop);
          if (!size) {
            // Not shrunk: the tile samples at least 1:1 or sizes are unusable.
            expect(source).not.toBeNull();
            expect(tile.width / (source?.sw ?? 1)).toBeGreaterThanOrEqual(
              1 - 1e-9,
            );
            continue;
          }
          expect(size.width).toBeLessThanOrEqual(w);
          expect(size.height).toBeLessThanOrEqual(h);
          expect(size.width).toBeGreaterThanOrEqual(1);
          expect(size.height).toBeGreaterThanOrEqual(1);
          // The visible region, at the decoded size, covers the tile.
          const scaled = coverSource(
            size.width,
            size.height,
            tile.width,
            tile.height,
            crop,
          );
          expect(scaled?.sw ?? 0).toBeGreaterThanOrEqual(tile.width - 1);
          expect(scaled?.sh ?? 0).toBeGreaterThanOrEqual(tile.height - 1);
        }
      }
    }
  });

  it('needs more of the photo for a zoomed crop than for the whole photo', () => {
    const tile = { width: 500, height: 500 };
    const whole = decodeSizeFor(6000, 6000, tile, DEFAULT_CROP);
    const zoomed = decodeSizeFor(6000, 6000, tile, { x: 0.3, y: 0.6, zoom: 4 });
    expect(whole?.width).toBe(500);
    expect(zoomed?.width).toBe(2000);
  });

  it('keeps the sampled region within a pixel of the original for an extreme crop', () => {
    const tile = { width: 40, height: 900 };
    const crop = { x: 0.8, y: 0.2, zoom: 3 };
    const size = decodeSizeFor(8000, 5000, tile, crop);
    expect(size).not.toBeNull();
    const full = coverSource(8000, 5000, tile.width, tile.height, crop);
    const small = coverSource(
      size?.width ?? 1,
      size?.height ?? 1,
      tile.width,
      tile.height,
      crop,
    );
    const k = (size?.width ?? 1) / 8000;
    expect(Math.abs((small?.sx ?? 0) - (full?.sx ?? 0) * k)).toBeLessThan(1);
    expect(Math.abs((small?.sw ?? 0) - (full?.sw ?? 0) * k)).toBeLessThan(1);
  });

  it('copes with tiny tiles and unusable sizes', () => {
    expect(
      decodeSizeFor(6000, 4000, { width: 1, height: 1 }, DEFAULT_CROP),
    ).toEqual({ width: 2, height: 1 });
    expect(
      decodeSizeFor(6000, 4000, { width: 0, height: 10 }, DEFAULT_CROP),
    ).toBeNull();
    expect(
      decodeSizeFor(0, 4000, { width: 10, height: 10 }, DEFAULT_CROP),
    ).toBeNull();
  });
});

describe('exportFileName', () => {
  it('names the file by its pixel size and format', () => {
    expect(exportFileName(4961, 7016, 'png')).toBe('collage-4961x7016.png');
    expect(exportFileName(1200, 800, 'jpeg')).toBe('collage-1200x800.jpg');
  });
});
