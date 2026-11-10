/**
 * Tile selection logic, pure (no DOM). Selection is view state: it is not
 * part of the EditorState, so it never creates an undo step and is never
 * saved. It names photos rather than slots, so it follows a photo whichever
 * tile it is in.
 *
 * States:
 * - idle: nothing selected.
 * - selected: one tile is selected and its action menu is open.
 * - swapping: Swap was chosen; waiting for a second tile.
 *
 * Issue #9 (zoom and pan on the selected tile) builds on `selected`: it only
 * needs the selected photo id and the tile geometry, both held by
 * tile-selection.ts.
 */
import type { Tile } from '../layout';

export type SelectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'selected'; readonly photoId: string }
  | { readonly kind: 'swapping'; readonly photoId: string };

export const initialSelection: SelectionState = { kind: 'idle' };

export type SelectionEvent =
  /** A click on a tile (with the photo in it). */
  | { readonly type: 'tile'; readonly photoId: string }
  /** A click outside the collage (or Escape). */
  | { readonly type: 'dismiss' }
  /** The Swap action was chosen. */
  | { readonly type: 'choose-swap' };

/** Something the caller must do as a result of an event. */
export interface SelectionEffect {
  readonly type: 'swap';
  readonly from: string;
  readonly to: string;
}

export function reduceSelection(
  state: SelectionState,
  event: SelectionEvent,
): { readonly state: SelectionState; readonly effect?: SelectionEffect } {
  switch (event.type) {
    case 'dismiss':
      return { state: initialSelection };
    case 'choose-swap':
      return state.kind === 'selected'
        ? { state: { kind: 'swapping', photoId: state.photoId } }
        : { state };
    case 'tile': {
      if (state.kind === 'idle') {
        return { state: { kind: 'selected', photoId: event.photoId } };
      }
      if (event.photoId === state.photoId) {
        // The same tile again: deselect, or cancel a pending swap.
        return { state: initialSelection };
      }
      if (state.kind === 'swapping') {
        return {
          state: initialSelection,
          effect: { type: 'swap', from: state.photoId, to: event.photoId },
        };
      }
      return { state: { kind: 'selected', photoId: event.photoId } };
    }
  }
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The tile to move keyboard focus to from `from`, in a direction: the nearest
 * tile whose centre lies that way, preferring those that overlap `from` along
 * the other axis. Returns `from` if there is none.
 */
export function moveFocus(
  tiles: readonly Tile[],
  from: Tile,
  direction: FocusDirection,
): Tile {
  const horizontal = direction === 'left' || direction === 'right';
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  // A tile counts as lying in a direction if it starts beyond the edge of
  // `from` (to within a pixel, for rounding).
  const EDGE = 1;
  let best = from;
  let bestScore = Infinity;
  for (const tile of tiles) {
    if (tile === from || tile.slot === from.slot) continue;
    const tx = tile.x + tile.width / 2;
    const ty = tile.y + tile.height / 2;
    let gap: number;
    if (direction === 'right') gap = tile.x - (from.x + from.width);
    else if (direction === 'left') gap = from.x - (tile.x + tile.width);
    else if (direction === 'down') gap = tile.y - (from.y + from.height);
    else gap = from.y - (tile.y + tile.height);
    if (gap < -EDGE) continue;
    const along = Math.max(0, gap);
    const across = horizontal ? Math.abs(ty - cy) : Math.abs(tx - cx);
    const overlaps = horizontal
      ? tile.y < from.y + from.height && tile.y + tile.height > from.y
      : tile.x < from.x + from.width && tile.x + tile.width > from.x;
    // Overlapping tiles always beat non-overlapping ones.
    const score = (overlaps ? 0 : 1e9) + along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = tile;
    }
  }
  return best;
}
