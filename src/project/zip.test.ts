/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index entries they just wrote */
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ProjectError } from './format';
import { makeZip, rawZip, withByte } from './test-helpers';
import {
  checkZipEntry,
  Crc32,
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
    ).rejects.toThrow(/can no longer be read/);
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

describe('Crc32', () => {
  it('matches the standard check value, in any chunking', () => {
    const data = strToU8('123456789');
    const whole = new Crc32();
    whole.update(data);
    expect(whole.value).toBe(0xcbf43926);
    const pieces = new Crc32();
    for (const byte of data) pieces.update(Uint8Array.of(byte));
    expect(pieces.value).toBe(0xcbf43926);
    expect(new Crc32().value).toBe(0);
  });

  it('agrees with the checksum fflate wrote, for long data', async () => {
    const data = bytes(100_003, 9);
    const archive = new Blob([zipSync({ a: data }, { level: 0 })]);
    const [entry] = await readZipDirectory(archive, BIG);
    const crc = new Crc32();
    crc.update(data.subarray(0, 12_345));
    crc.update(data.subarray(12_345));
    expect(crc.value).toBe(entry?.crc);
    await expect(checkZipEntry(archive, entry!)).resolves.toBeUndefined();
  });
});

describe('checkZipEntry', () => {
  const data = bytes(5000, 4);

  it('passes an entry with the right checksum, ours or deflated', async () => {
    const archive = await streamToBlob(
      createZipStream([
        { path: 'a', data: new Blob([data]), lastModified: 1e12 },
      ]),
    );
    const [entry] = await readZipDirectory(archive, BIG);
    await expect(checkZipEntry(archive, entry!)).resolves.toBeUndefined();
    const packed = new Blob([zipSync({ b: data }, { level: 6 })]);
    const [deflated] = await readZipDirectory(packed, BIG);
    await expect(checkZipEntry(packed, deflated!)).resolves.toBeUndefined();
  });

  it('refuses a changed byte, a wrong checksum and a wrong size', async () => {
    const good = rawZip([{ name: 'a', data }]);
    const [entry] = await readZipDirectory(good, BIG);
    const flipped = await withByte(good, entry!.dataOffset + 10, (b) => b ^ 1);
    await expect(checkZipEntry(flipped, entry!)).rejects.toThrow(/damaged/);
    const wrongCrc = rawZip([{ name: 'a', data, crc: entry!.crc ^ 1 }]);
    const [e2] = await readZipDirectory(wrongCrc, BIG);
    await expect(checkZipEntry(wrongCrc, e2!)).rejects.toThrow(/damaged/);
    await expect(
      checkZipEntry(good, { ...entry!, size: 4999, compressedSize: 5000 }),
    ).rejects.toThrow(/damaged/);
  });

  it('refuses a deflated entry that is corrupt or expands past its size', async () => {
    const packed = zipSync({ b: new Uint8Array(10_000) }, { level: 6 });
    const [entry] = await readZipDirectory(new Blob([packed]), BIG);
    const bad = await withByte(
      new Blob([packed]),
      entry!.dataOffset + 2,
      (b) => b ^ 0xff,
    );
    await expect(checkZipEntry(bad, entry!)).rejects.toThrow(/damaged/);
    await expect(
      checkZipEntry(new Blob([packed]), { ...entry!, size: 100 }),
    ).rejects.toThrow(/damaged/);
  });

  it('stops when aborted', async () => {
    const good = rawZip([{ name: 'a', data }]);
    const [entry] = await readZipDirectory(good, BIG);
    const controller = new AbortController();
    controller.abort();
    await expect(
      checkZipEntry(good, entry!, controller.signal),
    ).rejects.toThrow();
  });

  it('reports an unreadable archive as a lost file', async () => {
    const good = rawZip([{ name: 'a', data }]);
    const [entry] = await readZipDirectory(good, BIG);
    const broken = new Blob([data]);
    broken.slice = () => {
      const part = new Blob([data]);
      part.stream = () =>
        new ReadableStream({
          pull(controller) {
            controller.error(new DOMException('gone', 'NotFoundError'));
          },
        });
      return part;
    };
    await expect(checkZipEntry(broken, entry!)).rejects.toThrow(
      /can no longer be read/,
    );
  });
});

