import { describe, expect, it } from 'vitest';
import type { Tile } from '../layout';
import { ImageCache, type CachePhoto, type DecodedImage } from './images';

class FakeImage implements DecodedImage {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly label: string,
  ) {}
  close(): void {
    this.closed = true;
  }
}

/** 4:3 photos whose blobs say which photo and level they are. */
function photo(id: string): CachePhoto {
  return {
    width: 4000,
    height: 3000,
    preview: new Blob([`preview:${id}`]),
    thumbnail: new Blob([`thumbnail:${id}`]),
  };
}

function setup(
  options: {
    budgetBytes?: number;
    concurrency?: number;
    onError?: (id: string) => void;
  } = {},
) {
  const photos = new Map(['a', 'b', 'c', 'd'].map((id) => [id, photo(id)]));
  const pending: { label: string; resolve: () => void; fail: () => void }[] =
    [];
  const decoded: FakeImage[] = [];
  let loads = 0;
  const cache = new ImageCache<FakeImage>({
    lookup: (id) => photos.get(id),
    decode: async (blob) => {
      const label = await blob.text();
      const preview = label.startsWith('preview');
      return new Promise<FakeImage>((resolve, reject) => {
        pending.push({
          label,
          resolve: () => {
            const image = preview
              ? new FakeImage(1024, 768, label)
              : new FakeImage(256, 192, label);
            decoded.push(image);
            resolve(image);
          },
          fail: () => {
            reject(new Error('bad'));
          },
        });
      });
    },
    onLoad: () => loads++,
    ...options,
  });
  /** Resolves every pending decode (and any they start). */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 10; round++) {
      await new Promise((r) => setTimeout(r, 0));
      const batch = pending.splice(0);
      if (batch.length === 0) return;
      for (const p of batch) p.resolve();
    }
  };
  return {
    cache,
    photos,
    pending,
    decoded,
    settle,
    loads: () => loads,
  };
}

const small: Tile = { slot: 0, x: 0, y: 0, width: 120, height: 90 };
const large: Tile = { slot: 0, x: 0, y: 0, width: 800, height: 600 };
const labelOf = (image: unknown): string => (image as FakeImage).label;

