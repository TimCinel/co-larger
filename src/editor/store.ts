/**
 * EditorStore: holds the current EditorState and tells listeners when it
 * changes. All changes go through the pure actions in state.ts; this class
 * only adds subscribe/notify and the policy for dragging the dial. No DOM.
 *
 * Each notification says whether the change is `transient` (a step of a dial
 * drag that will be followed by a commit) or committed. Undo (#10) should
 * record committed states only, so a whole drag is one undo step.
 */
import type { PhotoShape } from '../layout';
import {
  createEditorState,
  forgetPhotos,
  isAssignmentCached,
  randomSeed,
  setPhotos,
  setVariation,
  shuffle,
  type CreateOptions,
  type EditorState,
} from './state';

export interface EditorChange {
  /** True for a dial-drag step; false once the state is committed. */
  readonly transient: boolean;
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

export interface EditorStoreOptions extends CreateOptions {
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
  private readonly listeners = new Set<EditorListener>();
  private readonly onListenerError: (error: unknown) => void;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly nextSeed: () => number;
  private cancelSettle: (() => void) | null = null;

  constructor(options: EditorStoreOptions = {}) {
    this.state = createEditorState(options);
    this.committed = this.state;
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
   * `editor.dispatch((s) => setBorder(s, 12))`. Ends any dial drag first.
   */
  dispatch(action: (state: EditorState) => EditorState): void {
    this.settleNow();
    this.set(action(this.state), false);
  }

  /** Replaces the whole state (undo, redo, loading a project). */
  replace(state: EditorState): void {
    this.dispatch(() => state);
  }

  /** Shuffle: re-roll with a fresh seed. */
  shuffle(): void {
    const seed = this.nextSeed();
    this.dispatch((state) => shuffle(state, seed));
  }

  /** Sets the photos in the collage (the store's included photos). */
  setPhotos(photos: readonly PhotoShape[]): void {
    this.dispatch((state) => setPhotos(state, photos));
  }

  /** Forgets photos removed from the store (drops their crops too). */
  forgetPhotos(ids: Iterable<string>): void {
    this.dispatch((state) => forgetPhotos(state, ids));
  }

  /**
   * A step of a dial drag. Tiles follow the dial at once. Photos keep their
   * tiles while the dial stays within a tenth (see setVariation); when it
   * crosses into another tenth they are re-assigned at once if that is
   * cheap (few photos, or the result is cached), and otherwise after the
   * dial has rested for SETTLE_MS or the drag ends, keeping the previous
   * assignment meanwhile. Either way the committed result is exactly
   * setVariation(state, value): it depends only on the final value.
   */
  dragVariation(value: number): void {
    const state = this.state;
    const defer =
      state.photos.length > DEFER_ASSIGNMENT_ABOVE &&
      !isAssignmentCached(state, value);
    this.set(setVariation(state, value, { keepAssignment: defer }), true);
    this.cancelSettle?.();
    this.cancelSettle = null;
    if (defer) {
      // Re-assign once the dial rests, still as part of the drag: the drag
      // is committed (one undo step) only when it ends.
      this.cancelSettle = this.setTimer(() => {
        this.cancelSettle = null;
        this.set(setVariation(this.state, value), true);
      }, SETTLE_MS);
    }
  }

  /** Ends a dial drag (or a keyboard step) at `value`, and commits. */
  commitVariation(value: number): void {
    this.dispatch((state) => setVariation(state, value));
  }

  /** True while a dial drag has not been committed. */
  isDragging(): boolean {
    return this.state !== this.committed;
  }

  /**
   * Ends any drag: a provisional state (one with a deferred assignment) is
   * replaced by the full result for its dial value, so no action is ever
   * applied to, and no commit ever contains, a provisional assignment.
   */
  private settleNow(): void {
    this.cancelSettle?.();
    this.cancelSettle = null;
    if (this.state !== this.committed) {
      this.state = setVariation(this.state, this.state.variation);
    }
  }

  private set(next: EditorState, transient: boolean): void {
    if (next === this.state && (transient || next === this.committed)) return;
    this.state = next;
    if (!transient) this.committed = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next, { transient });
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
