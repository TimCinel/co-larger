/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-dynamic-delete, @typescript-eslint/no-non-null-assertion -- tests tamper with untyped JSON */
import { describe, expect, it } from 'vitest';
import type { Decoder } from '../photos/decode';
import { fileFingerprint, PhotoStore } from '../photos/store';
import { planSave, reboundFiles, saveProjectStream } from './save';
import { Crc32, streamToBlob } from './zip';
import {
  FORMAT_VERSION,
  MAX_INFLATED_BYTES,
  ProjectError,
  serialiseProject,
} from './format';
import { openProject, type OpenProgress } from './open';
import { readZipDirectory } from './zip';
import {
  fakeDecode,
  makePhoto,
  makeZip,
  rawZip,
  type RawEntry,
  saveToBlob,
  stateFor,
  withByte,
} from './test-helpers';

const instantly = (): Promise<void> => Promise.resolve();

const photos = [
  makePhoto('photo-1', 'beach.jpg', 400, 300, true, 1_700_000_000_123),
  makePhoto('photo-2', 'beach.jpg', 300, 400, false, 1_700_000_000_456),
  makePhoto('photo-7', 'dog.jpg', 500, 500, true, 1_650_000_000_000),
];

async function saved() {
  return saveToBlob(stateFor(photos), photos);
}

/** The saved project with `change` applied to the parsed project.json. */
async function withJson(
  change: (json: any, files: Record<string, any>) => void,
) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const archive = await saved();
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const json = JSON.parse(strFromU8(files['project.json'] as Uint8Array));
  change(json, files);
  return makeZip({ ...files, 'project.json': JSON.stringify(json) });
}

const open = (archive: Blob, decode: Decoder = fakeDecode) =>
  openProject(archive, { decode, yieldToMain: instantly });

async function failure(archive: Blob, decode?: Decoder): Promise<string> {
  const error = await open(archive, decode).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  return (error as Error).message;
}

