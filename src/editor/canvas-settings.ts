/**
 * The pure logic behind the canvas settings controls: ratio presets and the
 * pixel size each gives, parsing and validating typed sizes, the aspect
 * lock's arithmetic, and the border slider's range. No DOM, so it is tested
 * in Node.
 */
import {
  formatMm,
  MAX_DPI,
  MAX_MM,
  MIN_DPI,
  MIN_MM,
  MM_DECIMALS,
  pixelsFromMm,
  roundMm,
  type PhysicalSize,
} from './physical';
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

/** The longer side of a new canvas, and of the presets from it: 1920 px. */
export const DEFAULT_LONG_SIDE = 1920;

/**
 * The pixel size choosing `preset` gives: the preset's ratio with the
 * canvas's current longer side (`longSide`), so a ratio click never silently
 * changes the resolution. From the default 1920 × 1080, 16:9 is 1920 × 1080,
 * 9:16 is 1080 × 1920, 1:1 is 1920 × 1920, 4:5 is 1536 × 1920 and 5:7 is
 * 1371 × 1920 (rounded to a whole pixel); from 3840 × 2160, 1:1 is 3840 × 3840,
 * and clicking the preset already active changes nothing. (A paper size at
 * 300 DPI, #7, keeps its resolution the same way.)
 */
