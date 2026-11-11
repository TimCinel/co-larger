/**
 * Real-Chrome check of the app served by the Docker image (issue #13). Drives
 * the production build through the UI only (no dev hooks): synthetic photos,
 * collage, PNG export, save, open. Fails on any Content-Security-Policy
 * violation, console error or page error. Not run in CI.
 *
 *   docker run -d --rm -p 8080:8080 timcinel/co-larger
 *   node scripts/docker-check.ts http://localhost:8080/
 *   node scripts/docker-check.ts --subpath http://localhost:8080/
 *
 * `--subpath` starts a small reverse proxy that serves the container under
 * /collage/ (stripping the prefix, as a real proxy would) and checks there.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { imageSize } from './export-checks.ts';

const args = process.argv.slice(2);
const subpath = args.includes('--subpath');
const target = new URL(args.find((a) => a.startsWith('http')) ?? '');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
}

let url = target.href;
let proxy: ReturnType<typeof createServer> | undefined;
if (subpath) {
  proxy = createServer((req, res) => {
    if (!req.url?.startsWith('/collage/')) {
      res.writeHead(404).end();
      return;
    }
    const up = request(
      {
        host: target.hostname,
        port: target.port,
        path: req.url.slice('/collage'.length),
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  await new Promise<void>((ok) => proxy!.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}/collage/`;
}
console.log(`Checking ${url}`);

const problems: string[] = [];
function watch(p: Page): void {
  p.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
  p.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${String(r.status())}: ${r.url()}`);
  });
}

const browser = await chromium.launch({ channel: 'chrome' });
console.log(`Browser: Chrome ${browser.version()}`);
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
});
await context.addInitScript(() => {
  // The native save dialog cannot be automated; use the download fallback.
  (window as any).showSaveFilePicker = undefined;
  (window as any).__csp = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
  );
});
const page = await context.newPage();
watch(page);
await page.goto(url);
await page.waitForSelector('.tray');

const policy = await page.evaluate(async () => {
  const r = await fetch(location.href);
  return r.headers.get('content-security-policy') ?? '';
});
check('page is served with a Content-Security-Policy', policy.length > 0);

// The page reports the version in package.json, and the commit it was built
// from (a 7-character hash, or empty when the build had no Git metadata).
const expectedVersion = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const reported = await page.evaluate(() => ({
  version:
    document.querySelector<HTMLMetaElement>('meta[name=version]')?.content ??
    '',
  commit:
    document.querySelector<HTMLMetaElement>('meta[name=commit]')?.content ?? '',
  shown: document.querySelector<HTMLAnchorElement>('a.version')?.textContent,
}));
check(
  'page reports the version from package.json',
  reported.version === expectedVersion,
  `page ${reported.version}, package.json ${expectedVersion}`,
);
check(
  'page reports a short commit hash',
  /^[0-9a-f]{7}$/.test(reported.commit),
  reported.commit === '' ? 'none' : reported.commit,
);
check(
  'the UI shows the version and commit',
  reported.shown === `co-larger ${expectedVersion} (${reported.commit})`,
  reported.shown ?? 'no .version link',
);

async function addPhotos(p: Page, count: number): Promise<void> {
  await p.evaluate(async (count) => {
    const sizes = [
      [900, 600],
      [600, 900],
      [800, 800],
      [1200, 500],
      [500, 1000],
    ];
    const dt = new DataTransfer();
    for (let i = 0; i < count; i++) {
      const [w, h] = sizes[i % sizes.length] as [number, number];
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${String(i * 47)} 70% 55%)`);
      g.addColorStop(1, `hsl(${String(i * 47 + 90)} 70% 25%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 80px sans-serif';
      ctx.fillText(String(i), w / 2 - 20, h / 2);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      dt.items.add(
        new File([blob], `synthetic-${String(i)}.jpg`, { type: 'image/jpeg' }),
      );
    }
    const input = document.querySelector<HTMLInputElement>(
      'input[type=file]:not(.project-input)',
    )!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, count);
}

/** Fraction of distinct colours across a grid of canvas samples. */
function canvasInfo(p: Page) {
  return p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const ctx = c.getContext('2d')!;
    const seen = new Set<string>();
    for (let x = 4; x < c.width; x += Math.ceil(c.width / 40))
      for (let y = 4; y < c.height; y += Math.ceil(c.height / 40))
        seen.add([...ctx.getImageData(x, y, 1, 1).data].join(','));
    return { w: c.width, h: c.height, colours: seen.size };
  });
}

