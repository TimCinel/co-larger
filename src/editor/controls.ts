/**
 * Layout controls for the top bar: the size-variation dial and Shuffle.
 */
import { DialInput } from './dial';
import type { FrameScheduler } from './frames';
import type { EditorStore } from './store';

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

  group.append(label, low, dial, high, shuffle);

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
  dial.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') end();
  });

  const sync = (): void => {
    const state = editor.getState();
    const disabled = state.photos.length === 0;
    dial.disabled = disabled;
    shuffle.disabled = disabled;
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
