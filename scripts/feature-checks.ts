/**
 * Real-browser checks for featured photos (issue #14), called from
 * browser-check.ts. Photos are generated in the page (flat gradients with
 * their size written on them), so nothing is read from disk and no real photo
 * is involved.
 *
 *   node scripts/browser-check.ts --feature-only [--feature-screenshot]
 *   node scripts/browser-check.ts --feature-only --feature-compat <checkout>
 *
 * `--feature-compat` takes a checkout of the released 2026.11.0 (for example
 * `git worktree add ../rel 2026.11.0` and `npm ci` there, or a symlinked
 * node_modules) and serves it beside this one: a project saved by the release
 * opens here with nothing featured, and a project with featured photos saved
 * here opens in the release, which ignores the mark.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import type { Browser, Page } from 'playwright-core';

type Check = (name: string, ok: boolean, detail?: string) => void;

const STATE_MODULE = '/src/editor/state.ts';
const RENDER_MODULE = '/src/editor/render.ts';
const sha = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

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

/** Adds one generated photo per `[width, height]`, named `f<i>-<w>x<h>.jpg`. */
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
      // Numbers keep counting after a removal, so no two photos share one.
      const w = window as any;
      let i: number = Math.max(before, w.__featureCounter ?? 0);
      w.__featureCounter = i + sizes.length;
      for (const [w, h] of sizes) {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${String((i * 47) % 360)} 50% 60%)`);
        g.addColorStop(1, `hsl(${String((i * 47 + 80) % 360)} 50% 30%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `bold ${String(Math.round(Math.min(w, h) / 6))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`#${String(i + 1)}`, w / 2, h / 2);
        const blob = await c.convertToBlob({
          type: 'image/jpeg',
          quality: 0.8,
        });
        dt.items.add(
          new File([blob], `f${String(i)}-${String(w)}x${String(h)}.jpg`, {
            type: 'image/jpeg',
            lastModified: 1_700_000_000_000 + i,
          }),
        );
        i++;
      }
      const input = document.querySelector<HTMLInputElement>(
        'input[type=file]:not(.project-input)',
      )!;
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
  await drawn(p);
}

/** The latest state is drawn, and the overlays have been updated for it. */
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
        document.querySelector<HTMLElement>('.progress')!.hidden &&
        state.photos.length === app.store.getIncludedIds().length
      );
    },
    undefined,
    { timeout: 60_000, polling: 25 },
  );
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
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

/**
 * For each featured photo in the collage: its tile's rank by drawn area (0 is
 * the largest), and whether every featured tile is at least as large as every
 * other tile.
 */
function featuredRanks(
  p: Page,
): Promise<{ k: number; ok: boolean; ranks: number[] }> {
  return p.evaluate(
    async ({ module }) => {
      const { tilesFor } = await import(/* @vite-ignore */ module);
      const s = (window as any).__app.editor.getState();
      // Each slot's tile as drawn: the renderer's and export's own call, at
      // the export pixel size with the effective border and snapped edges.
      const areas: number[] = [];
      for (const t of tilesFor(s, s.canvas)) areas[t.slot] = t.width * t.height;
      const marked = new Set<string>(s.featured ?? []);
      let minF = Infinity;
      let maxO = 0;
      const ranks: number[] = [];
      s.assignment.forEach((id: string, slot: number) => {
        const a = areas[slot]!;
        if (marked.has(id)) {
          minF = Math.min(minF, a);
          ranks.push(areas.filter((b) => b > a).length);
        } else maxO = Math.max(maxO, a);
      });
      return { k: ranks.length, ok: minF >= maxO, ranks: ranks.sort() };
    },
    { module: RENDER_MODULE },
  );
}

/** The centre of a slot's tile, in page CSS px. */
function centre(p: Page, slot: number): Promise<{ x: number; y: number }> {
  return p.evaluate((slot) => {
    const app = (window as any).__app;
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = canvas.getBoundingClientRect();
    const s = r.width / canvas.width;
    const t = app.view.lastRender().tiles.find((x: any) => x.slot === slot);
    return {
      x: r.left + (t.x + t.width / 2) * s,
      y: r.top + (t.y + t.height / 2) * s,
    };
  }, slot);
}

/** The slot of the smallest tile holding a photo that is not featured. */
function smallestPlainSlot(p: Page): Promise<number> {
  return p.evaluate(() => {
    const app = (window as any).__app;
    const last = app.view.lastRender();
    const marked = new Set<string>(last.state.featured ?? []);
    let best = -1;
    let bestArea = Infinity;
    for (const t of last.tiles) {
      if (marked.has(last.state.assignment[t.slot])) continue;
      if (t.width * t.height < bestArea) {
        bestArea = t.width * t.height;
        best = t.slot;
      }
    }
    return best;
  });
}

