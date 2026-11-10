/**
 * The pure logic behind the canvas settings controls: ratio presets and the
 * pixel size each gives, parsing and validating typed sizes, the aspect
 * lock's arithmetic, and the border slider's range. No DOM, so it is tested
 * in Node.
 */
import {
  borderAt,
  MAX_BORDER_FRACTION,
  MAX_CANVAS_SIDE,
  type EditorState,
} from './state';

/** A ratio preset: width : height. */
export interface RatioPreset {
  /** "16:9". */
  readonly label: string;
  readonly w: number;
  readonly h: number;
}

const preset = (w: number, h: number): RatioPreset => ({
  label: `${String(w)}:${String(h)}`,
  w,
  h,
});

/** The ratio presets, in the order the issue lists them. */
export const RATIO_PRESETS: readonly RatioPreset[] = [
  preset(1, 1),
  preset(1, 2),
  preset(2, 1),
  preset(3, 4),
  preset(4, 3),
  preset(4, 5),
  preset(5, 4),
  preset(5, 7),
  preset(7, 5),
  preset(9, 16),
  preset(16, 9),
];

/**
 * Choosing a preset sets the canvas's longer side to this many pixels and
 * the shorter side to match: 16:9 is 1920 × 1080, 9:16 is 1080 × 1920, 1:1
 * is 1920 × 1920, 4:5 is 1536 × 1920 and 5:7 is 1371 × 1920 (rounded to a
 * whole pixel). Full HD is a size every screen shows and every printer
 * can scale from; the editor is not tied to it (type any size, or use the
 * paper sizes of #7).
 */
export const PRESET_LONG_SIDE = 1920;

/** The pixel size choosing `preset` gives. */
export function presetSize(p: RatioPreset): {
  readonly width: number;
  readonly height: number;
} {
  const long = PRESET_LONG_SIDE;
  const short = Math.round((long * Math.min(p.w, p.h)) / Math.max(p.w, p.h));
  return p.w >= p.h
    ? { width: long, height: short }
    : { width: short, height: long };
}

/**
 * A size counts as a preset's ratio when it is within this relative
 * difference of it: tight enough that 1920 × 1080 and 3840 × 2160 are both
 * 16:9 but a custom 1920 × 1000 is not, loose enough for the rounding of 5:7
 * to whole pixels.
 */
export const PRESET_MATCH_TOLERANCE = 0.001;

/** The preset whose ratio this size has, or null for a custom ratio. */
export function activePreset(
  width: number,
  height: number,
): RatioPreset | null {
  const ratio = width / height;
  return (
    RATIO_PRESETS.find(
      (p) => Math.abs(ratio / (p.w / p.h) - 1) <= PRESET_MATCH_TOLERANCE,
    ) ?? null
  );
}

export type Side = 'width' | 'height';

export type SizeResult =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly message: string };

const RANGE = `1 to ${String(MAX_CANVAS_SIDE)}`;

const cap = (side: Side): string => (side === 'width' ? 'Width' : 'Height');

/**
 * Reads what was typed into a size field: a whole number of pixels from 1
 * to MAX_CANVAS_SIDE, nothing else (no decimals, units or separators).
 */
export function parseSide(
  text: string,
  side: Side,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      ok: false,
      message: `${cap(side)} is empty. Enter a whole number of pixels, ${RANGE}.`,
    };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `${cap(side)} must be a whole number of pixels, ${RANGE}, with no decimals, units or separators.`,
    };
  }
  const value = Number(trimmed);
  if (value < 1) {
    return { ok: false, message: `${cap(side)} must be at least 1 px.` };
  }
  if (value > MAX_CANVAS_SIDE) {
    return {
      ok: false,
      message: `${cap(side)} can be at most ${String(MAX_CANVAS_SIDE)} px.`,
    };
  }
  return { ok: true, value };
}

export interface ResizeRequest {
  /** The field that was edited. */
  readonly side: Side;
  /** What was typed into it. */
  readonly text: string;
  readonly current: { readonly width: number; readonly height: number };
  /** The aspect lock; when on, the other side follows to keep `ratio`. */
  readonly lock: boolean;
  /** The ratio (width / height) the lock keeps. */
  readonly ratio: number;
}

/**
 * The size to apply after an edit, or why it cannot be applied. With the
 * lock on, the other side is the edited one scaled by the locked ratio and
 * rounded to a whole pixel (so a very small side can drift from the ratio by
 * the rounding), and the edit is rejected if that side would leave the
 * range. With it off, the other side stays.
 */
export function resizeBySide(request: ResizeRequest): SizeResult {
  const { side, current, lock, ratio } = request;
  const parsed = parseSide(request.text, side);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!lock) {
    return side === 'width'
      ? { ok: true, width: value, height: current.height }
      : { ok: true, width: current.width, height: value };
  }
  const other: Side = side === 'width' ? 'height' : 'width';
  const followed = Math.round(side === 'width' ? value / ratio : value * ratio);
  if (followed < 1 || followed > MAX_CANVAS_SIDE) {
    return {
      ok: false,
      message:
        `${cap(side)} ${String(value)} px would make the ${other} ${String(followed)} px, ` +
        `outside ${RANGE}. Choose another size or turn the ratio lock off.`,
    };
  }
  return side === 'width'
    ? { ok: true, width: value, height: followed }
    : { ok: true, width: followed, height: value };
}

/** One step of the border slider: 0.1% of the canvas's shorter side. */
export const BORDER_STEP = 0.001;

/** What the border control shows for a state. */
export interface BorderRange {
  /** The slider's largest value (a fraction of the shorter side). */
  readonly max: number;
  /** The slider's value: what was asked for, up to `max`. */
  readonly value: number;
  /** What the user asked for (a fraction of the shorter side). */
  readonly requested: number;
  /** What is drawn (a fraction), at most `requested`. */
  readonly drawn: number;
  readonly requestedPx: number;
  readonly drawnPx: number;
  /** True when less is drawn than was asked for. */
  readonly limited: boolean;
}

/** Rounds down to a whole number of slider steps. */
const floorToStep = (fraction: number): number =>
  Math.floor(fraction / BORDER_STEP + 1e-9) * BORDER_STEP;

/**
 * The border slider's range and what to show beside it. Its maximum is the
 * most the current arrangement allows (borderAt's `max`, which keeps tiles
 * reasonably shaped), at most MAX_BORDER_FRACTION, in whole slider steps. A
 * re-roll or a new size can lower it below the stored request; the request
 * is kept, the slider shows it clamped, and `limited` says less is drawn.
 */
export function borderRange(state: EditorState): BorderRange {
  const { width, height, borderFraction } = state.canvas;
  const short = Math.min(width, height);
  const at = borderAt(state);
  const max = floorToStep(Math.min(MAX_BORDER_FRACTION, at.max / short));
  return {
    max,
    value: Math.min(borderFraction, max),
    requested: borderFraction,
    drawn: at.effective / short,
    requestedPx: at.requested,
    drawnPx: at.effective,
    limited: at.effective < Math.round(at.requested),
  };
}
