import { describe, expect, it } from 'vitest';
import type { Tile } from '../layout';
import { coverSource } from './crop';
import {
  drawTile,
  ERROR_COLOUR,
  fitSize,
  PLACEHOLDER_COLOUR,
  renderCollage,
  renderCollageAsync,
  tileAt,
  tilesFor,
  type CollageContext,
  type DrawableImage,
} from './render';
import {
  createEditorState,
  setBackground,
  setBorder,
  setCrop,
  type EditorState,
} from './state';

type Call =
  | { op: 'fillRect'; fill: string; args: number[] }
  | { op: 'drawImage'; image: unknown; args: number[] }
  | { op: 'stroke'; stroke: string };

/** A 2D context that records what is drawn. */
function recorder(): CollageContext & { calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low' as ImageSmoothingQuality,
    fillRect(...args: number[]) {
      calls.push({ op: 'fillRect', fill: ctx.fillStyle, args });
    },
    drawImage(image: unknown, ...args: number[]) {
      calls.push({ op: 'drawImage', image, args });
    },
    beginPath() {
      // Paths are recorded only when stroked.
    },
    moveTo() {
      // As above.
    },
    lineTo() {
      // As above.
    },
    stroke() {
      calls.push({ op: 'stroke', stroke: ctx.strokeStyle });
    },
  };
  return ctx;
}

const photos = [
  { id: 'wide', aspect: 2 },
  { id: 'tall', aspect: 0.5 },
  { id: 'square', aspect: 1 },
  { id: 'land', aspect: 4 / 3 },
  { id: 'port', aspect: 3 / 4 },
];

/** A fake image of each photo at `longSide` pixels. */
function images(longSide: number): Map<string, DrawableImage> {
  return new Map(
    photos.map((p) => {
      const width = p.aspect >= 1 ? longSide : longSide * p.aspect;
      const height = p.aspect >= 1 ? longSide / p.aspect : longSide;
      return [p.id, { image: { name: p.id } as never, width, height }];
    }),
  );
}

function area(tiles: readonly Tile[]): number {
  return tiles.reduce((sum, t) => sum + t.width * t.height, 0);
}

