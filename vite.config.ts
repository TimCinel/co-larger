import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so the built site works from any sub-path
  // (for example https://example.github.io/co-larger/).
  base: './',
  test: {
    include: ['src/**/*.test.ts'],
  },
});
