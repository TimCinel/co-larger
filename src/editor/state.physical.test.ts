import { describe, expect, it } from 'vitest';
import {
  PAPER_PRESETS,
  paperLabel,
  RATIO_PRESETS,
  presetPhysical,
} from './canvas-settings';
import { EditorStore, type EditorChange } from './store';
import {
  borderAt,
  createEditorState,
  setBackground,
  setBorder,
  setCanvasSize,
  setPhysicalSize,
  switchToPhysical,
  switchToPixels,
  validateEditorState,
  type EditorState,
} from './state';

const photos = Array.from({ length: 12 }, (_, i) => ({
  id: `p${String(i)}`,
  aspect: i % 2 ? 0.75 : 1.5,
}));

const fresh = (): EditorState =>
  createEditorState({ seed: 3, photos, canvas: { borderFraction: 0.02 } });

const a2 = { w: 420, h: 594 };
const a3landscape = { w: 420, h: 297 };

describe('setPhysicalSize', () => {
  it('A2 portrait at 300 DPI is 4961 x 7016 px', () => {
    const s = setPhysicalSize(fresh(), a2.w, a2.h, 300);
    expect(s.canvas).toMatchObject({ width: 4961, height: 7016 });
    expect(s.canvas.physical).toEqual({
      widthMm: 420,
      heightMm: 594,
      dpi: 300,
    });
  });

  it('A3 landscape at 300 DPI is 4961 x 3508 px', () => {
    const s = setPhysicalSize(fresh(), a3landscape.w, a3landscape.h, 300);
    expect(s.canvas).toMatchObject({ width: 4961, height: 3508 });
  });

  it('re-rolls when the ratio changes and keeps the plan when it does not', () => {
    const s = fresh();
    const portrait = setPhysicalSize(s, 210, 297, 300);
    expect(portrait.plan).not.toBe(s.plan);
    const landscape = setPhysicalSize(portrait, 297, 210, 300);
    expect(landscape.plan).not.toBe(portrait.plan);
    // The same ratio at another size (A4 to A2) keeps the arrangement.
    const bigger = setPhysicalSize(portrait, 420, 594, 300);
    expect(bigger.plan).toBe(portrait.plan);
    expect(bigger.assignment).toBe(portrait.assignment);
  });

  it('changing DPI at a fixed paper size keeps the arrangement and the border fraction', () => {
    for (const paper of PAPER_PRESETS) {
      const base = setPhysicalSize(fresh(), paper.widthMm, paper.heightMm, 300);
      for (const dpi of [72, 150, 600]) {
        const next = setPhysicalSize(base, paper.widthMm, paper.heightMm, dpi);
        const name = `${paperLabel(paper)} @${String(dpi)}`;
        expect(next.canvas.width, name).not.toBe(base.canvas.width);
        expect(next.plan, name).toBe(base.plan);
        expect(next.assignment, name).toBe(base.assignment);
        expect(next.seed, name).toBe(base.seed);
        expect(next.canvas.borderFraction, name).toBe(0.02);
        const ratioBefore =
          borderAt(base).requested /
          Math.min(base.canvas.width, base.canvas.height);
        const ratioAfter =
          borderAt(next).requested /
          Math.min(next.canvas.width, next.canvas.height);
        expect(ratioAfter, name).toBeCloseTo(ratioBefore, 12);
      }
    }
  });

  it('returns the same object when nothing changes', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    expect(setPhysicalSize(s, 210, 297, 300)).toBe(s);
  });

  it('a different description with the same pixels is a change that keeps the plan', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    // 210.01 mm at 300 DPI is still 2480 px.
    const t = setPhysicalSize(s, 210.01, 297, 300);
    expect(t).not.toBe(s);
    expect(t.plan).toBe(s.plan);
    expect(t.canvas.physical?.widthMm).toBe(210.01);
  });

  it('rejects numbers that are out of range, leaving the state alone', () => {
    const s = fresh();
    expect(() => setPhysicalSize(s, 5000, 5000, 300)).toThrow(RangeError);
    expect(() => setPhysicalSize(s, 0, 100, 300)).toThrow(RangeError);
    expect(() => setPhysicalSize(s, 100, 100, 0)).toThrow(RangeError);
    expect(() => setPhysicalSize(s, NaN, 100, 300)).toThrow(RangeError);
    expect(() => setPhysicalSize(s, 100, 100, 1e9)).toThrow(RangeError);
    expect(() => setPhysicalSize(s, 0.001, 0.001, 300)).toThrow(RangeError);
  });

  it('the border and background survive and keep the physical size', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    const t = setBackground(setBorder(s, 0.05), '#000000');
    expect(t.canvas.physical).toEqual(s.canvas.physical);
    expect(t.canvas.borderFraction).toBe(0.05);
  });
});

