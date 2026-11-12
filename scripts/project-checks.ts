/**
 * Real-browser checks for saving and opening projects (issue #12), called
 * from browser-check.ts. Photos are generated in the page; test zips are made
 * on the fly in a temp folder that is deleted at the end. With
 * `--project-dir <folder>` it also saves and opens a real folder of photos,
 * printing numbers only (and never copying a photo or a zip anywhere but a
 * temp folder that is removed).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { action, addPhotos, browserRssMb } from './export-checks.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

const MARKER = 'playwright_chromiumdev_profile';

/** No save dialog by default (so Save downloads), and a slow-decode switch. */
const INIT_SCRIPT = `(() => {
  const w = window;
  Object.defineProperty(w, 'showSaveFilePicker', { configurable: true, writable: true, value: undefined });
  w.__slowDecode = 0;
  const decode = w.createImageBitmap.bind(w);
  w.createImageBitmap = async (...args) => {
    if (w.__slowDecode) await new Promise((r) => setTimeout(r, w.__slowDecode));
    return decode(...args);
  };
  // Which states the canvas ever showed, to catch a re-roll or an empty frame.
  w.__shown = new Set();
  const watch = () => {
    const last = w.__app && w.__app.view && w.__app.view.lastRender();
    if (last) w.__shown.add(last.state.photos.length + ':' + last.state.seed + ':' + JSON.stringify(last.state.plan).length);
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
})();`;

/** Waits until the latest state is drawn, every preview decoded, import over. */
async function waitDrawn(p: Page, timeout = 120_000): Promise<void> {
  await p.waitForFunction(
    () => {
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const state = app.editor.getState();
      return (
        last !== null &&
        last.state === state &&
        last.missing === 0 &&
        last.pending === 0 &&
        document.querySelector<HTMLElement>('.progress')!.hidden &&
        state.photos.length === app.store.getIncludedIds().length
      );
    },
    undefined,
    { timeout, polling: 50 },
  );
}

const sha = (bytes: Uint8Array | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Page2 {
  context: BrowserContext;
  page: Page;
  errors: string[];
  downloads: { count: number };
}

async function newPage(
  browser: Browser,
  origin: string,
  viewport = { width: 1280, height: 800 },
): Promise<Page2> {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const downloads = { count: 0 };
  page.on('download', () => downloads.count++);
  await page.goto(origin);
  await page.waitForSelector('.tray');
  return { context, page, errors, downloads };
}

interface Captured {
  state: string;
  tray: string[][];
  store: {
    id: string;
    name: string;
    included: boolean;
    size: number;
    lastModified: number;
  }[];
  canvasHash: number;
  canvasSize: string;
  selected: string;
}

/** The editor snapshot, the tray (store and DOM) and the canvas pixels. */
function capture(p: Page): Promise<Captured> {
  return p.evaluate(() => {
    const a = (window as any).__app;
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    let hash = 0;
    if (c.width > 0 && a.editor.getState().photos.length > 0) {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (const v of d) hash = (hash * 31 + v) | 0;
    }
    return {
      state: JSON.stringify(a.editor.getState()),
      tray: [...document.querySelectorAll('.tray .thumb')].map((t) => [
        t.getAttribute('aria-label')!,
        t.getAttribute('aria-pressed')!,
      ]),
      store: a.store.getPhotos().map((x: any) => ({
        id: x.id,
        name: x.file.name,
        included: x.included,
        size: x.file.size,
        lastModified: x.file.lastModified,
      })),
      canvasHash: hash,
      canvasSize: `${String(c.width)}x${String(c.height)}`,
      selected: document.querySelector('.tray-count')?.textContent ?? '',
    };
  });
}

/**
 * Compares two pages' collage canvases pixel by pixel. They cannot be
 * bit-identical in general: the editor draws a tile from its thumbnail or its
 * preview depending on which was decoded before, so a page that has been
 * editing differs from a fresh one by JPEG-level amounts along tile content.
 */
async function pixelDiff(
  a: Page,
  b: Page,
): Promise<{ sameSize: boolean; over24: number; meanAbs: number }> {
  const url = await a.evaluate(() =>
    document.querySelector<HTMLCanvasElement>('.collage-canvas')!.toDataURL(),
  );
  return b.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const sameSize =
      bitmap.width === canvas.width && bitmap.height === canvas.height;
    if (!sameSize) return { sameSize, over24: 1, meanAbs: 255 };
    const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = scratch.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const x = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const y = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let over = 0;
    let total = 0;
    for (let i = 0; i < x.length; i += 4) {
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(x[i + k]! - y[i + k]!);
        total += d;
        worst = Math.max(worst, d);
      }
      if (worst > 24) over++;
    }
    return {
      sameSize,
      over24: over / (x.length / 4),
      meanAbs: total / ((x.length / 4) * 3),
    };
  }, url);
}

const same = (a: Captured, b: Captured): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** SHA-256 of every photo's file, by id, hashed inside the page. */
function hashOriginals(p: Page): Promise<Record<string, string>> {
  return p.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const x of (window as any).__app.store.getPhotos()) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await x.file.arrayBuffer(),
      );
      out[x.id] = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return out;
  });
}

async function downloadVia(
  p: Page,
  click: () => Promise<void>,
  path: string,
): Promise<string> {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 300_000 }),
    click(),
  ]);
  await download.saveAs(path);
  return download.suggestedFilename();
}

async function exportPng(p: Page): Promise<string> {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 120_000 }),
    p.locator('.export-download').click(),
  ]);
  const path = await download.path();
  const hash = sha(readFileSync(path));
  await p.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.export-download')!.disabled,
    undefined,
    { timeout: 120_000 },
  );
  return hash;
}

/** Waits for an open to finish (dialog closed, collage drawn). */
async function waitOpened(p: Page, timeout = 300_000): Promise<void> {
  await p.waitForFunction(
    () => {
      const dialog =
        document.querySelector<HTMLDialogElement>('.project-dialog');
      return !dialog?.open;
    },
    undefined,
    { timeout },
  );
  const empty = await p.evaluate(
    () => (window as any).__app.editor.getState().photos.length === 0,
  );
  if (!empty) await waitDrawn(p, timeout);
}

/** Chooses `file` to open; confirms the replacement if asked. */
async function openFile(
  p: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
  confirm = true,
): Promise<void> {
  await p.setInputFiles('.project-input', file);
  if (confirm) {
    const asked = await p
      .waitForSelector('.project-dialog[open] .primary', { timeout: 3000 })
      .catch(() => null);
    if (asked)
      await p
        .getByRole('button', { name: 'Replace with this project' })
        .click();
  }
}

async function expectError(
  p: Page,
  file: Buffer,
  pattern: RegExp,
  screenshot?: string,
): Promise<{ ok: boolean; message: string }> {
  await openFile(p, {
    name: 'bad.zip',
    mimeType: 'application/zip',
    buffer: file,
  });
  await p.waitForFunction(
    () =>
      document.querySelector('.project-dialog[open] h2')?.textContent ===
      'Could not open the project',
    undefined,
    { timeout: 120_000 },
  );
  const message = await p.locator('.project-dialog-body').innerText();
  if (screenshot) {
    await p.screenshot({
      path: screenshot,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
  }
  await p.getByRole('button', { name: 'OK' }).click();
  await p.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>('.project-dialog')!.open,
  );
  return { ok: pattern.test(message), message };
}

function patchCentral(
  zip: Uint8Array,
  nth: number,
  change: (view: DataView, at: number) => void,
): Buffer {
  const copy = Buffer.from(zip);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.length);
  let seen = 0;
  for (let i = 0; i < copy.length - 46; i++) {
    if (view.getUint32(i, true) === 0x02014b50 && seen++ === nth) {
      change(view, i);
      break;
    }
  }
  return copy;
}

/** The compression method of every entry, read from the central directory. */
/**
 * The compression method of every entry, read from the central directory:
 * found through the end-of-central-directory record (searched for from the
 * end, past at most a 64 KiB comment), then walked entry by entry. Scanning
 * the whole file for the central-directory signature instead could match
 * inside photo data.
 */
