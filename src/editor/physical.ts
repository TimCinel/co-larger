/**
 * Physical canvas sizes (#7): millimetres, DPI and the pixels they give.
 * Pure arithmetic and checks, no DOM and no state, so state.ts, the settings
 * controls and the tests all share one definition of "how many pixels is
 * this paper at this DPI".
 *
 * The canvas's pixel width and height stay the single source of truth for
 * layout and rendering. A {@link PhysicalSize} only records how the user
 * specified them: it is optional, and when present it is always consistent
 * with the pixels (see {@link isConsistent}).
 */

/** Millimetres in an inch. */
export const MM_PER_INCH = 25.4;

/** A new physical canvas is 300 DPI: print quality. */
export const DEFAULT_DPI = 300;

/** DPI is a whole number from 1 to 2400. */
export const MIN_DPI = 1;
export const MAX_DPI = 2400;

/** Millimetres: from 0.001 (a pixel at the highest DPI) to ten metres. */
export const MIN_MM = 0.001;
export const MAX_MM = 10000;

/** Typed and derived millimetres have at most this many decimals. */
export const MM_DECIMALS = 3;

/**
 * How a canvas was specified in physical units. All fields are finite and
 * in range (see {@link checkPhysical}), and `Math.round(widthMm * dpi /
 * 25.4)` is the canvas's pixel width, likewise for the height.
 */
export interface PhysicalSize {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly dpi: number;
}

/** Whole pixels for a length in millimetres at a DPI (nearest, halves up). */
export function pixelsFromMm(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / MM_PER_INCH);
}

/**
 * Millimetres for a pixel length at a DPI, rounded to MM_DECIMALS. Rounding
 * to 3 decimals moves the pixel count by well under half a pixel at any
 * DPI up to MAX_DPI, so {@link pixelsFromMm} returns the pixels it came
 * from: converting a canvas to millimetres never changes its size.
 */
export function mmFromPixels(pixels: number, dpi: number): number {
  return roundMm((pixels * MM_PER_INCH) / dpi);
}

/** Rounds a length to MM_DECIMALS (no floating-point tails). */
export function roundMm(mm: number): number {
  const scale = 10 ** MM_DECIMALS;
  return Math.round(mm * scale) / scale;
}

/**
 * The physical description of a pixel canvas at `dpi`, or null when the
 * millimetres would be out of range.
 */
export function physicalFor(
  width: number,
  height: number,
  dpi: number,
): PhysicalSize | null {
  const widthMm = mmFromPixels(width, dpi);
  const heightMm = mmFromPixels(height, dpi);
  const ok = (mm: number): boolean => mm >= MIN_MM && mm <= MAX_MM;
  return ok(widthMm) && ok(heightMm) ? { widthMm, heightMm, dpi } : null;
}

/** The pixel size a physical size gives (not range-checked). */
export function pixelSizeOf(physical: PhysicalSize): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: pixelsFromMm(physical.widthMm, physical.dpi),
    height: pixelsFromMm(physical.heightMm, physical.dpi),
  };
}

/**
 * True when `pixels` is exactly what `mm` at `dpi` converts to (see
 * {@link pixelsFromMm}), so a stored description can never claim a size
 * that does not produce its pixels, even at a half-pixel boundary.
 */
export function isConsistent(pixels: number, mm: number, dpi: number): boolean {
  return pixels === pixelsFromMm(mm, dpi);
}

/**
 * Checks a physical description against the canvas's pixels and returns a
 * clean copy (only the known fields). Throws a RangeError unless the
 * millimetres are finite numbers from MIN_MM to MAX_MM, the DPI is a whole
 * number from MIN_DPI to MAX_DPI, and the pixels are what they give.
 */
export function checkPhysical(
  value: unknown,
  width: number,
  height: number,
): PhysicalSize {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RangeError('physical size must be an object');
  }
  const { widthMm, heightMm, dpi } = value as Record<string, unknown>;
  for (const [name, mm] of [
    ['width', widthMm],
    ['height', heightMm],
  ] as const) {
    if (
      typeof mm !== 'number' ||
      !Number.isFinite(mm) ||
      mm < MIN_MM ||
      mm > MAX_MM
    ) {
      throw new RangeError(
        `physical ${name} must be a number of millimetres from ${String(MIN_MM)} to ${String(MAX_MM)}`,
      );
    }
  }
  if (
    typeof dpi !== 'number' ||
    !Number.isInteger(dpi) ||
    dpi < MIN_DPI ||
    dpi > MAX_DPI
  ) {
    throw new RangeError(
      `DPI must be a whole number from ${String(MIN_DPI)} to ${String(MAX_DPI)}`,
    );
  }
  const w = widthMm as number;
  const h = heightMm as number;
  if (!isConsistent(width, w, dpi) || !isConsistent(height, h, dpi)) {
    throw new RangeError(
      'physical size does not match the canvas size in pixels',
    );
  }
  return { widthMm: w, heightMm: h, dpi };
}

/** True when two descriptions (or two absences) are the same. */
export function samePhysical(
  a: PhysicalSize | undefined,
  b: PhysicalSize | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.widthMm === b.widthMm && a.heightMm === b.heightMm && a.dpi === b.dpi
  );
}

/** "297" or "148.5" or "162.56": no trailing zeros. */
export function formatMm(mm: number): string {
  return String(roundMm(mm));
}
