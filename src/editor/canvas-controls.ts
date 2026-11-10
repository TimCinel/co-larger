/**
 * The canvas settings panel: ratio presets, custom pixel size with an aspect
 * lock, the border slider and the background colour, plus the output size
 * readout for the top bar. Every change goes through the EditorStore's pure
 * actions (setCanvasSize, setBorder, setBackground).
 *
 * The panel is a column of sections, each a labelled group. Issue #7 adds
 * its physical-size section (mm, DPI, paper presets) after "Size", and later
 * issues add export and save buttons at the foot (`.settings-footer`).
 */
import {
  activePreset,
  BORDER_STEP,
  borderRange,
  presetSize,
  RATIO_PRESETS,
  resizeBySide,
  type RatioPreset,
  type Side,
} from './canvas-settings';
import type { FrameScheduler } from './frames';
import { GestureInput } from './gesture';
import {
  MAX_BORDER_FRACTION,
  setBackground,
  setBorder,
  setCanvasSize,
} from './state';
import type { EditorStore } from './store';

/** "1920 × 1080 px". */
export function formatSize(width: number, height: number): string {
  return `${String(width)} × ${String(height)} px`;
}

/** The current output size in pixels, for the top bar. Always visible. */
export function createSizeReadout(
  doc: Document,
  editor: EditorStore,
): HTMLElement {
  const readout = doc.createElement('span');
  readout.className = 'size-readout';
  const hidden = doc.createElement('span');
  hidden.className = 'sr-only';
  hidden.textContent = 'Output size: ';
  const text = doc.createTextNode('');
  readout.append(hidden, text);
  const sync = (): void => {
    const { width, height } = editor.getState().canvas;
    text.data = formatSize(width, height);
  };
  editor.subscribe(sync);
  sync();
  return readout;
}

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/** A background swatch: a name and a colour. */
const SWATCHES = [
  { name: 'White', colour: '#ffffff' },
  { name: 'Light grey', colour: '#c8c8c8' },
  { name: 'Mid grey', colour: '#808080' },
  { name: 'Dark grey', colour: '#303030' },
  { name: 'Black', colour: '#000000' },
] as const;