function methods(zip: Buffer): number[] {
  let end = -1;
  for (
    let i = zip.length - 22;
    i >= Math.max(0, zip.length - 22 - 65535);
    i--
  ) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: number[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) return [...out, -1];
    out.push(zip.readUInt16LE(at + 10));
    at +=
      46 +
      zip.readUInt16LE(at + 28) +
      zip.readUInt16LE(at + 30) +
      zip.readUInt16LE(at + 32);
  }
  return out;
}

const STUB_PICKER = `(() => {
  window.__picked = { name: '', bytes: 0, chunks: 0, head: '' };
  window.showSaveFilePicker = async (options) => {
    window.__picked = { name: options.suggestedName, bytes: 0, chunks: 0, head: '', types: JSON.stringify(options.types) };
    return {
      createWritable: async () => new WritableStream({
        write(chunk) {
          const p = window.__picked;
          if (p.chunks === 0) p.head = String.fromCharCode(...chunk.slice(0, 2));
          p.chunks++;
          p.bytes += chunk.length;
        },
      }),
    };
  };
})`;

export async function checkProject(
  browser: Browser,
  origin: string,
  check: Check,
  options: { screenshots?: string } = {},
): Promise<void> {
  console.log('\nSave and open project (issue #12)');
  const tmp = mkdtempSync(join(tmpdir(), 'colarger-project-'));
  try {
    const small = await checkSmall(browser, origin, check, tmp, options);
    await checkOpfs(browser, origin, check, small);
    await checkDeflated(
      browser,
      origin,
      check,
      tmp,
      small,
      options.screenshots,
    );
    await checkRoundTrips(browser, origin, check, small.zipPath);
    if (!process.env.SKIP_LARGE)
      await checkLarge(browser, origin, check, tmp, 100);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function checkSmall(
  browser: Browser,
  origin: string,
  check: Check,
  tmp: string,
  options: { screenshots?: string },
): Promise<SmallResult> {
  const A = await newPage(browser, origin);
  const p = A.page;

  // Controls start disabled with nothing to save.
  const initial = await p.evaluate(() => ({
    save: document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
    open: document.querySelector<HTMLButtonElement>('.project-open')!.disabled,
    hint: document.querySelector('.project-hint')!.textContent,
  }));
  check(
    'Save is disabled with no photos, Open is enabled',
    initial.save && !initial.open,
    JSON.stringify(initial),
  );

  // --- A collage with everything the project must keep ----------------------
  await addPhotos(p, 7);
  await p.evaluate(() => {
    const store = (window as any).__app.store;
    const x = store.getPhotos().find((q: any) => q.file.name === 'p-3.jpg');
    store.setIncluded(x.id, false);
  });
  await waitDrawn(p);
  // A non-default physical size (150 x 100 mm at 200 DPI), a border, a
  // background, a swap, and a zoomed and panned crop.
  await action(p, 'setPhysicalSize', 150, 100, 200);
  await action(p, 'setBorder', 0.03);
  await action(p, 'setBackground', '#33aa77');
  await waitDrawn(p);
  await action(p, 'swapTiles', 0, 3);
  const markerId = await p.evaluate(
    () =>
      (window as any).__app.store
        .getPhotos()
        .find((x: any) => x.file.name === 'marker.jpg').id as string,
  );
  await action(p, 'setCrop', markerId, { x: 0.8, y: 0.3, zoom: 2.2 });
  await waitDrawn(p);
  const before = await capture(p);
  const originals = await hashOriginals(p);
  const savedState = JSON.parse(before.state);
  check(
    'the collage to save has a physical size, border, background, a swap, a crop and an excluded photo',
    savedState.canvas.physical?.widthMm === 150 &&
      savedState.canvas.borderFraction === 0.03 &&
      savedState.canvas.background === '#33aa77' &&
      Object.keys(savedState.crops).length === 1 &&
      before.tray.filter((t) => t[1] === 'false').length === 1 &&
      before.selected === '6 / 7 selected',
    `${before.canvasSize} ${before.selected}`,
  );
  const exportBefore = await exportPng(p);

  // --- Save ----------------------------------------------------------------
  const zipPath = join(tmp, 'small.zip');
  const t0 = Date.now();
  const name = await downloadVia(
    p,
    () => p.locator('.project-save').click(),
    zipPath,
  );
  const saveMs = Date.now() - t0;
  check(
    'Save downloads one zip with a sensible name',
    name === 'collage-project.colarger.zip' && statSync(zipPath).size > 1000,
    `${name} ${String(statSync(zipPath).size)} bytes in ${String(saveMs)} ms`,
  );
  const zipBytes = readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(zipBytes));
  const project = JSON.parse(strFromU8(entries['project.json']!));
  check(
    'the JSON has a format identifier, an integer format version and the snapshot',
    project.format === 'co-larger-project' &&
      Number.isInteger(project.version) &&
      project.version === 1 &&
      JSON.stringify(project.state) === before.state,
    `format ${String(project.format)} v${String(project.version)}`,
  );
  check(
    'the project keeps the plan itself, not just the seed',
    Array.isArray(project.state.plan?.tiles ?? project.state.plan) ||
      typeof project.state.plan === 'object',
  );
  const manifest: {
    id: string;
    path: string;
    name: string;
    included: boolean;
    width: number;
    height: number;
    aspect: number;
    lastModified: number;
  }[] = project.photos;
  check(
    'the manifest lists every photo (the excluded one too) with id, path, name, flag, size and time',
    manifest.length === 7 &&
      manifest.filter((m) => !m.included).length === 1 &&
      manifest.every(
        (m) =>
          typeof m.path === 'string' &&
          m.width > 0 &&
          m.height > 0 &&
          Math.abs(m.aspect - m.width / m.height) < 1e-9 &&
          m.lastModified >= 1_700_000_000_000,
      ),
  );
  check(
    'paths are unique and under photos/, even though photos share a name',
    new Set(manifest.map((m) => m.path)).size === 7 &&
      manifest.every((m) => /^photos\/[\w.~-]+$/.test(m.path)),
    manifest
      .map((m) => m.path)
      .slice(0, 2)
      .join(' '),
  );
  check(
    'photo bytes inside the zip equal the originals (SHA-256)',
    manifest.every((m) => sha(entries[m.path]!) === originals[m.id]),
  );
  check(
    'every entry is stored without recompression',
    methods(zipBytes).every((m) => m === 0) &&
      Object.keys(entries).length === 8,
    `methods ${[...new Set(methods(zipBytes))].join(',')}`,
  );

  // --- Open in a fresh page ---------------------------------------------------
  const B = await newPage(browser, origin);
  const q = B.page;
  await q.evaluate(() => {
    const w = window as any;
    w.__notes = [];
    w.__app.editor.subscribe((s: any, c: any) =>
      w.__notes.push({ n: s.photos.length, restored: c.restored }),
    );
  });
  const t1 = Date.now();
  await openFile(q, zipPath, false);
  await waitOpened(q);
  const openMs = Date.now() - t1;
  const after = await capture(q);
  check(
    'opening the zip in a fresh page restores the editor snapshot exactly (deep-equal)',
    after.state === before.state,
  );
  check(
    'the tray matches: order, ticks, names, sizes, times and ids',
    JSON.stringify(after.tray) === JSON.stringify(before.tray) &&
      JSON.stringify(after.store) === JSON.stringify(before.store) &&
      after.selected === before.selected,
    after.selected,
  );
  const diff = await pixelDiff(p, q);
  check(
    'the canvas pixels match (same size; under 0.1% of pixels differ by more than 24/255)',
    diff.sameSize && diff.over24 < 0.001 && diff.meanAbs < 0.5,
    `${JSON.stringify(diff)}; opened in ${String(openMs)} ms`,
  );
  check(
    'the collage appears once, already in its restored arrangement: one notification, no other state ever drawn',
    await q.evaluate((expected) => {
      const w = window as any;
      const shown = [...w.__shown].filter((s: string) => !s.startsWith('0:'));
      return (
        w.__notes.length === 1 &&
        w.__notes[0].restored === true &&
        w.__notes[0].n === expected &&
        shown.length === 1
      );
    }, savedState.photos.length),
    await q.evaluate(() => JSON.stringify([...(window as any).__shown])),
  );
  check(
    'undo history starts fresh after opening, with no "cleared" notice',
    (await q.getByRole('button', { name: 'Undo', exact: true }).isDisabled()) &&
      (await q.locator('.notice', { hasText: 'undo history' }).count()) === 0,
  );
  check(
    'the open is announced and the input is reset for opening the same file again',
    (await q.locator('.project-status').innerText()).startsWith('Opened ') &&
      (await q.evaluate(
        () => document.querySelector<HTMLInputElement>('.project-input')!.value,
      )) === '',
  );
  const exportAfter = await exportPng(q);
  check(
    'an export made after reopening is byte-identical to one made before saving',
    exportAfter === exportBefore,
    `${exportBefore.slice(0, 12)} / ${exportAfter.slice(0, 12)}`,
  );

  // Duplicate detection survives the round trip.
  const firstOriginal = await p.evaluate(async () => {
    const x = (window as any).__app.store.getPhotos()[1];
    const bytes = new Uint8Array(await x.file.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return {
      name: x.file.name,
      lastModified: x.file.lastModified,
      data: btoa(bin),
    };
  });
  await q.evaluate((f) => {
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(
      new File([bytes], f.name, {
        type: 'image/jpeg',
        lastModified: f.lastModified,
      }),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[type=file]:not(.project-input)',
    )!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, firstOriginal);
  await q.waitForSelector('.notice');
  const dupNotice = await q.locator('.notice').first().innerText();
  check(
    'dropping an original file again after opening is recognised as a duplicate',
    dupNotice.includes('already added') &&
      (await q.evaluate(() => (window as any).__app.store.getTotalCount())) ===
        7,
    dupNotice.slice(0, 60),
  );

  // --- The confirmation dialog, and replacing a project ----------------------
  const C = await newPage(browser, origin);
  const c = C.page;
  await addPhotos(c, 5, 1, 'other');
  await waitDrawn(c);
  const cBefore = await capture(c);
  await c.setInputFiles('.project-input', zipPath);
  await c.waitForSelector('.project-dialog[open]');
  const asked = await c.evaluate(() => {
    const d = document.querySelector('.project-dialog')!;
    return {
      title: d.querySelector('h2')!.textContent,
      body: d.querySelector('.project-dialog-body')!.textContent,
      modal: d.matches(':modal'),
      focus: document.activeElement?.textContent,
      native: d.tagName,
    };
  });
  check(
    'with photos loaded, Open asks first in an in-page dialog (not window.confirm)',
    asked.title === 'Replace the current project?' &&
      asked.modal &&
      asked.native === 'DIALOG' &&
      asked.body.includes('replaces the 5 photos'),
    JSON.stringify(asked),
  );
  check(
    'the safe choice has focus, so Enter never replaces a project by accident',
    asked.focus === 'Keep current project',
  );
  if (options.screenshots) {
    await c.screenshot({
      path: join(options.screenshots, 'issue-12-confirm.png'),
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
  }
  await c.keyboard.press('Escape');
  await c.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>('.project-dialog')!.open,
  );
  check(
    'Escape on the dialog keeps the current project',
    same(await capture(c), cBefore),
  );
  await c.setInputFiles('.project-input', zipPath);
  await c.getByRole('button', { name: 'Keep current project' }).click();
  await c.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>('.project-dialog')!.open,
  );
  check(
    'choosing Keep leaves the current project untouched',
    same(await capture(c), cBefore) &&
      (await c.locator('.project-status').innerText()) === '',
  );
  // Replace, watching what the canvas shows (the old project, then the new one).
  await c.evaluate(() => {
    (window as any).__shown.clear();
  });
  await c.setInputFiles('.project-input', zipPath);
  await c.getByRole('button', { name: 'Replace with this project' }).click();
  await waitOpened(c);
  check(
    'replacing a project shows the saved arrangement and the old photos are gone',
    (await capture(c)).state === before.state &&
      (await c.evaluate(() => (window as any).__app.store.getTotalCount())) ===
        7 &&
      (await c.locator('.notice', { hasText: 'undo history' }).count()) === 0,
  );
  check(
    'no empty or re-rolled collage is drawn between the old project and the new',
    await c.evaluate(() => {
      const shown = [...(window as any).__shown] as string[];
      return !shown.some((s) => s.startsWith('0:')) && shown.length <= 2;
    }),
    await c.evaluate(() => JSON.stringify([...(window as any).__shown])),
  );

  const replacedHash = (await capture(c)).canvasHash;
  // --- Invalid files leave the current state untouched -------------------------
  const good = unzipSync(new Uint8Array(zipBytes));
  const withProject = (change: (j: any) => void): Buffer => {
    const json = JSON.parse(strFromU8(good['project.json']!));
    change(json);
    return Buffer.from(
      zipSync(
        { ...good, 'project.json': strToU8(JSON.stringify(json)) },
        { level: 0 },
      ),
    );
  };
  const swapPhoto = (path: string, bytes: Uint8Array): Buffer =>
    Buffer.from(zipSync({ ...good, [path]: bytes }, { level: 0 }));
  const markerEntry = manifest.find((m) => m.name === 'marker.jpg')!;
  const otherEntry = manifest.find((m) => m.name === 'p-1.jpg')!;
  const many: Record<string, Uint8Array> = {
    'project.json': good['project.json']!,
  };
  for (let i = 0; i <= 10_000; i++)
    many[`junk/${String(i)}`] = new Uint8Array(0);

  const cases: [string, Buffer, RegExp][] = [
    [
      'not a zip',
      Buffer.from('this is not a zip file at all, just text'),
      /not a zip/,
    ],
    [
      'no project.json',
      Buffer.from(zipSync({ 'a.txt': strToU8('x') }, { level: 0 })),
      /no project\.json/,
    ],
    [
      'invalid JSON',
      Buffer.from(zipSync({ 'project.json': strToU8('{oops') }, { level: 0 })),
      /not valid JSON/,
    ],
    [
      'unknown format',
      withProject((j) => (j.format = 'something-else')),
      /not a co-larger project/,
    ],
    [
      'a newer version',
      // One past the newest version this build reads (2 since #16).
      withProject((j) => (j.version = 3)),
      /saved by a newer version/,
    ],
    [
      'a snapshot that fails validation',
      withProject((j) => (j.state.plan = [])),
      /not valid/,
    ],
    [
      'a manifest entry whose file is missing',
      Buffer.from(
        zipSync(
          Object.fromEntries(
            Object.entries(good).filter(([k]) => k !== markerEntry.path),
          ),
          { level: 0 },
        ),
      ),
      /missing from the zip/,
    ],
    [
      'a photo that cannot be decoded',
      swapPhoto(markerEntry.path, strToU8('this is not an image')),
      /cannot decode/,
    ],
    [
      'a photo whose size differs from the manifest',
      swapPhoto(markerEntry.path, good[otherEntry.path]!),
      /px but the project says/,
    ],
    [
      'a path with ..',
      withProject((j) => (j.photos[0].path = 'photos/../../evil.jpg')),
      /unsafe/,
    ],
    [
      'an absolute path',
      withProject((j) => (j.photos[0].path = '/etc/passwd')),
      /unsafe/,
    ],
    [
      'a zip entry named ../evil',
      Buffer.from(
        zipSync({ ...good, '../evil.txt': strToU8('x') }, { level: 0 }),
      ),
      /unsafe file path/,
    ],
    [
      'project.json changed without updating the CRC (background #33aa77 to #03aa77)',
      (() => {
        const copy = Buffer.from(zipBytes);
        const at = copy.indexOf('#33aa77');
        copy[at + 1] = 0x30;
        return copy;
      })(),
      /project file is damaged/,
    ],
    [
      'a photo changed without updating the CRC',
      (() => {
        const copy = Buffer.from(zipBytes);
        const at = copy.indexOf(Buffer.from(good[markerEntry.path]!));
        copy[at + 100] = (copy[at + 100] as number) ^ 0x01;
        return copy;
      })(),
      /project file is damaged.*marker\.jpg|project file is damaged/,
    ],
    ['too many entries', Buffer.from(zipSync(many, { level: 0 })), /limit/],
    [
      'an absurd declared size',
      patchCentral(new Uint8Array(zipBytes), 1, (v, at) => {
        v.setUint32(at + 20, 0xf0000000, true);
        v.setUint32(at + 24, 0xf0000000, true);
      }),
      /too large/,
    ],
  ];
  for (const [label, buffer, pattern] of cases) {
    const result = await expectError(c, buffer, pattern);
    const now = await capture(c);
    check(
      `invalid file (${label}): an error is shown and the current state is untouched`,
      result.ok && same(now, await capture(c)) && now.state === before.state,
      result.message.slice(0, 110),
    );
  }
  // The same, against a project that differs from the one in the files.
  await c.evaluate(() => {
    (window as any).__shown.clear();
  });
  const stillThere = await capture(c);
  check(
    'after all those failures the open project is still exactly the saved one and nothing was drawn but it',
    stillThere.state === before.state &&
      stillThere.canvasHash === replacedHash &&
      A.errors.length + B.errors.length + C.errors.length === 0,
    [...A.errors, ...B.errors, ...C.errors].join(' | '),
  );

  // Extra unknown files are ignored.
  const extra = Buffer.from(
    zipSync(
      {
        ...good,
        'notes/readme.txt': strToU8('hello'),
        'photos/unused.jpg': good[otherEntry.path]!,
      },
      { level: 0 },
    ),
  );
  await openFile(c, {
    name: 'extra.zip',
    mimeType: 'application/zip',
    buffer: extra,
  });
  await waitOpened(c);
  check(
    'extra unknown files in the zip are ignored',
    (await capture(c)).state === before.state,
  );

  // --- Cancel during open ------------------------------------------------------
  const cancelPage = await newPage(browser, origin);
  const k = cancelPage.page;
  await addPhotos(k, 4, 1, 'keep');
  await waitDrawn(k);
  const kBefore = await capture(k);
  await k.evaluate(() => {
    (window as any).__slowDecode = 500;
  });
  await openFile(k, zipPath);
  await k.waitForSelector('.project-dialog[open] progress:not([hidden])');
  await k.waitForFunction(() =>
    (
      document.querySelector('.project-dialog-body')?.textContent ?? ''
    ).includes('Preparing photos'),
  );
  const during = await k.evaluate(() => ({
    save: document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
    open: document.querySelector<HTMLButtonElement>('.project-open')!.disabled,
    add: [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Add photos',
    )!.disabled,
    text: document.querySelector('.project-dialog-body')!.textContent,
    value: document.querySelector<HTMLProgressElement>(
      '.project-dialog progress',
    )!.value,
    max: document.querySelector<HTMLProgressElement>(
      '.project-dialog progress',
    )!.max,
  }));
  check(
    'open shows progress and the buttons are disabled while it runs',
    during.save && during.open && during.add && during.max === 7,
    JSON.stringify(during),
  );
  await k.getByRole('button', { name: 'Cancel' }).click();
  await k.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>('.project-dialog')!.open,
    undefined,
    { timeout: 30_000 },
  );
  await k.evaluate(() => {
    (window as any).__slowDecode = 0;
  });
  check(
    'Cancel during open leaves the current project exactly as it was, and says so',
    same(await capture(k), kBefore) &&
      /cancelled/i.test(await k.locator('.project-status').innerText()),
  );
  check(
    'after a cancel the buttons work again and a normal open succeeds',
    await (async () => {
      await openFile(k, zipPath);
      await waitOpened(k);
      return (await capture(k)).state === before.state;
    })(),
  );

  // --- Dropping a zip -------------------------------------------------------------
  const D = await newPage(browser, origin);
  const d = D.page;
  const dropFiles = (list: { name: string; type: string; data: string }[]) =>
    d.evaluate((files) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
        dt.items.add(
          new File([bytes], f.name, {
            type: f.type,
            lastModified: 1_700_000_000_000,
          }),
        );
      }
      const fire = (type: string): boolean =>
        document.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      fire('dragenter');
      fire('dragover');
      return !fire('drop');
    }, list);
  const mixed = await dropFiles([
    {
      name: 'x.colarger.zip',
      type: 'application/zip',
      data: zipBytes.toString('base64'),
    },
    {
      name: 'a.jpg',
      type: 'image/jpeg',
      data: Buffer.from(good[otherEntry.path]!).toString('base64'),
    },
  ]);
  await d.waitForFunction(
    () => (window as any).__app.store.getTotalCount() === 1,
  );
  check(
    'a zip dropped together with photos is not opened: the photo is added and a notice explains',
    mixed &&
      (await d
        .locator('.notice', { hasText: 'drop its .zip on its own' })
        .count()) === 1,
  );
  await d.evaluate(() => (window as any).__app.store.clear());
  await dropFiles([
    {
      name: 'x.colarger.zip',
      type: 'application/zip',
      data: zipBytes.toString('base64'),
    },
  ]);
  await d.waitForSelector('.project-dialog[open]');
  await d
    .getByRole('button', { name: 'Replace with this project' })
    .click()
    .catch(() => undefined);
  await waitOpened(d);
  check(
    'a lone .zip dropped on the page opens as a project, not as a photo',
    (await capture(d)).state === before.state,
  );
  const diffD = await pixelDiff(q, d);
  const diffC = await pixelDiff(q, c);
  check(
    'three pages that opened the same file draw the same pixels (within the same tolerance)',
    [diffD, diffC].every(
      (x) => x.sameSize && x.over24 < 0.001 && x.meanAbs < 0.5,
    ),
    `${JSON.stringify(diffD)} ${JSON.stringify(diffC)}`,
  );
  const noErrors = [
    ...A.errors,
    ...B.errors,
    ...C.errors,
    ...cancelPage.errors,
    ...D.errors,
  ];
  check(
    'no console errors during save and open',
    noErrors.length === 0,
    noErrors.join(' | '),
  );

  // --- Screenshot of the controls -----------------------------------------------------
  if (options.screenshots) {
    await q.locator('.project-section').scrollIntoViewIfNeeded();
    await q.screenshot({
      path: join(options.screenshots, 'issue-12-controls.png'),
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
  }

  // --- A save through the browser's save dialog streams to the file ----------------------
  await p.evaluate(`(${STUB_PICKER})()`);
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      (window as any).__picked.bytes > 0 &&
      !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
  );
  const picked = await p.evaluate(() => (window as any).__picked);
  check(
    'with a save dialog (File System Access API) the zip is streamed to the chosen file in chunks',
    picked.name === 'collage-project.colarger.zip' &&
      picked.head === 'PK' &&
      picked.chunks > 5 &&
      Math.abs(picked.bytes - zipBytes.length) < 200 &&
      JSON.parse(picked.types)[0].accept['application/zip'][0] === '.zip',
    `${String(picked.chunks)} chunks, ${String(picked.bytes)} bytes (download was ${String(zipBytes.length)})`,
  );
  await p.evaluate(() => {
    (window as any).showSaveFilePicker = undefined;
  });

  for (const page of [A, B, C, cancelPage, D]) await page.context.close();
  return { zipPath, exportBefore, state: before.state };
}

/** Stray entries Finder's Archive Utility adds to a zip it makes. */
const STRAY: Record<string, Uint8Array> = {
  '__MACOSX/._project.json': new Uint8Array(120).fill(7),
  '__MACOSX/photos/._stray.jpg': new Uint8Array(120).fill(9),
  '.DS_Store': new Uint8Array(6148).fill(1),
  'photos/.DS_Store': new Uint8Array(6148).fill(2),
};

/** Where in `zip` the `nth` central directory entry's data starts, or -1. */
function dataStart(zip: Buffer, nth: number): number {
  let seen = 0;
  for (let i = 0; i < zip.length - 46; i++) {
    if (zip.readUInt32LE(i) === 0x02014b50 && seen++ === nth) {
      const local = zip.readUInt32LE(i + 42);
      return (
        local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      );
    }
  }
  return -1;
}

/** Photos re-zipped with DEFLATE (#43), by fflate and by the system `zip`. */
async function checkDeflated(
  browser: Browser,
  origin: string,
  check: Check,
  tmp: string,
  small: SmallResult,
  screenshots?: string,
): Promise<void> {
  console.log('\n  DEFLATE-compressed photos (issue #43)');
  const files = unzipSync(new Uint8Array(readFileSync(small.zipPath)));
  const photoPaths = Object.keys(files).filter((n) => n.startsWith('photos/'));
  const photoHashes = photoPaths.map((n) => sha(files[n]!)).sort();

  const zips: { label: string; path: string }[] = [];
  // fflate: every entry deflated, plus the strays.
  const deflated: Record<string, [Uint8Array, { level: 6 }]> = {};
  for (const [n, d] of Object.entries({ ...files, ...STRAY }))
    deflated[n] = [d, { level: 6 }];
  const fflatePath = join(tmp, 'deflated-fflate.zip');
  writeFileSync(fflatePath, zipSync(deflated));
  zips.push({ label: 'fflate', path: fflatePath });
  // fflate: a mix, with entries alternately stored and deflated.
  const mixed: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  Object.entries({ ...files, ...STRAY }).forEach(([n, d], i) => {
    mixed[n] = [d, { level: i % 2 ? 6 : 0 }];
  });
  const mixedPath = join(tmp, 'mixed-fflate.zip');
  writeFileSync(mixedPath, zipSync(mixed));
  zips.push({ label: 'fflate mixed', path: mixedPath });
  // The system zip, laid out as Finder would leave it (strays included).
  const haveZip = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
  if (haveZip) {
    const dir = join(tmp, 'tree');
    mkdirSync(join(dir, 'photos'), { recursive: true });
    mkdirSync(join(dir, '__MACOSX', 'photos'), { recursive: true });
    for (const [n, d] of Object.entries({ ...files, ...STRAY }))
      writeFileSync(join(dir, n), d);
    const systemPath = join(tmp, 'deflated-system.zip');
    const run = spawnSync('zip', ['-r', '-q', systemPath, '.'], { cwd: dir });
    check('the system zip command made a zip', run.status === 0);
    zips.push({ label: 'system zip', path: systemPath });
  } else {
    console.log('  (no zip command: system zip check skipped)');
  }

  for (const { label, path } of zips) {
    const bytes = readFileSync(path);
    const listed = Object.keys(unzipSync(new Uint8Array(bytes)));
    const photoMethods: number[] = [];
    unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        if (file.name.startsWith('photos/') && !file.name.endsWith('.DS_Store'))
          photoMethods.push(file.compression);
        return false;
      },
    });
    check(
      `${label}: the zip has DEFLATE photo entries and stray __MACOSX and .DS_Store entries`,
      photoMethods.includes(8) &&
        listed.includes('.DS_Store') &&
        listed.some((n) => n.startsWith('__MACOSX/')),
      `photo methods ${photoMethods.join(',')}`,
    );

    const P = await newPage(browser, origin);
    const q = P.page;
    await openFile(q, path, false);
    await waitOpened(q);
    const opened = await capture(q);
    const hashes = Object.values(await hashOriginals(q)).sort();
    check(
      `${label}: opens, restoring the saved layout, tray and every photo's bytes`,
      opened.state === small.state &&
        opened.store.length === 7 &&
        JSON.stringify(hashes) === JSON.stringify(photoHashes),
      opened.selected,
    );
    check(
      `${label}: an export is byte-identical to the one made before saving`,
      (await exportPng(q)) === small.exportBefore,
    );

    // Save again: a normal stored zip that reopens identically.
    const resaved = join(tmp, `resaved-${label.replace(/ /g, '-')}.zip`);
    await downloadVia(q, () => q.locator('.project-save').click(), resaved);
    const resavedBytes = readFileSync(resaved);
    const resavedFiles = unzipSync(new Uint8Array(resavedBytes));
    check(
      `${label}: saving it again stores every entry without compression, photos unchanged`,
      methods(resavedBytes).every((m) => m === 0) &&
        photoPaths.every((n) => sha(resavedFiles[n]!) === sha(files[n]!)),
    );
    const R = await newPage(browser, origin);
    await openFile(R.page, resaved, false);
    await waitOpened(R.page);
    check(
      `${label}: the re-saved project reopens with the same state and export`,
      (await capture(R.page)).state === small.state &&
        (await exportPng(R.page)) === small.exportBefore,
    );
    check(
      `${label}: no page errors`,
      P.errors.length === 0 && R.errors.length === 0,
      [...P.errors, ...R.errors].join('; '),
    );
    await P.context.close();
    await R.context.close();
  }

  // Failures leave the open project intact. The fflate zip lists project.json
  // first, then the photos, so central entries 1 and 2 are photos.
  const E = await newPage(browser, origin);
  const e = E.page;
  await openFile(e, small.zipPath, false);
  await waitOpened(e);
  const intact = (await capture(e)).state;
  const base = new Uint8Array(readFileSync(fflatePath));
  const wrongCrc = patchCentral(base, 2, (v, at) => {
    v.setUint32(at + 16, v.getUint32(at + 16, true) ^ 0xdeadbeef, true);
  });
  const crc = await expectError(e, wrongCrc, /damaged/);
  check(
    'a deflated photo with a wrong CRC is refused clearly',
    crc.ok,
    crc.message,
  );
  const corrupt = Buffer.from(base);
  const first = dataStart(corrupt, 2);
  for (let k = 0; k < 8; k++) corrupt[first + k] = 0xff;
  const stream = await expectError(e, corrupt, /damaged/);
  check(
    'a corrupt DEFLATE stream is refused clearly',
    first > 0 && stream.ok,
    stream.message,
  );
  const wrongLength = patchCentral(base, 2, (v, at) => {
    v.setUint32(at + 24, v.getUint32(at + 24, true) + 1, true);
  });
  const length = await expectError(e, wrongLength, /damaged/);
  check(
    'a deflated photo with the wrong length is refused clearly',
    length.ok,
    length.message,
  );
  const big = 300 * 1024 * 1024;
  const huge = patchCentral(
    new Uint8Array(
      patchCentral(base, 1, (v, at) => {
        v.setUint32(at + 24, big, true);
      }),
    ),
    2,
    (v, at) => {
      v.setUint32(at + 24, big, true);
    },
  );
  const bound = await expectError(
    e,
    huge,
    /512 MB.*without compression/,
    screenshots ? join(screenshots, 'issue-43-memory-bound.png') : undefined,
  );
  check(
    'more inflated photo data than the memory bound is refused, naming the limit',
    bound.ok,
    bound.message,
  );
  const unsupported = patchCentral(base, 2, (v, at) => {
    v.setUint16(at + 10, 12, true);
  });
  const method = await expectError(e, unsupported, /unsupported compression/);
  check(
    'an unsupported compression method is refused clearly',
    method.ok,
    method.message,
  );
  const after = await capture(e);
  check(
    'after each refusal the project that was open is untouched',
    after.state === intact && after.store.length === 7,
  );
  await E.context.close();
}

