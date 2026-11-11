/**
 * Tile selection on the collage: pointer and keyboard handling, the outline
 * drawn over the selected tile, and the Swap / Remove menu. The state
 * machine is in selection.ts (pure); this module is the DOM around it.
 *
 * Everything is drawn as overlay elements over the canvas, never into it, so
 * the canvas pixels (and later the export) are untouched by selection.
 *
 * Selection is view state, not part of the EditorState: it makes no undo
 * steps and is not saved. It is cleared when the arrangement changes (a
 * re-roll, or anything else that replaces the plan or the assignment) and
 * when the selected photo leaves the collage.
 *
 * For issue #9 (zoom and pan on the selected tile): `selectedTile()` gives
 * the selected photo and its tile in canvas pixels; `onChange` reports each
 * selection change. Pointer handling for a drag on the selected tile can be
 * added next to `onClick` here (a pan gesture should suppress the click that
 * ends it).
 */
import type { PhotoStore } from '../photos';
import type { Tile } from '../layout';
import {
  initialSelection,
  moveFocus,
  reduceSelection,
  type FocusDirection,
  type SelectionEvent,
  type SelectionState,
} from './selection';
import { swapTiles, type EditorState } from './state';
import type { EditorStore, ImportActivity } from './store';
import type { FrameScheduler } from './frames';
import { createTileCrop } from './tile-crop';
import type { CollageView } from './view';

/** Said (toast and screen reader) when an include change waits for an import. */
export const SELECTION_DEFERRED =
  'Changes to the selection apply when the import finishes.';

export interface TileSelectionOptions {
  readonly doc: Document;
  readonly view: CollageView;
  readonly editor: EditorStore;
  readonly photos: Pick<PhotoStore, 'getPhoto' | 'setIncluded'>;
  /** Coalesces the crop gestures' redraws into frames. */
  readonly frames: Pick<FrameScheduler, 'request' | 'cancel'>;
  /**
   * Where keyboard focus goes if the collage becomes empty while the canvas
   * has it (the canvas is hidden then, and focus would fall to the page).
   */
  readonly emptyFocus?: () => HTMLElement | null;
  /** While an import runs, include changes wait for it (see store.ts). */
  readonly imports?: Pick<ImportActivity, 'isBusy'>;
  /**
   * An extra sentence for a photo's description (the low-resolution
   * warning, #15), or null. Spoken with the tile's name when it is focused.
   */
  readonly warningFor?: (photoId: string) => string | null;
}

export interface TileSelection {
  /** The current selection state. */
  getSelection(): SelectionState;
  /** The selected photo and its tile (canvas pixels), if any. */
  selectedTile(): { readonly photoId: string; readonly tile: Tile } | null;
  /** Clears the selection and any pending swap. */
  clear(): void;
  /** Called after every change of the selection state. */
  onChange(listener: (state: SelectionState) => void): () => void;
}

