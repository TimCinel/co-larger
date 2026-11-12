/**
 * With nothing featured, arrangements are bit for bit what they were before
 * featuring existed (#14). Two ways:
 *
 * 1. Always: every state is compared with the arrangement computed, in the
 *    same run, by a copy of master's code path (26434f1, before #14:
 *    `arrange` and `canonicalAssignment` in state.ts), so the comparison is
 *    exact on any JavaScript engine.
 * 2. When the engine matches the one that recorded it: digests of whole
 *    snapshots recorded by running this file on master itself. Plans depend
 *    on floating-point results that can differ in the last bit between V8
 *    versions (see src/layout/index.ts), so the recording is only comparable
 *    on the V8 version it names. Re-record on master with:
 *
 *   RECORD_MASTER=$PWD/tests/fixtures/master-arrangements.json npx vitest run src/editor/featured.master.test.ts
 *   npx prettier --write tests/fixtures/master-arrangements.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  arrangementStep,
  assignPhotos,
  placeLayout,
  planLayout,
  type PhotoShape,
} from '../layout';
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

/** Master's arrange (26434f1), copied: the plan and the assignment. */
function masterArrange(state: EditorState): {
  plan: unknown;
  assignment: string[];
} {
  const { width, height } = state.canvas;
  const photos: readonly PhotoShape[] = state.photos;
  const v = Math.min(1, Math.max(0, state.variation));
  const plan = planLayout({
    width,
    height,
    count: photos.length,
    variation: v,
    seed: state.seed,
  });
  if (photos.length === 0) return { plan, assignment: [] };
  const stepPlan = planLayout({
    width,
    height,
    count: photos.length,
    variation: arrangementStep(v),
    seed: state.seed,
  });
  const slots = placeLayout(stepPlan, { width, height });
  return {
    plan,
    assignment: assignPhotos(slots, photos, { seed: state.seed }),
  };
}

/** Every case: its key and the state the current code makes for it. */
function cases(): [string, EditorState][] {
  clearArrangementCache();
  const out: [string, EditorState][] = [];
  for (const [width, height] of SIZES) {
    for (const count of COUNTS) {
      const photos = photosOf(count);
      for (const variation of DIALS) {
        for (const seed of SEEDS) {
          out.push([
            `${String(width)}x${String(height)}/${String(count)}/${String(variation)}/${String(seed)}`,
            createEditorState({
              seed,
              variation,
              canvas: { width, height },
              photos,
            }),
          ]);
        }
      }
      // The re-roll paths: Shuffle, the dial, the ratio, include/exclude.
      const key = `${String(width)}x${String(height)}/${String(count)}/actions`;
      let state = createEditorState({
        seed: 5,
        canvas: { width, height },
        photos,
      });
      state = shuffle(state, 6);
      out.push([`${key}/0`, state]);
      state = setVariation(state, 0.9);
      out.push([`${key}/1`, state]);
      state = setCanvasSize(state, height, width);
      out.push([`${key}/2`, state]);
      state = setPhotos(state, photos.slice(1));
      out.push([`${key}/3`, state]);
      state = setPhotos(state, photos);
      out.push([`${key}/4`, state]);
    }
  }
  return out;
}

interface Recording {
  /** The V8 version that recorded the digests. */
  readonly v8: string;
  readonly digests: Record<string, string>;
}

describe('nothing featured: the same arrangements as before #14', () => {
  const all = cases();

  it('equals master’s code path, computed in this run, for every case', () => {
    expect(all).toHaveLength(
      SIZES.length * COUNTS.length * (DIALS.length * SEEDS.length + 5),
    );
    for (const [key, state] of all) {
      expect('featured' in state, key).toBe(false);
      const master = masterArrange(state);
      expect(state.plan, key).toEqual(master.plan);
      expect(state.assignment, key).toEqual(master.assignment);
    }
  });

  it('matches the digests recorded on master, on the engine that recorded them', () => {
    const digests = Object.fromEntries(
      all.map(([key, state]) => [key, digest(state)]),
    );
    const record = process.env.RECORD_MASTER;
    if (record) {
      const recording: Recording = { v8: process.versions.v8, digests };
      writeFileSync(record, `${JSON.stringify(recording, null, 1)}\n`);
      return;
    }
    expect(existsSync(FIXTURE)).toBe(true);
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
    expect(Object.keys(recorded.digests)).toEqual(Object.keys(digests));
    // Another engine may round differently: test 1 covers it there.
    if (recorded.v8 !== process.versions.v8) return;
    expect(digests).toEqual(recorded.digests);
  });
});
