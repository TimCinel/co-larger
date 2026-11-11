import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../photos';
import { makeNewPhoto } from '../photos/test-helpers';
import { setBorder, setVariation, swapTiles } from './state';
import { EditorStore } from './store';
import { UndoManager } from './undo-manager';

function setup(count = 6, manual = false, held = { value: false }) {
  const photos = new PhotoStore();
  photos.addPhotos(
    Array.from({ length: count }, (_, i) =>
      makeNewPhoto(`p${String(i)}.jpg`, i % 2 ? 300 : 400, 300),
    ),
  );
  const queued: (() => void)[] = [];
  let seed = 100;
  const editor = new EditorStore({
    photoStore: photos,
    seed: 1,
    nextSeed: () => seed++,
    scheduleSync: manual ? (f) => queued.push(f) : undefined,
  });
  const sync = (): void => {
    for (const f of queued.splice(0)) f();
  };
  const toasts: string[] = [];
  const manager = new UndoManager({
    editor,
    photos,
    prepare: sync,
    isGestureHeld: () => held.value,
    onHistoryCleared: (message) => toasts.push(message),
  });
  return { photos, editor, manager, sync, toasts, held };
}

describe('UndoManager', () => {
  it('records one entry per committed change and ignores transient ones', () => {
    const { editor, manager } = setup();
    const start = editor.getState();
    editor.drag((s) => setBorder(s, 0.01));
    editor.drag((s) => setBorder(s, 0.02));
    expect(manager.canUndo()).toBe(true); // a gesture to commit
    editor.dispatch((s) => setBorder(s, 0.03));
    expect(manager.undo()).toBe('done');
    expect(editor.getState()).toBe(start);
    expect(manager.canUndo()).toBe(false);
    expect(manager.redo()).toBe('done');
    expect(editor.getState().canvas.borderFraction).toBe(0.03);
  });

  it('does not record undo itself, and a new change clears redo', () => {
    const { editor, manager } = setup();
    editor.shuffle();
    manager.undo();
    expect(manager.canRedo()).toBe(true);
    expect(manager.canUndo()).toBe(false);
    editor.shuffle();
    expect(manager.canRedo()).toBe(false);
  });

  it('restores swapped arrangement after a shuffle', () => {
    const { editor, manager } = setup();
    editor.dispatch((s) => swapTiles(s, 0, 1));
    editor.dispatch((s) => swapTiles(s, 2, 3));
    const arranged = editor.getState();
    editor.shuffle();
    manager.undo();
    expect(editor.getState()).toBe(arranged);
  });

  it('commits an unfinished gesture as its own entry before undoing', () => {
    const { editor, manager } = setup();
    editor.shuffle();
    const afterShuffle = editor.getState();
    editor.drag((s) => setBorder(s, 0.02)); // colour picker closed unchanged
    expect(editor.isDragging()).toBe(true);
    manager.undo();
    expect(editor.isDragging()).toBe(false);
    expect(editor.getState()).toBe(afterShuffle);
    manager.redo();
    expect(editor.getState().canvas.borderFraction).toBe(0.02);
  });

  it('commits an unfinished dial drag, then undoes it', () => {
    const { editor, manager } = setup();
    const start = editor.getState();
    editor.dragVariation(0.9);
    manager.undo();
    expect(editor.getState()).toBe(start);
    expect(editor.getState().variation).not.toBe(0.9);
    expect(manager.canRedo()).toBe(true);
    manager.redo();
    expect(editor.getState().variation).toBe(0.9);
    expect(editor.isDragging()).toBe(false);
  });

  it('keeps the tray and the editor in step across undo of exclusion', () => {
    const { editor, manager, photos, sync } = setup(6, true);
    const ids = photos.getIncludedIds();
    photos.setAllIncluded(false);
    sync();
    photos.setAllIncluded(true);
    sync();
    editor.dispatch((s) => setVariation(s, 0.7));
    const check = (): void => {
      expect(editor.getState().photos.map((p) => p.id)).toEqual(
        photos.getIncludedIds(),
      );
    };
    manager.undo();
    check();
    expect(photos.getIncludedIds()).toEqual(ids);
    manager.undo();
    check();
    expect(photos.getIncludedIds()).toEqual([]);
    manager.undo();
    check();
    expect(photos.getIncludedIds()).toEqual(ids);
  });

  it('treats an import as a boundary and never throws', () => {
    const { editor, manager, photos } = setup(4, true);
    editor.shuffle();
    editor.shuffle();
    expect(manager.canUndo()).toBe(true);
    photos.addPhotos([makeNewPhoto('new.jpg')]);
    expect(manager.canUndo()).toBe(false);
    // Undo before the sync lands still sees the boundary.
    expect(manager.undo()).toBe('empty');
    expect(editor.getState().photos).toHaveLength(5);
    editor.shuffle();
    expect(manager.undo()).toBe('done');
    expect(editor.getState().photos).toHaveLength(5);
    expect(photos.getIncludedIds()).toHaveLength(5);
  });

  it('the tray sync after an import is not a step', () => {
    const { editor, manager, photos, sync } = setup(4, true);
    editor.shuffle();
    photos.addPhotos([makeNewPhoto('new.jpg')]);
    sync();
    expect(editor.getState().photos).toHaveLength(5);
    expect(manager.canUndo()).toBe(false);
  });

  it('clears history when a photo is removed from the store', () => {
    const { editor, manager, photos } = setup(4);
    editor.shuffle();
    photos.removePhotos([photos.getPhotos()[0]?.id ?? '']);
    expect(manager.canUndo()).toBe(false);
    expect(editor.getState().photos).toHaveLength(3);
  });

  it('keeps at most the limit of steps', () => {
    const photos = new PhotoStore();
    photos.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg')]);
    const editor = new EditorStore({ photoStore: photos, seed: 1 });
    const manager = new UndoManager({ editor, photos, limit: 5 });
    for (let i = 0; i < 12; i++) editor.shuffle();
    let n = 0;
    while (manager.undo() === 'done') n++;
    expect(n).toBe(5);
  });

  it('toasts when an import clears a non-empty history, not an empty one', () => {
    const { editor, photos, sync, toasts } = setup(4, true);
    photos.addPhotos([makeNewPhoto('first.jpg')]);
    sync();
    expect(toasts).toEqual([]); // nothing to lose
    editor.shuffle();
    photos.addPhotos([makeNewPhoto('second.jpg')]);
    sync();
    expect(toasts).toEqual(['Adding photos cleared the undo history.']);
    photos.addPhotos([makeNewPhoto('third.jpg')]);
    sync();
    expect(toasts).toHaveLength(1); // already empty again
  });

  it('toasts for a redo-only history too', () => {
    const { editor, manager, photos, toasts } = setup(4);
    editor.shuffle();
    manager.undo();
    photos.addPhotos([makeNewPhoto('x.jpg')]);
    expect(toasts).toHaveLength(1);
  });

  it('toasts once when removing photos clears a non-empty history only', () => {
    const { editor, photos, toasts } = setup(4);
    photos.removePhotos([photos.getPhotos()[0]?.id ?? '']);
    expect(toasts).toEqual([]);
    editor.shuffle();
    photos.removePhotos([photos.getPhotos()[0]?.id ?? '']);
    expect(toasts).toEqual(['Removing photos cleared the undo history.']);
  });

  it('does nothing while a pointer gesture is held', () => {
    const { editor, manager, held } = setup();
    editor.shuffle();
    const shuffled = editor.getState();
    editor.dragVariation(0.9);
    const mid = editor.getState();
    held.value = true;
    expect(manager.canUndo()).toBe(false);
    expect(manager.undo()).toBe('busy');
    expect(manager.redo()).toBe('busy');
    expect(editor.getState()).toBe(mid);
    expect(editor.isDragging()).toBe(true);
    held.value = false;
    editor.commitVariation(0.9);
    expect(manager.undo()).toBe('done');
    expect(editor.getState()).toBe(shuffled);
  });
});
