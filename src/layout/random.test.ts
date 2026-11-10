import { describe, expect, it } from 'vitest';
import { createRandom, hashUnit, shuffledIndices, toSeed } from './random';

describe('createRandom', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = createRandom(123);
    const b = createRandom(123);
    for (let i = 0; i < 10_000; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const random = createRandom(7);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const bucket = Math.floor(random() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });
});

describe('toSeed', () => {
  it('distinguishes nearby seeds, including fractional ones', () => {
    const seeds = new Set([0, 1, 2, -1, 1.5, 2 ** 32, 2 ** 32 + 1].map(toSeed));
    expect(seeds.size).toBe(7);
  });
});

describe('hashUnit', () => {
  it('is deterministic, in [0, 1), and sensitive to every argument', () => {
    expect(hashUnit(1, 2, 3)).toBe(hashUnit(1, 2, 3));
    expect(hashUnit(1, 2, 3)).not.toBe(hashUnit(1, 2, 4));
    expect(hashUnit(1, 2, 3)).not.toBe(hashUnit(3, 2, 1));
    const value = hashUnit(9, 9);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});

describe('shuffledIndices', () => {
  it('returns a permutation', () => {
    const random = createRandom(1);
    const p = shuffledIndices(100, random);
    expect([...p].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
    expect(p).not.toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});
