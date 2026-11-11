/**
 * Real-browser checks for the low-resolution warnings (issue #15), called
 * from browser-check.ts. Photos are generated in the page at chosen pixel
 * sizes (flat gradients), so nothing is written to disk and no real photo is
 * involved.
 *
 *   node scripts/browser-check.ts --resolution-screenshot   # docs/screenshots/issue-15-*.png
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { imageSize } from './export-checks.ts';
import type { Browser, Page } from 'playwright-core';

type Check = (name: string, ok: boolean, detail?: string) => void;

const STATE_MODULE = '/src/editor/state.ts';
const fixtures = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
);
const sha = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Adds one generated photo per `[width, height]`, named `r<i>-<w>x<h>.jpg`. */
async function addSized(
  p: Page,
  sizes: readonly (readonly [number, number])[],
): Promise<void> {
  const before = await p.evaluate(
    () => (window as any).__store.getPhotos().length as number,
  );
  await p.evaluate(
    async ({ sizes, before }) => {
      const dt = new DataTransfer();
      let i = before;
      for (const [w, h] of sizes) {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${String((i * 53) % 360)} 55% 55%)`);
        g.addColorStop(1, `hsl(${String((i * 53 + 70) % 360)} 55% 28%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `bold ${String(Math.round(Math.min(w, h) / 5))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${String(w)}×${String(h)}`, w / 2, h / 2);
        const blob = await c.convertToBlob({
          type: 'image/jpeg',
          quality: 0.8,
        });
        dt.items.add(
          new File([blob], `r${String(i)}-${String(w)}x${String(h)}.jpg`, {
            type: 'image/jpeg',
            lastModified: 1_700_000_000_000 + i,
          }),
        );
        i++;
      }
      const input =
        document.querySelector<HTMLInputElement>('input[type=file]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { sizes, before },
  );
  await p.waitForFunction(
    (n) => (window as any).__app.editor.getState().photos.length === n,
    before + sizes.length,
    { timeout: 120_000 },
  );
}

async function act(p: Page, name: string, ...args: unknown[]): Promise<void> {
  await p.evaluate(
    async ({ name, args, module }) => {
      const actions = await import(/* @vite-ignore */ module);
      (window as any).__app.editor.dispatch((s: unknown) =>
        actions[name](s, ...args),
      );
    },
    { name, args, module: STATE_MODULE },
  );
  await drawn(p);
}

/** The latest state is drawn and the badges have been updated for it. */
async function drawn(p: Page): Promise<void> {
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
    { timeout: 60_000, polling: 25 },
  );
  // Badges update from the render listener, in the same task as the draw.
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
  );
}

interface Badge {
  level: string;
  glyph: string;
  label: string;
  photo: string;
  rect: { x: number; y: number; width: number; height: number };
  tile: { x: number; y: number; width: number; height: number };
}

/** The shown canvas badges, with the tile (CSS px) and photo each belongs to. */
function badges(p: Page): Promise<Badge[]> {
  return p.evaluate(() => {
    const app = (window as any).__app;
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const cr = canvas.getBoundingClientRect();
    const scale = cr.width / canvas.width;
    const last = app.view.lastRender();
    const out: any[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      '.res-layer .res-badge',
    )) {
      if (el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      // The tile whose top-right corner is nearest the badge's.
      let tile: any;
      let best = Infinity;
      for (const t of last.tiles) {
        const d = Math.hypot(
          cr.left + (t.x + t.width) * scale - (r.right + 4),
          cr.top + t.y * scale - (r.top - 4),
        );
        if (d < best) {
          best = d;
          tile = t;
        }
      }
      const b = {
        x: cr.left + tile.x * scale,
        y: cr.top + tile.y * scale,
        width: tile.width * scale,
        height: tile.height * scale,
      };
      const id = tile ? last.state.assignment[tile.slot] : undefined;
      out.push({
        level: el.dataset.level,
        glyph: el.textContent,
        label: el.getAttribute('aria-label'),
        photo: id ? app.store.getPhoto(id).file.name : '',
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        tile: b,
      });
    }
    return out;
  });
}

function summary(p: Page): Promise<string | null> {
  return p.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.res-summary');
    const label = el?.lastElementChild;
    return el && label && el.getClientRects().length > 0
      ? label.textContent
      : null;
  });
}

/** Tray thumbnails that carry a marker, by photo name. */
function trayMarks(p: Page): Promise<Record<string, string>> {
  return p.evaluate(() => {
    const out: Record<string, string> = {};
    for (const btn of document.querySelectorAll<HTMLElement>('.thumb')) {
      const mark = btn.querySelector<HTMLElement>('.res-badge-tray');
      if (mark)
        out[btn.title.split('.')[0] + '.jpg'] = mark.dataset.level ?? '';
    }
    return out;
  });
}

