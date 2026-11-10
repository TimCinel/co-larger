function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/** If no `dragover` arrives for this long, the drag is over. */
const DRAG_IDLE_MS = 1000;

/**
 * Splits dropped entries into photos and folders. A dropped folder shows up in
 * `dataTransfer.files` as a pseudo-file with the folder's name and no type.
 */
export function splitDropped(
  files: readonly File[],
  folderNames: ReadonlySet<string>,
): { files: File[]; folders: string[] } {
  const folders: string[] = [];
  const photos: File[] = [];
  for (const file of files) {
    if (file.type === '' && folderNames.has(file.name)) folders.push(file.name);
    else photos.push(file);
  }
  return { files: photos, folders };
}

/**
 * Makes the whole page a drop target for files. Toggles the `dragging` class on
 * `indicator` while files are dragged over the page. Calls `onDrop` on drop.
 */
export function installDropTarget(
  doc: Document,
  indicator: HTMLElement,
  onDrop: (dropped: { files: File[]; folders: string[] }) => void,
): void {
  // dragenter/dragleave fire for every child element crossed, so count them.
  let depth = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const setDragging = (on: boolean): void => {
    indicator.classList.toggle('dragging', on);
  };
  const stop = (): void => {
    depth = 0;
    clearTimeout(idleTimer);
    setDragging(false);
  };
  // Safety net for a lost `dragleave` (or a drag cancelled with Escape):
  // `dragover` fires continuously while a drag is over the page, so when it
  // stops, so has the drag.
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, DRAG_IDLE_MS);
  };

  doc.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    setDragging(true);
    armIdleTimer();
  });
  doc.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    // Without this the browser would navigate to the dropped file.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
    armIdleTimer();
  });
  doc.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) stop();
  });
  doc.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    stop();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    // Entries must be read synchronously, while the drop event is dispatched.
    const folderNames = new Set<string>();
    for (const item of Array.from(transfer.items)) {
      if (item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory) {
        folderNames.add(item.getAsFile()?.name ?? '');
      }
    }
    const dropped = splitDropped(Array.from(transfer.files), folderNames);
    if (dropped.files.length > 0 || dropped.folders.length > 0) {
      onDrop(dropped);
    }
  });
}
