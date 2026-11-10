/**
 * The canvas settings panel: ratio presets, custom pixel size with an aspect
 * lock, the border slider and the background colour, plus the output size
 * readout for the top bar. Every change goes through the EditorStore's pure
 * actions (setCanvasSize, setBorder, setBackground).
 *
 * The "Size" section has a units choice. In pixels it is two fields; in
 * millimetres (#7) it is paper presets, width and height in mm and a DPI,
 * with the pixel size they give shown below. The panel is a column of
 * sections, each a labelled group; later issues add export and save buttons
 * at the foot (`.settings-footer`).
 *
 * Every control makes one gesture into one committed change: a click on a
 * preset or a units choice, or Enter or blur on a field. Typing alone
 * commits nothing and an edit that changes nothing (or is rejected) commits
 * nothing.
 */
import {
  activePaper,
  activePreset,
  BORDER_SLIDER_MAX,
  BORDER_STEP,
  borderRange,
  checkPhysicalFits,
  checkPresetPhysical,
  lockRatioFor,
  PAPER_PRESETS,
  paperLabel,
  presetPhysical,
  presetSize,
  RATIO_PRESETS,
  resizeByDpi,
  resizeByMm,
  resizeBySide,
  type MmSide,
  type PaperPreset,
  type RatioPreset,
  type Side,
} from './canvas-settings';
import type { FrameScheduler } from './frames';
import { GestureInput } from './gesture';
import { DEFAULT_DPI, formatMm, physicalFor } from './physical';
import {
  setBackground,
  setBorder,
  setCanvasSize,
  setPhysicalSize,
  switchToPhysical,
  switchToPixels,
  type CanvasSettings,
} from './state';
import type { EditorStore } from './store';

/** "1920 × 1080 px". */
export function formatSize(width: number, height: number): string {
  return `${String(width)} × ${String(height)} px`;
}

/**
 * The size for the top bar: "1920 × 1080 px", or in physical units
 * "297 × 420 mm at 300 DPI · 3508 × 4961 px".
 */
export function describeCanvas(canvas: CanvasSettings): string {
  const px = formatSize(canvas.width, canvas.height);
  const { physical } = canvas;
  return physical
    ? `${formatMm(physical.widthMm)} × ${formatMm(physical.heightMm)} mm at ${String(physical.dpi)} DPI · ${px}`
    : px;
}

