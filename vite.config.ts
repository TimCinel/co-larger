import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// package.json is the single source of truth for the version.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * The short Git commit this build is made from: the GIT_COMMIT environment
 * variable (set by `docker build` and CI, where there is no Git metadata),
 * else `git rev-parse`, else empty. A missing hash never fails the build.
 */
function resolveCommit(): string {
  let raw = (process.env.GIT_COMMIT ?? '').trim();
  if (raw === '') {
    try {
      raw = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7).toLowerCase() : '';
}

const commit = resolveCommit();

/** Puts the version in the page as <meta> tags, for scripts to read. */
function versionMeta(): Plugin {
  return {
    name: 'co-larger-version-meta',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { name: 'version', content: pkg.version },
        injectTo: 'head',
      },
      {
        tag: 'meta',
        attrs: { name: 'commit', content: commit },
        injectTo: 'head',
      },
    ],
  };
}

export default defineConfig({
  // Relative asset URLs, so the built site works from any sub-path
  // (for example https://example.github.io/co-larger/).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [versionMeta()],
  test: {
    include: ['src/**/*.test.ts'],
    // The CI runner is slow and shared; heavy tests set their own, longer ones.
    testTimeout: 60_000,
  },
});
