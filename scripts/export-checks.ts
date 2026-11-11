/**
 * Real-browser checks for export (issue #11), called from browser-check.ts
 * (Chrome) and runnable alone for another engine:
 *
 *   node scripts/browser-check.ts --a2-only --engine firefox
 *
 * Photos are generated in the page, so nothing large is written to disk.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';

type Check = (name: string, ok: boolean, detail?: string) => void;

const STATE_MODULE = '/src/editor/state.ts';
const RENDER_MODULE = '/src/editor/render.ts';

/** Recorded in every page: exported blobs, bitmap use and revoked URLs. */
const INIT_SCRIPT = `(() => {
  const w = window;
  w.__exports = [];
  w.__revoked = [];
  w.__open = 0;
  w.__maxOpen = 0;
  w.__resizeCalls = [];
  w.__failName = null;
  const tagged = new WeakSet();
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => {
    if (b instanceof Blob && /^image\\/(png|jpeg)$/.test(b.type)) w.__exports.push(b);
    return create(b);
  };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u) => { w.__revoked.push(u); revoke(u); };
  const decode = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (src, ...rest) => {
    const running = document.querySelector('.export-running');
    const inExport = !!running && !running.hidden;
    if (inExport && w.__failName && src.name === w.__failName) {
      throw new Error('injected decode failure');
    }
    const bitmap = await decode(src, ...rest);
    if (inExport) {
      tagged.add(bitmap);
      w.__open++;
      w.__maxOpen = Math.max(w.__maxOpen, w.__open);
      const opts = rest[0] || {};
      if (opts.resizeWidth) w.__resizeCalls.push({ w: opts.resizeWidth, h: opts.resizeHeight, q: opts.resizeQuality, o: opts.imageOrientation, bw: bitmap.width, bh: bitmap.height });
    }
    return bitmap;
  };
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () {
    if (tagged.has(this)) { tagged.delete(this); w.__open--; }
    return close.call(this);
  };
})();`;

