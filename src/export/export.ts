/**
 * Export (#11): renders the editor's snapshot at its full output size from
 * the original photos and encodes it. The drawing is renderCollageAsync, the
 * same per-tile code as the editor preview (tilesFor, coverSource, drawTile),
 * so the result matches the preview apart from resolution. The plan is the
 * snapshot's own: it is placed at the output size, never re-planned.
 *
 * The browser pieces (canvas, decoding, yielding) are injected so the flow
 * is testable in Node.
 */
import {
  cropOf,
  renderCollageAsync,
  tilesFor,
  type AsyncImageProvider,
  type CollageContext,
  type EditorState,
  type LoadedImage,
} from '../editor';
import {
  decodeSizeFor,
  MIME_TYPES,
  type DecodeSize,
  type ExportFormat,
} from './decode-size';

/** A photo to export from: the original file and its oriented size. */
export interface ExportPhoto {
  readonly name: string;
  readonly file: Blob;
  readonly width: number;
  readonly height: number;
}

/** An image decoded for one tile. */
export interface DecodedOriginal {
  readonly width: number;
  readonly height: number;
  readonly image: CanvasImageSource;
  close(): void;
}

/** The surface the collage is drawn on. */
export interface ExportSurface {
  readonly context: CollageContext;
  /** The alpha (0 to 255) of one pixel, to tell a blank surface. */
  alphaAt(x: number, y: number): number;
  /** The encoded image, or null if the browser could not encode it. */
  encode(type: string, quality: number | undefined): Promise<Blob | null>;
  /** Frees the pixels. */
  dispose(): void;
}

export interface ExportDeps {
  /** Throws if a surface of this size cannot be made. */
  createSurface(width: number, height: number): ExportSurface;
  /** Decodes `file` (shrunk to `size` if given), rejecting if it cannot. */
  decode(file: Blob, size: DecodeSize | null): Promise<DecodedOriginal>;
  /** Lets the page paint and handle input. */
  yieldToUi(): Promise<void>;
}

export type ExportProgress =
  | {
      readonly phase: 'rendering';
      readonly done: number;
      readonly total: number;
    }
  | { readonly phase: 'encoding' };

export type ExportFailure = 'too-large' | 'decode';

/** Why an export stopped, with a message fit to show. */
export class ExportError extends Error {
  constructor(
    readonly reason: ExportFailure,
    message: string,
    readonly photoName?: string,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export const TOO_LARGE_MESSAGE =
  'This size is too large for this browser to export. Try a smaller size or another browser.';

const tooLarge = (): ExportError =>
  new ExportError('too-large', TOO_LARGE_MESSAGE);

export interface ExportOptions {
  /** The snapshot to draw: take it when Export is pressed. */
  readonly state: EditorState;
  /** The originals, by photo id, for every photo in the snapshot. */
  readonly photos: ReadonlyMap<string, ExportPhoto>;
  readonly format: ExportFormat;
  /** JPEG quality, 0 to 1. Ignored for PNG. */
  readonly quality: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ExportProgress) => void;
  readonly deps: ExportDeps;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/** Where the blank check samples: a grid across the whole surface. */
const SAMPLES = [0, 0.5, 1];

/** Renders and encodes the collage. Rejects with an AbortError if cancelled. */
export async function exportCollage(
  options: ExportOptions,
): Promise<ExportResult> {
  const { state, photos, format, signal, deps } = options;
  const size = { width: state.canvas.width, height: state.canvas.height };
  const total = tilesFor(state, size).length;
  signal?.throwIfAborted();

  let surface: ExportSurface;
  try {
    surface = deps.createSurface(size.width, size.height);
  } catch {
    throw tooLarge();
  }
  try {
    let done = 0;
    options.onProgress?.({ phase: 'rendering', done, total });

    const getImage: AsyncImageProvider = async (id, tile) => {
      signal?.throwIfAborted();
      await deps.yieldToUi();
      signal?.throwIfAborted();
      const photo = photos.get(id);
      if (!photo) {
        throw new ExportError('decode', 'A photo in the collage is missing.');
      }
      const decodeSize = decodeSizeFor(
        photo.width,
        photo.height,
        tile,
        cropOf(state, id),
      );
      let decoded: DecodedOriginal;
      try {
        decoded = await deps.decode(photo.file, decodeSize);
      } catch {
        throw new ExportError(
          'decode',
          `Could not read ${photo.name}: this browser cannot decode the original photo, so the export was stopped.`,
          photo.name,
        );
      }
      if (signal?.aborted) {
        decoded.close();
        signal.throwIfAborted();
      }
      const image: LoadedImage = {
        image: decoded.image,
        width: decoded.width,
        height: decoded.height,
        release: () => {
          decoded.close();
          done++;
          options.onProgress?.({ phase: 'rendering', done, total });
        },
      };
      return image;
    };

    const rendered = await renderCollageAsync(
      surface.context,
      state,
      size,
      getImage,
    );
    if (rendered.missing > 0) {
      throw new ExportError(
        'decode',
        'A photo could not be drawn, so the export was stopped.',
      );
    }
    signal?.throwIfAborted();

    if (isBlank(surface, size.width, size.height)) throw tooLarge();

    options.onProgress?.({ phase: 'encoding' });
    await deps.yieldToUi();
    signal?.throwIfAborted();
    let blob: Blob | null;
    try {
      blob = await surface.encode(
        MIME_TYPES[format],
        format === 'jpeg' ? options.quality : undefined,
      );
    } catch {
      blob = null;
    }
    if (!blob || blob.size === 0) throw tooLarge();
    signal?.throwIfAborted();
    return { blob, width: size.width, height: size.height };
  } finally {
    surface.dispose();
  }
}

/**
 * True when the surface is fully transparent at every sample. The collage
 * always starts with an opaque background, so a transparent surface means
 * the browser dropped the drawing (a canvas over its size limit).
 */
function isBlank(
  surface: ExportSurface,
  width: number,
  height: number,
): boolean {
  for (const fy of SAMPLES) {
    for (const fx of SAMPLES) {
      const x = Math.min(width - 1, Math.floor(fx * width));
      const y = Math.min(height - 1, Math.floor(fy * height));
      if (surface.alphaAt(x, y) > 0) return false;
    }
  }
  return true;
}
