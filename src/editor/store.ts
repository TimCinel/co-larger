/**
 * EditorStore: holds the current EditorState, keeps it in step with the
 * PhotoStore, and tells listeners when it changes. All changes go through
 * the pure actions in state.ts. No DOM.
 *
 * ## Two stores, and which is the source of truth for what
 *
 * - The PhotoStore owns the photos themselves: original files, preview and
 *   thumbnail blobs, ids, sizes, and the include flags the tray shows. It is
 *   the source of truth for which photos exist.
 * - The EditorState owns everything about the collage: canvas settings, dial,
 *   seed, plan, assignment and crops. It also mirrors the included photos'
 *   ids and aspects (`state.photos`), which the arrangement is built from.
 *
 * The included set lives in both, and is kept equal in both directions:
 *
 * - Store to editor (the user toggled photos in the tray, or imported more):
 *   the editor's photos are set from the store's included photos, which
 *   re-rolls if the set changed (setPhotos). This runs once per frame (or
 *   microtask) after store changes, so an import of many photos re-rolls
 *   once per frame, not once per photo.
 * - Editor to store (undo, redo, opening a project): {@link
 *   EditorStore.restore} replaces the whole snapshot and sets the store's
 *   include flags to match it in one step. The sync then finds the sets
 *   equal, so nothing re-rolls and the restored arrangement, swaps and crops
 *   survive.
 *
 * Rules for later issues:
 *
 * - Undo (#10) records committed snapshots (see EditorChange) and restores
 *   them with `restore`. Excluding a photo is undoable. Removing a photo from
 *   the PhotoStore entirely is not: its blobs are gone, and restoring a
 *   snapshot that still names it throws.
 * - Opening a project (#12) must add the photos to the PhotoStore under
 *   their saved ids (`PhotoStore.addPhotos` accepts an `id`), because the
 *   assignment and crops refer to photos by id (and assignment's seeded
 *   variety hashes the id), then validateEditorState and `restore`.
 *
 * Behaviour #10 should decide deliberately (documented, not yet chosen):
 *
 * - `restore` during an import excludes photos already imported that the
 *   snapshot does not name: they stay in the tray, unticked, with no notice.
 * - A tray sync (a toggle, or an import finishing) that lands mid-drag
 *   commits the partial drag, so one physical drag can then give two
 *   committed states.
 *
 * Each notification says whether the change is `transient` (a step of a dial
 * drag that will be followed by a commit), committed, or a restore. One user
 * gesture gives exactly one committed notification; an action that changes
 * nothing gives none.
 */
import type { PhotoStore } from '../photos';
import {
  createEditorState,
  forgetPhotos,
  isAssignmentCached,
  randomSeed,
  rearrange,
  setPhotos,
  setVariation,
  shuffle,
  type CreateOptions,
  type EditorState,
} from './state';

export interface EditorChange {
  /** True for a dial-drag step; false once the state is committed. */
  readonly transient: boolean;
  /**
   * True when the snapshot was put back by `restore` (undo, redo, load):
   * undo history should not record it as a new step.
   */
  readonly restored: boolean;
}

export type EditorListener = (state: EditorState, change: EditorChange) => void;

/**
 * Above this many photos, assignment (cubic in the count) takes long enough
 * to drop frames (about 5 ms at 150 photos, 20 ms at 300 on a fast laptop),
 * so during a drag it is deferred: see dragVariation.
 */
export const DEFER_ASSIGNMENT_ABOVE = 150;

/** How long the dial must rest before a deferred assignment runs. */
export const SETTLE_MS = 150;

/** The parts of the PhotoStore the editor uses. */
export type EditorPhotoSource = Pick<
  PhotoStore,
  'getPhoto' | 'getPlacementPhotos' | 'setIncludedIds' | 'subscribe'
>;

export interface EditorStoreOptions extends CreateOptions {
  /**
   * The photo store to keep in step with (see the module comment). Its
   * included photos become the initial photos (overriding `photos`).
   */
  readonly photoStore?: EditorPhotoSource;
  /**
   * Runs the store-to-editor sync after a store change. Defaults to a
   * microtask; the app passes an animation-frame scheduler.
   */
  readonly scheduleSync?: (sync: () => void) => void;
  /** Called with anything a listener throws. Defaults to console.error. */
  readonly onListenerError?: (error: unknown) => void;
  /** Timer for settling a drag. Defaults to setTimeout. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
  /** Source of seeds for Shuffle. Defaults to a random seed. */
  readonly nextSeed?: () => number;
}

export class EditorStore {
  private state: EditorState;
  private committed: EditorState;
  /** The state holds a deferred (not yet canonical) assignment. */
  private provisional = false;
  private syncQueued = false;
  private readonly photoStore: EditorPhotoSource | undefined;
  private readonly scheduleSync: (sync: () => void) => void;
  private readonly listeners = new Set<EditorListener>();
  private readonly onListenerError: (error: unknown) => void;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly nextSeed: () => number;
  private cancelSettle: (() => void) | null = null;

