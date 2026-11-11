/**
 * Saving a project (#12): the zip as a stream. `project.json` comes first,
 * then every photo's original file, byte for byte, stored without
 * recompression. Excluded photos are saved too, so the tray comes back
 * whole.
 */
import type { EditorState } from '../editor/state';
import type { Photo } from '../photos';
import {
  buildProject,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  ProjectError,
  PROJECT_FILE,
  serialiseProject,
} from './format';
import {
  createZipStream,
  MAX_ARCHIVE_BYTES,
  readZipDirectory,
  type ZipSource,
} from './zip';

/** The default name of a saved project. */
export const PROJECT_FILE_NAME = 'collage-project.colarger.zip';

/** Room for the zip's own headers and directory. */
const OVERHEAD_PER_FILE = 200;

export interface SavePlan {
  /** The sources, `project.json` first. */
  readonly sources: readonly ZipSource[];
  /** Total bytes of the sources, for progress. */
  readonly totalBytes: number;
  /** Each photo saved, with its path in the zip and the file it came from. */
  readonly photos: readonly { id: string; path: string; file: File }[];
}

/**
 * Plans the archive for `state` and `photos` (all the store's photos, in
 * tray order). Throws a ProjectError if the project cannot be saved: too
 * many photos, a photo too large to open again, or a total of 4 GB or more.
 */
export function planSave(
  state: EditorState,
  photos: readonly Photo[],
): SavePlan {
  if (photos.length > MAX_PHOTOS) {
    throw new ProjectError(
      `Projects can hold up to ${String(MAX_PHOTOS)} photos; this one has ${String(photos.length)}.`,
    );
  }
  const project = buildProject(
    state,
    photos.map((photo) => ({
      id: photo.id,
      name: photo.file.name,
      type: photo.file.type,
      width: photo.width,
      height: photo.height,
      aspect: photo.aspect,
      lastModified: photo.file.lastModified,
    })),
  );
  const json = new Blob([serialiseProject(project)], {
    type: 'application/json',
  });
  const sources: ZipSource[] = [
    { path: PROJECT_FILE, data: json, lastModified: Date.now() },
  ];
  let totalBytes = json.size;
  const saved: { id: string; path: string; file: File }[] = [];
  photos.forEach((photo, index) => {
    if (photo.file.size > MAX_PHOTO_BYTES) {
      throw new ProjectError(
        `"${photo.file.name}" is too large to save in a project (over 1 GB).`,
      );
    }
    const path = (project.photos[index] as { path: string }).path;
    saved.push({ id: photo.id, path, file: photo.file });
    sources.push({
      path,
      data: photo.file,
      lastModified: photo.file.lastModified,
    });
    totalBytes += photo.file.size;
  });
  if (totalBytes + OVERHEAD_PER_FILE * sources.length >= MAX_ARCHIVE_BYTES) {
    throw new ProjectError(
      'This project is too large to save as one zip (4 GB or more). Remove some photos and try again.',
    );
  }
  return { sources, totalBytes, photos: saved };
}

export interface SaveOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number, photosDone: number) => void;
}

/** The project's zip as a stream; reading it does the work. */
export function saveProjectStream(
  plan: SavePlan,
  options: SaveOptions = {},
): ReadableStream<Uint8Array> {
  return createZipStream(plan.sources, {
    signal: options.signal,
    // The first source is project.json, not a photo.
    onProgress: (bytes, entry) => {
      options.onProgress?.(bytes, Math.max(0, entry - 1));
    },
  });
}

/**
 * After a project is saved to a file, the photos should read from that file:
 * the file they were opened from may just have been replaced (saving over the
 * project you opened). Reads the saved archive's directory and returns, for
 * every saved photo, a File that is a slice of it (the entry's offset and
 * length from the directory, with the original name, type and time). Throws
 * if the saved file does not hold what was written.
 */
export async function reboundFiles(
  plan: SavePlan,
  saved: Blob,
): Promise<Map<string, File>> {
  const entries = await readZipDirectory(saved, MAX_PHOTO_BYTES);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const files = new Map<string, File>();
  for (const photo of plan.photos) {
    const entry = byPath.get(photo.path);
    if (entry?.method !== 0 || entry.size !== photo.file.size) {
      throw new ProjectError(
        `The saved file does not contain "${photo.file.name}" as expected.`,
      );
    }
    files.set(
      photo.id,
      new File(
        [saved.slice(entry.dataOffset, entry.dataOffset + entry.size)],
        photo.file.name,
        { type: photo.file.type, lastModified: photo.file.lastModified },
      ),
    );
  }
  return files;
}
