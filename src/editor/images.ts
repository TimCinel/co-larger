/**
 * A bounded cache of decoded images for drawing the collage on screen.
 *
 * Each photo can be held at three levels (see image-source.ts): the 256 px
 * thumbnail (about 0.2 MB decoded), the 1024 px preview (about 3 MB) and a
 * "detail" decode of the original at the size a large tile needs (a few to
 * tens of MB). Decoded images are never held beyond a hard byte budget:
 *
 * - Rendering never waits: `get` returns the best image that is decoded now
 *   (or null: the tile is drawn as a placeholder) and records what the tile
 *   would like. After each frame `endFrame` plans which level of each photo
 *   to hold within the budget (image-plan.ts: most important tiles first,
 *   the rest degrade to a smaller level) and starts decoding what the plan
 *   lacks, in the background with bounded concurrency; `onLoad` asks for a
 *   repaint. A tile is drawn from the sharper image once it arrives.
 * - The total of every decoded image plus every decode in flight (counted
 *   at its expected size from the moment it starts) never exceeds the
 *   budget. Room is made before a decode starts, by closing images the plan
 *   does not keep, least recently used first; a decode that cannot get room
 *   waits. Images drawn in a frame are only closed between frames, so a
 *   frame never draws a closed image.
 * - Detail decodes are held back while `setInteracting(true)`: dragging the
 *   dial or a crop changes tile sizes every frame, and decoding a large
 *   image for a size that is about to change would be wasted.
 * - A failed decode is remembered and never retried. A failed detail (for
 *   instance a project file that was moved) falls back to the preview
 *   without a word; only a photo with no usable thumbnail or preview is
 *   reported.
 * - Images of photos that leave the store are released at once (`release`).
 */
import type { DecodeSize } from '../export/decode-size';
import { decodeOriginal } from '../export/browser';
import type { Tile } from '../layout';
import { DEFAULT_CROP, type Crop } from './crop';
import { planLevels, type PlanDemand } from './image-plan';
import {
  bytesOf,
  chooseSource,
  LEVEL_RANK,
  MAX_DETAIL_BYTES,
  storedSize,
  supplies,
  type Level,
} from './image-source';
import type { DrawableImage } from './render';

/** What the cache needs to know about a photo. `Photo` from the store fits. */
export interface CachePhoto {
  /** Natural size, after EXIF orientation. */
  readonly width: number;
  readonly height: number;
  /** The original file, decoded for detail. */
  readonly file: Blob;
  readonly preview: Blob;
  readonly thumbnail: Blob;
}

/** A decoded image. `ImageBitmap` fits. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** What to decode. */
export interface DecodeRequest {
  readonly id: string;
  readonly photo: CachePhoto;
  readonly level: Level;
  /** The size to decode at: the image's own size for a thumbnail/preview. */
  readonly size: DecodeSize;
}

export interface ImageCacheOptions<I extends DecodedImage> {
  /** Looks a photo up by id; undefined if it no longer exists. */
  readonly lookup: (id: string) => CachePhoto | undefined;
  /**
   * Decodes an image. Defaults to createImageBitmap for the stored blobs and
   * the export's decodeOriginal (EXIF orientation applied, shrunk while
   * decoding) for a detail.
   */
  readonly decode?: (request: DecodeRequest) => Promise<I>;
  /** Called after each image finishes decoding, to schedule a repaint. */
  readonly onLoad?: () => void;
  /**
   * Called once per photo the first time any of its images fails to decode
   * (to tell the user). A failed thumbnail falls back to the preview; a
   * photo with neither is reported by `isFailed`. A failed detail is not
   * reported: the preview is drawn.
   */
  readonly onError?: (photoId: string) => void;
  /** Byte budget for decoded images (width × height × 4). Default 256 MB. */
  readonly budgetBytes?: number;
  /** Decodes running at once. Default 4. */
  readonly concurrency?: number;
}

/**
 * The default budget. A quarter of a gigabyte holds a 4096 × 4096 detail and
 * about 80 previews at once, small next to what a browser tab may use.
 */
export const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

