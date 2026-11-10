import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so the built site works from any sub-path
  // (for example https://example.github.io/co-larger/).
  base: './',
  test: {
    include: ['src/**/*.test.ts'],
    // The layout property tests run thousands of layouts, which takes a few
    // seconds per test; leave room for slower CI machines.
    testTimeout: 60_000,
  },
});
