/**
 * Crop editing on the selected tile: dragging pans the photo, the wheel (or a
 * trackpad pinch) zooms about the pointer, Shift+arrows and +/- do the same
 * from the keyboard, and the menu has a zoom slider and a Reset button.
 *
 * The maths is in crop.ts (pure). This module is the gestures around it. Each
 * user gesture gives exactly one committed editor notification (none if the
 * crop ended up unchanged):
 * - a drag: steps while the pointer moves, one commit when it is released;
 * - a wheel or pinch burst, or a run of key presses: steps as they come, one
 *   commit when input has been quiet for BURST_MS, or earlier when anything
 *   else is about to act (a pointer press or a key press elsewhere);
 * - a slider drag or key press: GestureInput's usual `input` / `change`;
 * - Reset: one commit, or none if the crop is already the default.
 *
 * A drag starts only on the selected tile while it is merely selected (not
 * while a swap waits for a second tile), and only after the pointer has moved
 * a few pixels, so a click without movement is still a click. The click that
 * ends a drag is suppressed so it does not deselect the tile.
 */
import type { PhotoStore } from '../photos';
import type { Tile } from '../layout';
import {
  DEFAULT_CROP,
  MAX_ZOOM,
  panCrop,
  zoomCropAt,
  type Crop,
  type CropGeometry,
} from './crop';
import type { FrameScheduler } from './frames';
import { GestureInput, type GestureTarget } from './gesture';
import { cropOf, setCrop } from './state';
import type { EditorStore } from './store';
import type { CollageView } from './view';

/** Wheel and key input is one gesture until it has been quiet this long. */
export const BURST_MS = 250;
/** The pointer must move this far (CSS pixels) before a press becomes a pan. */
export const DRAG_THRESHOLD = 4;
/** A key press pans by this fraction of the tile. */
const KEY_PAN_STEP = 0.05;
/** A +/- key press multiplies the zoom by this. */
const KEY_ZOOM_STEP = 1.15;

export interface TileCropOptions {
  readonly doc: Document;
  readonly view: CollageView;
  readonly editor: EditorStore;
  readonly photos: Pick<PhotoStore, 'getPhoto'>;
  readonly frames: Pick<FrameScheduler, 'request' | 'cancel'>;
  /** The selected photo, its tile and whether a swap is pending. */
  readonly selected: () => {
    readonly photoId: string;
    readonly tile: Tile;
    readonly swapping: boolean;
  } | null;
}

export interface TileCrop {
  /** The slider and Reset button, for the tile's menu. */
  readonly controls: HTMLElement;
  /** True once for the click that ended a pan: the caller must ignore it. */
  consumeClick(): boolean;
  /** Handles Shift+arrows and +/- on the canvas; true if it was one. */
  handleKey(event: KeyboardEvent): boolean;
  /** Commits any gesture still in progress, now. */
  flush(): void;
  /** Re-reads the selection and the crop (after a render or selection change). */
  refresh(): void;
}

