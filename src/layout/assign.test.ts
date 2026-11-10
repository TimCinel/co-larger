import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignPhotos,
  cropFraction,
  PLACEMENT_NOISE,
  placeLayout,
  planLayout,
  swapSlots,
  weightedCrop,
  type PhotoShape,
  type SlotShape,
  type Tile,
} from './index';
import { createRandom, shuffledIndices } from './random';
import { area, RATIO_PRESETS } from './test-helpers';

const DIALS = [0, 0.25, 0.5, 0.75, 1];

/** The tiles of a plan on a canvas of the given ratio, with no border. */
function slotsFor(
  ratio: readonly [number, number],
  count: number,
  variation: number,
  seed: number,
): Tile[] {
  const [width, height] = ratio;
  const plan = planLayout({ width, height, count, variation, seed });
  return placeLayout(plan, { width: width * 1000, height: height * 1000 });
}

/**
 * A realistic camera-roll mix: 60% landscape (half 4:3, half 3:2), 30%
 * portrait 3:4, and 10% oddities (half square, half 3:1 panoramas). The
 * kinds are interleaved so every prefix has about the same mix.
 */
function realisticPhotos(count: number): PhotoShape[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i % 10;
    let aspect: number;
    if (k < 3) aspect = 4 / 3;
    else if (k < 6) aspect = 3 / 2;
    else if (k < 9) aspect = 3 / 4;
    else aspect = i % 20 < 10 ? 1 : 3;
    return { id: `photo-${String(i)}`, aspect };
  });
}

/** A seeded random assignment: the baseline to beat. */
function randomAssignment(photos: readonly PhotoShape[], seed: number) {
  return shuffledIndices(photos.length, createRandom(seed)).map(
    (p) => (photos[p] as PhotoShape).id,
  );
}

function expectPermutation(
  assignment: readonly string[],
  photos: readonly PhotoShape[],
): void {
  expect(assignment).toHaveLength(photos.length);
  expect([...assignment].sort()).toEqual(photos.map((p) => p.id).sort());
}

/** Slot numbers from largest area to smallest. */
function bySize(slots: readonly Tile[]): number[] {
  return slots
    .map((t) => t.slot)
    .sort((a, b) => area(slots[b] as Tile) - area(slots[a] as Tile));
}

describe('cropFraction', () => {
  it('is 0 for a match and grows with the mismatch, either way round', () => {
    expect(cropFraction(1.5, 1.5)).toBe(0);
    expect(cropFraction(4 / 3, 3 / 4)).toBeCloseTo(1 - 9 / 16, 12);
    expect(cropFraction(3 / 4, 4 / 3)).toBeCloseTo(1 - 9 / 16, 12);
    expect(cropFraction(4 / 3, 3 / 2)).toBeCloseTo(1 - 8 / 9, 12);
    expect(cropFraction(3, 1)).toBeCloseTo(2 / 3, 12);
  });
});

