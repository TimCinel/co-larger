// Shared helpers for the layout tests. Not part of the library.
import type { Tile } from './types';

/** The canvas ratio presets from spec.md, as [width, height]. */
export const RATIO_PRESETS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 2],
  [2, 1],
  [3, 4],
  [4, 3],
  [4, 5],
  [5, 4],
  [5, 7],
  [7, 5],
  [9, 16],
  [16, 9],
];

export function area(tile: Tile): number {
  return tile.width * tile.height;
}

export function aspect(tile: Tile): number {
  return tile.width >= tile.height
    ? tile.width / tile.height
    : tile.height / tile.width;
}

/** Largest tile area over smallest. */
export function areaSpread(tiles: readonly Tile[]): number {
  const areas = tiles.map(area);
  return Math.max(...areas) / Math.min(...areas);
}

export function maxAspect(tiles: readonly Tile[]): number {
  return Math.max(...tiles.map(aspect));
}

/**
 * Returns a description of the first way `tiles` fail to tile a
 * `width` × `height` canvas with a `border`-wide outer margin and gaps, or
 * null if they tile it exactly.
 *
 * Grow every tile by half a gap on each side. The tiles then tile the canvas
 * minus half a gap all round exactly if and only if: every grown tile lies
 * inside it, no two grown tiles overlap, and their areas add up to its area.
 * That also proves every gap between neighbours is exactly `border` wide and
 * there is no other empty space. `tolerance` is in canvas units.
 */
export function tilingError(
  tiles: readonly Tile[],
  width: number,
  height: number,
  border: number,
  tolerance: number,
): string | null {
  const half = border / 2;
  const left = half;
  const top = half;
  const right = width - half;
  const bottom = height - half;
  const grown = tiles.map((t) => ({
    slot: t.slot,
    x0: t.x - half,
    y0: t.y - half,
    x1: t.x + t.width + half,
    y1: t.y + t.height + half,
  }));

  for (const [i, t] of tiles.entries()) {
    if (t.slot !== i) return `tiles[${String(i)}] has slot ${String(t.slot)}`;
    if (!(t.width > 0) || !(t.height > 0)) return `slot ${String(i)} is empty`;
  }
  let sum = 0;
  for (const g of grown) {
    if (
      g.x0 < left - tolerance ||
      g.y0 < top - tolerance ||
      g.x1 > right + tolerance ||
      g.y1 > bottom + tolerance
    ) {
      return `slot ${String(g.slot)} is outside the canvas`;
    }
    sum += (g.x1 - g.x0) * (g.y1 - g.y0);
  }
  const expected = (right - left) * (bottom - top);
  // Each edge may be off by `tolerance`, so the area may be off by about
  // tolerance times the total perimeter.
  const perimeter = grown.reduce(
    (s, g) => s + 2 * (g.x1 - g.x0 + (g.y1 - g.y0)),
    0,
  );
  if (Math.abs(sum - expected) > tolerance * perimeter + 1e-9) {
    return `tiles cover ${String(sum)} but the canvas is ${String(expected)}`;
  }

  // Overlaps: sweep left to right, comparing only tiles whose x ranges meet.
  const sorted = [...grown].sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b || b.x0 >= a.x1 - tolerance) break;
      const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (overlapX > tolerance && overlapY > tolerance) {
        return `slots ${String(a.slot)} and ${String(b.slot)} overlap`;
      }
    }
  }
  return null;
}
