import { describe, expect, it } from 'vitest';
import {
  activePaper,
  checkPresetPhysical,
  activePreset,
  parseDpi,
  parseMm,
  presetPhysical,
  resizeByDpi,
  resizeByMm,
  BORDER_SLIDER_MAX,
  borderRange,
  parseSide,
  DEFAULT_LONG_SIDE,
  lockRatioFor,
  presetSize,
  RATIO_PRESETS,
  type RatioPreset,
  resizeBySide,
} from './canvas-settings';
import {
  createEditorState,
  MAX_BORDER_FRACTION,
  MAX_CANVAS_SIDE,
  setBorder,
  setCanvasSize,
  shuffle,
} from './state';

const photos = Array.from({ length: 12 }, (_, i) => ({
  id: `p${String(i)}`,
  aspect: i % 2 ? 0.75 : 1.5,
}));

function byLabel(label: string): RatioPreset {
  const found = RATIO_PRESETS.find((p) => p.label === label);
  if (!found) throw new Error(`no preset ${label}`);
  return found;
}

describe('ratio presets', () => {
  it('lists the eleven presets of the spec, in order', () => {
    expect(RATIO_PRESETS.map((p) => p.label)).toEqual([
      '1:1',
      '1:2',
      '2:1',
      '3:4',
      '4:3',
      '4:5',
      '5:4',
      '5:7',
      '7:5',
      '9:16',
      '16:9',
    ]);
  });

  it('gives each preset a 1920 px long side and whole pixels', () => {
    const sizes = Object.fromEntries(
      RATIO_PRESETS.map((p) => {
        const { width, height } = presetSize(p);
        return [p.label, `${String(width)}x${String(height)}`];
      }),
    );
    expect(sizes).toEqual({
      '1:1': '1920x1920',
      '1:2': '960x1920',
      '2:1': '1920x960',
      '3:4': '1440x1920',
      '4:3': '1920x1440',
      '4:5': '1536x1920',
      '5:4': '1920x1536',
      '5:7': '1371x1920',
      '7:5': '1920x1371',
      '9:16': '1080x1920',
      '16:9': '1920x1080',
    });
    for (const p of RATIO_PRESETS) {
      const { width, height } = presetSize(p);
      expect(Math.max(width, height)).toBe(DEFAULT_LONG_SIDE);
      expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
    }
  });

  it('every preset is recognised from its own size, and only that one', () => {
    for (const p of RATIO_PRESETS) {
      const { width, height } = presetSize(p);
      expect(activePreset(width, height)).toBe(p);
    }
  });

  it('a preset stays active at another pixel size, and not for custom ratios', () => {
    expect(activePreset(3840, 2160)?.label).toBe('16:9');
    expect(activePreset(2000, 2000)?.label).toBe('1:1');
    expect(activePreset(1920, 1000)).toBeNull();
    expect(activePreset(3508, 2480)).toBeNull(); // A4 is not a preset
    expect(activePreset(1920, 1070)).toBeNull();
  });

  it('presets keep the current long side instead of resetting it', () => {
    const big = { width: 3840, height: 2160 };
    const long = 3840;
    expect(presetSize(byLabel('1:1'), long)).toEqual({
      width: 3840,
      height: 3840,
    });
    expect(presetSize(byLabel('9:16'), long)).toEqual({
      width: 2160,
      height: 3840,
    });
    // The active preset gives the size already there: a click changes nothing.
    const active = byLabel('16:9');
    expect(presetSize(active, Math.max(big.width, big.height))).toEqual(big);
    let state = createEditorState({ seed: 4, photos, canvas: big });
    const same = setCanvasSize(state, 3840, 2160);
    expect(same).toBe(state);
    // A4 landscape at 300 dpi keeps its 3508 px long side.
    expect(presetSize(byLabel('4:3'), 3508)).toEqual({
      width: 3508,
      height: 2631,
    });
    // Extremes stay valid.
    for (const l of [1, 2, 7, 20000]) {
      for (const p of RATIO_PRESETS) {
        const { width, height } = presetSize(p, l);
        state = setCanvasSize(state, width, height);
        expect(Math.max(width, height)).toBe(l);
        expect(Math.min(width, height)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('choosing presets resizes the canvas and re-lays out', () => {
    let state = createEditorState({ seed: 4, photos });
    for (const p of RATIO_PRESETS) {
      const { width, height } = presetSize(p);
      const before = state;
      state = setCanvasSize(state, width, height);
      expect(state.canvas).toMatchObject({ width, height });
      if (activePreset(before.canvas.width, before.canvas.height) !== p) {
        expect(state.plan).not.toBe(before.plan);
        expect(state.plan.aspect).toBeCloseTo(width / height, 9);
      }
    }
  });
});

describe('parseSide', () => {
  it('accepts whole pixels from 1 to 20000', () => {
    expect(parseSide('1', 'width')).toEqual({ ok: true, value: 1 });
    expect(parseSide(' 1920 ', 'width')).toEqual({ ok: true, value: 1920 });
    expect(parseSide('20000', 'height')).toEqual({ ok: true, value: 20000 });
    expect(parseSide('007', 'height')).toEqual({ ok: true, value: 7 });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'whole number'],
    ['12.5', 'whole number'],
    ['1e3', 'whole number'],
    ['-5', 'whole number'],
    ['1,920', 'whole number'],
    ['1920px', 'whole number'],
    ['0', 'at least 1'],
    ['20001', 'at most 20000'],
    ['99999999999999999999', 'at most 20000'],
  ])('rejects %j with a message about %s', (text, about) => {
    const result = parseSide(text, 'width');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(about);
      expect(result.message.startsWith('Width')).toBe(true);
    }
  });
});

describe('resizeBySide', () => {
  const current = { width: 1920, height: 1080 };
  const ratio = 1920 / 1080;

  it('with the lock on, the other side keeps the ratio', () => {
    expect(
      resizeBySide({ side: 'width', text: '960', current, lock: true, ratio }),
    ).toEqual({ ok: true, width: 960, height: 540 });
    expect(
      resizeBySide({ side: 'height', text: '540', current, lock: true, ratio }),
    ).toEqual({ ok: true, width: 960, height: 540 });
  });

  it('with the lock on, the other side is rounded to a whole pixel', () => {
    expect(
      resizeBySide({ side: 'width', text: '1001', current, lock: true, ratio }),
    ).toEqual({ ok: true, width: 1001, height: 563 }); // 562.97
  });

  it('with the lock off, only the edited side changes', () => {
    expect(
      resizeBySide({
        side: 'width',
        text: '1000',
        current,
        lock: false,
        ratio,
      }),
    ).toEqual({ ok: true, width: 1000, height: 1080 });
    expect(
      resizeBySide({
        side: 'height',
        text: '1000',
        current,
        lock: false,
        ratio,
      }),
    ).toEqual({ ok: true, width: 1920, height: 1000 });
  });

  it('rejects a locked edit that would push the other side out of range', () => {
    const tall = { width: 1000, height: 10000 };
    const r = resizeBySide({
      side: 'width',
      text: '5000',
      current: tall,
      lock: true,
      ratio: 0.1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('height 50000 px');
    const thin = resizeBySide({
      side: 'height',
      text: '2',
      current: { width: 1000, height: 10000 },
      lock: true,
      ratio: 0.1,
    });
    expect(thin.ok).toBe(false);
    // Unlocked, the same edit is fine.
    expect(
      resizeBySide({
        side: 'height',
        text: '2',
        current: { width: 1000, height: 10000 },
        lock: false,
        ratio: 0.1,
      }),
    ).toEqual({ ok: true, width: 1000, height: 2 });
  });

  it('lock at 5:7 uses the exact ratio, not the rounded pixel ratio', () => {
    const cur = { width: 1371, height: 1920 };
    expect(lockRatioFor(1371, 1920)).toBe(5 / 7);
    expect(lockRatioFor(1920, 1000)).toBe(1920 / 1000);
    const r = resizeBySide({
      side: 'height',
      text: '7000',
      current: cur,
      lock: true,
      ratio: lockRatioFor(1371, 1920),
    });
    expect(r).toEqual({ ok: true, width: 5000, height: 7000 });
  });

  it('re-entering the current value changes nothing, even with the lock on', () => {
    const cur = { width: 1371, height: 1920 };
    expect(
      resizeBySide({
        side: 'width',
        text: '1371',
        current: cur,
        lock: true,
        ratio: 5 / 7,
      }),
    ).toEqual({ ok: true, ...cur });
  });

  it('passes parse errors through', () => {
    const r = resizeBySide({
      side: 'height',
      text: 'x',
      current,
      lock: true,
      ratio,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.startsWith('Height')).toBe(true);
  });

  it('every accepted result is a valid canvas size', () => {
    for (const text of ['1', '37', '999', '1920', '20000']) {
      for (const side of ['width', 'height'] as const) {
        for (const lock of [true, false]) {
          const r = resizeBySide({ side, text, current, lock, ratio });
          if (!r.ok) continue;
          for (const v of [r.width, r.height]) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(1);
            expect(v).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
          }
          expect(() =>
            setCanvasSize(createEditorState(), r.width, r.height),
          ).not.toThrow();
        }
      }
    }
  });

  it('with the lock on, a size change keeps the arrangement; with it off, a ratio change re-rolls', () => {
    const state = createEditorState({ seed: 9, photos });
    const locked = resizeBySide({
      side: 'width',
      text: '960',
      current: state.canvas,
      lock: true,
      ratio: state.canvas.width / state.canvas.height,
    });
    if (!locked.ok) throw new Error('unreachable');
    const smaller = setCanvasSize(state, locked.width, locked.height);
    expect(smaller.plan).toBe(state.plan);
    expect(smaller.assignment).toBe(state.assignment);

    const free = resizeBySide({
      side: 'width',
      text: '960',
      current: state.canvas,
      lock: false,
      ratio: 1,
    });
    if (!free.ok) throw new Error('unreachable');
    const reshaped = setCanvasSize(state, free.width, free.height);
    expect(reshaped.plan).not.toBe(state.plan);
  });
});

describe('borderRange', () => {
  it('has a fixed 0 to 10% scale whatever the arrangement', () => {
    for (let seed = 0; seed < 15; seed++) {
      const state = setBorder(
        shuffle(createEditorState({ seed: 1, photos }), seed),
        0.05,
      );
      const range = borderRange(state);
      expect(range.scale).toBe(BORDER_SLIDER_MAX);
      expect(range.scale).toBe(0.1);
      // The thumb shows the request, wherever the maximum is.
      expect(range.value).toBe(0.05);
      expect(range.available).toBeGreaterThan(0);
      expect(range.available).toBeLessThanOrEqual(MAX_BORDER_FRACTION);
    }
  });

  it('what is available is drawn in full; beyond it less is drawn', () => {
    const base = createEditorState({ seed: 1, photos });
    const { available } = borderRange(base);
    const at = borderRange(
      setBorder(base, Math.floor(available * 1000) / 1000),
    );
    expect(at.limited).toBe(false);
    const over = borderRange(setBorder(base, MAX_BORDER_FRACTION));
    expect(over.limited).toBe(true);
    expect(over.drawnPx).toBeLessThan(over.requestedPx);
    expect(over.drawn).toBeCloseTo(available, 2);
  });

  it('keeps a request above the available part and above the scale', () => {
    const base = setBorder(createEditorState({ seed: 3, photos }), 0.2);
    const range = borderRange(base);
    expect(range.requested).toBe(0.2);
    expect(range.value).toBe(BORDER_SLIDER_MAX);
    expect(range.limited).toBe(true);
    expect(range.drawnPx).toBeLessThan(range.requestedPx);
  });

  it('a re-roll changes what is available, never the request or the thumb', () => {
    let state = setBorder(createEditorState({ seed: 3, photos }), 0.06);
    const available = new Set<number>();
    for (let seed = 10; seed < 40; seed++) {
      state = shuffle(state, seed);
      const range = borderRange(state);
      available.add(range.available);
      expect(range.requested).toBe(0.06);
      expect(range.value).toBe(0.06);
      expect(range.limited).toBe(range.drawnPx < range.requestedPx);
    }
    expect(available.size).toBeGreaterThan(1);
  });

  it('the label and the note use the same numbers (5000 x 5000, 25% asked)', () => {
    const state = setBorder(
      createEditorState({
        seed: 2,
        photos,
        canvas: { width: 5000, height: 5000 },
      }),
      0.25,
    );
    const r = borderRange(state);
    expect(r.requestedPx).toBe(1250);
    expect(r.drawnPx / 5000).toBe(r.drawn);
    expect(r.limited).toBe(true);
  });

  it('is not limited at no border, and allows the full range with no photos', () => {
    expect(borderRange(createEditorState({ seed: 3, photos })).limited).toBe(
      false,
    );
    const empty = borderRange(createEditorState());
    expect(empty.available).toBe(MAX_BORDER_FRACTION);
    expect(empty.limited).toBe(false);
  });
});

describe('physical size input', () => {
  const current = { widthMm: 210, heightMm: 297, dpi: 300 };

  it('parses millimetres: decimals yes, anything else no', () => {
    const ok = (text: string): number | string => {
      const r = parseMm(text, 'widthMm');
      return r.ok ? r.value : r.message;
    };
    expect(ok('297')).toBe(297);
    expect(ok(' 148.5 ')).toBe(148.5);
    expect(ok('148,5')).toBe(148.5);
    expect(ok('.5')).toBe(0.5);
    expect(ok('0.001')).toBe(0.001);
    expect(ok('10000')).toBe(10000);
    for (const text of [
      'abc',
      '1e3',
      '-5',
      '+5',
      '5.',
      '1.2345',
      '1,000.5',
      '12mm',
      '0x10',
      '१२',
      'NaN',
      'Infinity',
      '1 2',
    ]) {
      expect(ok(text), text).toMatch(/plain number/);
    }
    expect(ok('')).toMatch(/empty/);
    expect(ok('  ')).toMatch(/empty/);
    expect(ok('0')).toMatch(/at least/);
    expect(ok('0.0001')).toMatch(/plain number/);
    expect(ok('10001')).toMatch(/at most/);
    expect(ok('9'.repeat(400))).toMatch(/at most/);
  });

  it('parses DPI: whole numbers from 1 to 2400', () => {
    const ok = (text: string): number | string => {
      const r = parseDpi(text);
      return r.ok ? r.value : r.message;
    };
    expect(ok('300')).toBe(300);
    expect(ok('1')).toBe(1);
    expect(ok('2400')).toBe(2400);
    expect(ok('')).toMatch(/empty/);
    expect(ok('0')).toMatch(/at least/);
    expect(ok('2401')).toMatch(/at most/);
    for (const text of ['300.5', '-300', 'abc', '3e2', '300 dpi', '1,200']) {
      expect(ok(text), text).toMatch(/whole number/);
    }
  });

  it('editing a side with the lock on follows in mm', () => {
    const r = resizeByMm({
      side: 'widthMm',
      text: '420',
      current,
      lock: true,
      ratio: 210 / 297,
    });
    expect(r.ok && r.physical).toEqual({
      widthMm: 420,
      heightMm: 594,
      dpi: 300,
    });
    const h = resizeByMm({
      side: 'heightMm',
      text: '594',
      current,
      lock: true,
      ratio: 210 / 297,
    });
    expect(h.ok && h.physical).toEqual({
      widthMm: 420,
      heightMm: 594,
      dpi: 300,
    });
  });

  it('editing a side with the lock off changes only that side', () => {
    const r = resizeByMm({
      side: 'widthMm',
      text: '100.5',
      current,
      lock: false,
      ratio: 1,
    });
    expect(r.ok && r.physical).toEqual({ ...current, widthMm: 100.5 });
  });

  it('re-entering the current value changes nothing', () => {
    const r = resizeByMm({
      side: 'widthMm',
      text: '210.000',
      current,
      lock: true,
      ratio: 0.5,
    });
    expect(r.ok && r.physical).toBe(current);
    const d = resizeByDpi('300', current);
    expect(d.ok && d.physical).toBe(current);
  });

  it('refuses sizes that would leave 1 to 20000 px, with a message', () => {
    const big = resizeByMm({
      side: 'widthMm',
      text: '2000',
      current,
      lock: false,
      ratio: 1,
    });
    expect(!big.ok && big.message).toMatch(
      /23622 px, more than the 20000 px limit/,
    );
    const locked = resizeByMm({
      side: 'widthMm',
      text: '2000',
      current,
      lock: true,
      ratio: 210 / 297,
    });
    expect(locked.ok).toBe(false);
    const tiny = resizeByMm({
      side: 'widthMm',
      text: '0.01',
      current,
      lock: false,
      ratio: 1,
    });
    expect(!tiny.ok && tiny.message).toMatch(/less than 1 px/);
    const dpi = resizeByDpi('2400', { widthMm: 594, heightMm: 420, dpi: 300 });
    expect(!dpi.ok && dpi.message).toMatch(/Choose another DPI/);
    // Rounding the followed side must not escape the range either.
    const followed = resizeByMm({
      side: 'widthMm',
      text: '9999',
      current,
      lock: true,
      ratio: 1e-6,
    });
    expect(followed.ok).toBe(false);
  });

  it('DPI edits keep the millimetres', () => {
    const r = resizeByDpi('600', current);
    expect(r.ok && r.physical).toEqual({ ...current, dpi: 600 });
  });

  it('paper presets are recognised by their millimetres only', () => {
    expect(activePaper({ widthMm: 420, heightMm: 594, dpi: 72 })).toMatchObject(
      { name: 'A2', orientation: 'portrait' },
    );
    expect(activePaper({ widthMm: 420, heightMm: 594.5, dpi: 72 })).toBeNull();
    expect(activePaper(undefined)).toBeNull();
  });

  it('a ratio preset keeps the long side in mm and the DPI', () => {
    const p = presetPhysical(byLabel('4:3'), {
      widthMm: 210,
      heightMm: 297,
      dpi: 150,
    });
    expect(p).toEqual({ widthMm: 297, heightMm: 222.75, dpi: 150 });
    const q = presetPhysical(byLabel('9:16'), {
      widthMm: 297,
      heightMm: 210,
      dpi: 300,
    });
    expect(q).toEqual({ widthMm: 167.063, heightMm: 297, dpi: 300 });
  });

  it('checks that a ratio preset fits in pixels before it is applied', () => {
    const tiny = { widthMm: 13, heightMm: 13, dpi: 1 };
    const refused = checkPresetPhysical(byLabel('1:2'), tiny);
    expect(!refused.ok && refused.message).toMatch(/0 px, less than 1 px/);
    expect(checkPresetPhysical(byLabel('1:1'), tiny).ok).toBe(true);
    const a4 = { widthMm: 210, heightMm: 297, dpi: 300 };
    for (const p of RATIO_PRESETS) {
      expect(checkPresetPhysical(p, a4).ok, p.label).toBe(true);
    }
  });
});
