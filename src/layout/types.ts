/**
 * The axis a split cuts along.
 *
 * - `'x'`: a vertical cut. The two children sit side by side, left then right.
 * - `'y'`: a horizontal cut. The two children are stacked, top then bottom.
 */
export type Axis = 'x' | 'y';

/** A single tile (slot) in the layout tree. */
export interface LeafNode {
  readonly kind: 'leaf';
  /** The slot this leaf holds, from 0 to `count - 1`. */
  readonly slot: number;
}

/** A guillotine cut dividing a rectangle into two. */
export interface SplitNode {
  readonly kind: 'split';
  readonly axis: Axis;
  /**
   * The share of the available length (after subtracting one gap) given to
   * `first`, strictly between 0 and 1. `second` gets the rest.
   */
  readonly fraction: number;
  /** The left (axis `'x'`) or top (axis `'y'`) child. */
  readonly first: LayoutNode;
  /** The right (axis `'x'`) or bottom (axis `'y'`) child. */
  readonly second: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

/** Inputs that decide the arrangement. The border is not one of them. */
export interface PlanOptions {
  /** Canvas width, in any unit. Only the ratio of width to height matters. */
  readonly width: number;
  /** Canvas height, in the same unit as `width`. */
  readonly height: number;
  /** Number of tiles, a non-negative integer. */
  readonly count: number;
  /**
   * Size variation from 0 (all tiles roughly equal in area) to 1 (a few very
   * large tiles and many small ones). Values outside 0..1 are clamped.
   */
  readonly variation: number;
  /** Any finite number. The same seed and inputs give the same layout. */
  readonly seed: number;
}

/**
 * A resolution-independent mosaic: a guillotine tree whose leaves are the
 * slots. Plain data, so it can be serialised as JSON.
 */
export interface LayoutPlan {
  /** Canvas width divided by height that the plan was made for. */
  readonly aspect: number;
  readonly count: number;
  readonly variation: number;
  readonly seed: number;
  /**
   * `'grid'` for a Grid layout (#20, see grid.ts); absent for a mosaic (the
   * key is missing, so a mosaic plan is exactly what it was before grids
   * existed). It changes how cuts are placed: in a mosaic a cut gives
   * `first` the share `fraction` of its region's length minus one gap; in a
   * grid it gives `first` the share `fraction` of the length plus one gap,
   * minus that gap (`fraction * (length + gap) - gap`), so that cuts at
   * a/n split n equal tiles into a and n - a equal tiles at any border.
   * With no border the two rules agree. A grid plan's tree must be exactly
   * the grid tree for its count and columns (validatePlan checks it).
   */
  readonly kind?: 'grid';
  /** `null` only when `count` is 0. */
  readonly root: LayoutNode | null;
}

/** A tile's rectangle on a concrete canvas. */
export interface Tile {
  /** Stable slot identity: 0 to `count - 1`, the same for every placement. */
  readonly slot: number;
  /** Left edge, from the canvas's left edge. */
  readonly x: number;
  /** Top edge, from the canvas's top edge. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where to place a plan. */
export interface PlaceOptions {
  /** Canvas width, in output units (for example pixels). */
  readonly width: number;
  /** Canvas height, in output units. */
  readonly height: number;
  /**
   * Outer margin and gap between tiles, in output units. Defaults to 0.
   * Changing it never changes the arrangement, only the gaps.
   */
  readonly border?: number;
  /**
   * Snap every edge to whole units (pixels). Tiles still tile exactly, with
   * every gap exactly `round(border)` wide. Defaults to false.
   */
  readonly snap?: boolean;
}
