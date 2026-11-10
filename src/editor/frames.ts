/**
 * Coalesces work into animation frames. Each kind of task runs at most once
 * per frame, in a fixed order, so input handled in a frame (photo changes,
 * control drags) is drawn in the same frame rather than the next.
 */

/**
 * Task kinds, in the order they run within a frame. Each continuous control
 * (see GestureInput) has its own kind, so two controls never replace each
 * other's queued step.
 */
export type FrameTask = 'photos' | 'dial' | 'border' | 'background' | 'render';
const ORDER: readonly FrameTask[] = [
  'photos',
  'dial',
  'border',
  'background',
  'render',
];

export interface FrameHost {
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export class FrameScheduler {
  private readonly tasks = new Map<FrameTask, () => void>();
  private pending = false;

  constructor(private readonly host: FrameHost) {}

  /** Runs `task` in the next frame, replacing any `kind` task already queued. */
  request(kind: FrameTask, task: () => void): void {
    this.tasks.set(kind, task);
    if (this.pending) return;
    this.pending = true;
    this.host.requestAnimationFrame(() => {
      this.flush();
    });
  }

  /** Drops a queued task. */
  cancel(kind: FrameTask): void {
    this.tasks.delete(kind);
  }

  /** Runs every queued task now, in order (also used by the frame callback). */
  flush(): void {
    this.pending = false;
    // A task may queue a later one (a dial move queues a render): it still
    // runs in this flush, because later kinds are looked up afterwards.
    for (const kind of ORDER) {
      const task = this.tasks.get(kind);
      if (!task) continue;
      this.tasks.delete(kind);
      task();
    }
  }
}