async function waitCollage(p: Page): Promise<void> {
  await p.waitForFunction(
    () => document.querySelectorAll('.tray-grid .thumb').length > 0,
    undefined,
    { timeout: 60_000 },
  );
  await p.waitForFunction(
    () => {
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas');
      if (!c || c.width === 0) return false;
      const ctx = c.getContext('2d')!;
      const seen = new Set<string>();
      for (let x = 4; x < c.width; x += Math.ceil(c.width / 40))
        for (let y = 4; y < c.height; y += Math.ceil(c.height / 40))
          seen.add([...ctx.getImageData(x, y, 1, 1).data].join(','));
      return seen.size > 30;
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function exportPng(
  p: Page,
): Promise<{ hash: string; w: number; h: number }> {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 120_000 }),
    p.locator('.export-download').click(),
  ]);
  const bytes = readFileSync(await download.path());
  const size = imageSize(bytes);
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    w: size?.type === 'png' ? size.width : 0,
    h: size?.type === 'png' ? size.height : 0,
  };
}

await addPhotos(page, 12);
await waitCollage(page);
const tiles = await page.locator('.tray-grid .thumb').count();
const info = await canvasInfo(page);
check(
  '12 synthetic photos import and the collage draws',
  tiles === 12 && info.colours > 30,
  `${String(tiles)} thumbnails, canvas ${String(info.w)}x${String(info.h)}, ${String(info.colours)} colours`,
);
await page
  .getByRole('button', { name: /shuffle/i })
  .first()
  .click();
await waitCollage(page);
check('Shuffle re-lays out the collage', true);

await page.locator('.export-option', { hasText: /png/i }).click();
const exported = await exportPng(page);
check(
  'PNG export downloads a PNG',
  exported.w > 0 && exported.h > 0,
  `${String(exported.w)}x${String(exported.h)}`,
);
const ratio = exported.w / exported.h / (info.w / info.h);
check(
  'exported PNG has the canvas aspect ratio',
  Math.abs(ratio - 1) < 0.02,
  `ratio ${ratio.toFixed(3)}`,
);

const [saved] = await Promise.all([
  page.waitForEvent('download', { timeout: 120_000 }),
  page.locator('.project-save').click(),
]);
const zipPath = await saved.path();
const zip = readFileSync(zipPath);
check(
  'Save downloads a project zip',
  zip.subarray(0, 2).toString() === 'PK' && zip.length > 1000,
  `${saved.suggestedFilename()} ${String(zip.length)} bytes`,
);

const page2 = await context.newPage();
watch(page2);
await page2.goto(url);
await page2.waitForSelector('.tray');
await page2.setInputFiles('.project-input', zipPath);
await page2
  .waitForFunction(
    () => !document.querySelector<HTMLDialogElement>('.project-dialog')?.open,
    undefined,
    { timeout: 120_000 },
  )
  .catch(() => undefined);
await waitCollage(page2);
const tiles2 = await page2.locator('.tray-grid .thumb').count();
check(
  'Open restores the saved project',
  tiles2 === 12,
  `${String(tiles2)} thumbnails`,
);
const again = await exportPng(page2);
check(
  'an export after reopening is byte-identical to the one before saving',
  again.hash === exported.hash,
  `${exported.hash.slice(0, 12)} / ${again.hash.slice(0, 12)}`,
);

const violations = [
  ...(await page.evaluate(() => (window as any).__csp as string[])),
  ...(await page2.evaluate(() => (window as any).__csp as string[])),
];
check(
  'no Content-Security-Policy violations',
  violations.length === 0,
  violations.join('; '),
);
check(
  'no console errors, page errors or failed requests',
  problems.length === 0,
  problems.join('; '),
);

await browser.close();
proxy?.close();
console.log(
  failures === 0
    ? '\nAll checks passed'
    : `\n${String(failures)} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
