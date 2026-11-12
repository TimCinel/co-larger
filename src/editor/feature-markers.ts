/**
 * Star markers on featured tiles (#14). Editor chrome only, like the
 * low-resolution badges (resolution-warnings.ts): DOM elements in a layer laid
 * exactly over the canvas, never drawn into it, and nothing in the export path
 * reads this module, so exported pixels cannot depend on it. The markers
 * ignore the pointer, so selecting, swapping, panning and zooming work through
 * them. They are not focusable: the tile's own description (tile-selection.ts)
 * says "featured", and each marker is an image named "Featured".
 *
 * Placement beside the low-resolution badge (top-right corner, 20 px, 4 px
 * in): the star takes the top-left corner. On a tile too narrow for both side
 * by side it moves to the bottom-left; on a tile too small for both in
 * opposite corners it is left out and the warning shows alone (the tray
 * thumbnail and the description still say the photo is featured). Neither
 * marker ever covers the other. Tiles under 30 px get no star, as they get no
 * badge.
 */
import type { Tile } from '../layout';
import { featuredOf, type EditorState } from './state';
import type { CollageView } from './view';

/** The star's size and its distance from the tile's corner (CSS px). */
export const STAR = 20;
const INSET = 4;
/** The low-resolution badge's size and inset (see resolution-warnings.ts). */
const BADGE = 20;
/** Smallest space kept between the star and the badge. */
const GAP = 4;
/** Tiles smaller than this (either side, CSS px) get no star. */
export const MIN_STAR_TILE = 30;

export type StarCorner = 'top-left' | 'bottom-left';

/**
 * Where a featured tile's star goes, for a tile of `width` × `height` CSS px
 * that does (`badge`) or does not show a low-resolution badge in its
 * top-right corner; null for no star. Never overlaps the badge.
 */
export function starCorner(
  width: number,
  height: number,
  badge: boolean,
): StarCorner | null {
  if (Math.min(width, height) < MIN_STAR_TILE) return null;
  const both = INSET + STAR + GAP + BADGE + INSET;
  if (!badge || width >= both) return 'top-left';
  if (height >= both) return 'bottom-left';
  return null;
}

export interface FeatureMarkers {
  /** The layer, for the app to append to the collage element. */
  readonly element: HTMLElement;
  /** Re-places the stars (for example when the warnings change). */
  refresh(): void;
}

export interface FeatureMarkersOptions {
  readonly doc: Document;
  readonly view: CollageView;
  /** Whether a photo's tile shows a low-resolution badge. */
  readonly hasBadge?: (photoId: string) => boolean;
}

export function createFeatureMarkers(
  options: FeatureMarkersOptions,
): FeatureMarkers {
  const { doc, view } = options;
  const { canvas } = view;
  const layer = doc.createElement('div');
  layer.className = 'feat-layer';
  layer.hidden = true;
  const pool: HTMLElement[] = [];

  function star(index: number): HTMLElement {
    let el = pool[index];
    if (!el) {
      el = doc.createElement('span');
      el.className = 'feat-star';
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'Featured');
      layer.append(el);
      pool.push(el);
    }
    return el;
  }

  let laidOut = '';
  let laidState: EditorState | null = null;
  function refresh(force = false): void {
    const last = view.lastRender();
    const state: EditorState | undefined = last?.state;
    const featured = state ? featuredOf(state) : [];
    if (!last || !state || canvas.hidden || featured.length === 0) {
      layer.hidden = true;
      laidOut = '';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const origin = view.element.getBoundingClientRect();
    const frame = [
      rect.left - origin.left,
      rect.top - origin.top,
      rect.width,
      rect.height,
    ];
    const badges = featured.map((id) => options.hasBadge?.(id) ?? false);
    const key = `${frame.join(',')}|${String(canvas.width)}|${badges.join(',')}`;
    if (!force && key === laidOut && last.state === laidState) return;
    laidOut = key;
    laidState = last.state;
    const [left, top, width] = frame as [number, number, number, number];
    layer.hidden = false;
    layer.style.left = `${String(left)}px`;
    layer.style.top = `${String(top)}px`;
    layer.style.width = `${String(width)}px`;
    layer.style.height = `${String(frame[3])}px`;
    const scale = width / canvas.width;
    const bySlot: (Tile | undefined)[] = [];
    for (const tile of last.tiles) bySlot[tile.slot] = tile;
    let used = 0;
    for (const [i, id] of featured.entries()) {
      const tile = bySlot[state.assignment.indexOf(id)];
      if (!tile) continue;
      const w = tile.width * scale;
      const h = tile.height * scale;
      const corner = starCorner(w, h, badges[i] ?? false);
      if (corner === null) continue;
      const el = star(used++);
      el.hidden = false;
      el.dataset.photoId = id;
      el.dataset.corner = corner;
      const x = tile.x * scale + INSET;
      const y =
        corner === 'top-left'
          ? tile.y * scale + INSET
          : tile.y * scale + h - INSET - STAR;
      el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    }
    for (let i = used; i < pool.length; i++) {
      const el = pool[i];
      if (el) el.hidden = true;
    }
  }

  view.onRender(() => {
    refresh();
  });
  doc.defaultView?.addEventListener('resize', () => {
    refresh();
  });
  // The canvas's box can move without a new render (the tray growing or
  // shrinking beside it): follow it.
  new ResizeObserver(() => {
    refresh();
  }).observe(canvas);
  refresh();
  return {
    element: layer,
    refresh: () => {
      refresh(true);
    },
  };
}
