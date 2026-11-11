/**
 * Low-resolution warnings on the page (#15): badges over the collage, the
 * one-line summary, the "Show resolution warnings" checkbox, and the data the
 * tray's thumbnails read. The arithmetic is in resolution.ts (pure).
 *
 * Everything here is editor chrome. The badges are DOM elements in a layer
 * laid exactly over the canvas, never drawn into the canvas, and the export
 * does not read anything in this module, so the exported pixels cannot
 * depend on it. The toggle is a closure variable: it is not in the editor
 * state, so it makes no undo steps and is not in a saved project.
 *
 * Cost: the warnings are recomputed only when the editor state changes (not
 * on the redraws that follow each image decode), the badge elements are
 * pooled and reused, and a badge's position is written in percentages of the
 * canvas, so a window resize moves them without any per-badge work.
 *
 * Badges ignore the pointer (`pointer-events: none`), so selecting, swapping,
 * dragging to pan and the wheel to zoom work through them. The explanation is
 * reached by hovering a badge (the canvas's pointer moves are hit-tested
 * against the badges) and by keyboard: the badges are focusable, one tab
 * stop with the arrow keys moving between them, and each carries its
 * explanation as its accessible name.
 */
import type { Photo, PhotoStore } from '../photos';
import type { Tile } from '../layout';
import {
  countLevels,
  describeResolution,
  resolutionWarnings,
  summaryText,
  type ResolutionLevel,
  type TileResolution,
} from './resolution';
import type { EditorState } from './state';
import type { EditorStore } from './store';
import type { CollageView } from './view';

/** Tiles smaller than this (CSS px, either side) get no badge: it would hide them. */
const MIN_BADGE_TILE = 30;
/** The badge's size and its distance from the tile's corner (CSS px; see style.css). */
const BADGE = 20;
const INSET = 4;

export interface ResolutionWarnings {
  /** The summary and the checkbox; the export section puts it by Download. */
  readonly element: HTMLElement;
  /**
   * The badge layer and the tooltip, for the app to append to the collage
   * element after the tile selection's own overlays, so that Tab from the
   * canvas reaches the tile menu before the badges.
   */
  readonly overlay: readonly HTMLElement[];
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** The warning for a photo in the collage, or undefined (none, or turned off). */
  warningFor(photoId: string): TileResolution | undefined;
  /** The explanation for a photo's warning, or null. */
  describe(photoId: string): string | null;
  /**
   * Called when the set of warned photos or any level changes, or the
   * toggle does (not for a change of the numbers in an explanation).
   */
  onChange(listener: () => void): () => void;
}

export interface ResolutionWarningsOptions {
  readonly doc: Document;
  readonly view: CollageView;
  readonly editor: Pick<EditorStore, 'getState' | 'isDragging'>;
  readonly photos: Pick<PhotoStore, 'getPhotos'>;
}

interface Marker {
  /** The tile's outline, shown only while the summary highlights tiles. */
  readonly box: HTMLElement;
  readonly badge: HTMLElement;
  /** Whether this pooled marker stands for a warning right now. */
  used: boolean;
  /** What was last written, to skip writes that would change nothing. */
  position: string;
  boxGeometry: string;
  level: ResolutionLevel | null;
  text: string;
  small: boolean;
  slot: number;
}

