import { describe, expect, it } from 'vitest';
import { FrameScheduler } from './frames';
import { GestureInput } from './gesture';
import {
  createEditorState,
  setBackground,
  setBorder,
  type EditorState,
} from './state';
import { EditorStore } from './store';

function setup() {
  const callbacks: FrameRequestCallback[] = [];
  const frames = new FrameScheduler({
    requestAnimationFrame: (cb) => callbacks.push(cb),
  });
  const photos = Array.from({ length: 10 }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: i % 2 ? 0.75 : 1.5,
  }));
  const editor = new EditorStore({ seed: 5, photos });
  let commits = 0;
  let steps = 0;
  editor.subscribe((_, change) => {
    if (change.transient) steps++;
    else commits++;
  });
  const border = new GestureInput<number>(
    {
      drag: (v) => {
        editor.drag((s) => setBorder(s, v));
      },
      commit: (v) => {
        editor.dispatch((s) => setBorder(s, v));
      },
      isDragging: () => editor.isDragging(),
    },
    frames,
    'border',
  );
  const colour = new GestureInput<string>(
    {
      drag: (v) => {
        editor.drag((s) => setBackground(s, v));
      },
      commit: (v) => {
        editor.dispatch((s) => setBackground(s, v));
      },
      isDragging: () => editor.isDragging(),
    },
    frames,
    'background',
  );
  const frame = (): void => {
    for (const cb of callbacks.splice(0)) cb(0);
  };
  return {
    editor,
    border,
    colour,
    frame,
    commits: () => commits,
    steps: () => steps,
  };
}

const arrangement = (s: EditorState): string =>
  JSON.stringify({ plan: s.plan, assignment: s.assignment });

describe('GestureInput on the border slider', () => {
  it('a drag: transient steps while it moves, then exactly one commit', () => {
    const { editor, border, frame, commits, steps } = setup();
    const start = editor.getState();
    for (const v of [0.005, 0.01, 0.02, 0.015, 0.03]) {
      border.move(v);
      border.move(v + 0.0001); // two inputs in one frame: one step
      frame();
    }
    expect(steps()).toBe(5);
    expect(commits()).toBe(0);
    expect(editor.isDragging()).toBe(true);
    // pointerup, then change, then a later blur
    border.end(0.03);
    border.end(0.03);
    border.end(0.03);
    frame();
    expect(commits()).toBe(1);
    expect(editor.isDragging()).toBe(false);
    expect(editor.getState().canvas.borderFraction).toBe(0.03);
    expect(arrangement(editor.getState())).toBe(arrangement(start));
  });

  it('the committed state depends only on the final value', () => {
    const a = setup();
    const b = setup();
    for (const v of [0.2, 0.01, 0.1, 0.04]) {
      a.border.move(v);
      a.frame();
    }
    a.border.end(0.04);
    b.border.move(0.04);
    b.border.end(0.04);
    expect(JSON.stringify(a.editor.getState())).toBe(
      JSON.stringify(b.editor.getState()),
    );
  });

  it('a drag that returns to its start commits once', () => {
    const { editor, border, frame, commits } = setup();
    border.move(0.05);
    frame();
    border.move(0);
    frame();
    border.end(0);
    expect(commits()).toBe(1);
    expect(editor.getState().canvas.borderFraction).toBe(0);
    expect(editor.isDragging()).toBe(false);
  });

  it('ending without any movement (a click on the thumb, a blur) commits nothing', () => {
    const { border, frame, commits, steps } = setup();
    border.end(0.12);
    border.end(0.12);
    frame();
    expect(commits()).toBe(0);
    expect(steps()).toBe(0);
  });

  it('keyboard: each key press is input then change, one commit each', () => {
    const { editor, border, frame, commits } = setup();
    let v = 0;
    for (let i = 0; i < 4; i++) {
      v = Math.round((v + 0.001) * 1000) / 1000;
      border.move(v);
      border.end(v);
      frame();
    }
    expect(commits()).toBe(4);
    expect(editor.getState().canvas.borderFraction).toBe(0.004);
  });

  it('a move still waiting for its frame is dropped by end, which commits the final value', () => {
    const { editor, border, frame, commits, steps } = setup();
    border.move(0.07);
    expect(border.isBusy()).toBe(true);
    border.end(0.07);
    frame();
    expect(steps()).toBe(0);
    expect(commits()).toBe(1);
    expect(editor.getState().canvas.borderFraction).toBe(0.07);
    expect(border.isBusy()).toBe(false);
  });

  it('a stored request above the slider maximum survives tabbing through the slider', () => {
    const { editor, border, frame, commits } = setup();
    editor.dispatch((s) => setBorder(s, 0.2));
    const before = commits();
    // Focus, then blur with the slider showing its clamped value.
    border.end(0.08);
    frame();
    expect(commits()).toBe(before);
    expect(editor.getState().canvas.borderFraction).toBe(0.2);
  });

  it('isBusy covers a waiting move and an uncommitted drag', () => {
    const { border, frame } = setup();
    expect(border.isBusy()).toBe(false);
    border.move(0.01);
    expect(border.isBusy()).toBe(true);
    frame();
    expect(border.isBusy()).toBe(true);
    border.end(0.01);
    expect(border.isBusy()).toBe(false);
  });
});