describe('renderCollage', () => {
  const state = createEditorState({ seed: 4, photos, variation: 0.6 });

  it('fills the background, then draws each photo covering its tile', () => {
    const ctx = recorder();
    const imgs = images(1024);
    const result = renderCollage(
      ctx,
      state,
      { width: 960, height: 540 },
      (id) => imgs.get(id) ?? null,
    );
    expect(ctx.calls[0]).toEqual({
      op: 'fillRect',
      fill: '#ffffff',
      args: [0, 0, 960, 540],
    });
    const draws = ctx.calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(5);
    expect(result.missing).toBe(0);
    // With no border the tiles cover the canvas exactly, in whole pixels.
    expect(area(result.tiles)).toBe(960 * 540);
    for (const tile of result.tiles) {
      const id = state.assignment[tile.slot] as string;
      const img = imgs.get(id) as DrawableImage;
      const source = coverSource(
        img.width,
        img.height,
        tile.width,
        tile.height,
      );
      const draw = draws.find((d) => (d.image as { name: string }).name === id);
      expect(draw?.args).toEqual([
        source?.sx,
        source?.sy,
        source?.sw,
        source?.sh,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
      ]);
      expect(Number.isInteger(tile.x) && Number.isInteger(tile.width)).toBe(
        true,
      );
    }
  });

  it('applies each photo’s crop', () => {
    const cropped = setCrop(state, 'wide', { x: 0, y: 0, zoom: 2 });
    const ctx = recorder();
    const imgs = images(1000);
    const result = renderCollage(
      ctx,
      cropped,
      { width: 800, height: 450 },
      (id) => imgs.get(id) ?? null,
    );
    const tile = result.tiles.find(
      (t) => cropped.assignment[t.slot] === 'wide',
    ) as Tile;
    const draw = ctx.calls.find(
      (c) =>
        c.op === 'drawImage' && (c.image as { name: string }).name === 'wide',
    );
    const expected = coverSource(1000, 500, tile.width, tile.height, {
      x: 0,
      y: 0,
      zoom: 2,
    });
    expect(draw && 'args' in draw ? draw.args.slice(0, 4) : null).toEqual([
      expected?.sx,
      expected?.sy,
      expected?.sw,
      expected?.sh,
    ]);
    expect(expected?.sx).toBe(0);
  });

  it('draws a placeholder for images that are not ready', () => {
    const ctx = recorder();
    const result = renderCollage(
      ctx,
      state,
      { width: 400, height: 225 },
      (id) => (id === 'tall' ? null : (images(64).get(id) ?? null)),
    );
    expect(result.missing).toBe(1);
    const placeholders = ctx.calls.filter(
      (c) => c.op === 'fillRect' && c.fill === PLACEHOLDER_COLOUR,
    );
    expect(placeholders).toHaveLength(1);
  });

  it('asks for each image with the tile it will fill', () => {
    const asked: [string, Tile][] = [];
    const result = renderCollage(
      recorder(),
      state,
      { width: 300, height: 169 },
      (id, tile) => {
        asked.push([id, tile]);
        return null;
      },
    );
    expect(asked.map(([, t]) => t)).toEqual(result.tiles);
  });

  it('uses the background colour and scales the border with the output', () => {
    const styled = setBorder(setBackground(state, '#102030'), 40);
    const ctx = recorder();
    const full = renderCollage(
      ctx,
      styled,
      { width: 1920, height: 1080 },
      () => null,
    );
    expect(ctx.calls[0]).toMatchObject({ fill: '#102030' });
    const half = tilesFor(styled, { width: 960, height: 540 });
    // The outer margin is the border, scaled: 40 at full size, 20 at half.
    expect(Math.min(...full.tiles.map((t) => t.x))).toBe(40);
    expect(Math.min(...half.map((t) => t.x))).toBe(20);
    expect(area(half)).toBeLessThan(960 * 540);
  });

  it('matches between preview and export sizes (export is the same picture)', () => {
    const preview = tilesFor(state, { width: 480, height: 270 });
    const exported = tilesFor(state, { width: 4800, height: 2700 });
    for (const [i, tile] of preview.entries()) {
      const big = exported[i] as Tile;
      expect(Math.abs(big.x / 10 - tile.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(big.width / 10 - tile.width)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps a border too large for the output instead of throwing', () => {
    const huge = setBorder(state, 5000);
    expect(() =>
      renderCollage(recorder(), huge, { width: 200, height: 113 }, () => null),
    ).not.toThrow();
  });

  it('draws only the background for an empty collage or a tiny size', () => {
    const empty = createEditorState({ seed: 1 });
    const ctx = recorder();
    expect(
      renderCollage(ctx, empty, { width: 100, height: 50 }, () => null).tiles,
    ).toEqual([]);
    expect(ctx.calls).toHaveLength(1);
    expect(tilesFor(state, { width: 3, height: 1 })).toEqual([]);
  });

  it('one photo fills the whole canvas', () => {
    const one: EditorState = createEditorState({
      seed: 1,
      photos: [{ id: 'only', aspect: 0.75 }],
    });
    const tiles = tilesFor(one, { width: 640, height: 360 });
    expect(tiles).toEqual([{ slot: 0, x: 0, y: 0, width: 640, height: 360 }]);
  });
});

describe('renderCollageAsync (export path)', () => {
  const state = setCrop(
    createEditorState({ seed: 4, photos, variation: 0.9 }),
    'tall',
    { x: 0.2, y: 0.8, zoom: 1.6 },
  );
  const imgs = images(800);

  it('issues exactly the same draw calls as renderCollage', async () => {
    const sync = recorder();
    const syncResult = renderCollage(
      sync,
      state,
      { width: 1200, height: 675 },
      (id) => imgs.get(id) ?? null,
    );
    const async = recorder();
    const asyncResult = await renderCollageAsync(
      async,
      state,
      { width: 1200, height: 675 },
      async (id) => {
        await new Promise((r) => setTimeout(r, 0));
        return imgs.get(id) ?? null;
      },
    );
    expect(async.calls).toEqual(sync.calls);
    expect(asyncResult).toEqual(syncResult);
  });

  it('obtains one image at a time and releases each after drawing it', async () => {
    let held = 0;
    let maxHeld = 0;
    const released: string[] = [];
    const ctx = recorder();
    await renderCollageAsync(
      ctx,
      state,
      { width: 600, height: 338 },
      async (id) => {
        held++;
        maxHeld = Math.max(maxHeld, held);
        await Promise.resolve();
        const img = imgs.get(id);
        return img
          ? {
              ...img,
              release: () => {
                held--;
                released.push(id);
              },
            }
          : null;
      },
    );
    expect(maxHeld).toBe(1);
    expect(released.sort()).toEqual(photos.map((p) => p.id).sort());
  });
});

describe('drawTile', () => {
  const state = createEditorState({ seed: 4, photos });
  const tile: Tile = { slot: 0, x: 10, y: 20, width: 100, height: 80 };

  it('draws a loading placeholder for null', () => {
    const ctx = recorder();
    expect(drawTile(ctx, state, tile, null)).toBe(false);
    expect(ctx.calls).toEqual([
      { op: 'fillRect', fill: PLACEHOLDER_COLOUR, args: [10, 20, 100, 80] },
    ]);
  });

  it('draws a visibly different error placeholder, with a cross, for failed', () => {
    const ctx = recorder();
    expect(drawTile(ctx, state, tile, 'failed')).toBe(false);
    expect(ctx.calls[0]).toEqual({
      op: 'fillRect',
      fill: ERROR_COLOUR,
      args: [10, 20, 100, 80],
    });
    expect(ctx.calls.some((c) => c.op === 'stroke')).toBe(true);
  });

  it('counts failed tiles as missing in renderCollage', () => {
    const result = renderCollage(
      recorder(),
      state,
      { width: 400, height: 225 },
      () => 'failed',
    );
    expect(result.missing).toBe(photos.length);
  });
});

describe('tileAt', () => {
  const tiles: Tile[] = [
    { slot: 0, x: 0, y: 0, width: 10, height: 10 },
    { slot: 1, x: 12, y: 0, width: 10, height: 10 },
  ];

  it('finds the tile under a point', () => {
    expect(tileAt(tiles, 5, 5)?.slot).toBe(0);
    expect(tileAt(tiles, 12, 9.9)?.slot).toBe(1);
  });

  it('returns null in gaps and outside', () => {
    expect(tileAt(tiles, 11, 5)).toBeNull();
    expect(tileAt(tiles, 10, 5)).toBeNull();
    expect(tileAt(tiles, -1, 5)).toBeNull();
    expect(tileAt(tiles, 5, 10)).toBeNull();
  });
});

describe('fitSize', () => {
  it('fits the canvas ratio inside the space', () => {
    expect(fitSize(1920, 1080, 1000, 1000)).toEqual({
      width: 1000,
      height: 562,
    });
    expect(fitSize(1080, 1920, 1000, 1000)).toEqual({
      width: 562,
      height: 1000,
    });
    expect(fitSize(100, 100, 0, 50)).toEqual({ width: 1, height: 1 });
  });
});
