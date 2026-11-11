import { describe, expect, it } from 'vitest';
import { History } from './history';

describe('History', () => {
  it('records, undoes and redoes', () => {
    const h = new History('a');
    expect(h.record('b')).toBe(true);
    h.record('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.redo()).toBe('b');
    expect(h.redo()).toBe('c');
    expect(h.present).toBe('c');
  });

  it('does nothing when empty', () => {
    const h = new History('a');
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBeUndefined();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.present).toBe('a');
  });

  it('ignores a record of the present snapshot', () => {
    const h = new History('a');
    expect(h.record('a')).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it('clears redo on a new change', () => {
    const h = new History('a');
    h.record('b');
    h.undo();
    expect(h.canRedo).toBe(true);
    h.record('c');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('a');
  });

  it('drops the oldest steps past the cap', () => {
    const h = new History(0, 3);
    for (let i = 1; i <= 10; i++) h.record(i);
    expect(h.undoCount).toBe(3);
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual([
      9,
      8,
      7,
      undefined,
    ]);
  });

  it('reset forgets everything', () => {
    const h = new History('a');
    h.record('b');
    h.undo();
    h.reset('z');
    expect(h.canUndo || h.canRedo).toBe(false);
    expect(h.present).toBe('z');
  });
});