export function createResolutionWarnings(
  options: ResolutionWarningsOptions,
): ResolutionWarnings {
  const { doc, view, editor, photos } = options;
  const { canvas } = view;
  const win = doc.defaultView as Window;

  let enabled = true;
  let warnings: readonly TileResolution[] = [];
  let byPhoto = new Map<string, TileResolution>();
  /** The state `warnings` was computed for. */
  let computedFor: EditorState | null | undefined;
  let sizes = new Map<string, { width: number; height: number }>();
  let sizesFrom: readonly Photo[] | null = null;
  const listeners = new Set<() => void>();

  // --- Badges over the canvas ---
  const layer = doc.createElement('div');
  layer.className = 'res-layer';
  layer.hidden = true;
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', 'Low resolution tiles');
  const tooltip = doc.createElement('div');
  tooltip.className = 'res-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.id = 'res-tooltip';
  tooltip.hidden = true;

  const pool: Marker[] = [];
  /** The marker whose tooltip is showing. */
  let hovered: Marker | null = null;
  /** The badge that is the tab stop (the others are reached by arrows). */
  let tabbable: HTMLElement | null = null;

  function createMarker(): Marker {
    const box = doc.createElement('div');
    box.className = 'res-box';
    const badge = doc.createElement('span');
    badge.className = 'res-badge';
    badge.tabIndex = -1;
    badge.setAttribute('role', 'img');
    const glyph = doc.createElement('span');
    glyph.className = 'res-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    badge.append(glyph);
    box.hidden = true;
    badge.hidden = true;
    layer.append(box, badge);
    const marker: Marker = {
      box,
      badge,
      used: false,
      position: '',
      boxGeometry: '',
      level: null,
      text: '',
      small: false,
      slot: -1,
    };
    badge.addEventListener('focus', () => {
      tabbable = badge;
      syncTabStop();
      showTooltip(marker);
    });
    badge.addEventListener('blur', hideTooltip);
    return marker;
  }

  /** The shown badges, in slot order. */
  const shown = (): Marker[] => pool.filter((m) => m.used && !m.badge.hidden);

  function syncTabStop(): void {
    const visible = shown();
    if (!tabbable || !visible.some((m) => m.badge === tabbable)) {
      tabbable = visible[0]?.badge ?? null;
    }
    for (const marker of pool) {
      marker.badge.tabIndex = marker.badge === tabbable ? 0 : -1;
    }
  }

  layer.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const visible = shown();
    const from = visible.findIndex((m) => m.badge === doc.activeElement);
    if (event.key === 'Escape') {
      // Dismisses the tooltip without moving focus (WCAG 1.4.13).
      hideTooltip();
      return;
    }
    if (from < 0) return;
    let to: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = from + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      to = from - 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = visible.length - 1;
    else return;
    event.preventDefault();
    visible[Math.max(0, Math.min(visible.length - 1, to))]?.badge.focus();
  });

  // --- The tooltip: one element, shared ---
  function showTooltip(marker: Marker): void {
    if (!enabled || marker.text === '') return;
    tooltip.textContent = marker.text;
    tooltip.dataset.level = marker.level ?? '';
    tooltip.hidden = false;
    const host = view.element.getBoundingClientRect();
    const badge = marker.badge.getBoundingClientRect();
    const gap = 6;
    const width = Math.min(tooltip.offsetWidth, host.width - 2 * gap);
    let left = badge.right - host.left - width;
    left = Math.max(gap, Math.min(left, host.width - width - gap));
    let top = badge.bottom - host.top + gap;
    if (top + tooltip.offsetHeight > host.height - gap) {
      top = badge.top - host.top - tooltip.offsetHeight - gap;
    }
    tooltip.style.left = `${String(left)}px`;
    tooltip.style.top = `${String(Math.max(gap, top))}px`;
    marker.badge.setAttribute('aria-describedby', tooltip.id);
    hovered = marker;
  }

  /**
   * Hovering: the tooltip stays while the pointer is over the badge or the
   * tooltip, with a short grace period for crossing the gap between them
   * (WCAG 1.4.13: hoverable).
   */
  const GRACE_MS = 350;
  let hideTimer: number | null = null;
  function cancelHide(): void {
    if (hideTimer !== null) win.clearTimeout(hideTimer);
    hideTimer = null;
  }
  function scheduleHide(): void {
    if (hideTimer !== null || !hovered) return;
    if (doc.activeElement === hovered.badge) return;
    hideTimer = win.setTimeout(() => {
      hideTimer = null;
      if (doc.activeElement !== hovered?.badge) hideTooltip();
    }, GRACE_MS);
  }
  tooltip.addEventListener('pointerenter', cancelHide);
  tooltip.addEventListener('pointerleave', scheduleHide);

  function hideTooltip(): void {
    cancelHide();
    tooltip.hidden = true;
    hovered?.badge.removeAttribute('aria-describedby');
    hovered = null;
  }

  /** The marker whose badge is under a canvas pointer event, if any. */
  function badgeAt(event: PointerEvent): Marker | null {
    if (!enabled || layer.hidden) return null;
    const hit = view.tileAtClientPoint(event.clientX, event.clientY);
    if (!hit) return null;
    const marker = pool.find((m) => m.slot === hit.tile.slot && m.used);
    if (!marker || marker.badge.hidden) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    const right = rect.left + (hit.tile.x + hit.tile.width) * scale;
    const top = rect.top + hit.tile.y * scale;
    // A little slop around the glyph: it is small.
    const slop = 3;
    const inside =
      event.clientX >= right - INSET - BADGE - slop &&
      event.clientX <= right &&
      event.clientY >= top &&
      event.clientY <= top + INSET + BADGE + slop;
    return inside ? marker : null;
  }
  canvas.addEventListener('pointermove', (event) => {
    // While a button is held the pointer is selecting, swapping or panning.
    if (event.buttons !== 0) {
      if (doc.activeElement !== hovered?.badge) hideTooltip();
      return;
    }
    const marker = badgeAt(event);
    if (marker) {
      cancelHide();
      if (marker === hovered || doc.activeElement === hovered?.badge) return;
      hideTooltip();
      showTooltip(marker);
    } else {
      scheduleHide();
    }
  });
  // The pointer may be on its way to the tooltip: leaving the canvas waits.
  canvas.addEventListener('pointerleave', scheduleHide);
  for (const type of ['pointerdown', 'wheel'] as const) {
    canvas.addEventListener(type, () => {
      if (doc.activeElement !== hovered?.badge) hideTooltip();
    });
  }
  // A press anywhere but the tooltip dismisses it.
  doc.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (target instanceof Node && tooltip.contains(target)) return;
      if (doc.activeElement !== hovered?.badge) hideTooltip();
    },
    true,
  );

  // --- Summary and checkbox ---
  const element = doc.createElement('div');
  element.className = 'res-controls';
  const summary = doc.createElement('button');
  summary.type = 'button';
  summary.className = 'res-summary';
  summary.hidden = true;
  summary.setAttribute('aria-pressed', 'false');
  summary.title = 'Highlight the affected tiles in the collage';
  const summaryDetail = doc.createElement('span');
  summaryDetail.className = 'res-summary-glyph';
  summaryDetail.setAttribute('aria-hidden', 'true');
  summaryDetail.textContent = '!';
  const summaryLabel = doc.createElement('span');
  summary.append(summaryDetail, summaryLabel);
  const row = doc.createElement('label');
  row.className = 'res-toggle';
  const checkbox = doc.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  row.append(checkbox, ' Show resolution warnings');
  element.append(summary, row);

  let pinned = false;
  let pointerOver = false;
  let summaryFocused = false;
  /** The tile outlines are showing (they are only positioned then). */
  let highlighting = false;
  function syncHighlight(): void {
    const on = pinned || pointerOver || summaryFocused;
    layer.classList.toggle('highlight', on);
    if (on === highlighting) return;
    highlighting = on;
    // Outlines are placed only while showing: place them now, or hide them.
    laidOut = '';
    update();
  }
  summary.addEventListener('click', () => {
    pinned = !pinned;
    summary.setAttribute('aria-pressed', String(pinned));
    syncHighlight();
  });
  summary.addEventListener('pointerenter', () => {
    pointerOver = true;
    syncHighlight();
  });
  summary.addEventListener('pointerleave', () => {
    pointerOver = false;
    syncHighlight();
  });
  summary.addEventListener('focus', () => {
    summaryFocused = true;
    syncHighlight();
  });
  summary.addEventListener('blur', () => {
    summaryFocused = false;
    syncHighlight();
  });
  checkbox.addEventListener('change', () => {
    setEnabled(checkbox.checked);
  });

  // --- Computing and showing ---
  function sizeOf(id: string): { width: number; height: number } | undefined {
    const all = photos.getPhotos();
    if (all !== sizesFrom) {
      sizesFrom = all;
      sizes = new Map(
        all.map((p) => [p.id, { width: p.width, height: p.height }]),
      );
    }
    return sizes.get(id);
  }

  /**
   * Recomputes for `state` if it is not the one already computed for.
   * `recomputed` says it did; `changed` says the warned photos or their
   * levels differ from before.
   */
  function compute(state: EditorState | null): {
    recomputed: boolean;
    changed: boolean;
  } {
    if (state === computedFor) return { recomputed: false, changed: false };
    computedFor = state;
    const next = state && enabled ? resolutionWarnings(state, sizeOf) : [];
    const changed =
      next.length !== warnings.length ||
      next.some((w, i) => {
        const before = warnings[i];
        return before?.photoId !== w.photoId || before.level !== w.level;
      });
    warnings = next;
    byPhoto = new Map(next.map((w) => [w.photoId, w]));
    return { recomputed: true, changed };
  }

  let laidOut = '';
  /** Explanations were left as they were during a drag. */
  let textStale = false;
  function update(): void {
    const last = view.lastRender();
    const state = last && enabled && !canvas.hidden ? last.state : null;
    const { recomputed, changed } = compute(state);
    const physical = state?.canvas.physical;

    if (!last || state === null || warnings.length === 0) {
      hideAll();
      laidOut = '';
    } else {
      const rect = canvas.getBoundingClientRect();
      const origin = view.element.getBoundingClientRect();
      const frame = [
        rect.left - origin.left,
        rect.top - origin.top,
        rect.width,
        rect.height,
      ];
      const key = `${frame.map(String).join(',')}|${String(canvas.width)}x${String(canvas.height)}`;
      // The same state at the same size: nothing moves.
      if (
        key !== laidOut ||
        recomputed ||
        (textStale && !editor.isDragging())
      ) {
        layOut(last.tiles, frame, physical);
        laidOut = key;
      }
    }
    if (changed) {
      showSummary();
      for (const listener of [...listeners]) listener();
    }
  }

  function hideAll(): void {
    if (layer.hidden && pool.every((m) => !m.used)) return;
    if (pool.some((m) => m.badge === doc.activeElement)) canvas.focus();
    layer.hidden = true;
    for (const marker of pool) retire(marker);
    hideTooltip();
  }

  /** Takes a marker out of use. */
  function retire(marker: Marker): void {
    if (!marker.used) return;
    marker.used = false;
    marker.box.hidden = true;
    marker.badge.hidden = true;
  }

  /**
   * Positions one pooled marker per warning; the rest are retired. Only the
   * badge's `transform` is written for each tile on every change (a move
   * costs style work but no layout), and explanations are not rewritten while
   * the dial or a crop is being dragged: they are brought up to date once it
   * ends. The tile outlines are placed only while they are showing.
   */
  function layOut(
    tiles: readonly Tile[],
    frame: number[],
    physical: EditorState['canvas']['physical'],
  ): void {
    const [left, top, width, height] = frame as [
      number,
      number,
      number,
      number,
    ];
    layer.hidden = false;
    layer.style.left = `${String(left)}px`;
    layer.style.top = `${String(top)}px`;
    layer.style.width = `${String(width)}px`;
    layer.style.height = `${String(height)}px`;
    const bySlot: (Tile | undefined)[] = [];
    for (const tile of tiles) bySlot[tile.slot] = tile;
    const scale = width / canvas.width;
    const focusedBadge = pool.find((m) => m.badge === doc.activeElement);
    const writeText = !editor.isDragging();
    textStale = !writeText;
    let used = 0;
    for (const warning of warnings) {
      const tile = bySlot[warning.slot];
      if (!tile) continue;
      const marker = (pool[used] ??= createMarker());
      used++;
      marker.slot = warning.slot;
      const x = (tile.x + tile.width) * scale - INSET - BADGE;
      const y = tile.y * scale + INSET;
      const position = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      if (marker.position !== position) {
        marker.position = position;
        marker.badge.style.transform = position;
      }
      if (highlighting) {
        const geometry = `${String(tile.x)},${String(tile.y)},${String(tile.width)},${String(tile.height)}`;
        if (marker.boxGeometry !== geometry) {
          marker.boxGeometry = geometry;
          const s = marker.box.style;
          s.left = `${String((tile.x / canvas.width) * 100)}%`;
          s.top = `${String((tile.y / canvas.height) * 100)}%`;
          s.width = `${String((tile.width / canvas.width) * 100)}%`;
          s.height = `${String((tile.height / canvas.height) * 100)}%`;
        }
        marker.box.hidden = false;
      } else if (!marker.box.hidden) {
        marker.box.hidden = true;
      }
      if (marker.level !== warning.level) {
        marker.level = warning.level;
        marker.box.dataset.level = warning.level;
        marker.badge.dataset.level = warning.level;
        const glyph = marker.badge.firstElementChild;
        if (glyph)
          glyph.textContent = warning.level === 'very-low' ? '!!' : '!';
      }
      const small = Math.min(tile.width, tile.height) * scale < MIN_BADGE_TILE;
      if (small !== marker.small || !marker.used) {
        marker.small = small;
        marker.badge.hidden = small;
      }
      marker.used = true;
      if (writeText || marker.text === '') {
        const text = describeResolution(warning, physical);
        if (text !== marker.text) {
          marker.text = text;
          marker.badge.setAttribute('aria-label', text);
          if (hovered === marker) tooltip.textContent = text;
        }
      }
    }
    // Focus on a badge that is about to go away would fall to the page.
    if (focusedBadge && pool.indexOf(focusedBadge) >= used) canvas.focus();
    for (let i = used; i < pool.length; i++) {
      const marker = pool[i];
      if (marker) retire(marker);
    }
    if (hovered && !hovered.used) hideTooltip();
    syncTabStop();
  }

  function showSummary(): void {
    const text = summaryText(warnings);
    summary.hidden = text === null;
    if (text === null) {
      pinned = false;
      summary.setAttribute('aria-pressed', 'false');
      syncHighlight();
      return;
    }
    summaryLabel.textContent = text;
    const { veryLow } = countLevels(warnings);
    summary.dataset.level = veryLow > 0 ? 'very-low' : 'low';
  }

  function setEnabled(next: boolean): void {
    if (next === enabled) return;
    enabled = next;
    checkbox.checked = next;
    computedFor = undefined;
    if (!next) hideTooltip();
    update();
  }

  view.onRender(update);
  update();

  return {
    element,
    overlay: [layer, tooltip],
    isEnabled: () => enabled,
    setEnabled,
    warningFor: (photoId) => (enabled ? byPhoto.get(photoId) : undefined),
    describe(photoId) {
      const warning = enabled ? byPhoto.get(photoId) : undefined;
      return warning
        ? describeResolution(warning, editor.getState().canvas.physical)
        : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
