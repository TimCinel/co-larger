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
import { createZipStream, MAX_ARCHIVE_BYTES, type ZipSource } from './zip';

/** The default name of a saved project. */
export const PROJECT_FILE_NAME = 'collage-project.colarger.zip';

/** Room for the zip's own headers and directory. */
const OVERHEAD_PER_FILE = 200;

export interface SavePlan {
  /** The sources, `project.json` first. */
  readonly sources: readonly ZipSource[];
  /** Total bytes of the sources, for progress. */
  readonly totalBytes: number;
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
  photos.forEach((photo, index) => {
    if (photo.file.size > MAX_PHOTO_BYTES) {
      throw new ProjectError(
        `"${photo.file.name}" is too large to save in a project (over 1 GB).`,
      );
    }
    sources.push({
      path: (project.photos[index] as { path: string }).path,
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
  return { sources, totalBytes };
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