describe('GestureInput on the colour picker', () => {
  it('many input events while the picker is open, then change: one commit', () => {
    const { editor, colour, frame, commits, steps } = setup();
    const start = editor.getState();
    for (const c of ['#101010', '#203040', '#405060', '#ff8800', '#336699']) {
      colour.move(c);
      frame();
    }
    expect(commits()).toBe(0);
    expect(steps()).toBe(5);
    colour.end('#336699'); // change
    colour.end('#336699'); // blur
    expect(commits()).toBe(1);
    expect(editor.getState().canvas.background).toBe('#336699');
    expect(arrangement(editor.getState())).toBe(arrangement(start));
    expect(editor.isDragging()).toBe(false);
  });

  it('a picker closed on the colour it opened with commits nothing', () => {
    const { colour, commits } = setup();
    colour.end('#ffffff');
    expect(commits()).toBe(0);
  });

  it('the border and the colour are separate gestures with their own commits', () => {
    const { editor, border, colour, frame, commits } = setup();
    border.move(0.02);
    frame();
    border.end(0.02);
    colour.move('#123456');
    frame();
    colour.end('#123456');
    expect(commits()).toBe(2);
    expect(editor.getState().canvas).toMatchObject({
      borderFraction: 0.02,
      background: '#123456',
    });
  });

  it('a drag of one control does not drop the queued step of the other', () => {
    const { editor, border, colour, frame } = setup();
    border.move(0.03);
    colour.move('#abcdef');
    frame();
    expect(editor.getState().canvas.borderFraction).toBe(0.03);
    expect(editor.getState().canvas.background).toBe('#abcdef');
  });
});

describe('GestureInput: one commit per action, whatever else happens', () => {
  it('picker: input, (focus lost and regained), input, change is one commit', () => {
    // The picker ends only on `change`, so the blur in the middle never
    // reaches the gesture.
    const { editor, colour, frame, commits } = setup();
    colour.move('#102030');
    frame();
    colour.move('#405060');
    frame();
    colour.move('#708090');
    frame();
    colour.end('#708090'); // change
    expect(commits()).toBe(1);
    expect(editor.getState().canvas.background).toBe('#708090');
  });

  it('a late end event after a commit from elsewhere commits nothing more', () => {
    const { editor, colour, border, frame, commits } = setup();
    border.move(0.02);
    frame();
    // Shuffle (or any other dispatch) commits the drag in progress.
    editor.shuffle();
    expect(commits()).toBe(1);
    border.end(0.02); // the late pointerup / change / blur
    border.end(0.02);
    expect(commits()).toBe(1);
    // Nor does a late end of a control that stepped and was committed away.
    colour.move('#123456');
    frame();
    editor.dispatch((s) => setBorder(s, 0.03));
    expect(commits()).toBe(2);
    colour.end('#123456');
    expect(commits()).toBe(2);
  });

  it('a picker returned to its starting colour (no change event), then a swatch click: one commit', () => {
    const { editor, colour, frame, commits } = setup();
    colour.move('#123456');
    frame();
    colour.move('#ffffff'); // back where it started; Chrome fires no change
    frame();
    expect(commits()).toBe(0);
    editor.dispatch((s) => setBackground(s, '#000000')); // the swatch
    expect(commits()).toBe(1);
    colour.end('#ffffff'); // a later blur, if it were wired
    expect(commits()).toBe(1);
    expect(editor.getState().canvas.background).toBe('#000000');
  });

  it('a stale end before a dial drag commits nothing', () => {
    const { editor, border, frame, commits } = setup();
    border.move(0.01);
    frame();
    editor.shuffle(); // commits
    const before = commits();
    border.end(0.01);
    editor.dragVariation(0.9);
    expect(commits()).toBe(before);
  });
});

describe('EditorStore.drag', () => {
  it('notifies as transient, and a dispatch commits it', () => {
    const editor = new EditorStore({ seed: 1 });
    const seen: boolean[] = [];
    editor.subscribe((_, change) => seen.push(change.transient));
    editor.drag((s) => setBorder(s, 0.02));
    expect(editor.isDragging()).toBe(true);
    editor.dispatch((s) => setBorder(s, 0.02));
    expect(seen).toEqual([true, false]);
    expect(editor.isDragging()).toBe(false);
    expect(createEditorState({ seed: 1 }).canvas.borderFraction).toBe(0);
  });
});
