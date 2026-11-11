import { describe, expect, it } from 'vitest';
import { formatVersion, versionLabel } from './version';

const release = { version: '2026.11.0', commit: '6c2d379', dev: false };

describe('formatVersion', () => {
  it('shows the version and the commit', () => {
    expect(formatVersion(release)).toBe('2026.11.0 (6c2d379)');
  });

  it('omits the commit when the build had none', () => {
    expect(formatVersion({ ...release, commit: '' })).toBe('2026.11.0');
  });

  it('marks development builds', () => {
    expect(formatVersion({ ...release, dev: true })).toBe(
      '2026.11.0 (6c2d379) dev',
    );
  });
});

describe('versionLabel', () => {
  it('names the app, version, commit and destination', () => {
    expect(versionLabel('co-larger', release)).toBe(
      'co-larger version 2026.11.0, commit 6c2d379, source on GitHub',
    );
  });

  it('leaves out a missing commit and says when it is a dev build', () => {
    expect(
      versionLabel('co-larger', { ...release, commit: '', dev: true }),
    ).toBe('co-larger version 2026.11.0, development build, source on GitHub');
  });
});
