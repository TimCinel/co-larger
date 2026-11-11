/**
 * Deciding which level of each photo the image cache holds within its
 * budget, pure so it is testable in Node.
 *
 * Every photo in view is first given its thumbnail (cheap), most important
 * first; then the photos that want more are upgraded, most important first,
 * for as long as the budget allows. A photo that cannot be upgraded keeps
 * the level it has: the least important tiles are drawn from the thumbnail
 * or preview rather than the cache growing past its budget. Importance is
 * the tile's size on screen.
 */
import { LEVEL_RANK, type Level } from './image-source';

export interface PlanDemand {
  readonly id: string;
  /** Larger is more important (the tile's area in output pixels). */
  readonly priority: number;
  /** The level the tile would like, ignoring the budget. */
  readonly ideal: Level;
  /**
   * True for a photo that is not in view (decoded ahead of time): it only
   * gets a thumbnail, and only while that leaves half the budget free.
   */
  readonly optional: boolean;
  /**
   * Bytes to hold the photo at each level, counting what is kept below it
   * to draw while the sharper image decodes.
   */
  readonly cost: Readonly<Record<Level, number>>;
}

/**
 * The level to hold each photo at. A photo that cannot be held at all is
 * absent from the result. The sum of the costs of the chosen levels never
 * exceeds `budget`.
 */
export function planLevels(
  demands: readonly PlanDemand[],
  budget: number,
): Map<string, Level> {
  const sorted = [...demands].sort(
    (a, b) =>
      Number(a.optional) - Number(b.optional) ||
      b.priority - a.priority ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const chosen = new Map<string, Level>();
  let remaining = budget;
  for (const demand of sorted) {
    const cost = demand.cost.thumbnail;
    if (cost > remaining) continue;
    if (demand.optional && remaining - cost < budget / 2) continue;
    chosen.set(demand.id, 'thumbnail');
    remaining -= cost;
  }
  for (const demand of sorted) {
    if (!chosen.has(demand.id)) continue;
    const base = demand.cost.thumbnail;
    for (const level of ['detail', 'preview'] as const) {
      if (LEVEL_RANK[level] > LEVEL_RANK[demand.ideal]) continue;
      const extra = demand.cost[level] - base;
      if (extra <= remaining) {
        chosen.set(demand.id, level);
        remaining -= extra;
        break;
      }
    }
  }
  return chosen;
}