describe('switching units', () => {
  it('switchToPhysical keeps the pixels, adds mm at the default DPI, never re-rolls', () => {
    const s = fresh();
    const t = switchToPhysical(s);
    expect(t.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(t.canvas.physical).toEqual({
      widthMm: 162.56,
      heightMm: 91.44,
      dpi: 300,
    });
    expect(t.plan).toBe(s.plan);
    expect(t.assignment).toBe(s.assignment);
    expect(switchToPhysical(t)).toBe(t);
  });

  it('switchToPhysical at another DPI, and out of range', () => {
    const s = createEditorState({ canvas: { width: 20000, height: 20000 } });
    expect(switchToPhysical(s, 600).canvas.physical?.dpi).toBe(600);
    expect(() => switchToPhysical(s, 1)).toThrow(RangeError);
  });

  it('keeps the exact pixel size for any size and DPI', () => {
    for (const [w, h] of [
      [1, 1],
      [7, 4],
      [1920, 1080],
      [4961, 7016],
      [20000, 3],
    ] as const) {
      for (const dpi of [1, 72, 300, 2400]) {
        const s = createEditorState({ canvas: { width: w, height: h } });
        let t: EditorState;
        try {
          t = switchToPhysical(s, dpi);
        } catch {
          continue;
        }
        expect(t.canvas).toMatchObject({ width: w, height: h });
        validateEditorState(JSON.parse(JSON.stringify(t)));
      }
    }
  });

  it('switchToPixels drops the description and keeps the pixels; no-op without one', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    const t = switchToPixels(s);
    expect(t.canvas).toEqual({
      width: 2480,
      height: 3508,
      borderFraction: 0.02,
      background: '#ffffff',
    });
    expect('physical' in t.canvas).toBe(false);
    expect(t.plan).toBe(s.plan);
    expect(switchToPixels(t)).toBe(t);
    expect(switchToPixels(fresh()).canvas.physical).toBeUndefined();
  });

  it('a pixel edit drops the description, even to the same pixels', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    const t = setCanvasSize(s, 2480, 3508);
    expect(t).not.toBe(s);
    expect('physical' in t.canvas).toBe(false);
    expect(t.plan).toBe(s.plan);
    const u = setCanvasSize(s, 1000, 1000);
    expect(u.canvas.physical).toBeUndefined();
    expect(setCanvasSize(t, 2480, 3508)).toBe(t);
  });

  it('a ratio preset in millimetres keeps the long side and the DPI', () => {
    const a3 = setPhysicalSize(fresh(), 297, 420, 150);
    for (const p of RATIO_PRESETS) {
      const next = presetPhysical(
        p,
        a3.canvas.physical ?? { widthMm: 0, heightMm: 0, dpi: 0 },
      );
      expect(Math.max(next.widthMm, next.heightMm)).toBe(420);
      expect(next.dpi).toBe(150);
      expect(next.widthMm / next.heightMm).toBeCloseTo(p.w / p.h, 3);
      const s = setPhysicalSize(a3, next.widthMm, next.heightMm, next.dpi);
      expect(s.canvas.physical).toEqual(next);
    }
  });
});

