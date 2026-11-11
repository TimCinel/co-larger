import { describe, expect, it } from 'vitest';
import { DEFAULT_CROP } from './crop';
import {
  countLevels,
  describeResolution,
  levelForFactor,
  LOW_FACTOR,
  resolutionWarnings,
  summaryText,
  tileResolution,
  VERY_LOW_FACTOR,
  type PhotoSize,
} from './resolution';
import {
  createEditorState,
  setBorder,
  setCanvasSize,
  setCrop,
  setPhysicalSize,
  type EditorState,
} from './state';
import { tilesFor } from './render';

describe('levelForFactor', () => {
  it('uses 1.5 and 3 as the exclusive-lower, inclusive-upper limits', () => {
    expect(LOW_FACTOR).toBe(1.5);
    expect(VERY_LOW_FACTOR).toBe(3);
    expect(levelForFactor(0.2)).toBe('ok');
    expect(levelForFactor(1)).toBe('ok');
    expect(levelForFactor(1.5)).toBe('ok');
    expect(levelForFactor(1.5000001)).toBe('low');
    expect(levelForFactor(2)).toBe('low');
    expect(levelForFactor(3)).toBe('low');
    expect(levelForFactor(3.0000001)).toBe('very-low');
    expect(levelForFactor(40)).toBe('very-low');
  });

  it('absorbs floating-point noise right at a threshold', () => {
    expect(levelForFactor(1.5 + 2e-16)).toBe('ok');
    expect(levelForFactor(3 + 4e-16)).toBe('low');
  });
});

describe('tileResolution', () => {
  const tile = (width: number, height: number) => ({ width, height });

  it('is exactly 1.5 at 1.5 pixels per original pixel, and 3 at 3', () => {
    const photo = { width: 2000, height: 1000 };
    const at15 = tileResolution(photo, tile(3000, 1500), DEFAULT_CROP);
    expect(at15?.factor).toBe(1.5);
    expect(at15?.level).toBe('ok');
    const at3 = tileResolution(photo, tile(6000, 3000), DEFAULT_CROP);
    expect(at3?.factor).toBe(3);
    expect(at3?.level).toBe('low');
    expect(tileResolution(photo, tile(6002, 3001), DEFAULT_CROP)?.level).toBe(
      'very-low',
    );
    expect(tileResolution(photo, tile(3002, 1501), DEFAULT_CROP)?.level).toBe(
      'low',
    );
  });

  it('measures the region the crop shows, not the whole photo', () => {
    // A 1000 x 1000 photo in a wide tile shows a 1000 x 500 strip.
    const wide = tileResolution(
      { width: 1000, height: 1000 },
      tile(1200, 600),
      DEFAULT_CROP,
    );
    expect(wide?.sourceWidth).toBe(1000);
    expect(wide?.sourceHeight).toBe(500);
    expect(wide?.factor).toBeCloseTo(1.2);
  });

  it('rises with the crop zoom', () => {
    const photo = { width: 3000, height: 2000 };
    const at = (zoom: number) =>
      tileResolution(photo, tile(3000, 2000), { x: 0.3, y: 0.6, zoom });
    expect([1, 1.5, 2, 3, 5].map((zoom) => at(zoom)?.factor)).toEqual([
      1, 1.5, 2, 3, 5,
    ]);
    // Exactly at the threshold despite the division: still fine.
    expect(at(1.5)?.level).toBe('ok');
    expect(at(1.51)?.level).toBe('low');
    expect(at(3)?.level).toBe('low');
    expect(at(3.01)?.level).toBe('very-low');
  });

  it('reports the effective DPI only for a physical canvas', () => {
    const photo = { width: 1000, height: 1000 };
    expect(
      tileResolution(photo, tile(2000, 2000), DEFAULT_CROP)?.effectiveDpi,
    ).toBeNull();
    const physical = tileResolution(photo, tile(2000, 2000), DEFAULT_CROP, 300);
    expect(physical?.factor).toBe(2);
    expect(physical?.effectiveDpi).toBe(150);
    // The thresholds in DPI: 200 and 100 at a canvas of 300.
    expect(
      tileResolution(photo, tile(1500, 1500), DEFAULT_CROP, 300)?.effectiveDpi,
    ).toBe(200);
    expect(
      tileResolution(photo, tile(3000, 3000), DEFAULT_CROP, 300)?.effectiveDpi,
    ).toBe(100);
  });

  it('is null for unusable sizes', () => {
    const ok = { width: 10, height: 10 };
    expect(
      tileResolution({ width: 0, height: 10 }, tile(10, 10), DEFAULT_CROP),
    ).toBeNull();
    expect(tileResolution(ok, tile(0, 10), DEFAULT_CROP)).toBeNull();
    expect(tileResolution(ok, tile(NaN, 10), DEFAULT_CROP)).toBeNull();
  });
});

