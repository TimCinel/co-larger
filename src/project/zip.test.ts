/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index entries they just wrote */
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ProjectError } from './format';
import { makeZip } from './test-helpers';
import {
  createZipStream,
  MAX_ENTRIES,
  readZipDirectory,
  readZipEntry,
  readZipText,
  streamToBlob,
  type ZipSource,
} from './zip';

const BIG = 1 << 30;

function bytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = x >> 16;
  }
  return data;
}

const sources: ZipSource[] = [
  {
    path: 'project.json',
    data: new Blob(['{"a":1}']),
    lastModified: 1_700_000_000_000,
  },
  {
    path: 'photos/a.jpg',
    data: new Blob([bytes(100_000, 1)]),
    lastModified: 1_600_000_000_000,
  },
  { path: 'photos/empty.jpg', data: new Blob([]), lastModified: 0 },
  {
    path: 'photos/b.jpg',
    data: new Blob([new Uint8Array(200_000)]),
    lastModified: 4_102_444_800_000,
  },
];

describe('writing', () => {
  it('writes a zip our reader and fflate both read back byte for byte', async () => {
    const archive = await streamToBlob(createZipStream(sources));
    const entries = await readZipDirectory(archive, BIG);
    expect(entries.map((e) => e.path)).toEqual(sources.map((s) => s.path));
    for (const [i, entry] of entries.entries()) {
      const original = new Uint8Array(
        await (sources[i] as ZipSource).data.arrayBuffer(),
      );
      const read = new Uint8Array(
        await (await readZipEntry(archive, entry)).arrayBuffer(),
      );
      expect(read).toEqual(original);
    }
    // An independent reader agrees.
    const viaFflate = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(viaFflate)).toEqual(sources.map((s) => s.path));
    expect(viaFflate['photos/a.jpg']).toEqual(
      new Uint8Array(await (sources[1] as ZipSource).data.arrayBuffer()),
    );
  });

  it('stores without recompression', async () => {
    const archive = await streamToBlob(createZipStream(sources));
    const entries = await readZipDirectory(archive, BIG);
    expect(
      entries.every((e) => e.method === 0 && e.compressedSize === e.size),
    ).toBe(true);
    // 200 KB of zeros would shrink to almost nothing if it were deflated.
    const total = sources.reduce((sum, s) => sum + s.data.size, 0);
    expect(archive.size).toBeGreaterThan(total);
    expect(archive.size).toBeLessThan(total + 1000);
  });

  it('puts modification times in the directory, clamped to what a zip can say', async () => {
    const archive = await streamToBlob(createZipStream(sources));
    const [, a, empty, far] = await readZipDirectory(archive, BIG);
    expect(Math.abs((a?.lastModified ?? 0) - 1_600_000_000_000)).toBeLessThan(
      4000,
    );
    expect(new Date(empty?.lastModified ?? 0).getUTCFullYear()).toBe(1980);
    expect(new Date(far?.lastModified ?? 0).getUTCFullYear()).toBe(2099);
  });

  it('handles unicode names and no files at all', async () => {
    const odd = await streamToBlob(
      createZipStream([
        { path: 'photos/é.jpg', data: new Blob(['x']), lastModified: 1e12 },
      ]),
    );
    expect((await readZipDirectory(odd, BIG)).map((e) => e.path)).toEqual([
      'photos/é.jpg',
    ]);
    const none = await streamToBlob(createZipStream([]));
    expect(await readZipDirectory(none, BIG)).toEqual([]);
  });

  it('reports progress, and reads only as fast as the consumer pulls', async () => {
    const seen: number[] = [];
    const stream = createZipStream(sources, {
      onProgress: (b) => seen.push(b),
    });
    expect(seen).toEqual([]);
    const reader = stream.getReader();
    await reader.read();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThan(300_000);
    await reader.cancel();
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const stream = createZipStream(sources, { signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it('errors if a source cannot be read', async () => {
    const broken = new Blob(['x']);
    broken.stream = () =>
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('gone'));
        },
      });
    await expect(
      streamToBlob(
        createZipStream([{ path: 'a', data: broken, lastModified: 1e12 }]),
      ),
    ).rejects.toThrow('gone');
  });
});

describe('streamToBlob', () => {
  it('collects chunks across flushes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++)
          controller.enqueue(new Uint8Array(1000).fill(i));
        controller.close();
      },
    });
    const blob = await streamToBlob(stream, 'application/zip', 2500);
    expect(blob.size).toBe(10_000);
    const data = new Uint8Array(await blob.arrayBuffer());
    expect(data[0]).toBe(0);
    expect(data[9999]).toBe(9);
  });
});

