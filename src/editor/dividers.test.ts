import { describe, expect, it } from 'vitest';
import {
  checkTileSizes,
  dividerRange,
  listDividers,
  planLayout,
  type LayoutNode,
  type PhotoShape,
} from '../layout';
import {
  buildProject,
  parseProject,
  serialiseProject,
} from '../project/format';
import {
  arrange,
  borderAt,
  createEditorState,
  dividersFor,
  moveDivider,
  onlyResized,
  sameButPlan,
  setBackground,
  setBorder,
  setCanvasSize,
  setCrop,
  setFeatured,
  setPhotos,
  setVariation,
  shuffle,
  swapTiles,
  tilesFor,
  validateEditorState,
  type EditorState,
} from './state';
import { EditorStore, type EditorChange } from './store';

const PHOTOS: PhotoShape[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${String(i)}`,
  aspect: [4 / 3, 3 / 4, 1, 16 / 9][i % 4] as number,
}));

function base(): EditorState {
  return createEditorState({
    seed: 11,
    variation: 0.5,
    photos: PHOTOS,
    canvas: { width: 1600, height: 1000, borderFraction: 0.01 },
  });
}

/** The state with its root divider moved to `fraction`. */
const resized = (state: EditorState, fraction = 0.2): EditorState =>
  moveDivider(state, '', fraction);

const fractionOf = (state: EditorState): number =>
  (state.plan.root as LayoutNode & { fraction: number }).fraction;

describe('moveDivider', () => {
  it('changes only the plan, and only that node', () => {
    const state = base();
    const next = resized(state);
    expect(next).not.toBe(state);
    expect(next.assignment).toBe(state.assignment);
    expect(next.crops).toBe(state.crops);
    expect(next.canvas).toBe(state.canvas);
    expect(next.photos).toBe(state.photos);
    expect(fractionOf(next)).not.toBe(fractionOf(state));
    expect(sameButPlan(next, state)).toBe(true);
    expect(onlyResized(next.plan, state.plan)).toBe(true);
  });

  it('returns the same object for the current position', () => {
    const state = base();
    expect(moveDivider(state, '', fractionOf(state))).toBe(state);
    const next = resized(state);
    expect(moveDivider(next, '', fractionOf(next))).toBe(next);
  });

  it('clamps to the range and never moves a photo, featured or not', () => {
    const featured = setFeatured(base(), 'p3', true);
    const next = moveDivider(featured, '', 0);
    const range = dividerRange(featured.plan, '');
    expect(fractionOf(next)).toBe(range.min);
    expect(next.assignment).toBe(featured.assignment);
    expect(next.featured).toBe(featured.featured);
  });

  it('dividersFor matches the drawn tiles', () => {
    const state = resized(base());
    const size = { width: 800, height: 500 };
    const tiles = tilesFor(state, size);
    const dividers = dividersFor(state, size);
    expect(dividers).toHaveLength(tiles.length - 1);
    const root = dividers[0];
    expect(root?.path).toBe('');
    // The tiles left of the root divider end at its cut.
    const ends = tiles
      .filter((t) => t.x < (root?.cut ?? 0))
      .map((t) => t.x + t.width);
    expect(Math.max(...ends)).toBe(root?.cut);
  });
});

describe('hand resizing and re-rolls', () => {
  const kept: [string, (s: EditorState) => EditorState][] = [
    ['the border', (s) => setBorder(s, 0.03)],
    ['the background', (s) => setBackground(s, '#123456')],
    ['the canvas size at the same ratio', (s) => setCanvasSize(s, 3200, 2000)],
    ['a swap', (s) => swapTiles(s, 0, 5)],
    ['a crop', (s) => setCrop(s, 'p1', { x: 0.2, y: 0.7, zoom: 2 })],
    ['featuring', (s) => setFeatured(s, 'p7', true)],
    ['the dial at the value it has', (s) => setVariation(s, s.variation)],
  ];
  it.each(kept)('survives %s', (_name, action) => {
    const state = resized(base());
    const next = action(state);
    expect(next.plan).toBe(state.plan);
  });

  const replaced: [string, (s: EditorState) => EditorState][] = [
    ['Shuffle', (s) => shuffle(s, 12)],
    ['the dial', (s) => setVariation(s, 0.55)],
    [
      'the dial while dragged',
      (s) => setVariation(s, 0.55, { keepAssignment: true }),
    ],
    ['a ratio change', (s) => setCanvasSize(s, 1000, 1000)],
    ['excluding a photo', (s) => setPhotos(s, PHOTOS.slice(1))],
  ];
  it.each(replaced)('is replaced by %s', (_name, action) => {
    const state = resized(base());
    const next = action(state);
    const fresh = arrange(next.canvas, next.photos, next.variation, next.seed);
    expect(JSON.stringify(next.plan)).toBe(JSON.stringify(fresh.plan));
  });

  it('a dial drag away and back re-rolls: nothing of the hand resizing is kept', () => {
    const editor = new EditorStore({
      seed: 11,
      variation: 0.5,
      photos: PHOTOS,
    });
    const start = editor.getState();
    editor.dispatch((s) => moveDivider(s, '', 0.2));
    const hand = editor.getState();
    expect(hand.plan).not.toBe(start.plan);
    editor.dragVariation(0.53);
    editor.dragVariation(0.5);
    editor.commitVariation(0.5);
    const after = editor.getState();
    expect(JSON.stringify(after.plan)).toBe(JSON.stringify(start.plan));
    // Within a tenth too: a plan made at 0.53 has the same tree, but its
    // fractions come from the planner, not from the hand-resized plan.
    editor.dispatch((s) => moveDivider(s, '', 0.2));
    editor.dragVariation(0.53);
    editor.commitVariation(0.53);
    expect(JSON.stringify(editor.getState().plan)).toBe(
      JSON.stringify(
        planLayout({
          width: 1920,
          height: 1080,
          count: PHOTOS.length,
          variation: 0.53,
          seed: 11,
        }),
      ),
    );
  });
});

describe('a gesture applies every step to its start', () => {
  it('a tile below the minimum may grow and come back, not shrink further', () => {
    // 300 photos: the planner makes tiles below the 4% minimum.
    const many: PhotoShape[] = Array.from({ length: 300 }, (_, i) => ({
      id: `q${String(i)}`,
      aspect: 1,
    }));
    const state = createEditorState({ seed: 4, variation: 1, photos: many });
    const dividers = listDividers(state.plan, {
      width: state.plan.aspect,
      height: 1,
    });
    // A divider whose range is pinned at one end by a small tile.
    const d = dividers.find((x) => {
      const r = dividerRange(state.plan, x.path);
      return r.min === r.fraction || r.max === r.fraction;
    });
    expect(d).toBeDefined();
    if (!d) return;
    const r = dividerRange(state.plan, d.path);
    const away = r.min === r.fraction ? r.max : r.min;
    const out = moveDivider(state, d.path, away);
    // Back from the intermediate state: the small tile is now larger and
    // may not return to below the minimum...
    const fromMiddle = moveDivider(out, d.path, r.fraction);
    // ...but from the gesture's start it returns exactly.
    const fromStart = moveDivider(state, d.path, r.fraction);
    expect(fromStart).toBe(state);
    expect(sameButPlan(out, state)).toBe(true);
    // (Whether the middle route can return depends on the tile; it never
    // goes past the start.)
    const f = (s: EditorState): number => {
      let node = s.plan.root as LayoutNode;
      for (const step of d.path) {
        if (node.kind !== 'split') break;
        node = step === '0' ? node.first : node.second;
      }
      return (node as LayoutNode & { fraction: number }).fraction;
    };
    const towardsStart = Math.sign(r.fraction - away);
    expect((f(fromMiddle) - r.fraction) * towardsStart).toBeLessThanOrEqual(0);
  });

  it('cancelDrag puts back the committed state without a commit', () => {
    const editor = new EditorStore({ seed: 2, photos: PHOTOS });
    const changes: EditorChange[] = [];
    editor.subscribe((_s, change) => changes.push(change));
    const before = editor.getState();
    editor.drag((s) => moveDivider(s, '', 0.3));
    expect(editor.isDragging()).toBe(true);
    editor.cancelDrag();
    expect(editor.getState()).toBe(before);
    expect(editor.isDragging()).toBe(false);
    expect(changes.every((c) => c.transient)).toBe(true);
    // Nothing more to commit.
    editor.commitPending();
    expect(changes.every((c) => c.transient)).toBe(true);
  });
});

describe('saving and validating a hand-resized layout', () => {
  /** The root divider pulled far, so a tile is beyond the planner's limit. */
  function stretched(): EditorState {
    let state = base();
    state = moveDivider(state, '', 0);
    state = moveDivider(state, '', 1);
    // Push every divider to one end, until some tile is beyond 2.5:1.
    for (const d of listDividers(state.plan, {
      width: state.plan.aspect,
      height: 1,
    })) {
      if (checkTileSizes(state.plan) === 'resized') break;
      state = moveDivider(state, d.path, 0);
    }
    return state;
  }

  it('a stretched layout validates and round-trips exactly', () => {
    const state = stretched();
    expect(checkTileSizes(state.plan)).toBe('resized');
    const text = JSON.stringify(state);
    const loaded = validateEditorState(JSON.parse(text));
    expect(JSON.stringify(loaded)).toBe(text);
  });

  it('a plan squashed below the minimum is still refused', () => {
    const state = base();
    const copy = JSON.parse(JSON.stringify(state)) as {
      plan: { root: { fraction: number } };
    };
    copy.plan.root.fraction = 0.001;
    expect(() => validateEditorState(copy)).toThrow(/squashed/);
  });

  it('keeps a border: a hand-stretched tile does not force it to zero', () => {
    const state = setBorder(stretched(), 0.01);
    const at = borderAt(state);
    expect(at.max).toBeGreaterThan(0);
    expect(at.effective).toBe(Math.round(at.requested));
  });

  it('planned borders are clamped exactly as before', () => {
    // No tile beyond the planner's limit: the clamp ignores `stretched`.
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = createEditorState({
        seed,
        photos: PHOTOS,
        canvas: { width: 1920, height: 1080, borderFraction: 0.25 },
      });
      expect(checkTileSizes(state.plan)).toBe('planned');
      expect(borderAt(state).max).toBeGreaterThan(0);
    }
  });

  // 900 px tall: every aspect above is exactly width / height.
  const sources = PHOTOS.map((p) => ({
    id: p.id,
    name: `${p.id}.jpg`,
    type: 'image/jpeg',
    width: Math.round(900 * p.aspect),
    height: 900,
    aspect: p.aspect,
    lastModified: 1,
  }));

  it('writes version 1 unless a tile is beyond the planner limit', () => {
    const plain = base();
    const nudged = moveDivider(plain, '', fractionOf(plain) + 0.01);
    expect(checkTileSizes(nudged.plan)).toBe('planned');
    expect(buildProject(plain, sources).version).toBe(1);
    expect(buildProject(nudged, sources).version).toBe(1);
    const far = stretched();
    const project = buildProject(far, sources);
    expect(project.version).toBe(2);
    // And this build reads it back, exactly.
    const parsed = parseProject(serialiseProject(project));
    expect(parsed.version).toBe(2);
    expect(JSON.stringify(parsed.state)).toBe(JSON.stringify(far));
  });
});
