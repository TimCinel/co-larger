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
 * Plan once per arrangement (canvas ratio, count, variation, seed), then place
 * it at whatever size is needed.
 */
import { planLayout } from './plan';
import { placeLayout } from './place';
import type { PlaceOptions, PlanOptions, Tile } from './types';

export { MAX_PLAN_ASPECT, planLayout } from './plan';
export { maxBorder, placeLayout } from './place';
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
