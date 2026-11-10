/**
 * A bounded cache of decoded images for drawing the collage on screen.
 *
 * Previews are stored as JPEG blobs and must be decoded before they can be
 * drawn; a decoded 1024 px preview takes about 3 MB, so 300 of them would
 * take about 900 MB. So:
 *
 * - Rendering never waits: `get` returns what is decoded now (or null, and
 *   the tile is drawn as a placeholder) and queues what is missing. Decoding
 *   runs in the background with bounded concurrency (createImageBitmap
 *   decodes off the main thread), and `onLoad` asks for a repaint.
 * - Small tiles use the 256 px thumbnail (about 0.2 MB decoded); only tiles
 *   that would show the thumbnail enlarged use the preview. Most tiles in a
 *   collage of 100+ photos are small, so most previews are never decoded.
 *   While a preview is loading, the thumbnail stands in for it.
 * - Decoded images are kept in least-recently-used order within a byte
 *   budget. Images drawn in the current frame are never evicted (what is on
 *   screen is bounded by the screen's pixels anyway), so the budget is soft
 *   only when the screen itself needs more.
 * - Images of photos that leave the store are released at once (`release`).
 */
import { fitLongSide, THUMBNAIL_LONG_SIDE } from '../photos/decode';
import type { Tile } from '../layout';
import { coverSource, type Crop } from './crop';
import type { DrawableImage } from './render';

/** What the cache needs to know about a photo. `Photo` from the store fits. */
export interface CachePhoto {
  /** Natural size, after EXIF orientation. */
  readonly width: number;
  readonly height: number;
  readonly preview: Blob;
  readonly thumbnail: Blob;
}

/** A decoded image. `ImageBitmap` fits. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface ImageCacheOptions<I extends DecodedImage> {
  /** Looks a photo up by id; undefined if it no longer exists. */
  readonly lookup: (id: string) => CachePhoto | undefined;
  /** Decodes a blob. Defaults to createImageBitmap. */
  readonly decode?: (blob: Blob) => Promise<I>;
  /** Called after each image finishes decoding, to schedule a repaint. */
  readonly onLoad?: () => void;
  /**
   * Called once per photo the first time any of its images fails to decode
   * (to tell the user). A failed thumbnail falls back to the preview; a
   * photo with neither is reported by `isFailed`.
   */
  readonly onError?: (photoId: string) => void;
  /** Byte budget for decoded images (width × height × 4). Default 256 MB. */
  readonly budgetBytes?: number;
  /** Decodes running at once. Default 4. */
  readonly concurrency?: number;
}

type Level = 'thumbnail' | 'preview';

interface Entry<I> {
  readonly id: string;
  readonly level: Level;
  image: I | null;
  status: 'queued' | 'loading' | 'ready' | 'failed';
  bytes: number;
  usedInFrame: number;
}

export const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * Thumbnail pixels per output pixel needed to use the thumbnail. Below this
 * the thumbnail would be visibly enlarged, so the preview is used.
 */
const THUMBNAIL_MIN_DENSITY = 1;

export class ImageCache<I extends DecodedImage = ImageBitmap> {
  private readonly entries = new Map<string, Entry<I>>();
  private readonly queue: string[] = [];
  private readonly lookup: (id: string) => CachePhoto | undefined;
  private readonly decode: (blob: Blob) => Promise<I>;
  private readonly onLoad: () => void;
  private readonly onError: (photoId: string) => void;
  private readonly reported = new Set<string>();
  private readonly budget: number;
  private readonly concurrency: number;
  private active = 0;
  private bytes = 0;
  private frame = 0;