export function createCanvasSettings(
  doc: Document,
  editor: EditorStore,
  frames: FrameScheduler,
): HTMLElement {
  const panel = doc.createElement('aside');
  panel.className = 'settings';
  panel.setAttribute('aria-label', 'Canvas settings');

  const section = (title: string, id: string): HTMLElement => {
    const group = doc.createElement('section');
    group.className = 'settings-section';
    group.setAttribute('aria-labelledby', id);
    const heading = doc.createElement('h2');
    heading.id = id;
    heading.textContent = title;
    group.append(heading);
    panel.append(group);
    return group;
  };

  // --- Ratio presets ---------------------------------------------------
  const ratioSection = section('Ratio', 'settings-ratio');
  const presets = doc.createElement('div');
  presets.className = 'preset-grid';
  const presetButtons = new Map<RatioPreset, HTMLButtonElement>();
  for (const p of RATIO_PRESETS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    const size = presetSize(p);
    button.title = `${p.label}: ${formatSize(size.width, size.height)}`;
    const icon = doc.createElement('span');
    icon.className = 'preset-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.aspectRatio = `${String(p.w)} / ${String(p.h)}`;
    if (p.w >= p.h) icon.style.width = '1.2rem';
    else icon.style.height = '1.2rem';
    button.append(icon, doc.createTextNode(p.label));
    button.addEventListener('click', () => {
      clearMessage();
      editor.dispatch((state) => setCanvasSize(state, size.width, size.height));
      syncFields();
    });
    presetButtons.set(p, button);
    presets.append(button);
  }
  ratioSection.append(presets);

  // --- Custom size -----------------------------------------------------
  const sizeSection = section('Size in pixels', 'settings-size');
  const fields = doc.createElement('div');
  fields.className = 'size-fields';
  const message = doc.createElement('p');
  message.className = 'field-message';
  message.id = 'size-message';
  message.setAttribute('role', 'alert');
  message.hidden = true;

  const makeField = (side: Side, label: string): HTMLInputElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'size-field';
    const id = `size-${side}`;
    const labelEl = doc.createElement('label');
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = doc.createElement('input');
    input.id = id;
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-describedby', message.id);
    wrap.append(labelEl, input);
    fields.append(wrap);
    return input;
  };
  const widthInput = makeField('width', 'Width');
  const times = doc.createElement('span');
  times.className = 'size-times';
  times.textContent = '×';
  times.setAttribute('aria-hidden', 'true');
  fields.insertBefore(times, fields.children[1] ?? null);
  const heightInput = makeField('height', 'Height');
  const inputs: Record<Side, HTMLInputElement> = {
    width: widthInput,
    height: heightInput,
  };

  const lockLabel = doc.createElement('label');
  lockLabel.className = 'check';
  const lock = doc.createElement('input');
  lock.type = 'checkbox';
  lock.checked = true;
  lockLabel.append(lock, doc.createTextNode('Lock aspect ratio'));
  sizeSection.append(fields, lockLabel, message);

  /** The ratio the lock keeps, and the size this panel last applied. */
  let lockRatio = 1;
  let applied = { width: 0, height: 0 };
  /** Fields the user has typed in and not yet committed. */
  const dirty = new Set<Side>();

  function clearMessage(): void {
    message.hidden = true;
    message.textContent = '';
    widthInput.removeAttribute('aria-invalid');
    heightInput.removeAttribute('aria-invalid');
    dirty.clear();
  }

  function showMessage(side: Side, text: string): void {
    message.textContent = text;
    message.hidden = false;
    inputs[side].setAttribute('aria-invalid', 'true');
  }

  /** Commits what was typed into one field (Enter or blur). */
  function commitSide(side: Side): void {
    if (!dirty.has(side)) return;
    const { canvas } = editor.getState();
    const result = resizeBySide({
      side,
      text: inputs[side].value,
      current: canvas,
      lock: lock.checked,
      ratio: lockRatio,
    });
    if (!result.ok) {
      showMessage(side, result.message);
      return;
    }
    clearMessage();
    applied = { width: result.width, height: result.height };
    editor.dispatch((state) =>
      setCanvasSize(state, result.width, result.height),
    );
    // Show the committed size even if nothing changed (a typed "01920").
    syncFields();
  }

  for (const side of ['width', 'height'] as const) {
    const input = inputs[side];
    input.addEventListener('input', () => {
      dirty.add(side);
      input.removeAttribute('aria-invalid');
    });
    input.addEventListener('change', () => {
      commitSide(side);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commitSide(side);
      } else if (event.key === 'Escape') {
        clearMessage();
        syncFields();
      }
    });
  }
  lock.addEventListener('change', () => {
    const { width, height } = editor.getState().canvas;
    lockRatio = width / height;
  });

  function syncFields(): void {
    const { width, height } = editor.getState().canvas;
    if (width !== applied.width || height !== applied.height) {
      // Changed from elsewhere (a preset, later paper sizes or undo): the
      // lock now keeps this size's ratio.
      applied = { width, height };
      lockRatio = width / height;
      clearMessage();
    }
    if (!dirty.has('width')) widthInput.value = String(width);
    if (!dirty.has('height')) heightInput.value = String(height);
  }

  // --- Border ----------------------------------------------------------
  const borderSection = section('Border', 'settings-border');
  const borderRow = doc.createElement('div');
  borderRow.className = 'slider-row';
  const borderLabel = doc.createElement('label');
  borderLabel.htmlFor = 'border';
  borderLabel.textContent = 'Margin and gaps';
  const borderValue = doc.createElement('output');
  borderValue.htmlFor = 'border';
  const border = doc.createElement('input');
  border.type = 'range';
  border.id = 'border';
  border.min = '0';
  border.step = String(BORDER_STEP);
  border.max = String(MAX_BORDER_FRACTION);
  border.value = '0';
  const borderNote = doc.createElement('p');
  borderNote.className = 'field-note';
  borderNote.id = 'border-note';
  borderNote.setAttribute('role', 'status');
  borderNote.hidden = true;
  border.setAttribute('aria-describedby', borderNote.id);
  borderRow.append(borderLabel, borderValue);
  borderSection.append(borderRow, border, borderNote);

  // While the slider moves, apply at most one value per frame; every event
  // that can end the gesture commits, once. See GestureInput.
  const borderGesture = new GestureInput<number>(
    {
      drag: (value) => {
        editor.drag((state) => setBorder(state, value));
      },
      commit: (value) => {
        editor.dispatch((state) => setBorder(state, value));
      },
      isDragging: () => editor.isDragging(),
    },
    frames,
    'border',
  );
  const onBorderInput = (): void => {
    showBorder(border.valueAsNumber);
    borderGesture.move(border.valueAsNumber);
  };
  border.addEventListener('input', onBorderInput);
  bindGestureEnd(border, SLIDER_END_EVENTS, () => {
    borderGesture.end(border.valueAsNumber);
  });

  function showBorder(fraction: number): void {
    const { width, height } = editor.getState().canvas;
    const px = Math.round(fraction * Math.min(width, height));
    const text = `${percent(fraction)} (${String(px)} px)`;
    borderValue.textContent = text;
    border.setAttribute('aria-valuetext', text);
  }

  function syncBorder(): void {
    const range = borderRange(editor.getState());
    // Follow the state when it changes from elsewhere (a re-roll that
    // changes the maximum, a new size, undo), but never fight a drag.
    if (!borderGesture.isBusy()) {
      border.max = String(range.max);
      border.value = String(range.value);
      showBorder(range.value);
    }
    if (range.limited) {
      borderNote.textContent =
        `Drawn at ${percent(range.drawn)} (${String(range.drawnPx)} px): the most this ` +
        `arrangement allows. You asked for ${percent(range.requested)}.`;
    }
    borderNote.hidden = !range.limited;
    border.classList.toggle('limited', range.limited);
  }

  // --- Background ------------------------------------------------------
  const bgSection = section('Background', 'settings-background');
  const bgRow = doc.createElement('div');
  bgRow.className = 'swatches';
  const swatchButtons: { button: HTMLButtonElement; colour: string }[] = [];
  for (const { name, colour } of SWATCHES) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.style.background = colour;
    button.title = name;
    button.setAttribute('aria-label', `${name} background`);
    button.addEventListener('click', () => {
      editor.dispatch((state) => setBackground(state, colour));
    });
    swatchButtons.push({ button, colour });
    bgRow.append(button);
  }
  const colourInput = doc.createElement('input');
  colourInput.type = 'color';
  colourInput.id = 'background-colour';
  colourInput.className = 'colour-input';
  colourInput.title = 'Choose a colour';
  const colourLabel = doc.createElement('label');
  colourLabel.htmlFor = colourInput.id;
  colourLabel.className = 'sr-only';
  colourLabel.textContent = 'Custom background colour';
  const colourHex = doc.createElement('output');
  colourHex.className = 'colour-hex';
  colourHex.htmlFor = colourInput.id;
  bgRow.append(colourLabel, colourInput);
  bgSection.append(bgRow, colourHex);

  // The native picker fires `input` for every colour while it is open and
  // `change` when it closes: one gesture, one commit.
  const colourGesture = new GestureInput<string>(
    {
      drag: (value) => {
        editor.drag((state) => setBackground(state, value));
      },
      commit: (value) => {
        editor.dispatch((state) => setBackground(state, value));
      },
      isDragging: () => editor.isDragging(),
    },
    frames,
    'background',
  );
  colourInput.addEventListener('input', () => {
    colourHex.textContent = colourInput.value;
    colourGesture.move(colourInput.value);
  });
  bindGestureEnd(colourInput, PICKER_END_EVENTS, () => {
    colourGesture.end(colourInput.value);
  });

  function syncBackground(): void {
    const colour = editor.getState().canvas.background;
    if (!colourGesture.isBusy()) {
      colourInput.value = colour;
      colourHex.textContent = colour;
    }
    for (const swatch of swatchButtons) {
      swatch.button.setAttribute(
        'aria-pressed',
        String(swatch.colour === colour),
      );
    }
  }

  // Room for #7 (physical sizes) above, and export and save (#11, #12) here.
  const footer = doc.createElement('div');
  footer.className = 'settings-footer';
  panel.append(footer);

  const sync = (): void => {
    const { width, height } = editor.getState().canvas;
    const active = activePreset(width, height);
    for (const [p, button] of presetButtons) {
      button.setAttribute('aria-pressed', String(p === active));
    }
    syncFields();
    syncBorder();
    syncBackground();
  };
  editor.subscribe(sync);
  sync();
  return panel;
}

/** Events that can end a gesture on a range input. */
const SLIDER_END_EVENTS = [
  'change',
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'blur',
];

/**
 * Events that can end a gesture on a colour input: the picker is a popup, so
 * pointer events on the input say nothing about it. `change` fires when the
 * picker closes, after the last `input`.
 */
const PICKER_END_EVENTS = ['change', 'blur'];

/**
 * Calls `end` on each of `types` on `input`. Escape is deliberately not one:
 * a native range input does not cancel on Escape, and with the pointer still
 * down the drag would carry on and commit again.
 */
function bindGestureEnd(
  input: HTMLInputElement,
  types: readonly string[],
  end: () => void,
): void {
  for (const type of types) input.addEventListener(type, end);
}
