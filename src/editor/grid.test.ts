/**
 * The Grid layout in the editor state (#20): the layout and Columns setting,
 * every re-roll path, featured photos, validation and undo.
 */
import { describe, expect, it } from 'vitest';
import {
  gridColumnsOf,
  gridRows,
  placeLayout,
  type PhotoShape,
  type Tile,
} from '../layout';
import { PhotoStore } from '../photos';
import { makeNewPhoto } from '../photos/test-helpers';
import { versionFor } from '../project/format';
import {
  arrange,
  columnsOf,
  createEditorState,
  forgetPhotos,
  gridColumnsFor,
  layoutOf,
  dividersFor,
  moveDivider,
  rearrange,
  setCanvasSize,
  setColumns,
  setFeatured,
  setLayout,
  setPhotos,
  setVariation,
  shuffle,
  swapTiles,
  tilesFor,
  validateEditorState,
  type EditorState,
} from './state';
import { EditorStore } from './store';
import { UndoManager } from './undo-manager';

const ASPECTS = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 1, 16 / 9];
const photosOf = (count: number): PhotoShape[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: ASPECTS[(i * 5) % ASPECTS.length] as number,
  }));

const roundTrip = (state: EditorState): EditorState =>
  validateEditorState(JSON.parse(JSON.stringify(state)));

function grid(count: number, columns: 'auto' | number = 'auto', seed = 3) {
  return createEditorState({
    seed,
    photos: photosOf(count),
    layout: 'grid',
    columns,
  });
}

describe('layout setting', () => {
  it('is absent from a mosaic state with Auto columns', () => {
    const state = createEditorState({ seed: 1, photos: photosOf(5) });
    expect('layout' in state).toBe(false);
    expect('columns' in state).toBe(false);
    expect('kind' in state.plan).toBe(false);
    expect(layoutOf(state)).toBe('mosaic');
    expect(columnsOf(state)).toBe('auto');
  });

  it('setLayout re-rolls into a grid, keeps the dial, and back gives the same mosaic', () => {
    const mosaic = createEditorState({
      seed: 9,
      variation: 0.83,
      photos: photosOf(13),
    });
    const g = setLayout(mosaic, 'grid');
    expect(g.layout).toBe('grid');
    expect(g.plan.kind).toBe('grid');
    expect(g.variation).toBe(0.83);
    expect(g.plan.variation).toBe(0.83);
    expect(gridColumnsOf(g.plan)).toBe(
      gridColumnsFor(g.canvas, g.photos, 'auto'),
    );
    expect(setLayout(g, 'grid')).toBe(g);
    const back = setLayout(g, 'mosaic');
    expect(back).toEqual(mosaic);
    expect(JSON.stringify(back)).toBe(JSON.stringify(mosaic));
  });

  it('rejects unknown layouts and column settings', () => {
    const state = grid(4);
    expect(() => setLayout(state, 'brick' as 'grid')).toThrow(RangeError);
    for (const bad of [0, -1, 1.5, NaN, 10001, '3' as unknown as number]) {
      expect(() => setColumns(state, bad)).toThrow(RangeError);
    }
  });
});

