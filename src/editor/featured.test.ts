// Featured photos in the editor state (#14).
import { describe, expect, it } from 'vitest';
import {
  placeLayout,
  validateAssignment,
  type PhotoShape,
  type SlotShape,
} from '../layout';
import {
  arrange,
  createEditorState,
  featuredOf,
  forgetPhotos,
  isFeatured,
  setBorder,
  setCanvasSize,
  setFeatured,
  setPhotos,
  setVariation,
  shuffle,
  swapTiles,
  validateEditorState,
  type EditorState,
} from './state';
import { EditorStore } from './store';

const ASPECTS = [4 / 3, 3 / 2, 3 / 4, 2 / 3, 1, 16 / 9, 9 / 16];
const photosOf = (count: number): PhotoShape[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: ASPECTS[(i * 3) % ASPECTS.length] as number,
  }));

const RATIOS = [
  [1920, 1080],
  [1080, 1920],
  [1000, 1000],
  [2480, 3508],
  [3508, 2480],
] as const;

/** The shown tiles, with no border (as arrange ranks them). */
const slotsOf = (state: EditorState): SlotShape[] =>
  placeLayout(state.plan, {
    width: state.canvas.width,
    height: state.canvas.height,
  });
const area = (s: SlotShape): number => s.width * s.height;

/** Ranks of slots by area, 0 for the largest. */
function rankOf(state: EditorState, slot: number): number {
  const slots = slotsOf(state);
  const a = area(slots[slot] as SlotShape);
  return slots.filter((s) => area(s) > a).length;
}

/** Every featured photo in the collage is in one of the k largest tiles. */
function expectFeaturedLargest(state: EditorState): void {
  validateAssignment(state.assignment, state.photos);
  const marked = new Set(featuredOf(state));
  const slots = slotsOf(state);
  let minFeatured = Infinity;
  let maxOther = 0;
  for (const [slot, id] of state.assignment.entries()) {
    const a = area(slots[slot] as SlotShape);
    if (marked.has(id)) minFeatured = Math.min(minFeatured, a);
    else maxOther = Math.max(maxOther, a);
  }
  expect(minFeatured).toBeGreaterThanOrEqual(maxOther);
}

function withFeatured(ids: readonly string[], seed = 1): EditorState {
  return createEditorState({
    seed,
    photos: photosOf(30),
    featured: ids,
  });
}

describe('re-rolls keep featured photos in the largest tiles', () => {
  for (const k of [1, 2, 5]) {
    it(`${String(k)} of 30: 50 Shuffles, 20 dial positions, 5 canvas ratios`, () => {
      const ids = photosOf(30)
        .filter((_, i) => i % 6 === 1)
        .slice(0, k)
        .map((p) => p.id);
      let state = withFeatured(ids);
      expect(featuredOf(state)).toHaveLength(k);
      for (const [width, height] of RATIOS) {
        state = setCanvasSize(state, width, height);
        expectFeaturedLargest(state);
        for (let d = 0; d < 20; d++) {
          state = setVariation(state, d / 19);
          expectFeaturedLargest(state);
        }
        for (let seed = 100; seed < 150; seed++) {
          state = shuffle(state, seed);
          expectFeaturedLargest(state);
        }
      }
      // Deterministic: the same inputs give the same arrangement.
      const again = arrange(
        state.canvas,
        state.photos,
        state.variation,
        state.seed,
        featuredOf(state),
      );
      expect(again.assignment).toEqual(state.assignment);
      expect(again.plan).toEqual(state.plan);
    });
  }

  it('holds for dial values between the tenths, and is order-independent', () => {
    const ids = ['p3', 'p11', 'p20'];
    for (let seed = 1; seed <= 15; seed++) {
      for (const v of [0.04, 0.27, 0.33, 0.61, 0.86, 0.97]) {
        const state = setVariation(withFeatured(ids, seed), v);
        expectFeaturedLargest(state);
        const reversed = arrange(
          state.canvas,
          [...state.photos].reverse(),
          v,
          seed,
          [...ids].reverse(),
        );
        expect(reversed.assignment).toEqual(state.assignment);
      }
    }
  });

  it('with every photo featured, is the plain arrangement', () => {
    const photos = photosOf(30);
    const all = photos.map((p) => p.id);
    for (const seed of [1, 2, 3]) {
      const plain = createEditorState({ seed, photos });
      const every = createEditorState({ seed, photos, featured: all });
      expect(every.assignment).toEqual(plain.assignment);
    }
  });

  it('copes with many featured photos at the uniform end of the dial', () => {
    const photos = photosOf(30);
    for (const k of [10, 25, 29]) {
      const state = setVariation(
        createEditorState({
          seed: 4,
          photos,
          featured: photos.slice(0, k).map((p) => p.id),
        }),
        0,
      );
      expectFeaturedLargest(state);
    }
  });

  it('a border never changes where featured photos go', () => {
    const state = withFeatured(['p5', 'p7']);
    const bordered = setBorder(state, 0.05);
    expect(bordered.assignment).toBe(state.assignment);
    expect(shuffle(bordered, 9).assignment).toEqual(
      shuffle(state, 9).assignment,
    );
  });
});

