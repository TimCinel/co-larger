import { describe, expect, it } from 'vitest';
import type { Decoder } from './decode';
import { PhotoImporter, type ImportProgress } from './importer';
import { PhotoStore } from './store';
import { makeDecoded, makeFile } from './test-helpers';

const instantly = (): Promise<void> => Promise.resolve();

/** A decoder that fails for names ending in .heic and tracks concurrency. */
function trackingDecoder(): { decode: Decoder; peak: () => number } {
  let running = 0;
  let peak = 0;
  const decode: Decoder = async (file) => {
    running++;
    peak = Math.max(peak, running);
    // Later files finish sooner, to exercise in-order commit.
    await new Promise((resolve) =>
      setTimeout(resolve, 10 - Math.min(9, file.size)),
    );
    running--;
    if (file.name.endsWith('.heic')) throw new Error('Cannot decode');
    return makeDecoded();
  };
  return { decode, peak: () => peak };
}

describe('PhotoImporter', () => {
  it('imports files into the store in the order given', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const files = [1, 2, 3, 4, 5].map((n) => makeFile(`p${String(n)}.jpg`, n));
    const summary = await importer.enqueue(files);
    expect(summary).toEqual({ added: 5, duplicates: [], failures: [] });
    expect(store.getPhotos().map((p) => p.file.name)).toEqual(
      files.map((f) => f.name),
    );
  });

  it('never decodes more than the concurrency limit at once', async () => {
    const store = new PhotoStore();
    const { decode, peak } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      concurrency: 2,
      yieldToMain: instantly,
    });
    await importer.enqueue(
      Array.from({ length: 12 }, (_, n) =>
        makeFile(`p${String(n)}.jpg`, n + 1),
      ),
    );
    expect(peak()).toBe(2);
    expect(store.getTotalCount()).toBe(12);
  });

  it('skips undecodable files, reports them, and keeps going', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const summary = await importer.enqueue([
      makeFile('a.jpg'),
      makeFile('b.heic'),
      makeFile('c.jpg'),
    ]);
    expect(summary.added).toBe(2);
    expect(summary.failures).toEqual([
      { name: 'b.heic', message: 'Cannot decode' },
    ]);
    expect(store.getPhotos().map((p) => p.file.name)).toEqual([
      'a.jpg',
      'c.jpg',
    ]);
  });

  it('does not add the same file twice, across and within batches', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const first = await importer.enqueue([
      makeFile('a.jpg'),
      makeFile('a.jpg'),
    ]);
    expect(first.added).toBe(1);
    expect(first.duplicates).toEqual(['a.jpg']);
    const second = await importer.enqueue([
      makeFile('a.jpg'),
      makeFile('b.jpg'),
    ]);
    expect(second.added).toBe(1);
    expect(second.duplicates).toEqual(['a.jpg']);
    expect(store.getTotalCount()).toBe(2);
  });

  it('treats the same file queued while it is still importing as a duplicate', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const one = importer.enqueue([makeFile('a.jpg')]);
    const two = importer.enqueue([makeFile('a.jpg')]);
    expect((await one).added).toBe(1);
    expect((await two).duplicates).toEqual(['a.jpg']);
    expect(store.getTotalCount()).toBe(1);
  });

  it('allows retrying a file that failed to decode', async () => {
    const store = new PhotoStore();
    let fail = true;
    const decode: Decoder = () =>
      fail ? Promise.reject(new Error('nope')) : Promise.resolve(makeDecoded());
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    expect((await importer.enqueue([makeFile('a.jpg')])).failures).toHaveLength(
      1,
    );
    fail = false;
    expect((await importer.enqueue([makeFile('a.jpg')])).added).toBe(1);
  });

  it('merges a second enqueue during an import into one queue', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const a = importer.enqueue([makeFile('a.jpg', 1), makeFile('b.jpg', 2)]);
    const b = importer.enqueue([makeFile('c.jpg', 3)]);
    expect((await a).added).toBe(2);
    expect((await b).added).toBe(1);
    expect(store.getPhotos().map((p) => p.file.name)).toEqual([
      'a.jpg',
      'b.jpg',
      'c.jpg',
    ]);
  });

  it('reports progress, ending idle', async () => {
    const store = new PhotoStore();
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const seen: ImportProgress[] = [];
    importer.subscribe((p) => seen.push(p));
    await importer.enqueue([
      makeFile('a.jpg', 1),
      makeFile('b.heic', 2),
      makeFile('c.jpg', 3),
    ]);
    expect(seen[0]).toEqual({ active: true, total: 3, done: 0 });
    expect(seen.map((p) => p.done)).toContain(3);
    expect(seen.at(-1)).toEqual({ active: false, total: 0, done: 0 });
    expect(importer.getProgress().active).toBe(false);
    for (const p of seen) expect(p.done).toBeLessThanOrEqual(p.total);
  });

  it('resolves immediately for an empty list', async () => {
    const importer = new PhotoImporter(new PhotoStore(), {
      decode: () => Promise.reject(new Error('unused')),
    });
    expect(await importer.enqueue([])).toEqual({
      added: 0,
      duplicates: [],
      failures: [],
    });
  });

  it('yields to the main thread between photos', async () => {
    let yields = 0;
    const importer = new PhotoImporter(new PhotoStore(), {
      decode: () => Promise.resolve(makeDecoded()),
      concurrency: 1,
      yieldToMain: () => {
        yields++;
        return Promise.resolve();
      },
    });
    await importer.enqueue([
      makeFile('a.jpg'),
      makeFile('b.jpg'),
      makeFile('c.jpg'),
    ]);
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it('does not stall when a store listener throws', async () => {
    const store = new PhotoStore({ onListenerError: () => undefined });
    store.subscribe(() => {
      throw new Error('bad listener');
    });
    const { decode } = trackingDecoder();
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const summary = await importer.enqueue([
      makeFile('a.jpg', 1),
      makeFile('b.jpg', 2),
    ]);
    expect(summary.added).toBe(2);
    expect(importer.getProgress().active).toBe(false);
  });

  it('reports a failure if the store rejects a photo, and carries on', async () => {
    const store = new PhotoStore();
    const decode: Decoder = (file) =>
      Promise.resolve(
        file.name === 'zero.jpg' ? makeDecoded(0, 0) : makeDecoded(),
      );
    const importer = new PhotoImporter(store, {
      decode,
      yieldToMain: instantly,
    });
    const summary = await importer.enqueue([
      makeFile('zero.jpg'),
      makeFile('ok.jpg'),
    ]);
    expect(summary.added).toBe(1);
    expect(summary.failures.map((f) => f.name)).toEqual(['zero.jpg']);
    expect(importer.getProgress().active).toBe(false);
  });

  describe('hold', () => {
    it('is busy until released, and tells listeners when it goes idle', () => {
      const store = new PhotoStore();
      const importer = new PhotoImporter(store, {
        decode: () => Promise.resolve(makeDecoded()),
        yieldToMain: instantly,
      });
      const busy: boolean[] = [];
      importer.subscribe(() => busy.push(importer.isBusy()));
      expect(importer.isBusy()).toBe(false);
      const release = importer.hold();
      expect(importer.isBusy()).toBe(true);
      expect(importer.getProgress().active).toBe(false);
      release();
      release(); // again: nothing
      expect(importer.isBusy()).toBe(false);
      expect(busy).toEqual([false]);
    });

    it('stays busy through an import until the hold is released too', async () => {
      const store = new PhotoStore();
      const importer = new PhotoImporter(store, {
        decode: () => Promise.resolve(makeDecoded()),
        yieldToMain: instantly,
      });
      const release = importer.hold();
      await importer.enqueue([makeFile('a.jpg')]);
      expect(importer.isBusy()).toBe(true);
      release();
      expect(importer.isBusy()).toBe(false);
    });

    it('nested holds release one by one', () => {
      const importer = new PhotoImporter(new PhotoStore(), {
        decode: () => Promise.resolve(makeDecoded()),
      });
      const a = importer.hold();
      const b = importer.hold();
      a();
      expect(importer.isBusy()).toBe(true);
      b();
      expect(importer.isBusy()).toBe(false);
    });
  });
});