describe('crop versus random assignment', () => {
  // 11 ratio presets × 5 dials × 3 counts × 4 seeds = 660 layouts. The
  // random baseline for each layout is the mean of 5 random assignments.
  it('crops under 80% as much as random on every preset and dial, and under 60% overall', () => {
    let oursTotal = 0;
    let randomTotal = 0;
    for (const ratio of RATIO_PRESETS) {
      for (const dial of DIALS) {
        let ours = 0;
        let random = 0;
        for (const count of [12, 40, 120]) {
          const photos = realisticPhotos(count);
          for (const seed of [1, 2, 3, 4]) {
            const slots = slotsFor(ratio, count, dial, seed);
            const assignment = assignPhotos(slots, photos, { seed });
            expectPermutation(assignment, photos);
            ours += weightedCrop(slots, photos, assignment);
            for (let r = 0; r < 5; r++) {
              random +=
                weightedCrop(
                  slots,
                  photos,
                  randomAssignment(photos, seed * 100 + r),
                ) / 5;
            }
          }
        }
        const label = `${ratio.join(':')} dial ${String(dial)}`;
        expect(ours / random, label).toBeLessThan(0.8);
        oursTotal += ours;
        randomTotal += random;
      }
    }
    // Measured: 0.53 overall; 0.74 for the worst preset and dial (where
    // the slot shapes match the photo mix least well).
    expect(oursTotal / randomTotal).toBeLessThan(0.6);
  }, 60_000);

  it('stays within PLACEMENT_NOISE of the best possible assignment', () => {
    for (const ratio of RATIO_PRESETS) {
      for (const dial of DIALS) {
        const photos = realisticPhotos(40);
        const slots = slotsFor(ratio, 40, dial, 7);
        const best = weightedCrop(
          slots,
          photos,
          assignPhotos(slots, photos, { seed: 7, noise: 0 }),
        );
        for (const seed of [1, 2, 3]) {
          const ours = weightedCrop(
            slots,
            photos,
            assignPhotos(slots, photos, { seed }),
          );
          expect(ours).toBeGreaterThanOrEqual(best - 1e-12);
          expect(ours).toBeLessThanOrEqual(best + PLACEMENT_NOISE);
        }
      }
    }
  });

  it('crops nothing when the photos are exactly the slot shapes', () => {
    const slots = slotsFor([3, 4], 60, 0.6, 3);
    const order = shuffledIndices(slots.length, createRandom(9));
    const photos = order.map((s, i) => {
      const t = slots[s] as Tile;
      return { id: `p${String(i)}`, aspect: t.width / t.height };
    });
    const exact = assignPhotos(slots, photos, { seed: 1, noise: 0 });
    expect(weightedCrop(slots, photos, exact)).toBeLessThan(1e-12);
    // With the default noise, any compromise is tiny.
    const seeded = assignPhotos(slots, photos, { seed: 1 });
    expect(weightedCrop(slots, photos, seeded)).toBeLessThan(0.01);
  });

  it('puts portrait photos in the large portrait slots and landscape in landscape', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const slots = slotsFor([1, 1], 40, 0.8, seed);
      const photos = realisticPhotos(40);
      const assignment = assignPhotos(slots, photos, { seed });
      const aspectOf = new Map(photos.map((p) => [p.id, p.aspect]));
      // The ten largest slots: each clearly shaped slot gets a photo of the
      // same orientation (the mix has plenty of each).
      for (const slot of bySize(slots).slice(0, 10)) {
        const t = slots[slot] as Tile;
        const slotAspect = t.width / t.height;
        const photoAspect = aspectOf.get(assignment[slot] as string) as number;
        if (slotAspect < 0.85) expect(photoAspect).toBeLessThan(1);
        if (slotAspect > 1.15) expect(photoAspect).toBeGreaterThan(1);
      }
    }
  });
});