interface Star {
  photo: string;
  label: string | null;
  corner: string;
  /** The star lies inside its photo's tile, as drawn now. */
  onTile: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

function stars(p: Page): Promise<Star[]> {
  return p.evaluate(() => {
    const app = (window as any).__app;
    const last = app.view.lastRender();
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const cr = canvas.getBoundingClientRect();
    const sc = cr.width / canvas.width;
    return [...document.querySelectorAll<HTMLElement>('.feat-layer .feat-star')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const photo = el.dataset.photoId ?? '';
        const slot = last.state.assignment.indexOf(photo);
        const t = last.tiles.find((x: any) => x.slot === slot);
        const onTile =
          !!t &&
          r.left >= cr.left + t.x * sc - 0.5 &&
          r.top >= cr.top + t.y * sc - 0.5 &&
          r.right <= cr.left + (t.x + t.width) * sc + 0.5 &&
          r.bottom <= cr.top + (t.y + t.height) * sc + 0.5;
        return {
          photo,
          label: el.getAttribute('aria-label'),
          corner: el.dataset.corner ?? '',
          onTile,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      });
  });
}

/** Waits until the canvas's box has stopped moving (after a resize). */
async function settled(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as any;
      const r = document
        .querySelector<HTMLCanvasElement>('.collage-canvas')!
        .getBoundingClientRect();
      const key = `${String(r.x)},${String(r.y)},${String(r.width)},${String(r.height)}`;
      if (w.__fitKey !== key) {
        w.__fitKey = key;
        w.__fitFrames = 0;
      } else {
        w.__fitFrames++;
      }
      return w.__fitFrames >= 8;
    },
    undefined,
    { polling: 'raf' },
  );
  await drawn(p);
}

/** Tray thumbnails with a star: name and the text they are described by. */
function trayStars(p: Page): Promise<Record<string, string>> {
  return p.evaluate(() => {
    const out: Record<string, string> = {};
    for (const btn of document.querySelectorAll<HTMLElement>('.thumb')) {
      const star = btn.querySelector<HTMLElement>('.feat-star-tray');
      if (!star || star.getClientRects().length === 0) continue;
      const ids = (btn.getAttribute('aria-describedby') ?? '').split(' ');
      out[btn.getAttribute('aria-label') ?? ''] = ids
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' | ');
    }
    return out;
  });
}

const nameOf = (p: Page, id: string): Promise<string> =>
  p.evaluate(
    (id) => (window as any).__store.getPhoto(id).file.name as string,
    id,
  );

async function exportPng(p: Page): Promise<string> {
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 120_000 }),
    p.locator('.export-download').click(),
  ]);
  const hash = sha(readFileSync(await download.path()));
  await p.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.export-download')!.disabled,
    undefined,
    { timeout: 120_000 },
  );
  return hash;
}

async function saveProject(p: Page, tag: string): Promise<string> {
  const path = join(tmpdir(), `feature-${tag}-${String(Date.now())}.zip`);
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 120_000 }),
    p.locator('.project-save').click(),
  ]);
  await download.saveAs(path);
  await p.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('.project-save')!.disabled,
    undefined,
    { timeout: 120_000 },
  );
  return path;
}

async function openProject(p: Page, path: string): Promise<string> {
  await p.evaluate(() => {
    const w = window as any;
    w.__beforeOpen = w.__app.editor.getState();
  });
  await p.setInputFiles('.project-input', path);
  const asked = await p
    .waitForSelector('.project-dialog[open] .primary', { timeout: 3000 })
    .catch(() => null);
  if (asked) {
    await p.getByRole('button', { name: 'Replace with this project' }).click();
  }
  await p.waitForFunction(
    () => {
      const failed =
        document.querySelector('.project-dialog[open] h2')?.textContent ===
        'Could not open the project';
      const app = (window as any).__app;
      return (
        failed ||
        (app.editor.getState() !== (window as any).__beforeOpen &&
          app.editor.getState().photos.length > 0)
      );
    },
    undefined,
    { timeout: 120_000 },
  );
  const error = await p.evaluate(() =>
    document.querySelector('.project-dialog[open] h2')?.textContent ===
    'Could not open the project'
      ? (document.querySelector('.project-dialog[open]')?.textContent ??
        'error')
      : '',
  );
  if (!error) await drawn(p);
  return error;
}

const projectJson = (path: string): any =>
  JSON.parse(
    Buffer.from(
      unzipSync(new Uint8Array(readFileSync(path)))['project.json']!,
    ).toString('utf8'),
  );

/** 30 photos: landscape, portrait and square, at sizes with no warnings. */
const THIRTY: (readonly [number, number])[] = Array.from(
  { length: 30 },
  (_, i) =>
    (
      [
        [2400, 1800],
        [1800, 2400],
        [2400, 1600],
        [1600, 2400],
        [2000, 2000],
      ] as const
    )[i % 5]!,
);

export interface FeatureCheckOptions {
  /** Write docs/screenshots/issue-14-*.png here. */
  readonly screenshots?: string;
  /** The released app's dev server, for the compatibility checks. */
  readonly releaseOrigin?: string;
}