  constructor(options: ImageCacheOptions<I>) {
    this.lookup = options.lookup;
    this.decode =
      options.decode ??
      ((blob) => createImageBitmap(blob) as unknown as Promise<I>);
    this.onLoad = options.onLoad ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /**
   * Starts a new frame: images fetched with `get` from now on count as on
   * screen and are not evicted until the next frame starts.
   */
  nextFrame(): void {
    this.frame++;
  }

  /**
   * The best decoded image of `photoId` for `tile` (in output pixels) with
   * `crop`, or null if none is decoded yet. Queues whatever is missing.
   */
  get(photoId: string, tile: Tile, crop?: Crop): DrawableImage | null {
    const photo = this.lookup(photoId);
    if (!photo) return null;
    const preview = this.use(photoId, 'preview');
    if (preview) return preview;
    const thumbnail = this.use(photoId, 'thumbnail');
    if (
      this.statusOf(photoId, 'thumbnail') === 'failed' ||
      !this.thumbnailSuffices(photo, tile, crop)
    ) {
      this.request(photoId, 'preview');
    }
    if (!thumbnail) this.request(photoId, 'thumbnail');
    return thumbnail;
  }

  /** True when no image of the photo can be decoded (draw an error). */
  isFailed(photoId: string): boolean {
    return (
      this.statusOf(photoId, 'thumbnail') === 'failed' &&
      this.statusOf(photoId, 'preview') === 'failed'
    );
  }

  private statusOf(id: string, level: Level): Entry<I>['status'] | undefined {
    return this.entries.get(keyOf(id, level))?.status;
  }

  /** Queues the thumbnails of `ids` (decoded in the background). */
  prefetch(ids: Iterable<string>): void {
    for (const id of ids) this.request(id, 'thumbnail');
  }

  /** Frees every image of these photos and drops any queued decodes. */
  release(ids: Iterable<string>): void {
    for (const id of ids) {
      this.reported.delete(id);
      for (const level of ['thumbnail', 'preview'] as const) {
        const key = keyOf(id, level);
        const entry = this.entries.get(key);
        if (!entry) continue;
        this.drop(key, entry);
      }
    }
  }

  /** Frees everything. */
  clear(): void {
    for (const [key, entry] of [...this.entries]) this.drop(key, entry);
  }

  /** For tests and diagnostics. */
  stats(): { bytes: number; images: number; queued: number; loading: number } {
    let images = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'ready') images++;
    }
    return {
      bytes: this.bytes,
      images,
      queued: this.queue.length,
      loading: this.active,
    };
  }

  private thumbnailSuffices(
    photo: CachePhoto,
    tile: Tile,
    crop: Crop | undefined,
  ): boolean {
    const thumb = fitLongSide(photo.width, photo.height, THUMBNAIL_LONG_SIDE);
    const source = coverSource(
      thumb.width,
      thumb.height,
      tile.width,
      tile.height,
      crop,
    );
    return (
      source !== null && source.sw >= tile.width * THUMBNAIL_MIN_DENSITY - 0.5
    );
  }

  /** The ready image at `level`, marked as used in this frame, or null. */
  private use(id: string, level: Level): DrawableImage | null {
    const key = keyOf(id, level);
    const entry = this.entries.get(key);
    if (entry?.status !== 'ready' || !entry.image) return null;
    entry.usedInFrame = this.frame;
    // Most recently used goes to the end of the map's order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    const { image } = entry;
    return {
      image: image as unknown as CanvasImageSource,
      width: image.width,
      height: image.height,
    };
  }

  private request(id: string, level: Level): void {
    const key = keyOf(id, level);
    if (this.entries.has(key)) return;
    this.entries.set(key, {
      id,
      level,
      image: null,
      status: 'queued',
      bytes: 0,
      usedInFrame: this.frame,
    });
    this.queue.push(key);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift() as string;
      const entry = this.entries.get(key);
      if (entry?.status !== 'queued') continue;
      const photo = this.lookup(entry.id);
      if (!photo) {
        this.entries.delete(key);
        continue;
      }
      entry.status = 'loading';
      this.active++;
      const blob = entry.level === 'preview' ? photo.preview : photo.thumbnail;
      this.decode(blob).then(
        (image) => {
          this.active--;
          this.loaded(key, entry, image);
        },
        (error: unknown) => {
          this.active--;
          // Still in the cache: remember the failure so it is not retried
          // every frame. The tile keeps its placeholder.
          if (this.entries.get(key) === entry) {
            entry.status = 'failed';
            console.warn(
              `Could not decode ${entry.level} of ${entry.id}`,
              error,
            );
            if (!this.reported.has(entry.id)) {
              this.reported.add(entry.id);
              this.onError(entry.id);
            }
            // Repaint: the tile may now fall back or show the error.
            this.onLoad();
          }
          this.pump();
        },
      );
    }
  }

  private loaded(key: string, entry: Entry<I>, image: I): void {
    if (this.entries.get(key) !== entry) {
      // Released while decoding.
      image.close();
      this.pump();
      return;
    }
    entry.image = image;
    entry.status = 'ready';
    entry.bytes = image.width * image.height * 4;
    // Protect it until the next frame has had a chance to draw it, or a full
    // cache would evict each image as soon as it arrived.
    entry.usedInFrame = this.frame;
    this.bytes += entry.bytes;
    this.evict();
    this.pump();
    this.onLoad();
  }

  /** Evicts least recently used images not on screen until within budget. */
  private evict(): void {
    if (this.bytes <= this.budget) return;
    for (const [key, entry] of [...this.entries]) {
      if (this.bytes <= this.budget) break;
      if (entry.status !== 'ready' || entry.usedInFrame === this.frame) {
        continue;
      }
      this.drop(key, entry);
    }
  }

  private drop(key: string, entry: Entry<I>): void {
    this.entries.delete(key);
    if (entry.image) {
      entry.image.close();
      this.bytes -= entry.bytes;
      entry.image = null;
    }
  }
}

function keyOf(id: string, level: Level): string {
  return `${level}:${id}`;
}
