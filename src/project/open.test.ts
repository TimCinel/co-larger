/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-dynamic-delete -- tests tamper with untyped JSON */
import { describe, expect, it } from 'vitest';
import type { Decoder } from '../photos/decode';
import { fileFingerprint } from '../photos/store';
import { FORMAT_VERSION, ProjectError, serialiseProject } from './format';
import { openProject, type OpenProgress } from './open';
import {
  fakeDecode,
  makePhoto,
  makeZip,
  saveToBlob,
  stateFor,
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

    it('a photo stored compressed', async () => {
      const { zipSync, unzipSync, strFromU8 } = await import('fflate');
      const files = unzipSync(
        new Uint8Array(await (await saved()).arrayBuffer()),
      );
      const json = strFromU8(files['project.json'] as Uint8Array);
      const archive = new Blob([
        zipSync(
          { ...files, 'project.json': new TextEncoder().encode(json) },
          { level: 6 },
        ),
      ]);
      expect(await failure(archive)).toMatch(/stored compressed/);
    });
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
});