describe('ImageCache', () => {
  it('returns null at first, decodes in the background, then returns the image', async () => {
    const { cache, settle, loads } = setup();
    expect(cache.get('a', small)).toBeNull();
    await settle();
    expect(loads()).toBe(1);
    const got = cache.get('a', small);
    expect(got && labelOf(got.image)).toBe('thumbnail:a');
    expect(got?.width).toBe(256);
  });

  it('uses the thumbnail for small tiles and never decodes their preview', async () => {
    const { cache, settle, decoded } = setup();
    cache.get('a', small);
    await settle();
    cache.get('a', small);
    await settle();
    expect(decoded.map((d) => d.label)).toEqual(['thumbnail:a']);
  });

  it('uses the preview for large tiles, with the thumbnail standing in meanwhile', async () => {
    const { cache, settle, pending } = setup();
    cache.get('a', small);
    await settle();
    // Now large: the thumbnail is returned while the preview decodes.
    const interim = cache.get('a', large);
    expect(interim && labelOf(interim.image)).toBe('thumbnail:a');
    await new Promise((r) => setTimeout(r, 0));
    expect(pending.map((p) => p.label)).toEqual(['preview:a']);
    await settle();
    const got = cache.get('a', large);
    expect(got && labelOf(got.image)).toBe('preview:a');
  });

  it('takes the crop zoom into account when choosing the resolution', async () => {
    const { cache, settle, decoded } = setup();
    cache.get('a', small, { x: 0.5, y: 0.5, zoom: 4 });
    await settle();
    expect(decoded.map((d) => d.label).sort()).toEqual([
      'preview:a',
      'thumbnail:a',
    ]);
  });

  it('decodes each image once, however often it is asked for', async () => {
    const { cache, settle, decoded } = setup();
    for (let i = 0; i < 5; i++) cache.get('b', small);
    cache.prefetch(['b', 'b']);
    await settle();
    expect(decoded).toHaveLength(1);
  });

  it('limits concurrent decodes', async () => {
    const { cache, pending, settle } = setup({ concurrency: 2 });
    cache.prefetch(['a', 'b', 'c', 'd']);
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2);
    expect(cache.stats().queued).toBe(2);
    await settle();
    expect(cache.stats().images).toBe(4);
  });

  it('releases images of removed photos, including ones still decoding', async () => {
    const { cache, settle, decoded, photos } = setup();
    cache.prefetch(['a', 'b']);
    await settle();
    cache.get('c', small);
    cache.release(['a', 'c']);
    photos.delete('a');
    await settle();
    const a = decoded.find((d) => d.label === 'thumbnail:a');
    const c = decoded.find((d) => d.label === 'thumbnail:c');
    expect(a?.closed).toBe(true);
    expect(c?.closed).toBe(true);
    expect(cache.stats().images).toBe(1);
    expect(cache.stats().bytes).toBe(256 * 192 * 4);
  });

  it('evicts least recently used images beyond the budget, but not those on screen', async () => {
    const thumbBytes = 256 * 192 * 4;
    const { cache, settle, decoded } = setup({ budgetBytes: thumbBytes * 2 });
    cache.nextFrame();
    cache.prefetch(['a', 'b']);
    await settle();
    // Frame 2 draws a and c: b is the least recently used and not on screen.
    cache.nextFrame();
    cache.get('a', small);
    cache.get('c', small);
    await settle();
    expect(decoded.find((d) => d.label === 'thumbnail:b')?.closed).toBe(true);
    expect(cache.stats().bytes).toBe(thumbBytes * 2);
    // Frame 3 draws all four: nothing on screen is evicted, so the budget
    // is exceeded rather than thrashing.
    cache.nextFrame();
    for (const id of ['a', 'b', 'c', 'd']) cache.get(id, small);
    await settle();
    cache.nextFrame();
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(cache.get(id, small)).not.toBeNull();
    }
  });

  it('falls back to the preview when the thumbnail fails, then reports the photo as failed once', async () => {
    const errors: string[] = [];
    const { cache, pending, loads } = setup({
      onError: (id) => errors.push(id),
    });
    const warn = console.warn;
    console.warn = () => undefined;
    const failAll = async (): Promise<string[]> => {
      await new Promise((r) => setTimeout(r, 0));
      const batch = pending.splice(0);
      for (const p of batch) p.fail();
      await new Promise((r) => setTimeout(r, 0));
      return batch.map((p) => p.label);
    };
    try {
      cache.get('a', small);
      expect(await failAll()).toEqual(['thumbnail:a']);
      expect(errors).toEqual(['a']);
      expect(cache.isFailed('a')).toBe(false);
      expect(loads()).toBe(1); // a repaint, to try the fallback
      // The next frame asks for the preview instead.
      cache.get('a', small);
      expect(await failAll()).toEqual(['preview:a']);
      expect(cache.isFailed('a')).toBe(true);
      expect(errors).toEqual(['a']); // reported once
      // And never retries either.
      cache.get('a', small);
      await new Promise((r) => setTimeout(r, 0));
      expect(pending).toHaveLength(0);
      expect(cache.get('a', small)).toBeNull();
    } finally {
      console.warn = warn;
    }
  });

  it('returns null for unknown photos', () => {
    const { cache } = setup();
    expect(cache.get('zzz', small)).toBeNull();
    expect(cache.stats().queued).toBe(0);
  });

  it('clear closes everything', async () => {
    const { cache, settle, decoded } = setup();
    cache.prefetch(['a', 'b', 'c']);
    await settle();
    cache.clear();
    expect(decoded.every((d) => d.closed)).toBe(true);
    expect(cache.stats()).toMatchObject({ bytes: 0, images: 0 });
  });
});
