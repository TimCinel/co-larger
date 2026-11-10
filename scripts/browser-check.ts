/**
 * Local real-browser check for photo import (issue #4). Not run in CI: it needs
 * a locally installed Chrome. Decoding, EXIF handling and drag and drop cannot
 * be verified in Node.
 *
 *   node scripts/browser-check.ts                 # synthetic fixtures + screenshot
 *   node scripts/browser-check.ts --dir <folder>  # also import a folder of real
 *                                                  # photos and report timing
 *                                                  # (prints numbers only)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');
const dirIndex = process.argv.indexOf('--dir');
const realDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : undefined;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
}

interface PhotoInfo {
  name: string;
  width: number;
  height: number;
  aspect: number;
  previewW: number;
  previewH: number;
  topLeft: number[];
  bottomRight: number[];
}

/** Describes every photo in the store, sampling the corner pixels of previews. */
function describePhotos(page: Page): Promise<PhotoInfo[]> {
  return page.evaluate(async () => {
    const store = (window as unknown as { __store: any }).__store;
    const out = [];
    for (const photo of store.getPhotos()) {
      const bitmap = await createImageBitmap(photo.preview);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const px = (x: number, y: number) => [
        ...ctx.getImageData(x, y, 1, 1).data,
      ];
      out.push({
        name: photo.file.name,
        width: photo.width,
        height: photo.height,
        aspect: photo.aspect,
        previewW: bitmap.width,
        previewH: bitmap.height,
        topLeft: px(10, 10),
        bottomRight: px(bitmap.width - 10, bitmap.height - 10),
      });
      bitmap.close();
    }
    return out;
  });
}

const isReddish = (p: number[]): boolean =>
  (p[0] ?? 0) > 150 && (p[1] ?? 255) < 100;
const isGreenish = (p: number[]): boolean =>
  (p[1] ?? 0) > 120 && (p[0] ?? 255) < 100;

const server = await createServer({
  root,
  server: { port: 5199 },
  logLevel: 'error',
});
await server.listen();
const origin = 'http://localhost:5199';

const browser = await chromium.launch({ channel: 'chrome' });
console.log(`Browser: Chrome ${browser.version()}`);
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

const requests: { url: string; method: string; hasBody: boolean }[] = [];
page.on('request', (r) => {
  requests.push({
    url: r.url(),
    method: r.method(),
    hasBody: r.postData() !== null,
  });
});
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(origin);
await page.waitForSelector('.tray');
const count = (): Promise<string> => page.locator('.tray-count').innerText();

// 1. Empty state.
check(
  'starts with 0 / 0 selected',
  (await count()) === '0 / 0 selected',
  await count(),
);

// 2. File picker, with files the browser cannot decode mixed in.
const good = [
  'landscape.jpg',
  'portrait.jpg',
  'square.jpg',
  'orient-6.jpg',
  'orient-8.jpg',
  'orient-3.jpg',
];
const bad = ['not-an-image.txt', 'fake.heic'];
await page.setInputFiles(
  'input[type=file]',
  [...good, ...bad].map((f) => join(fixtures, f)),
);
await page.waitForFunction(
  () => document.querySelectorAll('.thumb').length === 6,
);
check(
  'file picker adds the 6 decodable photos',
  (await page.locator('.thumb').count()) === 6,
);
check(
  'undecodable files are skipped with a visible message',
  (await page.locator('.notice').first().innerText()).includes(
    'Skipped 2 files',
  ),
);
check(
  'page still usable after failures (count shows 6 / 6)',
  (await count()) === '6 / 6 selected',
);