/** Detail decodes at once: each is large and briefly costs more natively. */
const DETAIL_CONCURRENCY = 1;

interface Ready<I> {
  readonly id: string;
  readonly level: Level;
  readonly image: I;
  readonly bytes: number;
}

interface InFlight {
  readonly id: string;
  readonly level: Level;
  readonly size: DecodeSize;
  /** What is counted against the budget until the decode ends. */
  readonly reserved: number;
  cancelled: boolean;
}

interface Demand {
  readonly priority: number;
  readonly ideal: Level;
  readonly needed: DecodeSize;
  readonly detailSize: DecodeSize;
  /** The level of the image `get` returned, or -1 for none. */
  readonly drawnRank: number;
}

interface Planned {
  readonly level: Level;
  /** For a detail: the size to hold it at. */
  readonly detailSize: DecodeSize;
  readonly priority: number;
}

export interface ImageCacheStats {
  /** Decoded bytes plus decodes in flight: what the budget bounds. */
  readonly bytes: number;
  readonly budget: number;
  /** The largest `bytes` there has been. */
  readonly peakBytes: number;
  /** Decoded images held. */
  readonly images: number;
  /** Decodes the plan wants that have not started. */
  readonly queued: number;
  /** Decodes running. */
  readonly loading: number;
  /** Total decodes started, for diagnostics. */
  readonly decodes: number;
  /** How many of them were decodes of the original (detail). */
  readonly detailDecodes: number;
}

export class ImageCache<I extends DecodedImage = ImageBitmap> {
  /** Decoded images, least recently used first. */
  private readonly ready = new Map<string, Ready<I>>();
  private readonly inflight = new Map<string, InFlight>();
  private readonly failed = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly prefetched = new Set<string>();
  private demands = new Map<string, Demand>();
  private plan = new Map<string, Planned>();
  private order: string[] = [];
  private readonly lookup: (id: string) => CachePhoto | undefined;
  private readonly decode: (request: DecodeRequest) => Promise<I>;
  private readonly onLoad: () => void;
  private readonly onError: (photoId: string) => void;
  private readonly budget: number;
  private readonly maxDetail: number;
  private readonly concurrency: number;
  private bytes = 0;
  private reserved = 0;
  private peak = 0;
  private decodes = 0;
  private detailDecodes = 0;
  private interacting = false;
  private planQueued = false;
  private upgrading = 0;

