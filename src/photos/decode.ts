/** Browser-only decoding: turns a `File` into dimensions, preview and thumbnail. */

/** Long side of the editor preview, in pixels. */
export const PREVIEW_LONG_SIDE = 1024;
/** Long side of the tray thumbnail, in pixels. */
export const THUMBNAIL_LONG_SIDE = 256;

const PREVIEW_QUALITY = 0.85;
const THUMBNAIL_QUALITY = 0.8;

export interface DecodedPhoto {
  /** Width after EXIF orientation is applied. */
  readonly width: number;
  /** Height after EXIF orientation is applied. */
  readonly height: number;
  readonly preview: Blob;
  readonly thumbnail: Blob;
}

/** Decodes one file. Rejects if the browser cannot decode it as an image. */
export type Decoder = (file: File) => Promise<DecodedPhoto>;

/** Size that fits `width` x `height` within `longSide`, never enlarging. */
export function fitLongSide(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function scaleTo(
  source: CanvasImageSource,
  width: number,
  height: number,
): Canvas {
  const canvas = createCanvas(width, height);
  const context =
    canvas instanceof HTMLCanvasElement
      ? canvas.getContext('2d')
      : canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is not available');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function toJpeg(canvas: Canvas, quality: number): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Could not encode image'));
        },
        'image/jpeg',
        quality,
      );
    });
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * Decodes `file` once at full size, draws the preview and thumbnail, then
 * releases the full-size bitmap before returning. Callers decode one (or a
 * small bounded number) at a time, so peak memory is a few full-size bitmaps
 * (about 100 MB each for a 24 MP photo) regardless of how many photos exist.
 * Only the `File` is kept for full-resolution use later.
 *
 * `imageOrientation: 'from-image'` applies the EXIF orientation, so the
 * dimensions and pixels are already the right way up.
 */
export const decodePhoto: Decoder = async (file) => {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  try {
    const { width, height } = bitmap;
    if (!(width > 0) || !(height > 0)) {
      throw new Error('Image has no pixels');
    }
    const previewSize = fitLongSide(width, height, PREVIEW_LONG_SIDE);
    const previewCanvas = scaleTo(
      bitmap,
      previewSize.width,
      previewSize.height,
    );
    // Draw the thumbnail from the preview rather than the full-size bitmap:
    // cheaper, and two gentle downscales look better than one extreme one.
    const thumbSize = fitLongSide(width, height, THUMBNAIL_LONG_SIDE);
    const thumbCanvas = scaleTo(
      previewCanvas,
      thumbSize.width,
      thumbSize.height,
    );
    const preview = await toJpeg(previewCanvas, PREVIEW_QUALITY);
    const thumbnail = await toJpeg(thumbCanvas, THUMBNAIL_QUALITY);
    return { width, height, preview, thumbnail };
  } finally {
    bitmap.close();
  }
};
