import { describe, expect, it } from 'vitest';
import { swapSlots, type PhotoShape } from '../layout';
import { DialInput } from './dial';
import { FrameScheduler } from './frames';
import { setVariation } from './state';
import { DEFER_ASSIGNMENT_ABOVE, EditorStore } from './store';

function makePhotos(count: number): PhotoShape[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: i % 2 ? 0.75 : 1.5,
  }));
}

/**
 * The dial as the browser drives it: `move` for each `input` event, `end`
 * for each of `change`, `pointerup`, `pointercancel`, `blur` or Escape.
 */
function setup(count = 12) {
  const frameCallbacks: FrameRequestCallback[] = [];
  const frames = new FrameScheduler({
    requestAnimationFrame: (cb) => frameCallbacks.push(cb),
  });
  const timers: (() => void)[] = [];
  const editor = new EditorStore({
    seed: 3,
    variation: 0.5,
    photos: makePhotos(count),
    setTimer: (cb) => {
      timers.push(cb);
      return () => {
        const i = timers.indexOf(cb);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  let commits = 0;
  let steps = 0;
  editor.subscribe((_, change) => {
    if (change.transient) steps++;
    else commits++;
  });
  const dial = new DialInput(editor, frames);
  const frame = (): void => {
    for (const cb of frameCallbacks.splice(0)) cb(0);
  };
  return {
    editor,
    dial,
    frame,
    timers,
    commits: () => commits,
    steps: () => steps,
  };
}

describe('DialInput: one commit per gesture', () => {
  it('a mouse drag: many moves, then pointerup and change', () => {
    const { editor, dial, frame, commits, steps } = setup();
    const start = editor.getState();
    for (const v of [0.52, 0.55, 0.61, 0.7, 0.68, 0.73]) {
      dial.move(v);
      dial.move(v + 0.001); // two inputs in one frame
      frame();
    }
    dial.move(0.74);
    // Chrome: pointerup, then change, for the same final value.
    dial.end(0.74);
    dial.end(0.74);
    frame();
    expect(commits()).toBe(1);
    expect(steps()).toBe(6);
    expect(editor.isDragging()).toBe(false);
    expect(JSON.stringify(editor.getState())).toBe(
      JSON.stringify(setVariation(start, 0.74)),
    );
  });

  it('the same drag in the other event order (change, then pointerup)', () => {
    const { dial, frame, commits } = setup();
    dial.move(0.2);
    frame();
    dial.end(0.2);
    dial.end(0.2);
    expect(commits()).toBe(1);
  });

  it('a click that moves the dial: input, pointerup, change', () => {
    const { dial, frame, commits } = setup();
    dial.move(0.9);
    dial.end(0.9);
    dial.end(0.9);
    frame();
    expect(commits()).toBe(1);
  });

  it('a click on the current value commits nothing', () => {
    const { dial, frame, commits, steps } = setup();
    dial.end(0.5);
    frame();
    expect(commits()).toBe(0);
    expect(steps()).toBe(0);
  });

  it('a drag that returns to where it started commits once (no change event)', () => {
    const { editor, dial, frame, commits } = setup();
    const start = editor.getState();
    dial.move(0.8);
    frame();
    dial.move(0.5);
    frame();
    dial.end(0.5); // pointerup only
    expect(commits()).toBe(1);
    expect(JSON.stringify(editor.getState())).toBe(JSON.stringify(start));
  });

  it('keyboard: each arrow press is input + change, one commit each', () => {
    const { editor, dial, frame, commits } = setup();
    let v = 0.5;
    for (let i = 0; i < 5; i++) {
      v = Math.round((v + 0.01) * 100) / 100;
      dial.move(v);
      dial.end(v);
      frame();
    }
    expect(commits()).toBe(5);
    expect(editor.getState().variation).toBe(0.55);
  });

  it('a cancelled drag (pointercancel, then blur) commits once', () => {
    const { editor, dial, frame, commits } = setup();
    dial.move(0.3);
    frame();
    dial.move(0.25);
    dial.end(0.25); // pointercancel
    dial.end(0.25); // blur
    frame();
    expect(commits()).toBe(1);
    expect(editor.isDragging()).toBe(false);
    expect(editor.getState().variation).toBe(0.25);
  });

  it('Escape mid-drag commits once at the dial’s value', () => {
    const { editor, dial, frame, commits } = setup();
    dial.move(0.1);
    frame();
    dial.end(0.1); // Escape
    dial.end(0.1); // later blur
    expect(commits()).toBe(1);
    expect(editor.isDragging()).toBe(false);
  });

  it('a deferred (large) drag commits once, and settles first', () => {
    const { editor, dial, frame, commits } = setup(DEFER_ASSIGNMENT_ABOVE + 1);
    const start = editor.getState();
    dial.move(0.05);
    frame();
    dial.move(0.95);
    frame();
    dial.end(0.95);
    dial.end(0.95);
    expect(commits()).toBe(1);
    expect(JSON.stringify(editor.getState())).toBe(
      JSON.stringify(setVariation(start, 0.95)),
    );
  });

  it('ending a gesture at the current value keeps a manual swap', () => {
    const { editor, dial, commits } = setup();
    editor.dispatch((s) => ({
      ...s,
      assignment: swapSlots(s.assignment, 0, 1),
    }));
    const swapped = editor.getState();
    dial.end(0.5);
    expect(editor.getState()).toBe(swapped);
    expect(commits()).toBe(1); // the swap itself
  });

  it('isBusy covers a move waiting for its frame and an uncommitted drag', () => {
    const { dial, frame } = setup();
    expect(dial.isBusy()).toBe(false);
    dial.move(0.6);
    expect(dial.isBusy()).toBe(true);
    frame();
    expect(dial.isBusy()).toBe(true);
    dial.end(0.6);
    expect(dial.isBusy()).toBe(false);
  });
});