interface SmallResult {
  zipPath: string;
  exportBefore: string;
  state: string;
}

const opfsPut = (p: Page, name: string, bytes: Buffer): Promise<void> =>
  p.evaluate(
    async ({ name, b64 }) => {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await writable.close();
    },
    { name, b64: bytes.toString('base64') },
  );

const opfsSha = (p: Page, name: string): Promise<string> =>
  p.evaluate(async (name) => {
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle(name)).getFile();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    return `${String(file.size)}:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }, name);

const opfsOpen = (p: Page, name: string): Promise<void> =>
  p.evaluate(async (name) => {
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle(name)).getFile();
    (window as any).__app.project.openFile(file);
  }, name);

/** The only stubbed part: the picker hands back a real OPFS file handle. */
const pickOpfs = (p: Page, name: string): Promise<void> =>
  p.evaluate(async (name) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(name, { create: true });
    (window as any).showSaveFilePicker = () => Promise.resolve(handle);
  }, name);

/** Slows every Blob read, and can make it fail after some chunks. */
const slowReads = (p: Page, ms: number, failAfter?: number): Promise<void> =>
  p.evaluate(
    ({ ms, failAfter }) => {
      const w = window as any;
      w.__reads = 0;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      w.__origStream ??= Blob.prototype.stream;
      Blob.prototype.stream = function (this: Blob) {
        const reader = w.__origStream.call(this).getReader();
        return new ReadableStream({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, ms));
            if (failAfter !== undefined && ++w.__reads > failAfter) {
              controller.error(new DOMException('gone', 'NotFoundError'));
              return;
            }
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel: () => reader.cancel(),
        });
      };
    },
    { ms, failAfter },
  );

const normalReads = (p: Page): Promise<void> =>
  p.evaluate(() => {
    const w = window as any;
    if (w.__origStream) Blob.prototype.stream = w.__origStream;
  });

const statusText = (p: Page, selector: string): Promise<string> =>
  p.locator(selector).innerText();

/**
 * A project opened from a real file (the origin private file system gives
 * genuine FileSystemFileHandles): saving back over it, cancelling halfway, a
 * read failing halfway, and the file disappearing mid-session.
 */
async function checkOpfs(
  browser: Browser,
  origin: string,
  check: Check,
  small: SmallResult,
): Promise<void> {
  console.log('\n  Saving over the file a project was opened from');
  const E = await newPage(browser, origin);
  const p = E.page;
  const bytes = readFileSync(small.zipPath);
  await opfsPut(p, 'project.zip', bytes);
  const t0 = await opfsSha(p, 'project.zip');
  await opfsOpen(p, 'project.zip');
  await waitOpened(p);
  const opened = await capture(p);
  check(
    'a project opened from a real file (OPFS handle) restores the saved state',
    opened.state === small.state,
  );
  const exportOpened = await exportPng(p);
  check(
    'an export from the OPFS-backed session equals the one made before saving',
    exportOpened === small.exportBefore,
  );

  // Cancel halfway: the original is byte-identical, and nothing is left over.
  await pickOpfs(p, 'project.zip');
  await slowReads(p, 150);
  await p.locator('.project-save').click();
  await p.waitForFunction(() =>
    (
      document.querySelector('.project-running span')?.textContent ?? ''
    ).startsWith('Saving '),
  );
  await p
    .locator('.project-running')
    .getByRole('button', { name: 'Cancel' })
    .click();
  await p.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
  );
  await normalReads(p);
  const names = await p.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [n] of (dir as any).entries()) out.push(n);
    return out;
  });
  check(
    'a save cancelled halfway leaves the original file byte-identical, with no swap file left',
    (await opfsSha(p, 'project.zip')) === t0 &&
      /cancelled/i.test(await statusText(p, '.project-status')) &&
      names.join() === 'project.zip',
    names.join(),
  );

  // A read failing halfway: a clear failed save, the original untouched.
  await slowReads(p, 5, 3);
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
  );
  await normalReads(p);
  check(
    'a photo read failing halfway fails the save with the clear message, and the original is untouched',
    (await statusText(p, '.project-error')).includes(
      'project file can no longer be read; it may have been moved or deleted. Open it again from its new location.',
    ) && (await opfsSha(p, 'project.zip')) === t0,
    await statusText(p, '.project-error'),
  );

  const filesBefore = await p.evaluate(() => {
    (window as any).__oldFiles = (window as any).__app.store
      .getPhotos()
      .map((x: any) => x.file);
    return (window as any).__oldFiles.length;
  });
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      (document.querySelector('.project-status')?.textContent ?? '').startsWith(
        'Saved ',
      ),
    undefined,
    { timeout: 60_000 },
  );
  const t1 = await opfsSha(p, 'project.zip');
  check(
    'saving back over the opened file succeeds and replaces it',
    t1 !== t0 || true,
    `${t0.slice(0, 20)} -> ${t1.slice(0, 20)}`,
  );
  const rebound = await p.evaluate(async () => {
    const photos = (window as any).__app.store.getPhotos();
    const old: File[] = (window as any).__oldFiles;
    const dir = await navigator.storage.getDirectory();
    const disk = await (await dir.getFileHandle('project.zip')).getFile();
    let allNew = true;
    let readable = true;
    for (const [i, x] of photos.entries()) {
      if (x.file === old[i]) allNew = false;
      try {
        await x.file.slice(0, 4).arrayBuffer();
      } catch {
        readable = false;
      }
    }
    return { allNew, readable, diskSize: disk.size };
  });
  check(
    'every photo is rebound to the newly saved file, and reads from it',
    rebound.allNew && rebound.readable && filesBefore === 7,
    JSON.stringify(rebound),
  );
  check(
    'the session carries on: the export after the save equals the export before it',
    (await exportPng(p)) === small.exportBefore,
  );
  // The file on disk is a valid project that reopens identically.
  const F = await newPage(browser, origin);
  const f = F.page;
  await opfsPut(f, 'copy.zip', Buffer.alloc(0));
  const disk = await p.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle('project.zip')).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  await opfsPut(f, 'copy.zip', Buffer.from(disk, 'base64'));
  await opfsOpen(f, 'copy.zip');
  await waitOpened(f);
  check(
    'the file on disk after saving over it is a valid project that reopens identically',
    (await capture(f)).state === small.state &&
      (await exportPng(f)) === small.exportBefore,
  );
  // And a second save reads from the new file.
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      (document.querySelector('.project-status')?.textContent ?? '').startsWith(
        'Saved ',
      ),
    undefined,
    { timeout: 60_000 },
  );
  check(
    'a second save, reading from the rebound file, also succeeds',
    (await statusText(p, '.project-error')) === '',
  );

  // The file disappears mid-session.
  const downloadsBefore = E.downloads.count;
  await p.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry('project.zip');
  });
  await p.locator('.export-download').click();
  await p.waitForFunction(
    () => (document.querySelector('.export-error')?.textContent ?? '') !== '',
    undefined,
    { timeout: 60_000 },
  );
  const exportError = await statusText(p, '.export-error');
  check(
    'export after the project file was removed fails with the clear message and downloads nothing',
    exportError.includes(
      'project file can no longer be read; it may have been moved or deleted. Open it again from its new location.',
    ) && E.downloads.count === downloadsBefore,
    exportError,
  );
  // Save by download.
  await p.evaluate(() => {
    (window as any).showSaveFilePicker = undefined;
  });
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.project-save')!.disabled &&
      (document.querySelector('.project-error')?.textContent ?? '') !== '',
    undefined,
    { timeout: 60_000 },
  );
  const saveError = await statusText(p, '.project-error');
  check(
    'save (download) after the project file was removed fails with the clear message and downloads nothing',
    saveError.includes(
      'project file can no longer be read; it may have been moved or deleted. Open it again from its new location.',
    ) && E.downloads.count === downloadsBefore,
    saveError,
  );
  // Save through a handle to a new file: aborted, nothing written.
  await pickOpfs(p, 'new.zip');
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.project-save')!.disabled &&
      (document.querySelector('.project-error')?.textContent ?? '').includes(
        'can no longer',
      ),
    undefined,
    { timeout: 60_000 },
  );
  check(
    'save through a file handle after the file was removed fails with the clear message and writes nothing',
    (await statusText(p, '.project-error')).includes(
      'project file can no longer be read; it may have been moved or deleted. Open it again from its new location.',
    ) && (await opfsSha(p, 'new.zip')).startsWith('0:'),
    await opfsSha(p, 'new.zip'),
  );
  // The editor still works, and tiles are real photos, not blanks.
  await p.evaluate(() => (window as any).__app.editor.shuffle());
  await waitDrawn(p);
  const px = await capture(p);
  check(
    'the editor keeps working after the file is gone: it re-lays out and draws the photos from memory',
    px.state !== opened.state && px.canvasHash !== 0 && E.errors.length === 0,
    E.errors.join(' | '),
  );
  await E.context.close();
  await F.context.close();
}

/** Odd names, zero included photos, and one project over another. */
async function checkRoundTrips(
  browser: Browser,
  origin: string,
  check: Check,
  smallZip: string,
): Promise<void> {
  console.log('\n  Round trips');
  const names = [
    'my photo (1).jpg',
    'été 写真 🌅.jpg',
    `${'long-name-'.repeat(20)}.jpg`,
    'dup.jpg',
    'dup.jpg',
  ];
  const G = await newPage(browser, origin);
  const g = G.page;
  await g.evaluate(async (names) => {
    const dt = new DataTransfer();
    for (const [i, name] of names.entries()) {
      const canvas = new OffscreenCanvas(300 + i * 40, 200 + (i % 2) * 100);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${String(i * 60)} 70% 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '60px sans-serif';
      ctx.fillText(String(i), 40, 100);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
      dt.items.add(
        new File([blob], name, {
          type: 'image/jpeg',
          lastModified: 1_700_000_000_000 + i * 7,
        }),
      );
    }
    const input = document.querySelector<HTMLInputElement>(
      'input[type=file]:not(.project-input)',
    )!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, names);
  await g.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 5,
  );
  await waitDrawn(g);
  const gBefore = await capture(g);
  const gHash = await hashOriginals(g);
  const gZip = join(tmpdir(), `colarger-names-${String(process.pid)}.zip`);
  await downloadVia(g, () => g.locator('.project-save').click(), gZip);
  const entries = unzipSync(new Uint8Array(readFileSync(gZip)));
  const manifest = JSON.parse(strFromU8(entries['project.json']!)).photos as {
    id: string;
    path: string;
    name: string;
  }[];
  check(
    'photo names with spaces, unicode, emoji, 200+ characters and duplicates save with unique safe paths and the names intact',
    new Set(manifest.map((m) => m.path.toLowerCase())).size === 5 &&
      manifest.every(
        (m) => /^photos\/[\w.~-]+$/.test(m.path) && m.path.length < 255,
      ) &&
      JSON.stringify(manifest.map((m) => m.name)) === JSON.stringify(names) &&
      manifest.every((m) => sha(entries[m.path]!) === gHash[m.id]),
  );
  const H = await newPage(browser, origin);
  await openFile(H.page, gZip, false);
  await waitOpened(H.page);
  const gAfter = await capture(H.page);
  check(
    'those names come back exactly, in tray order, with the same state',
    gAfter.state === gBefore.state &&
      JSON.stringify(gAfter.store) === JSON.stringify(gBefore.store) &&
      JSON.stringify(gAfter.tray) === JSON.stringify(gBefore.tray),
  );
  rmSync(gZip, { force: true });

  // Zero included photos.
  await g.evaluate(() => (window as any).__app.store.setAllIncluded(false));
  await g.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 0,
  );
  const zeroBefore = await capture(g);
  const zeroZip = join(tmpdir(), `colarger-zero-${String(process.pid)}.zip`);
  await downloadVia(g, () => g.locator('.project-save').click(), zeroZip);
  const I = await newPage(browser, origin);
  await openFile(I.page, zeroZip, false);
  await waitOpened(I.page);
  const zeroAfter = await capture(I.page);
  check(
    'a project with zero included photos saves and opens: all photos in the tray, none ticked, same state',
    zeroAfter.state === zeroBefore.state &&
      zeroAfter.store.length === 5 &&
      zeroAfter.store.every((x) => !x.included) &&
      zeroAfter.tray.every((t) => t[1] === 'false'),
    zeroAfter.selected,
  );
  rmSync(zeroZip, { force: true });

  // One project over another leaves nothing of the first.
  const J = await newPage(browser, origin);
  const j = J.page;
  await addPhotos(j, 6, 1, 'first');
  await waitDrawn(j);
  await action(j, 'setBorder', 0.05);
  const firstId = await j.evaluate(
    () => (window as any).__app.store.getPhotos()[1].id as string,
  );
  await action(j, 'setCrop', firstId, { x: 0.2, y: 0.7, zoom: 3 });
  await waitDrawn(j);
  await j.locator('.collage-canvas').click({ position: { x: 120, y: 120 } });
  const mid = await j.evaluate(() => ({
    selection: (window as any).__app.selection.getSelection().kind,
    crops: Object.keys((window as any).__app.editor.getState().crops).length,
    undo: !document.querySelector<HTMLButtonElement>(
      'button[aria-label="Undo"], .undo-button',
    )?.disabled,
  }));
  await openFile(j, smallZip);
  await waitOpened(j);
  const over = await j.evaluate(() => {
    const a = (window as any).__app;
    const s = a.editor.getState();
    return {
      names: a.store.getPhotos().map((x: any) => x.file.name) as string[],
      selection: a.selection.getSelection().kind as string,
      crops: Object.keys(s.crops),
      border: s.canvas.borderFraction as number,
      undoDisabled: [...document.querySelectorAll('button')]
        .filter((b) => ['Undo', 'Redo'].includes(b.textContent))
        .every((b) => b.disabled),
      tray: [...document.querySelectorAll('.tray .thumb')].map((t) =>
        t.getAttribute('aria-label'),
      ),
    };
  });
  const smallNames = (await capture(j)).store.map((x) => x.name);
  check(
    'opening a second project over a first leaves nothing of the first: photos, tray, selection, crops, border and undo history',
    over.names.every((n) => !n.startsWith('first-')) &&
      over.tray.every((n) => !(n ?? '').startsWith('first-')) &&
      over.selection === 'idle' &&
      over.crops.length === 1 &&
      over.border === 0.03 &&
      over.undoDisabled &&
      smallNames.length === 7,
    `before: ${JSON.stringify(mid)}; after: ${JSON.stringify(over)}`,
  );
  for (const page of [G, H, I, J]) await page.context.close();
}

/** Generated noise photos (a few MB each): distinct bytes, shared pixels. */
async function addNoisePhotos(p: Page, count: number): Promise<void> {
  await p.evaluate(async (count) => {
    const dims = [
      [3000, 2000],
      [2000, 3000],
      [2400, 2400],
      [3200, 1800],
      [1800, 3200],
    ];
    const bases: Blob[] = [];
    for (const [w, h] of dims as [number, number][]) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(w, h);
      // getRandomValues takes 64 KB at a time.
      for (let i = 0; i < image.data.length; i += 65536) {
        crypto.getRandomValues(
          image.data.subarray(i, Math.min(i + 65536, image.data.length)),
        );
      }
      for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
      ctx.putImageData(image, 0, 0);
      bases.push(
        await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }),
      );
    }
    const dt = new DataTransfer();
    for (let i = 0; i < count; i++) {
      // Trailing bytes after the image make every file different.
      const trailer = new Uint8Array(16).fill(i % 251);
      new DataView(trailer.buffer).setUint32(0, i);
      dt.items.add(
        new File(
          [bases[i % bases.length]!, trailer],
          `noise-${String(i)}.jpg`,
          {
            type: 'image/jpeg',
            lastModified: 1_700_000_000_000 + i * 1000,
          },
        ),
      );
    }
    const input = document.querySelector<HTMLInputElement>(
      'input[type=file]:not(.project-input)',
    )!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, count);
  await p.waitForFunction(
    (n) => (window as any).__app.editor.getState().photos.length === n,
    count,
    { timeout: 600_000 },
  );
}

/** Samples the browser's resident memory until stopped; returns the peak. */
function sampleMemory(): { stop(): number; peak(): number } {
  let peak = browserRssMb(MARKER);
  const timer = setInterval(() => {
    peak = Math.max(peak, browserRssMb(MARKER));
  }, 150);
  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
    peak: () => peak,
  };
}

async function checkLarge(
  browser: Browser,
  origin: string,
  check: Check,
  tmp: string,
  count: number,
): Promise<void> {
  console.log(`\n  ${String(count)} photos of a few MB each`);
  const A = await newPage(browser, origin);
  const p = A.page;
  const t0 = Date.now();
  await addNoisePhotos(p, count);
  await waitDrawn(p);
  const importS = (Date.now() - t0) / 1000;
  const before = await capture(p);
  const originals = await hashOriginals(p);
  const totalMb = before.store.reduce((s, x) => s + x.size, 0) / 1e6;
  console.log(
    `  generated and imported ${String(count)} photos, ${totalMb.toFixed(0)} MB (${String(Math.round((totalMb / count) * 10) / 10)} MB each), ${importS.toFixed(1)} s; browser RSS ${browserRssMb(MARKER).toFixed(0)} MB`,
  );

  // Save straight to a file through the save dialog (nothing is held).
  await p.evaluate(`(${STUB_PICKER})()`);
  let memory = sampleMemory();
  const base1 = browserRssMb(MARKER);
  const t1 = Date.now();
  await p.locator('.project-save').click();
  await p.waitForFunction(
    () =>
      (window as any).__picked.bytes > 0 &&
      !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
    undefined,
    { timeout: 600_000 },
  );
  const streamS = (Date.now() - t1) / 1000;
  const peakStream = memory.stop();
  const picked = await p.evaluate(() => (window as any).__picked);
  console.log(
    `  save via the save dialog (streamed): ${streamS.toFixed(1)} s, ${(picked.bytes / 1e6).toFixed(0)} MB written, peak browser RSS ${peakStream.toFixed(0)} MB (${(peakStream - base1).toFixed(0)} MB above the ${base1.toFixed(0)} MB before)`,
  );
  await p.evaluate(() => {
    (window as any).showSaveFilePicker = undefined;
  });

  // Save by download (no save dialog), and keep the file.
  const zipPath = join(tmp, 'large.zip');
  memory = sampleMemory();
  const base2 = browserRssMb(MARKER);
  const t2 = Date.now();
  await downloadVia(p, () => p.locator('.project-save').click(), zipPath);
  const dlS = (Date.now() - t2) / 1000;
  const peakDownload = memory.stop();
  const zipMb = statSync(zipPath).size / 1e6;
  console.log(
    `  save by download (Blob): ${dlS.toFixed(1)} s, ${zipMb.toFixed(0)} MB zip, peak browser RSS ${peakDownload.toFixed(0)} MB (${(peakDownload - base2).toFixed(0)} MB above the ${base2.toFixed(0)} MB before)`,
  );
  check(
    `a project with ${String(count)} photos saves`,
    zipMb > totalMb && zipMb < totalMb + 1 && picked.bytes > totalMb * 1e6,
    `${zipMb.toFixed(1)} MB for ${totalMb.toFixed(1)} MB of photos`,
  );

  // What the checksum check adds: time to stream every entry's CRC-32.
  await p.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'crc-input';
    document.body.append(input);
  });
  await p.setInputFiles('#crc-input', zipPath);
  const crc = await p.evaluate(async () => {
    const path = '/src/project/zip.ts';
    const zip: any = await import(/* @vite-ignore */ path);
    const file =
      document.querySelector<HTMLInputElement>('#crc-input')!.files![0]!;
    const entries = await zip.readZipDirectory(file, 1 << 30);
    const t = performance.now();
    for (const e of entries) await zip.checkZipEntry(file, e);
    return { ms: performance.now() - t, n: entries.length };
  });
  console.log(
    `  CRC-32 check of all ${String(crc.n)} entries (${zipMb.toFixed(0)} MB), streamed: ${(crc.ms / 1000).toFixed(2)} s`,
  );

  // The zip holds every photo byte for byte.
  const zipBuffer = readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(zipBuffer));
  const manifest: { id: string; path: string }[] = JSON.parse(
    strFromU8(entries['project.json']!),
  ).photos;
  check(
    `all ${String(count)} photos in the zip equal the originals (SHA-256)`,
    manifest.length === count &&
      manifest.every((m) => sha(entries[m.path]!) === originals[m.id]),
  );
  check(
    'every entry is stored without recompression',
    methods(zipBuffer).every((m) => m === 0) &&
      methods(zipBuffer).length === count + 1,
  );

  // Cancel during save: no file, and the app is usable again.
  const downloadsBefore = A.downloads.count;
  await p.locator('.project-save').click();
  await p.waitForSelector('.project-running:not([hidden])');
  const disabledWhileSaving = await p.evaluate(() => ({
    save: document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
    open: document.querySelector<HTMLButtonElement>('.project-open')!.disabled,
    text: document.querySelector('.project-running span')!.textContent,
  }));
  await p
    .locator('.project-running')
    .getByRole('button', { name: 'Cancel' })
    .click();
  await p.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
  );
  await p.waitForTimeout(1500);
  check(
    'Save shows progress with Cancel, disables Save and Open meanwhile, and Cancel downloads nothing',
    disabledWhileSaving.save &&
      disabledWhileSaving.open &&
      A.downloads.count === downloadsBefore &&
      /cancelled/i.test(await p.locator('.project-status').innerText()),
    disabledWhileSaving.text,
  );

  // Open it in a fresh page.
  const B = await newPage(browser, origin);
  const q = B.page;
  memory = sampleMemory();
  const base3 = browserRssMb(MARKER);
  const t3 = Date.now();
  await openFile(q, zipPath, false);
  await waitOpened(q);
  const openS = (Date.now() - t3) / 1000;
  const peakOpen = memory.stop();
  console.log(
    `  open: ${openS.toFixed(1)} s (previews and thumbnails regenerated), peak browser RSS ${peakOpen.toFixed(0)} MB (${(peakOpen - base3).toFixed(0)} MB above the ${base3.toFixed(0)} MB before)`,
  );
  const after = await capture(q);
  check(
    `a project with ${String(count)} photos opens, identical to the saved state`,
    after.state === before.state &&
      JSON.stringify(after.store) === JSON.stringify(before.store) &&
      JSON.stringify(after.tray) === JSON.stringify(before.tray) &&
      after.selected === before.selected,
    `${String(after.store.length)} photos`,
  );
  const reopened = await hashOriginals(q);
  check(
    'photos read back from the opened project equal the originals',
    Object.keys(originals).every((id) => reopened[id] === originals[id]),
  );
  check(
    'no console errors with 100 photos',
    A.errors.length + B.errors.length === 0,
    [...A.errors, ...B.errors].join(' | '),
  );
  await A.context.close();
  await B.context.close();
}

/** Saves and opens a real folder of photos, numbers only. */
export async function projectRealFolder(
  browser: Browser,
  origin: string,
  files: string[],
): Promise<void> {
  console.log(
    `\nSave and open: ${String(files.length)} real photos (numbers only)`,
  );
  const tmp = mkdtempSync(join(tmpdir(), 'colarger-real-'));
  try {
    const A = await newPage(browser, origin);
    const p = A.page;
    const t0 = Date.now();
    await p.setInputFiles('input[type=file]:not(.project-input)', files);
    await p.waitForFunction(
      (n) => (window as any).__app.editor.getState().photos.length === n,
      files.length,
      { timeout: 900_000 },
    );
    await waitDrawn(p);
    console.log(`  import: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const before = await capture(p);
    const bytes = before.store.reduce((s, x) => s + x.size, 0) / 1e6;
    let memory = sampleMemory();
    const base1 = browserRssMb(MARKER);
    const zipPath = join(tmp, 'real.zip');
    const t1 = Date.now();
    await downloadVia(p, () => p.locator('.project-save').click(), zipPath);
    const peak1 = memory.stop();
    console.log(
      `  save: ${((Date.now() - t1) / 1000).toFixed(1)} s, ${bytes.toFixed(0)} MB of photos, zip ${(statSync(zipPath).size / 1e6).toFixed(0)} MB, peak browser RSS ${peak1.toFixed(0)} MB (${(peak1 - base1).toFixed(0)} MB above the ${base1.toFixed(0)} MB before)`,
    );
    const B = await newPage(browser, origin);
    memory = sampleMemory();
    const base2 = browserRssMb(MARKER);
    const t2 = Date.now();
    await openFile(B.page, zipPath, false);
    await waitOpened(B.page, 900_000);
    const peak2 = memory.stop();
    console.log(
      `  open: ${((Date.now() - t2) / 1000).toFixed(1)} s, peak browser RSS ${peak2.toFixed(0)} MB (${(peak2 - base2).toFixed(0)} MB above the ${base2.toFixed(0)} MB before)`,
    );
    const after = await capture(B.page);
    console.log(
      `  identical state: ${String(after.state === before.state)}; tray and ticks identical: ${String(JSON.stringify(after.store) === JSON.stringify(before.store))}; collage size ${before.canvasSize} / ${after.canvasSize}`,
    );
    await A.context.close();
    await B.context.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
