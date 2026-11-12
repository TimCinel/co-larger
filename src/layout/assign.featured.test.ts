// Featured photos in the pure placement (#14).
import { describe, expect, it } from 'vitest';
import {
  arrangementStep,
  assignPhotos,
  largestSlots,
  placeLayout,
  planLayout,
  slotsBySize,
  validateAssignment,
  type PhotoShape,
  type SlotShape,
} from './index';

const RATIOS = [
  [16, 9],
  [9, 16],
  [1, 1],
  [4, 5],
  [7, 5],
] as const;
const DIALS = Array.from({ length: 20 }, (_, i) => i / 19);

function mix(count: number): PhotoShape[] {
  const aspects = [4 / 3, 3 / 2, 3 / 4, 2 / 3, 1, 16 / 9, 9 / 16];
  return Array.from({ length: count }, (_, i) => ({
    id: `p${String(i)}`,
    aspect: aspects[(i * 5) % aspects.length] as number,
  }));
}

const areaOf = (s: SlotShape): number => s.width * s.height;

/** Every featured photo's slot is at least as large as every other slot. */
function featuredAreLargest(
  slots: readonly SlotShape[],
  assignment: readonly string[],
  featured: ReadonlySet<string>,
): boolean {
  let minFeatured = Infinity;
  let maxOther = 0;
  for (const [slot, id] of assignment.entries()) {
    const a = areaOf(slots[slot] as SlotShape);
    if (featured.has(id)) minFeatured = Math.min(minFeatured, a);
    else maxOther = Math.max(maxOther, a);
  }
  return minFeatured >= maxOther;
}

describe('largestSlots', () => {
  it('ranks by area, largest first, equal areas in slot order', () => {
    const slots = [
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 4, height: 1 },
      { width: 1, height: 4 },
      { width: 3, height: 3 },
    ];
    expect(slotsBySize(slots)).toEqual([4, 1, 2, 3, 0]);
    expect(largestSlots(slots, 2)).toEqual([4, 1]);
    expect(largestSlots(slots, 0)).toEqual([]);
    expect(largestSlots(slots, 9)).toEqual([4, 1, 2, 3, 0]);
  });
});

describe('assignPhotos with featured photos', () => {
  it('puts 1, 2 and 5 featured photos of 30 in the largest slots: many seeds, dials and ratios', () => {
    const photos = mix(30);
    let cases = 0;
    for (const [w, h] of RATIOS) {
      for (const dial of DIALS) {
        for (let seed = 1; seed <= 10; seed++) {
          const plan = planLayout({
            width: w,
            height: h,
            count: 30,
            variation: arrangementStep(dial),
            seed,
          });
          const slots = placeLayout(plan, { width: w * 100, height: h * 100 });
          for (const k of [1, 2, 5]) {
            // A different featured set for each seed.
            const featured = new Set(
              photos.filter((_, i) => (i * 7 + seed) % 30 < k).map((p) => p.id),
            );
            expect(featured.size).toBe(k);
            const a = assignPhotos(slots, photos, { seed, featured });
            validateAssignment(a, photos);
            expect(featuredAreLargest(slots, a, featured)).toBe(true);
            // Deterministic, and independent of the order of the photos and
            // of the featured ids.
            expect(
              assignPhotos(slots, [...photos].reverse(), {
                seed,
                featured: [...featured].reverse(),
              }),
            ).toEqual(a);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(RATIOS.length * DIALS.length * 10 * 3);
  });

  it('is exactly the plain assignment with nothing, an excluded photo, or everything featured', () => {
    const photos = mix(30);
    for (const [w, h] of RATIOS) {
      for (const seed of [3, 4, 5]) {
        const plan = planLayout({
          width: w,
          height: h,
          count: 30,
          variation: 0.7,
          seed,
        });
        const slots = placeLayout(plan, { width: w * 100, height: h * 100 });
        const plain = assignPhotos(slots, photos, { seed });
        expect(assignPhotos(slots, photos, { seed, featured: [] })).toEqual(
          plain,
        );
        expect(
          assignPhotos(slots, photos, { seed, featured: ['not-here'] }),
        ).toEqual(plain);
        expect(
          assignPhotos(slots, photos, {
            seed,
            featured: photos.map((p) => p.id),
          }),
        ).toEqual(plain);
      }
    }
  });

  it('matches featured photos by shape among the large slots', () => {
    // Two large slots, one portrait and one landscape, and small ones.
    const slots: SlotShape[] = [
      { width: 4, height: 1 },
      { width: 30, height: 40 },
      { width: 1, height: 1 },
      { width: 40, height: 30 },
      { width: 1, height: 2 },
    ];
    const photos: PhotoShape[] = [
      { id: 'small-a', aspect: 1 },
      { id: 'landscape', aspect: 4 / 3 },
      { id: 'small-b', aspect: 4 },
      { id: 'portrait', aspect: 3 / 4 },
      { id: 'small-c', aspect: 0.5 },
    ];
    for (let seed = 0; seed < 50; seed++) {
      const a = assignPhotos(slots, photos, {
        seed,
        featured: ['portrait', 'landscape'],
      });
      expect(a[1]).toBe('portrait');
      expect(a[3]).toBe('landscape');
    }
    // One feature: the two large slots have equal areas, so the tie goes to
    // the lower slot number (the portrait one) for any photo.
    for (const id of ['portrait', 'landscape']) {
      expect(assignPhotos(slots, photos, { seed: 1, featured: [id] })[1]).toBe(
        id,
      );
    }
    // Make the landscape slot strictly largest: a single portrait feature
    // takes it anyway (size first, then shape).
    const wider = slots.map((s, i) =>
      i === 3 ? { width: 41, height: 30 } : s,
    );
    const one = assignPhotos(wider, photos, {
      seed: 1,
      featured: ['portrait'],
    });
    expect(one[3]).toBe('portrait');
  });

  it('copes with more featured photos than large slots (uniform dial)', () => {
    const photos = mix(30);
    const plan = planLayout({
      width: 16,
      height: 9,
      count: 30,
      variation: 0,
      seed: 8,
    });
    const slots = placeLayout(plan, { width: 1600, height: 900 });
    for (const k of [10, 25, 29]) {
      const featured = new Set(photos.slice(0, k).map((p) => p.id));
      const a = assignPhotos(slots, photos, { seed: 8, featured });
      validateAssignment(a, photos);
      expect(featuredAreLargest(slots, a, featured)).toBe(true);
    }
  });

  it('takes the given featured slots, and rejects bad ones', () => {
    const photos = mix(6);
    const slots = placeLayout(
      planLayout({ width: 3, height: 2, count: 6, variation: 1, seed: 2 }),
      { width: 300, height: 200 },
    );
    const a = assignPhotos(slots, photos, {
      seed: 2,
      featured: ['p0', 'p1'],
      featuredSlots: [0, 5],
    });
    expect([a[0], a[5]].sort()).toEqual(['p0', 'p1']);
    for (const bad of [[0], [0, 0], [0, 6], [0, 1.5], [0, 1, 2]]) {
      expect(() =>
        assignPhotos(slots, photos, {
          seed: 2,
          featured: ['p0', 'p1'],
          featuredSlots: bad,
        }),
      ).toThrow(RangeError);
    }
  });
});
