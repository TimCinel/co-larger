import { describe, expect, it } from 'vitest';
import { PhotoImporter, PhotoStore } from '../photos';
import type { Decoder } from '../photos/decode';
import { makeDecoded, makeFile } from '../photos/test-helpers';
import { setBorder } from './state';
import { EditorStore } from './store';
import { UndoManager } from './undo-manager';

const instantly = (): Promise<void> => Promise.resolve();

/** Decoding is held until `release` is called, one file at a time. */
function gatedDecoder() {
  const waiting: { name: string; go: () => void }[] = [];
  const decode: Decoder = (file) =>
    new Promise((resolve, reject) => {
      waiting.push({
        name: file.name,
        go: () => {
          if (file.name.endsWith('.bad')) reject(new Error('Cannot decode'));
          else resolve(makeDecoded());
        },
      });
    });
  const release = async (count = 1): Promise<void> => {
    for (let i = 0; i < count; i++) {
      // Let a worker reach its decode call first.
      for (let t = 0; t < 5 && waiting.length === 0; t++) await instantly();
      waiting.shift()?.go();
      for (let t = 0; t < 5; t++) await instantly();
    }
  };
  return { decode, release };
}

function setup() {
  const photos = new PhotoStore();
  const { decode, release } = gatedDecoder();
  const importer = new PhotoImporter(photos, {
    decode,
    yieldToMain: instantly,
    concurrency: 1,
  });
  const files = (prefix: string, n: number, ext = 'jpg'): File[] =>
    Array.from({ length: n }, (_, i) =>
      makeFile(`${prefix}${String(i)}.${ext}`, i + 1),
    );
  const queued: (() => void)[] = [];
  let seed = 100;
  let syncs = 0;
  const editor = new EditorStore({
    photoStore: photos,
    imports: importer,
    seed: 1,
    nextSeed: () => seed++,
    scheduleSync: (f) => queued.push(f),
  });
  const runFrame = (): void => {
    for (const f of queued.splice(0)) {
      syncs++;
      f();
    }
  };
  const commits: unknown[] = [];
  const toasts: string[] = [];
  const manager = new UndoManager({
    editor,
    photos,
    imports: importer,
    prepare: runFrame,
    onHistoryCleared: (m) => toasts.push(m),
  });
  editor.subscribe((state, change) => {
    if (!change.transient) commits.push(state);
  });
  return {
    photos,
    importer,
    editor,
    manager,
    files,
    release,
    runFrame,
    commits,
    toasts,
    syncs: () => syncs,
  };
}

