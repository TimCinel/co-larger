export const REPO_URL = 'https://github.com/TimCinel/co-larger';

export interface BuildInfo {
  /** `version` from package.json. */
  readonly version: string;
  /** Short Git commit, or empty when the build had none. */
  readonly commit: string;
  /** True under `npm run dev`. */
  readonly dev: boolean;
}

/** The build this code is running in. */
export const BUILD: BuildInfo = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  dev: import.meta.env.DEV,
};

/** For example `2026.11.0 (6c2d379)`, plus ` dev` in development. */
export function formatVersion(info: BuildInfo): string {
  const hash = info.commit === '' ? '' : ` (${info.commit})`;
  return `${info.version}${hash}${info.dev ? ' dev' : ''}`;
}

/** For example `co-larger version 2026.11.0, commit 6c2d379, source on GitHub`. */
export function versionLabel(name: string, info: BuildInfo): string {
  const commit = info.commit === '' ? '' : `, commit ${info.commit}`;
  const dev = info.dev ? ', development build' : '';
  return `${name} version ${info.version}${commit}${dev}, source on GitHub`;
}

/**
 * The link in the top bar, beside the title: opens the public repository in
 * a new tab. The commit sits in its own span so narrow windows can hide it
 * (CSS); the full text stays in the title and the accessible name.
 */
export function createVersionLink(
  doc: Document,
  name: string,
  info: BuildInfo = BUILD,
): HTMLAnchorElement {
  const link = doc.createElement('a');
  link.className = 'version';
  link.href = REPO_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = formatVersion(info);
  link.setAttribute('aria-label', versionLabel(name, info));
  const version = doc.createElement('span');
  version.textContent = info.version;
  link.append(version);
  if (info.commit !== '') {
    const commit = doc.createElement('span');
    commit.className = 'version-commit';
    commit.textContent = ` (${info.commit})`;
    link.append(commit);
  }
  if (info.dev) {
    const dev = doc.createElement('span');
    dev.className = 'version-dev';
    dev.textContent = ' dev';
    link.append(dev);
  }
  return link;
}
