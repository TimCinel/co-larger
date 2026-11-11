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
  createUndoControls,
  createTileSelection,
  SELECTION_DEFERRED,
  EditorStore,
  FrameScheduler,
  type CollageView,
  type TileSelection,
  type UndoControls,
} from './editor';
import { browserDeps, createExportControls } from './export';
import {
  classifyDrop,
  createProjectControls,
  type ProjectControls,
} from './project';
import { installDropTarget } from './ui/dropzone';
import { createNotices, summaryMessages } from './ui/notices';
import { createTray } from './ui/tray';
import { createVersionLink } from './version';

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
  /** Undo and redo: the history of committed changes. */
  readonly undo: UndoControls;
  /** Save and open project (#12). */
  readonly project: ProjectControls;
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
  const importer = new PhotoImporter(store, {
    decode: options.decode ?? decodePhoto,
  });
  // Tray changes reach the editor once per frame, and not at all while an
  // import runs: the collage is laid out once, when the import finishes.
  const editor = new EditorStore({
    photoStore: store,
    imports: importer,
    scheduleSync: (sync) => {
      frames.request('photos', sync);
    },
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

  // The version sits beside the title, in the top bar, so it takes no space
  // from the collage, the tray or the settings panel.
  const brand = doc.createElement('div');
  brand.className = 'brand';
  brand.append(title, createVersionLink(doc, APP_NAME));

  header.append(
    brand,
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
    imports: importer,
    frames,
    emptyFocus: () => addButton,
  });
  // Opening a project resets the undo history on purpose: no toast for it.
  let installing = false;
  const undo = createUndoControls({
    doc,
    editor,
    photos: store,
    imports: importer,
    frames,
    selection,
    canvas: view.canvas,
    notify: (message) => {
      if (!installing) notices.show(message);
    },
    announce: (text) => {
      announcer.textContent = text;
    },
  });
  layoutControls.after(undo.element);
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
  const settings = createCanvasSettings(doc, editor, frames);
  const project = createProjectControls({
    doc,
    editor,
    photos: store,
    imports: importer,
    decode: options.decode ?? decodePhoto,
    install: (opened, fileName) => {
      // One synchronous swap, held as an import so the collage is laid out
      // once, already in its saved arrangement: no frame is drawn between
      // the steps, the editor's sync finds the restored sets equal, and the
      // history restarts without a toast.
      installing = true;
      const release = importer.hold();
      try {
        store.clear();
        store.addPhotos(opened.photos);
        editor.restore(opened.state);
      } finally {
        release();
        installing = false;
      }
      announcer.textContent = `Opened ${fileName}`;
    },
    onBusyChange: (busy) => {
      addButton.disabled = busy;
    },
    notify: (message) => {
      notices.show(message);
    },
  });
  settings
    .querySelector('.settings-footer')
    ?.append(
      project.element,
      createExportControls({ doc, editor, photos: store, deps: browserDeps })
        .element,
    );
  workspace.append(settings, stage);
  shell.append(header, workspace);
  root.replaceChildren(shell);

  // Include changes (tile Remove, tray toggles, Remove all, Add all) wait
  // for a running import: say so once per import.
  let toldDeferred = false;
  store.subscribe((change) => {
    if (change.kind !== 'included' || !importer.isBusy() || toldDeferred) {
      return;
    }
    toldDeferred = true;
    notices.show(SELECTION_DEFERRED);
  });
  importer.subscribe(() => {
    if (!importer.isBusy()) toldDeferred = false;
  });

  const addFiles = (files: File[], folders: string[] = []): void => {
    if (project.isBusy()) {
      notices.show('Wait for the project to finish opening or saving.');
      return;
    }
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
    // A lone zip is a project to open; anything else is photos.
    const dropped = classifyDrop(files);
    if (dropped.project) {
      project.openFile(dropped.project);
      return;
    }
    if (dropped.ignoredZips.length > 0) {
      notices.show(
        'To open a project, drop its .zip on its own, without photos.',
      );
    }
    if (dropped.photos.length > 0 || folders.length > 0) {
      addFiles(dropped.photos, folders);
    }
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
  return { store, editor, view, selection, undo, project };
}
