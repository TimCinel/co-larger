import { describe, expect, it } from 'vitest';
import { planLayout, validatePlan, type LayoutNode } from './index';

const valid = planLayout({
  width: 3,
  height: 2,
  count: 4,
  variation: 0.5,
  seed: 1,
});

/** A deep copy of `valid` as plain JSON, to mutate. */
function copy(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
}

const leaf = (slot: number): LayoutNode => ({ kind: 'leaf', slot });
const split = (
  first: LayoutNode,
  second: LayoutNode,
  fraction = 0.5,
): LayoutNode => ({ kind: 'split', axis: 'x', fraction, first, second });

describe('validatePlan', () => {
  it('accepts plans from planLayout, including after a JSON round trip', () => {
    expect(validatePlan(valid)).toBe(valid);
    expect(validatePlan(copy())).toEqual(valid);
    for (const count of [0, 1, 2, 50, 200]) {
      const plan = planLayout({
        width: 1,
        height: 1,
        count,
        variation: 1,
        seed: 9,
      });
      expect(() =>
        validatePlan(JSON.parse(JSON.stringify(plan))),
      ).not.toThrow();
    }
  });

  it('rejects the wrong shape with a TypeError', () => {
    const base = { aspect: 1, count: 2, variation: 0, seed: 1 };
    for (const bad of [
      null,
      'plan',
      42,
      { ...base, root: null },
      { ...base, root: 'leaf' },
      { ...base, root: { kind: 'branch' } },
      {
        ...base,
        root: {
          kind: 'split',
          axis: 'z',
          fraction: 0.5,
          first: leaf(0),
          second: leaf(1),
        },
      },
      {
        ...base,
        root: { kind: 'split', axis: 'x', fraction: 0.5, first: leaf(0) },
      },
      {
        ...base,
        root: split(leaf(0), {
          kind: 'leaf',
          slot: '1',
        } as unknown as LayoutNode),
      },
      { ...base, count: 0, root: leaf(0) },
    ]) {
      expect(() => validatePlan(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('rejects out-of-range values with a RangeError', () => {
    const base = { aspect: 1, count: 2, variation: 0, seed: 1 };
    for (const bad of [
      { ...base, aspect: 0, root: split(leaf(0), leaf(1)) },
      { ...base, aspect: Number.NaN, root: split(leaf(0), leaf(1)) },
      { ...base, count: 1.5, root: split(leaf(0), leaf(1)) },
      { ...base, variation: 2, root: split(leaf(0), leaf(1)) },
      { ...base, seed: Number.NaN, root: split(leaf(0), leaf(1)) },
      { ...base, root: split(leaf(0), leaf(1), 0) },
      { ...base, root: split(leaf(0), leaf(1), 1) },
      { ...base, root: split(leaf(0), leaf(1), 1.5) },
      { ...base, root: split(leaf(0), leaf(1), Number.NaN) },
      { ...base, root: split(leaf(0), leaf(0)) }, // duplicate slot
      { ...base, root: split(leaf(0), leaf(2)) }, // slot out of range
      { ...base, root: split(leaf(0), leaf(-1)) },
      { ...base, root: leaf(0) }, // missing slot 1
      { ...base, count: 1, root: split(leaf(0), leaf(1)) }, // too many leaves
    ]) {
      expect(() => validatePlan(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('rejects shared and cyclic subtrees without hanging', () => {
    const shared = split(leaf(0), leaf(1));
    expect(() =>
      validatePlan({
        aspect: 1,
        count: 4,
        variation: 0,
        seed: 1,
        root: split(shared, shared),
      }),
    ).toThrow(RangeError);
    const cyclic: Record<string, unknown> = {
      kind: 'split',
      axis: 'x',
      fraction: 0.5,
      first: leaf(0),
    };
    cyclic.second = cyclic;
    expect(() =>
      validatePlan({
        aspect: 1,
        count: 3,
        variation: 0,
        seed: 1,
        root: cyclic,
      }),
    ).toThrow(RangeError);
  });
});
