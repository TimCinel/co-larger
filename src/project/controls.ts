/**
 * The Project section of the settings panel (#12): Save and Open, with
 * progress and Cancel.
 *
 * - Save streams the zip to a file chosen with the browser's save dialog
 *   where there is one (showSaveFilePicker, so the archive never sits in
 *   memory), and otherwise builds a Blob chunk by chunk and downloads it.
 *   It reads the editor and the photo store at the click and nothing after,
 *   and never changes them.
 * - Open shows a modal dialog (so nothing else can be edited while the
 *   project loads, which keeps Cancel simple and the result exactly what
 *   was saved), asks first if there are photos to replace, and builds the
 *   project off to the side (openProject). Only a fully loaded and checked
 *   project is handed to `install`; every failure, and Cancel, leaves the
 *   current project untouched. Errors are shown in the dialog.
 *
 * Both are disabled while an import runs, and while either one runs. An
 * export may run beside a save: both only read.
 */
import { downloadBlob } from '../export/controls';
import type { EditorStore } from '../editor/store';
import type { Decoder } from '../photos/decode';
import type { PhotoStore } from '../photos/store';
import { BackingFileError } from '../photos/backing';
import { ProjectError } from './format';
import { openProject, type OpenedProject } from './open';
import {
  planSave,
  PROJECT_FILE_NAME,
  reboundFiles,
  saveProjectStream,
} from './save';
import { streamToBlob } from './zip';

/** The part of the File System Access API's file handle that is used. */
export interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
  getFile(): Promise<File>;
}

/** Asks the user where to save; null if the browser has no such dialog. */
export type PickSaveFile = (
  suggestedName: string,
) => Promise<SaveFileHandle> | null;

interface PickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<SaveFileHandle>;
}

/** The browser's own save dialog, where it has one (Chrome and Edge). */
export const browserPickSaveFile: PickSaveFile = (suggestedName) => {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  return picker.call(window, {
    suggestedName,
    types: [
      {
        description: 'co-larger project',
        accept: { 'application/zip': ['.zip'] },
      },
    ],
  });
};

export interface ProjectControls {
  readonly element: HTMLElement;
  /** Opens a project file, as if chosen with Open (a dropped zip). */
  openFile(file: File): void;
  /** True while a save or an open is running. */
  isBusy(): boolean;
}

