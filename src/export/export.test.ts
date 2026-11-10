import { describe, expect, it, vi } from 'vitest';
import { coverSource } from '../editor/crop';
import {
  cropOf,
  createEditorState,
  renderCollage,
  setBackground,
  setBorder,
  setCrop,
  tilesFor,
  type CollageContext,
  type DrawableImage,
} from '../editor';
import { decodeSizeFor } from './decode-size';
import {
  exportCollage,
  ExportError,
  TOO_LARGE_MESSAGE,
  type DecodedOriginal,
  type ExportDeps,
  type ExportPhoto,
  type ExportProgress,
  type ExportSurface,
} from './export';

interface Call {
  op: string;
  args: unknown[];
}

function surfaceOf(
  calls: Call[],
  overrides: Partial<ExportSurface> = {},
): ExportSurface {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low' as ImageSmoothingQuality,
    fillRect: (...args: number[]) => {
      calls.push({ op: 'fillRect', args: [ctx.fillStyle, ...args] });
    },
    drawImage: (...args: unknown[]) => {
      calls.push({ op: 'drawImage', args });
    },
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  } satisfies CollageContext;
  return {
    context: ctx,
    alphaAt: () => 255,
    encode: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
    dispose: () => undefined,
    ...overrides,
  };
}

const shapes = [
  { id: 'wide', aspect: 2 },
  { id: 'tall', aspect: 0.5 },
  { id: 'square', aspect: 1 },
  { id: 'land', aspect: 4 / 3 },
  { id: 'port', aspect: 3 / 4 },
];

/** Originals of 4000 px on the long side. */
const originals = new Map<string, ExportPhoto>(
  shapes.map((s) => {
    const width = s.aspect >= 1 ? 4000 : Math.round(4000 * s.aspect);
    const height = s.aspect >= 1 ? Math.round(4000 / s.aspect) : 4000;
    return [
      s.id,
      { name: `${s.id}.jpg`, file: new Blob([s.id]), width, height },
    ];
  }),
);

function setup(overrides: Partial<ExportDeps> = {}): {
  deps: ExportDeps;
  calls: Call[];
  decodes: { id: string; size: unknown }[];
  state: { open: number; maxOpen: number; closed: number };
} {
  const calls: Call[] = [];
  const decodes: { id: string; size: unknown }[] = [];
  const counts = { open: 0, maxOpen: 0, closed: 0 };
  const deps: ExportDeps = {
    createSurface: () => surfaceOf(calls),
    decode: async (file, size) => {
      const id = await file.text();
      const photo = originals.get(id);
      if (!photo) throw new Error('no such photo');
      decodes.push({ id, size });
      counts.open++;
      counts.maxOpen = Math.max(counts.maxOpen, counts.open);
      await Promise.resolve();
      const decoded: DecodedOriginal = {
        image: { id } as unknown as CanvasImageSource,
        width: size?.width ?? photo.width,
        height: size?.height ?? photo.height,
        close: () => {
          counts.open--;
          counts.closed++;
        },
      };
      return decoded;
    },
    yieldToUi: () => Promise.resolve(),
    ...overrides,
  };
  return { deps, calls, decodes, state: counts };
}

const base = createEditorState({
  seed: 7,
  photos: shapes,
  variation: 0.8,
  canvas: { width: 2000, height: 1500 },
});