describe('setFeatured', () => {
  it('moves a photo in a small tile to the largest tile, by one swap', () => {
    const state = createEditorState({ seed: 3, photos: photosOf(30) });
    const slots = slotsOf(state);
    const smallest = slots.reduce(
      (best, s, i) => (area(s) < area(slots[best] as SlotShape) ? i : best),
      0,
    );
    const id = state.assignment[smallest] as string;
    const next = setFeatured(state, id, true);
    expect(isFeatured(next, id)).toBe(true);
    const to = next.assignment.indexOf(id);
    expect(rankOf(next, to)).toBe(0);
    // Exactly one swap: two entries changed, plan and crops kept.
    const changed = next.assignment.filter((x, i) => x !== state.assignment[i]);
    expect(changed).toHaveLength(2);
    expect(next.plan).toBe(state.plan);
    expect(next.assignment[smallest]).toBe(state.assignment[to]);
  });

  it('takes the largest tile not held by another featured photo', () => {
    let state = createEditorState({ seed: 3, photos: photosOf(30) });
    const order = slotsOf(state)
      .map((s, i) => [area(s), i] as const)
      .sort((a, b) => b[0] - a[0] || a[1] - b[1])
      .map(([, i]) => i);
    const first = state.assignment[order[29] as number] as string;
    const second = state.assignment[order[28] as number] as string;
    state = setFeatured(state, first, true);
    state = setFeatured(state, second, true);
    expect(state.assignment[order[0] as number]).toBe(first);
    expect(state.assignment[order[1] as number]).toBe(second);
  });

  it('moves nothing when the photo is already in one of the k largest tiles', () => {
    const state = createEditorState({ seed: 3, photos: photosOf(30) });
    const slots = slotsOf(state);
    const largest = slots.reduce(
      (best, s, i) => (area(s) > area(slots[best] as SlotShape) ? i : best),
      0,
    );
    const id = state.assignment[largest] as string;
    const next = setFeatured(state, id, true);
    expect(next.assignment).toBe(state.assignment);
    expect(featuredOf(next)).toEqual([id]);
  });

  it('unfeaturing never moves anything; repeats are no-ops', () => {
    const state = setFeatured(
      createEditorState({ seed: 3, photos: photosOf(30) }),
      'p9',
      true,
    );
    expect(setFeatured(state, 'p9', true)).toBe(state);
    const off = setFeatured(state, 'p9', false);
    expect(off.assignment).toBe(state.assignment);
    expect('featured' in off).toBe(false);
    expect(setFeatured(off, 'p9', false)).toBe(off);
    expect(() => setFeatured(off, '', true)).toThrow(RangeError);
  });

  it('a manual swap moves a featured photo until the next re-roll', () => {
    let state = setFeatured(
      createEditorState({ seed: 3, photos: photosOf(30) }),
      'p9',
      true,
    );
    const at = state.assignment.indexOf('p9');
    const elsewhere = (at + 1) % 30;
    state = swapTiles(state, at, elsewhere);
    expect(state.assignment[elsewhere]).toBe('p9');
    state = shuffle(state, 77);
    expectFeaturedLargest(state);
  });
});

