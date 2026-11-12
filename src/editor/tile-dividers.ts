/**
 * Dragging the dividers between tiles (#16): the pointer and keyboard
 * gestures, the highlight over the divider and the keyboard separators. The
 * geometry and the limits are pure functions in the layout library
 * (dividers.ts); the action is moveDivider in state.ts.
 *
 * Editor chrome only, like the selection outline and the badges: DOM
 * elements over the canvas, never drawn into it, and nothing in the export
 * path reads this module.
 *
 * ## Pointer
 *
 * Dividers are found from the pointer position against the drawn geometry
 * (dividerAt): the gap between tiles, widened to HIT_TOLERANCE CSS pixels
 * either side of its centre line, so a divider can be grabbed with no border.
 * Inside that band the divider takes priority: the press never reaches the
 * tile gestures (selection, swap, crop pan). Outside it nothing changes. The
 * listeners sit on the collage element in the capture phase, so they run
 * before the canvas's own. Hovering shows a resize cursor and highlights the
 * whole line; dragging redraws live through the store's transient path (so
 * sharper image decodes wait, as for the dial); releasing commits once;
 * Escape cancels. The click that ends a drag is swallowed.
 *
 * ## Keyboard
 *
 * One tab stop after the canvas, its menu and the badges, with roving focus
 * (like the badges): every divider is a `separator` element. The arrow keys
 * across the line move it (KEY_STEP of the canvas, Shift for KEY_STEP_BIG),
 * Home and End to its limits, the arrow keys along the line go to the
 * previous or next divider. A run of key presses is one gesture and one
 * undo step, committed when the keys have been quiet for BURST_MS, on blur,
 * or when anything else is about to act; Escape cancels it.
 *
 * ## Every step from the gesture's start
 *
 * A divider's range depends on the tile sizes (a tile already below the
 * minimum may not shrink further), so every step of a gesture is applied to
 * the state the gesture started from, unless something else changed the
 * state meanwhile (sameButPlan). The commit is then exactly one moveDivider
 * at the final value, and a drag can always return to where it began.
 */
import {
  dividerAt,
  dividerRange,
  fractionAt,
  tilesBeside,
  type Divider,
} from '../layout';
import type { FrameScheduler } from './frames';
import { GestureInput } from './gesture';
import {
  dividersFor,
  moveDivider,
  sameButPlan,
  type EditorState,
} from './state';
import type { EditorStore } from './store';
import { BURST_MS } from './tile-crop';
import type { CollageView } from './view';

/** The hit band either side of a divider's centre line, in CSS pixels. */
export const HIT_TOLERANCE = 4;
/** A key press moves a divider by this fraction of the canvas side. */
export const KEY_STEP = 0.01;
/** With Shift. */
export const KEY_STEP_BIG = 0.1;
/** The highlight is at least this thick, in CSS pixels. */
const HIGHLIGHT_MIN = 4;

export interface TileDividersOptions {
  readonly doc: Document;
  readonly view: CollageView;
  readonly editor: EditorStore;
  readonly frames: Pick<FrameScheduler, 'request' | 'cancel'>;
}

export interface TileDividers {
  /** The highlight and the keyboard separators, for the collage element. */
  readonly overlay: readonly HTMLElement[];
  /** The divider under a client point, or null (for tests). */
  dividerAtClientPoint(clientX: number, clientY: number): Divider | null;
  /** True while a pointer drag or a key sequence is in progress. */
  isBusy(): boolean;
}

