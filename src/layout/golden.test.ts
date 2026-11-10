// Fixed-output tests: these pin the exact plans the planner makes, so any
// change to the algorithm (or its constants) shows up here. If a change is
// intended, update the expected values, and note in the PR that layouts made
// before it will plan differently (saved projects store their plan, so they
// are unaffected).
import { describe, expect, it } from 'vitest';
import { planLayout, type LayoutNode } from './index';

/** A compact serialisation: axis, fraction to 6 places, children; or slot. */
function serialise(node: LayoutNode): string {
  return node.kind === 'leaf'
    ? String(node.slot)
    : `${node.axis}${node.fraction.toFixed(6)}(${serialise(node.first)},${serialise(node.second)})`;
}

/** FNV-1a, for pinning large plans without pasting them here. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function plan(
  width: number,
  height: number,
  count: number,
  variation: number,
  seed: number,
): string {
  const { root } = planLayout({ width, height, count, variation, seed });
  if (!root) throw new Error('empty plan');
  return serialise(root);
}

describe('golden plans', () => {
  it('makes exactly these small plans', () => {
    expect(plan(4, 3, 6, 0.5, 1)).toBe(
      'x0.762229(y0.444544(x0.449561(4,3),x0.698863(0,1)),y0.484650(2,5))',
    );
    expect(plan(1, 1, 5, 0, 42)).toBe(
      'y0.577387(x0.320050(1,x0.492231(3,2)),x0.546386(4,0))',
    );
    expect(plan(16, 9, 4, 1, 7)).toBe(
      'x0.345328(y0.469243(3,x0.467088(1,0)),2)',
    );
  });

  it('makes exactly these larger plans', () => {
    expect(hash(plan(3, 4, 30, 0, 3))).toBe('70b8baa9');
    expect(hash(plan(3, 4, 30, 1, 3))).toBe('bea8d545');
    expect(hash(plan(1, 1, 120, 0.62, 99))).toBe('126a9930');
    expect(hash(plan(9, 16, 200, 0.85, 2024))).toBe('64467c1e');
  });
});
