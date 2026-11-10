/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   The validation tests tamper with parsed JSON of unknown shape. */
import { describe, expect, it } from 'vitest';
import {
  arrangementStep,
  placeLayout,
  swapSlots,
  maxBorder,
  maxBorderForAspect,
  validateAssignment,
  type PhotoShape,
} from '../layout';
import {
  arrange,
  clearArrangementCache,
  createEditorState,
  cropOf,
  DEFAULT_CANVAS,
  forgetPhotos,
  borderAt,
  rearrange,
  setBackground,
  setBorder,
  setCanvasSize,
  setCrop,
  setPhotos,
  setVariation,
  shuffle,
  swapTiles,
  validateEditorState,
  MAX_BORDER_FRACTION,
  MAX_CANVAS_SIDE,
  type EditorState,
} from './state';
import { tilesFor } from './render';

const ASPECTS = [4 / 3, 3 / 4, 1, 16 / 9, 2 / 3, 3 / 2];
function makePhotos(count: number, prefix = 'p'): PhotoShape[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i)}`,
    aspect: ASPECTS[i % ASPECTS.length] as number,
  }));
}

/** The plan and assignment: what a re-roll replaces. */
function arrangementOf(state: EditorState): string {
  return JSON.stringify({ plan: state.plan, assignment: state.assignment });
}

describe('createEditorState', () => {
  it('defaults to a 1920 × 1080 white canvas with no border', () => {
    const state = createEditorState({ seed: 1 });
    expect(state.canvas).toEqual({
      width: 1920,
      height: 1080,
      borderFraction: 0,
      background: '#ffffff',
    });
    expect(state.variation).toBe(0.5);
    expect(state.photos).toEqual([]);
    expect(state.plan.count).toBe(0);
    expect(state.assignment).toEqual([]);
    expect(state.crops).toEqual({});
  });

  it('arranges the photos it is given: one slot per photo', () => {
    const photos = makePhotos(12);
    const state = createEditorState({ seed: 3, photos });
    expect(state.plan.count).toBe(12);
    expect(state.plan.aspect).toBeCloseTo(1920 / 1080);
    validateAssignment(state.assignment, photos);
  });

  it('handles one and two photos', () => {
    for (const count of [1, 2]) {
      const photos = makePhotos(count);
      const state = createEditorState({ seed: 9, photos });
      expect(state.assignment).toHaveLength(count);
      validateAssignment(state.assignment, photos);
    }
  });

  it('picks a random seed when none is given', () => {
    const seeds = new Set(
      Array.from({ length: 5 }, () => createEditorState().seed),
    );
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('rejects invalid canvas settings', () => {
    expect(() => createEditorState({ canvas: { width: 0 } })).toThrow(
      RangeError,
    );
    expect(() => createEditorState({ canvas: { background: 'red' } })).toThrow(
      RangeError,
    );
    expect(() => createEditorState({ canvas: { borderFraction: -1 } })).toThrow(
      RangeError,
    );
  });
});

describe('re-roll rules', () => {
  const photos = makePhotos(20);
  const base = createEditorState({ seed: 42, photos, variation: 0.35 });

  it('shuffle re-rolls with the new seed, and is deterministic', () => {
    const a = shuffle(base, 7);
    const b = shuffle(base, 7);
    expect(a.seed).toBe(7);
    expect(arrangementOf(a)).toBe(arrangementOf(b));
    expect(arrangementOf(a)).not.toBe(arrangementOf(base));
  });

  it('shuffle gives a different arrangement for each new seed', () => {
    const seen = new Set<string>();
    for (let seed = 100; seed < 110; seed++) {
      seen.add(arrangementOf(shuffle(base, seed)));
    }
    expect(seen.size).toBe(10);
  });

  it('a dial change re-rolls; crossing a tenth re-arranges', () => {
    const next = setVariation(base, 0.85);
    expect(next.variation).toBe(0.85);
    expect(next.plan.variation).toBe(0.85);
    expect(JSON.stringify(next.plan.root)).not.toBe(
      JSON.stringify(base.plan.root),
    );
    validateAssignment(next.assignment, photos);
  });

  it('a ratio change re-rolls; the same ratio at another size does not', () => {
    const portrait = setCanvasSize(base, 1080, 1920);
    expect(portrait.plan.aspect).toBeCloseTo(1080 / 1920);
    expect(arrangementOf(portrait)).not.toBe(arrangementOf(base));

    const bigger = setCanvasSize(base, 3840, 2160);
    expect(bigger.canvas.width).toBe(3840);
    expect(bigger.plan).toBe(base.plan);
    expect(bigger.assignment).toBe(base.assignment);
    expect(setCanvasSize(base, 1920, 1080)).toBe(base);
  });

  it('a change to the set of included photos re-rolls', () => {
    const fewer = setPhotos(base, photos.slice(1));
    expect(fewer.plan.count).toBe(19);
    expect(fewer.assignment).not.toContain('p0');
    validateAssignment(fewer.assignment, photos.slice(1));

    const more = setPhotos(base, [...photos, ...makePhotos(3, 'new')]);
    expect(more.plan.count).toBe(23);
    validateAssignment(more.assignment, more.photos);
  });

  it('the same set of photos (even reordered) is not a change', () => {
    expect(setPhotos(base, [...photos])).toBe(base);
    expect(setPhotos(base, [...photos].reverse())).toBe(base);
  });

  it('excluding and re-including a photo returns to the same arrangement', () => {
    const back = setPhotos(setPhotos(base, photos.slice(1)), photos);
    expect(arrangementOf(back)).toBe(arrangementOf(base));
  });

  it('all photos excluded, then re-included', () => {
    const none = setPhotos(base, []);
    expect(none.plan.root).toBeNull();
    expect(none.assignment).toEqual([]);
    const all = setPhotos(none, photos);
    expect(arrangementOf(all)).toBe(arrangementOf(base));
  });

  it('border and background changes never re-roll', () => {
    const bordered = setBorder(base, 0.01);
    expect(bordered.canvas.borderFraction).toBe(0.01);
    expect(bordered.plan).toBe(base.plan);
    expect(bordered.assignment).toBe(base.assignment);

    const black = setBackground(base, '#000000');
    expect(black.canvas.background).toBe('#000000');
    expect(black.plan).toBe(base.plan);
    expect(black.assignment).toBe(base.assignment);
    expect(setBackground(base, '#FFFFFF')).toBe(base);
    expect(() => setBackground(base, 'white')).toThrow(RangeError);
  });

  it('crops survive re-rolls of every kind, and exclusion', () => {
    const cropped = setCrop(base, 'p3', { x: 0.2, y: 0.7, zoom: 1.5 });
    const crop = { x: 0.2, y: 0.7, zoom: 1.5 };
    expect(cropOf(cropped, 'p3')).toEqual(crop);
    expect(cropOf(shuffle(cropped, 5), 'p3')).toEqual(crop);
    expect(cropOf(setVariation(cropped, 0.9), 'p3')).toEqual(crop);
    expect(cropOf(setCanvasSize(cropped, 1000, 1000), 'p3')).toEqual(crop);
    const excluded = setPhotos(
      cropped,
      photos.filter((p) => p.id !== 'p3'),
    );
    expect(cropOf(setPhotos(excluded, photos), 'p3')).toEqual(crop);
  });

  it('manual swaps do not survive a re-roll', () => {
    const swapped: EditorState = {
      ...base,
      assignment: swapSlots(base.assignment, 0, 1),
    };
    expect(shuffle(shuffle(swapped, 999), base.seed).assignment).toEqual(
      base.assignment,
    );
    expect(setVariation(swapped, 0.36).assignment).toEqual(base.assignment);
  });

  it('forgetPhotos drops crops and removes the photos from the collage', () => {
    const cropped = setCrop(base, 'p3', { zoom: 2 });
    const forgotten = forgetPhotos(cropped, ['p3']);
    expect(forgotten.crops).toEqual({});
    expect(forgotten.photos.map((p) => p.id)).not.toContain('p3');
    expect(forgotten.plan.count).toBe(19);
    expect(forgetPhotos(base, ['unknown'])).toBe(base);
  });

  it('actions never mutate their input', () => {
    const before = JSON.stringify(base);
    shuffle(base, 1);
    setVariation(base, 1);
    setPhotos(base, photos.slice(2));
    setCanvasSize(base, 500, 700);
    setBorder(base, 0.003);
    setBackground(base, '#123456');
    setCrop(base, 'p1', { zoom: 3 });
    forgetPhotos(base, ['p1']);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('crops', () => {
  const base = createEditorState({ seed: 1, photos: makePhotos(3) });

  it('are normalised: focal point clamped to the photo, zoom at least 1', () => {
    const state = setCrop(base, 'p0', { x: -1, y: 2, zoom: 0.5 });
    // Clamped to the default, so nothing is stored.
    expect(cropOf(state, 'p0')).toEqual({ x: 0, y: 1, zoom: 1 });
    const zoomed = setCrop(base, 'p0', { zoom: 1e9 });
    expect(cropOf(zoomed, 'p0').zoom).toBe(10);
  });

  it('default crops are not stored', () => {
    const state = setCrop(setCrop(base, 'p0', { zoom: 2 }), 'p0', {
      x: 0.5,
      y: 0.5,
      zoom: 1,
    });
    expect(state.crops).toEqual({});
    expect(setCrop(base, 'p0', {})).toBe(base);
  });
});

describe('dial drag', () => {
  const photos = makePhotos(40);
  const base = createEditorState({ seed: 11, photos, variation: 0.42 });

  it('within a tenth, photos keep their tiles while the tiles resize', () => {
    for (const v of [0.36, 0.4, 0.44, 0.449]) {
      const next = setVariation(base, v);
      expect(next.assignment).toEqual(base.assignment);
      expect(next.plan.variation).toBe(v);
    }
    // ...and the tiles really do change size.
    const a = placeLayout(base.plan, { width: 1920, height: 1080 });
    const b = placeLayout(setVariation(base, 0.36).plan, {
      width: 1920,
      height: 1080,
    });
    expect(a.map((t) => t.width)).not.toEqual(b.map((t) => t.width));
  });

  it('the result depends only on the final value, not the path', () => {
    const direct = setVariation(base, 0.73);
    // A wandering drag, with and without deferred assignment, and with a
    // cold cache, all end in exactly the same state.
    const path = [0.5, 0.61, 0.05, 0.99, 0.3, 0.71, 0.74, 0.73];
    for (const keepAssignment of [false, true]) {
      clearArrangementCache();
      let state = base;
      for (const v of path) state = setVariation(state, v, { keepAssignment });
      // What EditorStore does at the end of a drag: settle a provisional
      // state, else commit the final value.
      const committed = keepAssignment
        ? rearrange(state)
        : setVariation(state, 0.73);
      expect(JSON.stringify(committed)).toBe(JSON.stringify(direct));
    }
  });

  it('a provisional (keepAssignment) step keeps the assignment valid', () => {
    const provisional = setVariation(base, 0.95, { keepAssignment: true });
    expect(provisional.assignment).toBe(base.assignment);
    expect(provisional.plan.variation).toBe(0.95);
    expect(provisional.plan.count).toBe(40);
    validateAssignment(provisional.assignment, photos);
  });

  it('the cache never changes a result', () => {
    clearArrangementCache();
    const cold = arrange(DEFAULT_CANVAS, photos, 0.66, 5);
    const warm = arrange(DEFAULT_CANVAS, photos, 0.66, 5);
    clearArrangementCache();
    const again = arrange(DEFAULT_CANVAS, photos, 0.68, 5);
    expect(warm).toEqual(cold);
    expect(again.assignment).toEqual(cold.assignment);
    expect(arrangementStep(0.68)).toBe(arrangementStep(0.66));
  });

  it('assignment matches photo shape to slot shape', () => {
    // 20 portrait and 20 landscape photos at variation 0: most should land
    // in a tile of their own orientation.
    const mixed = Array.from({ length: 40 }, (_, i) => ({
      id: `m${String(i)}`,
      aspect: i % 2 ? 3 / 4 : 4 / 3,
    }));
    const state = createEditorState({ seed: 2, photos: mixed, variation: 0 });
    const tiles = placeLayout(state.plan, { width: 1920, height: 1080 });
    const aspect = new Map(mixed.map((p) => [p.id, p.aspect]));
    let matched = 0;
    for (const tile of tiles) {
      const photo = aspect.get(state.assignment[tile.slot] as string) as number;
      if (photo < 1 === tile.width / tile.height < 1) matched++;
    }
    expect(matched / tiles.length).toBeGreaterThan(0.8);
  });
});

describe('serialisation', () => {
  const photos = makePhotos(15);
  let state = createEditorState({ seed: 77, photos, variation: 0.8 });
  state = setCrop(state, 'p2', { x: 0.1, y: 0.9, zoom: 2.5 });
  state = setBorder(setBackground(state, '#202020'), 0.005);

  it('round-trips through JSON', () => {
    const text = JSON.stringify(state);
    const loaded = validateEditorState(JSON.parse(text));
    expect(loaded).toEqual(state);
    expect(JSON.stringify(loaded)).toBe(text);
  });

  it('a loaded state behaves like the original', () => {
    const loaded = validateEditorState(JSON.parse(JSON.stringify(state)));
    expect(arrangementOf(shuffle(loaded, 3))).toBe(
      arrangementOf(shuffle(state, 3)),
    );
  });

  it('rejects inconsistent or malformed states', () => {
    const json = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const broken: [string, (s: Record<string, unknown>) => void][] = [
      ['photo missing', (s) => (s.photos = (s.photos as unknown[]).slice(1))],
      [
        'unknown id in assignment',
        (s) => ((s.assignment as string[])[0] = 'nope'),
      ],
      ['wrong seed', (s) => (s.seed = 1)],
      ['wrong variation', (s) => (s.variation = 0.2)],
      [
        'wrong ratio',
        (s) => ((s.canvas as Record<string, number>).width = 1000),
      ],
      ['crop out of range', (s) => (s.crops = { p1: { x: 2, y: 0, zoom: 1 } })],
      [
        'bad background',
        (s) => ((s.canvas as Record<string, string>).background = 'x'),
      ],
      ['not an object', (s) => (s.canvas = null)],
    ];
    for (const [name, breakIt] of broken) {
      const value = json();
      breakIt(value);
      expect(() => validateEditorState(value), name).toThrow(RangeError);
    }
    expect(() => validateEditorState(null)).toThrow(RangeError);
  });

  it('round-trips an empty state', () => {
    const empty = createEditorState({ seed: 0 });
    expect(validateEditorState(JSON.parse(JSON.stringify(empty)))).toEqual(
      empty,
    );
  });
});

describe('no-op actions return the same state', () => {
  const photos = makePhotos(8);
  let base = createEditorState({ seed: 21, photos, variation: 0.4 });
  base = setCrop(setBorder(base, 0.004), 'p1', { zoom: 2 });

  it('for every action given its current value', () => {
    expect(shuffle(base, base.seed)).toBe(base);
    expect(setVariation(base, base.variation)).toBe(base);
    expect(setVariation(base, base.variation, { keepAssignment: true })).toBe(
      base,
    );
    expect(setPhotos(base, [...photos].reverse())).toBe(base);
    expect(forgetPhotos(base, ['nope'])).toBe(base);
    expect(setCanvasSize(base, 1920, 1080)).toBe(base);
    expect(setBorder(base, 0.004)).toBe(base);
    expect(setBackground(base, '#FFFFFF')).toBe(base);
    expect(setCrop(base, 'p1', { zoom: 2 })).toBe(base);
    expect(setCrop(base, 'p2', {})).toBe(base);
  });

  it('so a manual swap survives them', () => {
    const swapped = { ...base, assignment: swapSlots(base.assignment, 0, 1) };
    expect(setVariation(swapped, swapped.variation)).toBe(swapped);
    expect(shuffle(swapped, swapped.seed)).toBe(swapped);
  });
});

describe('canvas ratio tolerance', () => {
  // A-series paper in mm, at the DPIs #7 will offer.
  const paper = {
    A0: [841, 1189],
    A1: [594, 841],
    A2: [420, 594],
    A3: [297, 420],
    A4: [210, 297],
    A5: [148, 210],
  } as const;
  const px = (mm: number, dpi: number): number => Math.round((mm / 25.4) * dpi);
  const dpis = [72, 150, 200, 300, 600];

  it('changing DPI at a fixed paper size never re-rolls', () => {
    for (const [name, [w, h]] of Object.entries(paper)) {
      for (const [ww, hh] of [
        [w, h],
        [h, w],
      ] as const) {
        let state = createEditorState({
          seed: 4,
          photos: makePhotos(10),
          canvas: { width: px(ww, 300), height: px(hh, 300) },
        });
        const plan = state.plan;
        for (const dpi of [...dpis, 300, ...[...dpis].reverse()]) {
          // A0 and A1 at 600 dpi exceed the largest canvas.
          if (Math.max(px(ww, dpi), px(hh, dpi)) > MAX_CANVAS_SIDE) continue;
          state = setCanvasSize(state, px(ww, dpi), px(hh, dpi));
          expect(state.plan, `${name} at ${String(dpi)} dpi`).toBe(plan);
        }
      }
    }
  });

  it('a real ratio change re-rolls', () => {
    const a4 = createEditorState({
      seed: 4,
      photos: makePhotos(10),
      canvas: { width: 2480, height: 3508 },
    });
    expect(setCanvasSize(a4, 3508, 2480).plan).not.toBe(a4.plan);
    expect(setCanvasSize(a4, 2480, 3307).plan).not.toBe(a4.plan); // 3:4
  });

  it('small changes cannot accumulate past the tolerance', () => {
    let state = createEditorState({ seed: 4, photos: makePhotos(10) });
    const plan = state.plan;
    let width = 1920;
    // Each step is 0.3% wider than the last: within tolerance of the
    // previous canvas, but not of the plan after a couple of steps.
    for (let i = 0; i < 5; i++) {
      width = Math.round(width * 1.003);
      state = setCanvasSize(state, width, 1080);
      expect(
        Math.abs(width / 1080 / state.plan.aspect - 1),
      ).toBeLessThanOrEqual(0.005);
    }
    expect(state.plan).not.toBe(plan);
  });
});

describe('border: stored as asked, clamped only when drawn', () => {
  const photos = makePhotos(102);
  const base = setBorder(
    createEditorState({ seed: 8, photos, variation: 0.5 }),
    0.05, // 54 px on 1920 × 1080: more than many arrangements allow
  );

  it('setBorder takes a fraction of the shorter side, 0 to MAX_BORDER_FRACTION', () => {
    expect(borderAt(setBorder(base, 0.01)).requested).toBeCloseTo(10.8, 9);
    expect(setBorder(base, MAX_BORDER_FRACTION).canvas.borderFraction).toBe(
      MAX_BORDER_FRACTION,
    );
    expect(() => setBorder(base, -0.01)).toThrow(RangeError);
    expect(() => setBorder(base, MAX_BORDER_FRACTION + 0.01)).toThrow(
      RangeError,
    );
    expect(() => setBorder(base, Number.NaN)).toThrow(RangeError);
  });

  it('the drawn border never exceeds the plan’s maximum', () => {
    let state = base;
    for (let seed = 0; seed < 20; seed++) {
      state = shuffle(state, seed);
      for (const size of [
        { width: 1920, height: 1080 },
        { width: 640, height: 360 },
        { width: 96, height: 54 },
      ]) {
        const b = borderAt(state, size);
        expect(b.effective).toBeLessThanOrEqual(
          maxBorder(state.plan, size.width, size.height, { snap: true }),
        );
        expect(b.effective).toBeLessThanOrEqual(Math.round(b.requested));
        // ... nor the limit that keeps tiles within 3:1.
        expect(b.max).toBeLessThanOrEqual(
          maxBorderForAspect(state.plan, size.width, size.height, 3, {
            snap: true,
          }),
        );
        expect(() => tilesFor(state, size)).not.toThrow();
      }
    }
  });

  it('a drag commits the same border whatever path it took', () => {
    const click = setVariation(base, 0.6);
    let dragged = base;
    for (const v of [0.7, 0.85, 1, 0.9, 0.75, 0.6]) {
      dragged = setVariation(dragged, v, { keepAssignment: v !== 0.6 });
    }
    dragged = rearrange(dragged);
    expect(JSON.stringify(dragged)).toBe(JSON.stringify(click));
    expect(dragged.canvas.borderFraction).toBe(0.05);
  });

  it('repeated shuffles leave the stored border unchanged', () => {
    let state = base;
    for (let seed = 1; seed <= 40; seed++) {
      state = shuffle(state, seed);
      expect(state.canvas.borderFraction).toBe(0.05);
    }
    // And the drawn border is the most the current plan allows.
    const b = borderAt(state);
    expect(b.effective).toBe(Math.min(Math.round(b.requested), b.max));
  });

  it('a DPI round trip leaves the border unchanged, in physical terms', () => {
    // A4 landscape: 300 dpi, 72 dpi, back to 300 dpi.
    let a4 = setBorder(
      createEditorState({
        seed: 2,
        photos: makePhotos(12),
        canvas: { width: 3508, height: 2480 },
      }),
      80 / 2480,
    );
    const before = borderAt(a4);
    a4 = setCanvasSize(a4, 842, 595);
    expect(borderAt(a4).requested).toBeCloseTo(80 * (595 / 2480), 9);
    a4 = setCanvasSize(a4, 3508, 2480);
    expect(a4.canvas.borderFraction).toBe(80 / 2480);
    expect(borderAt(a4)).toEqual(before);
  });

  it('no action other than setBorder changes it', () => {
    let state = base;
    state = setPhotos(state, photos.slice(0, 5));
    state = setPhotos(state, photos);
    state = setCanvasSize(state, 1080, 1920);
    state = setCanvasSize(state, 3, 2);
    state = setVariation(state, 0);
    state = forgetPhotos(state, ['p1']);
    expect(state.canvas.borderFraction).toBe(0.05);
  });
});

describe('crops are prototype-safe', () => {
  const base = createEditorState({ seed: 1, photos: makePhotos(3) });

  it('cropOf never returns inherited properties', () => {
    expect(cropOf(base, 'constructor')).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
    expect(cropOf(base, 'toString')).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
  });

  it('a photo id of __proto__ is an ordinary key', () => {
    const state = setCrop(base, '__proto__', { zoom: 2 });
    expect(Object.getPrototypeOf(state.crops)).toBeNull();
    expect(cropOf(state, '__proto__').zoom).toBe(2);
    expect(Object.keys(state.crops)).toEqual(['__proto__']);
  });
});

describe('validateEditorState on untrusted input', () => {
  let state = createEditorState({ seed: 77, photos: makePhotos(6) });
  state = setCrop(setBorder(state, 0.005), 'p2', { x: 0.1, zoom: 2 });
  const json = (): Record<string, any> =>
    JSON.parse(JSON.stringify(state)) as Record<string, any>;
  const rejects = (mutate: (s: Record<string, any>) => void): void => {
    const value = json();
    mutate(value);
    expect(() => validateEditorState(value)).toThrow(RangeError);
  };

  it('rejects canvas sizes out of range or fractional', () => {
    rejects((s) => {
      s.canvas.width = 0;
    });
    rejects((s) => {
      s.canvas.width = 0.001;
      s.canvas.height = 0.0005625;
    });
    rejects((s) => {
      s.canvas.width = 1e9;
      s.canvas.height = 5.625e8;
    });
    rejects((s) => {
      s.canvas.width = MAX_CANVAS_SIDE + 1;
    });
    rejects((s) => {
      s.canvas.width = 1920.5;
    });
  });

  it('rejects a border outside 0..MAX_BORDER_FRACTION', () => {
    rejects((s) => {
      s.canvas.borderFraction = 1e9;
    });
    rejects((s) => {
      s.canvas.borderFraction = MAX_BORDER_FRACTION * 1.01;
    });
    rejects((s) => {
      s.canvas.borderFraction = -0.01;
    });
    rejects((s) => {
      s.canvas.borderFraction = '0.01';
    });
  });

  it('accepts any legal border, even above what the arrangement can draw', () => {
    const value = json();
    value.canvas.borderFraction = MAX_BORDER_FRACTION;
    expect(validateEditorState(value).canvas.borderFraction).toBe(
      MAX_BORDER_FRACTION,
    );
  });

  it('rejects non-integer, negative or huge seeds', () => {
    for (const seed of [1.5, -7, 2 ** 60, '5']) {
      rejects((s) => {
        s.seed = seed;
        s.plan.seed = seed;
      });
    }
  });

  it('rejects absurd photo aspects and bad ids', () => {
    rejects((s) => {
      s.photos[0].aspect = 1e9;
    });
    rejects((s) => {
      s.photos[0].aspect = 0;
    });
    rejects((s) => {
      s.photos[0].id = '';
    });
    rejects((s) => {
      s.photos[1].id = s.photos[0].id;
    });
  });

  it('rejects crops for unknown photos, unless the caller knows them', () => {
    const value = json();
    value.crops.stranger = { x: 0.5, y: 0.5, zoom: 2 };
    expect(() => validateEditorState(value)).toThrow(/unknown photo/);
    const ok = validateEditorState(value, {
      photoIds: [...state.photos.map((p) => p.id), 'stranger'],
    });
    expect(cropOf(ok, 'stranger').zoom).toBe(2);
  });

  it('rejects malformed crops', () => {
    rejects((s) => {
      s.crops.p2 = { x: 0.1, y: 0.5 };
    });
    rejects((s) => {
      s.crops.p2 = { x: '0.1', y: 0.5, zoom: 2 };
    });
  });

  it('a __proto__ crop key cannot replace the prototype', () => {
    const text = JSON.stringify(state).replace(
      '"crops":{',
      '"crops":{"__proto__":{"x":0.2,"y":0.5,"zoom":3},',
    );
    const value = JSON.parse(text) as unknown;
    const loaded = validateEditorState(value, {
      photoIds: [...state.photos.map((p) => p.id), '__proto__'],
    });
    expect(Object.getPrototypeOf(loaded.crops)).toBeNull();
    expect(cropOf(loaded, '__proto__').zoom).toBe(3);
    expect(cropOf(loaded, 'constructor').zoom).toBe(1);
  });

  it('rejects a tampered plan that would render zero-size tiles', () => {
    rejects((s) => {
      const squash = (node: any): void => {
        if (node.kind === 'split') {
          node.fraction = 0.999999;
          squash(node.first);
          squash(node.second);
        }
      };
      squash(s.plan.root);
    });
  });

  it('turns any plan error into a RangeError', () => {
    rejects((s) => {
      s.plan.root = { kind: 'nonsense' };
    });
    rejects((s) => {
      s.plan = 'plan';
    });
  });

  it('accepts and normalises an upper-case background', () => {
    const value = json();
    value.canvas.background = '#A0B1C2';
    expect(validateEditorState(value).canvas.background).toBe('#a0b1c2');
  });

  it('returns a freshly built object with no extra fields', () => {
    const value = json();
    value.extra = 1;
    value.canvas.extra = 2;
    value.plan.extra = 3;
    value.plan.root.extra = 4;
    value.photos[0].extra = 5;
    const loaded = validateEditorState(value);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(state));
    expect(loaded.plan).not.toBe(value.plan);
    expect(loaded.plan.root).not.toBe(value.plan.root);
  });
});

describe('swapTiles', () => {
  const photos = makePhotos(8);
  const base = setCrop(createEditorState({ photos, seed: 5 }), 'p2', {
    zoom: 2,
    x: 0.3,
    y: 0.6,
  });

  it('exchanges exactly two entries and nothing else', () => {
    const next = swapTiles(base, 1, 4);
    expect(next.assignment[1]).toBe(base.assignment[4]);
    expect(next.assignment[4]).toBe(base.assignment[1]);
    base.assignment.forEach((id, slot) => {
      if (slot !== 1 && slot !== 4) expect(next.assignment[slot]).toBe(id);
    });
    expect(next.plan).toBe(base.plan);
    expect(next.crops).toBe(base.crops);
    expect(next.photos).toBe(base.photos);
    expect(next.canvas).toBe(base.canvas);
    expect(next.seed).toBe(base.seed);
  });

  it('does not change its input, and swapping back restores it', () => {
    const before = JSON.stringify(base);
    const next = swapTiles(base, 0, 7);
    expect(JSON.stringify(base)).toBe(before);
    expect(swapTiles(next, 7, 0)).toEqual(base);
  });

  it('returns the same object for the same tile', () => {
    expect(swapTiles(base, 3, 3)).toBe(base);
  });

  it('rejects slots that do not exist', () => {
    expect(() => swapTiles(base, 0, 8)).toThrow(RangeError);
    expect(() => swapTiles(base, -1, 0)).toThrow(RangeError);
    expect(() => swapTiles(base, 0.5, 1)).toThrow(RangeError);
    expect(() => swapTiles(base, 9, 9)).toThrow(RangeError);
  });

  it('still validates, and photos keep their crops', () => {
    const next = swapTiles(base, 0, 5);
    expect(validateEditorState(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(cropOf(next, 'p2')).toEqual(cropOf(base, 'p2'));
  });
});