const ARROWS: Readonly<Record<string, FocusDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export function createTileSelection(
  options: TileSelectionOptions,
): TileSelection {
  const { doc, view, editor, photos } = options;
  const { canvas } = view;
  const win = doc.defaultView as Window;

  let selection: SelectionState = initialSelection;
  const listeners = new Set<(state: SelectionState) => void>();
  /** The photo keyboard focus is on, in the canvas. */
  let focusedId: string | null = null;
  /** Where the focused tile was, as fractions of the canvas. */
  let focusCentre: { x: number; y: number } | null = null;
  /** The canvas has focus (kept while it is hidden for an empty collage). */
  let canvasFocused = false;
  /** Whether to draw the focus ring: keyboard use, not mouse. */
  let keyboardMode = false;
  /** The arrangement the selection was made in. */
  let arrangement: Pick<EditorState, 'plan' | 'assignment'> = editor.getState();

  // --- DOM ---
  const selectedBox = doc.createElement('div');
  selectedBox.className = 'tile-outline';
  selectedBox.hidden = true;
  const focusBox = doc.createElement('div');
  focusBox.className = 'tile-focus';
  focusBox.hidden = true;

  const menu = doc.createElement('div');
  menu.className = 'tile-menu';
  menu.setAttribute('role', 'group');
  menu.hidden = true;
  const swapButton = doc.createElement('button');
  swapButton.type = 'button';
  swapButton.textContent = 'Swap';
  swapButton.title = 'Swap this photo with another tile';
  const removeButton = doc.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = 'Remove';
  removeButton.title = 'Take this photo out of the collage';
  const actions = doc.createElement('div');
  actions.className = 'tile-menu-actions';
  actions.append(swapButton, removeButton);
  const hint = doc.createElement('p');
  hint.className = 'tile-menu-hint';
  hint.textContent = 'Choose a tile to swap with. Esc to cancel.';
  const cancelButton = doc.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  const pending = doc.createElement('div');
  pending.className = 'tile-menu-pending';
  pending.append(hint, cancelButton);
  const crop = createTileCrop({
    doc,
    view,
    editor,
    photos,
    frames: options.frames,
    selected: () => {
      if (selection.kind === 'idle') return null;
      const tile = tileOf(selection.photoId);
      return tile
        ? {
            photoId: selection.photoId,
            tile,
            swapping: selection.kind === 'swapping',
          }
        : null;
    },
  });
  menu.append(actions, crop.controls, pending);

  const live = doc.createElement('span');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');

  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', 'collage');
  view.element.append(selectedBox, focusBox, menu, live);

  // --- Geometry ---
  const slotOf = (photoId: string): number =>
    (view.lastRender()?.state.assignment ?? []).indexOf(photoId);

  function tileOf(photoId: string): Tile | null {
    const last = view.lastRender();
    if (!last) return null;
    const slot = last.state.assignment.indexOf(photoId);
    return last.tiles.find((tile) => tile.slot === slot) ?? null;
  }

  /** A tile's box in CSS pixels, relative to the collage element. */
  function boxOf(tile: Tile): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const rect = canvas.getBoundingClientRect();
    const origin = view.element.getBoundingClientRect();
    const sx = rect.width / canvas.width;
    const sy = rect.height / canvas.height;
    return {
      left: rect.left - origin.left + tile.x * sx,
      top: rect.top - origin.top + tile.y * sy,
      width: tile.width * sx,
      height: tile.height * sy,
    };
  }

  function place(el: HTMLElement, tile: Tile | null): void {
    el.hidden = tile === null;
    if (!tile) return;
    const box = boxOf(tile);
    el.style.left = `${String(box.left)}px`;
    el.style.top = `${String(box.top)}px`;
    el.style.width = `${String(box.width)}px`;
    el.style.height = `${String(box.height)}px`;
  }

  /** Puts the menu just below the tile (above if no room), inside the viewport. */
  function placeMenu(tile: Tile): void {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / canvas.width;
    const sy = rect.height / canvas.height;
    const left = rect.left + tile.x * sx;
    const top = rect.top + tile.y * sy;
    const width = tile.width * sx;
    const height = tile.height * sy;
    const viewportW = win.innerWidth;
    const viewportH = win.innerHeight;
    const gap = 6;
    const m = menu.getBoundingClientRect();
    let y = top + height + gap;
    if (y + m.height > viewportH - gap) y = top - m.height - gap;
    if (y < gap) {
      // No room above or below: overlap the tile, as low as fits.
      y = Math.min(top + height - m.height - gap, viewportH - m.height - gap);
    }
    y = Math.max(gap, y);
    let x = left + width / 2 - m.width / 2;
    x = Math.max(gap, Math.min(x, viewportW - m.width - gap));
    menu.style.left = `${String(x)}px`;
    menu.style.top = `${String(y)}px`;
  }

  // --- Description for assistive technology ---
  function describe(photoId: string): string {
    const last = view.lastRender();
    const name = photos.getPhoto(photoId)?.file.name ?? 'photo';
    const position = slotOf(photoId) + 1;
    const total = last?.state.assignment.length ?? 0;
    let text = `${name}, tile ${String(position)} of ${String(total)}`;
    const warning = options.warningFor?.(photoId);
    if (warning) text += `. ${warning.replace(/\.$/, '')}`;
    if (selection.kind === 'selected' && selection.photoId === photoId) {
      text += ', selected';
    } else if (selection.kind === 'swapping' && selection.photoId === photoId) {
      text += ', selected, waiting for a tile to swap with';
    }
    return text;
  }

  let announced = '';
  function announce(text: string): void {
    // A repeated message must still be spoken: change the node's content.
    live.textContent = text === announced ? `${text}.` : text;
    announced = live.textContent;
  }

  // --- Drawing the overlays ---
  function refresh(): void {
    const last = view.lastRender();
    const total = last?.state.assignment.length ?? 0;

    // The collage became empty under keyboard focus: hand focus to another
    // control rather than let it fall to the page.
    if (canvas.hidden && canvasFocused) {
      canvasFocused = false;
      options.emptyFocus?.()?.focus();
    }

    // Keep keyboard focus on a tile that exists: if the focused photo left
    // the collage (Remove, or a re-roll) while the canvas has focus, move to
    // the tile nearest to where it was.
    if (focusedId !== null && tileOf(focusedId) === null) {
      focusedId = null;
      if (canvasFocused && last && focusCentre) {
        let best = Infinity;
        for (const tile of last.tiles) {
          const dx = (tile.x + tile.width / 2) / canvas.width - focusCentre.x;
          const dy = (tile.y + tile.height / 2) / canvas.height - focusCentre.y;
          if (dx * dx + dy * dy < best) {
            best = dx * dx + dy * dy;
            focusedId = last.state.assignment[tile.slot] ?? null;
          }
        }
      }
    }
    const focusedTile = focusedId === null ? null : tileOf(focusedId);
    if (focusedTile) {
      focusCentre = {
        x: (focusedTile.x + focusedTile.width / 2) / canvas.width,
        y: (focusedTile.y + focusedTile.height / 2) / canvas.height,
      };
    }

    const picked = selection.kind === 'idle' ? null : selection.photoId;
    const tile = picked === null ? null : tileOf(picked);
    place(selectedBox, tile);
    selectedBox.classList.toggle('swapping', selection.kind === 'swapping');

    const focusTile =
      keyboardMode && focusedId !== null && doc.activeElement === canvas
        ? tileOf(focusedId)
        : null;
    place(focusBox, focusTile);

    menu.hidden = tile === null;
    actions.hidden = selection.kind !== 'selected';
    crop.controls.hidden = selection.kind !== 'selected';
    pending.hidden = selection.kind !== 'swapping';
    if (tile && picked !== null) {
      const name = photos.getPhoto(picked)?.file.name ?? 'photo';
      menu.setAttribute('aria-label', `Actions for ${name}`);
      placeMenu(tile);
    }

    const base = `Collage of ${String(total)} ${total === 1 ? 'photo' : 'photos'}.`;
    const target = focusedId ?? picked;
    canvas.setAttribute(
      'aria-label',
      target === null
        ? `${base} Use the arrow keys to move between tiles and Enter to select one.`
        : `${base} ${describe(target)}.`,
    );
    canvas.classList.toggle('swap-pending', selection.kind === 'swapping');
  }

  function setSelection(next: SelectionState): void {
    if (next === selection) return;
    const before = selection;
    selection = next;
    if (next.kind !== 'idle') focusedId = next.photoId;
    arrangement = editor.getState();
    crop.flush();
    refresh();
    crop.refresh();
    if (next.kind === 'selected') {
      announce(
        `${describe(next.photoId)}. Tab for Swap, Remove, Zoom and Reset. Shift and the arrow keys pan, plus and minus zoom.`,
      );
    } else if (next.kind === 'swapping') {
      announce(
        `Swap ${describe(next.photoId)}. Move to another tile and press Enter, or Escape to cancel.`,
      );
    } else if (before.kind !== 'idle') {
      announce('Selection cleared.');
    }
    for (const listener of [...listeners]) listener(selection);
  }

  function send(event: SelectionEvent): void {
    const result = reduceSelection(selection, event);
    if (result.effect) {
      const { from, to } = result.effect;
      // Set first, so the commit's notification finds an idle selection.
      setSelection(result.state);
      const assignment = editor.getState().assignment;
      const a = assignment.indexOf(from);
      const b = assignment.indexOf(to);
      if (a >= 0 && b >= 0) {
        editor.dispatch((state) => swapTiles(state, a, b));
        announce(
          `Swapped ${photos.getPhoto(from)?.file.name ?? 'photo'} with ${photos.getPhoto(to)?.file.name ?? 'photo'}.`,
        );
      }
      return;
    }
    setSelection(result.state);
  }

  // --- Pointer ---
  canvas.addEventListener('click', (event) => {
    keyboardMode = false;
    // The click that ends a pan is not a click on the tile.
    if (crop.consumeClick()) return;
    const hit = view.tileAtClientPoint(event.clientX, event.clientY);
    // A click in a gap or the border changes nothing.
    if (hit) {
      focusedId = hit.photoId;
      send({ type: 'tile', photoId: hit.photoId });
    }
  });
  canvas.addEventListener('pointerdown', () => {
    keyboardMode = false;
  });
  // A click anywhere else (not the canvas, not the menu) is a click away.
  doc.addEventListener('click', (event) => {
    const target = event.target;
    if (
      selection.kind === 'idle' ||
      (target instanceof Node &&
        (canvas.contains(target) || menu.contains(target)))
    ) {
      return;
    }
    send({ type: 'dismiss' });
  });

  // --- Menu ---
  swapButton.addEventListener('click', () => {
    send({ type: 'choose-swap' });
    canvas.focus();
  });
  cancelButton.addEventListener('click', () => {
    send({ type: 'dismiss' });
    canvas.focus();
  });
  removeButton.addEventListener('click', () => {
    if (selection.kind !== 'selected') return;
    const { photoId } = selection;
    const name = photos.getPhoto(photoId)?.file.name ?? 'photo';
    setSelection(initialSelection);
    // Exactly as unticking it in the tray: the editor follows the photo
    // store (and re-rolls) in its next sync.
    photos.setIncluded(photoId, false);
    announce(
      options.imports?.isBusy()
        ? SELECTION_DEFERRED
        : `Removed ${name} from the collage.`,
    );
    canvas.focus();
  });

  // --- Keyboard ---
  canvas.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = view.lastRender();
    if (!last || last.tiles.length === 0) return;
    if (crop.handleKey(event)) return;
    const direction = ARROWS[event.key];
    if (direction && !event.shiftKey) {
      event.preventDefault();
      keyboardMode = true;
      const from = focusedId === null ? null : tileOf(focusedId);
      const next = from
        ? moveFocus(last.tiles, from, direction)
        : last.tiles[0];
      const photoId = next ? last.state.assignment[next.slot] : undefined;
      if (photoId !== undefined) focusedId = photoId;
      refresh();
      if (photoId !== undefined) announce(describe(photoId));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      keyboardMode = true;
      if (focusedId === null) {
        const first = last.state.assignment[last.tiles[0]?.slot ?? 0];
        if (first !== undefined) focusedId = first;
        refresh();
        if (focusedId !== null) announce(describe(focusedId));
        return;
      }
      send({ type: 'tile', photoId: focusedId });
    }
  });
  canvas.addEventListener('focus', () => {
    // Keyboard focus (not a mouse click) shows the focus indicator at once,
    // before any arrow key.
    canvasFocused = true;
    keyboardMode = canvas.matches(':focus-visible');
    if (focusedId === null && selection.kind !== 'idle') {
      focusedId = selection.photoId;
    }
    if (focusedId === null) {
      const slot = view.lastRender()?.tiles[0]?.slot;
      const first =
        slot === undefined
          ? undefined
          : view.lastRender()?.state.assignment[slot];
      if (first !== undefined) focusedId = first;
    }
    refresh();
  });
  canvas.addEventListener('blur', () => {
    // Hiding the canvas can blur it; that is not the user moving away.
    if (!canvas.hidden) canvasFocused = false;
    refresh();
  });

  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || selection.kind === 'idle') return;
    const inMenu = menu.contains(doc.activeElement);
    send({ type: 'dismiss' });
    if (inMenu) canvas.focus();
  });

  // --- Keeping in step with the editor and the view ---
  editor.subscribe((state) => {
    // A re-roll (or anything that replaces the plan or the assignment, such
    // as undo later) invalidates the selection.
    if (
      state.plan !== arrangement.plan ||
      state.assignment !== arrangement.assignment
    ) {
      arrangement = state;
      if (selection.kind !== 'idle') send({ type: 'dismiss' });
    }
  });
  view.onRender(() => {
    const last = view.lastRender();
    if (
      selection.kind !== 'idle' &&
      !(last?.state.assignment.includes(selection.photoId) ?? false)
    ) {
      send({ type: 'dismiss' });
      return;
    }
    refresh();
  });
  win.addEventListener('resize', refresh);

  return {
    getSelection: () => selection,
    selectedTile() {
      if (selection.kind === 'idle') return null;
      const tile = tileOf(selection.photoId);
      return tile ? { photoId: selection.photoId, tile } : null;
    },
    clear() {
      send({ type: 'dismiss' });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
