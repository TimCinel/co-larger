import { describe, expect, it } from 'vitest';
import { summaryMessages } from './notices';

describe('summaryMessages', () => {
  it('is empty when nothing was skipped', () => {
    expect(summaryMessages({ added: 3, duplicates: [], failures: [] })).toEqual(
      [],
    );
  });

  it('names failed and duplicate files, truncating long lists', () => {
    const messages = summaryMessages({
      added: 0,
      duplicates: ['d.jpg'],
      failures: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({
        name: `${name}.heic`,
        message: 'x',
      })),
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('Skipped 7 files');
    expect(messages[0]).toContain(
      'a.heic, b.heic, c.heic, d.heic, e.heic and 2 more',
    );
    expect(messages[1]).toContain('Skipped 1 already added photo: d.jpg');
  });
});