export async function newExportPage(
  browser: Browser,
  origin: string,
  viewport = { width: 1280, height: 800 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForSelector('.tray');
  return { context, page };
}

/** Adds generated photos (gradients, text; the first has a red disc). */
export async function addPhotos(
  p: Page,
  count: number,
  scale = 1,
  prefix = 'p',
): Promise<void> {
  await p.evaluate(
    async ({ count, scale, prefix }) => {
      const sizes = [
        [900, 600],
        [600, 900],
        [800, 800],
        [1200, 500],
        [500, 1000],
        [1000, 750],
        [750, 1000],
      ];
      const files: File[] = [];
      const cache = new Map<string, Blob>();
      for (let i = 0; i < count; i++) {
        const [w, h] = sizes[i % sizes.length] as [number, number];
        const hue = (i * 37) % 360;
        const key = String(i % (sizes.length * 3));
        let blob = cache.get(key);
        if (!blob) {
          const c = new OffscreenCanvas(
            Math.round(w * scale),
            Math.round(h * scale),
          );
          const ctx = c.getContext('2d')!;
          ctx.scale(scale, scale);
          const g = ctx.createLinearGradient(0, 0, w, h);
          g.addColorStop(0, `hsl(${String(120 + (hue % 140))} 60% 55%)`);
          g.addColorStop(1, `hsl(${String(150 + (hue % 110))} 60% 25%)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = 'bold 72px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(i), w / 2, h / 2 + 24);
          if (i === 0) {
            ctx.fillStyle = '#ff0000';
            ctx.beginPath();
            ctx.arc(w * 0.78, h * 0.35, 70, 0, Math.PI * 2);
            ctx.fill();
          }
          blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          cache.set(key, blob);
        }
        files.push(
          new File(
            [blob],
            i === 0 ? 'marker.jpg' : `${prefix}-${String(i)}.jpg`,
            {
              type: 'image/jpeg',
              lastModified: 1_700_000_000_000 + i,
            },
          ),
        );
      }
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const input =
        document.querySelector<HTMLInputElement>('input[type=file]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { count, scale, prefix },
  );
  await p.waitForFunction(
    (n) => (window as any).__app.editor.getState().photos.length === n,
    count,
    { timeout: 300_000 },
  );
}

export function action(
  p: Page,
  name: string,
  ...args: unknown[]
): Promise<void> {
  return p.evaluate(
    async ({ name, args, module }) => {
      const actions = await import(/* @vite-ignore */ module);
      (window as any).__app.editor.dispatch((s: unknown) =>
        actions[name](s, ...args),
      );
    },
    { name, args, module: STATE_MODULE },
  );
}

export async function waitDrawn(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const state = app.editor.getState();
      return (
        last !== null &&
        last.state === state &&
        last.missing === 0 &&
        state.photos.length === app.store.getIncludedIds().length
      );
    },
    undefined,
    { timeout: 60_000, polling: 50 },
  );
}

/** Image size from the first bytes of a PNG or JPEG file. */
export function imageSize(
  bytes: Buffer,
): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  if (bytes.readUInt32BE(0) === 0x89504e47) {
    return {
      type: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] as number;
      const length = bytes.readUInt16BE(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        return {
          type: 'jpeg',
          height: bytes.readUInt16BE(i + 5),
          width: bytes.readUInt16BE(i + 7),
        };
      }
      i += 2 + length;
    }
  }
  return null;
}

interface Exported {
  name: string;
  type: string;
  width: number;
  height: number;
  size: number;
  seconds: number;
}

/** Chooses the format, presses Download and waits for the file. */
async function exportAs(
  p: Page,
  format: 'png' | 'jpeg',
  timeout = 120_000,
): Promise<Exported> {
  await p
    .locator('.export-option', {
      hasText: format === 'png' ? 'PNG' : 'JPEG',
    })
    .click();
  const started = Date.now();
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout }),
    p.locator('.export-download').click(),
  ]);
  const path = await download.path();
  const bytes = readFileSync(path);
  const dims = imageSize(bytes);
  return {
    name: download.suggestedFilename(),
    type: dims?.type ?? 'unknown',
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    size: bytes.length,
    seconds: (Date.now() - started) / 1000,
  };
}

/** Waits for the export to finish (button enabled again). */
async function idle(p: Page, timeout = 120_000): Promise<void> {
  await p.waitForFunction(
    () => {
      const b = document.querySelector<HTMLButtonElement>('.export-download')!;
      return (
        !b.disabled &&
        document.querySelector<HTMLElement>('.export-running')!.hidden
      );
    },
    undefined,
    { timeout },
  );
}

/** The last exported blob, decoded and drawn on an offscreen canvas. */
const LOAD_EXPORT = `async () => {
  const blob = window.__exports.at(-1);
  const bitmap = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { c, ctx };
}`;

export async function checkExport(
  browser: Browser,
  origin: string,
  check: Check,
  options: { screenshots?: string } = {},
): Promise<void> {
  console.log('\nExport (issue #11)');
  const { context, page: p } = await newExportPage(browser, origin);

  // --- No photos: disabled, with the reason ---------------------------------
  const emptyState = await p.evaluate(() => ({
    disabled:
      document.querySelector<HTMLButtonElement>('.export-download')!.disabled,
    hint: document.querySelector('.export-hint')!.textContent,
  }));
  check(
    'Download is disabled with a reason when the collage has no photos',
    emptyState.disabled && /add photos/i.test(emptyState.hint),
    JSON.stringify(emptyState),
  );

  // --- A collage with a border, a background, and a zoomed, panned crop ------
  await addPhotos(p, 7);
  await action(p, 'setCanvasSize', 2400, 1800);
  await action(p, 'setBorder', 0.02);
  await action(p, 'setBackground', '#ff00ff');
  const markerId = await p.evaluate(
    () =>
      (window as any).__app.store
        .getPhotos()
        .find((x: any) => x.file.name === 'marker.jpg').id as string,
  );
  await action(p, 'setCrop', markerId, { x: 0.8, y: 0.3, zoom: 2.2 });
  await waitDrawn(p);
  const hasFormat = await p.evaluate(() => ({
    png: document.querySelector('.export-download')!.textContent,
    quality: document.querySelector<HTMLInputElement>('.export-quality input')!
      .value,
  }));
  check(
    'Export control: format choice and a JPEG quality defaulting to 92',
    hasFormat.png === 'Download PNG' && hasFormat.quality === '92',
    JSON.stringify(hasFormat),
  );

  // The preview, as drawn now (before any export).
  await p.evaluate(() => {
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const ctx = canvas.getContext('2d')!;
    (window as any).__preview = ctx.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
  });

  // Watch for store notifications and progress texts, and edit mid-export.
  await p.evaluate(() => {
    const w = window as any;
    w.__notified = 0;
    w.__photoNotified = 0;
    w.__unsub = [
      w.__app.editor.subscribe(() => {
        w.__notified++;
      }),
      w.__app.store.subscribe(() => {
        w.__photoNotified++;
      }),
    ];
    w.__progress = [];
    const text = document.querySelector('.export-progress-text')!;
    new MutationObserver(() => {
      w.__progress.push(text.textContent);
    }).observe(text, { childList: true, characterData: true, subtree: true });
  });

  const png = await exportAs(p, 'png');
  await idle(p);
  check(
    'PNG export has exactly the configured pixel dimensions and a sensible name',
    png.type === 'png' &&
      png.width === 2400 &&
      png.height === 1800 &&
      png.name === 'collage-2400x1800.png',
    JSON.stringify(png),
  );
  const notices = await p.evaluate(() => ({
    editor: (window as any).__notified,
    photos: (window as any).__photoNotified,
    progress: [...new Set((window as any).__progress as string[])],
    open: (window as any).__open,
    maxOpen: (window as any).__maxOpen,
    resize: (window as any).__resizeCalls.length,
    revoked: (window as any).__revoked.length,
  }));
  check(
    'exporting causes zero editor and photo store notifications',
    notices.editor === 0 && notices.photos === 0,
    JSON.stringify(notices),
  );
  check(
    'a progress indicator shows tiles done out of total, then encoding',
    notices.progress.some((t) => /Rendering \d+ \/ 7/.test(t)) &&
      notices.progress.includes('Encoding…'),
    notices.progress.join(' | '),
  );
  check(
    'one original is decoded at a time and all are closed',
    notices.maxOpen === 1 && notices.open === 0,
    `max open ${String(notices.maxOpen)}, open ${String(notices.open)}`,
  );
  await p.waitForTimeout(100);

  // Pixels: size, preview match, border and background.
  const analysis = await p.evaluate(
    async ({ renderModule, load }) => {
      const w = window as any;
      const { ctx, c } = await (0, eval)(`(${load})`)();
      const { tilesFor } = await import(/* @vite-ignore */ renderModule);
      const state = w.__app.editor.getState();
      const preview: ImageData = w.__preview;
      // The export, downscaled to the preview's size, against the preview.
      const small = new OffscreenCanvas(preview.width, preview.height);
      const sctx = small.getContext('2d')!;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(c, 0, 0, preview.width, preview.height);
      const got = sctx.getImageData(0, 0, preview.width, preview.height).data;
      let sum = 0;
      let big = 0;
      for (let i = 0; i < got.length; i += 4) {
        const d =
          (Math.abs(got[i]! - preview.data[i]!) +
            Math.abs(got[i + 1]! - preview.data[i + 1]!) +
            Math.abs(got[i + 2]! - preview.data[i + 2]!)) /
          3;
        sum += d;
        if (d > 48) big++;
      }
      const pixels = got.length / 4;
      // The marker's tile alone (the zoomed, panned crop), inset 4 px.
      const last = w.__app.view.lastRender();
      const slot = state.assignment.indexOf(
        w.__app.store.getPhotos().find((x: any) => x.file.name === 'marker.jpg')
          .id,
      );
      const tile = last.tiles.find((t: any) => t.slot === slot);
      let tsum = 0;
      let tn = 0;
      for (let y = tile.y + 4; y < tile.y + tile.height - 4; y++) {
        for (let x = tile.x + 4; x < tile.x + tile.width - 4; x++) {
          const i = (y * preview.width + x) * 4;
          tsum +=
            (Math.abs(got[i]! - preview.data[i]!) +
              Math.abs(got[i + 1]! - preview.data[i + 1]!) +
              Math.abs(got[i + 2]! - preview.data[i + 2]!)) /
            3;
          tn++;
        }
      }
      // Border and background at the output size: magenta just outside every
      // tile's edge, and none inside it.
      const tiles = tilesFor(state, { width: c.width, height: c.height });
      const magenta = (x: number, y: number): boolean => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return d[0] > 240 && d[1] < 15 && d[2] > 240;
      };
      let edgesOk = 0;
      let edges = 0;
      for (const t of tiles) {
        const mx = Math.floor(t.x + t.width / 2);
        const my = Math.floor(t.y + t.height / 2);
        for (const [x, y, outside] of [
          [mx, t.y - 1, true],
          [mx, t.y + t.height, true],
          [t.x - 1, my, true],
          [t.x + t.width, my, true],
          [mx, t.y, false],
          [mx, t.y + t.height - 1, false],
          [t.x, my, false],
          [t.x + t.width - 1, my, false],
        ] as [number, number, boolean][]) {
          if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
          // A pixel between two tiles is another tile's, not background.
          if (outside && !magenta(x, y)) continue;
          edges++;
          if (magenta(x, y) === outside) edgesOk++;
        }
      }
      const border = state.canvas.borderFraction * Math.min(c.width, c.height);
      const minX = Math.min(...tiles.map((t: any) => t.x));
      return {
        width: c.width,
        height: c.height,
        meanDiff: sum / pixels,
        bigFraction: big / pixels,
        tileDiff: tsum / tn,
        edgesOk,
        edges,
        corner: [...ctx.getImageData(2, 2, 1, 1).data],
        border,
        minX,
        previewW: preview.width,
      };
    },
    { renderModule: RENDER_MODULE, load: LOAD_EXPORT },
  );
  check(
    'decoded PNG is exactly 2400 x 1800',
    analysis.width === 2400 && analysis.height === 1800,
  );
  check(
    'exported pixels match the editor preview (downscaled export vs preview)',
    analysis.meanDiff < 4 && analysis.bigFraction < 0.03,
    `mean abs diff ${analysis.meanDiff.toFixed(2)}, ${(analysis.bigFraction * 100).toFixed(2)}% of pixels over 48, preview ${String(analysis.previewW)} px wide`,
  );
  check(
    'the zoomed and panned tile matches the preview',
    analysis.tileDiff < 6,
    `mean abs diff ${analysis.tileDiff.toFixed(2)}`,
  );
  check(
    'border and background: magenta outside every tile edge, photo inside',
    analysis.edges > 0 && analysis.edgesOk === analysis.edges,
    `${String(analysis.edgesOk)} / ${String(analysis.edges)}; corner ${analysis.corner.join(',')}; outer border ${String(analysis.minX)} px (requested ${analysis.border.toFixed(1)})`,
  );

  if (options.screenshots) {
    // The editor preview beside the export (2400 x 1800, shown downscaled).
    const url = await p.evaluate(async (load) => {
      const { c } = await (0, eval)(`(${load})`)();
      const preview =
        document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const w = preview.width;
      const h = preview.height;
      const out = document.createElement('canvas');
      out.width = w * 2 + 30;
      out.height = h + 40;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#121316';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.fillStyle = '#e8e9ec';
      ctx.font = '16px sans-serif';
      ctx.fillText('Editor preview', 10, 24);
      ctx.fillText(
        `Export, ${String(c.width)} x ${String(c.height)} px (shown at ${String(w)} px wide)`,
        w + 20,
        24,
      );
      ctx.drawImage(preview, 10, 40);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(c, w + 20, 40, w, h);
      return out.toDataURL('image/jpeg', 0.85);
    }, LOAD_EXPORT);
    writeFileSync(
      join(options.screenshots, 'issue-11-export-vs-preview.jpg'),
      Buffer.from(url.split(',')[1] ?? '', 'base64'),
    );
  }

  // --- JPEG: dimensions, quality, same content ------------------------------
  const jpeg92 = await exportAs(p, 'jpeg');
  await idle(p);
  check(
    'JPEG export has exactly the configured pixel dimensions',
    jpeg92.type === 'jpeg' &&
      jpeg92.width === 2400 &&
      jpeg92.height === 1800 &&
      jpeg92.name === 'collage-2400x1800.jpg',
    JSON.stringify(jpeg92),
  );
  await p.locator('.export-quality input').fill('50');
  const jpeg50 = await exportAs(p, 'jpeg');
  await idle(p);
  check(
    'a lower JPEG quality gives a smaller file',
    jpeg50.size < jpeg92.size,
    `${String(jpeg50.size)} < ${String(jpeg92.size)} bytes`,
  );
  const jpegMatch = await p.evaluate(
    async ({ load }) => {
      const { ctx, c } = await (0, eval)(`(${load})`)();
      const preview: ImageData = (window as any).__preview;
      const small = new OffscreenCanvas(preview.width, preview.height);
      const sctx = small.getContext('2d')!;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(c, 0, 0, preview.width, preview.height);
      const got = sctx.getImageData(0, 0, preview.width, preview.height).data;
      let sum = 0;
      for (let i = 0; i < got.length; i += 4) {
        sum +=
          (Math.abs(got[i]! - preview.data[i]!) +
            Math.abs(got[i + 1]! - preview.data[i + 1]!) +
            Math.abs(got[i + 2]! - preview.data[i + 2]!)) /
          3;
      }
      const corner = [...ctx.getImageData(2, 2, 1, 1).data];
      return { mean: sum / (got.length / 4), corner };
    },
    { load: LOAD_EXPORT },
  );
  check(
    'JPEG has no transparent pixels: the background is painted (magenta corner), and it matches the preview',
    jpegMatch.corner[3] === 255 &&
      jpegMatch.corner[0]! > 230 &&
      jpegMatch.corner[1]! < 30 &&
      jpegMatch.mean < 5,
    `corner ${jpegMatch.corner.join(',')}, mean diff ${jpegMatch.mean.toFixed(2)}`,
  );
  await p.waitForTimeout(10_500);
  const revoked = await p.evaluate(() => (window as any).__revoked.length);
  check(
    'every download URL is revoked afterwards',
    revoked >= 3,
    `${String(revoked)} revoked`,
  );

  // --- Editing during an export does not corrupt it -------------------------
  await p.locator('.export-quality input').fill('92');
  await p.evaluate(() => {
    (window as any).__exports.length = 0;
  });
  await p.locator('.export-option', { hasText: 'PNG' }).click();
  const during = p.waitForEvent('download', { timeout: 120_000 });
  await p.locator('.export-download').click();
  await action(p, 'setBackground', '#00ff00');
  await p.evaluate(() => (window as any).__app.editor.shuffle());
  await during;
  await idle(p);
  const snap = await p.evaluate(
    async ({ load }) => {
      const { ctx } = await (0, eval)(`(${load})`)();
      return [...ctx.getImageData(2, 2, 1, 1).data];
    },
    { load: LOAD_EXPORT },
  );
  check(
    'editing during an export (background, shuffle) leaves the export as it was when pressed',
    snap[0]! > 240 && snap[1]! < 15 && snap[2]! > 240,
    `corner ${snap.join(',')}`,
  );
  await p.evaluate(() => {
    for (const u of (window as any).__unsub) u();
  });

  // --- Decode failure, canvas failure ----------------------------------------
  await action(p, 'setBackground', '#ff00ff');
  await p.evaluate(() => {
    (window as any).__failName = 'p-3.jpg';
    (window as any).__exports.length = 0;
  });
  const downloads = { count: 0 };
  p.once('download', () => {
    downloads.count++;
  });
  await p.locator('.export-download').click();
  await idle(p);
  const failure = await p.locator('.export-error').innerText();
  check(
    'a photo that fails to decode stops the export with an error naming it, and nothing downloads',
    failure.includes('p-3.jpg') &&
      downloads.count === 0 &&
      (await p.evaluate(() => (window as any).__exports.length)) === 0,
    failure,
  );
  await p.evaluate(() => {
    (window as any).__failName = null;
    (window as any).__RealOffscreen = window.OffscreenCanvas;
    (window as any).OffscreenCanvas = function () {
      throw new Error('canvas too large');
    };
  });
  await p.locator('.export-download').click();
  await idle(p);
  const tooLarge = await p.locator('.export-error').innerText();
  check(
    'a canvas the browser cannot create gives the too-large message, with no download',
    tooLarge.includes('too large for this browser to export') &&
      downloads.count === 0 &&
      (await p.evaluate(() => (window as any).__exports.length)) === 0,
    tooLarge,
  );
  await p.evaluate(() => {
    (window as any).OffscreenCanvas = (window as any).__RealOffscreen;
  });

  // --- Cancel -----------------------------------------------------------------
  await action(p, 'setCanvasSize', 4961, 7016);
  await waitDrawn(p);
  await p.evaluate(() => {
    (window as any).__exports.length = 0;
    (window as any).__open = 0;
  });
  const cancelled = { download: false };
  p.on('download', () => {
    cancelled.download = true;
  });
  await p.locator('.export-download').click();
  await p.waitForSelector('.export-running:not([hidden])');
  const busy = await p.evaluate(() => ({
    disabled:
      document.querySelector<HTMLButtonElement>('.export-download')!.disabled,
    progress: document.querySelector('.export-progress-text')!.textContent,
  }));
  check(
    'Download is disabled and progress is visible while an export runs',
    busy.disabled && busy.progress.includes('Rendering'),
    JSON.stringify(busy),
  );
  const cancelStart = Date.now();
  await p.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('.export-running button')!
      .click();
  });
  await idle(p, 10_000);
  const cancelSeconds = (Date.now() - cancelStart) / 1000;
  await p.waitForTimeout(1500);
  const afterCancel = await p.evaluate(() => ({
    status: document.querySelector('.export-status')!.textContent,
    open: (window as any).__open,
    exports: (window as any).__exports.length,
  }));
  check(
    'Cancel stops promptly, releases everything and leaves no download',
    cancelSeconds < 3 &&
      !cancelled.download &&
      afterCancel.exports === 0 &&
      afterCancel.open === 0 &&
      /cancel/i.test(afterCancel.status),
    `${cancelSeconds.toFixed(2)} s; ${JSON.stringify(afterCancel)}`,
  );
  if (options.screenshots) {
    await p.evaluate(() => {
      document.querySelector('.export-section')!.scrollIntoView();
    });
    // Slow each decode down, so the screenshot catches the export part-way.
    await p.evaluate(() => {
      const decode = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, 500));
        return (decode as any)(...args);
      };
    });
    await p.locator('.export-download').click();
    await p.waitForSelector('.export-running:not([hidden])');
    await p.waitForFunction(
      () =>
        /Rendering [3-9]/.test(
          document.querySelector('.export-progress-text')!.textContent,
        ),
      undefined,
      { timeout: 60_000 },
    );
    await p.locator('.export-section').screenshot({
      path: join(options.screenshots, 'issue-11-progress.png'),
    });
    await p.locator('.export-running button').click();
    await idle(p, 10_000);
    await p.locator('.export-section').screenshot({
      path: join(options.screenshots, 'issue-11-export-control.png'),
    });
  }
  p.removeAllListeners('download');
  await context.close();

  await checkSeams(browser, origin, check);
  await checkOrientationAndSharpness(browser, origin, check);
}

/** No background shows between tiles at border 0, at awkward sizes. */
async function checkSeams(
  browser: Browser,
  origin: string,
  check: Check,
): Promise<void> {
  const { context, page: p } = await newExportPage(browser, origin);
  await addPhotos(p, 23);
  await action(p, 'setBackground', '#ff00ff');
  await action(p, 'setBorder', 0);
  await action(p, 'setVariation', 0.9);
  let worst = 0;
  const sizes: [number, number][] = [
    [2399, 1799],
    [1777, 2371],
    [3001, 3001],
  ];
  for (const [w, h] of sizes) {
    await action(p, 'setCanvasSize', w, h);
    await waitDrawn(p);
    await exportAs(p, 'png');
    await idle(p);
    const seams = await p.evaluate(async (load) => {
      const { ctx, c } = await (0, eval)(`(${load})`)();
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! > 200) n++;
      }
      return n;
    }, LOAD_EXPORT);
    worst = Math.max(worst, seams);
    if (seams > 0)
      console.log(
        `    ${String(w)}x${String(h)}: ${String(seams)} background pixels`,
      );
  }
  check(
    'no seams: no background pixels at border 0 (23 photos, three awkward sizes)',
    worst === 0,
    `${String(worst)} background pixels`,
  );
  await context.close();
}

async function checkOrientationAndSharpness(
  browser: Browser,
  origin: string,
  check: Check,
): Promise<void> {
  // An EXIF orientation 6 photo, stored 4000 x 3000 and shown 3000 x 4000:
  // red square at the upright top left, green at the bottom right, yellow at
  // (2400..2700, 300..600) upright.
  const dir = mkdtempSync(join(tmpdir(), 'co-larger-orient-'));
  let bytes: Buffer;
  try {
    const up = join(dir, 'up.jpg');
    const out = join(dir, 'orient6.jpg');
    execFileSync('magick', [
      '-size',
      '3000x4000',
      'gradient:#3060c0-#202020',
      '-fill',
      '#e02020',
      '-draw',
      'rectangle 0,0 599,599',
      '-fill',
      '#20c040',
      '-draw',
      'rectangle 2400,3400 2999,3999',
      '-fill',
      '#f0e020',
      '-draw',
      'rectangle 2400,300 2699,599',
      '-quality',
      '90',
      up,
    ]);
    execFileSync('magick', [up, '-rotate', '-90', '-quality', '90', out]);
    execFileSync('exiftool', [
      '-q',
      '-overwrite_original',
      '-n',
      '-Orientation=6',
      out,
    ]);
    bytes = readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { context, page: p } = await newExportPage(browser, origin);
  await p.setInputFiles('input[type=file]', {
    name: 'orient6.jpg',
    mimeType: 'image/jpeg',
    buffer: bytes,
  });
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 1,
  );
  const info = await p.evaluate(() => {
    const photo = (window as any).__app.store.getPhotos()[0];
    return { w: photo.width, h: photo.height };
  });
  check(
    'the EXIF-rotated photo is read as 3000 x 4000 (upright)',
    info.w === 3000 && info.h === 4000,
    JSON.stringify(info),
  );
  await action(p, 'setCanvasSize', 600, 800);
  await action(p, 'setBorder', 0);
  await waitDrawn(p);
  const pixel = (x: number, y: number): Promise<number[]> =>
    p.evaluate(
      async ({ load, x, y }) => {
        const { ctx } = await (0, eval)(`(${load})`)();
        return [...ctx.getImageData(x, y, 1, 1).data];
      },
      { load: LOAD_EXPORT, x, y },
    );
  const reddish = (c: number[]): boolean =>
    c[0]! > 170 && c[1]! < 90 && c[2]! < 90;
  const greenish = (c: number[]): boolean =>
    c[1]! > 140 && c[0]! < 90 && c[2]! < 120;
  const yellowish = (c: number[]): boolean =>
    c[0]! > 190 && c[1]! > 170 && c[2]! < 110;

  const first = await exportAs(p, 'png');
  await idle(p);
  const resize = await p.evaluate(() => (window as any).__resizeCalls);
  check(
    'EXIF orientation 6 photo: decoded shrunk with high quality, and upright in the export (red top left, green bottom right, yellow top right)',
    first.width === 600 &&
      first.height === 800 &&
      reddish(await pixel(25, 25)) &&
      greenish(await pixel(575, 775)) &&
      yellowish(await pixel(510, 90)) &&
      resize.some(
        (r: any) =>
          r.w === 600 &&
          r.h === 800 &&
          r.q === 'high' &&
          r.bw === 600 &&
          r.bh === 800,
      ),
    JSON.stringify(resize),
  );

  // Zoomed and panned: region x 1800..3000, y 0..1600 of the upright photo,
  // drawn at half size. The yellow square is at output (300..450, 150..300).
  await p.evaluate(async (module) => {
    const { setCrop } = await import(/* @vite-ignore */ module);
    const w = window as any;
    const id = w.__app.store.getPhotos()[0].id;
    w.__app.editor.dispatch((s: unknown) =>
      setCrop(s, id, { x: 0.8, y: 0.2, zoom: 2.5 }),
    );
  }, STATE_MODULE);
  await waitDrawn(p);
  await p.evaluate(() => {
    (window as any).__resizeCalls.length = 0;
  });
  await exportAs(p, 'png');
  await idle(p);
  const zoomResize = await p.evaluate(() => (window as any).__resizeCalls);
  check(
    'EXIF photo with a zoomed, panned crop: right region (yellow square in place, no red or green corners), decoded at 1:1 for the visible region',
    yellowish(await pixel(375, 225)) &&
      !reddish(await pixel(25, 25)) &&
      !greenish(await pixel(575, 775)) &&
      !yellowish(await pixel(100, 100)) &&
      zoomResize.some((r: any) => r.w === 1500 && r.h === 2000),
    JSON.stringify(zoomResize),
  );
  await context.close();

  // --- Sharpness: fine detail survives from the original ----------------------
  const sharp = await newExportPage(browser, origin);
  const q = sharp.page;
  // A 4000 x 3000 PNG: 1 px checker in the left half, 4 px checker in the right.
  await q.evaluate(async () => {
    const c = new OffscreenCanvas(4000, 3000);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(4000, 3000);
    for (let y = 0; y < 3000; y++) {
      for (let x = 0; x < 4000; x++) {
        const cell = x < 2000 ? 1 : 4;
        const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 255 : 0;
        const i = (y * 4000 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'checker.png', { type: 'image/png' }));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await q.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 1,
    undefined,
    { timeout: 60_000 },
  );
  await action(q, 'setBorder', 0);

  /** Share of sampled pixels equal to the checker pattern, per region. */
  const checker = (
    cell: number,
    ox: number,
    oy: number,
    scale: number,
    from: number,
    to: number,
  ): Promise<number> =>
    q.evaluate(
      async ({ load, cell, ox, oy, scale, from, to }) => {
        const { ctx, c } = await (0, eval)(`(${load})`)();
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let ok = 0;
        let n = 0;
        for (let y = 2; y < c.height - 2; y += 3) {
          for (let x = from; x < to; x += 3) {
            // The source pixel at the output pixel's centre.
            const sx = ox + (x + 0.5) * scale;
            const sy = oy + (y + 0.5) * scale;
            const want =
              (Math.floor(sx / cell) + Math.floor(sy / cell)) % 2 ? 255 : 0;
            const got = d[(y * c.width + x) * 4]!;
            n++;
            if (Math.abs(got - want) < 40) ok++;
          }
        }
        return ok / n;
      },
      { load: LOAD_EXPORT, cell, ox, oy, scale, from, to },
    );

  // 1. Full size: 4000 x 3000 output, the left half is a 1 px checker.
  await action(q, 'setCanvasSize', 4000, 3000);
  await waitDrawn(q);
  await exportAs(q, 'png');
  await idle(q);
  const fine = await checker(1, 0, 0, 1, 4, 1996);
  check(
    'large tile is sharp: a 1 px checker in the original is reproduced exactly (not from the 1024 px preview)',
    fine > 0.999,
    `${(fine * 100).toFixed(2)}% of sampled pixels match`,
  );

  // 2. Shrunk decode: 1000 x 750 output of the right half's 4 px cells at
  // zoom 2, panned: crop x .75 y .6 -> region 2000 x 1500, sx = 3000 - 1000,
  // clamped to 2000; sy = 1800 - 750 = 1050. Cells become 2 px.
  await action(q, 'setCanvasSize', 1000, 750);
  await q.evaluate(async (module) => {
    const { setCrop } = await import(/* @vite-ignore */ module);
    const w = window as any;
    const id = w.__app.store.getPhotos()[0].id;
    w.__app.editor.dispatch((s: unknown) =>
      setCrop(s, id, { x: 0.75, y: 0.6, zoom: 2 }),
    );
  }, STATE_MODULE);
  await waitDrawn(q);
  await q.evaluate(() => {
    (window as any).__resizeCalls.length = 0;
  });
  await exportAs(q, 'png');
  await idle(q);
  const zoomed = await checker(4, 2000, 1050, 2, 4, 996);
  const zoomCalls = await q.evaluate(() => (window as any).__resizeCalls);
  check(
    'zoomed, panned crop decoded at half size: the 4 px cells are crisp and in the right place',
    zoomed > 0.97 && zoomCalls.some((r: any) => r.w === 2000 && r.h === 1500),
    `${(zoomed * 100).toFixed(2)}% match; ${JSON.stringify(zoomCalls)}`,
  );
  await sharp.context.close();
}

/** Peak resident memory of a browser's processes, sampled with ps. */
export function browserRssMb(marker: string): number {
  const out = execFileSync('ps', ['-axo', 'rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let kb = 0;
  for (const line of out.split('\n')) {
    if (line.includes(marker)) kb += Number.parseInt(line.trim(), 10) || 0;
  }
  return kb / 1024;
}

/**
 * Posters up to A2 at 300 DPI (4961 x 7016) from about 100 photos of camera
 * size: PNG and JPEG, with time and peak memory of the browser's processes.
 */
export async function checkA2(
  browser: Browser,
  origin: string,
  check: Check,
  label: string,
  processMarker: string,
  count = 100,
): Promise<void> {
  console.log(`\nA2 at 300 DPI, ${String(count)} photos (${label})`);
  const { context, page: p } = await newExportPage(browser, origin);
  const t0 = Date.now();
  // 12 megapixel-class photos (about 4000 x 3000), in a few shapes.
  await addPhotos(p, count, 4, 'cam');
  console.log(`  import: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await action(p, 'setCanvasSize', 4961, 7016);
  await waitDrawn(p);
  const photoInfo = await p.evaluate(() => {
    const photos = (window as any).__app.store.getPhotos();
    return {
      n: photos.length,
      mp:
        photos.reduce((s: number, x: any) => s + x.width * x.height, 0) /
        photos.length /
        1e6,
    };
  });
  console.log(
    `  ${String(photoInfo.n)} photos, mean ${photoInfo.mp.toFixed(1)} MP`,
  );
  for (const format of ['png', 'jpeg'] as const) {
    const baseline = browserRssMb(processMarker);
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, browserRssMb(processMarker));
    }, 200);
    let result: Exported;
    try {
      result = await exportAs(p, format, 600_000);
      await idle(p, 60_000);
    } finally {
      clearInterval(timer);
    }
    const stats = await p.evaluate(async (load) => {
      const { ctx, c } = await (0, eval)(`(${load})`)();
      let opaque = 0;
      const values = new Set<number>();
      for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
          const d = ctx.getImageData(
            Math.floor(((gx + 0.5) / 8) * c.width),
            Math.floor(((gy + 0.5) / 8) * c.height),
            1,
            1,
          ).data;
          if (d[3] === 255) opaque++;
          values.add(d[0]! * 65536 + d[1]! * 256 + d[2]!);
        }
      }
      return { w: c.width, h: c.height, opaque, distinct: values.size };
    }, LOAD_EXPORT);
    check(
      `A2 ${format.toUpperCase()} export is 4961 x 7016 and not blank (${label})`,
      result.width === 4961 &&
        result.height === 7016 &&
        stats.w === 4961 &&
        stats.h === 7016 &&
        stats.opaque === 64 &&
        stats.distinct > 8,
      `${result.seconds.toFixed(1)} s, ${(result.size / 1e6).toFixed(1)} MB file, browser RSS peak ${peak.toFixed(0)} MB (baseline ${baseline.toFixed(0)} MB), ${String(stats.distinct)} distinct sampled colours`,
    );
    await p.evaluate(() => {
      (window as any).__exports.length = 0;
    });
  }
  await context.close();
}

/**
 * Exports a folder of real photos at A2 (4961 x 7016) in Chrome and prints
 * numbers only (time, size, peak memory). The files are downloaded to
 * Playwright's temporary folder and deleted at once; nothing is kept.
 */
export async function exportRealFolder(
  browser: Browser,
  origin: string,
  files: string[],
  processMarker: string,
): Promise<void> {
  const { context, page: p } = await newExportPage(browser, origin);
  const t0 = Date.now();
  await p.setInputFiles('input[type=file]', files);
  await p.waitForFunction(
    (n) =>
      !document.querySelector('.progress:not([hidden])') &&
      document.querySelectorAll('.thumb').length >= n,
    files.length,
    { timeout: 900_000, polling: 200 },
  );
  console.log(
    `  imported ${String(files.length)} photos in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  await action(p, 'setCanvasSize', 4961, 7016);
  await waitDrawn(p);
  const mean = await p.evaluate(() => {
    const photos = (window as any).__app.store.getPhotos();
    return (
      photos.reduce((s: number, x: any) => s + x.width * x.height, 0) /
      photos.length /
      1e6
    );
  });
  console.log(`  mean photo size ${mean.toFixed(1)} MP`);
  for (const format of ['png', 'jpeg'] as const) {
    const baseline = browserRssMb(processMarker);
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, browserRssMb(processMarker));
    }, 200);
    await p
      .locator('.export-option', {
        hasText: format === 'png' ? 'PNG' : 'JPEG',
      })
      .click();
    const started = Date.now();
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 900_000 }),
      p.locator('.export-download').click(),
    ]);
    const path = await download.path();
    const dims = imageSize(readFileSync(path));
    const seconds = (Date.now() - started) / 1000;
    clearInterval(timer);
    await download.delete();
    await idle(p, 60_000);
    console.log(
      `  A2 ${format.toUpperCase()}: ${dims ? `${String(dims.width)} x ${String(dims.height)}` : 'unreadable'}, ${seconds.toFixed(1)} s, browser memory peak ${peak.toFixed(0)} MB (before ${baseline.toFixed(0)} MB)`,
    );
  }
  await context.close();
}