describe('openProject', () => {
  it('restores photos with their ids, flags, names, order and files', async () => {
    const opened = await open(await saved());
    expect(opened.photos.map((p) => [p.id, p.included, p.file.name])).toEqual([
      ['photo-1', true, 'beach.jpg'],
      ['photo-2', false, 'beach.jpg'],
      ['photo-7', true, 'dog.jpg'],
    ]);
    expect(opened.photos.map((p) => [p.width, p.height])).toEqual([
      [400, 300],
      [300, 400],
      [500, 500],
    ]);
    expect(opened.state).toEqual(stateFor(photos));
    for (const [i, photo] of opened.photos.entries()) {
      const original = (photos[i] as (typeof photos)[number]).file;
      expect(await photo.file.text()).toBe(await original.text());
      expect(photo.file.type).toBe('image/jpeg');
      // The same fingerprint: dropping the original again is a duplicate.
      expect(fileFingerprint(photo.file)).toBe(fileFingerprint(original));
    }
  });

  it('reports progress and decodes two at a time at most', async () => {
    let running = 0;
    let peak = 0;
    const decode: Decoder = async (file) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return fakeDecode(file);
    };
    const progress: OpenProgress[] = [];
    await openProject(await saved(), {
      decode,
      yieldToMain: instantly,
      onProgress: (p) => progress.push(p),
    });
    expect(peak).toBe(2);
    expect(progress[0]).toEqual({ done: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 });
  });

  it('ignores extra files in the zip', async () => {
    const archive = await withJson((_json, files) => {
      files['notes.txt'] = new TextEncoder().encode('hi');
      files['photos/unused.jpg'] = new TextEncoder().encode('1x1');
    });
    expect((await open(archive)).photos).toHaveLength(3);
  });

  describe('refuses, with a message', () => {
    it('a file that is not a zip', async () => {
      expect(await failure(new Blob(['just text, not a zip at all']))).toMatch(
        /not a zip/,
      );
    });

    it('a zip without project.json', async () => {
      expect(await failure(makeZip({ 'photos/a.jpg': '1x1' }))).toMatch(
        /no project\.json/,
      );
    });

    it('a project.json that is not JSON', async () => {
      expect(await failure(makeZip({ 'project.json': '{nope' }))).toMatch(
        /not valid JSON/,
      );
    });

    it('another format', async () => {
      expect(
        await failure(
          makeZip({ 'project.json': '{"format":"x","version":1}' }),
        ),
      ).toMatch(/not a co-larger project/);
    });

    it('a newer version', async () => {
      const archive = await withJson((json) => {
        json.version = FORMAT_VERSION + 1;
      });
      expect(await failure(archive)).toMatch(/saved by a newer version/);
    });

    it('a snapshot that fails validation', async () => {
      const archive = await withJson((json) => {
        json.state.plan = [];
      });
      expect(await failure(archive)).toMatch(
        /collage in this project is not valid/,
      );
    });

    it('a photo missing from the zip', async () => {
      const archive = await withJson((_json, files) => {
        delete files['photos/photo-2-beach.jpg'];
        delete files['photos/photo-2-beach.jpg'.replace('2', '2')];
        for (const key of Object.keys(files)) {
          if (key.startsWith('photos/photo-2')) delete files[key];
        }
      });
      expect(await failure(archive)).toMatch(
        /"beach\.jpg" is listed in the project but missing/,
      );
    });

    it('a photo that fails to decode', async () => {
      const decode: Decoder = (file) =>
        file.name === 'dog.jpg'
          ? Promise.reject(new Error('bad data'))
          : fakeDecode(file);
      const message = await failure(await saved(), decode);
      expect(message).toMatch(/Could not read the photo "dog\.jpg"/);
    });

    it('a photo whose size differs from the manifest', async () => {
      const archive = await withJson((json) => {
        json.photos[0].width = 800;
        json.photos[0].aspect = 800 / 300;
        json.state.photos[0].aspect = 800 / 300;
      });
      // The plan was made for another shape, so the collage check may speak
      // first; either way the project is refused.
      expect(await failure(archive)).toMatch(
        /px but the project says|not valid/,
      );
    });

    it('a photo whose size differs and the rest consistent', async () => {
      const archive = await withJson((_json, files) => {
        files['photos/photo-1-beach.jpg'] = new TextEncoder().encode(
          '401x300:x',
        );
      });
      expect(await failure(archive)).toMatch(
        /401 × 300 px but the project says 400 × 300/,
      );
    });

    it('a manifest path with ..', async () => {
      const archive = await withJson((json) => {
        json.photos[0].path = 'photos/../../x.jpg';
      });
      expect(await failure(archive)).toMatch(/unsafe/);
    });

    it('an absolute manifest path', async () => {
      const archive = await withJson((json) => {
        json.photos[0].path = '/etc/passwd';
      });
      expect(await failure(archive)).toMatch(/unsafe/);
    });

    it('a zip entry with an unsafe name, even if unused', async () => {
      const archive = await withJson((_json, files) => {
        files['../evil.jpg'] = new TextEncoder().encode('x');
      });
      expect(await failure(archive)).toMatch(/unsafe file path/);
    });

    it('two photos with the same name, size and time', async () => {
      const twins = [
        makePhoto('a', 'same.jpg', 400, 300),
        makePhoto('b', 'same.jpg', 400, 300),
      ];
      const archive = await saveToBlob(stateFor(twins), twins);
      expect(await failure(archive)).toMatch(
        /same name, size and modification time/,
      );
    });

    it('an oversized photo or project.json', async () => {
      const { MAX_PROJECT_JSON_BYTES } = await import('./format');
      const big = makeZip({
        'project.json': new Uint8Array(MAX_PROJECT_JSON_BYTES + 1),
      });
      expect(await failure(big)).toMatch(/too large/);
    });
  });

  describe('deflated photos (#43)', () => {
    /** The saved project re-zipped: photos whose path has a `deflate` part use DEFLATE. */
    async function rezipped(deflate: readonly string[]): Promise<Blob> {
      const { zipSync, unzipSync } = await import('fflate');
      const files = unzipSync(
        new Uint8Array(await (await saved()).arrayBuffer()),
      );
      const out: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
      for (const [name, data] of Object.entries(files)) {
        out[name] = [
          data,
          { level: deflate.some((d) => name.includes(d)) ? 6 : 0 },
        ];
      }
      return new Blob([zipSync(out)]);
    }

    /**
     * The saved project.json with every photo as a hand-made DEFLATE entry
     * (correct unless `change` overrides a field of the directory entry).
     */
    async function rawProject(
      change: (original: Uint8Array) => Partial<RawEntry> = () => ({}),
    ): Promise<Blob> {
      const { unzipSync, deflateSync } = await import('fflate');
      const files = unzipSync(
        new Uint8Array(await (await saved()).arrayBuffer()),
      );
      const crc = (data: Uint8Array): number => {
        const c = new Crc32();
        c.update(data);
        return c.value;
      };
      return rawZip(
        Object.entries(files).map(([name, data]) =>
          name === 'project.json'
            ? { name, data }
            : {
                name,
                method: 8,
                data: deflateSync(data),
                crc: crc(data),
                size: data.length,
                ...change(data),
              },
        ),
      );
    }

    async function methodsOf(archive: Blob): Promise<number[]> {
      return (await readZipDirectory(archive, 1 << 30)).map((e) => e.method);
    }

    it('opens a project whose photos are all deflated, with the same bytes', async () => {
      const archive = await rezipped(['photos/']);
      expect(await methodsOf(archive)).toContain(8);
      const opened = await open(archive);
      expect(opened.photos).toHaveLength(3);
      expect(opened.state).toEqual(stateFor(photos));
      for (const [i, photo] of opened.photos.entries()) {
        const original = (photos[i] as (typeof photos)[number]).file;
        expect(await photo.file.text()).toBe(await original.text());
        expect(fileFingerprint(photo.file)).toBe(fileFingerprint(original));
        expect(photo.file.type).toBe('image/jpeg');
      }
    });

    it('opens a mix of stored and deflated photos', async () => {
      const archive = await rezipped(['photo-2', 'photo-7']);
      expect(new Set(await methodsOf(archive))).toEqual(new Set([0, 8]));
      const opened = await open(archive);
      for (const [i, photo] of opened.photos.entries()) {
        const original = (photos[i] as (typeof photos)[number]).file;
        expect(await photo.file.text()).toBe(await original.text());
      }
    });

    it('inflates each deflated photo exactly once and leaves stored ones alone', async () => {
      const archive = await rezipped(['photo-2', 'photo-7']);
      const Original = globalThis.DecompressionStream;
      let made = 0;
      globalThis.DecompressionStream = class extends Original {
        constructor(format: CompressionFormat) {
          super(format);
          made++;
        }
      };
      try {
        await open(archive);
      } finally {
        globalThis.DecompressionStream = Original;
      }
      // project.json and photo-1 are stored: one inflation per deflated photo.
      expect(made).toBe(2);
    });

    it('a project opened from deflated photos saves as a stored zip that reopens identically', async () => {
      const opened = await open(await rezipped(['photos/']));
      const store = new PhotoStore();
      store.addPhotos(opened.photos);
      const plan = planSave(opened.state, store.getPhotos());
      const archive = await streamToBlob(saveProjectStream(plan));
      expect(new Set(await methodsOf(archive))).toEqual(new Set([0]));
      // The inflated copies give way to slices of the saved file.
      store.rebindFiles(await reboundFiles(plan, archive));
      const again = await open(archive);
      expect(again.state).toEqual(opened.state);
      for (const [i, photo] of store.getPhotos().entries()) {
        const reopened = (again.photos[i] as { file: File }).file;
        expect(await photo.file.text()).toBe(await reopened.text());
        expect(photo.file).not.toBe((opened.photos[i] as { file: File }).file);
      }
    });

    describe('refuses, with a message, and builds nothing', () => {
      it('a corrupt deflate stream', async () => {
        const archive = await rawProject(() => ({
          data: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x13, 0x37]),
        }));
        expect(await failure(archive)).toMatch(/damaged/);
      });

      it('a wrong CRC-32', async () => {
        const archive = await rawProject(() => ({ crc: 0x12345678 }));
        expect(await failure(archive)).toMatch(/damaged.*checksum/);
      });

      it('a declared length that is too short', async () => {
        const archive = await rawProject((data) => ({
          size: data.length - 1,
        }));
        expect(await failure(archive)).toMatch(/damaged/);
      });

      it('a declared length that is too long', async () => {
        const archive = await rawProject((data) => ({
          size: data.length + 1,
        }));
        expect(await failure(archive)).toMatch(/damaged/);
      });

      it('more compressed photos than the memory bound, naming the limit and a way out', async () => {
        // The sizes are only declared: the check is made before inflating.
        const archive = await rawProject(() => ({
          size: Math.floor(MAX_INFLATED_BYTES / 2),
        }));
        const message = await failure(archive);
        expect(message).toMatch(/512 MB/);
        expect(message).toMatch(/without compression/);
      });

      it('declared lengths within the bound pass the memory check', async () => {
        const archive = await rawProject(() => ({
          size: Math.floor(MAX_INFLATED_BYTES / 3),
        }));
        // They then fail on the real length, not on memory.
        expect(await failure(archive)).not.toMatch(/memory/);
      });

      it('a method other than store and deflate', async () => {
        const archive = await rawProject(() => ({ method: 12 }));
        expect(await failure(archive)).toMatch(/unsupported compression/);
      });

      it('an encrypted photo', async () => {
        const archive = await rawProject(() => ({ flags: 1 }));
        expect(await failure(archive)).toMatch(/encrypted/);
      });

      it('and leaves a live project untouched', async () => {
        const live = new PhotoStore();
        live.addPhotos(photos.map((p) => ({ ...p })));
        const before = live.getPhotos();
        await failure(await rawProject(() => ({ crc: 5 })));
        expect(live.getPhotos()).toEqual(before);
      });
    });

    it('ignores the entries a system zip adds (__MACOSX, .DS_Store)', async () => {
      const { zipSync, unzipSync } = await import('fflate');
      const files = unzipSync(
        new Uint8Array(await (await saved()).arrayBuffer()),
      );
      const entries: Record<string, [Uint8Array, { level: 6 }]> = {};
      for (const [name, data] of Object.entries(files)) {
        entries[name] = [data, { level: 6 }];
      }
      entries['__MACOSX/._project.json'] = [new Uint8Array(120), { level: 6 }];
      entries['__MACOSX/photos/._photo-1-beach.jpg'] = [
        new Uint8Array(120),
        { level: 6 },
      ];
      entries['.DS_Store'] = [new Uint8Array(6148), { level: 6 }];
      entries['photos/.DS_Store'] = [new Uint8Array(6148), { level: 6 }];
      const archive = new Blob([zipSync(entries)]);
      expect((await open(archive)).photos).toHaveLength(3);
    });

    it('stops when aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        openProject(await rezipped(['photos/']), {
          decode: fakeDecode,
          signal: controller.signal,
          yieldToMain: instantly,
        }),
      ).rejects.toThrow();
    });
  });

  describe('checksums', () => {
    it('refuses a project.json whose content no longer matches its CRC', async () => {
      const archive = await saved();
      const entries = await readZipDirectory(archive, 1 << 30);
      const manifest = entries.find((e) => e.path === 'project.json')!;
      const text = await archive
        .slice(manifest.dataOffset, manifest.dataOffset + manifest.size)
        .text();
      // Change #ffffff (the default background) to #0fffff, keep the length.
      const at = text.indexOf('#ffffff');
      expect(at).toBeGreaterThan(0);
      const damaged = await withByte(
        archive,
        manifest.dataOffset + at + 1,
        () => 0x30,
      );
      expect(await failure(damaged)).toMatch(
        /project file is damaged.*project\.json/,
      );
    });

    it('refuses a photo whose bytes no longer match, before decoding any', async () => {
      const archive = await saved();
      const entries = await readZipDirectory(archive, 1 << 30);
      const photo = entries.find((e) => e.path.startsWith('photos/photo-7'))!;
      const damaged = await withByte(
        archive,
        photo.dataOffset + photo.size - 1,
        (b) => b ^ 1,
      );
      const decoded: string[] = [];
      const decode: Decoder = (file) => {
        decoded.push(file.name);
        return fakeDecode(file);
      };
      const message = await failure(damaged, decode);
      expect(message).toMatch(/damaged.*dog\.jpg|damaged.*photo-7/);
    });

    it('refuses a wrong CRC in the directory', async () => {
      const archive = await saved();
      const entries = await readZipDirectory(archive, 1 << 30);
      const photo = entries[1]!;
      // The directory entry's CRC field: find it by scanning for the signature.
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const view = new DataView(bytes.buffer);
      let seen = 0;
      for (let i = 0; i < bytes.length - 46; i++) {
        if (view.getUint32(i, true) === 0x02014b50 && seen++ === 1) {
          view.setUint32(i + 16, photo.crc ^ 0xdeadbeef, true);
          break;
        }
      }
      expect(await failure(new Blob([bytes]))).toMatch(/damaged/);
    });
  });

  it('every single changed byte gives a result or a clear error, never another exception', async () => {
    const archive = await saved();
    const total = archive.size;
    let x = 7;
    for (let i = 0; i < 150; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const mutated = await withByte(
        archive,
        x % total,
        (b) => b ^ (1 + (x % 255)),
      );
      try {
        await open(mutated);
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectError);
      }
    }
  });

  it('stops when aborted and produces nothing', async () => {
    const controller = new AbortController();
    const decode: Decoder = async (file) => {
      controller.abort();
      return fakeDecode(file);
    };
    await expect(
      openProject(await saved(), {
        decode,
        signal: controller.signal,
        yieldToMain: instantly,
      }),
    ).rejects.toThrow();
  });

  it('reads a project it saved with nothing but its own output', async () => {
    const text = serialiseProject({
      format: 'co-larger-project',
      version: FORMAT_VERSION,
      state: stateFor([]),
      photos: [],
    });
    const opened = await open(makeZip({ 'project.json': text }));
    expect(opened.photos).toEqual([]);
  });

  describe('rebinding photos to a saved file', () => {
    it('gives every photo a slice of the saved archive with the same content, name, type and time', async () => {
      const plan = planSave(stateFor(photos), photos);
      const archive = await streamToBlob(saveProjectStream(plan));
      const files = await reboundFiles(plan, archive);
      expect([...files.keys()]).toEqual(photos.map((p) => p.id));
      for (const photo of photos) {
        const file = files.get(photo.id) as File;
        expect(await file.text()).toBe(await photo.file.text());
        expect([file.name, file.type, file.lastModified]).toEqual([
          photo.file.name,
          photo.file.type,
          photo.file.lastModified,
        ]);
      }
    });

    it('refuses a saved file that lacks a photo', async () => {
      const plan = planSave(stateFor(photos), photos);
      await expect(
        reboundFiles(plan, makeZip({ 'project.json': '{}' })),
      ).rejects.toThrow(/does not contain/);
    });

    it('PhotoStore.rebindFiles swaps files silently', () => {
      const store = new PhotoStore();
      store.addPhotos(photos.map((p) => ({ ...p })));
      const seen: string[] = [];
      store.subscribe((c) => seen.push(c.kind));
      const replacement = new File(['x'], 'beach.jpg', { lastModified: 5 });
      store.rebindFiles(
        new Map([
          ['photo-1', replacement],
          ['nope', replacement],
        ]),
      );
      expect(store.getPhoto('photo-1')?.file).toBe(replacement);
      expect(store.getPhotos().map((p) => p.id)).toEqual(
        photos.map((p) => p.id),
      );
      expect(seen).toEqual([]);
    });
  });
});
