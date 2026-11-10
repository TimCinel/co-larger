import { describe, expect, it } from 'vitest';
import { splitDropped } from './dropzone';

describe('splitDropped', () => {
  it('separates dropped folders from photos', () => {
    const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const folder = new File([], 'Holiday', { type: '' });
    const result = splitDropped([photo, folder], new Set(['Holiday']));
    expect(result.files).toEqual([photo]);
    expect(result.folders).toEqual(['Holiday']);
  });

  it('keeps an untyped file that is not a folder', () => {
    const odd = new File(['x'], 'IMG_1', { type: '' });
    expect(splitDropped([odd], new Set()).files).toEqual([odd]);
  });
});
