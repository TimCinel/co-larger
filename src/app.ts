import {
  decodePhoto,
  PhotoImporter,
  PhotoStore,
  type Decoder,
  type ImportProgress,
} from './photos';
import { installDropTarget } from './ui/dropzone';
import { createNotices, summaryMessages } from './ui/notices';
import { createTray } from './ui/tray';

export const APP_NAME = 'co-larger';

export interface AppOptions {
  readonly store?: PhotoStore;
  readonly decode?: Decoder;
}

/**
 * Renders the app into `root`, replacing its contents: a top bar with the
 * "Add photos" button, the main area (the collage canvas arrives in issue #5)
 * and the tray below it. Returns the photo store so later code can build on it.
 */
export function renderApp(
  root: HTMLElement,
  options: AppOptions = {},
): PhotoStore {
  const doc = root.ownerDocument;
  const store = options.store ?? new PhotoStore();
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
  progressText.setAttribute('role', 'status');
  progress.append(bar, progressText);

  header.append(title, addButton, progress, input);

  const notices = createNotices(doc);

  // Main area: placeholder for the collage canvas.
  const main = doc.createElement('main');
  main.className = 'canvas-area';
  const hint = doc.createElement('p');
  hint.className = 'canvas-hint';
  hint.textContent = 'Drop photos anywhere on this page, or use Add photos.';
  const dropOverlay = doc.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.textContent = 'Drop photos to add them';
  main.append(hint, dropOverlay);

  const tray = createTray(doc, store);

  shell.append(header, notices.element, main, tray);
  root.replaceChildren(shell);

  const addFiles = (files: File[]): void => {
    void importer.enqueue(files).then((summary) => {
      for (const message of summaryMessages(summary)) notices.show(message);
    });
  };

  input.addEventListener('change', () => {
    addFiles(Array.from(input.files ?? []));
    // Reset so picking the same files again still fires `change`.
    input.value = '';
  });
  installDropTarget(doc, shell, addFiles);

  const showProgress = (state: ImportProgress): void => {
    progress.hidden = !state.active;
    bar.max = state.total;
    bar.value = state.done;
    progressText.textContent = `Importing ${String(state.done)} / ${String(state.total)}`;
  };
  importer.subscribe(showProgress);

  // The drop overlay is shown through the `dragging` class on the shell.
  return store;
}