describe('import defers the editor sync', () => {
  it('lays out once, at idle, for N photos', async () => {
    const t = setup();
    const done = t.importer.enqueue(t.files('a', 5));
    for (let i = 0; i < 5; i++) {
      await t.release();
      if (i < 4) {
        t.runFrame();
        expect(t.editor.getState().photos).toHaveLength(0);
      }
    }
    await done;
    expect(t.photos.getPhotos()).toHaveLength(5);
    // The one layout happens as the import goes idle, not a frame later.
    expect(t.editor.getState().photos).toHaveLength(5);
    expect(t.commits).toHaveLength(1);
    t.runFrame();
    expect(t.commits).toHaveLength(1);
  });

  it('keeps an existing collage unchanged until the batch is done', async () => {
    const t = setup();
    const first = t.importer.enqueue(t.files('a', 3));
    await t.release(3);
    await first;
    t.runFrame();
    const showing = t.editor.getState();
    const done = t.importer.enqueue(t.files('b', 4));
    await t.release(2);
    t.runFrame();
    expect(t.editor.getState()).toBe(showing);
    await t.release(2);
    await done;
    t.runFrame();
    expect(t.editor.getState().photos).toHaveLength(7);
    expect(t.commits).toHaveLength(2);
  });

  it('a second batch dropped mid-import extends it', async () => {
    const t = setup();
    const one = t.importer.enqueue(t.files('a', 2));
    await t.release();
    const two = t.importer.enqueue(t.files('b', 2));
    await t.release(2);
    t.runFrame();
    expect(t.editor.getState().photos).toHaveLength(0);
    await t.release();
    await Promise.all([one, two]);
    t.runFrame();
    expect(t.editor.getState().photos).toHaveLength(4);
    expect(t.commits).toHaveLength(1);
  });

  it('a partly failed import lays out once; an all-failed one never', async () => {
    const t = setup();
    const mixed = [...t.files('a', 2), ...t.files('x', 2, 'bad')];
    const done = t.importer.enqueue(mixed);
    await t.release(4);
    await done;
    t.runFrame();
    expect(t.editor.getState().photos).toHaveLength(2);
    expect(t.commits).toHaveLength(1);

    const failed = t.importer.enqueue(t.files('y', 3, 'bad'));
    await t.release(3);
    await failed;
    t.runFrame();
    expect(t.commits).toHaveLength(1);
    // Duplicates too.
    const dup = await t.importer.enqueue(t.files('a', 2));
    expect(dup.duplicates).toHaveLength(2);
    t.runFrame();
    expect(t.commits).toHaveLength(1);
  });

  it('tray toggles wait for the batch', async () => {
    const t = setup();
    const first = t.importer.enqueue(t.files('a', 3));
    await t.release(3);
    await first;
    t.runFrame();
    const showing = t.editor.getState();
    const done = t.importer.enqueue(t.files('b', 2));
    await t.release();
    t.photos.setIncludedIds([showing.photos[0]?.id ?? '']);
    t.runFrame();
    expect(t.editor.getState()).toBe(showing);
    await t.release();
    await done;
    t.runFrame();
    // The kept photo and the one that arrived after the toggle.
    expect(t.editor.getState().photos).toHaveLength(2);
  });

  it('clears history once per import, with one toast', async () => {
    const t = setup();
    const first = t.importer.enqueue(t.files('a', 2));
    await t.release(2);
    await first;
    t.runFrame();
    t.editor.dispatch((s) => setBorder(s, 0.01));
    expect(t.manager.canUndo()).toBe(true);

    const done = t.importer.enqueue(t.files('b', 4));
    await t.release(2);
    // Mid-import: undo and redo are safe no-ops, history untouched.
    expect(t.manager.canUndo()).toBe(false);
    expect(t.manager.undo()).toBe('busy');
    expect(t.manager.redo()).toBe('busy');
    expect(t.toasts).toEqual([]);
    expect(t.editor.getState().canvas.borderFraction).toBe(0.01);
    await t.release(2);
    await done;
    t.runFrame();
    expect(t.toasts).toEqual(['Adding photos cleared the undo history.']);
    expect(t.manager.canUndo()).toBe(false);
    expect(t.editor.getState().photos).toHaveLength(6);
  });

  it('an import that adds nothing leaves history alone', async () => {
    const t = setup();
    const first = t.importer.enqueue(t.files('a', 2));
    await t.release(2);
    await first;
    t.runFrame();
    t.editor.dispatch((s) => setBorder(s, 0.01));
    const failed = t.importer.enqueue(t.files('y', 2, 'bad'));
    await t.release(2);
    await failed;
    t.runFrame();
    expect(t.toasts).toEqual([]);
    expect(t.manager.canUndo()).toBe(true);
  });

  it('is a boundary even if every new photo ends up excluded', async () => {
    const t = setup();
    const first = t.importer.enqueue(t.files('a', 3));
    await t.release(3);
    await first;
    t.editor.shuffle();
    expect(t.manager.canUndo()).toBe(true);
    const before = t.editor.getState();

    // One good photo, then undecodable files keep the import running.
    const done = t.importer.enqueue([
      ...t.files('b', 1),
      ...t.files('x', 3, 'bad'),
    ]);
    await t.release();
    t.photos.setAllIncluded(false); // "Remove all", mid-import
    t.runFrame();
    expect(t.editor.getState()).toBe(before);
    await t.release(3);
    await done;

    expect(t.editor.getState().photos).toHaveLength(0);
    expect(t.toasts).toEqual(['Adding photos cleared the undo history.']);
    expect(t.manager.canUndo()).toBe(false);
    expect(t.manager.undo()).toBe('empty');
    t.runFrame();
    expect(t.toasts).toHaveLength(1);

    // Re-including one of them afterwards works, and undo never throws.
    const id = t.photos.getPhotos().at(-1)?.id ?? '';
    t.photos.setIncluded(id, true);
    t.runFrame();
    expect(t.editor.getState().photos.map((p) => p.id)).toEqual([id]);
    expect(t.toasts).toHaveLength(1);
    expect(() => t.manager.undo()).not.toThrow();
    expect(() => t.manager.redo()).not.toThrow();
  });

  it('with no history, an import that adds photos gives no toast', async () => {
    const t = setup();
    const done = t.importer.enqueue(t.files('a', 2));
    await t.release(2);
    await done;
    expect(t.toasts).toEqual([]);
    expect(t.manager.canUndo()).toBe(false);
  });
});