async function newPage(browser: Browser, origin: string, w = 1440, h = 900) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    acceptDownloads: true,
  });
  // No save dialog: Save project downloads a file.
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  return { ctx, p };
}

export async function checkResolution(
  browser: Browser,
  origin: string,
  check: Check,
  screenshots?: string,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin);
  const commits = (): Promise<number> =>
    p.evaluate(() => (window as any).__commits as number);
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_s: unknown, change: any) => {
      if (!change.transient) w.__commits++;
    });
  });

  // --- 1. The thresholds, with real pixel sizes: one 2000 x 1000 photo ----
  await addSized(p, [[2000, 1000]]);
  await act(p, 'setCanvasSize', 2000, 1000);
  const levelAt = async (w: number): Promise<string> => {
    await act(p, 'setCanvasSize', w, w / 2);
    const found = await badges(p);
    return found.length === 0 ? 'none' : found.map((b) => b.level).join(',');
  };
  const got: Record<number, string> = {};
  for (const w of [2000, 3000, 3002, 6000, 6002]) got[w] = await levelAt(w);
  check(
    'resolution: levels at the boundaries (factor 1, exactly 1.5, just over 1.5, exactly 3, just over 3)',
    got[2000] === 'none' &&
      got[3000] === 'none' &&
      got[3002] === 'low' &&
      got[6000] === 'low' &&
      got[6002] === 'very-low',
    JSON.stringify(got),
  );
  const veryLow = (await badges(p))[0];
  check(
    'resolution: the two levels differ in glyph and in shape, not only colour',
    veryLow?.glyph === '!!' &&
      (await p.evaluate(() => {
        const shape = (level: string): string => {
          const probe = document.createElement('span');
          probe.className = 'res-badge';
          probe.dataset.level = level;
          document.body.append(probe);
          const clip = getComputedStyle(probe, '::before').backgroundImage;
          probe.remove();
          return clip;
        };
        return shape('low') !== shape('very-low');
      })),
    JSON.stringify(veryLow?.glyph),
  );
  check(
    'resolution: a pixel canvas explains it as an enlargement',
    /^Very low resolution: this tile uses 2000 × 1000 px of the photo but exports at 6002 × 3001 px, so it will be enlarged just over 3×\.$/.test(
      veryLow?.label ?? '',
    ),
    veryLow?.label ?? '',
  );

  // --- 2. Three photos: small in a big tile, tiny, and big -----------------
  await p.evaluate(() => {
    (window as any).__app.store.removePhotos(
      (window as any).__app.store.getPhotos().map((x: any) => x.id),
    );
  });
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 0,
  );
  await addSized(p, [
    [6000, 4000],
    [1200, 800],
    [300, 200],
  ]);
  await act(p, 'setCanvasSize', 6000, 4000);
  const trio = await badges(p);
  const byName = new Map(trio.map((b) => [b.photo, b]));
  const names = [...byName.keys()].sort();
  check(
    'resolution: the small and the tiny photo are flagged, the large one is not',
    byName.size === 2 &&
      byName.has('r1-1200x800.jpg') &&
      byName.has('r2-300x200.jpg') &&
      !byName.has('r0-6000x4000.jpg'),
    names.join(' '),
  );
  check(
    'resolution: the tiny photo is very low',
    byName.get('r2-300x200.jpg')?.level === 'very-low',
  );
  const marks = await trayMarks(p);
  check(
    'resolution: tray thumbnails carry the same markers (and none for the large photo)',
    Object.keys(marks).length === 2 &&
      marks['r1-1200x800.jpg'] === byName.get('r1-1200x800.jpg')?.level &&
      marks['r2-300x200.jpg'] === 'very-low',
    JSON.stringify(marks),
  );
  check(
    'resolution: a flagged thumbnail keeps the photo name as its name and is described as low resolution',
    await p.evaluate(() => {
      const btn = document.querySelector<HTMLElement>(
        '.thumb[aria-label="r2-300x200.jpg"]',
      );
      const said = document.getElementById(
        btn?.getAttribute('aria-describedby') ?? '',
      );
      const clean = document.querySelector<HTMLElement>(
        '.thumb[aria-label="r0-6000x4000.jpg"]',
      );
      return (
        said?.textContent === 'Very low resolution' &&
        !!clean &&
        !clean.hasAttribute('aria-describedby')
      );
    }),
  );
  const text = await summary(p);
  check(
    'resolution: the summary near Export counts them',
    text === '2 photos are low resolution for this size (1 very low)' ||
      text === '2 photos are low resolution for this size (2 very low)',
    text ?? 'hidden',
  );
  check(
    'resolution: the summary sits in the Export section, next to Download',
    await p.evaluate(
      () =>
        !!document.querySelector('.export-section .res-summary') &&
        !document.querySelector('.topbar .res-summary'),
    ),
  );

  // Excluded photos carry no marker; the summary follows the collage.
  const tiny = p.locator('.thumb[title^="r2-300x200"]');
  await tiny.click();
  await drawn(p);
  const afterExclude = await trayMarks(p);
  check(
    'resolution: excluding a photo removes its marker and updates the summary',
    afterExclude['r2-300x200.jpg'] === undefined &&
      (await summary(p))?.startsWith(
        '1 photo is low resolution for this size',
      ) === true,
    `${JSON.stringify(afterExclude)} ${(await summary(p)) ?? 'hidden'}`,
  );
  await tiny.click();
  await drawn(p);

  // Back to a small canvas: nothing is shown anywhere.
  await act(p, 'setCanvasSize', 300, 200);
  check(
    'resolution: at a small size there are no badges, no markers and no summary',
    (await badges(p)).length === 0 &&
      Object.keys(await trayMarks(p)).length === 0 &&
      (await summary(p)) === null,
  );
  await act(p, 'setCanvasSize', 6000, 4000);

  // --- 3. Hover, keyboard and pointer pass-through (trio at 6000 x 4000) ---
  const centre = (b: Badge): [number, number] => [
    b.rect.x + b.rect.width / 2,
    b.rect.y + b.rect.height / 2,
  ];
  const tooltip = (): Promise<string | null> =>
    p.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.res-tooltip');
      return el && el.getClientRects().length > 0 ? el.textContent : null;
    });
  const small = byName.get('r1-1200x800.jpg') as Badge;
  const [bx, by] = centre(small);
  await p.mouse.move(bx, by);
  await p.waitForTimeout(50);
  check(
    'resolution: hovering a badge shows why, in the tooltip',
    (await tooltip()) === small.label,
    (await tooltip()) ?? 'no tooltip',
  );
  const tooltipBox = (): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> =>
    p.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.res-tooltip');
      if (!el || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  const box1 = (await tooltipBox())!;
  // Into the tooltip, crossing the gap between it and the badge.
  await p.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2, {
    steps: 8,
  });
  await p.waitForTimeout(700);
  check(
    'resolution: the tooltip is hoverable: moving from the badge into it keeps it open',
    (await tooltip()) === small.label,
    (await tooltip()) ?? 'closed',
  );
  await p.mouse.move(
    small.tile.x + small.tile.width / 2,
    small.tile.y + small.tile.height / 2,
    { steps: 4 },
  );
  await p.waitForTimeout(800);
  check(
    'resolution: moving away from the badge and the tooltip closes it after a short wait',
    (await tooltip()) === null,
  );
  await p.mouse.move(bx, by);
  await p.waitForTimeout(50);
  await p.mouse.move(2, 2);
  await p.waitForTimeout(100);
  const stillThere = (await tooltip()) !== null;
  await p.waitForTimeout(700);
  check(
    'resolution: leaving the page area waits a moment (to reach the tooltip), then closes',
    stillThere && (await tooltip()) === null,
  );
  await p.mouse.move(bx, by);
  await p.mouse.down();
  await p.waitForTimeout(30);
  check(
    'resolution: pressing the pointer hides the tooltip',
    (await tooltip()) === null,
  );
  await p.mouse.up();

  // Keyboard: Tab from the canvas reaches a badge, one tab stop, arrows move.
  await p.keyboard.press('Escape');
  await p.locator('.collage-canvas').focus();
  const onBadge = (): Promise<string | null> =>
    p.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.classList.contains('res-badge')
        ? a.getAttribute('aria-label')
        : null;
    });
  let reached: string | null = null;
  for (let i = 0; i < 6 && reached === null; i++) {
    await p.keyboard.press('Tab');
    reached = await onBadge();
  }
  check(
    'resolution: Tab from the canvas reaches a badge, which shows its explanation',
    reached !== null &&
      reached === (await tooltip()) &&
      /^(Low|Very low) resolution: /.test(reached),
    `${reached ?? 'none'} | ${(await tooltip()) ?? 'no tooltip'}`,
  );
  const tabStops = await p.evaluate(
    () => document.querySelectorAll('.res-badge[tabindex="0"]').length,
  );
  await p.keyboard.press('ArrowRight');
  const second = await onBadge();
  await p.keyboard.press('ArrowLeft');
  check(
    'resolution: the badges are one tab stop and the arrow keys move between them',
    tabStops === 1 &&
      second !== null &&
      second !== reached &&
      (await onBadge()) === reached,
    `${String(tabStops)} stops`,
  );
  await p.keyboard.press('Escape');
  check(
    'resolution: Escape dismisses the tooltip and keeps focus on the badge',
    (await tooltip()) === null && (await onBadge()) === reached,
  );
  check(
    'resolution: badges and the layer have accessible names; the glyph is hidden from readers',
    await p.evaluate(
      () =>
        [...document.querySelectorAll('.res-layer .res-badge')].every(
          (b) =>
            b.getAttribute('role') === 'img' &&
            (b.getAttribute('aria-label') ?? '').length > 20 &&
            b.firstElementChild?.getAttribute('aria-hidden') === 'true',
        ) &&
        document.querySelector('.res-layer')?.getAttribute('aria-label') ===
          'Low resolution tiles',
    ),
  );
  // The focused tile's description (what a screen reader says on the
  // canvas) includes the warning.
  await p.locator('.collage-canvas').focus();
  const described: string[] = [];
  const directions = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (let i = 0; i < 16; i++) {
    const label = await p.evaluate(
      () =>
        document.querySelector('.collage-canvas')!.getAttribute('aria-label') ??
        '',
    );
    described.push(label);
    if (
      described.some((d) => d.includes('r0-6000x4000.jpg')) &&
      described.some((d) => d.includes('resolution: this tile uses'))
    ) {
      break;
    }
    await p.keyboard.press(directions[i % 4]!);
  }
  check(
    'resolution: the canvas description of a flagged tile includes the warning, an unflagged one does not',
    described.some((d) => d.includes('resolution: this tile uses')) &&
      described.some((d) => d.includes('r0-6000x4000.jpg')) &&
      described
        .filter((d) => d.includes('r0-6000x4000.jpg'))
        .every((d) => !d.includes('resolution')),
    described.join(' | '),
  );

  // Pointer pass-through: select the small photo's tile (away from its
  // badge), zoom its crop, then wheel and drag starting on the badge.
  await p.mouse.click(
    small.tile.x + small.tile.width / 2,
    small.tile.y + small.tile.height / 2,
  );
  const smallId = await p.evaluate(
    () =>
      (window as any).__app.store
        .getPhotos()
        .find((x: any) => x.file.name === 'r1-1200x800.jpg').id as string,
  );
  await act(p, 'setCrop', smallId, { x: 0.5, y: 0.5, zoom: 1.5 });
  const crop = (): Promise<{ x: number; y: number; zoom: number }> =>
    p.evaluate(
      (id) =>
        (window as any).__app.editor.getState().crops[id] ?? {
          x: 0.5,
          y: 0.5,
          zoom: 1,
        },
      smallId,
    );
  const sel = (): Promise<string> =>
    p.evaluate(() => (window as any).__app.selection.getSelection().kind);
  const zoomBefore = (await crop()).zoom;
  const onSmall = async (): Promise<Badge> =>
    (await badges(p)).find((b) => b.photo === 'r1-1200x800.jpg') as Badge;
  let [wx, wy] = centre(await onSmall());
  await p.mouse.move(wx, wy);
  await p.mouse.wheel(0, -400);
  await p.waitForTimeout(400);
  const zoomAfter = (await crop()).zoom;
  check(
    'resolution: the wheel over a badge still zooms the selected tile',
    zoomAfter > zoomBefore,
    `${String(zoomBefore)} -> ${zoomAfter.toFixed(2)}`,
  );
  [wx, wy] = centre(await onSmall());
  const panBefore = await crop();
  await p.mouse.move(wx, wy);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(wx - i * 12, wy + i * 4);
  await p.mouse.up();
  await drawn(p);
  const panAfter = await crop();
  check(
    'resolution: dragging from a badge pans the crop and keeps the selection',
    (panAfter.x !== panBefore.x || panAfter.y !== panBefore.y) &&
      (await sel()) === 'selected',
    `${JSON.stringify(panBefore)} -> ${JSON.stringify(panAfter)}; ${await sel()}`,
  );
  await p.keyboard.press('Escape');
  [wx, wy] = centre(await onSmall());
  await p.mouse.click(wx, wy);
  check(
    'resolution: clicking a badge selects its tile',
    (await sel()) === 'selected',
  );
  await p.keyboard.press('Escape');
  await act(p, 'setCrop', smallId, { x: 0.5, y: 0.5, zoom: 1 });

  // Gestures start fine with a tooltip showing: hover the badge, go to
  // another part of the tile (inside the grace period) and wheel or drag.
  await p.mouse.click(
    small.tile.x + small.tile.width / 2,
    small.tile.y + small.tile.height / 2,
  );
  await act(p, 'setCrop', smallId, { x: 0.5, y: 0.5, zoom: 2 });
  const spot = async (): Promise<[number, number]> => {
    const b = await onSmall();
    const tb = await tooltipBox();
    let px = b.tile.x + b.tile.width / 2;
    const py = b.tile.y + b.tile.height - 30;
    if (
      tb &&
      px > tb.x &&
      px < tb.x + tb.width &&
      py > tb.y &&
      py < tb.y + tb.height
    ) {
      px = b.tile.x + 20;
    }
    return [px, py];
  };
  let nb = await onSmall();
  await p.mouse.move(...centre(nb));
  await p.waitForTimeout(60);
  const shownBeforeWheel = (await tooltip()) !== null;
  const [sx1, sy1] = await spot();
  await p.mouse.move(sx1, sy1);
  const z0 = (await crop()).zoom;
  await p.mouse.wheel(0, -400);
  await p.waitForTimeout(400);
  check(
    'resolution: with a tooltip showing, the wheel over the tile still zooms it (and closes the tooltip)',
    shownBeforeWheel && (await crop()).zoom > z0 && (await tooltip()) === null,
    `${String(z0)} -> ${(await crop()).zoom.toFixed(2)}`,
  );
  nb = await onSmall();
  await p.mouse.move(...centre(nb));
  await p.waitForTimeout(60);
  const shownBeforeDrag = (await tooltip()) !== null;
  const [sx2, sy2] = await spot();
  await p.mouse.move(sx2, sy2);
  const c0 = await crop();
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(sx2 - i * 10, sy2 - i * 3);
  await p.mouse.up();
  await drawn(p);
  const c1 = await crop();
  check(
    'resolution: with a tooltip showing, a drag on the tile still pans it (and closes the tooltip)',
    shownBeforeDrag &&
      (c1.x !== c0.x || c1.y !== c0.y) &&
      (await tooltip()) === null,
    `${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`,
  );
  await p.keyboard.press('Escape');

  // Swap by clicking the second tile on its badge.
  const slotsOf = (): Promise<string[]> =>
    p.evaluate(() => [...(window as any).__app.editor.getState().assignment]);
  const nameOfId = (id: string): Promise<string> =>
    p.evaluate((i) => (window as any).__app.store.getPhoto(i).file.name, id);
  await act(p, 'setCrop', smallId, { x: 0.5, y: 0.5, zoom: 1 });
  let swapped = false;
  let swapDetail = '';
  for (const [first, second] of [
    ['r1-1200x800.jpg', 'r2-300x200.jpg'],
    ['r2-300x200.jpg', 'r1-1200x800.jpg'],
  ] as const) {
    const before = await slotsOf();
    const names = await Promise.all(before.map(nameOfId));
    const a = (await badges(p)).find((x) => x.photo === first);
    const b = (await badges(p)).find((x) => x.photo === second);
    if (!a || !b) continue;
    await p.mouse.click(
      a.tile.x + a.tile.width / 2,
      a.tile.y + a.tile.height / 2,
    );
    await p.getByRole('button', { name: 'Swap', exact: true }).click();
    const [cx, cy] = centre(b);
    // The menu may cover the badge: then the other direction is tried.
    const open = await p.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x as number, y as number)?.tagName ===
        'CANVAS',
      [cx, cy],
    );
    if (!open) {
      await p.keyboard.press('Escape');
      continue;
    }
    await p.mouse.click(cx, cy);
    await drawn(p);
    const after = await slotsOf();
    const namesAfter = await Promise.all(after.map(nameOfId));
    const ia = names.indexOf(first);
    const ib = names.indexOf(second);
    swapped = namesAfter[ia] === second && namesAfter[ib] === first;
    swapDetail = `${first} <-> ${second}: ${names.join(',')} -> ${namesAfter.join(',')}`;
    break;
  }
  check(
    'resolution: choosing Swap and clicking the second tile on its badge swaps the two photos',
    swapped,
    swapDetail,
  );
  await p.keyboard.press('Escape');

  // --- 4. The badge follows the tile through resizes, the dial, the border --
  const aligned = (found: Badge[]): boolean =>
    found.length > 0 &&
    found.every(
      (b) =>
        Math.abs(b.rect.x + b.rect.width + 4 - (b.tile.x + b.tile.width)) <
          1.5 && Math.abs(b.rect.y - 4 - b.tile.y) < 1.5,
    );
  const where: string[] = [];
  where.push(String(aligned(await badges(p))));
  await p.setViewportSize({ width: 900, height: 620 });
  await p.waitForTimeout(500);
  await drawn(p);
  where.push(String(aligned(await badges(p))));
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(500);
  await drawn(p);
  await p.locator('#size-variation').fill('0.9');
  await drawn(p);
  where.push(String(aligned(await badges(p))));
  while ((await p.locator('.notice button').count()) > 0) {
    await p.locator('.notice button').first().click();
  }
  await p.getByRole('button', { name: 'Show all' }).click();
  await p.waitForTimeout(500);
  await drawn(p);
  where.push(String(aligned(await badges(p))));
  await p.getByRole('button', { name: 'Show one row' }).click();
  await p.waitForTimeout(500);
  await drawn(p);
  await act(p, 'setBorder', 0.03);
  where.push(String(aligned(await badges(p))));
  await act(p, 'setBorder', 0);
  check(
    'resolution: badges stay in their tile corners through a resize, the dial, the tray expanding and the border',
    where.every((w) => w === 'true'),
    where.join(' '),
  );

  // --- 5. The summary highlights the tiles ---------------------------------
  const layerClass = (): Promise<boolean> =>
    p.evaluate(() =>
      document.querySelector('.res-layer')!.classList.contains('highlight'),
    );
  await p.locator('.res-summary').scrollIntoViewIfNeeded();
  const sumBox = (await p.locator('.res-summary').boundingBox())!;
  await p.mouse.move(sumBox.x + 10, sumBox.y + 10);
  const hoverOn = await layerClass();
  await p.mouse.move(2, 2);
  const hoverOff = !(await layerClass());
  await p.locator('.res-summary').click();
  await p.mouse.move(2, 2);
  const pinned =
    (await layerClass()) &&
    (await p.locator('.res-summary').getAttribute('aria-pressed')) === 'true';
  await p.locator('.res-summary').click();
  await p.mouse.move(2, 2);
  await p.locator('.res-summary').blur();
  check(
    'resolution: hovering or pressing the summary highlights the affected tiles',
    hoverOn && hoverOff && pinned && !(await layerClass()),
    `${String(hoverOn)} ${String(hoverOff)} ${String(pinned)}`,
  );

  // --- 6. A4 to A2 at 300 DPI, with a physical size ------------------------
  await p.evaluate(() => {
    const store = (window as any).__app.store;
    store.removePhotos(store.getPhotos().map((x: any) => x.id));
  });
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 0,
  );
  await addSized(p, [[3000, 2000]]);
  await act(p, 'switchToPixels');
  await act(p, 'setPhysicalSize', 297, 210, 300);
  const a4 = await badges(p);
  await act(p, 'setPhysicalSize', 594, 420, 300);
  const a2 = await badges(p);
  // A 3000 x 2000 photo in a 7016 x 4961 tile shows 2000 * 7016 / 4961 =
  // 2828.5 px of width: factor 2.48, 121 DPI.
  const factor = 7016 / ((2000 * 7016) / 4961);
  check(
    'resolution: A4 at 300 DPI has no warning; A2 at 300 DPI adds one, with the DPI',
    a4.length === 0 &&
      a2.length === 1 &&
      a2[0]?.level === 'low' &&
      a2[0].label ===
        `Low resolution: this tile uses 2828 × 2000 px of the photo but prints at 7016 × 4961 px, about ${String(Math.round(300 / factor))} DPI at this size.`,
    a2[0]?.label ?? 'none',
  );
  await act(p, 'setPhysicalSize', 297, 210, 300);
  check(
    'resolution: going back to A4 removes the warning and the summary',
    (await badges(p)).length === 0 && (await summary(p)) === null,
  );

  // 150 DPI: A0 landscape, 1189 x 841 mm.
  await act(p, 'setPhysicalSize', 1189, 841, 150);
  const tw = Math.round((1189 * 150) / 25.4);
  const th = Math.round((841 * 150) / 25.4);
  const f150 = tw / ((2000 * tw) / th);
  const at150 = await badges(p);
  check(
    'resolution: a 150 DPI canvas reports its own effective DPI',
    at150.length === 1 &&
      at150[0]?.label ===
        `Low resolution: this tile uses ${String(Math.round((2000 * tw) / th))} × 2000 px of the photo but prints at ${String(tw)} × ${String(th)} px, about ${String(Math.round(150 / f150))} DPI at this size.`,
    at150[0]?.label ?? 'none',
  );

  // --- 7. Zooming a crop across the thresholds -----------------------------
  await act(p, 'switchToPixels');
  await act(p, 'setCanvasSize', 3000, 2000);
  const photoId = await p.evaluate(
    () => (window as any).__app.store.getPhotos()[0].id as string,
  );
  const levels: string[] = [];
  for (const zoom of [1, 1.5, 1.6, 3, 3.1, 1]) {
    await act(p, 'setCrop', photoId, { x: 0.5, y: 0.5, zoom });
    levels.push((await badges(p)).map((b) => b.level).join('') || 'none');
  }
  check(
    'resolution: zooming a crop in crosses 1.5 and 3, zooming out removes the badge',
    levels.join(' ') === 'none none low low very-low none',
    levels.join(' '),
  );

  // --- 8. The toggle is session-only; export and project do not change -----
  await act(p, 'setCanvasSize', 1500, 1000);
  await act(p, 'setCrop', photoId, { x: 0.3, y: 0.4, zoom: 2 });
  await addSized(p, [
    [300, 200],
    [900, 600],
  ]);
  await drawn(p);
  const warned = (await badges(p)).length;
  const exportPng = async (): Promise<string> => {
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 120_000 }),
      p.locator('.export-download').click(),
    ]);
    const hash = sha(readFileSync(await download.path()));
    await p.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>('.export-download')!
          .disabled,
      undefined,
      { timeout: 120_000 },
    );
    return hash;
  };
  const saveProject = async (): Promise<Buffer> => {
    const path = join(tmpdir(), `res-${String(Date.now())}.zip`);
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 120_000 }),
      p.locator('.project-save').click(),
    ]);
    await download.saveAs(path);
    await p.waitForTimeout(300);
    return readFileSync(path);
  };
  const toggle = p.locator('.res-toggle input');
  check(
    'resolution: the checkbox "Show resolution warnings" is on by default',
    (await toggle.isChecked()) &&
      (await p.locator('.res-toggle').innerText()).trim() ===
        'Show resolution warnings',
  );
  const stateBefore = await p.evaluate(() => {
    const w = window as any;
    w.__stateRef = w.__app.editor.getState();
    return w.__app.undo.manager.canUndo() as boolean;
  });
  const commitsBefore = await commits();
  const pngOn = await exportPng();
  const zipOn = await saveProject();
  await toggle.uncheck();
  await drawn(p);
  const hidden = {
    badges: (await badges(p)).length,
    summary: await summary(p),
    tray: Object.keys(await trayMarks(p)).length,
    tooltip: await tooltip(),
  };
  check(
    'resolution: the toggle hides every badge, tray marker and the summary',
    warned > 0 &&
      hidden.badges === 0 &&
      hidden.summary === null &&
      hidden.tray === 0 &&
      hidden.tooltip === null,
    JSON.stringify(hidden),
  );
  const pngOff = await exportPng();
  const zipOff = await saveProject();
  await toggle.check();
  await drawn(p);
  const pngBack = await exportPng();
  check(
    'resolution: the exported PNG is byte-identical with warnings on, off and on again',
    pngOn === pngOff && pngOff === pngBack,
    `${pngOn.slice(0, 12)} ${pngOff.slice(0, 12)} ${pngBack.slice(0, 12)}`,
  );
  const entries = (zip: Buffer): Record<string, string> =>
    Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(zip))).map(([name, data]) => [
        name,
        sha(Buffer.from(data)),
      ]),
    );
  check(
    'resolution: a saved project holds identical files with warnings on and off',
    JSON.stringify(entries(zipOn)) === JSON.stringify(entries(zipOff)),
    `${String(zipOn.length)} vs ${String(zipOff.length)} bytes; raw bytes ${zipOn.equals(zipOff) ? 'identical' : 'differ'}`,
  );
  const stateAfter = await p.evaluate(() => {
    const w = window as any;
    return {
      same: w.__stateRef === w.__app.editor.getState(),
      canUndo: w.__app.undo.manager.canUndo() as boolean,
      keys: Object.keys(w.__app.editor.getState()).sort().join(','),
    };
  });
  check(
    'resolution: toggling is not an editor change (same state object, no commit, no undo step, no new state key)',
    stateAfter.same &&
      stateAfter.canUndo === stateBefore &&
      (await commits()) === commitsBefore &&
      !/resol|warn/i.test(stateAfter.keys),
    `${stateAfter.keys}; commits ${String(commitsBefore)} -> ${String(await commits())}`,
  );
  check(
    'resolution: the project JSON does not mention the warnings',
    !Object.entries(unzipSync(new Uint8Array(zipOn))).some(
      ([name, data]) =>
        name.endsWith('.json') &&
        /resolution|warning/i.test(Buffer.from(data).toString('utf8')),
    ),
  );
  const reloaded = await ctx.newPage();
  await reloaded.goto(origin);
  await reloaded.waitForSelector('.tray');
  check(
    'resolution: a fresh page starts with the warnings on (the toggle is not stored)',
    await reloaded.locator('.res-toggle input').isChecked(),
  );
  await reloaded.close();

  await checkRotated(browser, origin, check);
  await checkTooltipsInViewport(browser, origin, check);
  if (screenshots) await shoot(browser, origin, screenshots);
  await ctx.close();
}

