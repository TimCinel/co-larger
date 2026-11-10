/**
 * The mosaic layout engine: pure functions with no DOM or UI dependencies.
 *
 * Typical use:
 *
 * ```ts
 * const plan = planLayout({ width: 4961, height: 7016, count: 120, variation: 0.6, seed });
 * const preview = placeLayout(plan, { width: 496.1, height: 701.6, border: 1.2 });
 * const exported = placeLayout(plan, { width: 4961, height: 7016, border: 12, snap: true });
 * ```
 *
 * Plan once per arrangement (canvas ratio, count, variation, seed), then
 * place that same plan at whatever size is needed.
 *
 * Reuse the plan; do not plan again. The planner is deterministic for exactly
 * the same inputs on the same JavaScript engine, but its choices depend on
 * floating-point results: planning again from a slightly different width and
 * height (export pixels instead of preview pixels), or in another browser
 * whose Math.pow, Math.exp or Math.log differ in the last bit, can give a
 * different arrangement. So the export (#11) must place the editor's plan,
 * and a saved project (#12) must store the plan itself (it is plain JSON),
 * not just the seed. Load a stored plan through validatePlan.
 *
 * Borders: the border control should be clamped to
 * `Math.min(maxBorder(...), maxBorderForAspect(plan, w, h, 3))` so that no
 * tile vanishes or becomes more stretched than 3:1.
 */
import { planLayout } from './plan';
import { placeLayout } from './place';
import type { PlaceOptions, PlanOptions, Tile } from './types';

export { MAX_PLAN_ASPECT, planAspectLimit, planLayout } from './plan';
export {
  maxBorder,
  maxBorderForAspect,
  placeLayout,
  type BorderLimitOptions,
} from './place';
export {
  assignPhotos,
  cropFraction,
  PLACEMENT_NOISE,
  placementCost,
  swapSlots,
  validateAssignment,
  weightedCrop,
  type AssignOptions,
  type Assignment,
  type PhotoShape,
  type SlotShape,
} from './assign';
export { validatePlan } from './validate';
export type {
  Axis,
  LayoutNode,
  LayoutPlan,
  LeafNode,
  PlaceOptions,
  PlanOptions,
  SplitNode,
  Tile,
} from './types';

/** Options for {@link layoutMosaic}: plan and place in one call. */
export interface MosaicOptions
  extends PlanOptions, Pick<PlaceOptions, 'border' | 'snap'> {}

/** Plans a layout and places it on a `width` × `height` canvas. */
export function layoutMosaic(options: MosaicOptions): Tile[] {
  const { border, snap, ...plan } = options;
  return placeLayout(planLayout(plan), {
    width: plan.width,
    height: plan.height,
    border,
    snap,
  });
}
