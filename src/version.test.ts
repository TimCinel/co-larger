import { describe, expect, it } from 'vitest';
import { formatVersion } from './version';

describe('formatVersion', () => {
  it('shows the version and the commit', () => {
    expect(
      formatVersion('co-larger', {
        version: '2026.11.0',
        commit: '6c2d379',
        dev: false,
      }),
    ).toBe('co-larger 2026.11.0 (6c2d379)');
  });

  it('omits the commit when the build had none', () => {
    expect(
      formatVersion('co-larger', {
        version: '2026.11.0',
        commit: '',
        dev: false,
      }),
    ).toBe('co-larger 2026.11.0');
  });

  it('marks development builds', () => {
    expect(
      formatVersion('co-larger', {
        version: '0.0.0',
        commit: 'abc1234',
        dev: true,
      }),
    ).toBe('co-larger 0.0.0 (abc1234) dev');
  });
});
