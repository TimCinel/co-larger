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

/** For example `co-larger 2026.11.0 (6c2d379)`, plus ` dev` in development. */
export function formatVersion(name: string, info: BuildInfo): string {
  const hash = info.commit === '' ? '' : ` (${info.commit})`;
  return `${name} ${info.version}${hash}${info.dev ? ' dev' : ''}`;
}

/** The link in the page chrome: opens the public repository in a new tab. */
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
  link.textContent = formatVersion(name, info);
  return link;
}