export function createTileCrop(options: TileCropOptions): TileCrop {
  const { doc, view, editor, photos, frames } = options;
  const { canvas } = view;
  const win = doc.defaultView as Window;

  // --- Controls ---
  const controls = doc.createElement('div');
  controls.className = 'tile-menu-crop';
  const label = doc.createElement('label');
  label.className = 'tile-menu-zoom';
  const labelText = doc.createElement('span');
  labelText.textContent = 'Zoom';
  const slider = doc.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = String(MAX_ZOOM);
  slider.step = '0.01';
  slider.value = '1';
  label.append(labelText, slider);
  const resetButton = doc.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset';
  resetButton.title = "Show the photo's default crop again";
  controls.append(label, resetButton);

  // --- Gestures ---
  /** The photo the running gesture is changing. */
  let activeId: string | null = null;
  const targetFor = (): GestureTarget<Crop> => ({
    drag(crop) {
      const id = activeId;
      if (id !== null) editor.drag((state) => setCrop(state, id, crop));
    },
    commit(crop) {
      const id = activeId;
      if (id !== null) editor.dispatch((state) => setCrop(state, id, crop));
    },
    isDragging: () => editor.isDragging(),
  });
  const canvasGesture = new GestureInput<Crop>(targetFor(), frames, 'crop');
  const sliderGesture = new GestureInput<Crop>(targetFor(), frames, 'zoom');
  /** The crop the canvas gesture has reached (not yet committed). */
  let working: Crop | null = null;
  /** The crop the slider gesture started from, and where it has reached. */
  let sliderStart: Crop | null = null;
  let sliderCrop: Crop | null = null;
  let burstTimer: number | null = null;

  function endCanvasGesture(): void {
    if (burstTimer !== null) win.clearTimeout(burstTimer);
    burstTimer = null;
    if (working) canvasGesture.end(working);
    working = null;
  }
  function endSliderGesture(): void {
    if (sliderCrop) sliderGesture.end(sliderCrop);
    sliderStart = null;
    sliderCrop = null;
  }
  function flush(): void {
    endDrag();
    endCanvasGesture();
    endSliderGesture();
  }

  // --- Geometry ---
  const scaleOf = (): number => {
    const rect = canvas.getBoundingClientRect();
    return rect.width === 0 ? 1 : canvas.width / rect.width;
  };
  function geometryOf(photoId: string, tile: Tile): CropGeometry | null {
    const aspect = photos.getPhoto(photoId)?.aspect;
    if (aspect === undefined || !(aspect > 0)) return null;
    return {
      imageWidth: aspect,
      imageHeight: 1,
      tileWidth: tile.width,
      tileHeight: tile.height,
    };
  }
  /** The crop the next step of a canvas gesture starts from. */
  function baseCrop(photoId: string): Crop {
    if (working && activeId === photoId) return working;
    activeId = photoId;
    return cropOf(editor.getState(), photoId);
  }
  function step(photoId: string, next: Crop): void {
    working = next;
    activeId = photoId;
    canvasGesture.move(next);
  }
  /** Extends the burst: commit when input has been quiet for BURST_MS. */
  function burst(photoId: string, next: Crop): void {
    step(photoId, next);
    if (burstTimer !== null) win.clearTimeout(burstTimer);
    burstTimer = win.setTimeout(endCanvasGesture, BURST_MS);
  }

  // --- Pan: dragging inside the selected tile ---
  interface Drag {
    readonly pointerId: number;
    readonly photoId: string;
    lastX: number;
    lastY: number;
    readonly startX: number;
    readonly startY: number;
    moving: boolean;
    /** True for a press on the tile of a pending swap: it never pans. */
    readonly inert: boolean;
  }
  let drag: Drag | null = null;
  let suppressClick = false;

  function endDrag(): void {
    const ended = drag;
    drag = null;
    if (!ended) return;
    if (ended.moving) {
      suppressClick = true;
      canvas.classList.remove('panning');
    }
    endCanvasGesture();
  }

  canvas.addEventListener('pointerdown', (event) => {
    suppressClick = false;
    const selected = options.selected();
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      !selected ||
      view.tileAtClientPoint(event.clientX, event.clientY)?.photoId !==
        selected.photoId
    ) {
      return;
    }
    flush();
    drag = {
      pointerId: event.pointerId,
      photoId: selected.photoId,
      lastX: event.clientX,
      lastY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moving: false,
      // While a swap is pending a drag is ignored entirely, and so is the
      // click that ends it, so the swap stays pending.
      inert: selected.swapping,
    };
    // Every move and the release reach the canvas wherever the pointer goes
    // (even a jump straight out of it); a press and release without moving
    // is still a click.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; the end events will follow.
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    const active = drag;
    if (!active) {
      const selected = options.selected();
      const over =
        selected !== null &&
        !selected.swapping &&
        view.tileAtClientPoint(event.clientX, event.clientY)?.photoId ===
          selected.photoId;
      canvas.classList.toggle('pannable', over);
      return;
    }
    if (event.pointerId !== active.pointerId) return;
    if (!active.moving) {
      if (
        Math.hypot(
          event.clientX - active.startX,
          event.clientY - active.startY,
        ) < DRAG_THRESHOLD
      ) {
        return;
      }
      active.moving = true;
      if (!active.inert) canvas.classList.add('panning');
    }
    if (active.inert) return;
    const selected = options.selected();
    const geometry =
      selected?.photoId === active.photoId
        ? geometryOf(active.photoId, selected.tile)
        : null;
    if (!selected || !geometry) return;
    const scale = scaleOf();
    const dx = (event.clientX - active.lastX) * scale;
    const dy = (event.clientY - active.lastY) * scale;
    active.lastX = event.clientX;
    active.lastY = event.clientY;
    step(active.photoId, panCrop(geometry, baseCrop(active.photoId), dx, dy));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => {
      if ((event as PointerEvent).pointerId === drag?.pointerId) {
        endDrag();
      }
    });
  }
  canvas.addEventListener('pointerleave', () => {
    if (!drag) canvas.classList.remove('pannable');
  });
  win.addEventListener('blur', flush);

  // --- Zoom: the wheel or a pinch over the selected tile ---
  canvas.addEventListener(
    'wheel',
    (event) => {
      const selected = options.selected();
      if (
        !selected ||
        view.tileAtClientPoint(event.clientX, event.clientY)?.photoId !==
          selected.photoId
      ) {
        return; // Elsewhere the wheel behaves normally.
      }
      // Over the selected tile it never scrolls the page (or, with Ctrl,
      // as a trackpad pinch, zooms the page).
      event.preventDefault();
      const geometry = geometryOf(selected.photoId, selected.tile);
      if (selected.swapping || drag || !geometry) return;
      const lines =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const delta = event.deltaY * lines;
      if (delta === 0) return;
      const base = baseCrop(selected.photoId);
      const rect = canvas.getBoundingClientRect();
      const scale = scaleOf();
      const px =
        ((event.clientX - rect.left) * scale - selected.tile.x) /
        selected.tile.width;
      const py =
        ((event.clientY - rect.top) * scale - selected.tile.y) /
        selected.tile.height;
      const rate = event.ctrlKey ? 0.01 : 0.0015;
      const next = zoomCropAt(
        geometry,
        base,
        base.zoom * Math.exp(-delta * rate),
        px,
        py,
      );
      if (next.x === base.x && next.y === base.y && next.zoom === base.zoom) {
        return;
      }
      burst(selected.photoId, next);
    },
    { passive: false },
  );

  // Anything else about to act ends a pending burst first, so it is its own
  // undo step rather than part of the crop's.
  doc.addEventListener(
    'pointerdown',
    () => {
      if (!drag) flush();
    },
    true,
  );
  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Shift') return;
      if (
        event.target === canvas &&
        (isCropKey(event) || zoomKey(event) !== 0)
      ) {
        return;
      }
      flush();
    },
    true,
  );

  // --- Keyboard ---
  /** +1 for a zoom-in key (+ or =), -1 for zoom-out (- or _), else 0. */
  function zoomKey(event: KeyboardEvent): number {
    if (event.key === '+' || event.key === '=') return 1;
    if (event.key === '-' || event.key === '_') return -1;
    return 0;
  }
  function isCropKey(event: KeyboardEvent): boolean {
    return (
      event.shiftKey &&
      (event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown')
    );
  }
  function handleKey(event: KeyboardEvent): boolean {
    const zoomIn = zoomKey(event) > 0;
    const zoomOut = zoomKey(event) < 0;
    if (!isCropKey(event) && !zoomIn && !zoomOut) return false;
    const selected = options.selected();
    if (!selected) return false;
    event.preventDefault();
    const geometry = geometryOf(selected.photoId, selected.tile);
    if (selected.swapping || !geometry) return true;
    const base = baseCrop(selected.photoId);
    let next: Crop;
    if (zoomIn || zoomOut) {
      next = zoomCropAt(
        geometry,
        base,
        zoomIn ? base.zoom * KEY_ZOOM_STEP : base.zoom / KEY_ZOOM_STEP,
        0.5,
        0.5,
      );
    } else {
      // The arrow says which way the view moves, like scrolling: Right shows
      // more of what is to the right, so the photo moves left.
      const sx =
        event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0;
      const sy =
        event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      next = panCrop(
        geometry,
        base,
        sx * KEY_PAN_STEP * selected.tile.width,
        sy * KEY_PAN_STEP * selected.tile.height,
      );
    }
    if (next.x !== base.x || next.y !== base.y || next.zoom !== base.zoom) {
      burst(selected.photoId, next);
    }
    return true;
  }

  // --- Slider and Reset ---
  slider.addEventListener('input', () => {
    const selected = options.selected();
    if (!selected || selected.swapping) return;
    const geometry = geometryOf(selected.photoId, selected.tile);
    if (!geometry) return;
    if (!sliderStart || !sliderGesture.isBusy()) {
      activeId = selected.photoId;
      sliderStart = cropOf(editor.getState(), selected.photoId);
    }
    sliderCrop = zoomCropAt(
      geometry,
      sliderStart,
      Number(slider.value),
      0.5,
      0.5,
    );
    sliderGesture.move(sliderCrop);
  });
  for (const type of [
    'change',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'blur',
  ]) {
    slider.addEventListener(type, endSliderGesture);
  }
  resetButton.addEventListener('click', () => {
    const selected = options.selected();
    if (!selected) return;
    flush();
    const id = selected.photoId;
    editor.dispatch((state) => setCrop(state, id, DEFAULT_CROP));
  });

  function refresh(): void {
    const selected = options.selected();
    if (!selected) {
      flush();
      canvas.classList.remove('pannable', 'panning');
      return;
    }
    if (selected.swapping && drag && !drag.inert) endDrag();
    const crop = cropOf(editor.getState(), selected.photoId);
    if (doc.activeElement !== slider || !sliderGesture.isBusy()) {
      slider.value = String(crop.zoom);
    }
    slider.setAttribute('aria-valuetext', `${crop.zoom.toFixed(1)} times`);
  }
  editor.subscribe(refresh);

  return {
    controls,
    consumeClick() {
      const was = suppressClick;
      suppressClick = false;
      return was;
    },
    handleKey,
    flush,
    refresh,
  };
}
