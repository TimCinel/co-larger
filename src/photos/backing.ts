/**
 * Photos opened from a project are slices of the zip the user chose, so they
 * stay readable only while that file stays where it is (#12). Any failed
 * read of one is reported with this one message, and stops the operation.
 */
export const BACKING_FILE_MESSAGE =
  'The project file can no longer be read; it may have been moved or deleted. Open it again from its new location.';

/** A file behind a photo or a project could not be read. */
export class BackingFileError extends Error {
  constructor(message = BACKING_FILE_MESSAGE) {
    super(message);
    this.name = 'BackingFileError';
  }
}

/** Whether the first and last bytes of `blob` can be read right now. */
export async function isReadable(blob: Blob): Promise<boolean> {
  try {
    await blob.slice(0, 1).arrayBuffer();
    if (blob.size > 1) await blob.slice(blob.size - 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