describe('validating physical sizes', () => {
  const roundTrip = (s: EditorState): EditorState =>
    validateEditorState(JSON.parse(JSON.stringify(s)));

  it('a project with no physical size has none (and no key)', () => {
    const t = roundTrip(fresh());
    expect('physical' in t.canvas).toBe(false);
    expect(JSON.stringify(fresh())).not.toContain('physical');
  });

  it('round-trips through JSON in the same mode with the same numbers', () => {
    const s = setPhysicalSize(fresh(), 148.5, 210, 300);
    const t = roundTrip(s);
    expect(t).toEqual(s);
    expect(t.canvas.physical).toEqual({
      widthMm: 148.5,
      heightMm: 210,
      dpi: 300,
    });
    for (const paper of PAPER_PRESETS) {
      const p = setPhysicalSize(fresh(), paper.widthMm, paper.heightMm, 300);
      expect(roundTrip(p)).toEqual(p);
    }
  });

  it('rejects hostile physical fields', () => {
    const base = JSON.parse(
      JSON.stringify(setPhysicalSize(fresh(), 210, 297, 300)),
    ) as { canvas: Record<string, unknown> };
    const withPhysical = (physical: unknown): unknown => ({
      ...base,
      canvas: { ...base.canvas, physical },
    });
    const bad: [string, unknown][] = [
      ['null', null],
      ['number', 300],
      ['string', 'A4'],
      ['array', [210, 297, 300]],
      ['empty', {}],
      ['NaN as null', { widthMm: null, heightMm: 297, dpi: 300 }],
      ['mm string', { widthMm: '210', heightMm: 297, dpi: 300 }],
      ['zero mm', { widthMm: 0, heightMm: 297, dpi: 300 }],
      ['negative mm', { widthMm: 210, heightMm: -297, dpi: 300 }],
      ['huge mm', { widthMm: 210, heightMm: 1e300, dpi: 300 }],
      ['zero dpi', { widthMm: 210, heightMm: 297, dpi: 0 }],
      ['negative dpi', { widthMm: 210, heightMm: 297, dpi: -300 }],
      ['fractional dpi', { widthMm: 210, heightMm: 297, dpi: 300.5 }],
      ['huge dpi', { widthMm: 210, heightMm: 297, dpi: 100000 }],
      ['dpi string', { widthMm: 210, heightMm: 297, dpi: '300' }],
      ['inconsistent width', { widthMm: 211, heightMm: 297, dpi: 300 }],
      ['inconsistent height', { widthMm: 210, heightMm: 300, dpi: 300 }],
      ['inconsistent dpi', { widthMm: 210, heightMm: 297, dpi: 301 }],
    ];
    for (const [name, physical] of bad) {
      expect(() => validateEditorState(withPhysical(physical)), name).toThrow(
        RangeError,
      );
    }
    // Rounding slack is accepted: 210.01 mm at 300 DPI is still 2480 px,
    // but 210.02 mm is 2481.
    expect(() =>
      validateEditorState(
        withPhysical({ widthMm: 210.01, heightMm: 297, dpi: 300 }),
      ),
    ).not.toThrow();
    expect(() =>
      validateEditorState(
        withPhysical({ widthMm: 210.02, heightMm: 297, dpi: 300 }),
      ),
    ).toThrow(RangeError);
  });

  it('infinity cannot come from JSON but is rejected anyway', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    const tampered = {
      ...s,
      canvas: {
        ...s.canvas,
        physical: { widthMm: Infinity, heightMm: 297, dpi: 300 },
      },
    };
    expect(() => validateEditorState(tampered)).toThrow(RangeError);
  });

  it('drops unknown fields and builds a fresh object', () => {
    const s = setPhysicalSize(fresh(), 210, 297, 300);
    const raw = JSON.parse(JSON.stringify(s)) as {
      canvas: { physical: Record<string, unknown> };
    };
    raw.canvas.physical.evil = 'x';
    const t = validateEditorState(raw);
    expect(t.canvas.physical).toEqual({
      widthMm: 210,
      heightMm: 297,
      dpi: 300,
    });
    expect(t.canvas.physical).not.toBe(raw.canvas.physical);
  });
});

describe('one gesture, one commit (store)', () => {
  const setup = (): { editor: EditorStore; changes: EditorChange[] } => {
    const editor = new EditorStore({ seed: 3, photos });
    const changes: EditorChange[] = [];
    editor.subscribe((_, change) => changes.push(change));
    return { editor, changes };
  };

  it('each new action commits once when it changes something, zero otherwise', () => {
    const { editor, changes } = setup();
    editor.dispatch((s) => switchToPhysical(s));
    expect(changes).toHaveLength(1);
    editor.dispatch((s) => switchToPhysical(s));
    expect(changes).toHaveLength(1);
    editor.dispatch((s) => setPhysicalSize(s, 420, 594, 300));
    expect(changes).toHaveLength(2);
    editor.dispatch((s) => setPhysicalSize(s, 420, 594, 300));
    expect(changes).toHaveLength(2);
    editor.dispatch((s) => setPhysicalSize(s, 420, 594, 150));
    expect(changes).toHaveLength(3);
    editor.dispatch((s) => switchToPixels(s));
    expect(changes).toHaveLength(4);
    editor.dispatch((s) => switchToPixels(s));
    expect(changes).toHaveLength(4);
    expect(changes.every((c) => !c.transient && !c.restored)).toBe(true);
  });
});
