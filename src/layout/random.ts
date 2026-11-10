/**
 * Small, dependency-free seeded randomness for the layout engine. Nothing in
 * the layout uses Math.random, so a seed always reproduces the same layout.
 */

/** Normalises any finite number to an unsigned 32-bit seed. */
export function toSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`seed must be a finite number, got ${String(seed)}`);
  }
  // Fold in the fractional part too, so 1.5 and 1 are different seeds.
  const whole = Math.trunc(seed);
  const fraction = Math.round((seed - whole) * 0x100000000);
  const high = Math.floor(whole / 0x100000000);
  return mix32((whole | 0) ^ mix32(high ^ mix32(fraction ^ 0x9e3779b9)));
}

/** A 32-bit avalanche mix (the MurmurHash3 finaliser). */
export function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hashes a list of integers to a float in [0, 1). Used for randomness that
 * must stay attached to a particular decision (for example "this group of
 * tiles, split at this point") rather than to the order in which decisions
 * are made, so that nudging the size-variation dial does not reshuffle
 * unrelated parts of the layout.
 */
export function hashUnit(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = mix32(h ^ mix32(value | 0));
  }
  return h / 0x100000000;
}

/** A seeded PRNG (mulberry32) returning floats in [0, 1). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Returns a seeded random permutation of 0..n-1 (Fisher–Yates). */
export function shuffledIndices(n: number, random: () => number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i] as number;
    out[i] = out[j] as number;
    out[j] = tmp;
  }
  return out;
}
