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
  /**
   * Restores a photo under a known id (for loading a saved project). Must not
   * clash with an existing photo. Omit to have the store mint one.
   */
  readonly id?: string;
  /** Initial included flag. Defaults to true. */
  readonly included?: boolean;
  readonly file: File;
  readonly width: number;
  readonly height: number;
  readonly preview: Blob;
  readonly thumbnail: Blob;
}

/** What changed, so listeners can update only the affected photos. */
export type PhotoStoreChange =
  | { readonly kind: 'added'; readonly ids: readonly string[] }
  | { readonly kind: 'included'; readonly ids: readonly string[] }
  | { readonly kind: 'removed'; readonly ids: readonly string[] };

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
  private readonly onListenerError: (error: unknown) => void;
  private nextId = 1;

  /**
   * @param onListenerError Called with anything a listener throws. A throwing
   *   listener never stops the store, the other listeners or the importer.
   */
  constructor(
    options: { readonly onListenerError?: (error: unknown) => void } = {},
  ) {
    this.onListenerError =
      options.onListenerError ??
      ((error) => {
        console.error('Photo store listener failed', error);
      });
  }

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

  /** Ids of included photos: the snapshot undo needs to restore a selection. */
  getIncludedIds(): string[] {
    return this.getIncludedPhotos().map((photo) => photo.id);
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
   * Adds decoded photos, included by default unless `included` says otherwise.
   * Photos whose file was already added are skipped. Returns the photos
   * actually added.
   *
   * The call is atomic: every input is validated first, so if one is invalid
   * (non-positive size, clashing id) it throws and nothing is added or marked
   * as seen.
   */
  addPhotos(inputs: readonly NewPhoto[]): Photo[] {
    const seen = new Set(this.fingerprints);
    const ids = new Set(this.photos.map((photo) => photo.id));
    const accepted: { input: NewPhoto; fingerprint: string }[] = [];
    for (const input of inputs) {
      const { file, width, height } = input;
      if (!(width > 0) || !(height > 0)) {
        throw new RangeError(
          `Photo dimensions must be positive, got ${String(width)}x${String(height)}`,
        );
      }
      const fingerprint = fileFingerprint(file);
      if (seen.has(fingerprint)) continue;
      if (input.id !== undefined) {
        if (input.id === '' || ids.has(input.id)) {
          throw new RangeError(`Invalid or duplicate photo id "${input.id}"`);
        }
        ids.add(input.id);
      }
      seen.add(fingerprint);
      accepted.push({ input, fingerprint });
    }

    // Everything is valid: mutate.
    const added: Photo[] = accepted.map(({ input }) => {
      const id = input.id ?? this.mintId(ids);
      ids.add(id);
      return {
        id,
        file: input.file,
        width: input.width,
        height: input.height,
        aspect: input.width / input.height,
        preview: input.preview,
        thumbnail: input.thumbnail,
        included: input.included ?? true,
      };
    });
    for (const { fingerprint } of accepted) this.fingerprints.add(fingerprint);
    if (added.length > 0) {
      this.photos = [...this.photos, ...added];
      this.notify({ kind: 'added', ids: added.map((photo) => photo.id) });
    }
    return added;
  }

  /**
   * Includes or excludes one photo or a set of them, with a single change
   * notification however many actually change. Unknown ids and no-ops are
   * ignored.
   */
  setIncluded(ids: string | Iterable<string>, included: boolean): void {
    const wanted = new Set(typeof ids === 'string' ? [ids] : ids);
    this.setIncludedWhere((photo) => wanted.has(photo.id), included);
  }

  /**
   * Includes exactly the photos in `ids` and excludes every other, with a
   * single change notification (for restoring an undo step or a saved
   * project). Unknown ids are ignored; check them first if that matters.
   */
  setIncludedIds(ids: Iterable<string>): void {
    const wanted = new Set(ids);
    const changed: string[] = [];
    this.photos = this.photos.map((photo) => {
      const included = wanted.has(photo.id);
      if (photo.included === included) return photo;
      changed.push(photo.id);
      return { ...photo, included };
    });
    if (changed.length > 0) this.notify({ kind: 'included', ids: changed });
  }

  /** Includes or excludes every photo ("Add all" / "Remove all"). */
  setAllIncluded(included: boolean): void {
    this.setIncludedWhere(() => true, included);
  }

  /**
   * Removes photos. Their files may be added again afterwards. Unknown ids are
   * ignored. Views must release anything they hold for the removed photos
   * (for example object URLs) when they see the `removed` change.
   */
  removePhotos(ids: Iterable<string>): void {
    const doomed = new Set(ids);
    const removed = this.photos.filter((photo) => doomed.has(photo.id));
    if (removed.length === 0) return;
    for (const photo of removed) {
      this.fingerprints.delete(fileFingerprint(photo.file));
    }
    this.photos = this.photos.filter((photo) => !doomed.has(photo.id));
    this.notify({ kind: 'removed', ids: removed.map((photo) => photo.id) });
  }

  /**
   * Points photos at new `File`s with the same content (after a project was
   * saved to a file, the photos read from that file). Silent: nothing about
   * a photo's identity, size, order or flags changes, so no listener has
   * anything to do. Unknown ids are ignored.
   */
  rebindFiles(files: ReadonlyMap<string, File>): void {
    this.photos = this.photos.map((photo) => {
      const file = files.get(photo.id);
      return file ? { ...photo, file } : photo;
    });
  }

  /** Removes every photo (for example before loading a project). */
  clear(): void {
    this.removePhotos(this.photos.map((photo) => photo.id));
  }

  /** Calls `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: PhotoStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A fresh `photo-N` id that is not in `taken`. */
  private mintId(taken: ReadonlySet<string>): string {
    let id = `photo-${String(this.nextId++)}`;
    while (taken.has(id)) id = `photo-${String(this.nextId++)}`;
    return id;
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
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // The error handler itself failed; nothing more to do.
        }
      }
    }
  }
}
