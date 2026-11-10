import { describe, expect, it } from 'vitest';
import {
  checkPhysical,
  DEFAULT_DPI,
  formatMm,
  MAX_DPI,
  mmFromPixels,
  physicalFor,
  pixelSizeOf,
  pixelsFromMm,
  roundMm,
  samePhysical,
} from './physical';
import { PAPER_PRESETS, paperLabel } from './canvas-settings';

describe('mm, DPI and pixels', () => {
  it('rounds to the nearest whole pixel', () => {
    expect(pixelsFromMm(25.4, 300)).toBe(300);
    expect(pixelsFromMm(210, 300)).toBe(2480);
    expect(pixelsFromMm(297, 300)).toBe(3508);
    expect(pixelsFromMm(420, 300)).toBe(4961);
    expect(pixelsFromMm(594, 300)).toBe(7016);
    expect(pixelsFromMm(0.01, 300)).toBe(0);
  });

  it('gives the exact A-series sizes of the issue at 300 DPI', () => {
    const find = (name: string): (typeof PAPER_PRESETS)[number] => {
      const p = PAPER_PRESETS.find((x) => paperLabel(x) === name);
      if (!p) throw new Error(name);
      return p;
    };
    const size = (name: string): string => {
      const p = find(name);
      const s = pixelSizeOf({
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        dpi: 300,
      });
      return `${String(s.width)}x${String(s.height)}`;
    };
    expect(size('A2 portrait')).toBe('4961x7016');
    expect(size('A3 landscape')).toBe('4961x3508');
    expect(size('A4 portrait')).toBe('2480x3508');
  });

  it('gives the A-series sizes at 72, 150, 300 and 600 DPI', () => {
    const expected: Record<string, Record<number, string>> = {
      'A4 portrait': {
        72: '595x842',
        150: '1240x1754',
        300: '2480x3508',
        600: '4961x7016',
      },
      'A3 portrait': {
        72: '842x1191',
        150: '1754x2480',
        300: '3508x4961',
        600: '7016x9921',
      },
      'A2 portrait': {
        72: '1191x1684',
        150: '2480x3508',
        300: '4961x7016',
        600: '9921x14031',
      },
    };
    for (const [name, byDpi] of Object.entries(expected)) {
      const p = PAPER_PRESETS.find((x) => paperLabel(x) === name);
      if (!p) throw new Error(name);
      for (const [dpi, px] of Object.entries(byDpi)) {
        const s = pixelSizeOf({
          widthMm: p.widthMm,
          heightMm: p.heightMm,
          dpi: Number(dpi),
        });
        expect(`${String(s.width)}x${String(s.height)}`, `${name} ${dpi}`).toBe(
          px,
        );
      }
    }
  });

  it('lists A4, A3 and A2, portrait then landscape, with ISO sizes', () => {
    expect(
      PAPER_PRESETS.map(
        (p) => `${paperLabel(p)} ${String(p.widthMm)}x${String(p.heightMm)}`,
      ),
    ).toEqual([
      'A4 portrait 210x297',
      'A4 landscape 297x210',
      'A3 portrait 297x420',
      'A3 landscape 420x297',
      'A2 portrait 420x594',
      'A2 landscape 594x420',
    ]);
  });

  it('converting pixels to mm and back never changes the pixels', () => {
    for (const dpi of [1, 72, 96, 150, 300, 600, 1200, MAX_DPI]) {
      for (const px of [1, 2, 3, 7, 100, 1080, 1920, 3508, 4961, 20000]) {
        expect(
          pixelsFromMm(mmFromPixels(px, dpi), dpi),
          `${String(px)}@${String(dpi)}`,
        ).toBe(px);
      }
    }
  });

  it('physicalFor describes pixels in mm, or null when out of range', () => {
    expect(physicalFor(1920, 1080, DEFAULT_DPI)).toEqual({
      widthMm: 162.56,
      heightMm: 91.44,
      dpi: 300,
    });
    expect(physicalFor(20000, 20000, 1)).toBeNull();
    expect(physicalFor(1, 1, MAX_DPI)).not.toBeNull();
  });

  it('formats and rounds millimetres without floating-point tails', () => {
    expect(roundMm(0.1 + 0.2)).toBe(0.3);
    expect(formatMm(297)).toBe('297');
    expect(formatMm(148.5)).toBe('148.5');
    expect(formatMm(162.560000001)).toBe('162.56');
  });

  it('compares descriptions', () => {
    const a = { widthMm: 1, heightMm: 2, dpi: 3 };
    expect(samePhysical(a, { ...a })).toBe(true);
    expect(samePhysical(a, { ...a, dpi: 4 })).toBe(false);
    expect(samePhysical(undefined, undefined)).toBe(true);
    expect(samePhysical(a, undefined)).toBe(false);
  });

  it('checkPhysical accepts consistent values and copies only known fields', () => {
    const checked = checkPhysical(
      { widthMm: 420, heightMm: 594, dpi: 300, extra: 1 },
      4961,
      7016,
    );
    expect(checked).toEqual({ widthMm: 420, heightMm: 594, dpi: 300 });
  });

  it('checkPhysical rejects bad values', () => {
    const bad: [string, unknown][] = [
      ['null', null],
      ['array', []],
      ['string', '300'],
      ['NaN', { widthMm: NaN, heightMm: 594, dpi: 300 }],
      ['Infinity', { widthMm: 420, heightMm: Infinity, dpi: 300 }],
      ['string mm', { widthMm: '420', heightMm: 594, dpi: 300 }],
      ['zero', { widthMm: 0, heightMm: 594, dpi: 300 }],
      ['negative', { widthMm: -420, heightMm: 594, dpi: 300 }],
      ['huge', { widthMm: 1e9, heightMm: 594, dpi: 300 }],
      ['dpi zero', { widthMm: 420, heightMm: 594, dpi: 0 }],
      ['dpi fraction', { widthMm: 420, heightMm: 594, dpi: 300.5 }],
      ['dpi huge', { widthMm: 420, heightMm: 594, dpi: 1e6 }],
      ['dpi missing', { widthMm: 420, heightMm: 594 }],
      ['mismatch', { widthMm: 420, heightMm: 594, dpi: 150 }],
    ];
    for (const [name, value] of bad) {
      expect(() => checkPhysical(value, 4961, 7016), name).toThrow(RangeError);
    }
  });
});