export function createTileDividers(options: TileDividersOptions): TileDividers {
  const { doc, view, editor, frames } = options;
  const { canvas } = view;
  const win = doc.defaultView as Window;

  // --- DOM ---
  const highlight = doc.createElement('div');
  highlight.className = 'divider-highlight';
  highlight.hidden = true;
  highlight.setAttribute('aria-hidden', 'true');
  const layer = doc.createElement('div');
  layer.className = 'divider-layer';
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', 'Dividers between tiles');
  layer.hidden = true;
  const pool: HTMLElement[] = [];

  // --- The gesture (pointer or keys, never both at once) ---
  /** The divider being moved and the state its gesture started from. */
  let active: { path: string; base: EditorState } | null = null;
  const rebase = (state: EditorState): EditorState =>
    active && sameButPlan(state, active.base) ? active.base : state;
  const gesture = new GestureInput<number>(
    {
      drag(fraction) {
        const path = active?.path;
        if (path === undefined) return;
        editor.drag((state) => moveDivider(rebase(state), path, fraction));
      },
      commit(fraction) {
        const path = active?.path;
        if (path === undefined) return;
        editor.dispatch((state) => moveDivider(rebase(state), path, fraction));
      },
      isDragging: () => editor.isDragging(),
      cancel: () => {
        editor.cancelDrag();
      },
    },
    frames,
    'divider',
  );

  // --- Geometry ---
  let cache: {
    state: EditorState;
    width: number;
    height: number;
    list: Divider[];
  } | null = null;
  /** The dividers as last drawn, in canvas (device) pixels. */
  function dividers(): Divider[] {
    const last = view.lastRender();
    if (!last || canvas.hidden) return [];
    const { state } = last;
    if (
      cache?.state !== state ||
      cache.width !== canvas.width ||
      cache.height !== canvas.height
    ) {
      cache = {
        state,
        width: canvas.width,
        height: canvas.height,
        list: dividersFor(state, canvas),
      };
    }
    return cache.list;
  }
  const find = (path: string): Divider | undefined =>
    dividers().find((d) => d.path === path);

  /** Canvas pixels per CSS pixel. */
  function scale(): number {
    const rect = canvas.getBoundingClientRect();
    return rect.width === 0 ? 1 : canvas.width / rect.width;
  }
  function toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const s = scale();
    return [(clientX - rect.left) * s, (clientY - rect.top) * s];
  }
  function hit(clientX: number, clientY: number): Divider | null {
    const rect = canvas.getBoundingClientRect();
    if (canvas.hidden || rect.width === 0) return null;
    const [x, y] = toCanvas(clientX, clientY);
    if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
    return dividerAt(dividers(), x, y, HIT_TOLERANCE * scale());
  }

  // --- Highlight ---
  let hoverPath: string | null = null;
  /** The fraction last asked for, beyond the range when the limit is hit. */
  let requested: number | null = null;
  let keyboardFocus = false;
  function shownPath(): string | null {
    if (active) return active.path;
    if (keyboardFocus && focusedPath !== null) return focusedPath;
    return hoverPath;
  }
  function placeBox(el: HTMLElement, d: Divider, min: number): void {
    const rect = canvas.getBoundingClientRect();
    const origin = view.element.getBoundingClientRect();
    const s = rect.width / canvas.width;
    const thick = Math.max(min, d.border * s);
    const centre = (d.cut + d.border / 2) * s;
    const along = [centre - thick / 2, thick] as const;
    const across = [d.from * s, (d.to - d.from) * s] as const;
    const [left, width] = d.axis === 'x' ? along : across;
    const [top, height] = d.axis === 'x' ? across : along;
    el.style.left = `${String(rect.left - origin.left + left)}px`;
    el.style.top = `${String(rect.top - origin.top + top)}px`;
    el.style.width = `${String(width)}px`;
    el.style.height = `${String(height)}px`;
  }
  function refreshHighlight(): void {
    const path = shownPath();
    const d = path === null ? undefined : find(path);
    highlight.hidden = d === undefined;
    canvas.classList.toggle('divider-x', d?.axis === 'x' && !keyboardOnly());
    canvas.classList.toggle('divider-y', d?.axis === 'y' && !keyboardOnly());
    if (!d) return;
    placeBox(highlight, d, HIGHLIGHT_MIN);
    let limit = false;
    if (active && requested !== null) {
      const range = dividerRange(active.base.plan, active.path);
      limit = requested < range.min || requested > range.max;
    }
    highlight.classList.toggle('at-limit', limit);
    highlight.classList.toggle('dragging', active !== null);
  }
  /** The highlight is only for the keyboard: no resize cursor. */
  const keyboardOnly = (): boolean =>
    !drag && hoverPath === null && keyboardFocus;

  // --- Pointer ---
  interface Drag {
    readonly pointerId: number;
    readonly path: string;
    /** Pointer position minus the gap's centre, along the axis (canvas px). */
    readonly offset: number;
    cancelled: boolean;
  }
  let drag: Drag | null = null;
  let swallowClick = false;

  function endDrag(): void {
    const ended = drag;
    drag = null;
    if (!ended) return;
    canvas.classList.remove('divider-dragging');
    if (!ended.cancelled && requested !== null) gesture.end(requested);
    active = null;
    requested = null;
    refreshHighlight();
  }

  const fromCanvas = (event: Event): boolean => event.target === canvas;

  view.element.addEventListener(
    'pointerdown',
    (event) => {
      swallowClick = false;
      if (event.button !== 0 || !event.isPrimary || !fromCanvas(event)) {
        return;
      }
      const d = hit(event.clientX, event.clientY);
      if (!d) return;
      // The divider's band: the tile gestures never see this press.
      event.stopPropagation();
      event.preventDefault();
      endKeys();
      const [x, y] = toCanvas(event.clientX, event.clientY);
      drag = {
        pointerId: event.pointerId,
        path: d.path,
        offset: (d.axis === 'x' ? x : y) - (d.cut + d.border / 2),
        cancelled: false,
      };
      active = { path: d.path, base: editor.getState() };
      requested = d.fraction;
      swallowClick = true;
      canvas.classList.add('divider-dragging');
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; the end events will follow.
      }
      refreshHighlight();
    },
    true,
  );
  view.element.addEventListener(
    'pointermove',
    (event) => {
      const current = drag;
      if (!current) {
        const d = fromCanvas(event) ? hit(event.clientX, event.clientY) : null;
        const path = d?.path ?? null;
        if (path !== hoverPath) {
          hoverPath = path;
          refreshHighlight();
        }
        // Over a divider the tile gestures' hover (the pan cursor) is off.
        if (d) event.stopPropagation();
        return;
      }
      event.stopPropagation();
      if (event.pointerId !== current.pointerId || current.cancelled) return;
      const d = find(current.path);
      if (!d) return;
      const [x, y] = toCanvas(event.clientX, event.clientY);
      requested = fractionAt(d, (d.axis === 'x' ? x : y) - current.offset);
      gesture.move(requested);
      refreshHighlight();
    },
    true,
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    view.element.addEventListener(
      type,
      (event) => {
        if ((event as PointerEvent).pointerId === drag?.pointerId) {
          event.stopPropagation();
          endDrag();
        }
      },
      true,
    );
  }
  view.element.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
  canvas.addEventListener('pointerleave', () => {
    if (drag || hoverPath === null) return;
    hoverPath = null;
    refreshHighlight();
  });
  // Escape cancels a drag, before anything else sees the key (the selection
  // would otherwise be dismissed too).
  win.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !drag || drag.cancelled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag.cancelled = true;
      gesture.cancel();
      requested = null;
      refreshHighlight();
    },
    true,
  );

  // --- Keyboard ---
  let focusedPath: string | null = null;
  /** The fraction the key sequence has reached. */
  let keyFraction: number | null = null;
  let burstTimer: number | null = null;
  function endKeys(): void {
    if (burstTimer !== null) win.clearTimeout(burstTimer);
    burstTimer = null;
    const value = keyFraction;
    keyFraction = null;
    if (value !== null && !drag) {
      gesture.end(value);
      active = null;
      requested = null;
    }
  }
  function cancelKeys(): boolean {
    if (keyFraction === null) return false;
    if (burstTimer !== null) win.clearTimeout(burstTimer);
    burstTimer = null;
    keyFraction = null;
    gesture.cancel();
    active = null;
    requested = null;
    return true;
  }
  /** Moves the focused divider by `delta` (or to `to`), as one key step. */
  function keyStep(d: Divider, delta: number, to?: 'min' | 'max'): void {
    // Continue the running sequence only if nothing else ended it (an undo
    // commits it, for example).
    if (keyFraction === null || active?.path !== d.path || !gesture.isBusy()) {
      endKeys();
      active = { path: d.path, base: editor.getState() };
      keyFraction = d.fraction;
    }
    const range = dividerRange(active.base.plan, d.path);
    const wanted =
      to === 'min' ? range.min : to === 'max' ? range.max : keyFraction + delta;
    requested = wanted;
    keyFraction = Math.min(range.max, Math.max(range.min, wanted));
    gesture.move(keyFraction);
    if (burstTimer !== null) win.clearTimeout(burstTimer);
    burstTimer = win.setTimeout(() => {
      burstTimer = null;
      endKeys();
      refreshHighlight();
    }, BURST_MS);
    refreshHighlight();
  }

  layer.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const index = pool.indexOf(target);
    const list = dividers();
    const d = list[index];
    if (index < 0 || !d) return;
    if (event.key === 'Escape') {
      if (cancelKeys()) {
        event.preventDefault();
        event.stopPropagation();
        refreshHighlight();
      }
      return;
    }
    const x = d.axis === 'x';
    const back = x ? 'ArrowLeft' : 'ArrowUp';
    const forth = x ? 'ArrowRight' : 'ArrowDown';
    const prev = x ? 'ArrowUp' : 'ArrowLeft';
    const next = x ? 'ArrowDown' : 'ArrowRight';
    if (event.key === back || event.key === forth) {
      event.preventDefault();
      const side = x ? canvas.width : canvas.height;
      const length = d.end - d.start - d.border;
      if (!(length > 0)) return;
      const step = ((event.shiftKey ? KEY_STEP_BIG : KEY_STEP) * side) / length;
      keyStep(d, event.key === back ? -step : step);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      keyStep(d, 0, event.key === 'Home' ? 'min' : 'max');
    } else if (event.key === prev || event.key === next) {
      event.preventDefault();
      const to = list[index + (event.key === next ? 1 : -1)];
      if (to) pool[list.indexOf(to)]?.focus();
    }
  });
  layer.addEventListener('focusin', (event) => {
    const index = pool.indexOf(event.target as HTMLElement);
    const d = dividers()[index];
    if (!d) return;
    focusedPath = d.path;
    keyboardFocus = true;
    for (const el of pool) el.tabIndex = el === event.target ? 0 : -1;
    describe(index, d);
    refreshHighlight();
  });
  layer.addEventListener('focusout', (event) => {
    // Moving to another divider ends the sequence too: it is its own step.
    endKeys();
    if (!layer.contains(event.relatedTarget as Node | null)) {
      keyboardFocus = false;
    }
    refreshHighlight();
  });
  // Anything else about to act ends a key sequence first, so that it is its
  // own undo step.
  doc.addEventListener(
    'pointerdown',
    () => {
      if (keyFraction !== null) endKeys();
    },
    true,
  );
  doc.addEventListener(
    'keydown',
    (event) => {
      if (keyFraction === null || layer.contains(event.target as Node)) return;
      if (event.metaKey || event.ctrlKey) return; // Undo commits it itself.
      endKeys();
    },
    true,
  );

  // --- Separators ---
  const percent = (f: number): string => String(Math.round(f * 1000) / 10);
  /** Sets a separator's name and value. */
  function describe(index: number, d: Divider): void {
    const el = pool[index];
    const state = view.lastRender()?.state;
    if (!el || !state) return;
    const x = d.axis === 'x';
    const range = dividerRange(state.plan, d.path);
    const sides = tilesBeside(state.plan, d.path);
    const total = dividers().length;
    const tiles = (n: number): string =>
      `${String(n)} ${n === 1 ? 'tile' : 'tiles'}`;
    el.setAttribute('aria-orientation', x ? 'vertical' : 'horizontal');
    el.setAttribute(
      'aria-label',
      `Divider ${String(index + 1)} of ${String(total)}, between ${tiles(sides.first)} ${x ? 'on the left' : 'above'} and ${tiles(sides.second)} ${x ? 'on the right' : 'below'}`,
    );
    el.setAttribute('aria-valuemin', percent(range.min));
    el.setAttribute('aria-valuemax', percent(range.max));
    el.setAttribute('aria-valuenow', percent(d.fraction));
    el.setAttribute(
      'aria-valuetext',
      x
        ? `${percent(d.fraction)}% left, ${percent(1 - d.fraction)}% right`
        : `${percent(d.fraction)}% top, ${percent(1 - d.fraction)}% bottom`,
    );
    el.setAttribute(
      'aria-description',
      x
        ? 'Left and Right arrow keys move it, Shift for bigger steps. Up and Down go to the previous or next divider.'
        : 'Up and Down arrow keys move it, Shift for bigger steps. Left and Right go to the previous or next divider.',
    );
  }

  function refresh(): void {
    // Another control's drag (the dial, a crop): nothing here moves with
    // the pointer, so the dividers are placed again once it is committed,
    // rather than every frame.
    if (editor.isDragging() && active === null) {
      highlight.hidden = true;
      return;
    }
    const list = dividers();
    if (list.length === 0) {
      layer.hidden = true;
      if (pool.some((el) => el === doc.activeElement)) canvas.focus();
      hoverPath = null;
      refreshHighlight();
      return;
    }
    layer.hidden = false;
    // The roving tab stop stays on the same divider while it exists.
    if (focusedPath === null || !list.some((d) => d.path === focusedPath)) {
      const had = pool.some((el) => el === doc.activeElement);
      focusedPath = list[0]?.path ?? null;
      if (had) pool[0]?.focus();
    }
    // Mid-gesture (this one, or a dial or crop drag) the separators wait:
    // they are invisible, and placing and naming hundreds every frame would
    // cost frames. Only the moving divider follows.
    const busy = gesture.isBusy() || editor.isDragging();
    for (const [i, d] of list.entries()) {
      let el = pool[i];
      if (!el) {
        el = doc.createElement('div');
        el.className = 'divider-sep';
        el.setAttribute('role', 'separator');
        el.tabIndex = -1;
        layer.append(el);
        pool.push(el);
      }
      el.hidden = false;
      el.dataset.path = d.path;
      el.tabIndex = d.path === focusedPath ? 0 : -1;
      // Mid-gesture only the moving divider changes its name and value;
      // the rest follow once it is committed.
      if (busy && d.path !== active?.path) continue;
      placeBox(el, d, 1);
      describe(i, d);
    }
    for (let i = list.length; i < pool.length; i++) {
      const el = pool[i];
      if (!el) continue;
      if (el === doc.activeElement) pool[0]?.focus();
      el.hidden = true;
      el.tabIndex = -1;
    }
    if (hoverPath !== null && !list.some((d) => d.path === hoverPath)) {
      hoverPath = null;
    }
    refreshHighlight();
  }

  view.onRender(refresh);
  win.addEventListener('resize', refresh);
  new ResizeObserver(() => {
    refresh();
  }).observe(canvas);

  return {
    overlay: [highlight, layer],
    dividerAtClientPoint: hit,
    isBusy: () => drag !== null || keyFraction !== null,
  };
}
