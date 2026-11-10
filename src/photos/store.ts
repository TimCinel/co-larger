/**
 * The photo store: the list of imported photos and which of them are included
 * in the collage. Pure TypeScript with no DOM access, so it is unit-testable in
 * Node. The tray reads and subscribes to it; the editor (issue #5) builds its
 * own state on top of it, and undo/redo (issue #10) wraps the mutations below.
 */

/** A photo that has been imported and decoded. Instances are immutable. */
export interface Photo {
  /** Stable for the session. Never reused, even after other photos change. */
  readonly id: string;
  /**
   * The original file, untouched. Kept for full-resolution export (issue #11)
   * and for zipping the originals into a project (issue #12).
   */
  readonly file: File;
  /** Natural width in pixels, after EXIF orientation is applied. */
  readonly width: number;
  /** Natural height in pixels, after EXIF orientation is applied. */
  readonly height: number;
  /** `width / height`, as displayed (after EXIF orientation). */
  readonly aspect: number;
  /** Downscaled, correctly oriented image for the editor (JPEG). */
  readonly preview: Blob;
  /** Small, correctly oriented image for the tray (JPEG). */
  readonly thumbnail: Blob;
  /** Whether the photo is part of the collage. */
  readonly included: boolean;
}

/** What the importer hands to the store for each decoded photo. */
export interface NewPhoto {
  readonly file: File;
  readonly width: number;
  readonly height: number;
  readonly preview: Blob;
  readonly thumbnail: Blob;
}

/** What changed, so listeners can update only the affected photos. */
export type PhotoStoreChange =
  | { readonly kind: 'added'; readonly ids: readonly string[] }
  | { readonly kind: 'included'; readonly ids: readonly string[] };

export type PhotoStoreListener = (change: PhotoStoreChange) => void;

/** The shape `assignPhotos` in `src/layout` expects. */
export interface PlacementPhoto {
  readonly id: string;
  readonly aspect: number;
}

/**
 * How two imports of "the same file" are recognised: same name, size and
 * last-modified time. This is cheap (no reading of file contents), which
 * matters for 100+ large photos, and it matches what the browser reports when
 * the same file is picked or dropped twice. Two different photos that share all
 * three are vanishingly unlikely; a renamed or re-saved copy of the same photo
 * is treated as a different photo.
 */
export function fileFingerprint(file: File): string {
  return `${file.name}\u0000${String(file.size)}\u0000${String(file.lastModified)}`;
}

export class PhotoStore {
  private photos: readonly Photo[] = [];
  private readonly fingerprints = new Set<string>();
  private readonly listeners = new Set<PhotoStoreListener>();
  private nextId = 1;

  /** Every photo, in the order added. A new array after each change. */
  getPhotos(): readonly Photo[] {
    return this.photos;
  }

  getPhoto(id: string): Photo | undefined {
    return this.photos.find((photo) => photo.id === id);
  }

  /** Photos included in the collage, in the order added. */
  getIncludedPhotos(): readonly Photo[] {
    return this.photos.filter((photo) => photo.included);
  }

  /** Included photos in the form `assignPhotos` takes. */
  getPlacementPhotos(): PlacementPhoto[] {
    return this.getIncludedPhotos().map(({ id, aspect }) => ({ id, aspect }));
  }

  getSelectedCount(): number {
    return this.getIncludedPhotos().length;
  }

  getTotalCount(): number {
    return this.photos.length;
  }

  /** True if a file with the same fingerprint was already added. */
  hasFile(file: File): boolean {
    return this.fingerprints.has(fileFingerprint(file));
  }

  /**
   * Adds decoded photos, included by default. Photos whose file was already
   * added are skipped. Returns the photos actually added.
   */
  addPhotos(inputs: readonly NewPhoto[]): Photo[] {
    const added: Photo[] = [];
    for (const input of inputs) {
      const { file, width, height } = input;
      if (!(width > 0) || !(height > 0)) {
        throw new RangeError(
          `Photo dimensions must be positive, got ${String(width)}x${String(height)}`,
        );
      }
      const fingerprint = fileFingerprint(file);
      if (this.fingerprints.has(fingerprint)) continue;
      this.fingerprints.add(fingerprint);
      added.push({
        id: `photo-${String(this.nextId++)}`,
        file,
        width,
        height,
        aspect: width / height,
        preview: input.preview,
        thumbnail: input.thumbnail,
        included: true,
      });
    }
    if (added.length > 0) {
      this.photos = [...this.photos, ...added];
      this.notify({ kind: 'added', ids: added.map((photo) => photo.id) });
    }
    return added;
  }

  /** Includes or excludes one photo. Unknown ids and no-ops are ignored. */
  setIncluded(id: string, included: boolean): void {
    this.setIncludedWhere((photo) => photo.id === id, included);
  }

  /** Includes or excludes every photo ("Add all" / "Remove all"). */
  setAllIncluded(included: boolean): void {
    this.setIncludedWhere(() => true, included);
  }

  /** Calls `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: PhotoStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setIncludedWhere(
    matches: (photo: Photo) => boolean,
    included: boolean,
  ): void {
    const changed: string[] = [];
    this.photos = this.photos.map((photo) => {
      if (!matches(photo) || photo.included === included) return photo;
      changed.push(photo.id);
      return { ...photo, included };
    });
    if (changed.length > 0) this.notify({ kind: 'included', ids: changed });
  }

  private notify(change: PhotoStoreChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