/** An EXIF-rotated photo is measured by its upright size. */
async function checkRotated(
  browser: Browser,
  origin: string,
  check: Check,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin);
  const file = join(fixtures, 'orient-6.jpg');
  const header = imageSize(readFileSync(file));
  await p.setInputFiles('input[type=file]', file);
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 1,
  );
  const dims = await p.evaluate(() => {
    const photo = (window as any).__app.store.getPhotos()[0];
    return { w: photo.width as number, h: photo.height as number };
  });
  // Twice the upright size: factor 2, low.
  await act(p, 'setCanvasSize', dims.w * 2, dims.h * 2);
  const found = await badges(p);
  check(
    'resolution: an EXIF-rotated photo is measured by its rotated (upright) size',
    header !== null &&
      dims.w === header.height &&
      dims.h === header.width &&
      found.length === 1 &&
      found[0]?.label ===
        `Low resolution: this tile uses ${String(dims.w)} × ${String(dims.h)} px of the photo but exports at ${String(dims.w * 2)} × ${String(dims.h * 2)} px, so it will be enlarged 2×.`,
    `${JSON.stringify(header)} ${JSON.stringify(dims)} ${found[0]?.label ?? 'none'}`,
  );
  await ctx.close();
}

/** The twelve-photo scene used by the screenshots and the viewport check. */
async function buildScene(p: Page): Promise<void> {
  await addSized(p, [
    [5200, 3500],
    [4200, 2800],
    [3000, 2000],
    [2400, 1600],
    [1800, 1200],
    [1200, 800],
    [900, 600],
    [3600, 2400],
    [2000, 3000],
    [1600, 2400],
    [600, 400],
  ]);
  // A2 landscape at 300 DPI: 7016 x 4961 px.
  await act(p, 'switchToPixels');
  await act(p, 'setPhysicalSize', 594, 420, 300);
  await act(p, 'shuffle', 11);
  await p.locator('#size-variation').fill('0.6');
  await drawn(p);
}

