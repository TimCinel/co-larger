/**
 * The project file format (#12), pure TypeScript with no DOM: building and
 * parsing `project.json`, and the paths of the photos inside the zip. See
 * docs/project-format.md.
 *
 * Everything read from a file is untrusted: parseProject checks every field
 * and returns freshly built values, never the parsed objects themselves.
 */
import { validateEditorState, type EditorState } from '../editor/state';
import { withinPlannerShape } from '../layout';

/** Marks a project.json as ours. */
export const FORMAT_ID = 'co-larger-project';

/**
 * The highest format version this build reads. Bump it for a change an
 * older build could not read; a build refuses any higher version.
 *
 * - 1: since the first release (2026.11.0).
 * - 2 (#16): a plan resized by hand with a tile beyond the planner's aspect
 *   limit (planAspectLimit: max(2.5, canvas aspect / tile count)), which
 *   2026.11.0 would refuse as "squashed". Written exactly when 2026.11.0
 *   would refuse the plan (see versionFor); everything else is still written
 *   as version 1, so that 2026.11.0 opens it. The same rule covers a Grid
 *   (#20), whose cells can be beyond that limit (one column on a wide
 *   canvas): such a grid is version 2, any other grid version 1.
 *
 * Grids (#20) added only optional fields (`layout`, `columns`, and `kind` in
 * the plan), which 2026.11.0 ignores: it opens a version 1 grid project
 * showing the saved cells (exactly at no border; with a border its older
 * cut rule makes a row's cells differ by up to a gap's width), as a mosaic
 * state, so its next re-roll makes a mosaic. See docs/project-format.md.
 */
export const FORMAT_VERSION = 2;

/**
 * The version written for `state`: 1 when release 2026.11.0 would accept
 * its plan (withinPlannerShape is its exact tile check), else 2. Hand
 * resizing (#16) and grids with stretched cells (#20) make plans it would
 * refuse.
 */
export function versionFor(state: EditorState): number {
  return withinPlannerShape(state.plan) ? 1 : 2;
}

/** The manifest's path inside the zip. */
export const PROJECT_FILE = 'project.json';

/** Where photos live inside the zip. */
export const PHOTO_DIR = 'photos/';

/** Largest project.json this build will read, in bytes. */
export const MAX_PROJECT_JSON_BYTES = 32 * 1024 * 1024;
/** Most photos in a project. */
export const MAX_PHOTOS = 5000;
/** Largest single photo in a project, in bytes. */
export const MAX_PHOTO_BYTES = 1024 * 1024 * 1024;
/**
 * Most bytes of photos inflated from DEFLATE entries that opening may hold in
 * memory at once (512 MiB). Stored photos are slices of the zip and cost
 * nothing; a deflated photo has to be a real in-memory copy until the project
 * is saved again. 512 MiB is room for about a hundred 5 MB phone photos and
 * stays well under what a desktop tab can hold (a tab holds this, plus
 * previews, plus the decoder's working memory), while it refuses a project
 * that would otherwise take the tab down. The check is on declared sizes,
 * before anything is inflated, and inflation never produces more than the
 * declaration, so the bound is exact.
 */
export const MAX_INFLATED_BYTES = 512 * 1024 * 1024;
/** Longest path or file name we accept, in characters. */
export const MAX_PATH_LENGTH = 255;

/** Why a project could not be saved or opened. The message is for the user. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** One photo as the manifest describes it. */
export interface ManifestPhoto {
  readonly id: string;
  /** Where the original file is inside the zip, for example `photos/photo-1-beach.jpg`. */
  readonly path: string;
  /** The original file name. */
  readonly name: string;
  /** The original MIME type, or an empty string. */
  readonly type: string;
  /** Whether the photo is in the collage; false means it waits in the tray. */
  readonly included: boolean;
  /** Pixels, after EXIF orientation. */
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  /** The file's last-modified time in ms since the epoch. */
  readonly lastModified: number;
}

/** The whole of `project.json`. */
export interface ProjectFile {
  readonly format: typeof FORMAT_ID;
  readonly version: number;
  readonly state: EditorState;
  /** Every photo, in tray order, included or not. */
  readonly photos: readonly ManifestPhoto[];
}

/** What `buildProject` needs to know about one photo. */
export interface PhotoSource {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly lastModified: number;
}

