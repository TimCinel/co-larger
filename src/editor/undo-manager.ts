/**
 * UndoManager: records the EditorStore's committed changes in a History and
 * applies undo and redo through `EditorStore.restore`. No DOM.
 *
 * Behaviour (also summarised in store.ts):
 * - One entry per committed notification. Transient notifications (steps of
 *   a drag) are never recorded; a gesture is one entry when it commits.
 * - Undo and redo are not recorded: restores are ignored. A restore from
 *   anywhere else (opening a project) resets the history.
 * - Unfinished gesture: before applying a step, `prepare` lets the view end
 *   its gestures, then any state still mid-gesture is committed as its own
 *   entry (`EditorStore.commitPending`); only then is the step applied. So
 *   nothing is lost silently and the store is never left mid-gesture.
 * - Photos added to or removed from the PhotoStore (an import) are a
 *   boundary: the history is cleared. The commit that follows an import
 *   (the tray sync that re-rolls with the new photos) becomes the new
 *   baseline instead of a step. So undo never crosses an import, and a
 *   snapshot never meets a store that has lost one of its photos. Photos
 *   imported while earlier steps exist cannot be un-added, and the tray and
 *   editor always agree because `restore` sets the include flags.
 */
import type { PhotoStore } from '../photos';
import { History, HISTORY_LIMIT } from './history';
import type { EditorState } from './state';
import type { EditorStore } from './store';

export interface UndoManagerOptions {
  readonly editor: EditorStore;
  readonly photos: Pick<PhotoStore, 'subscribe'>;
  /**
   * Runs before a step: ends the view's own gestures and applies queued
   * tray syncs (so a finished import is a boundary first).
   */
  readonly prepare?: () => void;
  readonly limit?: number;
}

export type StepResult = 'done' | 'empty' | 'failed';

export class UndoManager {
  private readonly history: History<EditorState>;
  private readonly editor: EditorStore;
  private readonly prepare: () => void;
  private applying = false;
  /** Photos imported whose first commit has not happened yet. */
  private unseen = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(options: UndoManagerOptions) {
    this.editor = options.editor;
    this.prepare = options.prepare ?? (() => undefined);
    this.history = new History(
      this.editor.getState(),
      options.limit ?? HISTORY_LIMIT,
    );
    this.editor.subscribe((state, change) => {
      if (change.transient) {
        this.changed();
        return;
      }
      if (this.applying) return;
      if (change.restored) {
        this.history.reset(state);
      } else if (state.photos.some((photo) => this.unseen.has(photo.id))) {
        this.unseen.clear();
        this.history.reset(state);
      } else {
        this.history.record(state);
      }
      this.changed();
    });
    options.photos.subscribe((change) => {
      if (change.kind === 'included') return;
      if (change.kind === 'added') {
        for (const id of change.ids) this.unseen.add(id);
      }
      // For removals the editor has already forgotten the photos (it
      // subscribed first), so the present state is the baseline.
      this.history.reset(this.editor.getState());
      this.changed();
    });
  }

  /** Undo is possible, counting a gesture still to be committed. */
  canUndo(): boolean {
    return this.history.canUndo || this.editor.isDragging();
  }

  canRedo(): boolean {
    return this.history.canRedo && !this.editor.isDragging();
  }

  /** Calls `listener` whenever availability may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  undo(): StepResult {
    return this.step(true);
  }

  redo(): StepResult {
    return this.step(false);
  }

  private step(back: boolean): StepResult {
    this.prepare();
    // An unfinished gesture becomes its own entry first.
    this.editor.commitPending();
    const target = back ? this.history.undo() : this.history.redo();
    if (target === undefined) return 'empty';
    this.applying = true;
    try {
      this.editor.restore(target);
      return 'done';
    } catch {
      // The snapshot cannot be shown (a photo is gone): start afresh.
      this.history.reset(this.editor.getState());
      return 'failed';
    } finally {
      this.applying = false;
      this.changed();
    }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
