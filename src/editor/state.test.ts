import { describe, expect, it } from 'vitest';
import {
  arrangementStep,
  placeLayout,
  swapSlots,
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
  setBackground,
  setBorder,
  setCanvasSize,
  setCrop,
  setPhotos,
  setVariation,
  shuffle,
  validateEditorState,
  type EditorState,
} from './state';

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
      border: 0,
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
    expect(() => createEditorState({ canvas: { border: -1 } })).toThrow(
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
    const bordered = setBorder(base, 12);
    expect(bordered.canvas.border).toBe(12);
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
    expect(shuffle(swapped, base.seed).assignment).toEqual(base.assignment);
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
    setBorder(base, 3);
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
      const committed = setVariation(state, 0.73);
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
  state = setBorder(setBackground(state, '#202020'), 6);

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
