import { describe, expect, it } from 'vitest';
import type { PhotoShape } from '../layout';
import {
  createEditorState,
  forgetPhotos,
  MAX_BORDER_FRACTION,
  rearrange,
  setBackground,
  setBorder,
  setCanvasSize,
  setCrop,
  setPhotos,
  setVariation,
  shuffle,
  validateEditorState,
  type EditorState,
} from './state';

/** A small seeded generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASPECTS = [4 / 3, 3 / 4, 1, 16 / 9, 9 / 16, 3 / 2, 1 / 50, 50, 2.39];
const POOL: PhotoShape[] = Array.from({ length: 60 }, (_, i) => ({
  id: `p${String(i)}`,
  aspect: ASPECTS[i % ASPECTS.length] as number,
}));

/** Validates `state` the way a saved project is loaded. */
function expectValid(state: EditorState, context: string): void {
  const text = JSON.stringify(state);
  let loaded: EditorState;
  try {
    loaded = validateEditorState(JSON.parse(text), {
      photoIds: POOL.map((p) => p.id),
    });
  } catch (error) {
    throw new Error(`${context}: ${String(error)}`, { cause: error });
  }
  expect(JSON.stringify(loaded), context).toBe(text);
}

describe('every state the actions produce validates', () => {
  it('for random sequences of actions, including tiny canvases', () => {
    for (let run = 0; run < 40; run++) {
      const rnd = random(run + 1);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(rnd() * items.length)] as T;
      const side = (): number =>
        pick([1, 2, 3, 7, 40, 50, 333, 1080, 1920, 7016, 20000]);
      const subset = (): PhotoShape[] =>
        POOL.filter(() => rnd() < pick([0.05, 0.3, 0.8, 1]));
      let state = createEditorState({
        seed: run,
        photos: subset(),
        variation: rnd(),
        canvas: { width: side(), height: side() },
      });
      const log: string[] = [];
      for (let step = 0; step < 25; step++) {
        const action = pick([
          'shuffle',
          'variation',
          'drag',
          'photos',
          'size',
          'sameRatio',
          'border',
          'background',
          'crop',
          'forget',
        ]);
        log.push(action);
        switch (action) {
          case 'shuffle':
            state = shuffle(state, Math.floor(rnd() * 2 ** 32));
            break;
          case 'variation':
            state = setVariation(state, pick([0, 1, rnd()]));
            break;
          case 'drag':
            state = setVariation(state, rnd(), { keepAssignment: true });
            expectValid(state, `run ${String(run)} provisional`);
            state = rearrange(state);
            break;
          case 'photos':
            state = setPhotos(state, subset());
            break;
          case 'size':
            state = setCanvasSize(state, side(), side());
            break;
          case 'sameRatio': {
            const k = pick([0.3, 0.5, 2, 3]);
            state = setCanvasSize(
              state,
              Math.min(20000, Math.max(1, Math.round(state.canvas.width * k))),
              Math.min(20000, Math.max(1, Math.round(state.canvas.height * k))),
            );
            break;
          }
          case 'border':
            state = setBorder(state, rnd() * MAX_BORDER_FRACTION);
            break;
          case 'background':
            state = setBackground(state, pick(['#000000', '#ABCDEF']));
            break;
          case 'crop':
            state = setCrop(state, pick(POOL).id, {
              x: rnd(),
              y: rnd(),
              zoom: 1 + rnd() * 9,
            });
            break;
          case 'forget':
            // Forgetting removes crops; keep the pool so ids stay known.
            state = forgetPhotos(state, [pick(POOL).id]);
            break;
        }
        expectValid(state, `run ${String(run)} after ${log.join(' ')}`);
      }
    }
  });

  it('for the tiny canvases the review found', () => {
    const fifty = createEditorState({ seed: 1, photos: POOL.slice(0, 50) });
    expectValid(setCanvasSize(fifty, 3, 2), '50 photos at 3 × 2');
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `m${String(i)}`,
      aspect: ASPECTS[i % 6] as number,
    }));
    for (let seed = 0; seed < 4; seed++) {
      const state = createEditorState({
        seed,
        photos: many,
        variation: 1,
        canvas: { width: 50, height: 40 },
      });
      const loaded = validateEditorState(JSON.parse(JSON.stringify(state)));
      expect(loaded.plan).toEqual(state.plan);
    }
  });
});