describe('the mark belongs to the photo', () => {
  it('survives excluding and including again; an excluded photo takes no tile', () => {
    const photos = photosOf(30);
    let state = withFeatured(['p4']);
    state = setPhotos(
      state,
      photos.filter((p) => p.id !== 'p4'),
    );
    expect(isFeatured(state, 'p4')).toBe(true);
    expect(state.assignment).not.toContain('p4');
    // Marking an excluded photo only marks it.
    const unmarked = setFeatured(state, 'p4', false);
    const marked = setFeatured(unmarked, 'p4', true);
    expect(isFeatured(marked, 'p4')).toBe(true);
    expect(marked.assignment).toBe(state.assignment);
    state = setPhotos(state, photos);
    expect(isFeatured(state, 'p4')).toBe(true);
    expectFeaturedLargest(state);
  });

  it('survives removing other photos and importing more', () => {
    let state = withFeatured(['p4', 'p6']);
    state = forgetPhotos(state, ['p0', 'p1']);
    expect(featuredOf(state)).toEqual(['p4', 'p6']);
    expectFeaturedLargest(state);
    state = setPhotos(state, [
      ...state.photos,
      { id: 'new-1', aspect: 1.5 },
      { id: 'new-2', aspect: 0.75 },
    ]);
    expect(featuredOf(state)).toEqual(['p4', 'p6']);
    expectFeaturedLargest(state);
  });

  it('is dropped when the photo leaves the store', () => {
    const state = forgetPhotos(withFeatured(['p4', 'p6']), ['p4']);
    expect(featuredOf(state)).toEqual(['p6']);
    expect('featured' in forgetPhotos(state, ['p6'])).toBe(false);
  });
});

describe('saving and validating', () => {
  it('round-trips through JSON', () => {
    const state = withFeatured(['p6', 'p4']);
    expect(state.featured).toEqual(['p4', 'p6']);
    const back = validateEditorState(JSON.parse(JSON.stringify(state)));
    expect(back).toEqual(state);
  });

  it('opens a snapshot without the field (saved before #14) with none featured', () => {
    const state = createEditorState({ seed: 2, photos: photosOf(5) });
    const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    expect('featured' in json).toBe(false);
    const back = validateEditorState(json);
    expect(featuredOf(back)).toEqual([]);
    expect('featured' in back).toBe(false);
    // An empty list is the same as none.
    expect('featured' in validateEditorState({ ...json, featured: [] })).toBe(
      false,
    );
  });

  it('keeps excluded featured photos the project knows, and rejects bad lists', () => {
    const state = createEditorState({ seed: 2, photos: photosOf(5) });
    const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const photoIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'excluded'];
    expect(
      validateEditorState({ ...json, featured: ['excluded'] }, { photoIds })
        .featured,
    ).toEqual(['excluded']);
    for (const featured of [
      'p1',
      {},
      [1],
      [''],
      ['nobody'],
      ['p1', 'p1'],
      ['excluded'],
    ]) {
      expect(() => validateEditorState({ ...json, featured })).toThrow(
        RangeError,
      );
    }
  });
});

describe('in the store: one gesture, one commit', () => {
  it('featuring commits once, and restoring the previous snapshot undoes mark and swap together', () => {
    const editor = new EditorStore({ seed: 3, photos: photosOf(30) });
    const before = editor.getState();
    const slots = slotsOf(before);
    const smallest = slots.reduce(
      (best, s, i) => (area(s) < area(slots[best] as SlotShape) ? i : best),
      0,
    );
    const id = before.assignment[smallest] as string;
    const commits: boolean[] = [];
    editor.subscribe((_, change) => commits.push(change.transient));
    editor.dispatch((s) => setFeatured(s, id, true));
    expect(commits).toEqual([false]);
    const after = editor.getState();
    expect(isFeatured(after, id)).toBe(true);
    expect(after.assignment).not.toEqual(before.assignment);
    editor.restore(before);
    expect(editor.getState().assignment).toEqual(before.assignment);
    expect(isFeatured(editor.getState(), id)).toBe(false);
  });
});