describe('hostile archives', () => {
  const ok = new Uint8Array([1, 2, 3]);
  const reject = async (blob: Blob, message: RegExp): Promise<void> => {
    const error = await readZipDirectory(blob, BIG).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, String(message)).toBeInstanceOf(ProjectError);
    expect((error as Error).message).toMatch(message);
  };

  it('huge declared sizes', async () => {
    await reject(
      rawZip([
        { name: 'a', data: ok, size: 0xf0000000, compressedSize: 0xf0000000 },
      ]),
      /damaged|too large/,
    );
    await readZipDirectory(rawZip([{ name: 'a', data: ok }]), 1 << 30);
    await reject(
      rawZip([
        { name: 'a', data: ok, size: 0xf0000000, compressedSize: 0xf0000000 },
      ]).slice(0),
      /damaged|too large/,
    );
    const limited = await readZipDirectory(
      rawZip([{ name: 'a', data: ok }]),
      2,
    ).then(
      () => 'ok',
      (e: unknown) => (e as Error).message,
    );
    expect(limited).toMatch(/too large/);
    await reject(
      rawZip([
        { name: 'a', data: ok, size: 0xffffffff, compressedSize: 0xffffffff },
      ]),
      /damaged|too large|ZIP64/,
    );
  });

  it('a declared size that does not match the data', async () => {
    await reject(rawZip([{ name: 'a', data: ok, size: 10 }]), /inconsistent/);
    await reject(
      rawZip([{ name: 'a', data: ok, size: 10, compressedSize: 10 }]),
      /damaged/,
    );
  });

  it('thousands of entries: the limit holds, and the limit itself works', async () => {
    const make = (n: number) =>
      rawZip(Array.from({ length: n }, (_, i) => ({ name: `f${String(i)}` })));
    expect(await readZipDirectory(make(MAX_ENTRIES), BIG)).toHaveLength(
      MAX_ENTRIES,
    );
    await reject(make(MAX_ENTRIES + 1), /limit/);
  });

  it('names with .., absolute paths, backslashes and drive letters', async () => {
    for (const name of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'a\\b',
      'C:\\x',
      'c:x',
      './x',
      'a//b',
      '..\\x',
    ]) {
      await reject(rawZip([{ name, data: ok }]), /unsafe/);
    }
  });

  it('duplicate names', async () => {
    await reject(
      rawZip([
        { name: 'a', data: ok },
        { name: 'a', data: ok },
      ]),
      /twice/,
    );
  });

  it('names that are not UTF-8 are read, not fatal', async () => {
    const entries = await readZipDirectory(
      rawZip([{ name: Uint8Array.of(0x70, 0xff, 0xfe, 0x2e, 0x6a), data: ok }]),
      BIG,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toContain('\ufffd');
  });

  it('a zip64 archive is refused clearly', async () => {
    await reject(rawZip([{ name: 'a', data: ok }], { count: 0xffff }), /ZIP64/);
    await reject(
      rawZip([{ name: 'a', data: ok }], { zip64Locator: true }),
      /ZIP64/,
    );
  });

  it('a comment in the end record, and garbage after it', async () => {
    const withComment = rawZip([{ name: 'a', data: ok }], {
      comment: 'made by someone',
    });
    expect(await readZipDirectory(withComment, BIG)).toHaveLength(1);
    const trailing = rawZip([{ name: 'a', data: ok }], {
      trailing: bytes(500, 5),
    });
    expect(await readZipDirectory(trailing, BIG)).toHaveLength(1);
    const both = rawZip([{ name: 'a', data: ok }], {
      comment: 'PK\u0005\u0006 inside',
      trailing: bytes(40, 6),
    });
    expect(await readZipDirectory(both, BIG)).toHaveLength(1);
  });

  it('data descriptors (sizes after the data), as our own writer and many tools write', async () => {
    const archive = rawZip([{ name: 'a', data: ok, flags: 8 }]);
    const [entry] = await readZipDirectory(archive, BIG);
    expect(entry?.size).toBe(3);
    await checkZipEntry(archive, entry!);
  });

  it('a deflated entry is read, but a stored photo is expected (see open)', async () => {
    const packed = new Blob([
      zipSync({ a: new Uint8Array(100) }, { level: 6 }),
    ]);
    const [entry] = await readZipDirectory(packed, BIG);
    expect(entry?.method).toBe(8);
  });

  it('an encrypted entry and an unknown method', async () => {
    await reject(rawZip([{ name: 'a', data: ok, flags: 1 }]), /encrypted/);
    await reject(rawZip([{ name: 'a', data: ok, method: 12 }]), /unsupported/);
  });

  it('truncated at any point: a clear error, never another exception', async () => {
    const archive = rawZip([
      { name: 'project.json', data: strToU8('{"a":1}') },
      { name: 'photos/a.jpg', data: bytes(300, 1) },
    ]);
    for (let cut = 0; cut < archive.size; cut += 3) {
      const error = await readZipDirectory(archive.slice(0, cut), BIG).then(
        () => null,
        (e: unknown) => e,
      );
      if (error !== null) expect(error).toBeInstanceOf(ProjectError);
    }
  });

  it('a random byte changed anywhere: readable or a clear error, never a crash or hang', async () => {
    const archive = await streamToBlob(
      createZipStream([
        {
          path: 'project.json',
          data: new Blob(['{"a":1}']),
          lastModified: 1e12,
        },
        {
          path: 'photos/a.jpg',
          data: new Blob([bytes(400, 2)]),
          lastModified: 1e12,
        },
      ]),
    );
    let x = 12345;
    for (let i = 0; i < 300; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const mutated = await withByte(
        archive,
        x % archive.size,
        (b) => b ^ (1 + (x % 255)),
      );
      try {
        const entries = await readZipDirectory(mutated, BIG);
        for (const entry of entries)
          await checkZipEntry(mutated, entry).catch((e: unknown) => {
            expect(e).toBeInstanceOf(ProjectError);
          });
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectError);
      }
    }
  });
});