export interface ProjectControlsOptions {
  readonly doc: Document;
  readonly editor: Pick<
    EditorStore,
    'getState' | 'subscribe' | 'commitPending'
  >;
  readonly photos: Pick<
    PhotoStore,
    'getPhotos' | 'getTotalCount' | 'subscribe' | 'rebindFiles'
  >;
  readonly imports: {
    isBusy(): boolean;
    subscribe(listener: () => void): () => void;
  };
  readonly decode: Decoder;
  /**
   * Replaces the current project with the opened one, in one step. Called
   * only with a fully loaded and validated project.
   */
  readonly install: (project: OpenedProject, fileName: string) => void;
  /** Asks where to save. Defaults to the browser's save dialog. */
  readonly pickSaveFile?: PickSaveFile;
  /** Tells others when a project operation starts or ends. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Shows a short message that does not need an answer. */
  readonly notify: (message: string) => void;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

interface DialogButton {
  readonly label: string;
  readonly primary?: boolean;
  readonly value: string;
}

interface DialogContent {
  readonly title: string;
  readonly body: string;
  readonly bar?: boolean;
  readonly buttons: readonly DialogButton[];
}

export function createProjectControls(
  options: ProjectControlsOptions,
): ProjectControls {
  const { doc, editor, photos, imports, decode } = options;
  const pickSaveFile = options.pickSaveFile ?? browserPickSaveFile;

  const element = doc.createElement('section');
  element.className = 'settings-section project-section';
  element.setAttribute('aria-labelledby', 'settings-project');
  const heading = doc.createElement('h2');
  heading.id = 'settings-project';
  heading.textContent = 'Project';

  const buttons = doc.createElement('div');
  buttons.className = 'project-buttons';
  const saveButton = doc.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'project-save';
  saveButton.textContent = 'Save';
  saveButton.setAttribute('aria-label', 'Save project');
  const openButton = doc.createElement('button');
  openButton.type = 'button';
  openButton.className = 'project-open';
  openButton.textContent = 'Open…';
  openButton.setAttribute('aria-label', 'Open project');
  buttons.append(saveButton, openButton);

  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.hidden = true;
  input.className = 'project-input';
  input.setAttribute('aria-label', 'Choose a project file');

  const hint = doc.createElement('p');
  hint.className = 'project-hint';
  hint.id = 'project-hint';
  saveButton.setAttribute('aria-describedby', hint.id);

  const running = doc.createElement('div');
  running.className = 'project-running';
  running.hidden = true;
  const bar = doc.createElement('progress');
  bar.className = 'project-progress';
  bar.setAttribute('aria-label', 'Save progress');
  const runningText = doc.createElement('span');
  runningText.setAttribute('aria-hidden', 'true');
  const cancelSave = doc.createElement('button');
  cancelSave.type = 'button';
  cancelSave.textContent = 'Cancel';
  running.append(bar, runningText, cancelSave);

  const status = doc.createElement('p');
  status.className = 'project-status';
  status.setAttribute('role', 'status');
  const failure = doc.createElement('p');
  failure.className = 'project-error';
  failure.setAttribute('role', 'alert');

  element.append(heading, buttons, input, hint, running, status, failure);

  // --- The dialog: confirm, progress and error, one modal element ---------
  const dialog = doc.createElement('dialog');
  dialog.className = 'project-dialog';
  dialog.setAttribute('aria-labelledby', 'project-dialog-title');
  const dialogTitle = doc.createElement('h2');
  dialogTitle.id = 'project-dialog-title';
  const dialogBody = doc.createElement('p');
  dialogBody.className = 'project-dialog-body';
  dialogBody.setAttribute('role', 'status');
  const dialogBar = doc.createElement('progress');
  dialogBar.setAttribute('aria-label', 'Open progress');
  const dialogActions = doc.createElement('div');
  dialogActions.className = 'project-dialog-actions';
  dialog.append(dialogTitle, dialogBody, dialogBar, dialogActions);
  element.append(dialog);

  let answer: ((value: string) => void) | null = null;
  let cancelValue: string | null = null;

  function setDialog(content: DialogContent): Promise<string> {
    dialogTitle.textContent = content.title;
    dialogBody.textContent = content.body;
    dialogBar.hidden = !content.bar;
    dialogActions.replaceChildren();
    const first = content.buttons[0];
    cancelValue = first?.primary ? null : (first?.value ?? null);
    for (const spec of content.buttons) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = spec.label;
      if (spec.primary) button.classList.add('primary');
      button.addEventListener('click', () => {
        answer?.(spec.value);
      });
      dialogActions.append(button);
    }
    if (!dialog.open) dialog.showModal();
    // The safe choice has focus: Enter never replaces a project by accident.
    dialogActions.querySelector('button')?.focus();
    return new Promise((resolve) => {
      answer = resolve;
    });
  }
  // Escape means the first, non-primary button (Cancel or OK).
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (cancelValue !== null) answer?.(cancelValue);
  });
  function closeDialog(): void {
    answer = null;
    if (dialog.open) dialog.close();
  }

  // --- State ---------------------------------------------------------------
  let saving: AbortController | null = null;
  let opening: AbortController | null = null;

  const busy = (): boolean => saving !== null || opening !== null;

  function sync(): void {
    const importing = imports.isBusy();
    const working = busy();
    saveButton.disabled = working || importing || photos.getTotalCount() === 0;
    openButton.disabled = working || importing;
    cancelSave.hidden = saving === null;
    running.hidden = saving === null;
    hint.textContent =
      photos.getTotalCount() === 0
        ? 'Open a saved project, or add photos to start one.'
        : importing
          ? 'Wait for the import to finish to save or open a project.'
          : 'A project is one zip: your original photos and the collage.';
  }

  const setBusy = (): void => {
    sync();
    options.onBusyChange?.(busy());
  };

  // --- Save ----------------------------------------------------------------
  saveButton.addEventListener('click', () => {
    if (busy() || imports.isBusy()) return;
    failure.textContent = '';
    status.textContent = '';
    // Take what is on screen: finish any gesture, then snapshot.
    editor.commitPending();
    const state = editor.getState();
    const all = photos.getPhotos();
    let plan;
    try {
      plan = planSave(state, all);
    } catch (error) {
      failure.textContent =
        error instanceof Error ? error.message : 'Could not save the project.';
      return;
    }
    const run = new AbortController();
    saving = run;
    bar.max = plan.totalBytes;
    bar.value = 0;
    runningText.textContent = 'Starting…';
    status.textContent = 'Saving the project';
    setBusy();
    // Called straight from the click, as the save dialog requires.
    const picked = pickSaveFile(PROJECT_FILE_NAME);
    void (async () => {
      try {
        const handle = picked ? await picked : null;
        const stream = saveProjectStream(plan, {
          signal: run.signal,
          onProgress: (bytes, done) => {
            bar.value = bytes;
            runningText.textContent = `Saving ${megabytes(bytes)} / ${megabytes(plan.totalBytes)} (${String(done)} / ${String(all.length)} photos)`;
          },
        });
        let size: number;
        if (handle) {
          // The file may be the very zip the photos were opened from, and
          // those photos read from it while this writes. That is safe because
          // createWritable() (no `keepExistingData`) writes to a separate
          // swap file and replaces the target only when it is closed: until
          // then every read of the original sees the original. So there is
          // no in-place write, and any failure or Cancel aborts the writable,
          // which discards the swap file and leaves the target untouched.
          const writable = await handle.createWritable();
          try {
            await stream.pipeTo(writable, { signal: run.signal });
          } catch (error) {
            await writable.abort(error).catch(() => undefined);
            throw error;
          }
          // The target now holds the new zip, so photos that were slices of
          // the old file may be invalid. Point every photo at the new file.
          const written = await handle.getFile();
          size = written.size;
          try {
            photos.rebindFiles(await reboundFiles(plan, written));
          } catch (error) {
            const reason = error instanceof Error ? error.message : '';
            throw new ProjectError(
              `The project was saved, but could not be read back (${reason}). Open it again from the saved file before continuing.`,
            );
          }
        } else {
          // The download path: the whole zip is assembled in a Blob from
          // readable sources first, and only a complete Blob is handed to the
          // browser, which writes it to a temporary download file and renames
          // it. A source that cannot be read fails the save before any
          // download starts, and the source is never also the output.
          const blob = await streamToBlob(stream);
          run.signal.throwIfAborted();
          downloadBlob(doc, blob, PROJECT_FILE_NAME);
          size = blob.size;
        }
        status.textContent = `Saved ${PROJECT_FILE_NAME}: ${String(all.length)} photos, ${megabytes(size)}`;
      } catch (error) {
        status.textContent = '';
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancelled in the save dialog, or with Cancel.
          status.textContent = run.signal.aborted ? 'Save cancelled' : '';
        } else if (run.signal.aborted) {
          status.textContent = 'Save cancelled';
        } else {
          failure.textContent =
            error instanceof ProjectError || error instanceof BackingFileError
              ? error.message
              : 'Could not save the project. A photo may have been moved or changed on disk since it was added.';
        }
      } finally {
        saving = null;
        setBusy();
      }
    })();
  });
  cancelSave.addEventListener('click', () => {
    saving?.abort();
  });

  // --- Open ----------------------------------------------------------------
  async function runOpen(file: File): Promise<void> {
    if (busy() || imports.isBusy()) {
      options.notify(
        'Wait for the current import or project operation to finish first.',
      );
      return;
    }
    failure.textContent = '';
    status.textContent = '';
    const run = new AbortController();
    opening = run;
    setBusy();
    try {
      const count = photos.getTotalCount();
      if (count > 0) {
        const choice = await setDialog({
          title: 'Replace the current project?',
          body: `Opening ${file.name} replaces the ${String(count)} ${count === 1 ? 'photo' : 'photos'} and the collage you have now. Save first if you want to keep them.`,
          buttons: [
            { label: 'Keep current project', value: 'cancel' },
            {
              label: 'Replace with this project',
              value: 'open',
              primary: true,
            },
          ],
        });
        if (choice !== 'open') return;
      }
      const cancelled = (): void => {
        dialogBody.textContent = 'Cancelling…';
        for (const button of dialogActions.querySelectorAll('button')) {
          button.disabled = true;
        }
        run.abort();
      };
      void setDialog({
        title: 'Opening project',
        body: 'Reading the project…',
        bar: true,
        buttons: [{ label: 'Cancel', value: 'cancel' }],
      }).then(cancelled);
      dialogBar.removeAttribute('value');
      const opened = await openProject(file, {
        decode,
        signal: run.signal,
        onProgress: ({ done, total }) => {
          dialogBar.max = total;
          dialogBar.value = done;
          dialogBody.textContent = `Preparing photos: ${String(done)} / ${String(total)}`;
        },
      });
      run.signal.throwIfAborted();
      options.install(opened, file.name);
      closeDialog();
      status.textContent = `Opened ${file.name}: ${String(opened.photos.length)} photos`;
    } catch (error) {
      if (run.signal.aborted) {
        closeDialog();
        status.textContent =
          'Open cancelled. Your current project is unchanged.';
        return;
      }
      const message =
        error instanceof ProjectError || error instanceof BackingFileError
          ? error.message
          : 'Could not open this file.';
      status.textContent = '';
      failure.textContent = `${message} Your current project is unchanged.`;
      await setDialog({
        title: 'Could not open the project',
        body: `${message} Your current project is unchanged.`,
        buttons: [{ label: 'OK', value: 'ok' }],
      });
      closeDialog();
    } finally {
      closeDialog();
      opening = null;
      setBusy();
    }
  }

  openButton.addEventListener('click', () => {
    input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void runOpen(file);
  });

  imports.subscribe(sync);
  photos.subscribe(sync);
  editor.subscribe(sync);
  sync();
  return {
    element,
    openFile(file) {
      void runOpen(file);
    },
    isBusy: busy,
  };
}