describe('columns', () => {
  it('a number re-rolls the grid with that many columns; Auto returns', () => {
    const auto = grid(12);
    const three = setColumns(auto, 3);
    expect(three.columns).toBe(3);
    expect(gridColumnsOf(three.plan)).toBe(3);
    const back = setColumns(three, 'auto');
    expect('columns' in back).toBe(false);
    expect(back.plan).toEqual(auto.plan);
    expect(back.assignment).toEqual(auto.assignment);
  });

  it('choosing the count Auto already shows changes only the setting', () => {
    const auto = grid(12);
    const shown = gridColumnsOf(auto.plan);
    const swapped = swapTiles(auto, 0, 5);
    const fixed = setColumns(swapped, shown);
    expect(fixed.columns).toBe(shown);
    expect(fixed.plan).toBe(swapped.plan);
    expect(fixed.assignment).toBe(swapped.assignment);
  });

  it('a setting above the photo count is clamped for planning and kept', () => {
    const state = setColumns(grid(4), 9);
    expect(state.columns).toBe(9);
    expect(gridColumnsOf(state.plan)).toBe(4);
    const more = setPhotos(state, photosOf(20));
    expect(more.columns).toBe(9);
    expect(gridColumnsOf(more.plan)).toBe(9);
    const fewer = forgetPhotos(more, ['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(gridColumnsOf(fewer.plan)).toBe(9);
    const two = setPhotos(fewer, photosOf(2));
    expect(two.columns).toBe(9);
    expect(gridColumnsOf(two.plan)).toBe(2);
  });

  it('in a mosaic only records the setting', () => {
    const mosaic = createEditorState({ seed: 2, photos: photosOf(8) });
    const next = setColumns(mosaic, 2);
    expect(next.columns).toBe(2);
    expect(next.plan).toBe(mosaic.plan);
    expect(next.assignment).toBe(mosaic.assignment);
    expect(gridColumnsOf(setLayout(next, 'grid').plan)).toBe(2);
  });
});

describe('re-rolls in a grid', () => {
  it('every re-roll path keeps the grid', () => {
    let state = grid(10);
    const check = (s: EditorState): void => {
      expect(s.plan.kind).toBe('grid');
      expect(s.layout).toBe('grid');
      expect(() => roundTrip(s)).not.toThrow();
    };
    state = shuffle(state, 77);
    check(state);
    state = setVariation(state, 0.1);
    check(state);
    expect(state.variation).toBe(0.1);
    state = setVariation(state, 0.95, { keepAssignment: true });
    check(state);
    state = setCanvasSize(state, 1080, 1920);
    check(state);
    state = setPhotos(state, photosOf(14));
    check(state);
    state = forgetPhotos(state, ['p3']);
    check(state);
    state = rearrange(state);
    check(state);
  });

  it('Shuffle moves photos between cells and keeps the cells', () => {
    const a = grid(16, 4, 1);
    const b = shuffle(a, 2);
    expect({ ...b.plan, seed: 0 }).toEqual({ ...a.plan, seed: 0 });
    expect(b.assignment).not.toEqual(a.assignment);
    expect([...b.assignment].sort()).toEqual([...a.assignment].sort());
    // Over a few seeds, the top-left cell holds several different photos.
    const firsts = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((s) => shuffle(a, s + 100).assignment[0]),
    );
    expect(firsts.size).toBeGreaterThan(2);
  });

  it('the dial does not change a grid', () => {
    const a = grid(11, 'auto', 5);
    const b = setVariation(a, 0.05);
    expect({ ...b.plan, variation: 0 }).toEqual({ ...a.plan, variation: 0 });
    expect(b.assignment).toEqual(a.assignment);
  });

  it('re-rolling twice gives the same result (no endless reshuffle)', () => {
    for (const featured of [[], ['p0'], ['p2', 'p5', 'p7']]) {
      for (const n of [9, 10, 11]) {
        const state = createEditorState({
          seed: 4,
          photos: photosOf(n),
          layout: 'grid',
          columns: 3,
          featured,
        });
        const again = rearrange(state);
        expect(again.plan).toEqual(state.plan);
        expect(again.assignment).toEqual(state.assignment);
      }
    }
  });

  it('places photos by shape where the cells differ: the wider last row', () => {
    // 4 columns, 6 photos: four 4:3 cells... and two wider ones on 16:9.
    const photos = [
      { id: 'pano-a', aspect: 3 },
      { id: 'pano-b', aspect: 3 },
      { id: 'q1', aspect: 0.75 },
      { id: 'q2', aspect: 0.75 },
      { id: 'q3', aspect: 0.75 },
      { id: 'q4', aspect: 0.75 },
    ];
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = createEditorState({
        seed,
        photos,
        layout: 'grid',
        columns: 4,
      });
      expect(state.assignment.slice(4).sort()).toEqual(['pano-a', 'pano-b']);
    }
  });
});

describe('featured photos in a grid', () => {
  const tileAreas = (s: EditorState): number[] =>
    tilesFor(s, s.canvas).map((t: Tile) => t.width * t.height);

  it('take the larger cells of a partial last row', () => {
    const state = createEditorState({
      seed: 8,
      photos: photosOf(10),
      layout: 'grid',
      columns: 4,
      featured: ['p6', 'p9'],
    });
    expect(gridRows(10, 4)).toEqual([4, 4, 2]);
    expect(state.assignment.slice(8).sort()).toEqual(['p6', 'p9']);
  });

  it('in a full grid go to the first cells (ties in slot order)', () => {
    const state = createEditorState({
      seed: 8,
      photos: photosOf(12),
      layout: 'grid',
      columns: 4,
      featured: ['p7', 'p11'],
    });
    expect(state.assignment.slice(0, 2).sort()).toEqual(['p11', 'p7']);
  });

  it('featuring in a full grid moves nothing: every cell is equally large', () => {
    for (const border of [0, 0.013, 0.05]) {
      let state = createEditorState({
        seed: 6,
        photos: photosOf(12),
        layout: 'grid',
        columns: 4,
        canvas: { width: 1921, height: 1081, borderFraction: border },
      });
      // Drawn cells differ by a pixel: the rank must not follow rounding.
      const areas = tileAreas(state);
      expect(Math.max(...areas) - Math.min(...areas)).toBeGreaterThan(0);
      for (const id of ['p9', 'p3', 'p11']) {
        const next = setFeatured(state, id, true);
        expect(next.assignment).toBe(state.assignment);
        state = next;
      }
    }
  });

  it('featuring in a partial grid swaps only into a larger cell, once', () => {
    const state = createEditorState({
      seed: 3,
      photos: photosOf(10),
      layout: 'grid',
      columns: 4,
    });
    // A photo already in one of the two wide cells stays.
    const wide = state.assignment[9] as string;
    expect(setFeatured(state, wide, true).assignment).toBe(state.assignment);
    // A photo in a small cell moves into a wide one, with one swap.
    const small = state.assignment[0] as string;
    const next = setFeatured(state, small, true);
    expect(next.assignment.slice(8)).toContain(small);
    const moved = next.assignment.filter((id, i) => id !== state.assignment[i]);
    expect(moved).toHaveLength(2);
    // Featuring the other wide cell's photo then moves nothing.
    const other = next.assignment.slice(8).find((id) => id !== small) as string;
    expect(setFeatured(next, other, true).assignment).toBe(next.assignment);
  });
});

