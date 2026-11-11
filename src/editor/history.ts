/**
 * Undo and redo stacks of snapshots, pure (no DOM, no store). `present` is
 * the last committed snapshot; `record` pushes the one it replaces onto the
 * undo stack and clears the redo stack. Snapshots are immutable and share
 * structure, so keeping many is cheap.
 */

/** How many undo steps are kept. Older ones are dropped. */
export const HISTORY_LIMIT = 100;

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;

  constructor(
    initial: T,
    private readonly limit = HISTORY_LIMIT,
  ) {
    this.current = initial;
  }

  /** The snapshot the history believes is on screen. */
  get present(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoCount(): number {
    return this.past.length;
  }

  get redoCount(): number {
    return this.future.length;
  }

  /**
   * A committed change to `next`: one new step, and redo is forgotten.
   * Returns false, changing nothing, if `next` is the present snapshot.
   */
  record(next: T): boolean {
    if (Object.is(next, this.current)) return false;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.current = next;
    return true;
  }

  /** Steps back. Returns the snapshot to show, or undefined if none. */
  undo(): T | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return undefined;
    this.future.push(this.current);
    this.current = previous;
    return previous;
  }

  /** Steps forward. Returns the snapshot to show, or undefined if none. */
  redo(): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  /** Forgets every step; `snapshot` becomes the present. */
  reset(snapshot: T): void {
    this.past = [];
    this.future = [];
    this.current = snapshot;
  }
}