/** The current output size, for the top bar. Always visible. */
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
    text.data = describeCanvas(editor.getState().canvas);
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
    const icon = doc.createElement('span');
    icon.className = 'preset-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.aspectRatio = `${String(p.w)} / ${String(p.h)}`;
    if (p.w >= p.h) icon.style.width = '1.2rem';
    else icon.style.height = '1.2rem';
    button.append(icon, doc.createTextNode(p.label));
    button.addEventListener('click', () => {
      clearErrors();
      // In millimetres it keeps the longer side in mm and the DPI; refuse
      // (with a message) a size that would not fit in pixels.
      const current = editor.getState().canvas.physical;
      if (current) {
        const fit = checkPresetPhysical(p, current);
        if (!fit.ok) {
          errors.set('paper', `${p.label}: ${fit.message}`);
          showErrors();
          return;
        }
      }
      // The ratio changes, the resolution (the longer side) does not.
      editor.dispatch((state) => {
        const { physical } = state.canvas;
        if (physical) {
          const next = presetPhysical(p, physical);
          return setPhysicalSize(state, next.widthMm, next.heightMm, next.dpi);
        }
        const { width, height } = presetSize(
          p,
          Math.max(state.canvas.width, state.canvas.height),
        );
        return setCanvasSize(state, width, height);
      });
      syncFields();
    });
    presetButtons.set(p, button);
    presets.append(button);
  }
  ratioSection.append(presets);

  // --- Size: pixels or millimetres ----------------------------------------
  const sizeSection = section('Size', 'settings-size');

  // Units: a native radio group (arrow keys move and select).
  const units = doc.createElement('div');
  units.className = 'segmented';
  units.setAttribute('role', 'radiogroup');
  units.setAttribute('aria-label', 'Size units');
  const unitRadios = {} as Record<'pixels' | 'physical', HTMLInputElement>;
  for (const [value, text] of [
    ['pixels', 'Pixels'],
    ['physical', 'Millimetres'],
  ] as const) {
    const label = doc.createElement('label');
    label.className = 'segment';
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'size-units';
    radio.value = value;
    const face = doc.createElement('span');
    face.textContent = text;
    label.append(radio, face);
    units.append(label);
    unitRadios[value] = radio;
  }
  unitRadios.pixels.addEventListener('change', () => {
    if (!unitRadios.pixels.checked) return;
    clearErrors();
    editor.dispatch((state) => switchToPixels(state));
    syncFields();
  });
  unitRadios.physical.addEventListener('change', () => {
    if (!unitRadios.physical.checked) return;
    clearErrors();
    // Keep the pixel size: the DPI is the last one used, or the default
    // when that would not fit in millimetres.
    const { width, height } = editor.getState().canvas;
    const dpi = physicalFor(width, height, lastDpi) ? lastDpi : DEFAULT_DPI;
    if (!physicalFor(width, height, dpi)) {
      errors.set(
        'paper',
        `${formatSize(width, height)} cannot be shown in millimetres at ${String(dpi)} DPI.`,
      );
      showErrors();
    } else {
      editor.dispatch((state) => switchToPhysical(state, dpi));
    }
    syncFields();
  });

  // Paper presets (millimetres only): A4, A3, A2, portrait and landscape.
  const paper = doc.createElement('div');
  paper.className = 'paper-grid';
  const paperButtons = new Map<PaperPreset, HTMLButtonElement>();
  for (const p of PAPER_PRESETS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'paper-preset';
    const icon = doc.createElement('span');
    icon.className = 'preset-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.aspectRatio = `${String(p.widthMm)} / ${String(p.heightMm)}`;
    if (p.orientation === 'landscape') icon.style.width = '1.2rem';
    else icon.style.height = '1.2rem';
    const hidden = doc.createElement('span');
    hidden.className = 'sr-only';
    hidden.textContent = ` ${p.orientation}`;
    button.append(icon, doc.createTextNode(p.name), hidden);
    button.title = `${paperLabel(p)}: ${String(p.widthMm)} × ${String(p.heightMm)} mm`;
    button.addEventListener('click', () => {
      clearErrors();
      const physical = editor.getState().canvas.physical;
      if (!physical) return;
      const next = { ...physical, widthMm: p.widthMm, heightMm: p.heightMm };
      const fit = checkPhysicalFits(next, 'dpi');
      if (!fit.ok) {
        errors.set('paper', `${paperLabel(p)}: ${fit.message}`);
        showErrors();
        return;
      }
      editor.dispatch((state) =>
        setPhysicalSize(state, next.widthMm, next.heightMm, next.dpi),
      );
      syncFields();
    });
    paperButtons.set(p, button);
    paper.append(button);
  }

  const message = doc.createElement('p');
  message.className = 'field-message';
  message.id = 'size-message';
  message.setAttribute('role', 'alert');
  message.style.whiteSpace = 'pre-line';
  message.hidden = true;

  type FieldKey = Side | MmSide | 'dpi' | 'paper';
  const inputs = new Map<FieldKey, HTMLInputElement>();

  const makeField = (
    parent: HTMLElement,
    key: Exclude<FieldKey, 'paper'>,
    id: string,
    label: string,
    inputMode: 'numeric' | 'decimal',
  ): void => {
    const wrap = doc.createElement('div');
    wrap.className = 'size-field';
    const labelEl = doc.createElement('label');
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = doc.createElement('input');
    input.id = id;
    input.type = 'text';
    input.inputMode = inputMode;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-describedby', message.id);
    wrap.append(labelEl, input);
    parent.append(wrap);
    inputs.set(key, input);
  };
  const times = (): HTMLElement => {
    const el = doc.createElement('span');
    el.className = 'size-times';
    el.textContent = '×';
    el.setAttribute('aria-hidden', 'true');
    return el;
  };

  // Pixels.
  const pixelFields = doc.createElement('div');
  pixelFields.className = 'size-fields';
  makeField(pixelFields, 'width', 'size-width', 'Width', 'numeric');
  pixelFields.append(times());
  makeField(pixelFields, 'height', 'size-height', 'Height', 'numeric');

  // Millimetres.
  const physicalGroup = doc.createElement('div');
  physicalGroup.className = 'size-physical';
  const mmFields = doc.createElement('div');
  mmFields.className = 'size-fields';
  makeField(mmFields, 'widthMm', 'size-width-mm', 'Width (mm)', 'decimal');
  mmFields.append(times());
  makeField(mmFields, 'heightMm', 'size-height-mm', 'Height (mm)', 'decimal');
  const dpiFields = doc.createElement('div');
  dpiFields.className = 'size-fields dpi-row';
  makeField(dpiFields, 'dpi', 'size-dpi', 'DPI', 'numeric');
  const derived = doc.createElement('p');
  derived.className = 'size-derived';
  derived.id = 'size-derived';
  derived.setAttribute('role', 'status');
  dpiFields.append(derived);
  physicalGroup.append(paper, mmFields, dpiFields);

  const lockLabel = doc.createElement('label');
  lockLabel.className = 'check';
  const lock = doc.createElement('input');
  lock.type = 'checkbox';
  lock.checked = true;
  lockLabel.append(lock, doc.createTextNode('Lock aspect ratio'));
  sizeSection.append(units, pixelFields, physicalGroup, lockLabel, message);

  /** The ratio the lock keeps, and the size this panel last applied. */
  let lockRatio = 1;
  let applied = '';
  /** The DPI last used in millimetres, offered again on switching back. */
  let lastDpi = DEFAULT_DPI;
  /** Fields the user has typed in and not yet committed. */
  const dirty = new Set<FieldKey>();

  /** Each field's own error: committing one never clears another's. */
  const errors = new Map<FieldKey, string>();

  function showErrors(): void {
    message.textContent = [...errors.values()].join('\n');
    message.hidden = errors.size === 0;
    for (const [key, input] of inputs) {
      if (errors.has(key)) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  /** Forgets one field's typed text and error. */
  function clearSide(key: FieldKey): void {
    errors.delete(key);
    dirty.delete(key);
    showErrors();
  }

  /** Forgets every field's typed text and error. */
  function clearErrors(): void {
    errors.clear();
    dirty.clear();
    showErrors();
  }

  const keyOf = (canvas: CanvasSettings): string => {
    const { physical } = canvas;
    return physical
      ? `${String(physical.widthMm)}x${String(physical.heightMm)}@${String(physical.dpi)}`
      : `${String(canvas.width)}x${String(canvas.height)}`;
  };

  /** Commits what was typed into one field (Enter or blur). */
  function commitField(key: FieldKey): void {
    const input = inputs.get(key);
    if (!dirty.has(key) || !input) return;
    const { canvas } = editor.getState();
    const { physical } = canvas;
    if (key === 'width' || key === 'height') {
      if (physical) return;
      const result = resizeBySide({
        side: key,
        text: input.value,
        current: canvas,
        lock: lock.checked,
        ratio: lockRatio,
      });
      if (!result.ok) {
        errors.set(key, result.message);
        showErrors();
        return;
      }
      clearSide(key);
      applied = `${String(result.width)}x${String(result.height)}`;
      editor.dispatch((state) =>
        setCanvasSize(state, result.width, result.height),
      );
    } else if (key === 'widthMm' || key === 'heightMm' || key === 'dpi') {
      if (!physical) return;
      const result =
        key === 'dpi'
          ? resizeByDpi(input.value, physical)
          : resizeByMm({
              side: key,
              text: input.value,
              current: physical,
              lock: lock.checked,
              ratio: lockRatio,
            });
      if (!result.ok) {
        errors.set(key, result.message);
        showErrors();
        return;
      }
      clearSide(key);
      const next = result.physical;
      applied = keyOf({ ...canvas, physical: next });
      editor.dispatch((state) =>
        setPhysicalSize(state, next.widthMm, next.heightMm, next.dpi),
      );
    }
    // Show the committed size even if nothing changed (a typed "01920").
    syncFields();
  }

  for (const [key, input] of inputs) {
    input.addEventListener('input', () => {
      dirty.add(key);
      errors.delete(key);
      showErrors();
    });
    input.addEventListener('change', () => {
      commitField(key);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commitField(key);
      } else if (event.key === 'Escape') {
        clearSide(key);
        syncFields();
      }
    });
  }
  lock.addEventListener('change', () => {
    const { canvas } = editor.getState();
    lockRatio = lockRatioOf(canvas);
  });

  function lockRatioOf(canvas: CanvasSettings): number {
    const { physical } = canvas;
    return physical
      ? lockRatioFor(physical.widthMm, physical.heightMm)
      : lockRatioFor(canvas.width, canvas.height);
  }

  function syncFields(): void {
    const { canvas } = editor.getState();
    const { physical } = canvas;
    const key = keyOf(canvas);
    if (key !== applied) {
      // Changed from elsewhere (a preset, a paper size, the units or
      // undo): the lock now keeps this size's ratio.
      applied = key;
      lockRatio = lockRatioOf(canvas);
      clearErrors();
    }
    if (physical) lastDpi = physical.dpi;
    unitRadios.pixels.checked = !physical;
    unitRadios.physical.checked = physical !== undefined;
    pixelFields.hidden = physical !== undefined;
    physicalGroup.hidden = !physical;
    const show = (field: FieldKey, value: string): void => {
      const input = inputs.get(field);
      if (input && !dirty.has(field)) input.value = value;
    };
    show('width', String(canvas.width));
    show('height', String(canvas.height));
    if (physical) {
      show('widthMm', formatMm(physical.widthMm));
      show('heightMm', formatMm(physical.heightMm));
      show('dpi', String(physical.dpi));
    }
    derived.textContent = `= ${formatSize(canvas.width, canvas.height)}`;
    const active = activePaper(physical);
    for (const [p, button] of paperButtons) {
      button.setAttribute('aria-pressed', String(p === active));
    }
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
  border.max = String(BORDER_SLIDER_MAX);
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

  /**
   * "2.0% (22 px)", or in physical units "2.0% (22 px, 1.9 mm)": the label
   * and the note are both made by this. The border is a fraction of the
   * shorter side, so its width in mm is that fraction of the shorter side
   * in mm, whatever the DPI.
   */
  const describeBorder = (fraction: number, px: number): string => {
    const { physical } = editor.getState().canvas;
    const mm = physical
      ? `, ${(fraction * Math.min(physical.widthMm, physical.heightMm)).toFixed(1)} mm`
      : '';
    return `${percent(fraction)} (${String(px)} px${mm})`;
  };

  function showBorder(fraction: number): void {
    const { width, height } = editor.getState().canvas;
    const text = describeBorder(
      fraction,
      Math.round(fraction * Math.min(width, height)),
    );
    borderValue.textContent = text;
    border.setAttribute('aria-valuetext', text);
  }

  function syncBorder(): void {
    const range = borderRange(editor.getState());
    // The scale is fixed and the thumb shows what was asked for, so a
    // re-roll never moves it. Follow the state when it changes from
    // elsewhere (a new size, undo), but never fight a drag.
    if (!borderGesture.isBusy()) {
      border.value = String(range.value);
      showBorder(range.requested);
    }
    // Shade the part of the track this arrangement cannot draw.
    border.style.setProperty(
      '--available',
      String(Math.min(1, range.available / range.scale)),
    );
    if (range.limited) {
      borderNote.textContent =
        `Drawn at ${describeBorder(range.drawn, range.drawnPx)}: the most this ` +
        `arrangement allows. You asked for ${describeBorder(range.requested, range.requestedPx)}.`;
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
    const { width, height, physical } = editor.getState().canvas;
    const active = activePreset(width, height);
    const long = Math.max(width, height);
    for (const [p, button] of presetButtons) {
      button.setAttribute('aria-pressed', String(p === active));
      if (physical) {
        const to = presetPhysical(p, physical);
        button.title = `${p.label}: ${formatMm(to.widthMm)} × ${formatMm(to.heightMm)} mm`;
      } else {
        const to = presetSize(p, long);
        button.title = `${p.label}: ${formatSize(to.width, to.height)}`;
      }
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
 * The event that ends a gesture on a colour input: `change`, which fires when
 * the picker closes, after the last `input`. Not `blur`: the picker is a
 * separate window on some platforms, so the input can lose and regain focus
 * while it is open, and a blur would split one picking into two commits. If
 * the picker closes on the colour it opened with, no `change` fires, and the
 * uncommitted steps are committed by the next action anyway.
 */
const PICKER_END_EVENTS = ['change'];

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