/** The tooltip of the badge nearest each canvas corner stays in the viewport. */
async function checkTooltipsInViewport(
  browser: Browser,
  origin: string,
  check: Check,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin, 900, 620);
  await buildScene(p);
  const corners = await p.evaluate(() => {
    const r = document
      .querySelector<HTMLElement>('.collage-canvas')!
      .getBoundingClientRect();
    return [
      [r.left, r.top],
      [r.right, r.top],
      [r.left, r.bottom],
      [r.right, r.bottom],
    ] as [number, number][];
  });
  const found = await badges(p);
  const results: string[] = [];
  let ok = found.length >= 3;
  for (const [cx, cy] of corners) {
    const nearest = [...found].sort(
      (a, b) =>
        Math.hypot(a.rect.x + 10 - cx, a.rect.y + 10 - cy) -
        Math.hypot(b.rect.x + 10 - cx, b.rect.y + 10 - cy),
    )[0];
    if (!nearest) {
      ok = false;
      continue;
    }
    await p.mouse.move(2, 2);
    await p.waitForTimeout(450);
    await p.mouse.move(nearest.rect.x + 10, nearest.rect.y + 10);
    await p.waitForTimeout(100);
    const box = await p.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.res-tooltip');
      if (!el || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        w: window.innerWidth,
        h: window.innerHeight,
      };
    });
    const inside =
      box !== null &&
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= box.w + 0.5 &&
      box.bottom <= box.h + 0.5;
    ok &&= inside;
    results.push(inside ? 'in' : `OUT ${JSON.stringify(box)}`);
  }
  check(
    'resolution: at 900 x 620 the tooltip of the badge nearest each canvas corner stays inside the viewport',
    ok,
    results.join(' '),
  );
  await ctx.close();
}

