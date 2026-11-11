/**
 * Opening a project (#12), off to the side: reads and validates the zip,
 * rebuilds each photo's file and regenerates its preview and thumbnail with
 * the usual decoder, and checks the whole thing can be restored. It never
 * touches the live stores, so any failure, or a Cancel, leaves the current
 * project exactly as it was. The caller swaps the result in (see
 * installProject in app.ts).
 */
import { EditorStore } from '../editor/store';
import type { EditorState } from '../editor/state';
import type { Decoder } from '../photos/decode';
import { PhotoStore, type NewPhoto } from '../photos/store';
import {
  MAX_PHOTO_BYTES,
  MAX_PROJECT_JSON_BYTES,
  parseProject,
  ProjectError,
  PROJECT_FILE,
  type ManifestPhoto,
} from './format';
import {
  checkZipEntry,
  readZipDirectory,
  readZipEntry,
  readZipText,
  type ZipEntry,
} from './zip';

/** A validated project, ready to be installed. */
export interface OpenedProject {
  /** Every photo in tray order, with its saved id and included flag. */
  readonly photos: readonly NewPhoto[];
  readonly state: EditorState;
}

export interface OpenProgress {
  /** Photos whose previews are made, out of `total`. */
  readonly done: number;
  readonly total: number;
}

export interface OpenOptions {
  readonly decode: Decoder;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OpenProgress) => void;
  /** Photos decoded at once. Default 2, as for imports. */
  readonly concurrency?: number;
  /** Lets the page paint between photos. */
  readonly yieldToMain?: () => Promise<void>;
}

const DEFAULT_CONCURRENCY = 2;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown problem';
}

/**
 * Opens `archive`. Throws a ProjectError (with a message for the user) if
 * anything is wrong with it, or an AbortError-like DOMException if the
 * signal aborts. The checks, in order: zip structure and limits; project.json
 * present, JSON, our format and a version we read; the collage and manifest
 * valid; every listed file present; every photo decodes to the size the
 * manifest says; and the result restores into a fresh editor.
 */
export async function openProject(
  archive: Blob,
  options: OpenOptions,
): Promise<OpenedProject> {
  const { decode, signal, onProgress } = options;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const yieldToMain =
    options.yieldToMain ??
    (() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }));

  const entries = await readZipDirectory(
    archive,
    Math.max(MAX_PROJECT_JSON_BYTES, MAX_PHOTO_BYTES),
  );
  const manifestEntry = entries.find((entry) => entry.path === PROJECT_FILE);
  if (!manifestEntry) {
    throw new ProjectError(
      'This zip has no project.json, so it is not a co-larger project.',
    );
  }
  if (manifestEntry.size > MAX_PROJECT_JSON_BYTES) {
    throw new ProjectError('project.json is too large.');
  }
  signal?.throwIfAborted();
  await checkZipEntry(archive, manifestEntry, signal);
  const project = parseProject(await readZipText(archive, manifestEntry));

  // Every listed file must exist (extra files in the zip are ignored).
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const files = new Map<string, File>();
  const entryOf = new Map<string, ZipEntry>();
  for (const photo of project.photos) {
    const entry = byPath.get(photo.path);
    if (!entry) {
      throw new ProjectError(
        `The photo "${photo.name}" is listed in the project but missing from the zip (${photo.path}).`,
      );
    }
    if (entry.size > MAX_PHOTO_BYTES) {
      throw new ProjectError(`The photo "${photo.name}" is too large.`);
    }
    if (entry.method !== 0) {
      throw new ProjectError(
        `The photo "${photo.name}" is stored compressed in this zip; co-larger stores photos as they are.`,
      );
    }
    // A stored entry is a slice of the archive: nothing is copied. The saved
    // name, type and modification time make the same fingerprint as the
    // original file, so dropping the original again is a duplicate.
    const data = await readZipEntry(archive, entry);
    entryOf.set(photo.id, entry);
    files.set(
      photo.id,
      new File([data], photo.name, {
        type: photo.type,
        lastModified: photo.lastModified,
      }),
    );
  }

  // Regenerate previews and thumbnails with bounded concurrency.
  const total = project.photos.length;
  const decoded: (NewPhoto | undefined)[] = new Array<NewPhoto | undefined>(
    total,
  ).fill(undefined);
  let next = 0;
  let done = 0;
  let failure: { readonly error: unknown } | undefined;
  onProgress?.({ done, total });
  const work = async (): Promise<void> => {
    while (failure === undefined) {
      signal?.throwIfAborted();
      const index = next++;
      const photo = project.photos[index];
      if (!photo) return;
      try {
        // Check the photo's CRC-32 first, streaming: a damaged entry
        // refuses the whole project before anything is replaced.
        await checkZipEntry(archive, entryOf.get(photo.id) as ZipEntry, signal);
        decoded[index] = await decodeOne(photo, files, decode);
      } catch (error) {
        failure ??= { error };
        return;
      }
      done++;
      onProgress?.({ done, total });
      await yieldToMain();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, work),
  );
  if (failure) throw failure.error as Error;
  signal?.throwIfAborted();

  const photos = decoded as NewPhoto[];
  verifyRestorable(photos, project.state);
  return { photos, state: project.state };
}

async function decodeOne(
  photo: ManifestPhoto,
  files: ReadonlyMap<string, File>,
  decode: Decoder,
): Promise<NewPhoto> {
  const file = files.get(photo.id) as File;
  let result;
  try {
    result = await decode(file);
  } catch (error) {
    throw new ProjectError(
      `Could not read the photo "${photo.name}": this browser cannot decode it (${describe(error)}).`,
    );
  }
  if (result.width !== photo.width || result.height !== photo.height) {
    throw new ProjectError(
      `The photo "${photo.name}" is ${String(result.width)} × ${String(result.height)} px but the project says ${String(photo.width)} × ${String(photo.height)} px.`,
    );
  }
  return {
    id: photo.id,
    included: photo.included,
    file,
    width: result.width,
    height: result.height,
    preview: result.preview,
    thumbnail: result.thumbnail,
  };
}

/**
 * A dry run of the swap on throwaway stores, so a project that cannot be
 * installed is refused before the live ones are touched.
 */
function verifyRestorable(
  photos: readonly NewPhoto[],
  state: EditorState,
): void {
  const store = new PhotoStore();
  const added = store.addPhotos(photos);
  if (added.length !== photos.length) {
    throw new ProjectError(
      'Two photos in this project have the same name, size and modification time.',
    );
  }
  try {
    new EditorStore({ photoStore: store }).restore(state);
  } catch (error) {
    throw new ProjectError(
      `This project cannot be restored: ${describe(error)}.`,
    );
  }
}
