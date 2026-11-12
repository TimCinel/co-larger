/**
 * With nothing featured, arrangements are bit for bit what they were before
 * featuring existed (#14). The fixture was recorded by running this same file
 * on `master` at 26434f1 (before #14) with RECORD_MASTER set to the fixture's
 * path; on this branch it compares. It uses only actions that existed then.
 *
 *   RECORD_MASTER=$PWD/tests/fixtures/master-arrangements.json npx vitest run src/editor/featured.master.test.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  clearArrangementCache,
  createEditorState,
  setCanvasSize,
  setPhotos,
  setVariation,
  shuffle,
  type EditorState,
} from './state';

const FIXTURE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  'tests',
  'fixtures',
  'master-arrangements.json',
);

const ASPECTS = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 1, 16 / 9, 9 / 16, 1.25, 0.8];
const photosOf = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `photo-${String(i + 1)}`,
    aspect: ASPECTS[(i * 7) % ASPECTS.length] as number,
  }));

const SIZES = [
  [1920, 1080],
  [1080, 1920],
  [1000, 1000],
  [2480, 3508],
  [4961, 3508],
] as const;
const COUNTS = [1, 2, 7, 30, 61];
const DIALS = [0, 0.13, 0.5, 0.77, 1];
const SEEDS = [1, 7, 42, 1234, 99991];

/** A short digest of the whole snapshot: canvas, plan, assignment, crops. */
const digest = (state: EditorState): string =>
  createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);

function arrangements(): Record<string, string> {
  clearArrangementCache();
  const out: Record<string, string> = {};
  for (const [width, height] of SIZES) {
    for (const count of COUNTS) {
      const photos = photosOf(count);
      for (const variation of DIALS) {
        for (const seed of SEEDS) {
          const state = createEditorState({
            seed,
            variation,
            canvas: { width, height },
            photos,
          });
          out[
            `${String(width)}x${String(height)}/${String(count)}/${String(variation)}/${String(seed)}`
          ] = digest(state);
        }
      }
      // The re-roll paths: Shuffle, the dial, the ratio, include/exclude.
      let state = createEditorState({
        seed: 5,
        canvas: { width, height },
        photos,
      });
      const steps: string[] = [];
      state = shuffle(state, 6);
      steps.push(digest(state));
      state = setVariation(state, 0.9);
      steps.push(digest(state));
      state = setCanvasSize(state, height, width);
      steps.push(digest(state));
      state = setPhotos(state, photos.slice(1));
      steps.push(digest(state));
      state = setPhotos(state, photos);
      steps.push(digest(state));
      out[`${String(width)}x${String(height)}/${String(count)}/actions`] =
        steps.join(',');
    }
  }
  return out;
}

describe('nothing featured: the same arrangements as before #14', () => {
  it('matches every arrangement recorded on master', () => {
    const record = process.env.RECORD_MASTER;
    const now = arrangements();
    if (record) {
      writeFileSync(record, `${JSON.stringify(now, null, 1)}\n`);
      return;
    }
    expect(existsSync(FIXTURE)).toBe(true);
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<
      string,
      string
    >;
    expect(Object.keys(now).length).toBe(SIZES.length * COUNTS.length * 26);
    expect(now).toEqual(recorded);
  });
});
