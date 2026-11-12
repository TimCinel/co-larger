/**
 * Layout controls for the top bar: the size-variation dial and Shuffle.
 */
import { DialInput } from './dial';
import type { FrameScheduler } from './frames';
import { layoutOf } from './state';
import type { EditorStore } from './store';

/** Why the dial is disabled in a grid (#20), for its description. */
export const DIAL_GRID_NOTE =
  'Size variation does not apply to the Grid layout. Its value is kept for Mosaic.';

/** Steps of the dial (a range input from 0 to 1). */
const DIAL_STEP = 0.01;

/** Words for the dial's position, for screen readers. */
export function describeVariation(value: number): string {
  const percent = Math.round(value * 100);
  if (percent <= 10) return `${String(percent)}%, uniform`;
  if (percent >= 90) return `${String(percent)}%, very varied`;
  return `${String(percent)}%`;
}

export function createLayoutControls(
  doc: Document,
  editor: EditorStore,
  frames: FrameScheduler,
): HTMLElement {
  const group = doc.createElement('div');
  group.className = 'layout-controls';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Layout');

  const dialId = 'size-variation';
  const label = doc.createElement('label');
  label.htmlFor = dialId;
  label.textContent = 'Size variation';

  const low = doc.createElement('span');
  low.className = 'dial-end';
  low.textContent = 'Uniform';
  low.setAttribute('aria-hidden', 'true');

  const dial = doc.createElement('input');
  dial.type = 'range';
  dial.id = dialId;
  dial.min = '0';
  dial.max = '1';
  dial.step = String(DIAL_STEP);

  const high = doc.createElement('span');
  high.className = 'dial-end';
  high.textContent = 'Varied';
  high.setAttribute('aria-hidden', 'true');

  const shuffle = doc.createElement('button');
  shuffle.type = 'button';
  shuffle.textContent = 'Shuffle';
  shuffle.title = 'Re-roll the arrangement';
  shuffle.addEventListener('click', () => {
    editor.shuffle();
  });

  // In a grid the dial is disabled (#20): say why, to assistive technology
  // (the description) and on hover (the title). Hidden text, so the top bar
  // gains nothing visible.
  const gridNote = doc.createElement('span');
  gridNote.id = 'size-variation-note';
  gridNote.className = 'sr-only';

  group.append(label, low, dial, high, shuffle, gridNote);

  // While the dial moves, apply at most one value per frame. Every event
  // that can end the gesture commits; DialInput makes that one commit per
  // gesture. The final state depends only on the final value.
  const gesture = new DialInput(editor, frames);
  dial.addEventListener('input', () => {
    dial.setAttribute('aria-valuetext', describeVariation(dial.valueAsNumber));
    gesture.move(dial.valueAsNumber);
  });
  const end = (): void => {
    gesture.end(dial.valueAsNumber);
  };
  for (const type of [
    'change',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'blur',
  ]) {
    dial.addEventListener(type, end);
  }
  // Escape is deliberately not an end event: a native range input does not
  // cancel on Escape, and with the pointer still down the drag would carry
  // on and commit a second time on release.

  const sync = (): void => {
    const state = editor.getState();
    const disabled = state.photos.length === 0;
    const grid = layoutOf(state) === 'grid';
    dial.disabled = disabled || grid;
    shuffle.disabled = disabled;
    gridNote.textContent = grid ? DIAL_GRID_NOTE : '';
    if (grid) {
      dial.setAttribute('aria-describedby', gridNote.id);
      dial.title = DIAL_GRID_NOTE;
      group.classList.add('dial-off');
    } else {
      dial.removeAttribute('aria-describedby');
      dial.removeAttribute('title');
      group.classList.remove('dial-off');
    }
    // Follow the state when it changes from elsewhere (undo, loading a
    // project), but never fight the user's own drag.
    if (!gesture.isBusy() && dial.valueAsNumber !== state.variation) {
      dial.value = String(state.variation);
    }
    dial.setAttribute('aria-valuetext', describeVariation(dial.valueAsNumber));
  };
  editor.subscribe(sync);
  sync();
  return group;
}
