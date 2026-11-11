/**
 * UndoManager: records the EditorStore's committed changes in a History and
 * applies undo and redo through `EditorStore.restore`. No DOM.
 *
 * Behaviour (also summarised in store.ts):
 * - One entry per committed notification. Transient notifications (steps of
 *   a drag) are never recorded; a gesture is one entry when it commits.
 * - Undo and redo are not recorded: restores are ignored. A restore from
 *   anywhere else (opening a project) resets the history.
 * - Pointer held in a continuous gesture (dial, sliders, crop pan): undo
 *   and redo do nothing (`isGestureHeld`); the gesture commits once on
 *   release as usual.
 * - Uncommitted change with no pointer held (a wheel burst inside its quiet
 *   window, a run of keys, a colour picker closed on its starting colour):
 *   before applying a step, `prepare` lets the view end its gestures, then
 *   any state still mid-gesture is committed as its own entry
 *   (`EditorStore.commitPending`); only then is the step applied. So
 *   nothing is lost silently and the store is never left mid-gesture.
 * - Photos added to or removed from the PhotoStore (an import) are a
 *   boundary: the history is cleared. The commit that follows an import
 *   (the tray sync that re-rolls with the new photos) becomes the new
 *   baseline instead of a step. A toast says so (`onHistoryCleared`) when
 *   steps were lost; none if the history was already empty. So undo never crosses an import, and a
 *   snapshot never meets a store that has lost one of its photos. Photos
 *   imported while earlier steps exist cannot be un-added, and the tray and
 *   editor always agree because `restore` sets the include flags.
 */
import type { PhotoStore } from '../photos';
import { History, HISTORY_LIMIT } from './history';
import type { EditorState } from './state';
import type { EditorStore, ImportActivity } from './store';

export interface UndoManagerOptions {
  readonly editor: EditorStore;
  readonly photos: Pick<PhotoStore, 'subscribe' | 'getPhoto'>;
  /**
   * Runs before a step: ends the view's own gestures and applies queued
   * tray syncs (so a finished import is a boundary first).
   */
  readonly prepare?: () => void;
  readonly limit?: number;
  /**
   * While an import runs, undo and redo do nothing, and adding photos is
   * not a boundary yet: the commit that lays out the whole import is.
   */
  readonly imports?: ImportActivity;
  /**
   * True while a pointer is held down in a continuous gesture (a drag of
   * the dial, a slider or the crop). Undo and redo then do nothing, so the
   * gesture carries on and commits once on release.
   */
  readonly isGestureHeld?: () => boolean;
  /**
   * Called when adding or removing photos clears a history that had steps
   * in it (never when it was already empty), with the message to show.
   */
  readonly onHistoryCleared?: (message: string) => void;
}

export type StepResult = 'done' | 'empty' | 'failed' | 'busy';

export class UndoManager {
  private readonly history: History<EditorState>;
  private readonly editor: EditorStore;
  private readonly prepare: () => void;
  private readonly isGestureHeld: () => boolean;
  private readonly onHistoryCleared: (message: string) => void;
  private readonly photos: UndoManagerOptions['photos'];
  private readonly imports: ImportActivity | undefined;
  private applying = false;
  /** Photos imported whose first commit has not happened yet. */
  private unseen = new Set<string>();
  /** Photos were added during the running import: it is a boundary. */
  private importAdded = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: UndoManagerOptions) {
    this.editor = options.editor;
    this.prepare = options.prepare ?? (() => undefined);
    this.isGestureHeld = options.isGestureHeld ?? (() => false);
    this.onHistoryCleared = options.onHistoryCleared ?? (() => undefined);
    this.photos = options.photos;
    this.imports = options.imports;
    this.history = new History(
      this.editor.getState(),
      options.limit ?? HISTORY_LIMIT,
    );
    this.imports?.subscribe(() => {
      if (!this.imports?.isBusy() && this.importAdded) {
        // The editor has just made its one sync (it subscribed first). The
        // boundary holds even if that changed nothing, for example when
        // every new photo was excluded meanwhile.
        this.importAdded = false;
        this.unseen.clear();
        if (!this.applying) this.boundary(this.editor.getState(), 'Adding');
      }
      this.changed();
    });
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
        this.boundary(state, 'Adding');
      } else if (this.namesMissingPhoto(this.history.present)) {
        // The editor forgot photos the store has dropped: not a step.
        this.boundary(state, 'Removing');
      } else {
        this.history.record(state);
      }
      this.changed();
    });
    options.photos.subscribe((change) => {
      if (change.kind === 'included') return;
      if (change.kind === 'added') {
        for (const id of change.ids) this.unseen.add(id);
        // Mid-import the collage does not change; the commit that lays out
        // the whole import is the boundary (once, with one toast).
        if (this.imports?.isBusy()) {
          this.importAdded = true;
          return;
        }
      }
      // For removals the editor has already forgotten the photos (it
      // subscribed first, and the listener above treated that as the
      // boundary), so the present state is the baseline.
      this.boundary(
        this.editor.getState(),
        change.kind === 'added' ? 'Adding' : 'Removing',
      );
    });
  }

  /** Undo is possible, counting a gesture still to be committed. */
  canUndo(): boolean {
    if (this.isGestureHeld() || this.imports?.isBusy()) return false;
    return this.history.canUndo || this.editor.isDragging();
  }

  canRedo(): boolean {
    if (this.isGestureHeld() || this.imports?.isBusy()) return false;
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

  /** Tells listeners availability may have changed (a pointer moved). */
  refresh(): void {
    this.changed();
  }

  private boundary(state: EditorState, verb: 'Adding' | 'Removing'): void {
    const had = this.history.canUndo || this.history.canRedo;
    this.history.reset(state);
    if (had) {
      this.onHistoryCleared(`${verb} photos cleared the undo history.`);
    }
    this.changed();
  }

  private namesMissingPhoto(state: EditorState): boolean {
    const ids = [
      ...state.photos.map((photo) => photo.id),
      ...state.assignment,
      ...Object.keys(state.crops),
    ];
    return ids.some((id) => !this.photos.getPhoto(id));
  }

  private step(back: boolean): StepResult {
    // A pointer drag in progress is left alone: it commits once on release.
    if (this.isGestureHeld() || this.imports?.isBusy()) return 'busy';
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