const SAFE_CHARS = /[^A-Za-z0-9._-]+/g;
const MAX_STEM = 80;

/**
 * Makes `text` safe as one path segment: only letters, digits, dot, dash and
 * underscore, no leading dot, at most 80 characters, never empty. The real
 * file name is kept in the manifest; this is only for the zip.
 */
export function sanitiseName(text: string, fallback = 'photo'): string {
  const cleaned = text
    .replace(SAFE_CHARS, '_')
    .replace(/^[._-]+/, '')
    .replace(/\.{2,}/g, '.');
  if (cleaned.length <= MAX_STEM) return cleaned || fallback;
  // Keep a short extension when cutting.
  const dot = cleaned.lastIndexOf('.');
  const extension =
    dot > 0 && cleaned.length - dot <= 8 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_STEM - extension.length) + extension;
}

/**
 * One path per photo, in order: `photos/<id>-<name>`, both sanitised, made
 * unique (ignoring case, because some systems unzip onto case-insensitive
 * disks) by a numeric suffix before the extension when two photos clash.
 */
export function photoPaths(
  photos: readonly { readonly id: string; readonly name: string }[],
): string[] {
  const taken = new Set<string>();
  return photos.map((photo) => {
    const base = `${sanitiseName(photo.id, 'id')}-${sanitiseName(photo.name)}`;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    let path = `${PHOTO_DIR}${base}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) {
      path = `${PHOTO_DIR}${stem}~${String(n)}${extension}`;
    }
    taken.add(path.toLowerCase());
    return path;
  });
}

/**
 * Whether `path` is a plain relative path that stays inside the archive:
 * not empty, not absolute, no backslashes, drive letters, control
 * characters, empty, `.` or `..` segments.
 */
export function isSafePath(path: string): boolean {
  if (path === '' || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const body = path.endsWith('/') ? path.slice(0, -1) : path;
  return body
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The manifest for `state` and `photos` (every photo in the store, in tray
 * order). A photo is included exactly when the collage uses it, so the
 * manifest and the snapshot always agree. Throws a ProjectError if the
 * collage names a photo that is not in `photos`.
 */
export function buildProject(
  state: EditorState,
  photos: readonly PhotoSource[],
): ProjectFile {
  const used = new Set(state.photos.map((photo) => photo.id));
  const known = new Set(photos.map((photo) => photo.id));
  for (const id of used) {
    if (!known.has(id)) {
      throw new ProjectError(`The collage uses a photo that is missing: ${id}`);
    }
  }
  const paths = photoPaths(photos);
  return {
    format: FORMAT_ID,
    version: versionFor(state),
    state,
    photos: photos.map((photo, index) => ({
      id: photo.id,
      path: paths[index] as string,
      name: photo.name,
      type: photo.type,
      included: used.has(photo.id),
      width: photo.width,
      height: photo.height,
      aspect: photo.aspect,
      lastModified: photo.lastModified,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ProjectError(message);
}

function checkManifestPhoto(value: unknown, index: number): ManifestPhoto {
  const where = `photo ${String(index + 1)}`;
  if (!isRecord(value)) return fail(`The project's ${where} is malformed.`);
  const { id, path, name, type, included, width, height, aspect } = value;
  const { lastModified } = value;
  if (typeof id !== 'string' || id === '') {
    return fail(`The project's ${where} has no id.`);
  }
  if (typeof name !== 'string' || name === '' || name.length > 1024) {
    return fail(`The project's ${where} has no valid file name.`);
  }
  const label = `"${name}"`;
  if (typeof path !== 'string' || !isSafePath(path) || path.endsWith('/')) {
    return fail(
      `The project names an unsafe file path for the photo ${label}.`,
    );
  }
  if (!path.startsWith(PHOTO_DIR)) {
    return fail(`The photo ${label} is stored outside ${PHOTO_DIR}.`);
  }
  if (
    typeof type !== 'string' ||
    (type !== '' && !/^[\w.+-]+\/[\w.+-]+$/.test(type))
  ) {
    return fail(`The photo ${label} has an invalid type.`);
  }
  if (typeof included !== 'boolean') {
    return fail(`The photo ${label} does not say whether it is included.`);
  }
  for (const side of [width, height]) {
    if (
      typeof side !== 'number' ||
      !Number.isInteger(side) ||
      side < 1 ||
      side > 1_000_000
    ) {
      return fail(`The photo ${label} has an invalid size.`);
    }
  }
  if (
    typeof aspect !== 'number' ||
    Math.abs(aspect / ((width as number) / (height as number)) - 1) > 1e-9
  ) {
    return fail(
      `The photo ${label} has an aspect ratio that does not match its size.`,
    );
  }
  if (
    typeof lastModified !== 'number' ||
    !Number.isSafeInteger(lastModified) ||
    lastModified < 0
  ) {
    return fail(`The photo ${label} has an invalid modification time.`);
  }
  return {
    id,
    path,
    name,
    type,
    included,
    width: width as number,
    height: height as number,
    aspect,
    lastModified,
  };
}

/**
 * Parses and validates the text of a `project.json`. Throws a ProjectError
 * with a message for the user for anything wrong: not JSON, not our format,
 * a newer version, a bad manifest, or a collage that fails
 * validateEditorState. The returned value shares nothing with the parsed
 * JSON.
 */
export function parseProject(text: string): ProjectFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('project.json is not valid JSON.');
  }
  if (!isRecord(json) || json.format !== FORMAT_ID) {
    return fail(
      'This is not a co-larger project: project.json has the wrong format.',
    );
  }
  const { version } = json;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return fail('This project has an invalid format version.');
  }
  if (version > FORMAT_VERSION) {
    return fail(
      `This project was saved by a newer version of co-larger (format version ${String(version)}; this one reads up to ${String(FORMAT_VERSION)}). Update co-larger to open it.`,
    );
  }
  if (!Array.isArray(json.photos))
    return fail('The project has no photo list.');
  if (json.photos.length > MAX_PHOTOS) {
    return fail(
      `The project has ${String(json.photos.length)} photos; the limit is ${String(MAX_PHOTOS)}.`,
    );
  }
  const photos = (json.photos as unknown[]).map(checkManifestPhoto);

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const photo of photos) {
    if (ids.has(photo.id))
      return fail(`Two photos share the id "${photo.id}".`);
    ids.add(photo.id);
    const key = photo.path.toLowerCase();
    if (paths.has(key)) {
      return fail(`Two photos share the file path "${photo.path}".`);
    }
    paths.add(key);
  }

  let state: EditorState;
  try {
    state = validateEditorState(json.state, { photoIds: ids });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown problem';
    return fail(`The collage in this project is not valid: ${reason}.`);
  }

  // The tray's ticks and the collage must agree, and on each photo's shape.
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const inCollage = new Set<string>();
  for (const { id, aspect } of state.photos) {
    const photo = byId.get(id);
    if (!photo?.included) {
      return fail(
        `The collage uses the photo "${id}", which the project lists as excluded.`,
      );
    }
    if (Math.abs(aspect / photo.aspect - 1) > 1e-9) {
      return fail(
        `The collage and the photo list disagree about the shape of "${photo.name}".`,
      );
    }
    inCollage.add(id);
  }
  for (const photo of photos) {
    if (photo.included && !inCollage.has(photo.id)) {
      return fail(
        `The photo "${photo.name}" is marked included but the collage does not use it.`,
      );
    }
  }
  return { format: FORMAT_ID, version, state, photos };
}

/** The text of `project.json` for `project`. */
export function serialiseProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 1);
}

const ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
]);

/** Whether a dropped or picked file looks like a zip, by name or type. */
export function looksLikeZip(file: { name: string; type: string }): boolean {
  return ZIP_TYPES.has(file.type) || /\.zip$/i.test(file.name);
}

/**
 * What to do with a drop: a single zip on its own is a project to open;
 * anything else is photos, with any zips set aside to be reported.
 */
export function classifyDrop<T extends { name: string; type: string }>(
  files: readonly T[],
): { project: T | null; photos: T[]; ignoredZips: T[] } {
  const zips = files.filter(looksLikeZip);
  const first = files[0];
  if (files.length === 1 && first && zips.length === 1) {
    return { project: first, photos: [], ignoredZips: [] };
  }
  return {
    project: null,
    photos: files.filter((file) => !looksLikeZip(file)),
    ignoredZips: zips,
  };
}