export function presetSize(
  p: RatioPreset,
  longSide: number = DEFAULT_LONG_SIDE,
): { readonly width: number; readonly height: number } {
  const long = Math.min(MAX_CANVAS_SIDE, Math.max(1, Math.round(longSide)));
  const short = Math.max(
    1,
    Math.round((long * Math.min(p.w, p.h)) / Math.max(p.w, p.h)),
  );
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

/**
 * The ratio (width / height) the aspect lock keeps for a canvas of this
 * size: the active preset's exact ratio when there is one (so 5:7 stays
 * exactly 5:7 and height 7000 gives width 5000, not 4998), otherwise the
 * size's own ratio.
 */
export function lockRatioFor(width: number, height: number): number {
  const p = activePreset(width, height);
  return p ? p.w / p.h : width / height;
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
  // Re-entering the side's current value changes nothing (rather than
  // re-deriving the other side from a rounded ratio).
  if (value === current[side]) {
    return { ok: true, width: current.width, height: current.height };
  }
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

/**
 * The slider's fixed scale: 0 to 10% of the shorter side. Fixed, so a thumb
 * position always means the same border and a re-roll never moves it. (The
 * state accepts up to MAX_BORDER_FRACTION, 25%, but no arrangement of more
 * than a few photos can draw that much; 10% is more than most can.)
 */
export const BORDER_SLIDER_MAX = 0.1;

/** What the border control shows for a state. */
export interface BorderRange {
  /** The slider's scale: always BORDER_SLIDER_MAX. */
  readonly scale: number;
  /** The slider's value: what was asked for, up to `scale`. */
  readonly value: number;
  /** What the user asked for (a fraction of the shorter side). */
  readonly requested: number;
  /** What is drawn (a fraction), at most `requested`. */
  readonly drawn: number;
  /** Whole pixels at the canvas's size: the label and the note use these. */
  readonly requestedPx: number;
  readonly drawnPx: number;
  /**
   * The most the current arrangement can draw, as a fraction of the shorter
   * side; the part of the track beyond it is shaded as unavailable.
   */
  readonly available: number;
  /** True when less is drawn than was asked for. */
  readonly limited: boolean;
}

/**
 * The border slider's numbers for a state. The scale is fixed; `available`
 * (borderAt's `max`, which keeps tiles reasonably shaped) changes with the
 * arrangement. A re-roll or new size can lower it below the stored request:
 * the request is kept and the thumb stays, and `limited` says less is drawn.
 */
export function borderRange(state: EditorState): BorderRange {
  const { width, height, borderFraction } = state.canvas;
  const short = Math.min(width, height);
  const at = borderAt(state);
  const requestedPx = Math.round(at.requested);
  return {
    scale: BORDER_SLIDER_MAX,
    value: Math.min(borderFraction, BORDER_SLIDER_MAX),
    requested: borderFraction,
    drawn: at.effective / short,
    requestedPx,
    drawnPx: at.effective,
    available: Math.min(MAX_BORDER_FRACTION, at.max / short),
    limited: at.effective < requestedPx,
  };
}

// --- Physical sizes (#7) -----------------------------------------------------

/** A paper size, in millimetres, in one orientation. */
export interface PaperPreset {
  /** "A4". */
  readonly name: string;
  readonly orientation: 'portrait' | 'landscape';
  readonly widthMm: number;
  readonly heightMm: number;
}

const ISO_A: readonly (readonly [string, number, number])[] = [
  ['A4', 210, 297],
  ['A3', 297, 420],
  ['A2', 420, 594],
];

/** A4, A3 and A2, each portrait then landscape (ISO 216). */
export const PAPER_PRESETS: readonly PaperPreset[] = ISO_A.flatMap(
  ([name, short, long]) => [
    { name, orientation: 'portrait', widthMm: short, heightMm: long },
    { name, orientation: 'landscape', widthMm: long, heightMm: short },
  ],
);

/** "A4 portrait". */
export const paperLabel = (p: PaperPreset): string =>
  `${p.name} ${p.orientation}`;

/** The paper preset with exactly these millimetres, or null. */
export function activePaper(
  physical: PhysicalSize | undefined,
): PaperPreset | null {
  if (physical === undefined) return null;
  return (
    PAPER_PRESETS.find(
      (p) => p.widthMm === physical.widthMm && p.heightMm === physical.heightMm,
    ) ?? null
  );
}

/**
 * The physical size choosing a ratio preset gives: the preset's ratio with
 * the current longer side in millimetres, at the current DPI (so, like the
 * pixel version, a ratio click never changes the resolution). The shorter
 * side is rounded to MM_DECIMALS.
 */
export function presetPhysical(
  p: RatioPreset,
  current: PhysicalSize,
): PhysicalSize {
  const long = Math.max(current.widthMm, current.heightMm);
  const short = Math.max(
    MIN_MM,
    roundMm((long * Math.min(p.w, p.h)) / Math.max(p.w, p.h)),
  );
  return p.w >= p.h
    ? { widthMm: long, heightMm: short, dpi: current.dpi }
    : { widthMm: short, heightMm: long, dpi: current.dpi };
}

/**
 * The physical size choosing a ratio preset gives, checked to fit 1 to
 * MAX_CANVAS_SIDE px per side, or why it does not (for example 1:2 from a
 * 13 mm canvas at 1 DPI would have a side under 1 px).
 */
export function checkPresetPhysical(
  p: RatioPreset,
  current: PhysicalSize,
): PhysicalResult {
  return checkPhysicalFits(presetPhysical(p, current), 'widthMm');
}

export type MmSide = 'widthMm' | 'heightMm';

const mmName = (side: MmSide): string =>
  side === 'widthMm' ? 'Width' : 'Height';

const MM_RANGE = `${String(MIN_MM)} to ${String(MAX_MM)} mm`;
const DPI_RANGE = `${String(MIN_DPI)} to ${String(MAX_DPI)}`;

/**
 * Reads what was typed into a millimetre field: a positive number with a
 * decimal point or comma and at most MM_DECIMALS decimals, from MIN_MM to
 * MAX_MM. No units, signs, exponents or thousands separators.
 */
export function parseMm(
  text: string,
  side: MmSide,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  const name = mmName(side);
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      ok: false,
      message: `${name} is empty. Enter a length in millimetres, ${MM_RANGE}.`,
    };
  }
  if (!/^(?:\d+(?:[.,]\d{1,3})?|[.,]\d{1,3})$/.test(trimmed)) {
    return {
      ok: false,
      message: `${name} must be a plain number of millimetres, such as 297 or 148.5, with at most ${String(MM_DECIMALS)} decimals and no units or separators.`,
    };
  }
  const value = Number(trimmed.replace(',', '.'));
  if (value < MIN_MM) {
    return {
      ok: false,
      message: `${name} must be at least ${String(MIN_MM)} mm.`,
    };
  }
  if (value > MAX_MM) {
    return {
      ok: false,
      message: `${name} can be at most ${String(MAX_MM)} mm.`,
    };
  }
  return { ok: true, value };
}