describe('determinism and variety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives the same assignment for the same seed, and survives JSON', () => {
    const slots = slotsFor([4, 5], 80, 0.5, 11);
    const photos = realisticPhotos(80);
    const a = assignPhotos(slots, photos, { seed: 42 });
    const b = assignPhotos(slots, photos, { seed: 42 });
    expect(b).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('does not depend on the order of the photo list', () => {
    const slots = slotsFor([16, 9], 50, 0.7, 2);
    const photos = realisticPhotos(50);
    const reordered = shuffledIndices(50, createRandom(5)).map(
      (i) => photos[i] as PhotoShape,
    );
    expect(assignPhotos(slots, reordered, { seed: 3 })).toEqual(
      assignPhotos(slots, photos, { seed: 3 }),
    );
  });

  it('does not use Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    assignPhotos(slotsFor([1, 1], 30, 0.5, 1), realisticPhotos(30), {
      seed: 1,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('puts different photos in the largest slots for different seeds', () => {
    // Same slots, only the assignment seed changes, so this isolates the
    // assignment's own variety from the layout's.
    for (const dial of [0, 0.5, 1]) {
      const slots = slotsFor([3, 4], 30, dial, 5);
      const photos = realisticPhotos(30);
      const [largest, second, third] = bySize(slots) as [
        number,
        number,
        number,
      ];
      const featured = new Set<string>();
      let changed = 0;
      let previous: string[] = [];
      for (let seed = 1; seed <= 20; seed++) {
        const a = assignPhotos(slots, photos, { seed });
        featured.add(a[largest] as string);
        const top = [largest, second, third].map((s) => a[s] as string);
        if (top.some((id, i) => id !== previous[i])) changed++;
        previous = top;
      }
      // About 9 photos fit the largest slot equally well; 20 seeds should
      // feature most of them.
      expect(featured.size, `dial ${String(dial)}`).toBeGreaterThanOrEqual(6);
      expect(changed).toBe(20);
    }
  });

  it('varies the largest slot even when no two photos share an aspect', () => {
    const random = createRandom(77);
    const photos = Array.from({ length: 40 }, (_, i) => ({
      id: `p${String(i)}`,
      // Landscape photos from 1.25 to 1.6 and portrait ones from 0.6 to 0.8.
      aspect: i % 3 === 0 ? 0.6 + 0.2 * random() : 1.25 + 0.35 * random(),
    }));
    const layouts: [readonly [number, number], number][] = [
      [[1, 1], 3],
      [[1, 1], 1],
      [[3, 4], 2],
      [[16, 9], 4],
      [[4, 5], 5],
    ];
    let total = 0;
    for (const [ratio, layoutSeed] of layouts) {
      const slots = slotsFor(ratio, 40, 1, layoutSeed);
      const largest = bySize(slots)[0] as number;
      const featured = new Set<string>();
      for (let seed = 1; seed <= 20; seed++) {
        featured.add(assignPhotos(slots, photos, { seed })[largest] as string);
      }
      // A slot shaped like the edge of the photo mix (say 0.87, when the
      // portrait photos stop at 0.8) has only one or two good candidates.
      expect(featured.size).toBeGreaterThanOrEqual(2);
      total += featured.size;
    }
    // Measured: 2, 4, 6, 5 and 3 different photos over 20 seeds.
    expect(total / layouts.length).toBeGreaterThanOrEqual(3.5);
  });
});

describe('edge cases', () => {
  it('handles photos that all have the same aspect', () => {
    const slots = slotsFor([5, 7], 60, 0.6, 4);
    const photos = Array.from({ length: 60 }, (_, i) => ({
      id: `p${String(i)}`,
      aspect: 3 / 2,
    }));
    const a = assignPhotos(slots, photos, { seed: 1 });
    const b = assignPhotos(slots, photos, { seed: 2 });
    expectPermutation(a, photos);
    // Every assignment crops the same; the seed still shuffles.
    expect(weightedCrop(slots, photos, a)).toBeCloseTo(
      weightedCrop(slots, photos, randomAssignment(photos, 1)),
      12,
    );
    expect(b).not.toEqual(a);
  });

  it('handles slots that are all one orientation', () => {
    const slots: SlotShape[] = Array.from({ length: 20 }, (_, i) => ({
      width: 300 + 10 * i,
      height: 200,
    }));
    const photos = realisticPhotos(20);
    const a = assignPhotos(slots, photos, { seed: 3 });
    expectPermutation(a, photos);
    const best = weightedCrop(
      slots,
      photos,
      assignPhotos(slots, photos, { seed: 3, noise: 0 }),
    );
    expect(weightedCrop(slots, photos, a)).toBeLessThanOrEqual(
      best + PLACEMENT_NOISE,
    );
    // Note what "least cropped" means here: with every photo narrower than
    // every slot, the optimum sacrifices the portrait photos to the widest
    // slots so that the landscape ones fit the narrowest slots well, rather
    // than cropping everything moderately.
    expect(weightedCrop(slots, photos, a)).toBeLessThan(
      weightedCrop(slots, photos, randomAssignment(photos, 3)),
    );
  });

  it('puts panoramas and very tall photos in the most stretched slots', () => {
    const slots: SlotShape[] = [
      { width: 250, height: 100 },
      { width: 100, height: 250 },
      { width: 100, height: 100 },
      { width: 140, height: 100 },
      { width: 100, height: 140 },
    ];
    const photos: PhotoShape[] = [
      { id: 'square', aspect: 1 },
      { id: 'tall', aspect: 1 / 6 },
      { id: 'landscape', aspect: 4 / 3 },
      { id: 'panorama', aspect: 6 },
      { id: 'portrait', aspect: 3 / 4 },
    ];
    for (const seed of [1, 2, 3]) {
      expect(assignPhotos(slots, photos, { seed })).toEqual([
        'panorama',
        'tall',
        'square',
        'landscape',
        'portrait',
      ]);
    }
  });

  it('handles one photo and no photos', () => {
    expect(
      assignPhotos([{ width: 3, height: 2 }], [{ id: 'a', aspect: 0.5 }], {
        seed: 1,
      }),
    ).toEqual(['a']);
    expect(assignPhotos([], [], { seed: 1 })).toEqual([]);
    expect(weightedCrop([], [], [])).toBe(0);
  });

  it('throws when the number of photos and slots differ', () => {
    const slots = slotsFor([1, 1], 5, 0.5, 1);
    expect(() => assignPhotos(slots, realisticPhotos(4), { seed: 1 })).toThrow(
      RangeError,
    );
    expect(() => assignPhotos(slots, realisticPhotos(6), { seed: 1 })).toThrow(
      /one photo per slot/,
    );
  });

  it('rejects bad inputs', () => {
    const slots: SlotShape[] = [
      { width: 1, height: 1 },
      { width: 2, height: 1 },
    ];
    const ok: PhotoShape[] = [
      { id: 'a', aspect: 1 },
      { id: 'b', aspect: 2 },
    ];
    const seed = { seed: 1 };
    expect(() =>
      assignPhotos(slots, [ok[0] as PhotoShape, { id: 'a', aspect: 2 }], seed),
    ).toThrow(/duplicate/);
    for (const aspect of [0, -1, Number.NaN, Infinity]) {
      expect(() =>
        assignPhotos(slots, [ok[0] as PhotoShape, { id: 'b', aspect }], seed),
      ).toThrow(RangeError);
    }
    expect(() =>
      assignPhotos([{ width: 0, height: 1 }, slots[1] as SlotShape], ok, seed),
    ).toThrow(RangeError);
    expect(() => assignPhotos(slots, ok, { seed: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => assignPhotos(slots, ok, { seed: 1, noise: -1 })).toThrow(
      RangeError,
    );
    expect(() => weightedCrop(slots, ok, ['a'])).toThrow(RangeError);
    expect(() => weightedCrop(slots, ok, ['a', 'z'])).toThrow(/unknown/);
  });
});

describe('swapSlots', () => {
  it('swaps two slots without changing the original', () => {
    const original = ['a', 'b', 'c'];
    expect(swapSlots(original, 0, 2)).toEqual(['c', 'b', 'a']);
    expect(swapSlots(original, 1, 1)).toEqual(original);
    expect(original).toEqual(['a', 'b', 'c']);
    expect(() => swapSlots(original, 0, 3)).toThrow(RangeError);
    expect(() => swapSlots(original, -1, 0)).toThrow(RangeError);
    expect(() => swapSlots(original, 0.5, 0)).toThrow(RangeError);
  });
});

describe('performance', () => {
  it('assigns 200 photos in under 100 ms on every preset', () => {
    let worst = 0;
    for (const [i, ratio] of RATIO_PRESETS.entries()) {
      const slots = slotsFor(ratio, 200, i / 10, i);
      const photos = realisticPhotos(200);
      const started = performance.now();
      assignPhotos(slots, photos, { seed: i });
      worst = Math.max(worst, performance.now() - started);
    }
    expect(worst).toBeLessThan(100);
  });
});