function stateWith(
  sizes: Record<string, PhotoSize>,
  width: number,
  height: number,
): EditorState {
  return createEditorState({
    canvas: { width, height },
    seed: 3,
    variation: 0,
    photos: Object.entries(sizes).map(([id, s]) => ({
      id,
      aspect: s.width / s.height,
    })),
  });
}

describe('resolutionWarnings', () => {
  const sizes: Record<string, PhotoSize> = {
    big: { width: 6000, height: 4000 },
    small: { width: 1200, height: 800 },
    tiny: { width: 300, height: 200 },
  };
  const sizeOf = (id: string): PhotoSize | undefined => sizes[id];

  it('flags a small photo in a large tile and a tiny one, not a big one', () => {
    const state = stateWith(sizes, 6000, 4000);
    const found = resolutionWarnings(state, sizeOf);
    const byId = new Map(found.map((w) => [w.photoId, w]));
    expect(byId.has('big')).toBe(false);
    expect(byId.get('small')?.level).toBe('very-low');
    expect(byId.get('tiny')?.level).toBe('very-low');
    // Slot order, and every flagged tile is at its export size.
    expect(found.map((w) => w.slot)).toEqual(
      [...found.map((w) => w.slot)].sort((a, b) => a - b),
    );
    const tiles = tilesFor(state, { width: 6000, height: 4000 });
    for (const w of found) {
      const t = tiles.find((tile) => tile.slot === w.slot);
      expect([w.tileWidth, w.tileHeight]).toEqual([t?.width, t?.height]);
    }
  });

  it('gives each level at the right factor for a one-photo canvas', () => {
    const levelAt = (width: number): string | undefined =>
      resolutionWarnings(
        stateWith({ a: { width: 2000, height: 1000 } }, width, width / 2),
        () => ({
          width: 2000,
          height: 1000,
        }),
      )[0]?.level;
    expect(levelAt(2000)).toBeUndefined();
    expect(levelAt(3000)).toBeUndefined();
    expect(levelAt(3002)).toBe('low');
    expect(levelAt(6000)).toBe('low');
    expect(levelAt(6002)).toBe('very-low');
  });

  it('follows the canvas size: A4 to A2 at 300 DPI adds warnings', () => {
    const photo = { width: 3000, height: 2000 };
    const base = createEditorState({
      seed: 1,
      photos: [{ id: 'a', aspect: 1.5 }],
    });
    const a4 = setPhysicalSize(base, 297, 210, 300);
    expect(a4.canvas.width).toBe(3508);
    const warn = (s: EditorState) => resolutionWarnings(s, () => photo);
    expect(warn(a4)).toEqual([]);
    const a2 = setPhysicalSize(a4, 594, 420, 300);
    const found = warn(a2);
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('low');
    expect(found[0]?.effectiveDpi).toBeCloseTo(300 / (found[0]?.factor ?? 1));
    expect(found[0]?.effectiveDpi).toBeLessThan(200);
    expect(warn(setPhysicalSize(a2, 297, 210, 300))).toEqual([]);
  });

  it('follows the crop zoom', () => {
    const photo = { width: 3000, height: 2000 };
    const base = setCanvasSize(
      createEditorState({ seed: 1, photos: [{ id: 'a', aspect: 1.5 }] }),
      3000,
      2000,
    );
    const warn = (s: EditorState) => resolutionWarnings(s, () => photo);
    expect(warn(base)).toEqual([]);
    const zoomed = setCrop(base, 'a', { x: 0.5, y: 0.5, zoom: 2 });
    expect(warn(zoomed)[0]?.level).toBe('low');
    expect(
      warn(setCrop(zoomed, 'a', { x: 0.5, y: 0.5, zoom: 4 }))[0]?.level,
    ).toBe('very-low');
    expect(warn(setCrop(zoomed, 'a', DEFAULT_CROP))).toEqual([]);
  });

  it('uses the tile inside the border, so a border can only help', () => {
    const photo = { width: 1000, height: 1000 };
    const base = createEditorState({
      seed: 1,
      canvas: { width: 1600, height: 1600 },
      photos: [{ id: 'a', aspect: 1 }],
    });
    const none = resolutionWarnings(base, () => photo);
    expect(none[0]?.tileWidth).toBe(1600);
    expect(none[0]?.level).toBe('low');
    // Border 5% of 1600 = 80 px on each side: the tile is 1440 px, factor 1.44.
    expect(resolutionWarnings(setBorder(base, 0.05), () => photo)).toEqual([]);
    const less = resolutionWarnings(setBorder(base, 0.02), () => photo);
    expect(less[0]?.tileWidth).toBe(1536);
    expect(less[0]?.level).toBe('low');
  });

  it('skips photos of unknown size and does not mutate the state', () => {
    const state = stateWith(sizes, 6000, 4000);
    const frozen = JSON.stringify(state);
    expect(resolutionWarnings(state, () => undefined)).toEqual([]);
    resolutionWarnings(state, sizeOf);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('is empty for an empty collage', () => {
    expect(resolutionWarnings(createEditorState({ seed: 1 }), sizeOf)).toEqual(
      [],
    );
  });
});

describe('wording', () => {
  const warning = {
    slot: 0,
    photoId: 'a',
    level: 'low' as const,
    factor: 2.2,
    tileWidth: 2600,
    tileHeight: 1733,
    sourceWidth: 1200,
    sourceHeight: 800,
    effectiveDpi: 137.6,
  };

  it('explains a physical canvas in DPI and a pixel canvas by enlargement', () => {
    expect(
      describeResolution(warning, { widthMm: 297, heightMm: 210, dpi: 300 }),
    ).toBe(
      'Low resolution: this tile uses 1200 × 800 px of the photo but prints at 2600 × 1733 px, about 138 DPI at this size.',
    );
    expect(
      describeResolution({ ...warning, effectiveDpi: null }, undefined),
    ).toBe(
      'Low resolution: this tile uses 1200 × 800 px of the photo but exports at 2600 × 1733 px, so it will be enlarged 2.2×.',
    );
    expect(
      describeResolution(
        { ...warning, level: 'very-low', effectiveDpi: null, factor: 4 },
        undefined,
      ),
    ).toMatch(/^Very low resolution: .* enlarged 4×\.$/);
  });

  it('summarises, with the very low count, and says nothing for none', () => {
    const very = { ...warning, level: 'very-low' as const };
    expect(summaryText([])).toBeNull();
    expect(summaryText([warning])).toBe(
      '1 photo is low resolution for this size',
    );
    expect(summaryText([warning, warning])).toBe(
      '2 photos are low resolution for this size',
    );
    expect(summaryText([warning, very])).toBe(
      '2 photos are low resolution for this size (1 very low)',
    );
    expect(countLevels([warning, very, very])).toEqual({ low: 1, veryLow: 2 });
  });
});
