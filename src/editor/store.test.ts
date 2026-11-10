import { describe, expect, it, vi } from 'vitest';
import type { PhotoShape } from '../layout';
import { clearArrangementCache, setBorder, setVariation } from './state';
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
    expect(changes).toEqual([{ transient: false }]);
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
    expect(changes).toEqual([
      { transient: true },
      { transient: true },
      { transient: false },
    ]);
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

  it('setPhotos re-rolls only when the set changes', () => {
    const { editor, changes } = setup(4);
    editor.setPhotos(makePhotos(4));
    expect(changes).toHaveLength(0);
    editor.setPhotos(makePhotos(6));
    expect(editor.getState().plan.count).toBe(6);
    editor.forgetPhotos(['p5']);
    expect(editor.getState().plan.count).toBe(5);
  });

  it('a throwing listener does not stop the others', () => {
    const onListenerError = vi.fn();
    const editor = new EditorStore({ seed: 1, onListenerError });
    const other = vi.fn();
    editor.subscribe(() => {
      throw new Error('boom');
    });
    editor.subscribe(other);
    editor.setPhotos(makePhotos(2));
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
  });

  it('unsubscribes', () => {
    const editor = new EditorStore({ seed: 1 });
    const listener = vi.fn();
    const off = editor.subscribe(listener);
    off();
    editor.setPhotos(makePhotos(2));
    expect(listener).not.toHaveBeenCalled();
  });
});
