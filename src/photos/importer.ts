import type { Decoder } from './decode';
import { fileFingerprint, type PhotoStore } from './store';

export interface ImportFailure {
  readonly name: string;
  readonly message: string;
}

/** What happened to the files of one `enqueue` call. */
export interface ImportSummary {
  /** Number of photos added to the store. */
  readonly added: number;
  /** Names of files skipped because they were already added. */
  readonly duplicates: readonly string[];
  /** Files the browser could not decode (HEIC in Chrome, non-images, ...). */
  readonly failures: readonly ImportFailure[];
}

export interface ImportProgress {
  /** True while any file is queued or being decoded. */
  readonly active: boolean;
  /** Files queued since the queue was last idle (including finished ones). */
  readonly total: number;
  /** Files finished (added or failed) out of `total`. */
  readonly done: number;
}

export type ImportProgressListener = (progress: ImportProgress) => void;

export interface ImporterOptions {
  readonly decode: Decoder;
  /** Photos decoded at once. Each full-size decode can be ~100 MB. Default 2. */
  readonly concurrency?: number;
  /** Called between photos so the page can paint and handle input. */
  readonly yieldToMain?: () => Promise<void>;
}

/** Lets the browser paint and process input. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Batch {
  readonly duplicates: string[];
  readonly failures: ImportFailure[];
  added: number;
  remaining: number;
  readonly resolve: (summary: ImportSummary) => void;
}

interface Job {
  readonly file: File;
  readonly batch: Batch;
  state: 'waiting' | 'running' | 'done';
  result?: Awaited<ReturnType<Decoder>>;
  error?: unknown;
}

/**
 * Decodes files into the store with bounded concurrency. Calls to `enqueue`
 * (for example a second drop during an import) join one shared queue. Photos
 * enter the store in the order the files were given, whatever order decoding
 * finishes in.
 */
export class PhotoImporter {
  private readonly store: PhotoStore;
  private readonly decode: Decoder;
  private readonly concurrency: number;
  private readonly yieldToMain: () => Promise<void>;
  private readonly listeners = new Set<ImportProgressListener>();
  private readonly queuedFingerprints = new Set<string>();

  private jobs: Job[] = [];
  private nextToStart = 0;
  private nextToCommit = 0;
  private workers = 0;
  private holds = 0;

  constructor(store: PhotoStore, options: ImporterOptions) {
    this.store = store;
    this.decode = options.decode;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.yieldToMain = options.yieldToMain ?? yieldToMain;
  }

  getProgress(): ImportProgress {
    return {
      active: this.nextToCommit < this.jobs.length,
      total: this.jobs.length,
      done: this.nextToCommit,
    };
  }

  /**
   * True from the first file queued until the last one is added, skipped or
   * failed (the queue is then empty). Unlike `getProgress().active` it is
   * still true while the last photo is being added to the store, so a store
   * listener never sees a photo arrive while this reads false.
   */
  isBusy(): boolean {
    return this.jobs.length > 0 || this.holds > 0;
  }

  /**
   * Makes `isBusy()` true until the returned function is called, as if an
   * import were running, so the editor lays out once afterwards (and not
   * in between) and undo waits. Opening a project (#12) holds the importer
   * while it swaps the photos and the collage in. Calling the release
   * function again does nothing. Listeners are told when the last hold is
   * released, like when a queue goes idle.
   */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.emit();
    };
  }

  /**
   * Calls `listener` on every progress change; when `isBusy()` is false the
   * queue has just gone idle, which is the "import finished" event.
   */
  subscribe(listener: ImportProgressListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Queues files for import. Resolves when all of them have been added,
   * skipped as duplicates or failed. Never rejects for an undecodable file.
   */
  enqueue(files: Iterable<File>): Promise<ImportSummary> {
    return new Promise((resolve) => {
      const batch: Batch = {
        duplicates: [],
        failures: [],
        added: 0,
        remaining: 0,
        resolve,
      };
      const accepted: Job[] = [];
      for (const file of files) {
        const fingerprint = fileFingerprint(file);
        if (
          this.store.hasFile(file) ||
          this.queuedFingerprints.has(fingerprint)
        ) {
          batch.duplicates.push(file.name);
          continue;
        }
        this.queuedFingerprints.add(fingerprint);
        accepted.push({ file, batch, state: 'waiting' });
      }
      batch.remaining = accepted.length;
      if (accepted.length === 0) {
        this.finish(batch);
        return;
      }
      this.jobs.push(...accepted);
      this.emit();
      // A worker that finds no job exits synchronously, so start a bounded
      // number rather than looping until `workers` reaches the limit.
      const toStart = Math.min(
        accepted.length,
        this.concurrency - this.workers,
      );
      for (let i = 0; i < toStart; i++) {
        this.workers++;
        void this.work();
      }
    });
  }

  private async work(): Promise<void> {
    for (;;) {
      const job = this.jobs[this.nextToStart];
      if (!job) break;
      this.nextToStart++;
      job.state = 'running';
      try {
        job.result = await this.decode(job.file);
      } catch (error) {
        job.error = error;
      }
      job.state = 'done';
      this.commit();
      await this.yieldToMain();
    }
    this.workers--;
  }

  /** Applies finished jobs to the store, in order. */
  private commit(): void {
    let changed = false;
    for (;;) {
      const job = this.jobs[this.nextToCommit];
      if (job?.state !== 'done') break;
      this.nextToCommit++;
      changed = true;
      const { batch, file } = job;
      this.queuedFingerprints.delete(fileFingerprint(file));
      if (job.result) {
        try {
          const added = this.store.addPhotos([{ file, ...job.result }]);
          if (added.length > 0) batch.added++;
          else batch.duplicates.push(file.name);
        } catch (error) {
          batch.failures.push({ name: file.name, message: describe(error) });
        }
      } else {
        batch.failures.push({ name: file.name, message: describe(job.error) });
      }
      batch.remaining--;
      if (batch.remaining === 0) this.finish(batch);
    }
    if (!changed) return;
    this.emit();
    if (this.nextToCommit === this.jobs.length) {
      // Idle: forget finished jobs, but report the final progress first.
      this.jobs = [];
      this.nextToStart = 0;
      this.nextToCommit = 0;
      this.emit();
    }
  }

  private finish(batch: Batch): void {
    batch.resolve({
      added: batch.added,
      duplicates: batch.duplicates,
      failures: batch.failures,
    });
  }

  private emit(): void {
    const progress = this.getProgress();
    for (const listener of [...this.listeners]) listener(progress);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not read this file';
}
