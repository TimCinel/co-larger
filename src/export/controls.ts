/**
 * The Export section of the settings panel (#11): format, JPEG quality, a
 * Download button, and progress with Cancel while it runs. It only reads the
 * editor (the snapshot is taken when Download is pressed), so exporting never
 * changes the editor state or notifies its listeners, and editing during an
 * export cannot affect it.
 */
import type { EditorStore } from '../editor';
import type { Photo } from '../photos';
import { exportFileName, type ExportFormat } from './decode-size';
import {
  exportCollage,
  ExportError,
  TOO_LARGE_MESSAGE,
  type ExportDeps,
  type ExportPhoto,
  type ExportProgress,
} from './export';

export interface ExportControls {
  readonly element: HTMLElement;
}

export interface ExportControlsOptions {
  readonly doc: Document;
  readonly editor: Pick<EditorStore, 'getState' | 'subscribe'>;
  readonly photos: { getPhoto(id: string): Photo | undefined };
  readonly deps: ExportDeps;
  /** Hands the finished file to the user. Defaults to a download link. */
  readonly save?: (blob: Blob, fileName: string) => void;
}

export const DEFAULT_JPEG_QUALITY = 92;
const URL_REVOKE_DELAY_MS = 10_000;

/** Downloads `blob` through an object URL, revoked shortly after. */
export function downloadBlob(
  doc: Document,
  blob: Blob,
  fileName: string,
): void {
  const view = doc.defaultView as Window;
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  view.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, URL_REVOKE_DELAY_MS);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function createExportControls(
  options: ExportControlsOptions,
): ExportControls {
  const { doc, editor, photos, deps } = options;
  const save =
    options.save ??
    ((blob: Blob, fileName: string): void => {
      downloadBlob(doc, blob, fileName);
    });

  const element = doc.createElement('section');
  element.className = 'settings-section export-section';
  element.setAttribute('aria-labelledby', 'settings-export');
  const heading = doc.createElement('h2');
  heading.id = 'settings-export';
  heading.textContent = 'Export';

  // Format
  const formatGroup = doc.createElement('div');
  formatGroup.className = 'export-format';
  formatGroup.setAttribute('role', 'group');
  formatGroup.setAttribute('aria-label', 'Format');
  const formatButtons = new Map<ExportFormat, HTMLButtonElement>();
  let format: ExportFormat = 'png';
  for (const [value, label] of [
    ['png', 'PNG'],
    ['jpeg', 'JPEG'],
  ] as const) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'export-option';
    button.textContent = label;
    button.addEventListener('click', () => {
      format = value;
      sync();
    });
    formatButtons.set(value, button);
    formatGroup.append(button);
  }

  // JPEG quality
  const qualityRow = doc.createElement('label');
  qualityRow.className = 'export-quality';
  const qualityLabel = doc.createElement('span');
  const quality = doc.createElement('input');
  quality.type = 'range';
  quality.min = '50';
  quality.max = '100';
  quality.step = '1';
  quality.value = String(DEFAULT_JPEG_QUALITY);
  quality.addEventListener('input', sync);
  qualityRow.append(qualityLabel, quality);

  const download = doc.createElement('button');
  download.type = 'button';
  download.className = 'primary export-download';

  const hint = doc.createElement('p');
  hint.className = 'export-hint';
  hint.id = 'export-hint';
  download.setAttribute('aria-describedby', hint.id);

  // Progress, shown while exporting
  const running = doc.createElement('div');
  running.className = 'export-running';
  running.hidden = true;
  const bar = doc.createElement('progress');
  bar.className = 'export-progress';
  bar.setAttribute('aria-label', 'Export progress');
  const runningText = doc.createElement('span');
  runningText.className = 'export-progress-text';
  runningText.setAttribute('aria-hidden', 'true');
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  running.append(bar, runningText, cancel);

  // Announced politely: the start, the encoding phase and the end only.
  const status = doc.createElement('p');
  status.className = 'export-status';
  status.setAttribute('role', 'status');
  const failure = doc.createElement('p');
  failure.className = 'export-error';
  failure.setAttribute('role', 'alert');

  element.append(
    heading,
    formatGroup,
    qualityRow,
    download,
    hint,
    running,
    status,
    failure,
  );

  let controller: AbortController | null = null;

  function sync(): void {
    const { width, height } = editor.getState().canvas;
    const empty = editor.getState().photos.length === 0;
    const busy = controller !== null;
    for (const [value, button] of formatButtons) {
      button.setAttribute('aria-pressed', String(value === format));
      button.disabled = busy;
    }
    qualityRow.hidden = format !== 'jpeg';
    quality.disabled = busy;
    qualityLabel.textContent = `JPEG quality ${quality.value}%`;
    download.textContent = `Download ${format === 'jpeg' ? 'JPEG' : 'PNG'}`;
    download.disabled = busy || empty;
    hint.textContent = empty
      ? 'Add photos to the collage to export it.'
      : `${String(width)} × ${String(height)} px, rendered from the original photos.`;
    cancel.hidden = !busy;
  }

  function showProgress(progress: ExportProgress): void {
    if (progress.phase === 'rendering') {
      bar.max = progress.total;
      bar.value = progress.done;
      runningText.textContent = `Rendering ${String(progress.done)} / ${String(progress.total)} photos`;
    } else {
      bar.removeAttribute('value');
      runningText.textContent = 'Encoding…';
      status.textContent = 'Encoding the image';
    }
  }

  function collect(): Map<string, ExportPhoto> {
    const state = editor.getState();
    const found = new Map<string, ExportPhoto>();
    for (const id of new Set(state.assignment)) {
      const photo = photos.getPhoto(id);
      if (!photo) continue;
      found.set(id, {
        name: photo.file.name,
        file: photo.file,
        width: photo.width,
        height: photo.height,
      });
    }
    return found;
  }

  download.addEventListener('click', () => {
    if (controller) return;
    // The snapshot: later edits make new states and leave this one alone.
    const state = editor.getState();
    if (state.photos.length === 0) return;
    const run = new AbortController();
    controller = run;
    failure.textContent = '';
    status.textContent = 'Exporting';
    running.hidden = false;
    showProgress({ phase: 'rendering', done: 0, total: state.photos.length });
    sync();
    const chosen = format;
    void exportCollage({
      state,
      photos: collect(),
      format: chosen,
      quality: Number(quality.value) / 100,
      signal: run.signal,
      onProgress: showProgress,
      deps,
    })
      .then(({ blob, width, height }) => {
        const name = exportFileName(width, height, chosen);
        save(blob, name);
        status.textContent = `Exported ${name} (${megabytes(blob.size)})`;
      })
      .catch((error: unknown) => {
        if (run.signal.aborted) {
          status.textContent = 'Export cancelled';
        } else if (error instanceof ExportError) {
          status.textContent = '';
          failure.textContent = error.message;
        } else {
          status.textContent = '';
          failure.textContent = TOO_LARGE_MESSAGE;
        }
      })
      .finally(() => {
        controller = null;
        running.hidden = true;
        sync();
      });
  });
  cancel.addEventListener('click', () => {
    controller?.abort();
  });

  editor.subscribe(sync);
  sync();
  return { element };
}
