/**
 * The collage view: the main area's canvas, fitted to the area and drawn
 * through renderCollage from decoded previews and thumbnails. It also keeps
 * the editor state in step with the photo store.
 *
 * The canvas's backing store is sized in device pixels (CSS size × device
 * pixel ratio), so the collage is sharp on high-density screens, and it is
 * re-fitted when the area is resized or the window moves to a screen with
 * another pixel ratio. All redraws are coalesced into animation frames.
 */
import type { Photo, PhotoStore } from '../photos';
import type { Tile } from '../layout';
import type { FrameScheduler } from './frames';
import { ImageCache } from './images';
import { fitSize, renderCollage, tileAt } from './render';
import { cropOf, type EditorState } from './state';
import type { EditorStore } from './store';

/** Space kept clear around the collage, in CSS pixels. */
const MARGIN = 24;

export interface CollageView {
  /** Put this in the main area. */
  readonly element: HTMLElement;
  /** The canvas, for pointer handling by later issues. */
  readonly canvas: HTMLCanvasElement;
  /**
   * The tile under a point in client (CSS) coordinates, with the photo in
   * it, or null if the point is not on a tile. For swap (#8) and crop (#9).
   */
  tileAtClientPoint(
    clientX: number,
    clientY: number,
  ): { readonly tile: Tile; readonly photoId: string } | null;
  /**
   * What was last drawn: the state, its tiles in canvas (device) pixels and
   * how many were placeholders. Null before the first non-empty draw.
   */
  lastRender(): {
    readonly state: EditorState;
    readonly tiles: readonly Tile[];
    readonly missing: number;
  } | null;
  /**
   * Calls `listener` after every draw (and after the canvas is hidden for an
   * empty collage), when `lastRender` and the canvas's size are current.
   * Returns an unsubscribe function. For overlays on the canvas (#8, #9).
   */
  onRender(listener: () => void): () => void;
  /** Draws now instead of in the next frame (for tests). */
  renderNow(): void;
}

export interface CollageViewOptions {
  readonly doc: Document;
  readonly editor: EditorStore;
  readonly photos: PhotoStore;
  readonly frames: FrameScheduler;
  /** The element whose size the collage is fitted to. */
  readonly area: HTMLElement;
  /** Called once per photo whose images cannot be decoded. */
  readonly onImageError?: (photo: Photo) => void;
}

export function createCollageView(options: CollageViewOptions): CollageView {
  const { doc, editor, photos, frames, area } = options;
  const win = doc.defaultView as Window;

  const element = doc.createElement('div');
  element.className = 'collage';

  const canvas = doc.createElement('canvas');
  canvas.className = 'collage-canvas';
  canvas.setAttribute('role', 'img');
  canvas.hidden = true;

  const hint = doc.createElement('p');
  hint.className = 'canvas-hint';

  element.append(canvas, hint);

  // Photos by id, for the image cache.
  let byId = new Map<string, Photo>();
  const indexPhotos = (): void => {
    byId = new Map(photos.getPhotos().map((photo) => [photo.id, photo]));
  };
  indexPhotos();

  const cache = new ImageCache({
    lookup: (id) => byId.get(id),
    onLoad: () => {
      frames.request('render', render);
    },
    onError: (id) => {
      const photo = byId.get(id);
      if (photo) options.onImageError?.(photo);
    },
  });

  let tiles: Tile[] = [];
  let last: ReturnType<CollageView['lastRender']> = null;
  let available = { width: 0, height: 0 };
  let dpr = win.devicePixelRatio || 1;

  const renderListeners = new Set<() => void>();
  function render(): void {
    draw();
    for (const listener of [...renderListeners]) listener();
  }

  function draw(): void {
    const state = editor.getState();
    const empty = state.photos.length === 0;
    canvas.hidden = empty;
    hint.hidden = !empty;
    if (empty) {
      tiles = [];
      last = null;
      hint.textContent =
        photos.getTotalCount() === 0
          ? 'Drop photos anywhere on this page, or use Add photos.'
          : 'No photos are included. Select photos in the tray to add them to the collage.';
      return;
    }

    // Fit the canvas to the area, in device pixels.
    const size = fitSize(
      state.canvas.width,
      state.canvas.height,
      Math.max(1, (available.width - 2 * MARGIN) * dpr),
      Math.max(1, (available.height - 2 * MARGIN) * dpr),
    );
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    canvas.style.width = `${String(size.width / dpr)}px`;
    canvas.style.height = `${String(size.height / dpr)}px`;
    canvas.setAttribute(
      'aria-label',
      `Collage of ${String(state.photos.length)} ${state.photos.length === 1 ? 'photo' : 'photos'}`,
    );

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    cache.nextFrame();
    const result = renderCollage(
      ctx,
      state,
      size,
      (id, tile) =>
        cache.get(id, tile, cropOf(state, id)) ??
        (cache.isFailed(id) ? 'failed' : null),
    );
    tiles = result.tiles;
    last = { state, tiles, missing: result.missing };
  }

  const scheduleRender = (): void => {
    frames.request('render', render);
  };

  // The EditorStore keeps the included set in step with the photo store;
  // the view only keeps its images in step.
  photos.subscribe((change) => {
    indexPhotos();
    if (change.kind === 'removed') {
      cache.release(change.ids);
    } else {
      // Start decoding thumbnails of newly included photos in the background.
      cache.prefetch(
        change.ids.filter((id) => byId.get(id)?.included === true),
      );
    }
  });
  editor.subscribe(scheduleRender);

  // Re-fit when the area is resized.
  new ResizeObserver((entries) => {
    const box = entries.at(-1)?.contentRect;
    if (!box) return;
    available = { width: box.width, height: box.height };
    scheduleRender();
  }).observe(area);

  // Re-fit when the pixel ratio changes (browser zoom, another screen).
  const watchPixelRatio = (): void => {
    const query = win.matchMedia(`(resolution: ${String(dpr)}dppx)`);
    query.addEventListener(
      'change',
      () => {
        dpr = win.devicePixelRatio || 1;
        watchPixelRatio();
        scheduleRender();
      },
      { once: true },
    );
  };
  watchPixelRatio();

  // Remaining decoded images are released with the page.
  win.addEventListener('pagehide', () => {
    cache.clear();
  });

  const initial = photos.getPlacementPhotos();
  cache.prefetch(initial.map((photo) => photo.id));
  scheduleRender();

  return {
    element,
    canvas,
    tileAtClientPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (canvas.hidden || rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) * canvas.width) / rect.width;
      const y = ((clientY - rect.top) * canvas.height) / rect.height;
      const tile = tileAt(tiles, x, y);
      const photoId =
        tile === null ? undefined : editor.getState().assignment[tile.slot];
      return tile && photoId !== undefined ? { tile, photoId } : null;
    },
    lastRender: () => last,
    onRender(listener) {
      renderListeners.add(listener);
      return () => {
        renderListeners.delete(listener);
      };
    },
    renderNow() {
      frames.cancel('render');
      render();
    },
  };
}