export async function checkFeature(
  browser: Browser,
  origin: string,
  check: Check,
  options: FeatureCheckOptions = {},
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin);
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_s: unknown, change: any) => {
      if (!change.transient) w.__commits++;
    });
  });
  const commits = (): Promise<number> =>
    p.evaluate(() => (window as any).__commits as number);
  /**
   * In the tray, collapsed and expanded: no star covers its thumbnail's tick
   * or warning, every featured photo's thumbnail is described as featured,
   * and expanded, every one shows its star.
   */
  const trayLayoutCheck = async (when: string): Promise<void> => {
    const results: string[] = [];
    for (const expanded of [false, true]) {
      if (expanded) {
        await p.getByRole('button', { name: 'Show all' }).click();
      }
      await settled(p);
      for (const star of await stars(p)) {
        if (!star.onTile) {
          results.push(`${expanded ? 'expanded' : 'row'}: star off its tile`);
        }
      }
      const r = await p.evaluate(() => {
        const s = (window as any).__app.editor.getState();
        const store = (window as any).__store;
        const featured = new Set<string>(s.featured ?? []);
        const problems: string[] = [];
        let shown = 0;
        const apart = (a: DOMRect, b: DOMRect) =>
          a.right <= b.left ||
          b.right <= a.left ||
          a.bottom <= b.top ||
          b.bottom <= a.top;
        for (const btn of document.querySelectorAll<HTMLElement>('.thumb')) {
          const name = btn.getAttribute('aria-label') ?? '';
          const id = store.getPhotos().find((x: any) => x.file.name === name)
            ?.id as string;
          const star = btn.querySelector<HTMLElement>('.feat-star-tray');
          const said = (btn.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .map((i) => document.getElementById(i)?.textContent ?? '');
          if (featured.has(id) !== said.includes('Featured')) {
            problems.push(`${name}: described ${JSON.stringify(said)}`);
          }
          if (!star || star.getClientRects().length === 0) continue;
          shown++;
          const a = star.getBoundingClientRect();
          for (const other of btn.querySelectorAll<HTMLElement>(
            '.tick, .res-badge-tray',
          )) {
            if (other.getClientRects().length === 0) continue;
            if (!apart(a, other.getBoundingClientRect())) {
              problems.push(`${name}: star covers ${other.className}`);
            }
          }
          const box = btn.getBoundingClientRect();
          if (
            a.left < box.left ||
            a.right > box.right ||
            a.bottom > box.bottom
          ) {
            problems.push(`${name}: star outside the thumbnail`);
          }
        }
        return { shown, featured: featured.size, problems };
      });
      if (expanded && r.shown !== r.featured) {
        r.problems.push(`${String(r.shown)} stars for ${String(r.featured)}`);
      }
      results.push(
        ...r.problems.map((x) => `${expanded ? 'expanded' : 'row'}: ${x}`),
      );
      if (expanded) {
        await p.getByRole('button', { name: 'Show one row' }).click();
      }
    }
    await settled(p);
    for (const star of await stars(p)) {
      if (!star.onTile) results.push('row again: star off its tile');
    }
    check(
      `feature: tray stars never cover the include tick or a warning, every featured thumbnail says "Featured", and tile stars follow the canvas as the tray grows and shrinks (${when})`,
      results.length === 0,
      results.slice(0, 6).join('; '),
    );
  };
  await addSized(p, THIRTY);
  await act(p, 'shuffle', 20261112);
  const shot = async (name: string): Promise<void> => {
    if (options.screenshots) {
      await p.screenshot({ path: join(options.screenshots, name) });
    }
  };

  // --- 1. The menu item, and featuring a photo in a small tile --------------
  const small = await smallestPlainSlot(p);
  const before = await p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    (window as any).__beforeFeature = s;
    return s.assignment as string[];
  });
  const target = before[small]!;
  const targetName = await nameOf(p, target);
  const c = await centre(p, small);
  await p.mouse.click(c.x, c.y);
  const featureBtn = p.locator('.tile-menu-feature');
  check(
    'feature: the tile menu offers "Feature" with its shortcut in the tooltip',
    (await featureBtn.isVisible()) &&
      (await featureBtn.innerText()) === 'Feature' &&
      (await featureBtn.getAttribute('aria-pressed')) === 'false' &&
      ((await featureBtn.getAttribute('title')) ?? '').endsWith('(F)'),
    `${await featureBtn.innerText()} / ${String(await featureBtn.getAttribute('title'))}`,
  );
  await shot('issue-14-menu-1440x900.png');
  const commits0 = await commits();
  await featureBtn.click();
  await drawn(p);
  const after = await p.evaluate(
    () => (window as any).__app.editor.getState().assignment as string[],
  );
  const ranks1 = await featuredRanks(p);
  const changed = after.filter((id, i) => id !== before[i]);
  check(
    'feature: a photo in the smallest tile moves to the largest tile, by one swap, in one commit',
    ranks1.k === 1 &&
      ranks1.ranks[0] === 0 &&
      changed.length === 2 &&
      (await commits()) - commits0 === 1,
    `ranks ${JSON.stringify(ranks1.ranks)}, ${String(changed.length)} moved, ${String((await commits()) - commits0)} commits`,
  );
  const selectedNow = await p.evaluate(() =>
    (window as any).__app.selection.getSelection(),
  );
  check(
    'feature: the photo stays selected and the menu now offers "Unfeature"',
    selectedNow.kind === 'selected' &&
      selectedNow.photoId === target &&
      (await featureBtn.innerText()) === 'Unfeature' &&
      (await featureBtn.getAttribute('aria-pressed')) === 'true',
    JSON.stringify(selectedNow),
  );
  const label = await p.locator('.collage-canvas').getAttribute('aria-label');
  check(
    'feature: the tile description says the photo is featured',
    (label ?? '').includes(`${targetName}, tile`) &&
      (label ?? '').includes(', featured'),
    label ?? '',
  );
  await p.keyboard.press('Escape');
  await drawn(p);
  const s1 = await stars(p);
  const t1 = await trayStars(p);
  check(
    'feature: a star marks the featured tile and its tray thumbnail, with accessible names',
    s1.length === 1 &&
      s1[0]?.photo === target &&
      s1[0].onTile &&
      s1[0].label === 'Featured' &&
      Object.keys(t1).length === 1 &&
      t1[targetName] === 'Featured',
    `${JSON.stringify(s1)} ${JSON.stringify(t1)}`,
  );
  await trayLayoutCheck('one featured photo');
  // The featured thumbnail scrolled into view, for the screenshot.
  await p.locator(`.thumb[aria-label="${targetName}"]`).evaluate((el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  await settled(p);
  await shot('issue-14-featured-1440x900.png');

  // --- 2. Undo and redo: arrangement and mark together ----------------------
  await p.evaluate(() => (window as any).__app.undo.manager.undo());
  await drawn(p);
  const undone = await p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    return {
      same:
        JSON.stringify(s.assignment) ===
        JSON.stringify((window as any).__beforeFeature.assignment),
      featured: s.featured ?? [],
    };
  });
  check(
    'feature: one Undo restores both the arrangement and the mark',
    undone.same &&
      undone.featured.length === 0 &&
      (await stars(p)).length === 0,
    JSON.stringify(undone),
  );
  await p.evaluate(() => (window as any).__app.undo.manager.redo());
  await drawn(p);
  check(
    'feature: Redo features it again in the large tile',
    (await featuredRanks(p)).ranks.join() === '0',
  );

  // --- 3. The keyboard shortcut ---------------------------------------------
  const small2 = await smallestPlainSlot(p);
  const c2 = await centre(p, small2);
  await p.mouse.click(c2.x, c2.y);
  const id2 = await p.evaluate(
    () => (window as any).__app.selection.getSelection().photoId as string,
  );
  await p.keyboard.press('f');
  await drawn(p);
  const r2 = await featuredRanks(p);
  check(
    'feature: F on the selected tile features it, into the largest tile not held by a feature',
    r2.k === 2 &&
      r2.ok &&
      r2.ranks.join() === '0,1' &&
      (await p.evaluate(
        (id) => (window as any).__app.editor.getState().featured.includes(id),
        id2,
      )),
    JSON.stringify(r2),
  );
  const beforeUnfeature = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  await p.keyboard.press('f');
  await drawn(p);
  const afterUnfeature = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  check(
    'feature: F again unfeatures it, and nothing moves',
    afterUnfeature === beforeUnfeature && (await featuredRanks(p)).k === 1,
  );
  await p.keyboard.press('Escape');

  // F typed into a text field is text, even with a tile selected; and F on
  // the canvas with no tile selected (only the keyboard focus ring) does
  // nothing.
  const snapshot = (): Promise<string> =>
    p.evaluate(() => {
      const w = window as any;
      const s = w.__app.editor.getState();
      return JSON.stringify([s.featured, s.assignment, w.__commits]);
    });
  {
    const beforeKeys = await snapshot();
    const c3 = await centre(p, await smallestPlainSlot(p));
    await p.mouse.click(c3.x, c3.y);
    const selectedFirst = await p.evaluate(
      () => (window as any).__app.selection.getSelection().kind as string,
    );
    const field = p.locator('#size-width');
    const original = await field.inputValue();
    await field.focus();
    await p.keyboard.press('End');
    await p.keyboard.press('f');
    await p.keyboard.press('Shift+F');
    const typed = await field.inputValue();
    await p.keyboard.press('Backspace');
    await p.keyboard.press('Backspace');
    await p.evaluate(() => {
      (document.activeElement as HTMLElement).blur();
    });
    await drawn(p);
    const afterField = await snapshot();
    check(
      'feature: F typed into the width field (with a tile selected) goes into the field and features nothing',
      selectedFirst === 'selected' &&
        typed === `${original}fF` &&
        afterField === beforeKeys &&
        (await field.inputValue()) === original,
      `${selectedFirst}; typed ${JSON.stringify(typed)}`,
    );
    await p.keyboard.press('Escape');
    await p.evaluate(() => {
      document.querySelector<HTMLElement>('.collage-canvas')!.focus();
    });
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('f');
    await p.keyboard.press('F');
    await drawn(p);
    const idle = await p.evaluate(
      () => (window as any).__app.selection.getSelection().kind as string,
    );
    check(
      'feature: F on the canvas with no tile selected does nothing',
      idle === 'idle' && (await snapshot()) === beforeKeys,
      idle,
    );
    await p.evaluate(() => {
      (document.activeElement as HTMLElement).blur();
    });
  }

  // --- 4. The menu still fits at 900 x 620 ----------------------------------
  await p.setViewportSize({ width: 900, height: 620 });
  await p.waitForTimeout(400);
  await drawn(p);
  let fits = true;
  const problems: string[] = [];
  for (const slot of [0, 1, 2, 3, small]) {
    const at = await centre(p, slot);
    if (at.x < 0 || at.y < 0 || at.x > 900 || at.y > 620) continue;
    await p.mouse.click(at.x, at.y);
    const box = await p.locator('.tile-menu').boundingBox();
    const btn = await featureBtn.boundingBox();
    if (
      !box ||
      !btn ||
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > 900 ||
      box.y + box.height > 620 ||
      btn.x + btn.width > box.x + box.width
    ) {
      fits = false;
      problems.push(`${String(slot)}: ${JSON.stringify(box)}`);
    }
    await p.keyboard.press('Escape');
  }
  check(
    'feature: the menu with Feature / Unfeature stays inside a 900 x 620 viewport',
    fits,
    problems.join('; '),
  );
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(400);
  await drawn(p);

  // --- 5. Re-rolls: 1, 2, 5 featured of 30, borders 0, 1, 3 and 10% -------
  // Areas are those of the tiles as drawn (tilesFor at the export size, with
  // the effective border and snapped edges). A border change is not a re-roll
  // and moves no photo, so each border is followed by a Shuffle before the
  // guarantee is checked.
  const BORDERS = [0, 0.01, 0.03, 0.1];
  for (const k of [1, 2, 5]) {
    const result = await p.evaluate(
      async ({ k, stateModule, renderModule, borders }) => {
        const actions = await import(/* @vite-ignore */ stateModule);
        const { tilesFor } = await import(/* @vite-ignore */ renderModule);
        const app = (window as any).__app;
        const ed = app.editor;
        const ids: string[] = ed.getState().photos.map((x: any) => x.id);
        // Unfeature everything, then feature k photos spread over the list.
        for (const id of ed.getState().featured ?? []) {
          ed.dispatch((s: any) => actions.setFeatured(s, id, false));
        }
        for (let i = 0; i < k; i++) {
          const id = ids[(i * 7 + 3) % ids.length];
          ed.dispatch((s: any) => actions.setFeatured(s, id, true));
        }
        const failures: string[] = [];
        let checks = 0;
        const verify = (what: string) => {
          const s = ed.getState();
          const areas: number[] = [];
          for (const t of tilesFor(s, s.canvas)) {
            areas[t.slot] = t.width * t.height;
          }
          const marked = new Set(s.featured ?? []);
          let minF = Infinity;
          let maxO = 0;
          let n = 0;
          s.assignment.forEach((id: string, slot: number) => {
            if (marked.has(id)) {
              n++;
              minF = Math.min(minF, areas[slot]!);
            } else maxO = Math.max(maxO, areas[slot]!);
          });
          const valid =
            new Set(s.assignment).size === s.photos.length &&
            s.assignment.length === s.photos.length &&
            areas.length === s.photos.length;
          checks++;
          if (n !== k || minF < maxO || !valid) {
            failures.push(`${what} (${String(minF)} < ${String(maxO)})`);
          }
        };
        const sizes = [
          [1920, 1080],
          [1080, 1920],
          [1200, 1200],
          [2480, 3508],
          [3508, 2480],
        ];
        for (const border of borders) {
          ed.dispatch((s: any) => actions.setCanvasSize(s, 1920, 1080));
          ed.dispatch((s: any) => actions.setBorder(s, border));
          ed.shuffle();
          const at = `border ${String(border)}`;
          verify(`${at} shuffle`);
          for (const [w, h] of sizes) {
            ed.dispatch((s: any) => actions.setCanvasSize(s, w, h));
            verify(`${at} ratio ${String(w)}x${String(h)}`);
          }
          for (let i = 0; i < 20; i++) {
            ed.commitVariation(i / 19);
            verify(`${at} dial ${(i / 19).toFixed(3)}`);
          }
          for (let i = 0; i < 20; i++) {
            ed.shuffle();
            verify(`${at} shuffle ${String(i)}`);
          }
        }
        ed.dispatch((s: any) => actions.setBorder(s, 0));
        ed.dispatch((s: any) => actions.setCanvasSize(s, 1920, 1080));
        ed.commitVariation(0.5);
        return { checks, failures };
      },
      {
        k,
        stateModule: STATE_MODULE,
        renderModule: RENDER_MODULE,
        borders: BORDERS,
      },
    );
    await drawn(p);
    check(
      `feature: with ${String(k)} featured of 30, every featured photo stays in the ${String(k)} largest drawn tiles at borders 0, 1, 3 and 10% through 5 ratios, 20 dial positions and 21 Shuffles each`,
      result.checks === BORDERS.length * 46 && result.failures.length === 0,
      `${String(result.checks)} checks; ${result.failures.slice(0, 5).join(', ')}`,
    );
  }

  // The review's case: 30 images cycling 320 x 200, 200 x 320 and 200 x 200,
  // photos 1 to 5 featured, 1920 x 1080, dial 0.5, 3% border, seed
  // 3601405607. Ranked on borderless, unsnapped geometry, a featured tile
  // there was drawn smaller than an unfeatured one.
  {
    const repro = await newPage(browser, origin);
    await addSized(
      repro.p,
      Array.from(
        { length: 30 },
        (_, i) =>
          (
            [
              [320, 200],
              [200, 320],
              [200, 200],
            ] as const
          )[i % 3]!,
      ),
    );
    const order: string[] = await repro.p.evaluate(() =>
      (window as any).__store.getPhotos().map((x: any) => x.id),
    );
    for (const id of order.slice(0, 5))
      await act(repro.p, 'setFeatured', id, true);
    await act(repro.p, 'setCanvasSize', 1920, 1080);
    await act(repro.p, 'setVariation', 0.5);
    await act(repro.p, 'setBorder', 0.03);
    await act(repro.p, 'shuffle', 3601405607);
    const r = await featuredRanks(repro.p);
    const border = await repro.p.evaluate(async (module) => {
      const { borderAt } = await import(/* @vite-ignore */ module);
      return borderAt((window as any).__app.editor.getState()).effective;
    }, STATE_MODULE);
    check(
      "feature: the review's case (30 photos, 5 featured, 1920 x 1080, dial 0.5, 3% border, seed 3601405607): the featured photos are in the 5 largest drawn tiles",
      r.k === 5 && r.ok && border > 0 && r.ranks.every((x) => x < 5),
      `${JSON.stringify(r)}; border ${String(border)} px`,
    );
    await repro.ctx.close();
  }
  // The Shuffle button itself, with screenshots before and after.
  await shot('issue-14-before-shuffle-1440x900.png');
  const shuffleRanks: string[] = [];
  for (let i = 0; i < 5; i++) {
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await drawn(p);
    const r = await featuredRanks(p);
    shuffleRanks.push(r.ok && r.k === 5 ? 'ok' : JSON.stringify(r));
  }
  await shot('issue-14-after-shuffle-1440x900.png');
  check(
    'feature: the Shuffle button keeps the featured photos in the largest tiles',
    shuffleRanks.every((r) => r === 'ok'),
    shuffleRanks.join(' '),
  );

  // --- 6. The mark survives exclude/include, removals and imports -----------
  const featuredNow = await p.evaluate(
    () => (window as any).__app.editor.getState().featured as string[],
  );
  const excluded = featuredNow[0]!;
  const excludedName = await nameOf(p, excluded);
  await p.locator(`.thumb[aria-label="${excludedName}"]`).click();
  await drawn(p);
  const whileOut = await p.evaluate((id) => {
    const s = (window as any).__app.editor.getState();
    return {
      marked: (s.featured ?? []).includes(id),
      inCollage: s.assignment.includes(id),
    };
  }, excluded);
  check(
    'feature: an excluded featured photo keeps its mark and its tray star, and takes no tile',
    whileOut.marked &&
      !whileOut.inCollage &&
      (await trayStars(p))[excludedName] === 'Featured' &&
      (await featuredRanks(p)).ok,
    JSON.stringify(whileOut),
  );
  await p.locator(`.thumb[aria-label="${excludedName}"]`).click();
  await drawn(p);
  check(
    'feature: included again, it is featured again and back in a large tile',
    (await featuredRanks(p)).k === 5 && (await featuredRanks(p)).ok,
  );
  // Remove a photo that is not featured from the store, then import more.
  await p.evaluate((marked) => {
    const store = (window as any).__store;
    const victim = store.getPhotos().find((x: any) => !marked.includes(x.id));
    store.removePhotos([victim.id]);
  }, featuredNow);
  await drawn(p);
  const afterRemove = await featuredRanks(p);
  await addSized(p, [
    [2400, 1800],
    [1800, 2400],
  ]);
  const afterImport = await featuredRanks(p);
  check(
    'feature: removing another photo and importing more keep every mark, in the largest tiles',
    afterRemove.k === 5 &&
      afterRemove.ok &&
      afterImport.k === 5 &&
      afterImport.ok,
    `${JSON.stringify(afterRemove)} ${JSON.stringify(afterImport)}`,
  );

  // --- 7. Beside a low-resolution warning on the same tile ------------------
  await addSized(p, [
    [120, 90],
    [90, 120],
  ]);
  const lowId = await p.evaluate(
    () =>
      (window as any).__store.getPhotos().find((x: any) => x.width === 120)
        .id as string,
  );
  await act(p, 'setFeatured', lowId, true);
  const lowPortrait = await p.evaluate(
    () =>
      (window as any).__store.getPhotos().find((x: any) => x.width === 90)
        .id as string,
  );
  await act(p, 'setFeatured', lowPortrait, true);
  const both = await p.evaluate((id) => {
    const star = [...document.querySelectorAll<HTMLElement>('.feat-star')].find(
      (el) => el.dataset.photoId === id && el.getClientRects().length > 0,
    );
    const app = (window as any).__app;
    const warning = app.resolution.warningFor(id);
    // The badge of the tile holding `id`: the warned slot.
    const slot = app.editor.getState().assignment.indexOf(id);
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const cr = canvas.getBoundingClientRect();
    const s = cr.width / canvas.width;
    const tile = app.view.lastRender().tiles.find((t: any) => t.slot === slot);
    const right = cr.left + (tile.x + tile.width) * s;
    const top = cr.top + tile.y * s;
    const badge = [
      ...document.querySelectorAll<HTMLElement>('.res-layer .res-badge'),
    ].find((el) => {
      const r = el.getBoundingClientRect();
      return (
        el.getClientRects().length > 0 &&
        Math.abs(r.right + 4 - right) < 2 &&
        Math.abs(r.top - 4 - top) < 2
      );
    });
    if (!star || !badge) {
      return {
        star: !!star,
        badge: !!badge,
        level: warning?.level,
        apart: false,
      };
    }
    const a = star.getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    return {
      star: true,
      badge: true,
      level: warning?.level,
      apart:
        a.right <= b.left ||
        b.right <= a.left ||
        a.bottom <= b.top ||
        b.bottom <= a.top,
    };
  }, lowId);
  check(
    'feature: a featured low-resolution photo in a big tile shows both its warning and its star, apart',
    both.star && both.badge && both.apart && both.level !== undefined,
    JSON.stringify(both),
  );
  await shot('issue-14-featured-with-warning-1440x900.png');
  await trayLayoutCheck('beside low-resolution warnings');
  await drawn(p);

  // --- 8. Export is byte-identical with and without the markers -------------
  const featuredExport = await p.evaluate(
    () => (window as any).__app.editor.getState().featured as string[],
  );
  const pngWith = await exportPng(p);
  const arrangementWith = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  // Unfeaturing never moves anything: the same arrangement, no stars.
  for (const id of featuredExport) await act(p, 'setFeatured', id, false);
  const arrangementWithout = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  const pngWithout = await exportPng(p);
  check(
    'feature: the exported PNG is byte-identical with and without featured markers (same arrangement)',
    arrangementWith === arrangementWithout &&
      (await stars(p)).length === 0 &&
      pngWith === pngWithout,
    `${pngWith.slice(0, 12)} vs ${pngWithout.slice(0, 12)}`,
  );
  for (const id of featuredExport) await act(p, 'setFeatured', id, true);

  // --- 9. Save, then open ----------------------------------------------------
  const saved = await saveProject(p, 'marks');
  const json = projectJson(saved);
  const expected = await p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    return { featured: s.featured, assignment: s.assignment };
  });
  check(
    'feature: the saved project lists the featured photos in state.featured, format version 1',
    json.version === 1 &&
      JSON.stringify(json.state.featured) === JSON.stringify(expected.featured),
    JSON.stringify(json.state.featured),
  );
  const fresh = await newPage(browser, origin);
  const openError = await openProject(fresh.p, saved);
  const reopened = await fresh.p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    return { featured: s.featured, assignment: s.assignment };
  });
  check(
    'feature: opening the project restores the marks, the arrangement and the stars',
    openError === '' &&
      JSON.stringify(reopened) === JSON.stringify(expected) &&
      (await stars(fresh.p)).length > 0 &&
      (await fresh.p.evaluate(
        () =>
          [...document.querySelectorAll('.thumb')].filter((b) =>
            (b.getAttribute('aria-describedby') ?? '').includes('feat-said-'),
          ).length,
      )) === expected.featured.length,
    openError || JSON.stringify(reopened.featured),
  );

  // Hostile `featured` values are refused, and the open project stays as it
  // was (docs/project-format.md: anything but a list of distinct ids of
  // photos in the project is refused).
  {
    const entries = unzipSync(new Uint8Array(readFileSync(saved)));
    const ids: string[] = json.photos.map((x: any) => x.id);
    const cases: [string, unknown][] = [
      ['a string', 'x'],
      ['null', null],
      ['an object', { 0: ids[0] }],
      ['numbers', [1, 2]],
      ['a non-string entry beside a real id', [ids[0], { id: ids[1] }]],
      ['an unknown id', ['nobody']],
      ['a duplicate', [ids[0], ids[0]]],
      [
        '10,000 entries',
        Array.from({ length: 10_000 }, (_, i) => `photo-${String(i + 1)}`),
      ],
      [
        '10,000 copies of one real id',
        Array.from({ length: 10_000 }, () => ids[0]),
      ],
    ];
    const before = await fresh.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    const starsBefore = (await stars(fresh.p)).length;
    for (const [what, value] of cases) {
      const project = { ...json, state: { ...json.state, featured: value } };
      const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
      for (const [name, bytes] of Object.entries(entries)) {
        files[name] =
          name === 'project.json'
            ? [new TextEncoder().encode(JSON.stringify(project)), { level: 0 }]
            : [bytes, { level: 0 }];
      }
      const path = join(
        tmpdir(),
        `feature-hostile-${String(Date.now())}-${String(Math.random()).slice(2)}.zip`,
      );
      writeFileSync(path, zipSync(files));
      const error = await openProject(fresh.p, path);
      if (error) {
        await fresh.p.getByRole('button', { name: 'OK' }).click();
        await fresh.p
          .waitForSelector('.project-dialog[open]', {
            state: 'detached',
            timeout: 10_000,
          })
          .catch(() => undefined);
      }
      const after = await fresh.p.evaluate(() =>
        JSON.stringify((window as any).__app.editor.getState()),
      );
      await drawn(fresh.p);
      check(
        `feature: a project file whose featured is ${what} is refused, and the open project is unchanged`,
        error.includes('Could not open the project') &&
          error.includes('featured') &&
          after === before &&
          (await stars(fresh.p)).length === starsBefore,
        error.replace(/\s+/g, ' ').slice(0, 160),
      );
    }
  }
  await fresh.ctx.close();

  // --- 10. Compatibility with the released 2026.11.0 -------------------------
  if (options.releaseOrigin) {
    const rel = await newPage(browser, options.releaseOrigin);
    await addSized(rel.p, THIRTY.slice(0, 12));
    const oldState = await rel.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    const oldZip = await saveProject(rel.p, 'release');
    const here = await newPage(browser, origin);
    const err1 = await openProject(here.p, oldZip);
    const opened = await here.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    check(
      'feature: a project saved by the released 2026.11.0 opens with nothing featured and the same collage',
      err1 === '' &&
        opened === oldState &&
        !('featured' in JSON.parse(opened)) &&
        (await stars(here.p)).length === 0,
      err1 || `${String(opened.length)} vs ${String(oldState.length)} chars`,
    );
    // The other way: feature a photo here, save, open in the release.
    const someId = await here.p.evaluate(
      () => (window as any).__app.editor.getState().assignment.at(-1) as string,
    );
    await act(here.p, 'setFeatured', someId, true);
    const newState = await here.p.evaluate(() =>
      (window as any).__app.editor.getState(),
    );
    const newZip = await saveProject(here.p, 'new');
    const err2 = await openProject(rel.p, newZip);
    const inOld = await rel.p.evaluate(() =>
      (window as any).__app.editor.getState(),
    );
    const { featured: _f, ...withoutMark } = newState;
    check(
      'feature: a project with featured photos opens in 2026.11.0, which ignores the mark and shows the same collage',
      err2 === '' &&
        JSON.stringify(inOld) === JSON.stringify(withoutMark) &&
        Array.isArray(_f),
      err2 || JSON.stringify(Object.keys(inOld)),
    );
    await here.ctx.close();
    await rel.ctx.close();
  }
  await ctx.close();

  // --- 11. 200 photos: continuous dial drags ---------------------------------
  // Above 150 photos a drag defers the assignment until the dial rests or the
  // drag ends. Once each drag has ended and the deferred assignment settled,
  // the featured photos are in the largest drawn tiles.
  {
    const big = await newPage(browser, origin);
    await addSized(
      big.p,
      Array.from(
        { length: 200 },
        (_, i) =>
          (
            [
              [400, 300],
              [300, 400],
              [360, 240],
              [300, 300],
            ] as const
          )[i % 4]!,
      ),
    );
    const order: string[] = await big.p.evaluate(() =>
      (window as any).__store.getPhotos().map((x: any) => x.id),
    );
    for (const i of [7, 50, 111, 160, 199]) {
      await act(big.p, 'setFeatured', order[i], true);
    }
    await act(big.p, 'setBorder', 0.01);
    const failures: string[] = [];
    let deferred = 0;
    for (let run = 0; run < 10; run++) {
      const box = (await big.p.locator('#size-variation').boundingBox())!;
      const y = box.y + box.height / 2;
      const x = (f: number): number => box.x + 1 + (box.width - 2) * f;
      // Different paths: start and end anywhere, some resting mid-drag long
      // enough for the deferred assignment to run, some not.
      const from = ((run * 37) % 100) / 100;
      const to = ((run * 61 + 13) % 100) / 100;
      await big.p.mouse.move(x(from), y);
      await big.p.mouse.down();
      const moves = 40;
      for (let i = 1; i <= moves; i++) {
        const t = i / moves;
        const wobble = Math.sin(t * Math.PI * (run + 1)) * 0.15;
        const f = Math.min(1, Math.max(0, from + (to - from) * t + wobble));
        await big.p.mouse.move(x(f), y);
        await big.p.waitForTimeout(run % 3 === 0 && i === moves / 2 ? 300 : 16);
      }
      await big.p.mouse.move(x(to), y);
      deferred += await big.p.evaluate(() =>
        (window as any).__app.editor.isDragging() ? 1 : 0,
      );
      await big.p.mouse.up();
      await big.p.waitForFunction(
        () => !(window as any).__app.editor.isDragging(),
        undefined,
        { timeout: 60_000 },
      );
      await drawn(big.p);
      const r = await featuredRanks(big.p);
      const dial = await big.p.evaluate(
        () => (window as any).__app.editor.getState().variation as number,
      );
      if (!(r.k === 5 && r.ok && r.ranks.every((rank) => rank < 5))) {
        failures.push(
          `drag ${String(run)} to ${dial.toFixed(3)}: ${JSON.stringify(r.ranks)}`,
        );
      }
    }
    check(
      'feature: with 200 photos, after each of 10 continuous dial drags ends and settles, the 5 featured photos are in the 5 largest drawn tiles',
      failures.length === 0 && deferred === 10,
      `${String(deferred)} drags were mid-gesture at release; ${failures.join('; ')}`,
    );
    await big.ctx.close();
  }
}
