import { describe, expect, it } from 'vitest';
import type { Tile } from '../layout';
import type { Crop } from './crop';
import {
  ImageCache,
  type CachePhoto,
  type DecodedImage,
  type DecodeRequest,
} from './images';
import { storedSize } from './image-source';

const MB = 1024 * 1024;

class FakeImage implements DecodedImage {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly level: string,
    readonly id: string,
    private readonly onClose: (image: FakeImage) => void,
  ) {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }
}

function photo(id: string, width = 4000, height = 3000): CachePhoto {
  return {
    width,
    height,
    file: new Blob([`file:${id}`]),
    preview: new Blob([`preview:${id}`]),
    thumbnail: new Blob([`thumbnail:${id}`]),
  };
}

interface SetupOptions {
  budgetBytes?: number;
  concurrency?: number;
  photoCount?: number;
  width?: number;
  height?: number;
  onError?: (id: string) => void;
  /** Rejects the decode of these `level:id` keys. */
  failing?: Set<string>;
  /** Milliseconds a decode takes, per request. */
  delay?: (request: DecodeRequest) => number;
}

function setup(options: SetupOptions = {}) {
  const count = options.photoCount ?? 4;
  const photos = new Map<string, CachePhoto>();
  for (let i = 0; i < count; i++) {
    const id = String.fromCharCode(97 + (i % 26)) + String(Math.floor(i / 26));
    photos.set(id, photo(id, options.width, options.height));
  }
  const ids = [...photos.keys()];
  const requests: DecodeRequest[] = [];
  const decodeCounts = new Map<string, number>();
  const live = new Set<FakeImage>();
  let liveBytes = 0;
  let peakLive = 0;
  let loads = 0;
  const cache = new ImageCache<FakeImage>({
    lookup: (id) => photos.get(id),
    decode: (request) => {
      requests.push(request);
      const key = `${request.level}:${request.id}`;
      decodeCounts.set(key, (decodeCounts.get(key) ?? 0) + 1);
      return new Promise<FakeImage>((resolve, reject) => {
        setTimeout(
          () => {
            if (options.failing?.has(key)) {
              reject(new Error('bad'));
              return;
            }
            const image = new FakeImage(
              request.size.width,
              request.size.height,
              request.level,
              request.id,
              (closed) => {
                live.delete(closed);
                liveBytes -= closed.width * closed.height * 4;
              },
            );
            live.add(image);
            liveBytes += image.width * image.height * 4;
            peakLive = Math.max(peakLive, liveBytes);
            resolve(image);
          },
          options.delay?.(request) ?? 0,
        );
      });
    },
    onLoad: () => loads++,
    budgetBytes: options.budgetBytes,
    concurrency: options.concurrency,
    onError: options.onError,
  });
  return {
    cache,
    photos,
    ids,
    requests,
    decodeCounts,
    live,
    peakLive: () => peakLive,
    liveBytes: () => liveBytes,
    loads: () => loads,
  };
}

interface Want {
  id: string;
  tile: Tile;
  crop?: Crop;
}
const tile = (width: number, height: number, slot = 0): Tile => ({
  slot,
  x: 0,
  y: 0,
  width,
  height,
});
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Draws one frame like the view does; returns what each tile got. */
function frame(cache: ImageCache<FakeImage>, wants: Want[]) {
  cache.nextFrame();
  const got = wants.map((w) => {
    const image = cache.get(w.id, w.tile, w.crop);
    return image ? (image.image as unknown as FakeImage) : null;
  });
  cache.endFrame();
  return got;
}

/** Draws the same frame until decoding has settled. */
async function settle(
  cache: ImageCache<FakeImage>,
  wants: Want[],
  maxFrames = 200,
) {
  let got = frame(cache, wants);
  for (let i = 0; i < maxFrames; i++) {
    await tick();
    got = frame(cache, wants);
    const { queued, loading } = cache.stats();
    if (queued === 0 && loading === 0) {
      await tick();
      return frame(cache, wants);
    }
  }
  return got;
}

const small = tile(120, 90);
const medium = tile(800, 600);
// 4000 x 3000 photo; 2200 x 1650 needs more than the 1024 px preview.
const huge = tile(2200, 1650);

