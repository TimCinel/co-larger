import {
  decodePhoto,
  PhotoImporter,
  PhotoStore,
  type Decoder,
  type ImportProgress,
} from './photos';
import {
  createCanvasSettings,
  createCollageView,
  createLayoutControls,
  createSizeReadout,
  createTileSelection,
  EditorStore,
  FrameScheduler,
  type CollageView,
  type TileSelection,
} from './editor';
import { installDropTarget } from './ui/dropzone';
import { createNotices, summaryMessages } from './ui/notices';
import { createTray } from './ui/tray';

export const APP_NAME = 'co-larger';

export interface AppOptions {
  readonly store?: PhotoStore;
  readonly decode?: Decoder;
}

/** What renderApp returns, for later code (and tests) to build on. */
export interface App {
  /** The photos: files, previews, thumbnails, included flags. */
  readonly store: PhotoStore;
  /** The editor state: canvas, dial, seed, arrangement, crops. */
  readonly editor: EditorStore;
  /** The collage canvas in the main area. */
  readonly view: CollageView;
  /** Which tile is selected, and the Swap / Remove menu. */
  readonly selection: TileSelection;
}

/**
 * Renders the app into `root`, replacing its contents: a top bar with the
 * "Add photos" button, the output size and the layout controls; beside the
 * canvas settings panel, the main area with the collage and the tray below
 * it.
 */
export function renderApp(root: HTMLElement, options: AppOptions = {}): App {
  const doc = root.ownerDocument;
  const store = options.store ?? new PhotoStore();
  const frames = new FrameScheduler(doc.defaultView as Window);
  // Tray changes reach the editor once per frame, so an import of many
  // photos re-rolls once per frame rather than once per photo.
  const editor = new EditorStore({
    photoStore: store,
    scheduleSync: (sync) => {
      frames.request('photos', sync);
    },
  });
  const importer = new PhotoImporter(store, {
    decode: options.decode ?? decodePhoto,
  });

  const shell = doc.createElement('div');
  shell.className = 'shell';

  // Top bar
  const header = doc.createElement('header');
  header.className = 'topbar';
  const title = doc.createElement('h1');
  title.textContent = APP_NAME;

  const input = doc.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*';
  input.hidden = true;
  input.setAttribute('aria-label', 'Choose photos');

  const addButton = doc.createElement('button');
  addButton.type = 'button';
  addButton.className = 'primary';
  addButton.textContent = 'Add photos';
  addButton.addEventListener('click', () => {
    input.click();
  });

  const progress = doc.createElement('div');
  progress.className = 'progress';
  progress.hidden = true;
  const bar = doc.createElement('progress');
  const progressText = doc.createElement('span');
  // Visual only. Announcing every photo would flood a screen reader, so the
  // live region below speaks only at the start and end of an import.
  progress.setAttribute('aria-hidden', 'true');
  progress.append(bar, progressText);
  const announcer = doc.createElement('span');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');

  const layoutControls = createLayoutControls(doc, editor, frames);

  const sizeReadout = createSizeReadout(doc, editor);

  header.append(
    title,
    sizeReadout,
    addButton,
    progress,
    announcer,
    input,
    layoutControls,
  );

  const notices = createNotices(doc);

  // Main area: the collage, or a hint when it is empty.
  const main = doc.createElement('main');
  main.className = 'canvas-area';
  const view = createCollageView({
    doc,
    editor,
    photos: store,
    frames,
    area: main,
    onImageError: (photo) => {
      notices.show(
        `Could not display ${photo.file.name}: this browser cannot decode it.`,
      );
    },
  });
  const selection = createTileSelection({
    doc,
    view,
    editor,
    photos: store,
    emptyFocus: () => addButton,
  });
  const dropOverlay = doc.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.textContent = 'Drop photos to add them';
  main.append(view.element, dropOverlay);

  const tray = createTray(doc, store);

  // Notices sit in the tray, so they never cover the collage.
  tray.append(notices.element);

  // The collage and the tray share a column; the settings panel stands
  // beside both, so the collage keeps the full height of the column.
  const stage = doc.createElement('div');
  stage.className = 'stage';
  stage.append(main, tray);
  const workspace = doc.createElement('div');
  workspace.className = 'workspace';
  // The panel comes first in the DOM, so Tab reaches it before the tray's
  // thumbnails; CSS (`order`) keeps it on the right.
  workspace.append(createCanvasSettings(doc, editor, frames), stage);
  shell.append(header, workspace);
  root.replaceChildren(shell);

  const addFiles = (files: File[], folders: string[] = []): void => {
    void importer.enqueue(files).then((summary) => {
      for (const message of summaryMessages(summary, folders)) {
        notices.show(message);
      }
    });
  };

  input.addEventListener('change', () => {
    addFiles(Array.from(input.files ?? []));
    // Reset so picking the same files again still fires `change`.
    input.value = '';
  });
  installDropTarget(doc, shell, ({ files, folders }) => {
    addFiles(files, folders);
  });

  let wasActive = false;
  const showProgress = (state: ImportProgress): void => {
    if (state.active && !wasActive) {
      announcer.textContent = `Importing ${String(state.total)} ${state.total === 1 ? 'photo' : 'photos'}`;
    } else if (!state.active && wasActive) {
      announcer.textContent = 'Import finished';
    }
    wasActive = state.active;
    progress.hidden = !state.active;
    bar.max = state.total;
    bar.value = state.done;
    progressText.textContent = `Importing ${String(state.done)} / ${String(state.total)}`;
  };
  importer.subscribe(showProgress);

  // The drop overlay is shown through the `dragging` class on the shell.
  return { store, editor, view, selection };
}