/** Reads what was typed into the DPI field: a whole number, MIN_DPI to MAX_DPI. */
export function parseDpi(
  text: string,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      ok: false,
      message: `DPI is empty. Enter a whole number, ${DPI_RANGE}.`,
    };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `DPI must be a whole number, ${DPI_RANGE}, with no decimals, units or separators.`,
    };
  }
  const value = Number(trimmed);
  if (value < MIN_DPI) {
    return { ok: false, message: `DPI must be at least ${String(MIN_DPI)}.` };
  }
  if (value > MAX_DPI) {
    return { ok: false, message: `DPI can be at most ${String(MAX_DPI)}.` };
  }
  return { ok: true, value };
}

export type PhysicalResult =
  | { readonly ok: true; readonly physical: PhysicalSize }
  | { readonly ok: false; readonly message: string };

/**
 * Checks that a physical size gives pixel sides from 1 to MAX_CANVAS_SIDE,
 * or says which side does not and why. `edited` names the field to blame.
 */
export function checkPhysicalFits(
  physical: PhysicalSize,
  edited: MmSide | 'dpi',
): PhysicalResult {
  const { widthMm, heightMm, dpi } = physical;
  const sides = [
    ['Width', widthMm],
    ['Height', heightMm],
  ] as const;
  for (const [name, mm] of sides) {
    const px = pixelsFromMm(mm, dpi);
    if (px >= 1 && px <= MAX_CANVAS_SIDE) continue;
    const what = `${name} ${formatMm(mm)} mm at ${String(dpi)} DPI is ${String(px)} px`;
    const fix =
      px > MAX_CANVAS_SIDE
        ? `more than the ${String(MAX_CANVAS_SIDE)} px limit`
        : 'less than 1 px';
    const advice =
      edited === 'dpi'
        ? 'Choose another DPI.'
        : px > MAX_CANVAS_SIDE
          ? 'Choose a smaller size or a lower DPI, or turn the ratio lock off.'
          : 'Choose a larger size or a higher DPI.';
    return { ok: false, message: `${what}, ${fix}. ${advice}` };
  }
  return { ok: true, physical };
}

export interface MmResizeRequest {
  /** The field that was edited. */
  readonly side: MmSide;
  /** What was typed into it. */
  readonly text: string;
  readonly current: PhysicalSize;
  /** The aspect lock; when on, the other side follows to keep `ratio`. */
  readonly lock: boolean;
  /** The ratio (width / height) the lock keeps. */
  readonly ratio: number;
}

/**
 * The physical size to apply after editing a millimetre field, or why it
 * cannot be applied. With the lock on, the other side is the edited one
 * scaled by the locked ratio, rounded to MM_DECIMALS. The result must give
 * whole pixel sides from 1 to MAX_CANVAS_SIDE. Re-entering the current
 * value changes nothing.
 */
export function resizeByMm(request: MmResizeRequest): PhysicalResult {
  const { side, current, lock, ratio } = request;
  const parsed = parseMm(request.text, side);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value === current[side]) return { ok: true, physical: current };
  let next: PhysicalSize;
  if (!lock) {
    next = { ...current, [side]: value };
  } else {
    const followed = roundMm(
      side === 'widthMm' ? value / ratio : value * ratio,
    );
    if (followed < MIN_MM || followed > MAX_MM) {
      const other = side === 'widthMm' ? 'height' : 'width';
      return {
        ok: false,
        message:
          `${mmName(side)} ${formatMm(value)} mm would make the ${other} ${formatMm(followed)} mm, ` +
          `outside ${MM_RANGE}. Choose another size or turn the ratio lock off.`,
      };
    }
    next =
      side === 'widthMm'
        ? { ...current, widthMm: value, heightMm: followed }
        : { ...current, widthMm: followed, heightMm: value };
  }
  return checkPhysicalFits(next, side);
}

/**
 * The physical size to apply after editing the DPI field (the millimetres
 * stay, the pixels change), or why it cannot be applied. Re-entering the
 * current DPI changes nothing.
 */
export function resizeByDpi(
  text: string,
  current: PhysicalSize,
): PhysicalResult {
  const parsed = parseDpi(text);
  if (!parsed.ok) return parsed;
  if (parsed.value === current.dpi) return { ok: true, physical: current };
  return checkPhysicalFits({ ...current, dpi: parsed.value }, 'dpi');
}