describe('ImageCache', () => {
  it('returns null at first, decodes in the background, then returns the image', async () => {
    const { cache, loads } = setup();
    expect(frame(cache, [{ id: 'a0', tile: small }])).toEqual([null]);
    const [got] = await settle(cache, [{ id: 'a0', tile: small }]);
    expect(loads()).toBeGreaterThan(0);
    expect(got?.level).toBe('thumbnail');
    expect(got?.width).toBe(256);
  });

  it('uses the thumbnail for small tiles and never decodes their preview', async () => {
    const { cache, decodeCounts } = setup();
    await settle(cache, [{ id: 'a0', tile: small }]);
    expect([...decodeCounts.keys()]).toEqual(['thumbnail:a0']);
  });

  it('uses the preview for medium tiles, with the thumbnail standing in meanwhile', async () => {
    const { cache, requests } = setup();
    const wants = [{ id: 'a0', tile: medium }];
    await settle(cache, [{ id: 'a0', tile: small }]);
    const interim = frame(cache, wants)[0];
    expect(interim?.level).toBe('thumbnail');
    const [final] = await settle(cache, wants);
    expect(final?.level).toBe('preview');
    expect(requests.map((r) => r.level)).toEqual(['thumbnail', 'preview']);
  });

  it('decodes a larger image of the original for a tile that outgrows the preview, never above the original', async () => {
    const { cache, requests } = setup();
    const wants = [{ id: 'a0', tile: huge }];
    await settle(cache, wants);
    // The preview is drawn first; the sharper image follows.
    expect(requests.map((r) => r.level)).toEqual([
      'thumbnail',
      'preview',
      'detail',
    ]);
    const detail = requests.find((r) => r.level === 'detail');
    expect(detail?.size.width).toBeGreaterThanOrEqual(2200);
    expect(detail?.size.width).toBeLessThanOrEqual(4000);
    expect((detail?.size.width ?? 0) / (detail?.size.height ?? 1)).toBeCloseTo(
      4 / 3,
      2,
    );
    const [got] = frame(cache, wants);
    expect(got?.level).toBe('detail');
    const huge2 = tile(9000, 6750);
    const big = setup();
    await settle(big.cache, [{ id: 'a0', tile: huge2 }]);
    const sizes = big.requests.filter((r) => r.level === 'detail');
    expect(sizes[0]?.size).toEqual({ width: 4000, height: 3000 });
  });

  it('draws the preview until the sharper image is ready, then swaps it in without a gap', async () => {
    const { cache } = setup({ delay: (r) => (r.level === 'detail' ? 20 : 0) });
    const wants = [{ id: 'a0', tile: huge }];
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 40; i++) {
      await tick();
      seen.push(frame(cache, wants)[0]?.level);
    }
    const firstPreview = seen.indexOf('preview');
    const firstDetail = seen.indexOf('detail');
    expect(firstPreview).toBeGreaterThan(-1);
    expect(firstDetail).toBeGreaterThan(firstPreview);
    // Never goes back to blank or a smaller image once drawn.
    expect(seen.slice(firstPreview).includes(undefined)).toBe(false);
    expect(seen.slice(firstDetail).every((l) => l === 'detail')).toBe(true);
  });

  it('takes the crop zoom into account when choosing the source', async () => {
    const { cache, requests } = setup();
    // The same small tile, zoomed 5x, samples a fifth of the photo.
    await settle(cache, [
      { id: 'a0', tile: tile(300, 225), crop: { x: 0.5, y: 0.5, zoom: 5 } },
    ]);
    expect(requests.map((r) => r.level)).toEqual([
      'thumbnail',
      'preview',
      'detail',
    ]);
    const plain = setup();
    await settle(plain.cache, [{ id: 'a0', tile: tile(300, 225) }]);
    expect(plain.requests.map((r) => r.level)).toEqual([
      'thumbnail',
      'preview',
    ]);
  });

  it('draws a tile from the image it needs, whatever else is decoded, so pixels do not depend on history', async () => {
    const { cache } = setup();
    // The photo was big once, so its preview is decoded...
    await settle(cache, [{ id: 'a0', tile: medium }]);
    // ...but a small tile still draws from the thumbnail, as it would have
    // had the preview never been decoded.
    const [got] = await settle(cache, [{ id: 'a0', tile: small }]);
    expect(got?.level).toBe('thumbnail');
    const [big] = await settle(cache, [{ id: 'a0', tile: huge }]);
    expect(big?.level).toBe('detail');
    const [again] = await settle(cache, [{ id: 'a0', tile: medium }]);
    expect(again?.level).toBe('preview');
  });

  it('does not decode a detail for a photo no larger than its preview', async () => {
    const { cache, requests } = setup({ width: 900, height: 600 });
    await settle(cache, [{ id: 'a0', tile: tile(1800, 1200) }]);
    expect(requests.some((r) => r.level === 'detail')).toBe(false);
  });

  it('starts no detail decode while interacting, then upgrades once it settles', async () => {
    const { cache, requests, loads } = setup();
    const wants = [{ id: 'a0', tile: huge }];
    cache.setInteracting(true);
    await settle(cache, wants);
    expect(requests.map((r) => r.level)).toEqual(['thumbnail', 'preview']);
    expect(cache.upgradingTiles()).toBe(1);
    const before = loads();
    cache.setInteracting(false);
    expect(loads()).toBeGreaterThan(before);
    await settle(cache, wants);
    expect(requests.map((r) => r.level)).toEqual([
      'thumbnail',
      'preview',
      'detail',
    ]);
    expect(cache.upgradingTiles()).toBe(0);
  });

  it('draws the preview quietly when the detail cannot be decoded', async () => {
    const errors: string[] = [];
    const { cache, decodeCounts } = setup({
      failing: new Set(['detail:a0']),
      onError: (id) => errors.push(id),
    });
    const wants = [{ id: 'a0', tile: huge }];
    const [got] = await settle(cache, wants);
    expect(got?.level).toBe('preview');
    expect(errors).toEqual([]);
    expect(cache.isFailed('a0')).toBe(false);
    expect(cache.upgradingTiles()).toBe(0);
    await settle(cache, wants);
    expect(decodeCounts.get('detail:a0')).toBe(1);
  });

  it('falls back to the preview when the thumbnail fails, then reports the photo as failed once', async () => {
    const errors: string[] = [];
    const { cache, decodeCounts } = setup({
      failing: new Set(['thumbnail:a0', 'preview:a0']),
      onError: (id) => errors.push(id),
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const wants = [{ id: 'a0', tile: small }];
      const [got] = await settle(cache, wants);
      expect(got).toBeNull();
      expect(cache.isFailed('a0')).toBe(true);
      expect(errors).toEqual(['a0']);
      await settle(cache, wants);
      expect(decodeCounts.get('thumbnail:a0')).toBe(1);
      expect(decodeCounts.get('preview:a0')).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  it('limits concurrent decodes', async () => {
    const { cache, requests } = setup({ concurrency: 2 });
    cache.prefetch(['a0', 'b0', 'c0', 'd0']);
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(cache.stats().queued).toBe(2);
    await tick();
    await tick();
    await tick();
    expect(cache.stats().images).toBe(4);
  });

  it('releases images of removed photos, including ones still decoding', async () => {
    const { cache, photos, live, liveBytes } = setup();
    cache.prefetch(['a0', 'b0']);
    await settle(cache, []);
    cache.prefetch(['c0']);
    await Promise.resolve();
    cache.release(['a0', 'c0']);
    photos.delete('a0');
    await tick();
    await tick();
    expect([...live].map((i) => i.id)).toEqual(['b0']);
    expect(cache.stats().images).toBe(1);
    expect(cache.stats().bytes).toBe(liveBytes());
  });

  it('returns null for unknown photos', () => {
    const { cache } = setup();
    expect(cache.get('zzz', small)).toBeNull();
    expect(cache.stats().queued).toBe(0);
  });

  it('clear closes everything', async () => {
    const { cache, live } = setup();
    cache.prefetch(['a0', 'b0', 'c0']);
    await settle(cache, []);
    cache.clear();
    expect(live.size).toBe(0);
    expect(cache.stats()).toMatchObject({ bytes: 0, images: 0 });
  });
});

describe('ImageCache budget', () => {
  const preview = storedSize({ width: 4000, height: 3000 }, 'preview');
  const previewBytes = preview.width * preview.height * 4;
  const thumbBytes = 256 * 192 * 4;

  it('gives the biggest tiles their previews and draws the rest from thumbnails', async () => {
    const budget = 2 * previewBytes + 8 * thumbBytes;
    const { cache, ids, live, peakLive } = setup({
      photoCount: 6,
      budgetBytes: budget,
    });
    const wants = ids.map((id, i) => ({
      id,
      tile: tile(800 - i * 20, 600 - i * 15, i),
    }));
    const got = await settle(cache, wants);
    expect(got.map((g) => g?.level)).toEqual([
      'preview',
      'preview',
      'thumbnail',
      'thumbnail',
      'thumbnail',
      'thumbnail',
    ]);
    expect(cache.stats().bytes).toBeLessThanOrEqual(budget);
    expect(peakLive()).toBeLessThanOrEqual(budget);
    expect(cache.upgradingTiles()).toBe(0);
    expect(cache.stats().queued + cache.stats().loading).toBe(0);
    expect(live.size).toBeLessThanOrEqual(8);
  });

  it('closes images that are not in view before ones that are', async () => {
    const budget = 3 * (previewBytes + thumbBytes);
    const { cache, ids, live } = setup({ photoCount: 8, budgetBytes: budget });
    const first = ids
      .slice(0, 3)
      .map((id, i) => ({ id, tile: medium, slot: i }));
    await settle(cache, first);
    const second = ids.slice(3, 6).map((id) => ({ id, tile: medium }));
    await settle(cache, second);
    const held = [...live]
      .filter((i) => i.level === 'preview')
      .map((i) => i.id);
    expect(held.sort()).toEqual(ids.slice(3, 6).sort());
  });

  it('counts a decode in flight against the budget from the moment it starts', async () => {
    // Room for one preview and a few thumbnails only.
    const budget = previewBytes + 6 * thumbBytes;
    const { cache, ids, peakLive } = setup({
      photoCount: 8,
      budgetBytes: budget,
      concurrency: 4,
      delay: () => 2,
    });
    const wants = ids.map((id, i) => ({ id, tile: medium, slot: i }));
    for (let i = 0; i < 40; i++) {
      frame(cache, wants);
      expect(cache.stats().bytes).toBeLessThanOrEqual(budget);
      await tick();
    }
    expect(peakLive()).toBeLessThanOrEqual(budget);
    expect(cache.stats().peakBytes).toBeLessThanOrEqual(budget);
  });

  it('never exceeds the budget under random request sequences', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = random(seed);
      const budget = Math.floor((2 + rng() * 40) * MB);
      const count = 5 + Math.floor(rng() * 60);
      const { cache, ids, peakLive, liveBytes } = setup({
        photoCount: count,
        budgetBytes: budget,
        concurrency: 1 + Math.floor(rng() * 4),
        delay: () => Math.floor(rng() * 3),
      });
      let interacting = false;
      for (let step = 0; step < 60; step++) {
        const action = rng();
        if (action < 0.1) {
          interacting = !interacting;
          cache.setInteracting(interacting);
        } else if (action < 0.15) {
          cache.release(ids.filter(() => rng() < 0.1));
        } else if (action < 0.2) {
          cache.prefetch(ids.filter(() => rng() < 0.5));
        }
        const wants: Want[] = ids
          .filter(() => rng() < 0.7)
          .map((id, slot) => {
            const width = 20 + Math.floor(rng() * rng() * 4000);
            return {
              id,
              tile: tile(width, Math.max(10, width * (0.5 + rng())), slot),
              crop: { x: rng(), y: rng(), zoom: 1 + rng() * 4 },
            };
          });
        frame(cache, wants);
        expect(cache.stats().bytes).toBeLessThanOrEqual(budget);
        expect(liveBytes()).toBeLessThanOrEqual(budget);
        await tick();
        expect(cache.stats().bytes).toBeLessThanOrEqual(budget);
      }
      expect(peakLive()).toBeLessThanOrEqual(budget);
      expect(cache.stats().peakBytes).toBeLessThanOrEqual(budget);
    }
  });

  it('does not decode an image over and over in a steady view', async () => {
    const { cache, ids, decodeCounts } = setup({
      photoCount: 40,
      budgetBytes: 40 * MB,
    });
    const wants = ids.map((id, i) => ({
      id,
      tile: i < 5 ? huge : i < 20 ? medium : small,
      slot: i,
    }));
    await settle(cache, wants);
    const total = [...decodeCounts.values()].reduce((a, b) => a + b, 0);
    for (let i = 0; i < 30; i++) {
      frame(cache, wants);
      await tick();
    }
    expect([...decodeCounts.values()].every((n) => n === 1)).toBe(true);
    expect([...decodeCounts.values()].reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('does not thrash with 300 photos, or when a tile is zoomed in and out', async () => {
    const { cache, ids, decodeCounts } = setup({
      photoCount: 300,
      budgetBytes: 64 * MB,
    });
    const view = (zoom: number): Want[] =>
      ids.map((id, i) => ({
        id,
        tile:
          i === 0
            ? tile(1200, 900)
            : i < 30
              ? tile(400, 300, i)
              : tile(110, 80, i),
        crop: i === 0 ? { x: 0.5, y: 0.5, zoom } : undefined,
      }));
    await settle(cache, view(1));
    for (let round = 0; round < 10; round++) {
      for (const zoom of [1, 3, 1, 5, 2]) {
        await settle(cache, view(zoom));
      }
    }
    expect(cache.stats().bytes).toBeLessThanOrEqual(64 * MB);
    // Every image of every photo other than the zoomed one was decoded once.
    for (const [key, count] of decodeCounts) {
      if (key.startsWith('detail:a0')) continue;
      expect(count, key).toBe(1);
    }
    // The zoomed tile's detail steps up a few times and is then reused.
    expect(decodeCounts.get('detail:a0') ?? 0).toBeLessThanOrEqual(2);
  });
});

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
