/**
 * The top bar's Undo and Redo buttons and the keyboard shortcuts
 * (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, and Ctrl+Y off the Mac). While focus is in
 * a text field the browser keeps its own text undo. After a step the tile
 * selection (and any pending swap) is cleared, since a tile may hold another
 * photo, and a short message goes to a status region for screen readers.
 */
import type { PhotoStore } from '../photos';
import type { FrameScheduler } from './frames';
import type { TileSelection } from './tile-selection';
import type { EditorStore, ImportActivity } from './store';
import { UndoManager } from './undo-manager';

export interface UndoControlsOptions {
  readonly doc: Document;
  readonly editor: EditorStore;
  readonly photos: Pick<PhotoStore, 'subscribe' | 'getPhoto'>;
  readonly frames: Pick<FrameScheduler, 'flush'>;
  readonly selection: Pick<TileSelection, 'clear'>;
  /** Speaks a short message through the page's polite live region. */
  readonly announce: (text: string) => void;
  /** Shows a brief notice (a toast). */
  readonly notify: (message: string) => void;
  /** The collage canvas: a press on it may start a crop pan. */
  readonly canvas: HTMLElement;
  /** Undo and redo wait while an import runs. */
  readonly imports?: ImportActivity;
}

export interface UndoControls {
  readonly element: HTMLElement;
  readonly manager: UndoManager;
  /** Handles the shortcuts; true if the event was one. */
  handleKey(event: KeyboardEvent): boolean;
}

const NON_TEXT_INPUTS = new Set([
  'range',
  'color',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'image',
]);

/** Focus is somewhere the browser's own undo should handle Cmd/Ctrl+Z. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  }
  return false;
}

export function createUndoControls(options: UndoControlsOptions): UndoControls {
  const { doc, editor, selection } = options;
  const win = doc.defaultView as Window;
  const mac = /mac|iphone|ipad/i.test(win.navigator.platform);
  const mod = mac ? 'Cmd' : 'Ctrl';

  // Pointers held down on a range input (dial, border, zoom sliders) or the
  // canvas (crop pan): a continuous gesture is in progress. The native
  // colour input is left out (its popup swallows the pointer events).
  const held = new Set<number>();
  const gestureTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    if (el === options.canvas) return true;
    return el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';
  };

  const manager = new UndoManager({
    editor,
    photos: options.photos,
    imports: options.imports,
    isGestureHeld: () => held.size > 0,
    onHistoryCleared: options.notify,
    prepare: () => {
      // Ends crop gestures (a wheel burst) and clears the selection, then
      // applies queued steps of other controls and any tray sync.
      selection.clear();
      options.frames.flush();
    },
  });

  const group = doc.createElement('div');
  group.className = 'undo-controls';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'History');
  const make = (label: string, shortcut: string): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = `${label} (${shortcut})`;
    button.setAttribute('aria-keyshortcuts', shortcut.replace('Cmd', 'Meta'));
    return button;
  };
  const undoButton = make('Undo', `${mod}+Z`);
  const redoButton = make('Redo', mac ? 'Shift+Cmd+Z' : 'Ctrl+Y');
  if (!mac) redoButton.title = 'Redo (Ctrl+Shift+Z or Ctrl+Y)';
  group.append(undoButton, redoButton);

  const release = (event: Event): void => {
    if (held.delete((event as PointerEvent).pointerId)) manager.refresh();
  };
  doc.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !gestureTarget(event.target)) return;
      held.add(event.pointerId);
      manager.refresh();
    },
    true,
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    doc.addEventListener(type, release, true);
  }
  // A release outside the window may never arrive: no button down means no
  // drag, so let go.
  doc.addEventListener(
    'pointermove',
    (event) => {
      if (event.buttons === 0 && held.size > 0) {
        held.clear();
        manager.refresh();
      }
    },
    true,
  );
  win.addEventListener('blur', () => {
    if (held.size === 0) return;
    held.clear();
    manager.refresh();
  });

  const sync = (): void => {
    undoButton.disabled = !manager.canUndo();
    redoButton.disabled = !manager.canRedo();
  };
  manager.subscribe(sync);
  sync();

  const announce = (text: string): void => {
    // Clearing first makes a repeated message read again.
    options.announce('');
    options.announce(text);
  };

  function run(back: boolean): void {
    if (held.size > 0) return;
    const active = doc.activeElement;
    const result = back ? manager.undo() : manager.redo();
    sync();
    if (result === 'done') {
      announce(back ? 'Undone.' : 'Redone.');
    } else if (result === 'failed') {
      announce('Could not undo that change. History cleared.');
    } else {
      announce(back ? 'Nothing to undo.' : 'Nothing to redo.');
    }
    // A button that just became disabled drops focus: move it to the other.
    if (
      (active === undoButton && undoButton.disabled) ||
      (active === redoButton && redoButton.disabled)
    ) {
      const other = active === undoButton ? redoButton : undoButton;
      (other.disabled ? doc.body : other).focus();
    }
  }
  undoButton.addEventListener('click', () => {
    run(true);
  });
  redoButton.addEventListener('click', () => {
    run(false);
  });

  function handleKey(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.altKey) return false;
    if (isEditableTarget(event.target)) return false;
    const primary = mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!primary) return false;
    const key = event.key.toLowerCase();
    let back: boolean;
    if (key === 'z') back = !event.shiftKey;
    else if (key === 'y' && !mac && !event.shiftKey) back = false;
    else return false;
    event.preventDefault();
    // While a drag is held run() does nothing.
    run(back);
    return true;
  }
  doc.addEventListener('keydown', handleKey);

  return { element: group, manager, handleKey };
}
