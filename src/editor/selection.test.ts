import { describe, expect, it } from 'vitest';
import type { Tile } from '../layout';
import {
  initialSelection,
  moveFocus,
  reduceSelection,
  type SelectionState,
} from './selection';

const selected = (photoId: string): SelectionState => ({
  kind: 'selected',
  photoId,
});
const swapping = (photoId: string): SelectionState => ({
  kind: 'swapping',
  photoId,
});

describe('reduceSelection', () => {
  it('selects a clicked tile, and deselects it on a second click', () => {
    const a = reduceSelection(initialSelection, { type: 'tile', photoId: 'a' });
    expect(a.state).toEqual(selected('a'));
    expect(reduceSelection(a.state, { type: 'tile', photoId: 'a' })).toEqual({
      state: initialSelection,
    });
  });

  it('moves the selection to another tile', () => {
    expect(
      reduceSelection(selected('a'), { type: 'tile', photoId: 'b' }),
    ).toEqual({ state: selected('b') });
  });

  it('dismisses from every state', () => {
    for (const s of [initialSelection, selected('a'), swapping('a')]) {
      expect(reduceSelection(s, { type: 'dismiss' }).state).toEqual(
        initialSelection,
      );
    }
  });

  it('only starts a swap from a selection', () => {
    expect(
      reduceSelection(selected('a'), { type: 'choose-swap' }).state,
    ).toEqual(swapping('a'));
    expect(
      reduceSelection(initialSelection, { type: 'choose-swap' }).state,
    ).toEqual(initialSelection);
  });

  it('swaps with a second tile and then goes idle', () => {
    expect(
      reduceSelection(swapping('a'), { type: 'tile', photoId: 'b' }),
    ).toEqual({
      state: initialSelection,
      effect: { type: 'swap', from: 'a', to: 'b' },
    });
  });

  it('cancels a pending swap on the same tile, with no effect', () => {
    expect(
      reduceSelection(swapping('a'), { type: 'tile', photoId: 'a' }),
    ).toEqual({ state: initialSelection });
  });
});

describe('moveFocus', () => {
  // Two columns: slot 0 tall on the left; slots 1 and 2 stacked on the right.
  const tiles: Tile[] = [
    { slot: 0, x: 0, y: 0, width: 50, height: 100 },
    { slot: 1, x: 50, y: 0, width: 50, height: 50 },
    { slot: 2, x: 50, y: 50, width: 50, height: 50 },
  ];
  const at = (slot: number): Tile => tiles[slot] as Tile;

  it('moves in the direction pressed', () => {
    expect(moveFocus(tiles, at(1), 'down')).toBe(at(2));
    expect(moveFocus(tiles, at(2), 'up')).toBe(at(1));
    expect(moveFocus(tiles, at(1), 'left')).toBe(at(0));
    expect(moveFocus(tiles, at(0), 'right')).toBe(at(1));
  });

  it('stays put at an edge', () => {
    expect(moveFocus(tiles, at(0), 'left')).toBe(at(0));
    expect(moveFocus(tiles, at(2), 'down')).toBe(at(2));
    expect(moveFocus(tiles, at(0), 'up')).toBe(at(0));
  });

  it('reaches every tile by arrow keys', () => {
    const seen = new Set<number>([0]);
    let here = at(0);
    for (const dir of ['right', 'down', 'left'] as const) {
      here = moveFocus(tiles, here, dir);
      seen.add(here.slot);
    }
    expect(seen).toEqual(new Set([0, 1, 2]));
  });
});