describe('exportCollage', () => {
  it('draws the tiles at the output size from the same plan', async () => {
    const state = setBorder(
      setBackground(
        setCrop(base, 'tall', { x: 0.2, y: 0.7, zoom: 2 }),
        '#ff00ff',
      ),
      0.02,
    );
    const { deps, calls } = setup();
    const result = await exportCollage({
      state,
      photos: originals,
      format: 'png',
      quality: 0.9,
      deps,
    });
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1500);
    // The destinations are tilesFor at the output size (border computed
    // there, edges snapped), not a scaled copy of the preview's.
    const tiles = tilesFor(state, { width: 2000, height: 1500 });
    const drawn = calls.filter((c) => c.op === 'drawImage');
    expect(drawn).toHaveLength(tiles.length);
    tiles.forEach((tile, i) => {
      expect(drawn[i]?.args.slice(5)).toEqual([
        tile.x,
        tile.y,
        tile.width,
        tile.height,
      ]);
    });
    expect(calls[0]).toEqual({
      op: 'fillRect',
      args: ['#ff00ff', 0, 0, 2000, 1500],
    });
  });

  it('draws the same region of each photo as the preview, from a shrunk copy', async () => {
    const state = setCrop(base, 'wide', { x: 0.9, y: 0.1, zoom: 3 });
    const { deps, calls } = setup();
    await exportCollage({
      state,
      photos: originals,
      format: 'png',
      quality: 1,
      deps,
    });
    const exportCalls = calls.filter((c) => c.op === 'drawImage');

    // The preview path: 1024 px images, same state, another size.
    const preview: Call[] = [];
    const previewSurface = surfaceOf(preview);
    renderCollage(
      previewSurface.context,
      state,
      { width: 2000, height: 1500 },
      (id): DrawableImage => {
        const p = originals.get(id);
        if (!p) throw new Error('missing');
        return { image: { id } as never, width: p.width, height: p.height };
      },
    );
    const reference = preview.filter((c) => c.op === 'drawImage');
    expect(exportCalls).toHaveLength(reference.length);
    exportCalls.forEach((call, i) => {
      const image = call.args[0] as { id: string };
      const photo = originals.get(image.id);
      const ref = reference[i];
      if (!photo || !ref) throw new Error('missing');
      // Destination identical; source region equal to the full-size region
      // within a pixel of the shrunk bitmap.
      expect(call.args.slice(5)).toEqual(ref.args.slice(5));
      const k = (ref.args[3] as number) / (call.args[3] as number);
      for (let n = 1; n <= 4; n++) {
        const got = (call.args[n] as number) * k;
        const want = ref.args[n] as number;
        expect(Math.abs(got - want)).toBeLessThan(k + 1e-6);
      }
    });
  });

  it('decodes at the size each tile needs, one original at a time, and closes each', async () => {
    const state = setCrop(base, 'port', { x: 0.5, y: 0.5, zoom: 4 });
    const { deps, decodes, state: counts } = setup();
    await exportCollage({
      state,
      photos: originals,
      format: 'jpeg',
      quality: 0.9,
      deps,
    });
    const tiles = tilesFor(state, { width: 2000, height: 1500 });
    expect(decodes).toHaveLength(tiles.length);
    for (const tile of tiles) {
      const id = state.assignment[tile.slot] ?? '';
      const photo = originals.get(id);
      const want = decodeSizeFor(
        photo?.width ?? 0,
        photo?.height ?? 0,
        tile,
        cropOf(state, id),
      );
      expect(decodes.find((d) => d.id === id)?.size).toEqual(want);
    }
    expect(counts.maxOpen).toBe(1);
    expect(counts.open).toBe(0);
    expect(counts.closed).toBe(tiles.length);
  });

  it('reports progress, then the encoding phase', async () => {
    const { deps } = setup();
    const seen: ExportProgress[] = [];
    await exportCollage({
      state: base,
      photos: originals,
      format: 'png',
      quality: 1,
      onProgress: (p) => seen.push(p),
      deps,
    });
    expect(seen[0]).toEqual({ phase: 'rendering', done: 0, total: 5 });
    expect(seen).toContainEqual({ phase: 'rendering', done: 5, total: 5 });
    expect(seen.at(-1)).toEqual({ phase: 'encoding' });
  });

  it('passes the JPEG quality, and none for PNG', async () => {
    const types: unknown[][] = [];
    const make = (): ExportDeps => ({
      ...setup().deps,
      createSurface: () =>
        surfaceOf([], {
          encode: (type, quality) => {
            types.push([type, quality]);
            return Promise.resolve(new Blob(['x']));
          },
        }),
    });
    await exportCollage({
      state: base,
      photos: originals,
      format: 'jpeg',
      quality: 0.92,
      deps: make(),
    });
    await exportCollage({
      state: base,
      photos: originals,
      format: 'png',
      quality: 0.92,
      deps: make(),
    });
    expect(types).toEqual([
      ['image/jpeg', 0.92],
      ['image/png', undefined],
    ]);
  });

  it('fails clearly if the canvas cannot be created', async () => {
    const { deps } = setup({
      createSurface: () => {
        throw new Error('nope');
      },
    });
    await expect(
      exportCollage({
        state: base,
        photos: originals,
        format: 'png',
        quality: 1,
        deps,
      }),
    ).rejects.toMatchObject({
      reason: 'too-large',
      message: TOO_LARGE_MESSAGE,
    });
  });

  it('fails clearly if the canvas comes back blank', async () => {
    const dispose = vi.fn();
    const { deps } = setup({
      createSurface: () => surfaceOf([], { alphaAt: () => 0, dispose }),
    });
    await expect(
      exportCollage({
        state: base,
        photos: originals,
        format: 'png',
        quality: 1,
        deps,
      }),
    ).rejects.toMatchObject({ reason: 'too-large' });
    expect(dispose).toHaveBeenCalled();
  });

  it('fails clearly if encoding returns null or an empty blob', async () => {
    for (const result of [null, new Blob([])]) {
      const { deps } = setup({
        createSurface: () =>
          surfaceOf([], { encode: () => Promise.resolve(result) }),
      });
      await expect(
        exportCollage({
          state: base,
          photos: originals,
          format: 'jpeg',
          quality: 0.9,
          deps,
        }),
      ).rejects.toMatchObject({ reason: 'too-large' });
    }
  });

  it('stops and names the photo whose original cannot be decoded', async () => {
    const good = setup().deps;
    const dispose = vi.fn();
    const deps: ExportDeps = {
      ...good,
      createSurface: () => surfaceOf([], { dispose }),
      decode: (file, size) =>
        file.text().then((id) => {
          if (id === 'square') throw new Error('corrupt');
          return good.decode(file, size);
        }),
    };
    const error = await exportCollage({
      state: base,
      photos: originals,
      format: 'png',
      quality: 1,
      deps,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).reason).toBe('decode');
    expect((error as ExportError).message).toContain('square.jpg');
    expect(dispose).toHaveBeenCalled();
  });

  it('stops when cancelled, closes what it holds and encodes nothing', async () => {
    const controller = new AbortController();
    const encode = vi.fn(() => Promise.resolve(new Blob(['x'])));
    const setupped = setup({});
    let decoded = 0;
    const deps: ExportDeps = {
      ...setupped.deps,
      createSurface: () => surfaceOf([], { encode }),
      decode: async (file, size) => {
        const image = await setupped.deps.decode(file, size);
        if (++decoded === 2) controller.abort();
        return image;
      },
    };
    await expect(
      exportCollage({
        state: base,
        photos: originals,
        format: 'png',
        quality: 1,
        signal: controller.signal,
        deps,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(encode).not.toHaveBeenCalled();
    expect(setupped.state.open).toBe(0);
    expect(setupped.decodes).toHaveLength(2);
  });

  it('does not change the state it is given', async () => {
    const before = JSON.stringify(base);
    const { deps } = setup();
    await exportCollage({
      state: base,
      photos: originals,
      format: 'png',
      quality: 1,
      deps,
    });
    expect(JSON.stringify(base)).toBe(before);
    // coverSource is what the shared draw code uses: sanity-check import.
    expect(coverSource(10, 10, 5, 5)).not.toBeNull();
  });
});