  constructor(options: ImageCacheOptions<I>) {
    this.lookup = options.lookup;
    this.decode = options.decode ?? defaultDecode<I>;
    this.onLoad = options.onLoad ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.maxDetail = Math.min(MAX_DETAIL_BYTES, this.budget / 4);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /** Starts a frame: what the previous one asked for is forgotten. */
  nextFrame(): void {
    this.demands = new Map();
  }

  /**
   * The best decoded image of `photoId` for `tile` (in output pixels) with
   * `crop`, or null if none is decoded yet. Records what the tile would
   * like; `endFrame` (or a microtask) then plans and queues the decodes.
   */
  get(
    photoId: string,
    tile: Tile,
    crop: Crop = DEFAULT_CROP,
  ): DrawableImage | null {
    const photo = this.lookup(photoId);
    if (!photo) return null;
    const choice = chooseSource(photo, tile, crop, this.maxDetail);
    let ideal = choice.level;
    if (ideal === 'detail' && this.failed.has(keyOf(photoId, 'detail'))) {
      ideal = 'preview';
    }
    if (ideal === 'preview' && this.failed.has(keyOf(photoId, 'preview'))) {
      ideal = 'thumbnail';
    }
    if (ideal === 'thumbnail' && this.failed.has(keyOf(photoId, 'thumbnail'))) {
      ideal = 'preview';
    }
    // The image the tile wants if it is decoded, else the best stand-in
    // (the sharper one first: a thumbnail is never drawn over a preview
    // the tile needs). The pixels drawn then depend only on the tile once
    // everything has decoded, not on what happened to be decoded earlier.
    const candidates: Level[] =
      ideal === 'detail'
        ? ['detail', 'preview', 'thumbnail']
        : ideal === 'preview'
          ? ['preview', 'thumbnail']
          : ['thumbnail', 'preview'];
    let drawn: Ready<I> | null = null;
    for (const level of candidates) {
      const entry = this.touch(keyOf(photoId, level));
      if (entry) {
        drawn = entry;
        break;
      }
    }
    this.demands.set(photoId, {
      priority: tile.width * tile.height,
      ideal,
      needed: choice.needed,
      detailSize: choice.size,
      drawnRank: drawn ? LEVEL_RANK[drawn.level] : -1,
    });
    this.queuePlan();
    if (!drawn) return null;
    return {
      image: drawn.image as unknown as CanvasImageSource,
      width: drawn.image.width,
      height: drawn.image.height,
    };
  }

  /**
   * Ends a frame: plans what to hold, closes nothing that was just drawn,
   * and starts the decodes the plan lacks. Called by the view after it
   * draws; `get` also schedules it for callers that do not.
   */
  endFrame(): void {
    this.planQueued = false;
    this.replan();
    this.pump();
  }

  /**
   * True while the user is dragging or zooming something: no detail decode
   * starts until it is false again (then `onLoad` asks for a repaint).
   */
  setInteracting(value: boolean): void {
    if (this.interacting === value) return;
    this.interacting = value;
    if (!value) {
      this.pump();
      this.onLoad();
    }
  }

  /**
   * How many of the last frame's tiles were drawn from less than the best
   * image the cache means to hold for them (a decode is on its way or is
   * held back): zero once the pixels are final.
   */
  upgradingTiles(): number {
    return this.upgrading;
  }

  /** True when no image of the photo can be decoded (draw an error). */
  isFailed(photoId: string): boolean {
    return (
      this.failed.has(keyOf(photoId, 'thumbnail')) &&
      this.failed.has(keyOf(photoId, 'preview'))
    );
  }

  /** Queues the thumbnails of `ids` (decoded in the background). */
  prefetch(ids: Iterable<string>): void {
    for (const id of ids) this.prefetched.add(id);
    this.queuePlan();
  }

  /** Frees every image of these photos and drops any queued decodes. */
  release(ids: Iterable<string>): void {
    for (const id of ids) {
      this.reported.delete(id);
      this.prefetched.delete(id);
      this.demands.delete(id);
      this.plan.delete(id);
      for (const level of LEVELS) {
        const key = keyOf(id, level);
        this.failed.delete(key);
        const entry = this.ready.get(key);
        if (entry) this.drop(key, entry);
        const job = this.inflight.get(key);
        if (job) job.cancelled = true;
      }
    }
    this.order = this.order.filter((id) => this.plan.has(id));
  }

  /** Frees everything. */
  clear(): void {
    this.release(
      new Set([
        ...[...this.ready.values()].map((entry) => entry.id),
        ...[...this.inflight.values()].map((job) => job.id),
        ...this.plan.keys(),
        ...this.prefetched,
      ]),
    );
  }

  /** For tests and diagnostics. */
  stats(): ImageCacheStats {
    return {
      bytes: this.bytes + this.reserved,
      budget: this.budget,
      peakBytes: this.peak,
      images: this.ready.size,
      queued: this.outstanding().length,
      loading: this.inflight.size,
      decodes: this.decodes,
      detailDecodes: this.detailDecodes,
    };
  }

  // --- Planning ---

  private queuePlan(): void {
    if (this.planQueued) return;
    this.planQueued = true;
    queueMicrotask(() => {
      if (this.planQueued) this.endFrame();
    });
  }

  private replan(): void {
    const demands: PlanDemand[] = [];
    const detailSizes = new Map<string, DecodeSize>();
    for (const [id, demand] of this.demands) {
      const photo = this.lookup(id);
      if (!photo) continue;
      const thumb = bytesOf(storedSize(photo, 'thumbnail'));
      const preview = thumb + bytesOf(storedSize(photo, 'preview'));
      // An existing detail that is sharp enough is reused, not decoded
      // again; one that is not stays until its replacement is ready.
      const existing = this.ready.get(keyOf(id, 'detail'));
      let detailSize = demand.detailSize;
      let detail = preview + bytesOf(detailSize);
      if (existing) {
        const have = {
          width: existing.image.width,
          height: existing.image.height,
        };
        if (
          supplies(have, demand.needed) ||
          supplies(have, demand.detailSize)
        ) {
          detailSize = have;
          detail = preview + existing.bytes;
        } else {
          detail += existing.bytes;
        }
      }
      detailSizes.set(id, detailSize);
      // Photos that already hold a sharper image keep it over one that
      // would need a decode, so a view near the budget does not churn.
      const held = existing || this.ready.has(keyOf(id, 'preview')) ? 1.25 : 1;
      demands.push({
        id,
        priority: demand.priority * held,
        ideal: demand.ideal,
        optional: false,
        cost: { thumbnail: thumb, preview, detail },
      });
    }
    for (const id of this.prefetched) {
      if (this.demands.has(id)) continue;
      const photo = this.lookup(id);
      if (!photo) continue;
      const thumb = bytesOf(storedSize(photo, 'thumbnail'));
      demands.push({
        id,
        priority: 0,
        ideal: 'thumbnail',
        optional: true,
        cost: { thumbnail: thumb, preview: thumb, detail: thumb },
      });
    }
    const levels = planLevels(demands, this.budget);
    const plan = new Map<string, Planned>();
    const priorityOf = new Map(demands.map((d) => [d.id, d.priority]));
    for (const [id, level] of levels) {
      plan.set(id, {
        level,
        detailSize: detailSizes.get(id) ?? { width: 0, height: 0 },
        priority: priorityOf.get(id) ?? 0,
      });
    }
    this.plan = plan;
    this.order = [...plan.keys()].sort(
      (a, b) => (plan.get(b)?.priority ?? 0) - (plan.get(a)?.priority ?? 0),
    );
    let upgrading = 0;
    for (const [id, demand] of this.demands) {
      const planned = plan.get(id);
      if (planned && demand.drawnRank < LEVEL_RANK[planned.level]) upgrading++;
    }
    this.upgrading = upgrading;
  }

  /** What the plan holds but the cache does not yet, best first. */
  private outstanding(): { id: string; level: Level; size: DecodeSize }[] {
    const jobs: { id: string; level: Level; size: DecodeSize }[] = [];
    for (const level of LEVELS) {
      for (const id of this.order) {
        const planned = this.plan.get(id);
        const photo = this.lookup(id);
        if (!planned || !photo) continue;
        if (LEVEL_RANK[level] > LEVEL_RANK[planned.level]) continue;
        const key = keyOf(id, level);
        if (this.failed.has(key) || this.inflight.has(key)) continue;
        if (level === 'detail') {
          if (this.failed.has(keyOf(id, 'preview'))) continue;
          const have = this.ready.get(key);
          if (have && supplies(have.image, planned.detailSize)) continue;
          jobs.push({ id, level, size: planned.detailSize });
        } else if (!this.ready.has(key)) {
          jobs.push({ id, level, size: storedSize(photo, level) });
        }
      }
    }
    return jobs;
  }

  // --- Decoding ---

  private pump(): void {
    if (this.inflight.size >= this.concurrency) return;
    for (const job of this.outstanding()) {
      if (this.inflight.size >= this.concurrency) return;
      if (job.level === 'detail') {
        if (this.interacting) continue;
        let detail = 0;
        for (const running of this.inflight.values()) {
          if (running.level === 'detail') detail++;
        }
        if (detail >= DETAIL_CONCURRENCY) continue;
      }
      const need = bytesOf(job.size);
      if (!this.makeRoom(need, job.level === 'detail' ? job.id : null))
        continue;
      this.start(job.id, job.level, job.size, need);
    }
  }

  private start(
    id: string,
    level: Level,
    size: DecodeSize,
    need: number,
  ): void {
    const photo = this.lookup(id);
    if (!photo) return;
    const key = keyOf(id, level);
    const job: InFlight = { id, level, size, reserved: need, cancelled: false };
    this.inflight.set(key, job);
    this.reserved += need;
    this.notePeak();
    this.decodes++;
    if (level === 'detail') this.detailDecodes++;
    this.decode({ id, photo, level, size }).then(
      (image) => {
        this.finish(key, job);
        this.loaded(key, job, image);
      },
      (error: unknown) => {
        this.finish(key, job);
        if (!job.cancelled) this.failedDecode(key, job, error);
        this.pump();
      },
    );
  }

  private finish(key: string, job: InFlight): void {
    this.inflight.delete(key);
    this.reserved -= job.reserved;
  }

  private loaded(key: string, job: InFlight, image: I): void {
    const bytes = image.width * image.height * 4;
    // The image may be bigger than expected (a browser that ignored the
    // requested size): it must still fit, or it is not kept.
    if (job.cancelled || !this.makeRoom(bytes, null)) {
      image.close();
      if (!job.cancelled) this.failed.add(key);
      this.pump();
      this.onLoad();
      return;
    }
    const old = this.ready.get(key);
    if (old) this.drop(key, old);
    this.ready.set(key, { id: job.id, level: job.level, image, bytes });
    this.bytes += bytes;
    this.notePeak();
    this.pump();
    this.onLoad();
  }

  private failedDecode(key: string, job: InFlight, error: unknown): void {
    this.failed.add(key);
    if (job.level === 'detail') {
      // Drawn from the preview instead; nothing to tell the user.
      this.onLoad();
      return;
    }
    // Remember the failure so it is not retried every frame. The tile falls
    // back to the other level or shows the error placeholder.
    console.warn(`Could not decode ${job.level} of ${job.id}`, error);
    if (!this.reported.has(job.id)) {
      this.reported.add(job.id);
      this.onError(job.id);
    }
    this.onLoad();
  }

  // --- The budget ---

  /**
   * Closes images the plan does not keep, least recently used first, until
   * `need` more bytes fit in the budget. False if they do not (the caller
   * waits). `except` is a photo whose images are kept regardless.
   */
  private makeRoom(need: number, except: string | null): boolean {
    if (this.bytes + this.reserved + need <= this.budget) return true;
    for (const keptPass of [false, true]) {
      // First the images of photos not in this plan at all, then surplus
      // levels of photos that are.
      for (const [key, entry] of [...this.ready]) {
        if (this.bytes + this.reserved + need <= this.budget) return true;
        if (this.isKept(entry) || entry.id === except) continue;
        if (this.plan.has(entry.id) !== keptPass) continue;
        this.drop(key, entry);
      }
    }
    return this.bytes + this.reserved + need <= this.budget;
  }

  /** Whether the plan holds this image. */
  private isKept(entry: Ready<I>): boolean {
    const planned = this.plan.get(entry.id);
    return (
      planned !== undefined &&
      LEVEL_RANK[entry.level] <= LEVEL_RANK[planned.level]
    );
  }

  private drop(key: string, entry: Ready<I>): void {
    this.ready.delete(key);
    this.bytes -= entry.bytes;
    entry.image.close();
  }

  private notePeak(): void {
    this.peak = Math.max(this.peak, this.bytes + this.reserved);
  }

  /** The ready image, marked as most recently used, or null. */
  private touch(key: string): Ready<I> | null {
    const entry = this.ready.get(key);
    if (!entry) return null;
    this.ready.delete(key);
    this.ready.set(key, entry);
    return entry;
  }
}

const LEVELS: readonly Level[] = ['thumbnail', 'preview', 'detail'];

function keyOf(id: string, level: Level): string {
  return `${level}:${id}`;
}

function defaultDecode<I extends DecodedImage>(
  request: DecodeRequest,
): Promise<I> {
  if (request.level === 'detail') {
    return decodeOriginal(request.photo.file, request.size).then(
      (decoded) => decoded.image as unknown as I,
    );
  }
  const blob =
    request.level === 'preview'
      ? request.photo.preview
      : request.photo.thumbnail;
  return createImageBitmap(blob) as unknown as Promise<I>;
}
