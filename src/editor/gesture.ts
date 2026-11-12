/**
 * The gesture logic shared by every continuous control (the size-variation
 * dial, the border slider, the colour picker), separate from the DOM so it
 * can be tested in Node: turns the events an input fires into drag steps
 * and exactly one commit per gesture.
 *
 * Browsers fire `input` for every movement and `change` when a pointer drag
 * ends, a key changes the value or (for a colour picker) the picker closes,
 * but `change` does not fire when a drag ends where it started, and neither
 * fires when the drag is cancelled (pointercancel, lost capture, the window
 * losing focus). So every event that can end a gesture calls `end`, and a
 * commit at the value already committed changes nothing and notifies nobody:
 * however many of those events arrive, the gesture commits once.
 *
 * `end` commits only while this gesture has something to end: a step still
 * waiting for its frame, or a drag the store has not committed. So an event
 * that merely ends focus (a blur after tabbing through) never commits the
 * control's displayed value over a stored one it could not show, and a
 * commit that came from elsewhere meanwhile (Shuffle, a swatch) leaves
 * nothing for a late end event to commit again. It is derived from the store,
 * not remembered, so it cannot go stale.
 */
import type { FrameScheduler, FrameTask } from './frames';

/** What a gesture drives: usually a few methods of the EditorStore. */
export interface GestureTarget<T> {
  /** A step of the gesture (transient notification). */
  drag(value: T): void;
  /** The end of the gesture: commits `value`. Idempotent at that value. */
  commit(value: T): void;
  /** True while a drag has not been committed. */
  isDragging(): boolean;
  /** Puts back the committed state, for `GestureInput.cancel`. Optional. */
  cancel?(): void;
}

export class GestureInput<T> {
  private pending: { readonly value: T } | null = null;

  constructor(
    private readonly target: GestureTarget<T>,
    private readonly frames: Pick<FrameScheduler, 'request' | 'cancel'>,
    /** The frame task this control's steps run as: one per control. */
    private readonly kind: FrameTask,
  ) {}

  /** The control moved (`input`). Applied at most once per frame. */
  move(value: T): void {
    this.pending = { value };
    this.frames.request(this.kind, () => {
      this.pending = null;
      this.target.drag(value);
    });
  }

  /**
   * The gesture ended at `value`: on `change`, `pointerup`,
   * `pointercancel`, `lostpointercapture` or `blur`. Commits once. (Not on
   * Escape: the pointer may still be down, so the drag would carry on.)
   */
  end(value: T): void {
    this.frames.cancel(this.kind);
    const hadPending = this.pending !== null;
    this.pending = null;
    if (!hadPending && !this.target.isDragging()) return;
    this.target.commit(value);
  }

  /**
   * Abandons the gesture (Escape during a divider drag, #16): drops a step
   * still waiting for its frame and lets the target put back what was
   * committed. Nothing is committed.
   */
  cancel(): void {
    this.frames.cancel(this.kind);
    this.pending = null;
    this.target.cancel?.();
  }

  /** True while a move is waiting for its frame or a drag is uncommitted. */
  isBusy(): boolean {
    return this.pending !== null || this.target.isDragging();
  }
}
