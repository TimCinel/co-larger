import type { LayoutPlan } from './types';

/**
 * Checks that `value` is a well-formed LayoutPlan, for example one loaded
 * from a saved project, and returns it typed. Throws a TypeError for the
 * wrong shape (missing fields, wrong types, unknown node kinds) and a
 * RangeError for out-of-range values (a fraction outside (0, 1), a slot
 * outside 0..count-1, a missing or repeated slot, a non-positive aspect).
 *
 * placeLayout and the border functions call this themselves, so a bad plan
 * never yields holes or empty tiles silently.
 */
export function validatePlan(value: unknown): LayoutPlan {
  if (!isObject(value)) throw new TypeError('plan must be an object');
  const { aspect, count, variation, seed, root } = value;
  if (typeof aspect !== 'number' || !(aspect > 0) || !isFinite(aspect)) {
    throw new RangeError('plan.aspect must be a positive finite number');
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new RangeError('plan.count must be a non-negative integer');
  }
  if (typeof variation !== 'number' || !(variation >= 0 && variation <= 1)) {
    throw new RangeError('plan.variation must be a number from 0 to 1');
  }
  if (typeof seed !== 'number' || !isFinite(seed)) {
    throw new RangeError('plan.seed must be a finite number');
  }
  if (count === 0) {
    if (root !== null)
      throw new TypeError('plan.root must be null when count is 0');
    return value as unknown as LayoutPlan;
  }
  const seen = new Uint8Array(count);
  let leaves = 0;
  let nodes = 0;
  // An explicit stack rather than recursion, so a hostile deeply nested plan
  // cannot overflow the call stack.
  const stack: { node: unknown; path: string }[] = [
    { node: root, path: 'root' },
  ];
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: string };
    // A binary tree with `count` leaves has 2 * count - 1 nodes; more means a
    // shared or cyclic subtree.
    if (++nodes > 2 * count - 1) {
      throw new RangeError('plan has more nodes than count allows');
    }
    if (!isObject(node)) throw new TypeError(`${path} must be a node object`);
    if (node.kind === 'leaf') {
      const { slot } = node;
      if (typeof slot !== 'number' || !Number.isInteger(slot)) {
        throw new TypeError(`${path}.slot must be an integer`);
      }
      if (slot < 0 || slot >= count) {
        throw new RangeError(
          `${path}.slot ${String(slot)} is outside 0..${String(count - 1)}`,
        );
      }
      if (seen[slot])
        throw new RangeError(`slot ${String(slot)} appears more than once`);
      seen[slot] = 1;
      leaves++;
      if (leaves > count)
        throw new RangeError('plan has more leaves than count');
    } else if (node.kind === 'split') {
      const { axis, fraction } = node;
      if (axis !== 'x' && axis !== 'y') {
        throw new TypeError(`${path}.axis must be 'x' or 'y'`);
      }
      if (typeof fraction !== 'number' || !(fraction > 0 && fraction < 1)) {
        throw new RangeError(
          `${path}.fraction must be strictly between 0 and 1`,
        );
      }
      stack.push(
        { node: node.second, path: `${path}.second` },
        { node: node.first, path: `${path}.first` },
      );
    } else {
      throw new TypeError(`${path}.kind must be 'leaf' or 'split'`);
    }
  }
  if (leaves !== count) {
    throw new RangeError(
      `plan has ${String(leaves)} slots but count is ${String(count)}`,
    );
  }
  return value as unknown as LayoutPlan;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
