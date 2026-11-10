/**
 * The dial's gesture logic, separate from the DOM so it can be tested in
 * Node: turns the events a range input fires into drag steps and exactly one
 * commit per gesture.
 *
 * Browsers fire `input` for every movement and `change` when a pointer drag
 * ends or a key changes the value, but `change` does not fire when a drag
 * ends where it started, and neither fires when the drag is cancelled
 * (pointercancel, lost capture, the window losing focus). So every event
 * that can end a gesture calls `end`, and a commit at the value already
 * committed changes nothing and notifies nobody: however many of those
 * events arrive, the gesture commits once.
 */
import type { FrameScheduler } from './frames';
import type { EditorStore } from './store';

export type DialEditor = Pick<
  EditorStore,
  'dragVariation' | 'commitVariation' | 'isDragging'
>;

export class DialInput {
  private pending: number | null = null;

  constructor(
    private readonly editor: DialEditor,
    private readonly frames: Pick<FrameScheduler, 'request' | 'cancel'>,
  ) {}

  /** The dial moved (`input`). Applied at most once per frame. */
  move(value: number): void {
    this.pending = value;
    this.frames.request('dial', () => {
      this.pending = null;
      this.editor.dragVariation(value);
    });
  }

  /**
   * The gesture ended at `value`: on `change`, `pointerup`,
   * `pointercancel`, `lostpointercapture`, `blur` or Escape. Commits once.
   */
  end(value: number): void {
    this.frames.cancel('dial');
    this.pending = null;
    this.editor.commitVariation(value);
  }

  /** True while a move is waiting for its frame or a drag is uncommitted. */
  isBusy(): boolean {
    return this.pending !== null || this.editor.isDragging();
  }
}
