import { describe, expect, it, vi } from 'vitest';
import type { PhotoShape } from '../layout';
import { PhotoStore } from '../photos';
import { makeNewPhoto } from '../photos/test-helpers';
import { swapSlots } from '../layout';
import {
  clearArrangementCache,
  cropOf,
  setBorder,
  setCrop,
  setPhotos,
  setVariation,
  type EditorState,
} from './state';
import {
  DEFER_ASSIGNMENT_ABOVE,
  EditorStore,
  type EditorChange,
} from './store';

function makePhotos(count: number): PhotoShape[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: i % 3 === 0 ? 0.75 : 1.5,
  }));
}

/** A store with a manual timer. */
function setup(count: number) {
  const timers: (() => void)[] = [];
  const editor = new EditorStore({
    seed: 5,
    variation: 0.5,
    photos: makePhotos(count),
    setTimer: (callback) => {
      timers.push(callback);
      return () => {
        const i = timers.indexOf(callback);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    nextSeed: (() => {
      let seed = 1000;
      return () => seed++;
    })(),
  });
  const changes: EditorChange[] = [];
  editor.subscribe((_, change) => changes.push(change));
  const runTimers = (): void => {
    for (const t of timers.splice(0)) t();
  };
  return { editor, changes, timers, runTimers };
}

describe('EditorStore', () => {
  it('notifies committed changes and skips no-ops', () => {
    const { editor, changes } = setup(5);
    editor.dispatch((s) => setBorder(s, 4));
    editor.dispatch((s) => setBorder(s, 4));
    expect(changes).toEqual([{ transient: false, restored: false }]);
    expect(editor.getState().canvas.border).toBe(4);
  });

  it('shuffle uses a new seed each time', () => {
    const { editor } = setup(10);
    const seeds = new Set<number>();
    const plans = new Set<string>();
    for (let i = 0; i < 5; i++) {
      editor.shuffle();
      seeds.add(editor.getState().seed);
      plans.add(JSON.stringify(editor.getState().plan));
    }
    expect(seeds.size).toBe(5);
    expect(plans.size).toBe(5);
  });

  it('a drag notifies transient steps, then one commit', () => {
    const { editor, changes } = setup(10);
    editor.dragVariation(0.6);
    editor.dragVariation(0.7);
    expect(editor.isDragging()).toBe(true);
    editor.commitVariation(0.7);
    expect(editor.isDragging()).toBe(false);
    expect(changes.map((c) => c.transient)).toEqual([true, true, false]);
  });

  it('a small collage is re-assigned at once while dragging', () => {
    const { editor, timers } = setup(DEFER_ASSIGNMENT_ABOVE);
    const start = editor.getState();
    editor.dragVariation(0.9);
    expect(timers).toHaveLength(0);
    expect(editor.getState()).toEqual(setVariation(start, 0.9));
  });

  it('a large collage defers re-assignment until the dial rests', () => {
    clearArrangementCache();
    const { editor, timers, runTimers, changes } = setup(
      DEFER_ASSIGNMENT_ABOVE + 1,
    );
    const start = editor.getState();
    editor.dragVariation(0.9);
    // Provisional: the new plan with the old assignment.
    expect(editor.getState().plan.variation).toBe(0.9);
    expect(editor.getState().assignment).toBe(start.assignment);
    expect(timers).toHaveLength(1);
    runTimers();
    // Settled: exactly the full result, still part of the drag.
    expect(editor.getState()).toEqual(setVariation(start, 0.9));
    expect(changes.every((c) => c.transient)).toBe(true);
    expect(editor.isDragging()).toBe(true);
  });

  it('a drag commits the same state whatever path it took', () => {
    const { editor } = setup(DEFER_ASSIGNMENT_ABOVE + 1);
    const start = editor.getState();
    for (const v of [0.55, 0.2, 0.95, 0.31, 0.84]) editor.dragVariation(v);
    editor.commitVariation(0.84);
    expect(JSON.stringify(editor.getState())).toBe(
      JSON.stringify(setVariation(start, 0.84)),
    );
  });

  it('any other action during a drag settles the drag first', () => {
    clearArrangementCache();
    const { editor, timers } = setup(DEFER_ASSIGNMENT_ABOVE + 1);
    const start = editor.getState();
    editor.dragVariation(0.05);
    editor.dispatch((s) => setBorder(s, 2));
    expect(timers).toHaveLength(0);
    expect(editor.isDragging()).toBe(false);
    expect(editor.getState().assignment).toEqual(
      setVariation(start, 0.05).assignment,
    );
  });

  it('commits a drag once, however many events end it', () => {
    const { editor, changes } = setup(10);
    editor.dragVariation(0.6);
    editor.commitVariation(0.6);
    editor.commitVariation(0.6);
    expect(changes.map((c) => c.transient)).toEqual([true, false]);
  });

  it('committing the dial at its current value keeps a manual swap', () => {
    const { editor, changes } = setup(10);
    const v = editor.getState().variation;
    editor.dispatch((s) => ({
      ...s,
      assignment: swapSlots(s.assignment, 0, 1),
    }));
    const swapped = editor.getState();
    editor.commitVariation(v);
    editor.dragVariation(v);
    editor.commitVariation(v);
    expect(editor.getState()).toBe(swapped);
    expect(changes).toHaveLength(1);
  });

  it('a provisional drag back to its start value still settles', () => {
    clearArrangementCache();
    const { editor } = setup(DEFER_ASSIGNMENT_ABOVE + 1);
    const start = editor.getState();
    editor.dragVariation(0.95);
    clearArrangementCache();
    editor.dragVariation(0.5);
    editor.commitVariation(0.5);
    expect(JSON.stringify(editor.getState())).toBe(JSON.stringify(start));
  });

  it('dispatch re-rolls only when the photo set changes', () => {
    const { editor, changes } = setup(4);
    editor.dispatch((s) => setPhotos(s, makePhotos(4)));
    expect(changes).toHaveLength(0);
    editor.dispatch((s) => setPhotos(s, makePhotos(6)));
    expect(editor.getState().plan.count).toBe(6);
  });

  it('a throwing listener does not stop the others', () => {
    const onListenerError = vi.fn();
    const editor = new EditorStore({ seed: 1, onListenerError });
    const other = vi.fn();
    editor.subscribe(() => {
      throw new Error('boom');
    });
    editor.subscribe(other);
    editor.dispatch((s) => setPhotos(s, makePhotos(2)));
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
  });

  it('unsubscribes', () => {
    const editor = new EditorStore({ seed: 1 });
    const listener = vi.fn();
    const off = editor.subscribe(listener);
    off();
    editor.dispatch((s) => setPhotos(s, makePhotos(2)));
    expect(listener).not.toHaveBeenCalled();
  });
});

/** An editor connected to a real PhotoStore, with a manual sync queue. */
function connected(count: number) {
  const photos = new PhotoStore();
  photos.addPhotos(
    Array.from({ length: count }, (_, i) =>
      makeNewPhoto(`p${String(i)}.jpg`, i % 3 ? 400 : 300, i % 3 ? 300 : 400),
    ),
  );
  const queue: (() => void)[] = [];
  const editor = new EditorStore({
    seed: 9,
    photoStore: photos,
    scheduleSync: (sync) => queue.push(sync),
  });
  const changes: EditorChange[] = [];
  editor.subscribe((_, change) => changes.push(change));
  const flush = (): void => {
    for (const sync of queue.splice(0)) sync();
  };
  return { photos, editor, changes, flush };
}

describe('EditorStore with a PhotoStore', () => {
  it('starts with the store’s included photos', () => {
    const { editor } = connected(5);
    expect(editor.getState().photos.map((p) => p.id)).toHaveLength(5);
  });

  it('follows tray toggles once per sync, re-rolling', () => {
    const { photos, editor, flush, changes } = connected(6);
    const [a, b] = editor.getState().photos;
    photos.setIncluded((a as PhotoShape).id, false);
    photos.setIncluded((b as PhotoShape).id, false);
    expect(editor.getState().photos).toHaveLength(6);
    flush();
    expect(editor.getState().photos).toHaveLength(4);
    expect(changes).toHaveLength(1);
  });

  it('forgets removed photos at once', () => {
    const { photos, editor } = connected(4);
    const id = (editor.getState().photos[0] as PhotoShape).id;
    editor.dispatch((s) => setCrop(s, id, { zoom: 2 }));
    photos.removePhotos([id]);
    expect(editor.getState().photos).toHaveLength(3);
    expect(Object.keys(editor.getState().crops)).toEqual([]);
  });

  it('restore puts back a snapshot and the tray flags, without a re-roll', () => {
    const { photos, editor, flush, changes } = connected(8);
    const ids = editor.getState().photos.map((p) => p.id);
    // A snapshot with a swap and a crop, while 2 photos are excluded.
    photos.setIncluded([ids[0] as string, ids[1] as string], false);
    flush();
    editor.dispatch((s) => ({
      ...s,
      assignment: swapSlots(s.assignment, 0, 3),
    }));
    editor.dispatch((s) => setCrop(s, ids[4] as string, { x: 0.1, zoom: 3 }));
    const snapshot: EditorState = editor.getState();
    // Then the user changes the tray: all included again (a re-roll).
    photos.setAllIncluded(true);
    flush();
    expect(editor.getState().photos).toHaveLength(8);

    changes.length = 0;
    editor.restore(snapshot);
    expect(editor.getState()).toBe(snapshot);
    expect(photos.getIncludedIds().sort()).toEqual(
      snapshot.photos.map((p) => p.id).sort(),
    );
    expect(changes).toEqual([{ transient: false, restored: true }]);
    // The store's change queues a sync; it must not re-roll.
    flush();
    expect(editor.getState()).toBe(snapshot);
    expect(cropOf(editor.getState(), ids[4] as string).zoom).toBe(3);
    expect(changes).toHaveLength(1);
  });

  it('restore of an older snapshot excludes photos the snapshot did not have', () => {
    const { photos, editor, flush } = connected(5);
    const snapshot = editor.getState();
    photos.addPhotos([makeNewPhoto('late.jpg')]);
    flush();
    expect(editor.getState().photos).toHaveLength(6);
    editor.restore(snapshot);
    flush();
    expect(photos.getSelectedCount()).toBe(5);
    expect(editor.getState()).toBe(snapshot);
  });

  it('restore fails loudly, changing nothing, for a photo the store lacks', () => {
    const { photos, editor, flush } = connected(4);
    const snapshot = editor.getState();
    const gone = (snapshot.photos[0] as PhotoShape).id;
    photos.removePhotos([gone]);
    const before = editor.getState();
    const included = photos.getIncludedIds();
    expect(() => {
      editor.restore(snapshot);
    }).toThrow(/not in the photo store/);
    flush();
    expect(editor.getState()).toBe(before);
    expect(photos.getIncludedIds()).toEqual(included);
  });

  it('restore ends a drag', () => {
    const { editor } = connected(4);
    const snapshot = editor.getState();
    editor.dragVariation(0.9);
    editor.restore(snapshot);
    expect(editor.isDragging()).toBe(false);
    expect(editor.getState()).toBe(snapshot);
  });
});
