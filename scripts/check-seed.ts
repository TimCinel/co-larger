/**
 * The seed a browser check fixes its arrangement with (#54): `fallback`, or
 * `BROWSER_CHECK_SEED` to try another seed everywhere a check uses this.
 * Shared by browser-check.ts and the check modules it calls.
 */
export function checkSeed(fallback: number): number {
  const fromEnv = process.env.BROWSER_CHECK_SEED;
  return fromEnv === undefined ? fallback : Number(fromEnv);
}
