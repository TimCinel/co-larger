import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so the built site works from any sub-path
  // (for example https://example.github.io/co-larger/).
  base: './',
  test: {
    include: ['src/**/*.test.ts'],
    // The CI runner is slow and shared; heavy tests set their own, longer ones.
    testTimeout: 60_000,
  },
});