  constructor(options: EditorStoreOptions = {}) {
    this.photoStore = options.photoStore;
    this.state = createEditorState({
      ...options,
      photos: this.photoStore?.getPlacementPhotos() ?? options.photos,
    });
    this.committed = this.state;
    this.scheduleSync =
      options.scheduleSync ??
      ((sync) => {
        queueMicrotask(sync);
      });
    this.onListenerError =
      options.onListenerError ??
      ((error) => {
        console.error('Editor listener failed', error);
      });
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        return () => {
          clearTimeout(handle);
        };
      });
    this.nextSeed = options.nextSeed ?? randomSeed;
    this.photoStore?.subscribe((change) => {
      if (change.kind === 'removed') {
        // At once: the photos' blobs are gone, so they must leave the
        // collage (and their crops be forgotten) before the next draw.
        this.dispatch((state) => forgetPhotos(state, change.ids));
      } else {
        this.queueSync();
      }
    });
  }

  getState(): EditorState {
    return this.state;
  }

  /** Calls `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: EditorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies a pure action and commits the result: for example
   * `editor.dispatch((s) => setBorder(s, 0.01))`. Ends any dial drag first
   * (so the drag is committed with it). If neither the action nor a drag
   * changed anything, nobody is notified.
   */
  dispatch(action: (state: EditorState) => EditorState): void {
    this.settleNow();
    this.set(action(this.state), false);
  }

  /**
   * Puts back a whole snapshot (undo, redo, opening a project) without
   * re-rolling, and sets the PhotoStore's include flags to match it: its
   * `photos` become exactly the included photos. Ends any drag.
   *
   * Throws, changing nothing, if the snapshot names a photo the PhotoStore
   * does not have (or one with a different aspect ratio). Snapshots from
   * outside (a saved project) must be checked with validateEditorState
   * first.
   */
  restore(snapshot: EditorState): void {
    const store = this.photoStore;
    if (store) {
      const ids = [
        ...snapshot.photos.map((photo) => photo.id),
        ...snapshot.assignment,
      ];
      for (const id of ids) {
        const photo = store.getPhoto(id);
        if (!photo) {
          throw new Error(
            `Cannot restore: photo ${JSON.stringify(id)} is not in the photo store`,
          );
        }
      }
      for (const { id, aspect } of snapshot.photos) {
        const actual = store.getPhoto(id)?.aspect ?? aspect;
        if (Math.abs(actual / aspect - 1) > 1e-9) {
          throw new Error(
            `Cannot restore: photo ${JSON.stringify(id)} has a different shape`,
          );
        }
      }
    }
    this.cancelSettle?.();
    this.cancelSettle = null;
    this.provisional = false;
    const changed = snapshot !== this.state || snapshot !== this.committed;
    this.state = snapshot;
    this.committed = snapshot;
    // The store notifies synchronously; the sync it queues will find the
    // sets equal and do nothing.
    store?.setIncludedIds(snapshot.photos.map((photo) => photo.id));
    if (changed) this.notify({ transient: false, restored: true });
  }

  /** Shuffle: re-roll with a fresh seed. */
  shuffle(): void {
    let seed = this.nextSeed();
    if (seed === this.state.seed) seed = this.nextSeed();
    this.dispatch((state) => shuffle(state, seed));
  }

  /**
   * A step of a dial drag. Tiles follow the dial at once. Photos keep their
   * tiles while the dial stays within a tenth (see setVariation); when it
   * crosses into another tenth they are re-assigned at once if that is
   * cheap (few photos, or the result is cached), and otherwise after the
   * dial has rested for SETTLE_MS or the drag ends, keeping the previous
   * assignment meanwhile. Either way the committed result is exactly
   * setVariation(start, finalValue): it depends only on the final value.
   */
  dragVariation(value: number): void {
    const state = this.state;
    const defer =
      state.photos.length > DEFER_ASSIGNMENT_ABOVE &&
      !isAssignmentCached(state, value);
    let next = setVariation(state, value, { keepAssignment: defer });
    if (defer) {
      if (next !== state) this.provisional = true;
    } else {
      if (next === state && this.provisional) next = rearrange(state);
      this.provisional = false;
    }
    this.cancelSettle?.();
    this.cancelSettle = null;
    if (this.provisional) {
      // Re-assign once the dial rests, still as part of the drag: the drag
      // is committed (one undo step) only when it ends.
      this.cancelSettle = this.setTimer(() => {
        this.cancelSettle = null;
        if (!this.provisional) return;
        this.provisional = false;
        this.set(rearrange(this.state), true);
      }, SETTLE_MS);
    }
    this.set(next, true);
  }

  /**
   * Ends a dial drag (or a keyboard step) at `value`, and commits. Calling
   * it again with the same value does nothing, so the several events that
   * can end one gesture (change, pointerup, blur) commit it only once.
   */
  commitVariation(value: number): void {
    this.dispatch((state) => setVariation(state, value));
  }

  /** True while a dial drag has not been committed. */
  isDragging(): boolean {
    return this.state !== this.committed;
  }

  private queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    this.scheduleSync(() => {
      this.syncQueued = false;
      const store = this.photoStore;
      if (store) {
        this.dispatch((state) => setPhotos(state, store.getPlacementPhotos()));
      }
    });
  }

  /**
   * Ends any drag: a provisional state (one with a deferred assignment) is
   * replaced by the full result for its dial value, so no action is ever
   * applied to, and no commit ever contains, a provisional assignment.
   */
  private settleNow(): void {
    this.cancelSettle?.();
    this.cancelSettle = null;
    if (this.provisional) {
      this.provisional = false;
      this.state = rearrange(this.state);
    }
  }

  private set(next: EditorState, transient: boolean): void {
    if (next === this.state && (transient || next === this.committed)) return;
    this.state = next;
    if (!transient) this.committed = next;
    this.notify({ transient, restored: false });
  }

  private notify(change: EditorChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state, change);
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // The error handler itself failed; nothing more to do.
        }
      }
    }
  }
}