/** Screenshots for the pull request: synthetic photos only. */
async function shoot(
  browser: Browser,
  origin: string,
  dir: string,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin);
  mkdirSync(dir, { recursive: true });
  const out = (name: string): string => join(dir, `issue-15-${name}.png`);
  await buildScene(p);
  await p.locator('.tray-grid').evaluate((el) => (el.scrollLeft = 0));
  const hoverBadge = async (level: string): Promise<void> => {
    const b = (await badges(p)).find((x) => x.level === level);
    if (!b) throw new Error(`no ${level} badge to photograph`);
    await p.mouse.move(
      b.rect.x + b.rect.width / 2,
      b.rect.y + b.rect.height / 2,
    );
    await p.waitForTimeout(100);
  };
  await p.locator('.res-summary').scrollIntoViewIfNeeded();
  await p.mouse.move(2, 2);
  await p.screenshot({ path: out('overview-1440x900') });
  const sum = (await p.locator('.res-summary').boundingBox())!;
  await p.mouse.move(sum.x + 12, sum.y + 12);
  await p.waitForTimeout(100);
  await p.screenshot({ path: out('summary-highlight-1440x900') });
  await p.mouse.move(2, 2);
  await hoverBadge('very-low');
  await p.screenshot({ path: out('tooltip-very-low-physical-1440x900') });
  await hoverBadge('low');
  await p.screenshot({ path: out('tooltip-low-physical-1440x900') });
  await p.mouse.move(2, 2);
  await act(p, 'switchToPixels');
  await hoverBadge('low');
  await p.screenshot({ path: out('tooltip-low-pixels-1440x900') });
  await p.mouse.move(2, 2);
  while ((await p.locator('.notice button').count()) > 0) {
    await p.locator('.notice button').first().click();
  }
  await p.getByRole('button', { name: 'Show all' }).click();
  await p.waitForTimeout(500);
  await drawn(p);
  await p.screenshot({ path: out('tray-expanded-1440x900') });
  await p.getByRole('button', { name: 'Show one row' }).click();
  await p.locator('.res-toggle input').uncheck();
  await drawn(p);
  await p.screenshot({ path: out('warnings-off-1440x900') });
  await p.locator('.res-toggle input').check();
  await drawn(p);
  await p.setViewportSize({ width: 900, height: 620 });
  await p.waitForTimeout(500);
  await drawn(p);
  await p.mouse.move(2, 2);
  await hoverBadge('very-low');
  await p.screenshot({ path: out('tooltip-900x620') });
  await ctx.close();
}