// 3. EXIF orientation: recorded size and rendered pixels.
const photos = await describePhotos(page);
const byName = (n: string): PhotoInfo => photos.find((p) => p.name === n)!;
for (const [name, w, h] of [
  ['landscape.jpg', 400, 300],
  ['portrait.jpg', 300, 400],
  ['square.jpg', 300, 300],
  ['orient-6.jpg', 300, 400],
  ['orient-8.jpg', 300, 400],
  ['orient-3.jpg', 400, 300],
] as const) {
  const p = byName(name);
  check(
    `${name}: recorded ${w}x${h} (aspect ${(w / h).toFixed(3)})`,
    p.width === w && p.height === h && Math.abs(p.aspect - w / h) < 1e-9,
    `${p.width}x${p.height}`,
  );
  check(
    `${name}: preview upright (red top-left, green bottom-right)`,
    isReddish(p.topLeft) && isGreenish(p.bottomRight),
    `tl=${p.topLeft.join(',')} br=${p.bottomRight.join(',')}`,
  );
}
// Negative control: read the stored size from the JPEG header (the SOF marker),
// to prove the file really is stored sideways and the decoder rotated it.
// (createImageBitmap's old 'none' option is no longer a way to ignore EXIF.)
const stored = await page.evaluate(async () => {
  const store = (window as unknown as { __store: any }).__store;
  const photo = store
    .getPhotos()
    .find((p: { file: File }) => p.file.name === 'orient-6.jpg');
  const bytes = new Uint8Array(await photo.file.arrayBuffer());
  for (let i = 2; i < bytes.length - 9;) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return `${String((bytes[i + 7]! << 8) | bytes[i + 8]!)}x${String((bytes[i + 5]! << 8) | bytes[i + 6]!)}`;
    }
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return 'unknown';
});
check(
  'control: orient-6.jpg is stored 400x300 (sideways) but recorded 300x400',
  stored === '400x300' && byName('orient-6.jpg').width === 300,
  stored,
);
// The tray thumbnails themselves, as displayed in the page.
const thumbCheck = await page.evaluate(async () => {
  const results: {
    name: string;
    w: number;
    h: number;
    tl: number[];
    br: number[];
  }[] = [];
  for (const img of document.querySelectorAll<HTMLImageElement>('.thumb img')) {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    results.push({
      name: img.parentElement?.getAttribute('aria-label') ?? '',
      w: img.naturalWidth,
      h: img.naturalHeight,
      tl: px(5, 5),
      br: px(img.naturalWidth - 6, img.naturalHeight - 6),
    });
  }
  return results;
});
for (const t of thumbCheck) {
  check(
    `${t.name}: tray thumbnail upright`,
    isReddish(t.tl) && isGreenish(t.br),
    `${t.w}x${t.h}`,
  );
}

// 4. Toggling and the count.
await page.locator('.thumb').first().click();
check(
  'toggling one photo gives 5 / 6',
  (await count()) === '5 / 6 selected',
  await count(),
);
check(
  'toggled thumb is aria-pressed=false',
  (await page.locator('.thumb').first().getAttribute('aria-pressed')) ===
    'false',
);
await page.getByRole('button', { name: 'Remove all' }).click();
check(
  'Remove all gives 0 / 6',
  (await count()) === '0 / 6 selected',
  await count(),
);
check(
  'Remove all disabled at 0 selected',
  await page.getByRole('button', { name: 'Remove all' }).isDisabled(),
);
await page.getByRole('button', { name: 'Add all to collage' }).click();
check(
  'Add all gives 6 / 6',
  (await count()) === '6 / 6 selected',
  await count(),
);
check(
  'Add all disabled when all selected',
  await page.getByRole('button', { name: 'Add all to collage' }).isDisabled(),
);

// 5. Adding more later: same files again are duplicates, a new one is added.
await page.setInputFiles('input[type=file]', [
  join(fixtures, 'landscape.jpg'),
  join(fixtures, 'portrait.jpg'),
]);
await page.waitForFunction(
  () => document.querySelectorAll('.notice').length >= 2,
);
check(
  're-adding the same files creates no duplicates',
  (await page.locator('.thumb').count()) === 6 &&
    (await page.locator('.notice').nth(1).innerText()).includes(
      'already added',
    ),
);

