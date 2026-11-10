function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Makes the whole page a drop target for files. Toggles the `dragging` class on
 * `indicator` while files are dragged over the page. Calls `onFiles` on drop.
 */
export function installDropTarget(
  doc: Document,
  indicator: HTMLElement,
  onFiles: (files: File[]) => void,
): void {
  // dragenter/dragleave fire for every child element crossed, so count them.
  let depth = 0;
  const setDragging = (on: boolean): void => {
    indicator.classList.toggle('dragging', on);
  };

  doc.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    setDragging(true);
  });
  doc.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    // Without this the browser would navigate to the dropped file.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  doc.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  });
  doc.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  });
}
