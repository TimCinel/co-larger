import { describe, expect, it } from 'vitest';
import {
  activePreset,
  BORDER_STEP,
  borderRange,
  parseSide,
  PRESET_LONG_SIDE,
  presetSize,
  RATIO_PRESETS,
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
      expect(Math.max(width, height)).toBe(PRESET_LONG_SIDE);
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
  it('ends at the most the arrangement allows, in whole slider steps', () => {
    for (let seed = 0; seed < 15; seed++) {
      const state = shuffle(createEditorState({ seed: 1, photos }), seed);
      const range = borderRange(state);
      expect(range.max).toBeGreaterThan(0);
      expect(range.max).toBeLessThanOrEqual(MAX_BORDER_FRACTION);
      expect(
        Math.abs(range.max / BORDER_STEP - Math.round(range.max / BORDER_STEP)),
      ).toBeLessThan(1e-6);
      // At the slider's maximum, the border is drawn in full.
      const full = borderRange(setBorder(state, range.max));
      expect(full.limited).toBe(false);
      expect(full.drawnPx).toBe(Math.round(full.requestedPx));
    }
  });

  it('keeps a request above the maximum, and says when less is drawn', () => {
    const base = setBorder(createEditorState({ seed: 3, photos }), 0.2);
    const range = borderRange(base);
    expect(range.requested).toBe(0.2);
    expect(range.max).toBeLessThan(0.2);
    expect(range.value).toBe(range.max);
    expect(range.limited).toBe(true);
    expect(range.drawnPx).toBeLessThan(range.requestedPx);
    expect(range.drawn).toBeLessThanOrEqual(range.max + BORDER_STEP);
  });

  it('a re-roll that changes the maximum never changes the request', () => {
    let state = setBorder(createEditorState({ seed: 3, photos }), 0.06);
    const maxes = new Set<number>();
    for (let seed = 10; seed < 40; seed++) {
      state = shuffle(state, seed);
      const range = borderRange(state);
      maxes.add(range.max);
      expect(range.requested).toBe(0.06);
      expect(range.value).toBe(Math.min(0.06, range.max));
      expect(range.limited).toBe(range.drawnPx < Math.round(range.requestedPx));
    }
    expect(maxes.size).toBeGreaterThan(1);
  });

  it('is not limited at no border, and allows the full range with no photos', () => {
    expect(borderRange(createEditorState({ seed: 3, photos })).limited).toBe(
      false,
    );
    const empty = borderRange(createEditorState());
    expect(empty.max).toBe(MAX_BORDER_FRACTION);
    expect(empty.limited).toBe(false);
  });
});