// 6. Drag and drop: synthetic drag events carrying 40 generated images.
const dropped = await page.evaluate(async () => {
  const dt = new DataTransfer();
  for (let i = 0; i < 40; i++) {
    const w = [800, 600, 600, 900][i % 4]!;
    const h = [600, 800, 600, 500][i % 4]!;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${String((i * 47) % 360)} 70% 55%)`);
    g.addColorStop(1, `hsl(${String((i * 47 + 90) % 360)} 70% 25%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), w / 2, h / 2 + 24);
    const blob = await new Promise<Blob>((res) => {
      canvas.toBlob(
        (b) => {
          res(b!);
        },
        'image/jpeg',
        0.8,
      );
    });
    dt.items.add(
      new File([blob], `synthetic-${String(i + 1)}.jpg`, {
        type: 'image/jpeg',
        lastModified: 1000 + i,
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
  const overlayShown = document
    .querySelector('.shell')!
    .classList.contains('dragging');
  const dragoverCancelled = !fire('dragover');
  const dropCancelled = !fire('drop');
  const overlayHidden = !document
    .querySelector('.shell')!
    .classList.contains('dragging');
  return { overlayShown, dragoverCancelled, dropCancelled, overlayHidden };
});
check('drag over shows the drop overlay', dropped.overlayShown);
check(
  'dragover and drop are default-prevented (browser will not navigate)',
  dropped.dragoverCancelled && dropped.dropCancelled,
);
check('overlay hides after drop', dropped.overlayHidden);
await page.waitForFunction(
  () => document.querySelectorAll('.thumb').length === 46,
  undefined,
  { timeout: 30000 },
);
check(
  'dropping 40 images adds them (46 total)',
  (await count()) === '46 / 46 selected',
  await count(),
);

// 7. Screenshot for the PR (synthetic images only).
for (const i of [1, 4, 7, 12, 20, 30])
  await page.locator('.thumb').nth(i).click();
mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
await page.evaluate(() => {
  document.querySelector('.tray-grid')!.scrollTop = 0;
});
await page.screenshot({
  path: join(root, 'docs', 'screenshots', 'photo-tray.png'),
});

// 8. Optional: a folder of real photos. Prints numbers only.
if (realDir) {
  const files = readdirSync(realDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => join(realDir, f));
  const real = await context.newPage();
  await real.goto(origin);
  await real.waitForSelector('.tray');
  const client = await context.newCDPSession(real);
  await client.send('Performance.enable');
  await real.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __long: number[] };
    w.__gaps = [];
    w.__long = [];
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  const rss = (): number => {
    // Sum resident memory of every process in Chrome's tree (MB).
    const out = execFileSync('ps', [
      '-axo',
      'pid=,ppid=,rss=,comm=',
    ]).toString();
    const rows = out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length >= 4);
    const mine = rows.filter((r) =>
      r.slice(3).join(' ').includes('Google Chrome'),
    );
    return mine.reduce((sum, r) => sum + Number(r[2]), 0) / 1024;
  };
  let peakRss = 0;
  let peakHeap = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, rss());
    void client.send('Performance.getMetrics').then((m) => {
      const heap =
        m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0;
      peakHeap = Math.max(peakHeap, heap / 1048576);
    });
  }, 250);
  const baseline = rss();
  const t0 = Date.now();
  await real.setInputFiles('input[type=file]', files);
  await real.waitForFunction(
    (n) =>
      document.querySelectorAll('.thumb').length +
        document.querySelectorAll('.notice').length >
        0 &&
      !document.querySelector('.progress:not([hidden])') &&
      document.querySelectorAll('.thumb').length >= n,
    files.length,
    { timeout: 600000, polling: 200 },
  );
  const seconds = (Date.now() - t0) / 1000;
  clearInterval(sampler);
  const stats = await real.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __long: number[] };
    const gaps = [...w.__gaps].sort((a, b) => a - b);
    return {
      frames: gaps.length,
      p50: gaps[Math.floor(gaps.length * 0.5)] ?? 0,
      p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
      max: gaps.at(-1) ?? 0,
      longTasks: w.__long.length,
      longestTask: Math.max(0, ...w.__long),
      thumbs: document.querySelectorAll('.thumb').length,
      count: document.querySelector('.tray-count')?.textContent ?? '',
    };
  });
  const photos = await describePhotos(real);
  const previewBytes = await real.evaluate(() => {
    const store = (window as unknown as { __store: any }).__store;
    let p = 0;
    let t = 0;
    for (const photo of store.getPhotos()) {
      p += photo.preview.size;
      t += photo.thumbnail.size;
    }
    return { p, t };
  });
  // Interaction while idle after import: toggle latency.
  const toggleMs = await real.evaluate(async () => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>('.thumb')!.click();
    await new Promise((r) =>
      requestAnimationFrame(() => {
        r(null);
      }),
    );
    return performance.now() - start;
  });
  const heapNow =
    (await client.send('Performance.getMetrics')).metrics.find(
      (x) => x.name === 'JSHeapUsedSize',
    )?.value ?? 0;
  console.log(
    `\nReal photos: ${String(files.length)} files, imported in ${seconds.toFixed(1)} s`,
  );
  console.log(`  tray: ${String(stats.thumbs)} thumbs, ${stats.count}`);
  console.log(
    `  frame gaps while importing: p50 ${stats.p50.toFixed(0)} ms, p95 ${stats.p95.toFixed(0)} ms, max ${stats.max.toFixed(0)} ms; ${String(stats.longTasks)} long tasks (>50 ms), longest ${stats.longestTask.toFixed(0)} ms`,
  );
  console.log(
    `  Chrome RSS (all processes): baseline ${baseline.toFixed(0)} MB, peak ${peakRss.toFixed(0)} MB, after ${rss().toFixed(0)} MB`,
  );
  console.log(
    `  JS heap: peak ${peakHeap.toFixed(0)} MB, after ${(heapNow / 1048576).toFixed(0)} MB`,
  );
  console.log(
    `  stored blobs: previews ${(previewBytes.p / 1048576).toFixed(1)} MB, thumbnails ${(previewBytes.t / 1048576).toFixed(1)} MB`,
  );
  console.log(`  toggle latency after import: ${toggleMs.toFixed(0)} ms`);
  const sizes = photos.map((p) => `${String(p.width)}x${String(p.height)}`);
  const uniq = [...new Set(sizes)];
  console.log(
    `  distinct recorded sizes: ${uniq.slice(0, 12).join(', ')}${uniq.length > 12 ? ', ...' : ''}`,
  );
  const maxPrev = Math.max(
    ...photos.map((p) => Math.max(p.previewW, p.previewH)),
  );
  console.log(
    `  largest preview side: ${String(maxPrev)} px; aspects ok: ${String(photos.every((p) => Math.abs(p.previewW / p.previewH - p.aspect) < 0.01))}`,
  );
  // Compare recorded sizes with what EXIF says they should be (needs exiftool).
  try {
    const meta = JSON.parse(
      execFileSync(
        'exiftool',
        ['-j', '-n', '-Orientation', '-ImageWidth', '-ImageHeight', realDir],
        { maxBuffer: 1 << 26 },
      ).toString(),
    ) as {
      FileName: string;
      Orientation?: number;
      ImageWidth: number;
      ImageHeight: number;
    }[];
    let rotated = 0;
    let mismatched = 0;
    for (const m of meta) {
      const got = photos.find((p) => p.name === m.FileName);
      if (!got) continue;
      const swap = (m.Orientation ?? 1) >= 5;
      if (swap) rotated++;
      const [w, h] = swap
        ? [m.ImageHeight, m.ImageWidth]
        : [m.ImageWidth, m.ImageHeight];
      if (got.width !== w || got.height !== h) mismatched++;
    }
    console.log(
      `  ${String(rotated)} photos have a 90-degree EXIF orientation (5-8); ${String(mismatched)} recorded sizes differ from EXIF-corrected sizes`,
    );
    check(
      'recorded sizes match EXIF-corrected sizes for real photos',
      mismatched === 0,
    );
  } catch {
    console.log('  (exiftool not available; skipped EXIF size comparison)');
  }
  check(
    'all real photos imported',
    stats.thumbs === files.length,
    `${String(stats.thumbs)}/${String(files.length)}`,
  );
  await real.close();
}

// 9. Network: nothing but the local dev server, and nothing carrying a body.
const foreign = requests.filter(
  (r) =>
    !r.url.startsWith(origin) &&
    !r.url.startsWith('blob:') &&
    !r.url.startsWith('data:'),
);
check(
  'no requests leave the local server',
  foreign.length === 0,
  foreign.map((r) => r.url).join(' '),
);
check(
  'no request carries a body',
  requests.every((r) => !r.hasBody && r.method === 'GET'),
);
check(
  'no console errors',
  consoleErrors.length === 0,
  consoleErrors.join(' | '),
);

await browser.close();
await server.close();
console.log(
  failures === 0
    ? '\nAll checks passed'
    : `\n${String(failures)} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
