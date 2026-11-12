import { describe, expect, it } from 'vitest';
import { MIN_STAR_TILE, STAR, starCorner } from './feature-markers';

/** The star's and the badge's boxes for a tile, in tile coordinates. */
function boxes(w: number, h: number, corner: 'top-left' | 'bottom-left') {
  const star =
    corner === 'top-left'
      ? { x: 4, y: 4, w: STAR, h: STAR }
      : { x: 4, y: h - 4 - STAR, w: STAR, h: STAR };
  const badge = { x: w - 4 - 20, y: 4, w: 20, h: 20 };
  return { star, badge };
}

describe('starCorner', () => {
  it('is top-left with no badge, and none on tiles under the minimum', () => {
    expect(starCorner(200, 100, false)).toBe('top-left');
    expect(starCorner(MIN_STAR_TILE, MIN_STAR_TILE, false)).toBe('top-left');
    expect(starCorner(MIN_STAR_TILE - 1, 200, false)).toBeNull();
    expect(starCorner(200, MIN_STAR_TILE - 1, true)).toBeNull();
  });

  it('never overlaps the low-resolution badge, and stays inside the tile', () => {
    for (let w = 0; w <= 120; w++) {
      for (let h = 0; h <= 120; h++) {
        const corner = starCorner(w, h, true);
        if (corner === null) continue;
        const { star, badge } = boxes(w, h, corner);
        const apart =
          star.x + star.w <= badge.x ||
          badge.x + badge.w <= star.x ||
          star.y + star.h <= badge.y ||
          badge.y + badge.h <= star.y;
        expect(apart, `${String(w)} x ${String(h)}`).toBe(true);
        expect(star.y >= 0 && star.y + star.h <= h).toBe(true);
      }
    }
    expect(starCorner(40, 100, true)).toBe('bottom-left');
    expect(starCorner(40, 40, true)).toBeNull();
  });
});
