/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- tests tamper with untyped JSON */
import { describe, expect, it } from 'vitest';
import { createEditorState } from '../editor/state';
import {
  buildProject,
  classifyDrop,
  FORMAT_ID,
  FORMAT_VERSION,
  isSafePath,
  looksLikeZip,
  MAX_PHOTOS,
  parseProject,
  photoPaths,
  ProjectError,
  sanitiseName,
  serialiseProject,
} from './format';
import { makePhoto, stateFor } from './test-helpers';

const photos = [
  makePhoto('photo-1', 'beach.jpg', 400, 300),
  makePhoto('photo-2', 'beach.jpg', 300, 400, false),
  makePhoto('photo-3', 'dog.jpg', 500, 500),
];

function sources(list = photos) {
  return list.map((photo) => ({
    id: photo.id,
    name: photo.file.name,
    type: photo.file.type,
    width: photo.width,
    height: photo.height,
    aspect: photo.aspect,
    lastModified: photo.file.lastModified,
  }));
}

const good = () => buildProject(stateFor(photos), sources());
const text = () => serialiseProject(good());

/** The project with `change` applied to its parsed JSON. */
function tampered(change: (json: any) => void): string {
  const json = JSON.parse(text());
  change(json);
  return JSON.stringify(json);
}

describe('sanitiseName', () => {
  it('keeps safe names and replaces everything else', () => {
    expect(sanitiseName('beach.jpg')).toBe('beach.jpg');
    expect(sanitiseName('my photo (1).JPG')).toBe('my_photo_1_.JPG');
    expect(sanitiseName('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitiseName('..')).toBe('photo');
    expect(sanitiseName('日本語.jpg')).toBe('jpg');
    expect(sanitiseName('')).toBe('photo');
  });

  it('shortens long names but keeps the extension', () => {
    const name = sanitiseName(`${'a'.repeat(300)}.jpeg`);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('.jpeg')).toBe(true);
  });
});

describe('photoPaths', () => {
  it('puts each photo under photos/ with its id', () => {
    expect(photoPaths([{ id: 'photo-1', name: 'beach.jpg' }])).toEqual([
      'photos/photo-1-beach.jpg',
    ]);
  });

  it('is unique even when names, ids and cases clash', () => {
    const paths = photoPaths([
      { id: 'a/b', name: 'x.jpg' },
      { id: 'a_b', name: 'x.jpg' },
      { id: 'A_B', name: 'X.JPG' },
      { id: 'a b', name: 'x.jpg' },
    ]);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(4);
    expect(paths.every((path) => isSafePath(path))).toBe(true);
    expect(
      paths.every((path) => path.endsWith('.jpg') || path.endsWith('.JPG')),
    ).toBe(true);
  });

  it('never escapes the folder, whatever the name', () => {
    for (const name of [
      '../x.jpg',
      '/abs.jpg',
      'a\\b.jpg',
      'C:evil.jpg',
      '..',
    ]) {
      const [path] = photoPaths([{ id: 'photo-1', name }]);
      expect(isSafePath(path as string)).toBe(true);
      expect(path?.startsWith('photos/')).toBe(true);
      expect(path?.slice('photos/'.length)).not.toMatch(/[/\\]/);
    }
  });
});

describe('isSafePath', () => {
  it('accepts plain relative paths', () => {
    for (const path of [
      'project.json',
      'photos/a.jpg',
      'a/b/c.txt',
      'photos/',
    ]) {
      expect(isSafePath(path), path).toBe(true);
    }
  });

  it('rejects absolute, parent, backslash, drive, empty and control paths', () => {
    for (const path of [
      '',
      '/etc/passwd',
      '../x',
      'a/../../x',
      'a/..',
      './a',
      'a//b',
      'a\\b',
      'C:/x',
      'c:x',
      'a\u0000b',
      'a\nb',
      'a'.repeat(300),
    ]) {
      expect(isSafePath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe('buildProject', () => {
  it('lists every photo in order, marking the ones the collage uses', () => {
    const project = good();
    expect(project.format).toBe(FORMAT_ID);
    // A collage not resized by hand is written as version 1 (#16), so the
    // first release (2026.11.0) still opens it.
    expect(project.version).toBe(1);
    expect(project.photos.map((p) => [p.id, p.included])).toEqual([
      ['photo-1', true],
      ['photo-2', false],
      ['photo-3', true],
    ]);
    expect(project.photos[0]).toMatchObject({
      name: 'beach.jpg',
      type: 'image/jpeg',
      width: 400,
      height: 300,
      lastModified: 1_700_000_000_000,
    });
    // Two photos named beach.jpg get different paths.
    expect(new Set(project.photos.map((p) => p.path)).size).toBe(3);
  });

  it('carries the whole snapshot, plan and assignment included', () => {
    const state = stateFor(photos);
    const json = JSON.parse(serialiseProject(buildProject(state, sources())));
    expect(json.state).toEqual(JSON.parse(JSON.stringify(state)));
    expect(json.state.plan).toBeDefined();
    expect(json.state.assignment).toHaveLength(2);
    expect(json.version).toBe(1);
  });

  it('refuses a collage that uses a photo the list lacks', () => {
    expect(() =>
      buildProject(stateFor(photos), sources(photos.slice(1))),
    ).toThrow(ProjectError);
  });
});

describe('parseProject', () => {
  it('round-trips the snapshot and the manifest exactly', () => {
    const state = stateFor(photos);
    const parsed = parseProject(
      serialiseProject(buildProject(state, sources())),
    );
    expect(parsed.state).toEqual(state);
    expect(parsed.photos).toEqual(good().photos);
  });

  it('returns values that share nothing with the input', () => {
    const a = parseProject(text());
    const b = parseProject(text());
    expect(a.state).not.toBe(b.state);
    expect(a.photos[0]).not.toBe(b.photos[0]);
  });

  const rejects: [string, () => string, RegExp][] = [
    ['text that is not JSON', () => 'not json {', /not valid JSON/],
    ['an array', () => '[]', /not a co-larger project/],
    [
      'another format',
      () => tampered((j) => (j.format = 'other')),
      /not a co-larger project/,
    ],
    [
      'a missing format',
      () => tampered((j) => delete j.format),
      /not a co-larger project/,
    ],
    [
      'a newer version',
      () => tampered((j) => (j.version = FORMAT_VERSION + 1)),
      /newer version of co-larger/,
    ],
    [
      'a far newer version',
      () => tampered((j) => (j.version = 99)),
      /newer version/,
    ],
    [
      'version 0',
      () => tampered((j) => (j.version = 0)),
      /invalid format version/,
    ],
    [
      'a fractional version',
      () => tampered((j) => (j.version = 1.5)),
      /invalid format version/,
    ],
    [
      'a string version',
      () => tampered((j) => (j.version = '1')),
      /invalid format version/,
    ],
    [
      'a missing version',
      () => tampered((j) => delete j.version),
      /invalid format version/,
    ],
    ['no photo list', () => tampered((j) => delete j.photos), /no photo list/],
    [
      'too many photos',
      () =>
        tampered(
          (j) => (j.photos = new Array<unknown>(MAX_PHOTOS + 1).fill({})),
        ),
      /limit/,
    ],
    [
      'a non-object photo',
      () => tampered((j) => (j.photos[0] = 5)),
      /malformed/,
    ],
    ['an empty id', () => tampered((j) => (j.photos[0].id = '')), /no id/],
    [
      'a repeated id',
      () => tampered((j) => (j.photos[1].id = 'photo-1')),
      /share the id/,
    ],
    [
      'a parent-directory path',
      () => tampered((j) => (j.photos[0].path = 'photos/../../x.jpg')),
      /unsafe/,
    ],
    [
      'an absolute path',
      () => tampered((j) => (j.photos[0].path = '/etc/passwd')),
      /unsafe/,
    ],
    [
      'a backslash path',
      () => tampered((j) => (j.photos[0].path = 'photos\\x.jpg')),
      /unsafe/,
    ],
    [
      'a path outside photos/',
      () => tampered((j) => (j.photos[0].path = 'project.json')),
      /outside/,
    ],
    [
      'a repeated path',
      () =>
        tampered(
          (j) =>
            (j.photos[1].path = String(j.photos[0].path).replace(
              'beach',
              'BEACH',
            )),
        ),
      /share the file path/,
    ],
    [
      'a bad included flag',
      () => tampered((j) => (j.photos[0].included = 'yes')),
      /included/,
    ],
    [
      'a bad size',
      () => tampered((j) => (j.photos[0].width = 0)),
      /invalid size/,
    ],
    [
      'a fractional size',
      () => tampered((j) => (j.photos[0].height = 1.5)),
      /invalid size/,
    ],
    [
      'an aspect that is not width over height',
      () => tampered((j) => (j.photos[0].aspect = 2)),
      /aspect ratio/,
    ],
    [
      'a bad time',
      () => tampered((j) => (j.photos[0].lastModified = -1)),
      /modification time/,
    ],
    [
      'a bad type',
      () => tampered((j) => (j.photos[0].type = 'x y')),
      /invalid type/,
    ],
    [
      'a missing snapshot',
      () => tampered((j) => delete j.state),
      /collage in this project is not valid/,
    ],
    [
      'a snapshot with a bad canvas',
      () => tampered((j) => (j.state.canvas.width = -5)),
      /collage in this project is not valid/,
    ],
    [
      'a snapshot with a tampered plan',
      () => tampered((j) => (j.state.plan = [])),
      /collage in this project is not valid/,
    ],
    [
      'a snapshot with a bad assignment',
      () => tampered((j) => (j.state.assignment = ['photo-1', 'photo-1'])),
      /collage in this project is not valid/,
    ],
    [
      'a crop for an unknown photo',
      () =>
        tampered(
          (j) => (j.state.crops = { nope: { x: 0.5, y: 0.5, zoom: 2 } }),
        ),
      /collage in this project is not valid/,
    ],
    [
      'a collage using an excluded photo',
      () => tampered((j) => (j.photos[0].included = false)),
      /excluded/,
    ],
    [
      'an included photo the collage does not use',
      () => tampered((j) => (j.photos[1].included = true)),
      /does not use it/,
    ],
    [
      'a collage and list that disagree on shape',
      () => tampered((j) => (j.state.photos[0].aspect = 0.5)),
      /not valid|disagree/,
    ],
  ];
  for (const [name, make, message] of rejects) {
    it(`rejects ${name}`, () => {
      let thrown: unknown;
      try {
        parseProject(make());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectError);
      expect((thrown as Error).message).toMatch(message);
    });
  }

  it('says so clearly for a newer version', () => {
    expect(() =>
      parseProject(tampered((j) => (j.version = FORMAT_VERSION + 1))),
    ).toThrow('This project was saved by a newer version of co-larger');
  });

  it('reads version 2 (#16) as well as version 1', () => {
    expect(FORMAT_VERSION).toBe(2);
    expect(parseProject(tampered((j) => (j.version = 2))).version).toBe(2);
    expect(parseProject(text()).version).toBe(1);
  });

  it('accepts an empty project', () => {
    const empty = serialiseProject({
      format: FORMAT_ID,
      version: FORMAT_VERSION,
      state: createEditorState({ seed: 1 }),
      photos: [],
    });
    expect(parseProject(empty).photos).toEqual([]);
  });

  it('ignores unknown extra fields', () => {
    const parsed = parseProject(tampered((j) => (j.future = { a: 1 })));
    expect('future' in parsed).toBe(false);
  });
});

describe('a hostile project.json', () => {
  it('prototype keys are not special', () => {
    const json = JSON.parse(text());
    const raw = JSON.stringify(json)
      .replace(
        '{"format"',
        '{"__proto__":{"polluted":1},"constructor":{"x":1},"format"',
      )
      .replace(
        '"crops":{}',
        '"crops":{"__proto__":{"x":1,"y":0.5,"zoom":2},"constructor":{"x":1,"y":0.5,"zoom":2}}',
      );
    let outcome: unknown;
    try {
      outcome = parseProject(raw);
    } catch (error) {
      outcome = error;
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(outcome instanceof ProjectError || typeof outcome === 'object').toBe(
      true,
    );
    if (!(outcome instanceof ProjectError)) {
      const parsed = outcome as ReturnType<typeof parseProject>;
      expect(Object.getPrototypeOf(parsed.state.crops)).toBe(null);
    }
  });

  it('an id named like a prototype key or with path characters is fine', () => {
    const odd = [
      makePhoto('__proto__', 'a.jpg', 400, 300),
      makePhoto('constructor', 'b.jpg', 300, 400),
      makePhoto('../x\\y/z', 'c.jpg', 500, 500),
    ];
    const parsed = parseProject(
      serialiseProject(buildProject(stateFor(odd), sources(odd))),
    );
    expect(parsed.photos.map((p) => p.id)).toEqual([
      '__proto__',
      'constructor',
      '../x\\y/z',
    ]);
    expect(parsed.photos.every((p) => isSafePath(p.path))).toBe(true);
  });

  it('enormous arrays are refused quickly', () => {
    const started = Date.now();
    for (const change of [
      (j: any) => (j.photos = new Array<unknown>(1_000_000).fill(null)),
      (j: any) => (j.state.assignment = new Array<number>(500_000).fill(0)),
      (j: any) =>
        (j.state.photos = new Array<unknown>(500_000).fill({
          id: 'a',
          aspect: 1,
        })),
    ]) {
      expect(() => parseProject(tampered(change))).toThrow(ProjectError);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('wrong types everywhere give a ProjectError, never another exception', () => {
    const weird: unknown[] = [
      null,
      [],
      {},
      'x',
      Number.POSITIVE_INFINITY,
      -1,
      true,
      0.5,
      '__proto__',
    ];
    const paths: string[][] = [
      ['format'],
      ['version'],
      ['state'],
      ['photos'],
      ['state', 'canvas'],
      ['state', 'plan'],
      ['state', 'assignment'],
      ['state', 'crops'],
      ['state', 'photos'],
      ['state', 'seed'],
      ['photos', '0'],
      ['photos', '0', 'id'],
      ['photos', '0', 'path'],
      ['photos', '0', 'name'],
      ['photos', '0', 'type'],
      ['photos', '0', 'included'],
      ['photos', '0', 'width'],
      ['photos', '0', 'aspect'],
      ['photos', '0', 'lastModified'],
    ];
    for (const path of paths) {
      for (const value of weird) {
        const raw = tampered((j) => {
          let at = j;
          for (const key of path.slice(0, -1)) at = at[key];
          at[path[path.length - 1] as string] = value;
        });
        try {
          parseProject(raw);
        } catch (error) {
          expect(error, `${path.join('.')} = ${String(value)}`).toBeInstanceOf(
            ProjectError,
          );
        }
      }
    }
  });

  it('the same file named twice, and ids that collide', () => {
    expect(() =>
      parseProject(tampered((j) => (j.photos[2].path = j.photos[0].path))),
    ).toThrow(/share the file path/);
    expect(() =>
      parseProject(tampered((j) => (j.photos[2].id = j.photos[0].id))),
    ).toThrow(/share the id/);
  });
});

describe('classifyDrop', () => {
  const zip = { name: 'trip.colarger.zip', type: 'application/zip' };
  const noType = { name: 'trip.ZIP', type: '' };
  const jpg = { name: 'a.jpg', type: 'image/jpeg' };

  it('treats a lone zip as a project', () => {
    expect(classifyDrop([zip]).project).toBe(zip);
    expect(classifyDrop([noType]).project).toBe(noType);
  });

  it('treats photos as photos', () => {
    expect(classifyDrop([jpg, jpg])).toEqual({
      project: null,
      photos: [jpg, jpg],
      ignoredZips: [],
    });
  });

  it('keeps the photos and sets zips aside when they are mixed or several', () => {
    expect(classifyDrop([zip, jpg])).toEqual({
      project: null,
      photos: [jpg],
      ignoredZips: [zip],
    });
    expect(classifyDrop([zip, noType])).toEqual({
      project: null,
      photos: [],
      ignoredZips: [zip, noType],
    });
  });

  it('recognises zips by name or type', () => {
    expect(
      looksLikeZip({ name: 'x.bin', type: 'application/x-zip-compressed' }),
    ).toBe(true);
    expect(looksLikeZip({ name: 'x.jpg', type: 'image/jpeg' })).toBe(false);
  });
});