describe('dividers in a grid', () => {
  it('a divider moves, the state validates, and a re-roll discards it', () => {
    const state = grid(9, 3);
    const dividers = dividersFor(state, state.canvas);
    expect(dividers.length).toBeGreaterThan(0);
    const moved = moveDivider(state, '', 0.5);
    expect(moved.plan).not.toEqual(state.plan);
    expect(() => roundTrip(moved)).not.toThrow();
    expect(rearrange(moved).plan).toEqual(state.plan);
  });
});

describe('validation', () => {
  it('round-trips grid states through JSON', () => {
    for (const s of [grid(1), grid(7, 3), grid(30, 1), grid(5, 20)]) {
      const back = roundTrip(s);
      expect(back).toEqual(s);
      expect(JSON.stringify(back)).toBe(JSON.stringify(s));
    }
  });

  it('refuses a bad layout, bad columns, and a plan that disagrees', () => {
    const s = grid(7, 3);
    const mosaic = createEditorState({ seed: 3, photos: photosOf(7) });
    const json = (v: EditorState): Record<string, unknown> =>
      JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
    const bad: [string, Record<string, unknown>][] = [
      ['layout mosaic spelled out', { ...json(s), layout: 'mosaic' }],
      ['layout brick', { ...json(s), layout: 'brick' }],
      ['columns 0', { ...json(s), columns: 0 }],
      ['columns 2.5', { ...json(s), columns: 2.5 }],
      ['columns "3"', { ...json(s), columns: '3' }],
      ['columns null', { ...json(s), columns: null }],
      ['columns disagree', { ...json(s), columns: 2 }],
      ['grid plan, mosaic layout', { ...json(s), layout: undefined }],
      ['mosaic plan, grid layout', { ...json(mosaic), layout: 'grid' }],
    ];
    for (const [what, value] of bad) {
      expect(() => validateEditorState(value), what).toThrow(RangeError);
    }
  });

  it('accepts a grid whose cells are far beyond the mosaic limit', () => {
    const strip = grid(40, 1);
    expect(() => roundTrip(strip)).not.toThrow();
    expect(versionFor(strip)).toBe(2);
    // Within 2.5:1, release 2026.11.0 would accept it: version 1.
    expect(versionFor(grid(12, 4))).toBe(1);
  });
});

describe('undo', () => {
  function setup() {
    const photos = new PhotoStore();
    photos.addPhotos(
      Array.from({ length: 9 }, (_, i) =>
        makeNewPhoto(`p${String(i)}.jpg`, i % 2 ? 300 : 400, 300),
      ),
    );
    let seed = 100;
    const editor = new EditorStore({
      photoStore: photos,
      seed: 1,
      nextSeed: () => seed++,
    });
    const manager = new UndoManager({
      editor,
      photos,
      prepare: () => undefined,
      isGestureHeld: () => false,
      onHistoryCleared: () => undefined,
    });
    let commits = 0;
    editor.subscribe((_s, change) => {
      if (!change.transient && !change.restored) commits++;
    });
    return { editor, manager, commits: () => commits };
  }

  it('switching layout, changing columns and Shuffle are one step each', () => {
    const { editor, manager, commits } = setup();
    const s0 = editor.getState();
    editor.dispatch((s) => setLayout(s, 'grid'));
    const s1 = editor.getState();
    editor.dispatch((s) => setColumns(s, 2));
    const s2 = editor.getState();
    editor.shuffle();
    const s3 = editor.getState();
    expect(commits()).toBe(3);
    expect(manager.undo()).toBe('done');
    expect(editor.getState()).toBe(s2);
    expect(manager.undo()).toBe('done');
    expect(editor.getState()).toBe(s1);
    expect(manager.undo()).toBe('done');
    expect(editor.getState()).toBe(s0);
    expect(layoutOf(editor.getState())).toBe('mosaic');
    expect(manager.redo()).toBe('done');
    expect(manager.redo()).toBe('done');
    expect(manager.redo()).toBe('done');
    expect(editor.getState()).toBe(s3);
  });
});

describe('arrange', () => {
  it('a grid arrangement depends only on its inputs', () => {
    const photos = photosOf(13);
    const canvas = {
      width: 1600,
      height: 1000,
      borderFraction: 0,
      background: '#ffffff',
    };
    const setting = { layout: 'grid', columns: 'auto' } as const;
    const a = arrange(canvas, photos, 0.2, 7, [], setting);
    const b = arrange(canvas, [...photos].reverse(), 0.9, 7, [], setting);
    expect(gridColumnsOf(b.plan)).toBe(gridColumnsOf(a.plan));
    expect(b.assignment).toEqual(a.assignment);
    const tiles = placeLayout(a.plan, canvas);
    expect(tiles).toHaveLength(13);
  });
});