describe('reading refuses bad archives', () => {
  const reject = async (
    blob: Blob,
    message: RegExp,
    limit = BIG,
  ): Promise<void> => {
    const error = await readZipDirectory(blob, limit).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as Error).message).toMatch(message);
  };

  it('not a zip', async () => {
    await reject(
      new Blob(['hello world, definitely not a zip file']),
      /not a zip/,
    );
    await reject(new Blob([]), /not a zip/);
    await reject(new Blob([bytes(70_000, 3)]), /not a zip/);
  });

  it('a truncated zip', async () => {
    const archive = await streamToBlob(createZipStream(sources));
    await reject(archive.slice(0, archive.size - 30), /not a zip|damaged/);
    await reject(archive.slice(0, 100), /not a zip/);
  });

  it('unsafe paths, even for files nobody asked for', async () => {
    for (const name of [
      '../evil.txt',
      'a/../../evil.txt',
      '/etc/passwd',
      'a\\b.txt',
      'C:/x.txt',
    ]) {
      await reject(
        makeZip({ 'project.json': '{}', [name]: 'x' }),
        /unsafe file path/,
      );
    }
  });

  it('too many entries', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ENTRIES; i++)
      files[`f${String(i)}`] = new Uint8Array(0);
    await reject(new Blob([zipSync(files, { level: 0 })]), /limit/);
  });

  it('a declared size over the limit', async () => {
    await reject(
      makeZip({ 'photos/a.jpg': new Uint8Array(5000) }),
      /too large/,
      4000,
    );
  });

  it('a directory that points outside the file', async () => {
    const archive = new Uint8Array(await makeZip({ a: 'x' }).arrayBuffer());
    const view = new DataView(archive.buffer);
    view.setUint32(archive.length - 6, 0x00ffffff, true);
    await reject(new Blob([archive]), /damaged/);
  });

  it('a stored entry whose sizes disagree', async () => {
    const archive = new Uint8Array(await makeZip({ a: 'hello' }).arrayBuffer());
    const view = new DataView(archive.buffer);
    const central = findSignature(archive, 0x02014b50);
    view.setUint32(central + 24, 3, true);
    await reject(new Blob([archive]), /inconsistent sizes/);
  });

  it('encryption', async () => {
    const archive = new Uint8Array(await makeZip({ a: 'hello' }).arrayBuffer());
    const view = new DataView(archive.buffer);
    const central = findSignature(archive, 0x02014b50);
    view.setUint16(central + 8, 1, true);
    await reject(new Blob([archive]), /encrypted/);
  });
});

function findSignature(data: Uint8Array, signature: number): number {
  const view = new DataView(data.buffer);
  for (let i = 0; i < data.length - 4; i++) {
    if (view.getUint32(i, true) === signature) return i;
  }
  throw new Error('signature not found');
}

describe('deflated entries', () => {
  const deflated = (): Uint8Array<ArrayBuffer> =>
    zipSync({ 'a.txt': new Uint8Array(10_000) }, { level: 6 });

  it('are read when they are honest', async () => {
    const archive = new Blob([deflated()]);
    const [entry] = await readZipDirectory(archive, BIG);
    expect(entry?.method).toBe(8);
    expect(entry?.compressedSize).toBeLessThan(100);
    const blob = await readZipEntry(archive, entry!);
    expect(blob.size).toBe(10_000);
  });

  it('are refused when they expand beyond their declared size', async () => {
    const data = deflated();
    const central = findSignature(data, 0x02014b50);
    new DataView(data.buffer).setUint32(central + 24, 100, true);
    const archive = new Blob([data]);
    const [entry] = await readZipDirectory(archive, BIG);
    await expect(readZipEntry(archive, entry!)).rejects.toThrow(
      /beyond its declared size/,
    );
  });

  it('are refused when they expand to less than declared', async () => {
    const data = deflated();
    const central = findSignature(data, 0x02014b50);
    new DataView(data.buffer).setUint32(central + 24, 20_000, true);
    const archive = new Blob([data]);
    const [entry] = await readZipDirectory(archive, BIG);
    await expect(readZipEntry(archive, entry!)).rejects.toThrow(/wrong size/);
  });
});

describe('readZipText', () => {
  it('decodes UTF-8', async () => {
    const archive = makeZip({ 'project.json': strToU8('{"name":"café"}') });
    const [entry] = await readZipDirectory(archive, BIG);
    expect(await readZipText(archive, entry!)).toBe('{"name":"café"}');
  });
});
