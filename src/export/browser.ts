/** The browser side of export (#11): canvas, decoding and yielding. */
import type { DecodeSize } from './decode-size';
import type { DecodedOriginal, ExportDeps, ExportSurface } from './export';

type Canvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * A canvas of exactly `width` × `height`: an OffscreenCanvas where there is
 * one, else a detached <canvas>. Throws if the browser will not make it.
 */
export function createSurface(width: number, height: number): ExportSurface {
  let canvas: Canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const context:
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null =
    canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is not available');
  return {
    context,
    alphaAt: (x, y) => context.getImageData(x, y, 1, 1).data[3] ?? 0,
    encode: (type, quality) => encodeCanvas(canvas, type, quality),
    dispose: () => {
      // Release the pixels now rather than when the canvas is collected.
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

function encodeCanvas(
  canvas: Canvas,
  type: string,
  quality: number | undefined,
): Promise<Blob | null> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, type, quality);
    });
  }
  return canvas.convertToBlob({ type, quality });
}

/**
 * Decodes `file` with its EXIF orientation applied, shrunk to `size` when
 * given. The browser resizes while decoding, so the full-size bitmap is
 * never held. If the result's shape does not match the request (a browser
 * that applies the orientation and the resize in another order), decodes
 * again at full size instead: the drawing code works from the bitmap's own
 * size, and a bitmap of the wrong shape would be drawn from the wrong place.
 */
export async function decodeOriginal(
  file: Blob,
  size: DecodeSize | null,
): Promise<DecodedOriginal> {
  if (size) {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'high',
    });
    if (bitmap.width === size.width && bitmap.height === size.height) {
      return wrap(bitmap);
    }
    bitmap.close();
  }
  return wrap(
    await createImageBitmap(file, { imageOrientation: 'from-image' }),
  );
}

function wrap(bitmap: ImageBitmap): DecodedOriginal {
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => {
      bitmap.close();
    },
  };
}

/**
 * Lets the page paint and handle input between tiles. A message, not a
 * timer: timers in a background tab are throttled to once a second.
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export const browserDeps: ExportDeps = {
  createSurface,
  decode: decodeOriginal,
  yieldToUi,
};
