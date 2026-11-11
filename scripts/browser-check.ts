/**
 * Local real-browser check for photo import (issue #4), the editor canvas
 * (issue #5), the canvas settings and page layout (issue #6) and physical
 * canvas sizes (issue #7), tile selection, Swap and Remove (issue #8), and tile crop (issue #9), and undo and redo (issue #10).
 * Not run in
 * CI: it needs
 * a locally installed Chrome. Decoding, EXIF handling and drag and drop cannot
 * be verified in Node.
 *
 *   node scripts/browser-check.ts                 # synthetic fixtures
 *   node scripts/browser-check.ts --screenshot    # also rewrite docs/screenshots/issue-6-*.png
 *   node scripts/browser-check.ts --physical-screenshot  # and docs/screenshots/issue-7-*.png
 *   node scripts/browser-check.ts --selection-screenshot  # and docs/screenshots/issue-8-*.png
 *   node scripts/browser-check.ts --crop-screenshot  # and docs/screenshots/issue-9-*.png
 *   node scripts/browser-check.ts --undo-screenshot  # and docs/screenshots/issue-10-undo.png
 *   node scripts/browser-check.ts --tray-screenshot  # and docs/screenshots/photo-tray.png
 *   node scripts/browser-check.ts --port 5301     # another dev server port (or BROWSER_CHECK_PORT)
 *   node scripts/browser-check.ts --only sharp,cap,drag  # the editor image checks (#27)
 *   node scripts/browser-check.ts --dir <folder>  # also import a folder of real
 *                                                  # photos and report timing
 *                                                  # (prints numbers only)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { checkA2, checkExport, exportRealFolder } from './export-checks.ts';
import { checkProject, projectRealFolder } from './project-checks.ts';

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

// --- Editor canvas helpers (issue #5) ----------------------------------------

/** The editor's pure actions, imported into the page from the dev server. */
const STATE_MODULE = '/src/editor/state.ts';

/** Waits until the latest editor state is drawn with every image decoded. */
async function waitDrawn(p: Page, timeout = 30000): Promise<void> {
  await p.waitForFunction(
    () => {
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const state = app.editor.getState();
      const included: string[] = app.store.getIncludedIds();
      // The store's changes reach the editor in the next frame: wait for it.
      return (
        last !== null &&
        last.state === state &&
        last.missing === 0 &&
        // No thumbnail standing in for a preview still decoding: the pixels
        // are final. (A draw follows every decode.)
        last.pending === 0 &&
        // And no tile waits for a sharper image (a decode of the original
        // for a large tile, held back while the user drags): every visible
        // tile is drawn from its final source. (Absent before #27.)
        (last.upgrading ?? 0) === 0 &&
        // The import is over: its one layout has been made.
        document.querySelector<HTMLElement>('.progress')!.hidden &&
        state.photos.length === included.length &&
        included.every((id) => state.photos.some((ph: any) => ph.id === id))
      );
    },
    undefined,
    { timeout, polling: 50 },
  );
}

/**
 * A hash of the canvas that does not depend on timing, for comparing two
 * drawings of the same arrangement. It waits until every tile is drawn from
 * its final source (waitDrawn), then redraws until two consecutive hashes
 * agree: Chrome scales an image drawn for the first time or two differently
 * (without mipmaps) from the same image drawn again, so the first frames
 * after an image arrives, or after it was last drawn long ago, can differ
 * in a few pixels from the settled ones.
 */
async function stableHash<T>(p: Page, hashOf: () => Promise<T>): Promise<T> {
  const redraws = 12;
  await waitDrawn(p);
  const seen: T[] = [await hashOf()];
  for (let i = 0; i < redraws; i++) {
    await p.evaluate(() => (window as any).__app.view.renderNow());
    await waitDrawn(p);
    const next = await hashOf();
    if (next === seen[seen.length - 1] && i >= 2) return next;
    seen.push(next);
  }
  // Never return an unconverged hash: two such comparisons could agree by
  // chance without the pixels ever having been stable.
  throw new Error(
    `canvas pixels did not converge after ${String(redraws)} redraws of a settled state; hashes seen: ${[...new Set(seen)].map(String).join(', ')}`,
  );
}

/** Sets the dial as a user would (fires `input` and `change`). */
async function setDial(p: Page, value: number): Promise<void> {
  await p.locator('#size-variation').fill(String(value));
}

/** The plan and assignment: what a re-roll replaces. */
function arrangementOf(p: Page): Promise<string> {
  return p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    return JSON.stringify({ plan: s.plan, assignment: s.assignment });
  });
}

interface DrawnStats {
  tiles: number;
  included: number;
  canvasW: number;
  canvasH: number;
  coverage: number;
  /** Coefficient of variation of tile areas. */
  areaCv: number;
  /** Largest tile's share of the canvas. */
  largestShare: number;
  /** Share of portrait photos (aspect < 0.95) in portrait tiles. */
  portraitInPortrait: number;
  portraits: number;
  /** Same for landscape photos (aspect > 1.05) in landscape tiles. */
  landscapeInLandscape: number;
  assignmentOk: boolean;
}

/** Measures what was last drawn. */
function drawnStats(p: Page): Promise<DrawnStats> {
  return p.evaluate(() => {
    const app = (window as any).__app;
    const { state, tiles } = app.view.lastRender();
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const areas = tiles.map((t: any) => t.width * t.height);
    const total = areas.reduce((a: number, b: number) => a + b, 0);
    const mean = total / areas.length;
    const sd = Math.sqrt(
      areas.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) /
        areas.length,
    );
    const aspect = new Map(
      state.photos.map((ph: any) => [ph.id, ph.aspect] as const),
    );
    let portraits = 0;
    let pInP = 0;
    let landscapes = 0;
    let lInL = 0;
    for (const t of tiles) {
      const a = aspect.get(state.assignment[t.slot]) as number;
      const tileAspect = t.width / t.height;
      if (a < 0.95) {
        portraits++;
        if (tileAspect < 1) pInP++;
      } else if (a > 1.05) {
        landscapes++;
        if (tileAspect > 1) lInL++;
      }
    }
    const ids = new Set(state.assignment);
    const included = app.store.getIncludedIds();
    return {
      tiles: tiles.length,
      included: included.length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      coverage: total / (canvas.width * canvas.height),
      areaCv: sd / mean,
      largestShare: Math.max(...areas) / (canvas.width * canvas.height),
      portraitInPortrait: portraits ? pInP / portraits : 1,
      portraits,
      landscapeInLandscape: landscapes ? lInL / landscapes : 1,
      assignmentOk:
        ids.size === included.length &&
        included.every((id: string) => ids.has(id)),
    };
  });
}

/** Counts canvas pixels close to the given colour. */
function countColour(p: Page, rgb: [number, number, number]): Promise<number> {
  return p.evaluate((rgb) => {
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const data = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - rgb[0]) < 12 &&
        Math.abs(data[i + 1]! - rgb[1]) < 12 &&
        Math.abs(data[i + 2]! - rgb[2]) < 12
      ) {
        n++;
      }
    }
    return n;
  }, rgb);
}

/** Applies a pure action from src/editor/state.ts through the editor. */
function editorAction(
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

async function checkEditor(p: Page): Promise<void> {
  const included = (): Promise<number> =>
    p.evaluate(() => (window as any).__app.store.getSelectedCount());
  const n = await included();
  await waitDrawn(p);
  let stats = await drawnStats(p);
  check(
    'collage shows one tile per included photo',
    stats.tiles === n && stats.assignmentOk,
    `${String(stats.tiles)} tiles, ${String(n)} included`,
  );
  check(
    'tiles cover the whole canvas (border 0)',
    Math.abs(stats.coverage - 1) < 1e-9,
    stats.coverage.toFixed(6),
  );

  // Pixels: with a magenta background and no border, no magenta shows.
  await editorAction(p, 'setBackground', '#ff00ff');
  await waitDrawn(p);
  const magenta = await countColour(p, [255, 0, 255]);
  check(
    'no background pixels show with border 0',
    magenta === 0,
    `${String(magenta)} px`,
  );
  // Control: with a border, the background does show (and nothing re-rolls).
  const before = await arrangementOf(p);
  await editorAction(p, 'setBorder', 0.011);
  await waitDrawn(p);
  const withBorder = await countColour(p, [255, 0, 255]);
  check(
    'control: with a border the background shows, without a re-roll',
    withBorder > 1000 && (await arrangementOf(p)) === before,
    `${String(withBorder)} px`,
  );
  await editorAction(p, 'setBorder', 0);
  await editorAction(p, 'setBackground', '#ffffff');

  // Photos fill their tiles (cover): no placeholder grey either.
  await waitDrawn(p);
  // The renderer's own count of tiles it could not draw a photo in.
  const missing = await p.evaluate(
    () => (window as any).__app.view.lastRender().missing as number,
  );
  check(
    'no placeholder tiles once images are decoded (the renderer reports 0 missing)',
    missing === 0,
    `${String(missing)} missing`,
  );

  // The canvas fits inside the main area with a margin.
  const fit = await p.evaluate(() => {
    const c = document
      .querySelector('.collage-canvas')!
      .getBoundingClientRect();
    const m = document.querySelector('.canvas-area')!.getBoundingClientRect();
    return {
      inside:
        c.left >= m.left + 20 &&
        c.right <= m.right - 20 &&
        c.top >= m.top + 20 &&
        c.bottom <= m.bottom - 20,
      ratio: c.width / c.height,
      centred:
        Math.abs(c.left - m.left - (m.right - c.right)) < 2 &&
        Math.abs(c.top - m.top - (m.bottom - c.bottom)) < 2,
    };
  });
  check(
    'canvas is centred in the main area, fitted with a margin, at 16:9',
    fit.inside && fit.centred && Math.abs(fit.ratio - 16 / 9) < 0.01,
    JSON.stringify(fit),
  );

  // Dial: minimum vs maximum.
  await setDial(p, 0);
  await waitDrawn(p);
  const atMin = await drawnStats(p);
  await setDial(p, 1);
  await waitDrawn(p);
  const atMax = await drawnStats(p);
  check(
    'dial: tile sizes go from uniform (min) to varied (max)',
    atMin.areaCv < 0.4 &&
      atMax.areaCv > 2 * atMin.areaCv &&
      atMax.largestShare > 3 * atMin.largestShare,
    `area CV ${atMin.areaCv.toFixed(2)} -> ${atMax.areaCv.toFixed(2)}, largest tile ${(atMin.largestShare * 100).toFixed(1)}% -> ${(atMax.largestShare * 100).toFixed(1)}% of canvas`,
  );
  check(
    'dial change commits (state variation follows the dial)',
    await p.evaluate(() => {
      const e = (window as any).__app.editor;
      return e.getState().variation === 1 && !e.isDragging();
    }),
  );

  // A real mouse drag across the dial, ending at some value: the committed
  // state is exactly what setting that value directly gives.
  const box = (await p.locator('#size-variation').boundingBox())!;
  const y = box.y + box.height / 2;
  await p.mouse.move(box.x + 2, y);
  await p.mouse.down();
  for (const f of [0.2, 0.9, 0.1, 0.75, 0.4, 0.62]) {
    await p.mouse.move(box.x + box.width * f, y, { steps: 6 });
  }
  await p.mouse.up();
  await waitDrawn(p);
  const dragged = await p.evaluate(async (module) => {
    const e = (window as any).__app.editor;
    const actions = await import(/* @vite-ignore */ module);
    const s = e.getState();
    const direct = actions.setVariation(
      actions.shuffle(s, s.seed), // the same inputs, re-derived
      s.variation,
    );
    return {
      v: s.variation,
      dragging: e.isDragging(),
      same:
        JSON.stringify({ p: s.plan, a: s.assignment }) ===
        JSON.stringify({ p: direct.plan, a: direct.assignment }),
    };
  }, STATE_MODULE);
  check(
    'mouse drag on the dial commits a state that depends only on the final value',
    dragged.same && !dragged.dragging && dragged.v > 0.4 && dragged.v < 0.8,
    `final ${String(dragged.v)}`,
  );

  // Keyboard: arrow keys move the dial and commit each step.
  await p.locator('#size-variation').focus();
  const v0 = await p.evaluate(
    () => (window as any).__app.editor.getState().variation,
  );
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await waitDrawn(p);
  const v1 = await p.evaluate(
    () => (window as any).__app.editor.getState().variation,
  );
  check(
    'dial is keyboard operable (two ArrowRight presses add 0.02)',
    Math.abs(v1 - v0 - 0.02) < 1e-9,
    `${String(v0)} -> ${String(v1)}`,
  );

  // Shuffle: a different arrangement each time.
  await setDial(p, 0.5);
  await waitDrawn(p);
  const seen = new Set([await arrangementOf(p)]);
  for (let i = 0; i < 4; i++) {
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await waitDrawn(p);
    seen.add(await arrangementOf(p));
  }
  stats = await drawnStats(p);
  check(
    'Shuffle produces a different arrangement each time (5 of 5 distinct)',
    seen.size === 5 && stats.tiles === n,
    `${String(seen.size)} distinct`,
  );

  // Portrait photos land in portrait tiles: an aggregate over fixed seeds, so
  // the result is the same on every run.
  {
    let portraits = 0;
    let hits = 0;
    let landscapes = 0;
    let landHits = 0;
    const weak: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      await editorAction(p, 'shuffle', seed);
      await waitDrawn(p);
      const st = await drawnStats(p);
      const h = Math.round(st.portraitInPortrait * st.portraits);
      portraits += st.portraits;
      hits += h;
      if (st.portraits && h / st.portraits < 0.5) {
        weak.push(`seed ${String(seed)}: ${String(h)}/${String(st.portraits)}`);
      }
      const l = Math.round(
        st.landscapeInLandscape *
          (await p.evaluate(
            () =>
              (window as any).__app.view
                .lastRender()
                .state.photos.filter((ph: any) => ph.aspect > 1.05).length,
          )),
      );
      landscapes += await p.evaluate(
        () =>
          (window as any).__app.view
            .lastRender()
            .state.photos.filter((ph: any) => ph.aspect > 1.05).length,
      );
      landHits += l;
    }
    check(
      'portrait photos mostly land in portrait tiles (synthetic set, seeds 1 to 20)',
      portraits > 0 && hits / portraits >= 0.8,
      `${String(hits)}/${String(portraits)} portraits = ${((100 * hits) / portraits).toFixed(0)}%; landscape in landscape ${String(landHits)}/${String(landscapes)}; weakest: ${weak.join('; ') || 'none under 50%'}`,
    );
    await editorAction(p, 'shuffle', 1);
    await waitDrawn(p);
  }

  // Toggling a photo in the tray re-rolls; toggling back restores it.
  const beforeToggle = await arrangementOf(p);
  await p.locator('.thumb').nth(3).click();
  await waitDrawn(p);
  stats = await drawnStats(p);
  const afterToggle = await arrangementOf(p);
  check(
    'excluding a photo in the tray re-rolls with one tile fewer',
    stats.tiles === n - 1 && stats.assignmentOk && afterToggle !== beforeToggle,
    `${String(stats.tiles)} tiles`,
  );
  await p.locator('.thumb').nth(3).click();
  await waitDrawn(p);
  check(
    're-including it re-rolls back to the same arrangement (same seed)',
    (await arrangementOf(p)) === beforeToggle,
  );

  // Hit-testing: the tile under the canvas centre holds an included photo.
  const hit = await p.evaluate(() => {
    const app = (window as any).__app;
    const r = document
      .querySelector('.collage-canvas')!
      .getBoundingClientRect();
    const h = app.view.tileAtClientPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    const miss = app.view.tileAtClientPoint(r.left - 5, r.top - 5);
    return {
      ok: h !== null && app.store.getIncludedIds().includes(h.photoId),
      miss: miss === null,
    };
  });
  check(
    'tileAtClientPoint finds the tile and photo under a point',
    hit.ok && hit.miss,
  );

  // All excluded: empty state; then all re-included.
  await p.getByRole('button', { name: 'Remove all' }).click();
  await p.waitForFunction(
    () => document.querySelector<HTMLCanvasElement>('.collage-canvas')!.hidden,
  );
  const empty = await p.evaluate(() => ({
    hint: document.querySelector<HTMLElement>('.canvas-hint')!.innerText,
    dial: document.querySelector<HTMLInputElement>('#size-variation')!.disabled,
    shuffle: [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Shuffle',
    )!.disabled,
  }));
  check(
    'all photos excluded: empty-state message, controls disabled',
    empty.hint.includes('No photos are included') &&
      empty.dial &&
      empty.shuffle,
    empty.hint,
  );
  await p.getByRole('button', { name: 'Add all to collage' }).click();
  await waitDrawn(p);
  stats = await drawnStats(p);
  check(
    're-including all photos brings the collage back',
    stats.tiles === n && stats.assignmentOk,
  );

  // Photos added while a layout is showing: re-rolls to include them.
  await p.setInputFiles('input[type=file]', join(fixtures, 'transparent.png'));
  await p.waitForFunction(
    (n) => (window as any).__app.editor.getState().photos.length === n + 1,
    n,
  );
  await waitDrawn(p);
  stats = await drawnStats(p);
  check(
    'adding a photo while a layout is showing adds a tile',
    stats.tiles === n + 1,
  );
  await p.evaluate(() => {
    const store = (window as any).__app.store;
    store.removePhotos([store.getPhotos().at(-1).id]);
  });
  await waitDrawn(p);
  check(
    'removing it from the store removes its tile',
    (await drawnStats(p)).tiles === n,
  );

  // Re-fit on window resize.
  const sizeBefore = await p.evaluate(
    () =>
      document.querySelector('.collage-canvas')!.getBoundingClientRect().width,
  );
  await p.setViewportSize({ width: 900, height: 700 });
  await p
    .waitForFunction(
      (w) =>
        document.querySelector('.collage-canvas')!.getBoundingClientRect()
          .width !== w,
      sizeBefore,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  await waitDrawn(p);
  const resized = await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    const m = document.querySelector('.canvas-area')!.getBoundingClientRect();
    return { width: r.width, fits: r.right <= m.right && r.bottom <= m.bottom };
  });
  check(
    'collage re-fits when the window is resized',
    resized.width < sizeBefore && resized.fits,
    `${sizeBefore.toFixed(0)} -> ${resized.width.toFixed(0)} px wide`,
  );
  await p.setViewportSize({ width: 1280, height: 800 });
  await waitDrawn(p);
}

/**
 * Contracts later issues rely on: one commit per dial gesture, restoring a
 * snapshot, toasts clear of the collage, decode failures shown.
 */
async function checkEditorContracts(p: Page): Promise<void> {
  await waitDrawn(p);
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_: unknown, change: any) => {
      if (!change.transient) w.__commits++;
    });
  });
  const commitsDuring = async (
    gesture: () => Promise<void>,
  ): Promise<number> => {
    await p.evaluate(() => {
      (window as any).__commits = 0;
    });
    await gesture();
    await p.waitForTimeout(100);
    await waitDrawn(p);
    return p.evaluate(() => (window as any).__commits);
  };
  const dial = p.locator('#size-variation');
  const box = (await dial.boundingBox())!;
  const y = box.y + box.height / 2;
  const at = (f: number): number => box.x + 8 + (box.width - 16) * f;

  const drag = await commitsDuring(async () => {
    await p.mouse.move(at(0.5), y);
    await p.mouse.down();
    for (const f of [0.6, 0.8, 0.3, 0.9, 0.7]) {
      await p.mouse.move(at(f), y, { steps: 5 });
    }
    await p.mouse.up();
  });
  check(
    'a mouse drag on the dial commits exactly once',
    drag === 1,
    `${String(drag)} commits`,
  );

  const click = await commitsDuring(async () => {
    await p.mouse.click(at(0.2), y);
  });
  check(
    'a click that moves the dial commits exactly once',
    click === 1,
    `${String(click)} commits`,
  );

  const sameClick = await commitsDuring(async () => {
    await p.mouse.click(at(0.2), y);
  });
  check(
    'a click on the current value commits nothing',
    sameClick === 0,
    `${String(sameClick)} commits`,
  );

  const keys = await commitsDuring(async () => {
    await dial.focus();
    for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
  });
  check(
    'three arrow-key presses commit three times',
    keys === 3,
    `${String(keys)} commits`,
  );

  const escaped = await commitsDuring(async () => {
    await p.mouse.move(at(0.3), y);
    await p.mouse.down();
    await p.mouse.move(at(0.6), y, { steps: 5 });
    await p.keyboard.press('Escape');
    await p.mouse.move(at(0.8), y, { steps: 5 });
    await p.mouse.up();
  });
  check(
    'Escape mid-drag: the drag carries on and commits exactly once',
    escaped === 1,
    `${String(escaped)} commits`,
  );

  const cancelled = await commitsDuring(async () => {
    await p.mouse.move(at(0.4), y);
    await p.mouse.down();
    await p.mouse.move(at(0.75), y, { steps: 5 });
    await p.waitForTimeout(50);
    // The browser takes the pointer away (for example a system gesture).
    await dial.dispatchEvent('pointercancel');
    await p.evaluate(() => {
      document.querySelector<HTMLInputElement>('#size-variation')!.blur();
    });
    await p.mouse.up();
  });
  const settled = await p.evaluate(
    () => !(window as any).__app.editor.isDragging(),
  );
  check(
    'a cancelled drag resolves to one committed state',
    cancelled === 1 && settled,
    `${String(cancelled)} commits`,
  );

  // Swap survives committing the dial at its current value.
  const swapKept = await p.evaluate(() => {
    const e = (window as any).__app.editor;
    e.dispatch((s: any) => {
      const a = [...s.assignment];
      [a[0], a[1]] = [a[1], a[0]];
      return { ...s, assignment: a };
    });
    const swapped = e.getState();
    e.commitVariation(swapped.variation);
    return e.getState() === swapped;
  });
  check(
    'committing the dial at its current value keeps a manual swap',
    swapKept,
  );

  // Restore: a snapshot with a different included set comes back intact,
  // and the tray follows it.
  await waitDrawn(p);
  const snapshot = await p.evaluate(() => {
    const w = window as any;
    w.__snapshot = w.__app.editor.getState();
    return JSON.stringify(w.__snapshot);
  });
  await p.locator('.thumb').nth(2).click();
  await p.locator('.thumb').nth(5).click();
  await waitDrawn(p);
  await p.evaluate(() => {
    const w = window as any;
    w.__app.editor.restore(w.__snapshot);
  });
  await p.waitForTimeout(100);
  await waitDrawn(p);
  const restored = await p.evaluate(() => {
    const w = window as any;
    const s = w.__app.editor.getState();
    const included = w.__app.store.getIncludedIds().sort();
    const ids = s.photos.map((ph: any) => ph.id).sort();
    return {
      same: s === w.__snapshot,
      tray:
        JSON.stringify(included) === JSON.stringify(ids) &&
        document.querySelectorAll('.thumb[aria-pressed=true]').length ===
          ids.length,
    };
  });
  check(
    'restore puts back a snapshot (with its swap) and the tray follows, without a re-roll',
    restored.same &&
      restored.tray &&
      (await p.evaluate(() =>
        JSON.stringify((window as any).__app.editor.getState()),
      )) === snapshot,
  );

  // Toasts sit clear of the collage.
  await p.setInputFiles('input[type=file]', join(fixtures, 'landscape.jpg'));
  await p.waitForSelector('.notice');
  const overlap = await p.evaluate(() => {
    const c = document
      .querySelector('.collage-canvas')!
      .getBoundingClientRect();
    return [...document.querySelectorAll('.notice')].some((n) => {
      const r = n.getBoundingClientRect();
      return !(
        r.right <= c.left ||
        r.left >= c.right ||
        r.bottom <= c.top ||
        r.top >= c.bottom
      );
    });
  });
  check('notices do not cover the collage', !overlap);
  while ((await p.locator('.notice button').count()) > 0) {
    await p.locator('.notice button').first().click();
  }

  // A photo whose images cannot be decoded: an error tile and one notice.
  await p.evaluate(() => {
    const store = (window as any).__app.store;
    const junk = new Blob(['not a jpeg'], { type: 'image/jpeg' });
    store.addPhotos([
      {
        file: new File(['x'], 'broken.jpg', { type: 'image/jpeg' }),
        width: 400,
        height: 300,
        preview: junk,
        thumbnail: junk,
      },
    ]);
  });
  await p.waitForFunction(
    () => {
      const last = (window as any).__app.view.lastRender();
      return (
        document.querySelector('.notice')?.textContent.includes('broken.jpg') &&
        last?.missing === 1
      );
    },
    undefined,
    { timeout: 10000 },
  );
  const errorPixels = await countColour(p, [0x6b, 0x2a, 0x33]);
  const notices = await p.locator('.notice').count();
  check(
    'an undecodable photo shows an error tile and one notice',
    errorPixels > 100 && notices === 1,
    `${String(errorPixels)} error px, ${String(notices)} notice(s)`,
  );
  await p.evaluate(() => {
    const store = (window as any).__app.store;
    store.removePhotos([store.getPhotos().at(-1).id]);
  });
  while ((await p.locator('.notice button').count()) > 0) {
    await p.locator('.notice button').first().click();
  }
  await waitDrawn(p);

  // DPI change at a fixed paper size keeps the layout (#7).
  const dpi = await p.evaluate(async (module) => {
    const actions = await import(/* @vite-ignore */ module);
    const e = (window as any).__app.editor;
    const before = e.getState();
    e.dispatch((s: any) => actions.setCanvasSize(s, 3508, 2480));
    const a4At300 = e.getState();
    e.dispatch((s: any) => actions.setCanvasSize(s, 2339, 1654));
    const kept = e.getState().plan === a4At300.plan;
    e.restore(before);
    return kept;
  }, STATE_MODULE);
  check('A4 at 300 dpi to 200 dpi keeps the layout', dpi);
  await waitDrawn(p);
}

// --- Canvas settings and page layout (issue #6) -------------------------------

/** What the collage got at 1280 x 800 on master before #6 (46 photos). */
const BEFORE_COLLAGE = { width: 694, height: 390 };

const SETTINGS_MODULE = '/src/editor/canvas-settings.ts';

interface CanvasInfo {
  width: number;
  height: number;
  border: number;
  background: string;
  aspect: number;
}

function canvasInfo(p: Page): Promise<CanvasInfo> {
  return p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    return {
      width: s.canvas.width,
      height: s.canvas.height,
      border: s.canvas.borderFraction,
      background: s.canvas.background,
      aspect: s.plan.aspect,
    };
  });
}

/** Which tile holds which photo: what a border change must not alter. */
function tilePhotos(p: Page): Promise<string> {
  return p.evaluate(() => {
    const { state, tiles } = (window as any).__app.view.lastRender();
    return JSON.stringify(
      tiles.map((t: any) => [t.slot, state.assignment[t.slot]]),
    );
  });
}

/** The output size readout in the top bar: visible and its text. */
async function readout(p: Page): Promise<{ visible: boolean; text: string }> {
  const el = p.locator('.topbar .size-readout');
  return {
    visible: await el.isVisible(),
    text: (await el.innerText()).replace(/^Output size:\s*/, '').trim(),
  };
}

/**
 * Samples the drawn canvas: the margin in pixels (the leftmost tile's x),
 * whether the pixel in the middle of the margin and of a gap between two
 * horizontal neighbours has the background colour, and how many pixels have
 * it against how many the gaps and margin should cover.
 */
function borderPixels(
  p: Page,
  rgb: [number, number, number],
): Promise<{
  margin: number;
  marginIsBg: boolean;
  gap: number;
  gapIsBg: boolean | null;
  photoNextToMarginIsBg: boolean;
  bgPixels: number;
  expectedPixels: number;
}> {
  return p.evaluate((rgb) => {
    const { tiles } = (window as any).__app.view.lastRender();
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const ctx = canvas.getContext('2d')!;
    const isBg = (x: number, y: number): boolean => {
      const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return (
        Math.abs(d[0]! - rgb[0]) < 12 &&
        Math.abs(d[1]! - rgb[1]) < 12 &&
        Math.abs(d[2]! - rgb[2]) < 12
      );
    };
    const margin = Math.min(...tiles.map((t: any) => t.x));
    const left = tiles.find((t: any) => t.x === margin);
    // The narrowest gap between two tiles side by side: the border.
    let gap = 0;
    let gapIsBg: boolean | null = null;
    for (const a of tiles) {
      for (const b of tiles) {
        const g = b.x - (a.x + a.width);
        const overlap =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (g > 0 && overlap > 4 && (gap === 0 || g < gap)) {
          gap = g;
          const y = Math.max(a.y, b.y) + overlap / 2;
          gapIsBg = isBg(a.x + a.width + g / 2, y);
        }
      }
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let bgPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i]! - rgb[0]) < 12 &&
        Math.abs(data[i + 1]! - rgb[1]) < 12 &&
        Math.abs(data[i + 2]! - rgb[2]) < 12
      ) {
        bgPixels++;
      }
    }
    const tileArea = tiles.reduce(
      (n: number, t: any) => n + t.width * t.height,
      0,
    );
    return {
      margin,
      marginIsBg: margin > 0 ? isBg(margin / 2, canvas.height / 2) : false,
      gap,
      gapIsBg,
      photoNextToMarginIsBg: isBg(margin + 2, left.y + left.height / 2),
      bgPixels,
      expectedPixels: canvas.width * canvas.height - tileArea,
    };
  }, rgb);
}

async function checkLayout(p: Page): Promise<void> {
  await p.setViewportSize({ width: 1280, height: 800 });
  await waitDrawn(p);
  const size = await p.evaluate(() => {
    const r = document
      .querySelector('.collage-canvas')!
      .getBoundingClientRect();
    const tray = document.querySelector('.tray')!.getBoundingClientRect();
    return { width: r.width, height: r.height, tray: tray.height };
  });
  console.log(
    `  collage at 1280 x 800: ${size.width.toFixed(0)} x ${size.height.toFixed(0)} px (before: ${String(BEFORE_COLLAGE.width)} x ${String(BEFORE_COLLAGE.height)}); tray ${size.tray.toFixed(0)} px tall`,
  );
  check(
    'the collage is larger than before at 1280 x 800 (more than 1.3x each way)',
    size.width > 1.3 * BEFORE_COLLAGE.width &&
      size.height > 1.3 * BEFORE_COLLAGE.height,
    `${size.width.toFixed(0)} x ${size.height.toFixed(0)}`,
  );

  // The tray: collapsed is one scrolling row, expanded shows every photo.
  const rows = (): Promise<number> =>
    p.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll('.tray-grid li')].map((li) =>
            Math.round(li.getBoundingClientRect().top),
          ),
        ).size,
    );
  const toggle = p.getByRole('button', { name: /^Show (all|one row)$/ });
  check(
    'the tray starts collapsed: one row of thumbnails that scrolls sideways',
    (await toggle.getAttribute('aria-expanded')) === 'false' &&
      (await rows()) === 1 &&
      (await p.evaluate(() => {
        const g = document.querySelector('.tray-grid')!;
        return g.scrollWidth > g.clientWidth;
      })),
  );
  await toggle.click();
  const open = await p.evaluate(() => {
    const grid = document.querySelector('.tray-grid')!;
    const lis = [...grid.querySelectorAll('li')];
    return {
      expanded: document
        .querySelector('.tray-expand')!
        .getAttribute('aria-expanded'),
      wide: grid.scrollWidth <= grid.clientWidth,
      tops: new Set(lis.map((li) => Math.round(li.getBoundingClientRect().top)))
        .size,
    };
  });
  await waitDrawn(p);
  check(
    'expanding the tray wraps the thumbnails into a grid showing every photo',
    open.expanded === 'true' && open.wide && open.tops > 1,
    JSON.stringify(open),
  );
  check(
    'the tray toolbar (count, Add all, Remove all) works while expanded',
    (await trayCount(p)).endsWith('selected') &&
      (await p.getByRole('button', { name: 'Remove all' }).isEnabled()) &&
      (await p
        .getByRole('button', { name: 'Add all to collage' })
        .isDisabled()),
  );
  await toggle.click();
  check(
    'collapsing returns the tray to one row',
    (await rows()) === 1 &&
      (await toggle.getAttribute('aria-expanded')) === 'false',
  );
  await waitDrawn(p);

  // Keyboard: the settings panel comes before the tray in tab order, and the
  // thumbnails are one tab stop with arrow-key movement.
  const order = await p.evaluate(() => {
    const panel = document.querySelector('.settings')!;
    const tray = document.querySelector('.tray')!;
    const stops = [
      ...document.querySelectorAll<HTMLElement>('button, input, a[href]'),
    ].filter((el) => el.tabIndex >= 0 && !el.hidden);
    const inTray = stops.filter(
      (el) => tray.contains(el) && el.closest('.tray-grid'),
    );
    return {
      panelFirst: !!(
        panel.compareDocumentPosition(tray) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      thumbStops: inTray.length,
    };
  });
  check(
    'tab order: the settings panel comes before the tray, and the thumbnails are a single tab stop',
    order.panelFirst && order.thumbStops === 1,
    JSON.stringify(order),
  );
  const included = (): Promise<number> =>
    p.evaluate(() => (window as any).__app.store.getSelectedCount());
  await p.locator('.thumb[tabindex="0"]').focus();
  const firstName = await p.evaluate(() =>
    document.activeElement?.getAttribute('aria-label'),
  );
  await p.keyboard.press('ArrowRight');
  const secondName = await p.evaluate(() =>
    document.activeElement?.getAttribute('aria-label'),
  );
  const stopsAfter = await p.locator('.thumb[tabindex="0"]').count();
  const before = await included();
  await p.keyboard.press('Space');
  await waitDrawn(p);
  const afterSpace = await included();
  await p.keyboard.press('Enter');
  await waitDrawn(p);
  const afterEnter = await included();
  await p.keyboard.press('End');
  const lastIsActive = await p.evaluate(() => {
    const all = [...document.querySelectorAll('.thumb')];
    return document.activeElement === all.at(-1);
  });
  await p.keyboard.press('Home');
  const homeFirst = await p.evaluate(
    () => document.activeElement === document.querySelector('.thumb'),
  );
  check(
    'thumbnails: ArrowRight moves focus (still one tab stop), Space and Enter toggle, End and Home jump',
    firstName !== secondName &&
      stopsAfter === 1 &&
      afterSpace === before - 1 &&
      afterEnter === before &&
      lastIsActive &&
      homeFirst,
    `${String(firstName)} -> ${String(secondName)}, ${String(before)} -> ${String(afterSpace)} -> ${String(afterEnter)}`,
  );
  // Expanded: ArrowDown moves to the next row.
  await toggle.click();
  await p.locator('.thumb').first().focus();
  await p.keyboard.press('ArrowDown');
  const down = await p.evaluate(() => {
    const a = document.activeElement!.getBoundingClientRect();
    const first = document.querySelector('.thumb')!.getBoundingClientRect();
    return a.top > first.top;
  });
  check('expanded tray: ArrowDown moves to the next row', down);
  await toggle.click();
  await waitDrawn(p);
}

const trayCount = (p: Page): Promise<string> =>
  p.locator('.tray-count').innerText();

async function checkCanvasSettings(p: Page): Promise<void> {
  await waitDrawn(p);
  const n = await p.evaluate(() =>
    (window as any).__app.store.getSelectedCount(),
  );
  await p.evaluate(() => {
    const w = window as any;
    w.__settingsCommits = 0;
    w.__settingsSteps = 0;
    w.__app.editor.subscribe((_: unknown, change: any) => {
      if (change.transient) w.__settingsSteps++;
      else w.__settingsCommits++;
    });
  });
  const commitsDuring = async (
    gesture: () => Promise<void>,
  ): Promise<{ commits: number; steps: number }> => {
    await p.evaluate(() => {
      (window as any).__settingsCommits = 0;
      (window as any).__settingsSteps = 0;
    });
    await gesture();
    await p.waitForTimeout(100);
    await waitDrawn(p);
    return p.evaluate(() => ({
      commits: (window as any).__settingsCommits as number,
      steps: (window as any).__settingsSteps as number,
    }));
  };

  // The panel is always there, with every control labelled.
  const labelled = await p.evaluate(() => {
    const names = ['size-width', 'size-height', 'border', 'background-colour'];
    return names.every((id) => {
      const el = document.getElementById(id);
      return el !== null && document.querySelector(`label[for=${id}]`) !== null;
    });
  });
  check('the size, border and colour controls all have labels', labelled);

  // 1. Ratio presets.
  const presets = await p.evaluate(async (module) => {
    const m = await import(/* @vite-ignore */ module);
    return m.RATIO_PRESETS.map((x: any) => ({
      label: x.label,
      size: m.presetSize(x),
    }));
  }, SETTINGS_MODULE);
  check(
    'there are 11 preset buttons, one per ratio of the spec',
    (await p.locator('.preset').count()) === 11 && presets.length === 11,
  );
  let before = await arrangementOf(p);
  const problems: string[] = [];
  let rerolled = 0;
  for (const preset of presets) {
    await p
      .locator('.preset', { hasText: new RegExp(`^${preset.label}$`) })
      .click();
    await waitDrawn(p);
    const info = await canvasInfo(p);
    const stats = await drawnStats(p);
    const shown = await readout(p);
    const pressed = await p.evaluate(() =>
      [...document.querySelectorAll('.preset[aria-pressed=true]')].map(
        (b) => b.textContent,
      ),
    );
    const [rw, rh] = preset.label.split(':').map(Number) as [number, number];
    const after = await arrangementOf(p);
    if (after !== before) rerolled++;
    before = after;
    if (info.width !== preset.size.width || info.height !== preset.size.height)
      problems.push(
        `${preset.label}: canvas ${String(info.width)}x${String(info.height)}`,
      );
    if (Math.abs(info.aspect / (rw / rh) - 1) > 0.001)
      problems.push(`${preset.label}: plan aspect ${info.aspect.toFixed(4)}`);
    if (Math.abs(stats.canvasW / stats.canvasH - rw / rh) > 0.01)
      problems.push(
        `${preset.label}: drawn ratio ${(stats.canvasW / stats.canvasH).toFixed(3)}`,
      );
    if (
      stats.tiles !== n ||
      Math.abs(stats.coverage - 1) > 1e-9 ||
      !stats.assignmentOk
    )
      problems.push(
        `${preset.label}: ${String(stats.tiles)} tiles, coverage ${stats.coverage.toFixed(4)}`,
      );
    if (
      !shown.visible ||
      shown.text !==
        `${String(preset.size.width)} × ${String(preset.size.height)} px`
    )
      problems.push(`${preset.label}: readout ${shown.text}`);
    if (pressed.length !== 1 || pressed[0] !== preset.label)
      problems.push(`${preset.label}: pressed ${pressed.join(',')}`);
    const fields = await p.evaluate(() => [
      document.querySelector<HTMLInputElement>('#size-width')!.value,
      document.querySelector<HTMLInputElement>('#size-height')!.value,
    ]);
    if (
      fields[0] !== String(preset.size.width) ||
      fields[1] !== String(preset.size.height)
    )
      problems.push(`${preset.label}: fields ${fields.join('x')}`);
  }
  check(
    'each ratio preset resizes the canvas, re-lays out the mosaic, shows as pressed and updates the readout and fields',
    problems.length === 0,
    problems.join('; '),
  );
  check(
    'moving between presets re-rolled the arrangement every time the ratio changed',
    rerolled === presets.length,
    `${String(rerolled)} of ${String(presets.length)}`,
  );
  console.log(
    `  presets: ${presets.map((x: any) => `${x.label} ${String(x.size.width)}x${String(x.size.height)}`).join(', ')}`,
  );

  // 2. Custom size. Start from 16:9.
  await p.locator('.preset', { hasText: /^16:9$/ }).click();
  await waitDrawn(p);
  const width = p.locator('#size-width');
  const height = p.locator('#size-height');
  const lock = p.getByLabel('Lock aspect ratio');
  check('the aspect lock is on by default', await lock.isChecked());
  const arr0 = await arrangementOf(p);

  // Typing alone commits nothing; Enter does.
  const typed = await commitsDuring(async () => {
    await width.fill('');
    await width.pressSequentially('960', { delay: 20 });
  });
  const midState = await canvasInfo(p);
  check(
    'typing a size does not commit on every keystroke',
    typed.commits === 0 && midState.width === 1920,
    `${String(typed.commits)} commits, width ${String(midState.width)}`,
  );
  const enter = await commitsDuring(async () => {
    await width.press('Enter');
  });
  let info = await canvasInfo(p);
  check(
    'lock on: Enter commits the width and the height follows (960 x 540), one commit',
    info.width === 960 && info.height === 540 && enter.commits === 1,
    `${String(info.width)} x ${String(info.height)}, ${String(enter.commits)} commits`,
  );
  check(
    'lock on: the new size is shown in the fields and the top-bar readout, and the arrangement is kept',
    (await height.inputValue()) === '540' &&
      (await readout(p)).text === '960 × 540 px' &&
      (await arrangementOf(p)) === arr0,
  );
  await height.fill('270');
  await height.press('Tab'); // blur commits
  await waitDrawn(p);
  info = await canvasInfo(p);
  check(
    'lock on: blur commits the height and the width follows (480 x 270), same arrangement',
    info.width === 480 &&
      info.height === 270 &&
      (await arrangementOf(p)) === arr0,
    `${String(info.width)} x ${String(info.height)}`,
  );
  check(
    'a custom 16:9 size keeps the 16:9 preset highlighted',
    (await p.locator('.preset[aria-pressed=true]').innerText()) === '16:9',
  );
  await width.fill('7');
  await width.press('Enter');
  await waitDrawn(p);
  info = await canvasInfo(p);
  check(
    'lock on: a locked edit rounds the other side to a whole pixel (7 x 4)',
    info.width === 7 && info.height === 4,
    `${String(info.width)} x ${String(info.height)}`,
  );
  await width.fill('1920');
  await width.press('Enter');
  await waitDrawn(p);

  // Lock off: one side changes alone and the ratio change re-rolls.
  await lock.uncheck();
  await width.fill('1000');
  await width.press('Enter');
  await waitDrawn(p);
  info = await canvasInfo(p);
  const free = await arrangementOf(p);
  const none = await p.locator('.preset[aria-pressed=true]').count();
  check(
    'lock off: only the width changes, the ratio changes, the arrangement re-rolls, no preset is active',
    info.width === 1000 && info.height === 1080 && free !== arr0 && none === 0,
    `${String(info.width)} x ${String(info.height)}, ${String(none)} presets pressed`,
  );
  await height.fill('2000');
  await height.press('Enter');
  await waitDrawn(p);
  info = await canvasInfo(p);
  check(
    'lock off: the height changes alone',
    info.width === 1000 && info.height === 2000,
    `${String(info.width)} x ${String(info.height)}`,
  );
  // Turning the lock back on keeps the ratio of the size at that moment.
  await lock.check();
  await width.fill('500');
  await width.press('Enter');
  await waitDrawn(p);
  info = await canvasInfo(p);
  check(
    'turning the lock on keeps the current ratio (1000 x 2000 -> 500 x 1000)',
    info.width === 500 && info.height === 1000,
    `${String(info.width)} x ${String(info.height)}`,
  );

  // Bad input: a clear message, nothing applied, never an invalid state.
  const sizeBefore = await canvasInfo(p);
  const message = p.locator('#size-message');
  const bad: [string, string, RegExp][] = [
    ['width', 'abc', /whole number/],
    ['width', '12.5', /whole number/],
    ['width', '0', /at least 1/],
    ['height', '20001', /at most 20000/],
    ['width', '', /empty/],
    ['height', '-3', /whole number/],
  ];
  const badProblems: string[] = [];
  for (const [side, text, pattern] of bad) {
    const field = side === 'width' ? width : height;
    const c = await commitsDuring(async () => {
      await field.fill(text);
      await field.press('Enter');
    });
    const msg = (await message.isVisible()) ? await message.innerText() : '';
    const now = await canvasInfo(p);
    if (
      !pattern.test(msg) ||
      c.commits !== 0 ||
      now.width !== sizeBefore.width ||
      now.height !== sizeBefore.height ||
      (await field.getAttribute('aria-invalid')) !== 'true'
    )
      badProblems.push(
        `${side} ${JSON.stringify(text)}: ${msg || 'no message'}, ${String(c.commits)} commits`,
      );
    await field.press('Escape');
    if (
      (await message.isVisible()) ||
      (await field.inputValue()) !==
        String(side === 'width' ? sizeBefore.width : sizeBefore.height)
    )
      badProblems.push(`${side}: Escape did not restore`);
  }
  check(
    'bad sizes (text, decimals, 0, over 20000, empty, negative) show an inline message and apply nothing; Escape restores',
    badProblems.length === 0,
    badProblems.join('; '),
  );
  // A locked edit that pushes the other side out of range.
  await height.fill('10000');
  await height.press('Enter');
  await waitDrawn(p);
  await width.fill('15000');
  await width.press('Enter');
  const outOfRange = await canvasInfo(p);
  check(
    'lock on: an edit that would push the other side past 20000 px is rejected with a message',
    (await message.innerText()).includes('outside 1 to 20000') &&
      outOfRange.width === 5000 &&
      outOfRange.height === 10000,
    `${String(outOfRange.width)} x ${String(outOfRange.height)}`,
  );
  await width.press('Escape');
  const setSize = async (w: number, h: number): Promise<void> => {
    await lock.uncheck();
    await width.fill(String(w));
    await width.press('Enter');
    await height.fill(String(h));
    await height.press('Enter');
    await lock.check();
    await waitDrawn(p);
  };
  await setSize(1920, 1080);
  check(
    'the largest sizes work: 20000 x 20000 unlocked',
    await (async () => {
      await lock.uncheck();
      await width.fill('20000');
      await width.press('Enter');
      await height.fill('20000');
      await height.press('Enter');
      await waitDrawn(p);
      const big = await canvasInfo(p);
      const fine = big.width === 20000 && big.height === 20000;
      await setSize(1920, 1080);
      return fine;
    })(),
  );

  // Presets keep the current long side (the resolution), and the active
  // preset does nothing.
  await setSize(3840, 2160);
  const keep = await commitsDuring(async () => {
    await p.locator('.preset', { hasText: /^1:1$/ }).click();
  });
  const square = await canvasInfo(p);
  const noop = await commitsDuring(async () => {
    await p.locator('.preset', { hasText: /^1:1$/ }).click();
  });
  await p.locator('.preset', { hasText: /^9:16$/ }).click();
  await waitDrawn(p);
  const tall = await canvasInfo(p);
  check(
    'presets keep the long side: from 3840 x 2160, 1:1 gives 3840 x 3840 and 9:16 gives 2160 x 3840; the active preset does nothing',
    square.width === 3840 &&
      square.height === 3840 &&
      keep.commits === 1 &&
      noop.commits === 0 &&
      tall.width === 2160 &&
      tall.height === 3840,
    `${String(square.width)}x${String(square.height)}, ${String(noop.commits)} commits on the active preset, ${String(tall.width)}x${String(tall.height)}`,
  );
  await setSize(1920, 1080);

  // The lock at 5:7 keeps the exact ratio.
  await p.locator('.preset', { hasText: /^5:7$/ }).click();
  await waitDrawn(p);
  await height.fill('7000');
  await height.press('Enter');
  await waitDrawn(p);
  const fiveSeven = await canvasInfo(p);
  check(
    'lock at 5:7: height 7000 gives width 5000 (the exact ratio)',
    fiveSeven.width === 5000 && fiveSeven.height === 7000,
    `${String(fiveSeven.width)} x ${String(fiveSeven.height)}`,
  );
  await setSize(1920, 1080);

  // An error in one field survives committing the other.
  await lock.uncheck();
  await width.fill('abc');
  await width.press('Enter');
  await height.fill('1000');
  await height.press('Enter');
  await waitDrawn(p);
  const kept = await canvasInfo(p);
  check(
    "committing one size field keeps the other field's invalid text and its error",
    kept.height === 1000 &&
      kept.width === 1920 &&
      (await width.inputValue()) === 'abc' &&
      (await width.getAttribute('aria-invalid')) === 'true' &&
      (await message.innerText()).includes('Width'),
  );
  await width.press('Escape');
  check(
    "Escape clears that field's error and restores it",
    (await width.inputValue()) === '1920' &&
      (await message.isHidden()) &&
      (await height.inputValue()) === '1000',
  );
  await lock.check();
  await setSize(1920, 1080);

  // 3. Readout always visible: with the tray expanded, scrolled, at 900 px.
  const visibleEverywhere: boolean[] = [];
  await p.getByRole('button', { name: 'Show all' }).click();
  visibleEverywhere.push((await readout(p)).visible);
  await p.getByRole('button', { name: 'Show one row' }).click();
  await p.setViewportSize({ width: 1000, height: 600 });
  visibleEverywhere.push((await readout(p)).visible);
  await p.setViewportSize({ width: 1280, height: 800 });
  await waitDrawn(p);
  check(
    'the pixel size is visible in the top bar with the tray open, and in a smaller window',
    visibleEverywhere.every(Boolean) &&
      (await readout(p)).text === '1920 × 1080 px',
    JSON.stringify(visibleEverywhere),
  );

  // 4. Border.
  const slider = p.locator('#border');
  await editorAction(p, 'setBackground', '#ff00ff');
  await waitDrawn(p);
  // The slider has a fixed 0 to 10% scale. Re-roll until this arrangement
  // can draw at least 4%, so the drags below are not limited.
  for (let i = 0; i < 40; i++) {
    const avail = await p.evaluate(async (module) => {
      const m = await import(/* @vite-ignore */ module);
      return m.borderRange((window as any).__app.editor.getState())
        .available as number;
    }, SETTINGS_MODULE);
    if (avail >= 0.04) break;
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await waitDrawn(p);
  }
  const arrB = await arrangementOf(p);
  const tilesB = await tilePhotos(p);
  const noBorder = await borderPixels(p, [255, 0, 255]);
  check(
    'border 0: no background shows',
    noBorder.margin === 0 && noBorder.bgPixels === 0,
    `${String(noBorder.bgPixels)} px`,
  );
  const sbox = (await slider.boundingBox())!;
  const sy = sbox.y + sbox.height / 2;
  const sat = (f: number): number => sbox.x + 8 + (sbox.width - 16) * f;
  const dragBorder = await commitsDuring(async () => {
    await p.mouse.move(sat(0), sy);
    await p.mouse.down();
    for (const f of [0.1, 0.2, 0.3, 0.2, 0.25]) {
      await p.mouse.move(sat(f), sy, { steps: 5 });
    }
    await p.mouse.up();
  });
  const dragged = await canvasInfo(p);
  check(
    'a mouse drag on the border slider commits exactly once, after transient steps',
    dragBorder.commits === 1 && dragBorder.steps >= 2 && dragged.border > 0,
    `${String(dragBorder.commits)} commits, ${String(dragBorder.steps)} steps, border ${String(dragged.border)}`,
  );
  const withBorder = await borderPixels(p, [255, 0, 255]);
  check(
    'the border slider changes the outer margin and the gaps (checked in pixels)',
    withBorder.margin > 0 &&
      withBorder.marginIsBg &&
      withBorder.gap === withBorder.margin &&
      withBorder.gapIsBg === true &&
      !withBorder.photoNextToMarginIsBg,
    JSON.stringify(withBorder),
  );
  check(
    'the border does not change the arrangement or which photo is in which tile',
    (await arrangementOf(p)) === arrB && (await tilePhotos(p)) === tilesB,
  );
  const readBorder = await p.locator('output[for=border]').innerText();
  check(
    'the border readout shows percent and pixels',
    /^\d+\.\d% \(\d+ px\)$/.test(readBorder),
    readBorder,
  );

  // Further drag to a larger border: margin grows.
  const bigger = await commitsDuring(async () => {
    await p.mouse.move(sat(0.25), sy);
    await p.mouse.down();
    await p.mouse.move(sat(0.38), sy, { steps: 8 });
    await p.mouse.up();
  });
  const wide = await borderPixels(p, [255, 0, 255]);
  check(
    'dragging further right widens the margin and gaps; one commit',
    wide.margin > withBorder.margin && bigger.commits === 1,
    `${String(withBorder.margin)} -> ${String(wide.margin)} px, ${String(bigger.commits)} commit(s)`,
  );
  const clickSame = await commitsDuring(async () => {
    await slider.focus();
    await slider.blur();
  });
  check('tabbing through the slider commits nothing', clickSame.commits === 0);
  const cancelled = await commitsDuring(async () => {
    await p.mouse.move(sat(0.38), sy);
    await p.mouse.down();
    await p.mouse.move(sat(0.1), sy, { steps: 5 });
    await slider.dispatchEvent('pointercancel');
    await p.evaluate(() => {
      document.querySelector<HTMLInputElement>('#border')!.blur();
    });
    await p.mouse.up();
  });
  check(
    'a cancelled border drag resolves to one committed state',
    cancelled.commits === 1 &&
      !(await p.evaluate(() => (window as any).__app.editor.isDragging())),
    `${String(cancelled.commits)} commits`,
  );
  const keys = await commitsDuring(async () => {
    await slider.focus();
    for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowRight');
  });
  check(
    'the border slider is keyboard operable: three ArrowRight presses commit three times',
    keys.commits === 3,
    `${String(keys.commits)} commits`,
  );
  await slider.press('Home');
  await waitDrawn(p);
  check(
    'Home sets the border to 0 again',
    (await canvasInfo(p)).border === 0 &&
      (await borderPixels(p, [255, 0, 255])).bgPixels === 0,
  );

  // The slider's scale is fixed (0 to 10%): the thumb shows the request and
  // never moves on a re-roll; only the shaded unavailable part changes.
  await editorAction(p, 'setBorder', 0.25);
  await waitDrawn(p);
  const avails: string[] = [];
  const rangeProblems: string[] = [];
  for (let i = 0; i < 8; i++) {
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await waitDrawn(p);
    const r = await p.evaluate(async (module) => {
      const m = await import(/* @vite-ignore */ module);
      const e = (window as any).__app.editor.getState();
      const el = document.querySelector<HTMLInputElement>('#border')!;
      const range = m.borderRange(e);
      const note = document.querySelector<HTMLElement>('#border-note')!;
      return {
        sliderMax: Number(el.max),
        sliderValue: Number(el.value),
        avail: el.style.getPropertyValue('--available'),
        expectAvail: Math.min(1, range.available / range.scale),
        requested: e.canvas.borderFraction,
        limited: range.limited,
        noteShown: !note.hidden,
        note: note.textContent,
        label: document.querySelector('output[for=border]')!.textContent,
      };
    }, SETTINGS_MODULE);
    avails.push(Number(r.avail).toFixed(2));
    if (r.sliderMax !== 0.1 || r.sliderValue !== 0.1)
      rangeProblems.push(
        `scale ${String(r.sliderMax)} value ${String(r.sliderValue)}`,
      );
    if (Math.abs(Number(r.avail) - r.expectAvail) > 1e-9)
      rangeProblems.push(`shade ${r.avail} vs ${String(r.expectAvail)}`);
    if (r.requested !== 0.25)
      rangeProblems.push(`request changed to ${String(r.requested)}`);
    if (!r.limited || !r.noteShown || !r.note.includes('You asked for 25.0%'))
      rangeProblems.push(`note: ${r.note}`);
    // The label and the note give the same request.
    if (!r.note.includes(`You asked for ${r.label}`))
      rangeProblems.push(`label ${r.label} vs note ${r.note}`);
  }
  check(
    'border slider: fixed 0 to 10% scale, the thumb and the 25% request never move on a re-roll, the shaded part changes, the label and note agree',
    rangeProblems.length === 0 && new Set(avails).size > 1,
    `${rangeProblems.join('; ')} available share of track ${avails.join(' ')}`,
  );
  const limitedDraw = await borderPixels(p, [255, 0, 255]);
  const shownMax = await p.evaluate(() => {
    const { state } = (window as any).__app.view.lastRender();
    return state.canvas.borderFraction;
  });
  check(
    'a request above the maximum is drawn at the maximum, with no tile vanishing',
    limitedDraw.margin > 0 &&
      limitedDraw.gapIsBg === true &&
      shownMax === 0.25 &&
      (await drawnStats(p)).tiles === n,
    `margin ${String(limitedDraw.margin)} px of canvas`,
  );
  await editorAction(p, 'setBorder', 0.01);
  await waitDrawn(p);
  check(
    'within the range the note is hidden',
    await p.locator('#border-note').isHidden(),
  );

  // 5. Background colour.
  const midBorder = await borderPixels(p, [255, 0, 255]);
  check(
    'the background shows through the border and gaps and nowhere else (pixel count equals the gap area)',
    Math.abs(midBorder.bgPixels - midBorder.expectedPixels) <=
      0.01 * midBorder.expectedPixels && midBorder.expectedPixels > 1000,
    `${String(midBorder.bgPixels)} bg px, ${String(midBorder.expectedPixels)} px of margin and gaps`,
  );
  const arrC = await arrangementOf(p);
  const tilesC = await tilePhotos(p);
  const swatch = await commitsDuring(async () => {
    await p.getByRole('button', { name: 'Black background' }).click();
  });
  await waitDrawn(p);
  const black = await borderPixels(p, [0, 0, 0]);
  check(
    'a swatch sets the background: black shows in the margin and gaps, one commit, no re-roll',
    swatch.commits === 1 &&
      black.marginIsBg &&
      black.gapIsBg === true &&
      (await arrangementOf(p)) === arrC &&
      (await tilePhotos(p)) === tilesC &&
      (await p
        .getByRole('button', { name: 'Black background' })
        .getAttribute('aria-pressed')) === 'true',
    JSON.stringify(black),
  );
  const pickerOnce = await commitsDuring(async () => {
    await p.evaluate(() => {
      const el =
        document.querySelector<HTMLInputElement>('#background-colour')!;
      el.focus();
      for (const c of ['#112233', '#2255aa', '#44aa22', '#ddaa00', '#ff00ff']) {
        el.value = c;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (c === '#2255aa') {
          // The picker is a separate window on some platforms: focus can
          // leave and come back while it is open. That is not an end.
          el.blur();
          el.focus();
        }
      }
    });
    await p.waitForTimeout(50);
    await p.evaluate(() => {
      const el =
        document.querySelector<HTMLInputElement>('#background-colour')!;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });
  });
  await waitDrawn(p);
  const magenta = await borderPixels(p, [255, 0, 255]);
  check(
    'the colour picker (many input events, then change and blur) is one gesture: one commit; colour shows in margin and gaps',
    pickerOnce.commits === 1 &&
      pickerOnce.steps >= 1 &&
      magenta.marginIsBg &&
      magenta.gapIsBg === true &&
      (await canvasInfo(p)).background === '#ff00ff',
    `${String(pickerOnce.commits)} commits, ${String(pickerOnce.steps)} steps`,
  );
  // The picker returns to the colour it opened with (Chrome fires no
  // change), then a swatch is clicked: exactly one commit.
  const staleSwatch = await commitsDuring(async () => {
    await p.evaluate(() => {
      const el =
        document.querySelector<HTMLInputElement>('#background-colour')!;
      el.focus();
      for (const c of ['#123456', '#ff00ff']) {
        el.value = c;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await p.waitForTimeout(50);
    await p.getByRole('button', { name: 'Black background' }).click();
  });
  check(
    'picker returned to its start (no change event), then a swatch click: one commit',
    staleSwatch.commits === 1,
    `${String(staleSwatch.commits)} commits`,
  );
  await p.evaluate(() => {
    (window as any).__app.editor.dispatch((s: any) => ({
      ...s,
      canvas: { ...s.canvas, background: '#ff00ff' },
    }));
  });
  await waitDrawn(p);
  const fillOnce = await commitsDuring(async () => {
    await p.locator('#background-colour').fill('#00aa44');
  });
  const green = await borderPixels(p, [0, 0xaa, 0x44]);
  check(
    'setting the colour input as a user would changes the background in the border and gaps',
    fillOnce.commits === 1 && green.marginIsBg && green.gapIsBg === true,
    `${String(fillOnce.commits)} commits`,
  );
  check(
    'the swatch for the current colour is the only one pressed',
    (await p.locator('.swatch[aria-pressed=true]').count()) === 0,
  );
  await p.getByRole('button', { name: 'White background' }).click();
  await editorAction(p, 'setBorder', 0);
  await waitDrawn(p);
}

/**
 * Physical canvas sizes (issue #7): units, paper presets, millimetres and
 * DPI, in real Chrome with the 40-odd synthetic photos already imported.
 */
async function checkPhysicalSizes(p: Page): Promise<void> {
  await p.locator('.preset', { hasText: /^16:9$/ }).click();
  await waitDrawn(p);
  await p.evaluate(() => {
    const w = window as any;
    w.__physCommits = 0;
    w.__physSteps = 0;
    w.__app.editor.subscribe((_: unknown, change: any) => {
      if (change.transient) w.__physSteps++;
      else w.__physCommits++;
    });
  });
  const commitsDuring = async (
    gesture: () => Promise<void>,
  ): Promise<number> => {
    await p.evaluate(() => {
      (window as any).__physCommits = 0;
      (window as any).__physSteps = 0;
    });
    await gesture();
    await p.waitForTimeout(100);
    await waitDrawn(p);
    return p.evaluate(() => (window as any).__physCommits as number);
  };
  const physical = (): Promise<any> =>
    p.evaluate(
      () => (window as any).__app.editor.getState().canvas.physical ?? null,
    );
  const sizeText = async (): Promise<string> => {
    const c = await canvasInfo(p);
    return `${String(c.width)}x${String(c.height)}`;
  };
  const value = (id: string): Promise<string> => p.locator(id).inputValue();
  const asPixels = p.getByRole('radio', { name: 'Pixels' });
  const asMm = p.getByRole('radio', { name: 'Millimetres' });
  const paper = (name: string) => p.getByRole('button', { name });
  const message = p.locator('#size-message');
  const mmW = p.locator('#size-width-mm');
  const mmH = p.locator('#size-height-mm');
  const dpi = p.locator('#size-dpi');
  const lock = p.getByLabel('Lock aspect ratio');
  const nPhotos = await p.evaluate(() =>
    (window as any).__app.store.getSelectedCount(),
  );

  // Labels and structure.
  const labelled = await p.evaluate(
    () =>
      ['size-width-mm', 'size-height-mm', 'size-dpi'].every(
        (id) => document.querySelector(`label[for=${id}]`) !== null,
      ) &&
      document
        .querySelector('[role=radiogroup]')
        ?.getAttribute('aria-label') === 'Size units',
  );
  check(
    'the millimetre and DPI fields and the units choice are labelled',
    labelled,
  );

  // 1. Pixel mode is the default: no physical size, no paper presets.
  check(
    'pixel mode by default: pixels pressed, no physical size, paper presets and mm fields hidden',
    (await asPixels.isChecked()) &&
      !(await asMm.isChecked()) &&
      (await physical()) === null &&
      !(await paper('A4 portrait').isVisible()) &&
      !(await mmW.isVisible()) &&
      (await p.locator('#size-width').isVisible()),
  );
  check(
    'pixel mode: the readout is pixels only and the border label has no mm',
    (await readout(p)).text === '1920 × 1080 px' &&
      !(await p.locator('.slider-row output').innerText()).includes('mm'),
  );
  const arr16 = await arrangementOf(p);

  // 2. Entering millimetres keeps the size, one commit, no re-roll.
  let commits = await commitsDuring(async () => {
    await asMm.check();
  });
  let phys = await physical();
  check(
    'switching to millimetres keeps 1920 x 1080 px, converts to mm at 300 DPI, one commit, same arrangement',
    commits === 1 &&
      (await sizeText()) === '1920x1080' &&
      phys?.widthMm === 162.56 &&
      phys?.heightMm === 91.44 &&
      phys?.dpi === 300 &&
      (await arrangementOf(p)) === arr16,
    `${String(commits)} commits, ${JSON.stringify(phys)}`,
  );
  check(
    'millimetre mode shows the fields, the paper presets and the derived pixel size',
    (await value('#size-width-mm')) === '162.56' &&
      (await value('#size-height-mm')) === '91.44' &&
      (await value('#size-dpi')) === '300' &&
      (await paper('A4 portrait').isVisible()) &&
      !(await p.locator('#size-width').isVisible()) &&
      (await p.locator('#size-derived').innerText()) === '= 1920 × 1080 px',
  );
  check(
    'the top-bar readout shows the paper size, DPI and pixels',
    (await readout(p)).text === '162.56 × 91.44 mm at 300 DPI · 1920 × 1080 px',
    (await readout(p)).text,
  );
  commits = await commitsDuring(async () => {
    await asMm.click();
  });
  check('choosing the units already chosen commits nothing', commits === 0);

  // 3. Leaving it keeps the pixels and drops the physical description.
  commits = await commitsDuring(async () => {
    await asPixels.check();
  });
  check(
    'switching back to pixels keeps 1920 x 1080, drops the physical size, one commit, same arrangement',
    commits === 1 &&
      (await sizeText()) === '1920x1080' &&
      (await physical()) === null &&
      (await value('#size-width')) === '1920' &&
      (await readout(p)).text === '1920 × 1080 px' &&
      (await arrangementOf(p)) === arr16,
  );

  // 4. A2 portrait at 300 DPI.
  await asMm.check();
  await waitDrawn(p);
  const before = await arrangementOf(p);
  const t0 = Date.now();
  commits = await commitsDuring(async () => {
    await paper('A2 portrait').click();
  });
  const a2ms = Date.now() - t0;
  phys = await physical();
  check(
    'A2 portrait at 300 DPI gives a 4961 x 7016 px canvas, one commit, re-rolled',
    commits === 1 &&
      (await sizeText()) === '4961x7016' &&
      phys?.widthMm === 420 &&
      phys?.heightMm === 594 &&
      phys?.dpi === 300 &&
      (await arrangementOf(p)) !== before,
    `${await sizeText()}, ${String(commits)} commits`,
  );
  check(
    'A2 portrait: readout, fields, derived size and pressed state',
    (await readout(p)).text === '420 × 594 mm at 300 DPI · 4961 × 7016 px' &&
      (await value('#size-width-mm')) === '420' &&
      (await value('#size-height-mm')) === '594' &&
      (await p.locator('#size-derived').innerText()) === '= 4961 × 7016 px' &&
      (await p.locator('.paper-preset[aria-pressed=true]').count()) === 1 &&
      (await paper('A2 portrait').getAttribute('aria-pressed')) === 'true',
    (await readout(p)).text,
  );
  commits = await commitsDuring(async () => {
    await paper('A2 portrait').click();
  });
  check(
    'clicking the paper preset already active commits nothing',
    commits === 0,
  );
  const big = await drawnStats(p);
  const backing = await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    return c.width * c.height;
  });
  check(
    'at A2 300 DPI the editor draws at screen size (not 35 million px) with every tile and full coverage',
    backing < 4_000_000 &&
      big.tiles === nPhotos &&
      Math.abs(big.coverage - 1) < 1e-9 &&
      Math.abs(big.canvasW / big.canvasH - 4961 / 7016) < 0.01,
    `backing ${String(backing)} px, ${String(big.tiles)} tiles`,
  );

  // 5. A3 landscape at 300 DPI.
  commits = await commitsDuring(async () => {
    await paper('A3 landscape').click();
  });
  phys = await physical();
  check(
    'A3 landscape at 300 DPI gives a 4961 x 3508 px canvas, one commit',
    commits === 1 &&
      (await sizeText()) === '4961x3508' &&
      phys?.widthMm === 420 &&
      phys?.heightMm === 297,
    `${await sizeText()}, ${String(commits)} commits`,
  );
  check(
    'only A3 landscape is pressed among the paper presets',
    (await p.locator('.paper-preset[aria-pressed=true]').count()) === 1 &&
      (await paper('A3 landscape').getAttribute('aria-pressed')) === 'true',
  );

  // 6. DPI: the pixel size changes, the layout and the relative border do not.
  await editorAction(p, 'setBackground', '#000000');
  await editorAction(p, 'setBorder', 0.02);
  await waitDrawn(p);
  const arr0 = await arrangementOf(p);
  const tiles0 = await tilePhotos(p);
  const edge0 = await borderPixels(p, [0, 0, 0]);
  const stats0 = await drawnStats(p);
  const rel0 = edge0.margin / Math.min(stats0.canvasW, stats0.canvasH);
  const label = await p.locator('.slider-row output').innerText();
  check(
    'physical mode: the border label shows pixels and millimetres (2.0% of 297 mm is 5.9 mm)',
    label.includes('2.0%') && label.includes('5.9 mm') && label.includes('px'),
    label,
  );
  const dpiProblems: string[] = [];
  for (const [d, expected] of [
    [150, '2480x1754'],
    [72, '1191x842'],
    [600, '9921x7016'],
    [300, '4961x3508'],
  ] as const) {
    await dpi.fill(String(d));
    commits = await commitsDuring(async () => {
      await dpi.press('Enter');
    });
    const edge = await borderPixels(p, [0, 0, 0]);
    const stats = await drawnStats(p);
    const rel = edge.margin / Math.min(stats.canvasW, stats.canvasH);
    if (commits !== 1)
      dpiProblems.push(`${String(d)}: ${String(commits)} commits`);
    if ((await sizeText()) !== expected)
      dpiProblems.push(`${String(d)}: ${await sizeText()}`);
    if ((await arrangementOf(p)) !== arr0)
      dpiProblems.push(`${String(d)}: re-rolled`);
    if ((await tilePhotos(p)) !== tiles0)
      dpiProblems.push(`${String(d)}: photos moved`);
    if (Math.abs(rel - rel0) > 0.004 || Math.abs(rel - 0.02) > 0.004)
      dpiProblems.push(
        `${String(d)}: relative border ${rel.toFixed(4)} vs ${rel0.toFixed(4)}`,
      );
    if ((await canvasInfo(p)).border !== 0.02)
      dpiProblems.push(`${String(d)}: border fraction`);
    const ph = await physical();
    if (ph?.widthMm !== 420 || ph?.heightMm !== 297 || ph?.dpi !== d)
      dpiProblems.push(`${String(d)}: physical ${JSON.stringify(ph)}`);
    if (
      (await readout(p)).text !==
      `420 × 297 mm at ${String(d)} DPI · ${expected.replace('x', ' × ')} px`
    )
      dpiProblems.push(`${String(d)}: readout ${(await readout(p)).text}`);
  }
  check(
    'changing DPI at A3 landscape (150, 72, 600, 300) changes the pixel size, keeps the photo-to-tile assignment and the arrangement, the border fraction and its drawn relative width (pixels measured), one commit each',
    dpiProblems.length === 0,
    dpiProblems.join('; '),
  );
  console.log(
    `  relative border at 2%: measured ${(rel0 * 100).toFixed(2)}% of the shorter side (margin ${String(edge0.margin)} px)`,
  );

  // 7. Typing alone commits nothing; blur commits.
  commits = await commitsDuring(async () => {
    await dpi.fill('');
    await dpi.pressSequentially('150', { delay: 20 });
  });
  check(
    'typing a DPI commits nothing on its own',
    commits === 0 && (await sizeText()) === '4961x3508',
  );
  commits = await commitsDuring(async () => {
    await dpi.press('Tab');
  });
  check(
    'blur commits the DPI, once',
    commits === 1 && (await sizeText()) === '2480x1754',
    `${String(commits)} commits`,
  );
  await editorAction(p, 'setBorder', 0);
  await editorAction(p, 'setBackground', '#ffffff');

  // 8. A ratio preset in millimetres keeps the long side in mm and the DPI.
  const arrA3 = await arrangementOf(p);
  commits = await commitsDuring(async () => {
    await p.locator('.preset', { hasText: /^1:1$/ }).click();
  });
  phys = await physical();
  check(
    'ratio preset 1:1 in millimetres keeps the long side (420 mm) and the DPI (150): 420 x 420 mm, 2480 x 2480 px, one commit, re-rolled',
    commits === 1 &&
      phys?.widthMm === 420 &&
      phys?.heightMm === 420 &&
      phys?.dpi === 150 &&
      (await sizeText()) === '2480x2480' &&
      (await arrangementOf(p)) !== arrA3,
    `${JSON.stringify(phys)} ${await sizeText()}`,
  );
  commits = await commitsDuring(async () => {
    await p.locator('.preset', { hasText: /^1:1$/ }).click();
  });
  check(
    'clicking the active ratio preset in millimetres commits nothing',
    commits === 0,
  );
  await p.locator('.preset', { hasText: /^3:4$/ }).click();
  await waitDrawn(p);
  phys = await physical();
  check(
    'ratio preset 3:4 in millimetres: 315 x 420 mm',
    phys?.widthMm === 315 && phys?.heightMm === 420 && phys?.dpi === 150,
    JSON.stringify(phys),
  );

  // 9. The aspect lock works in millimetres.
  await dpi.fill('300');
  await dpi.press('Enter');
  await paper('A4 portrait').click();
  await waitDrawn(p);
  const arrA4 = await arrangementOf(p);
  check('the aspect lock is on in millimetre mode', await lock.isChecked());
  await mmW.fill('105');
  commits = await commitsDuring(async () => {
    await mmW.press('Enter');
  });
  phys = await physical();
  check(
    'lock on: width 105 mm makes the height 148.5 mm (1240 x 1754 px), one commit, same arrangement',
    commits === 1 &&
      phys?.widthMm === 105 &&
      phys?.heightMm === 148.5 &&
      (await sizeText()) === '1240x1754' &&
      (await value('#size-height-mm')) === '148.5' &&
      (await arrangementOf(p)) === arrA4,
    `${JSON.stringify(phys)} ${String(commits)} commits`,
  );
  await mmH.fill('297');
  await mmH.press('Enter');
  await waitDrawn(p);
  phys = await physical();
  check(
    'lock on: height 297 mm makes the width 210 mm, and A4 portrait is pressed again',
    phys?.widthMm === 210 &&
      (await paper('A4 portrait').getAttribute('aria-pressed')) === 'true',
    JSON.stringify(phys),
  );
  await mmW.fill('99,9');
  await mmW.press('Enter');
  await waitDrawn(p);
  phys = await physical();
  check(
    'a decimal comma is accepted (99,9 mm), and the locked height follows (141.287 mm)',
    phys?.widthMm === 99.9 && phys?.heightMm === 141.287,
    JSON.stringify(phys),
  );
  await lock.uncheck();
  await mmW.fill('100');
  commits = await commitsDuring(async () => {
    await mmW.press('Enter');
  });
  phys = await physical();
  check(
    'lock off: only the width changes (100 x 141.287 mm), no paper preset is pressed, one commit',
    commits === 1 &&
      phys?.widthMm === 100 &&
      phys?.heightMm === 141.287 &&
      (await p.locator('.paper-preset[aria-pressed=true]').count()) === 0,
    JSON.stringify(phys),
  );
  await lock.check();
  await paper('A4 portrait').click();
  await waitDrawn(p);

  // 10. Bad input: a message, nothing applied, Escape restores.
  const base =
    JSON.stringify(await canvasInfo(p)) + JSON.stringify(await physical());
  const bad: [string, string, RegExp][] = [
    ['#size-width-mm', 'abc', /plain number/],
    ['#size-width-mm', '-5', /plain number/],
    ['#size-width-mm', '1e3', /plain number/],
    ['#size-width-mm', '12.3456', /plain number/],
    ['#size-width-mm', '12 mm', /plain number/],
    ['#size-width-mm', '', /empty/],
    ['#size-width-mm', '0', /at least/],
    ['#size-height-mm', '10001', /at most/],
    ['#size-height-mm', '99999999999999999999999', /at most/],
    ['#size-width-mm', '2000', /more than the 20000 px limit/],
    ['#size-dpi', 'abc', /whole number/],
    ['#size-dpi', '300.5', /whole number/],
    ['#size-dpi', '-300', /whole number/],
    ['#size-dpi', '', /empty/],
    ['#size-dpi', '0', /at least/],
    ['#size-dpi', '99999', /at most/],
    ['#size-dpi', '2400', /more than the 20000 px limit/],
  ];
  const badProblems: string[] = [];
  for (const [id, text, pattern] of bad) {
    const field = p.locator(id);
    const original = await field.inputValue();
    const n = await commitsDuring(async () => {
      await field.fill(text);
      await field.press('Enter');
    });
    const msg = (await message.isVisible()) ? await message.innerText() : '';
    if (
      !pattern.test(msg) ||
      n !== 0 ||
      (await field.getAttribute('aria-invalid')) !== 'true' ||
      JSON.stringify(await canvasInfo(p)) + JSON.stringify(await physical()) !==
        base
    )
      badProblems.push(
        `${id} ${JSON.stringify(text)}: ${msg || 'no message'}, ${String(n)} commits`,
      );
    await field.press('Escape');
    if (
      (await message.isVisible()) ||
      (await field.inputValue()) !== original ||
      (await field.getAttribute('aria-invalid')) !== null
    )
      badProblems.push(`${id}: Escape did not restore`);
  }
  check(
    'bad millimetre and DPI input (text, negatives, exponent, units, too many decimals, empty, zero, huge, over 20000 px) shows an inline message and applies nothing; Escape restores',
    badProblems.length === 0,
    badProblems.join('; '),
  );
  // Per-field errors: one field's error survives committing the other.
  await mmW.fill('abc');
  await mmW.press('Enter');
  await dpi.fill('0');
  await dpi.press('Enter');
  const both = (await message.innerText()).split('\n');
  check(
    'each field keeps its own error (width and DPI both shown)',
    both.length === 2 &&
      (await mmW.getAttribute('aria-invalid')) === 'true' &&
      (await dpi.getAttribute('aria-invalid')) === 'true',
    both.join(' | '),
  );
  await mmW.press('Escape');
  await dpi.press('Escape');
  // The largest sizes: A4 at 1200 DPI fits, and a paper that does not fit
  // at the current DPI is refused with a message.
  await paper('A4 portrait').click();
  await dpi.fill('1200');
  await dpi.press('Enter');
  await waitDrawn(p);
  check(
    'A4 portrait at 1200 DPI is 9921 x 14031 px',
    (await sizeText()) === '9921x14031',
    await sizeText(),
  );
  const atBig = JSON.stringify(await canvasInfo(p));
  commits = await commitsDuring(async () => {
    await paper('A2 portrait').click();
  });
  check(
    'a paper that would exceed 20000 px at the current DPI (A2 at 1200 DPI) is refused with a message and commits nothing',
    commits === 0 &&
      (await message.isVisible()) &&
      /A2 portrait.*20000 px limit/.test(await message.innerText()) &&
      JSON.stringify(await canvasInfo(p)) === atBig,
    await message.innerText(),
  );
  await paper('A4 portrait').click();
  await dpi.fill('300');
  await dpi.press('Enter');
  await paper('A2 portrait').click();
  await waitDrawn(p);
  check(
    'a valid change clears the refusal message',
    !(await message.isVisible()) && (await sizeText()) === '4961x7016',
  );

  // A ratio preset whose size would not fit in pixels is refused inline
  // (13 x 13 mm at 1 DPI, then 1:2 would give a 0 px side), never thrown.
  await editorAction(p, 'setPhysicalSize', 13, 13, 1);
  await waitDrawn(p);
  const tinyBase =
    JSON.stringify(await canvasInfo(p)) + JSON.stringify(await physical());
  const consoleErrors: string[] = [];
  const onError = (e: Error): void => {
    consoleErrors.push(e.message);
  };
  p.on('pageerror', onError);
  commits = await commitsDuring(async () => {
    await p.locator('.preset', { hasText: /^1:2$/ }).click();
  });
  p.off('pageerror', onError);
  check(
    'a ratio preset that would give a side under 1 px (1:2 from 13 mm at 1 DPI) shows an inline message, applies nothing, commits nothing and throws nothing',
    commits === 0 &&
      (await message.isVisible()) &&
      /1:2.*less than 1 px/.test(await message.innerText()) &&
      consoleErrors.length === 0 &&
      JSON.stringify(await canvasInfo(p)) + JSON.stringify(await physical()) ===
        tinyBase,
    `${await message.innerText()} ${consoleErrors.join(',')}`,
  );
  await p.locator('.preset', { hasText: /^1:1$/ }).click();
  check(
    'another preset that fits clears the message',
    !(await message.isVisible()),
  );
  await editorAction(p, 'setPhysicalSize', 420, 594, 300);
  await waitDrawn(p);

  // 11. Switching modes keeps the size.
  const a2size = await sizeText();
  commits = await commitsDuring(async () => {
    await asPixels.check();
  });
  const afterPixels = await sizeText();
  commits += await commitsDuring(async () => {
    await asMm.check();
  });
  phys = await physical();
  check(
    'A2 at 300 DPI -> pixels -> millimetres keeps 4961 x 7016 px (two commits); the DPI is remembered',
    commits === 2 &&
      a2size === '4961x7016' &&
      afterPixels === '4961x7016' &&
      (await sizeText()) === '4961x7016' &&
      phys?.dpi === 300,
    `${a2size} ${afterPixels} ${await sizeText()} ${String(commits)}`,
  );

  // 12. A pixel-mode edit drops the physical size.
  await asPixels.check();
  await p.locator('#size-width').fill('1000');
  await p.locator('#size-width').press('Enter');
  await waitDrawn(p);
  check(
    'a pixel edit leaves a pixel project: no physical size, readout in pixels',
    (await physical()) === null &&
      /^\d+ × \d+ px$/.test((await readout(p)).text),
  );

  // 13. Saved state stays valid JSON and reopens in the same mode.
  await asMm.check();
  await paper('A3 portrait').click();
  await waitDrawn(p);
  const reopened = await p.evaluate(async (module) => {
    const m = await import(/* @vite-ignore */ module);
    const s = (window as any).__app.editor.getState();
    const back = m.validateEditorState(JSON.parse(JSON.stringify(s)));
    return {
      same: JSON.stringify(back.canvas) === JSON.stringify(s.canvas),
      physical: back.canvas.physical,
    };
  }, STATE_MODULE);
  check(
    'the state, saved to JSON and validated, reopens in millimetres with the same numbers',
    reopened.same &&
      reopened.physical.widthMm === 297 &&
      reopened.physical.heightMm === 420 &&
      reopened.physical.dpi === 300,
    JSON.stringify(reopened.physical),
  );

  // 14. Keyboard: the units choice works with arrow keys, with a visible focus.
  await asPixels.check();
  await asPixels.focus();
  commits = await commitsDuring(async () => {
    await p.keyboard.press('ArrowRight');
  });
  const focusRing = await p.evaluate(() => {
    const radio = document.activeElement as HTMLInputElement;
    const face = radio.nextElementSibling as HTMLElement;
    return {
      value: radio.value,
      outline: getComputedStyle(face).outlineStyle,
    };
  });
  check(
    'keyboard: arrow key on the units choice selects millimetres (one commit) and shows a focus ring',
    commits === 1 &&
      focusRing.value === 'physical' &&
      focusRing.outline !== 'none',
    JSON.stringify(focusRing),
  );
  await mmW.focus();
  const mmRing = await p.evaluate(
    () => getComputedStyle(document.activeElement!).outlineStyle,
  );
  check('the millimetre field has a visible focus ring', mmRing !== 'none');

  // 15. Responsiveness at A2 300 DPI with the photos in the tray.
  await paper('A2 portrait').click();
  await waitDrawn(p);
  const timings = await p.evaluate(async (module) => {
    const m = await import(/* @vite-ignore */ module);
    const app = (window as any).__app;
    const frame = (): Promise<void> =>
      new Promise((r) => {
        requestAnimationFrame(() => {
          r();
        });
      });
    const out: Record<string, number> = {};
    const time = async (name: string, act: () => void): Promise<void> => {
      const start = performance.now();
      act();
      await frame();
      await frame();
      out[name] = Math.round(performance.now() - start);
    };
    await time('shuffle', () => {
      app.editor.shuffle();
    });
    await time('dpi', () => {
      const s = app.editor.getState().canvas.physical;
      app.editor.dispatch((st: any) =>
        m.setPhysicalSize(st, s.widthMm, s.heightMm, 150),
      );
    });
    return out;
  }, STATE_MODULE);
  await waitDrawn(p);
  check(
    'A2 at 300 DPI with a few dozen photos stays responsive: shuffle and a DPI change draw within 2 s',
    timings.shuffle! < 2000 && timings.dpi! < 2000,
    `shuffle ${String(timings.shuffle)} ms, dpi change ${String(timings.dpi)} ms, A2 click to drawn ${String(a2ms)} ms, ${String(nPhotos)} photos`,
  );
  console.log(
    `  A2 300 DPI, ${String(nPhotos)} photos: A2 click to drawn ${String(a2ms)} ms, shuffle ${String(timings.shuffle)} ms, DPI change ${String(timings.dpi)} ms`,
  );

  // Leave a clean pixel state for whatever runs next.
  await p.locator('.preset', { hasText: /^16:9$/ }).click();
  await asPixels.check();
  await waitDrawn(p);
}

/** At device pixel ratio 2 the canvas has twice the CSS pixels: sharp. */
async function checkPixelRatio(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  const empty = await p.evaluate(() => ({
    hidden:
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!.hidden,
    hint: document.querySelector<HTMLElement>('.canvas-hint')!.innerText,
    dial: document.querySelector<HTMLInputElement>('#size-variation')!.disabled,
  }));
  check(
    'empty editor: hint shown, canvas hidden, dial disabled',
    empty.hidden && empty.hint.includes('Drop photos') && empty.dial,
    empty.hint,
  );
  await p.setInputFiles(
    'input[type=file]',
    ['landscape.jpg', 'portrait.jpg'].map((f) => join(fixtures, f)),
  );
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 2,
  );
  await waitDrawn(p);
  const two = await drawnStats(p);
  check(
    'two photos: two tiles filling the canvas',
    two.tiles === 2 && Math.abs(two.coverage - 1) < 1e-9,
  );
  const dpr = await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    return {
      dpr: window.devicePixelRatio,
      backing: [c.width, c.height],
      css: [r.width, r.height],
    };
  });
  check(
    'at device pixel ratio 2 the canvas backing store is 2x its CSS size',
    dpr.dpr === 2 &&
      Math.abs(dpr.backing[0]! - 2 * dpr.css[0]!) <= 1 &&
      Math.abs(dpr.backing[1]! - 2 * dpr.css[1]!) <= 1,
    JSON.stringify(dpr),
  );
  // A single photo fills the canvas on its own.
  await p.locator('.thumb').first().click();
  await waitDrawn(p);
  const one = await drawnStats(p);
  check(
    'one photo: a single tile filling the canvas',
    one.tiles === 1 && Math.abs(one.coverage - 1) < 1e-9,
  );
  await ctx.close();
}

// --- Tile selection, Swap and Remove (issue #8) --------------------------------

/** Selection in a fresh page with the six synthetic fixtures. */
async function checkSelection(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles(
    'input[type=file]',
    [
      'landscape.jpg',
      'portrait.jpg',
      'square.jpg',
      'orient-6.jpg',
      'orient-8.jpg',
      'orient-3.jpg',
    ].map((f) => join(fixtures, f)),
  );
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 6,
  );
  await waitDrawn(p);
  // Count committed editor notifications from here on.
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_s: unknown, c: { transient: boolean }) => {
      if (!c.transient) w.__commits++;
    });
  });
  const commits = (): Promise<number> =>
    p.evaluate(() => (window as any).__commits);
  const resetCommits = (): Promise<void> =>
    p.evaluate(() => {
      (window as any).__commits = 0;
    });
  const kind = (): Promise<string> =>
    p.evaluate(() => (window as any).__app.selection.getSelection().kind);
  const assignment = (): Promise<string[]> =>
    p.evaluate(() => [...(window as any).__app.editor.getState().assignment]);
  /** The client point at the centre of a slot's tile. */
  const centre = (slot: number): Promise<{ x: number; y: number }> =>
    p.evaluate((slot) => {
      const { tiles } = (window as any).__app.view.lastRender();
      const t = tiles.find((t: any) => t.slot === slot);
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const r = c.getBoundingClientRect();
      return {
        x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
        y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
      };
    }, slot);
  const clickTile = async (slot: number): Promise<void> => {
    const { x, y } = await centre(slot);
    await p.mouse.click(x, y);
  };
  const menu = p.locator('.tile-menu');
  const swapBtn = menu.getByRole('button', { name: 'Swap' });
  const removeBtn = menu.getByRole('button', { name: 'Remove' });
  const outline = p.locator('.tile-outline');
  const outsideClick = (): Promise<void> => p.mouse.click(5, 790);

  // Select and deselect: no commits.
  await clickTile(0);
  const outlineBox = await outline.boundingBox();
  const tileBox = await p.evaluate(() => {
    const { tiles } = (window as any).__app.view.lastRender();
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    const t = tiles.find((t: any) => t.slot === 0);
    return {
      x: r.left + (t.x * r.width) / c.width,
      y: r.top + (t.y * r.height) / c.height,
      w: (t.width * r.width) / c.width,
    };
  });
  check(
    'clicking a tile selects it: outline over that tile and the menu appears',
    (await kind()) === 'selected' &&
      (await outline.isVisible()) &&
      (await menu.isVisible()) &&
      Math.abs(outlineBox!.x - tileBox.x) < 1.5 &&
      Math.abs(outlineBox!.y - tileBox.y) < 1.5 &&
      Math.abs(outlineBox!.width - tileBox.w) < 1.5,
    JSON.stringify({ outlineBox, tileBox }),
  );
  check(
    'the menu offers Swap and Remove as buttons with a label',
    (await swapBtn.isVisible()) &&
      (await removeBtn.isVisible()) &&
      ((await menu.getAttribute('aria-label')) ?? '').includes('Actions for '),
  );
  const before = await assignment();
  await clickTile(0);
  check(
    'clicking the selected tile again deselects it',
    (await kind()) === 'idle' &&
      !(await outline.isVisible()) &&
      !(await menu.isVisible()),
  );
  await clickTile(1);
  await outsideClick();
  check('clicking outside the collage deselects', (await kind()) === 'idle');
  await clickTile(1);
  await p.keyboard.press('Escape');
  check('Escape deselects', (await kind()) === 'idle');
  await clickTile(2);
  await clickTile(3);
  check(
    'clicking another tile moves the selection',
    (await kind()) === 'selected' &&
      (await p.evaluate(
        () => (window as any).__app.selection.selectedTile().tile.slot,
      )) === 3,
  );
  await outsideClick();
  check(
    'selecting and deselecting makes no commits and changes nothing',
    (await commits()) === 0 &&
      JSON.stringify(await assignment()) === JSON.stringify(before),
    String(await commits()),
  );

  // The menu stays inside the viewport for every tile (and a small window).
  for (const size of [
    { width: 1280, height: 800 },
    { width: 900, height: 620 },
  ]) {
    await p.setViewportSize(size);
    await waitDrawn(p);
    let inside = true;
    let tried = 0;
    for (let slot = 0; slot < 6; slot++) {
      // A narrow window can push part of the collage off screen: check the
      // tiles that are on screen, however many the arrangement leaves.
      const c = await centre(slot);
      if (c.x < 0 || c.y < 0 || c.x > size.width || c.y > size.height) continue;
      tried++;
      await clickTile(slot);
      const box = await menu.boundingBox();
      if (
        !box ||
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > size.width ||
        box.y + box.height > size.height
      ) {
        inside = false;
      }
    }
    await outsideClick();
    check(
      `the menu stays inside the viewport for every tile at ${String(size.width)} x ${String(size.height)}`,
      inside && tried >= 1,
      `${String(tried)} tiles tried`,
    );
  }
  await p.setViewportSize({ width: 1280, height: 800 });
  await waitDrawn(p);

  // Give one photo a crop, so we can check crops stay with their photos.
  const photoA = before[0]!;
  const photoB = before[3]!;
  await editorAction(p, 'setCrop', photoA, { zoom: 2, x: 0.3, y: 0.7 });
  await waitDrawn(p);
  const cropBefore = await p.evaluate(
    (id) => JSON.stringify((window as any).__app.editor.getState().crops[id]),
    photoA,
  );
  await resetCommits();

  // Swap: pending state, then a second tile.
  await clickTile(0);
  await swapBtn.click();
  const pendingHint = await menu.innerText();
  check(
    'choosing Swap shows a hint and a distinct outline on the first tile',
    (await kind()) === 'swapping' &&
      /swap/i.test(pendingHint) &&
      (await outline.evaluate((e) => e.classList.contains('swapping'))) &&
      (await p.locator('.tile-menu-hint').isVisible()),
    pendingHint,
  );
  if (process.argv.includes('--selection-screenshot')) {
    mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
    await p.screenshot({
      path: join(root, 'docs', 'screenshots', 'issue-8-swap-pending.png'),
    });
  }
  const pixelsBefore = await canvasPixels(p);
  const photosBefore = await assignment();
  await clickTile(3);
  await waitDrawn(p);
  const after = await assignment();
  const changed = after.flatMap((id, slot) =>
    id === photosBefore[slot] ? [] : [slot],
  );
  check(
    'swapping exchanges the two photos and nothing else, as one commit',
    changed.join() === '0,3' &&
      after[0] === photosBefore[3] &&
      after[3] === photosBefore[0] &&
      (await commits()) === 1 &&
      (await kind()) === 'idle' &&
      !(await menu.isVisible()),
    `changed ${changed.join()}, commits ${String(await commits())}`,
  );
  const pixelsAfter = await canvasPixels(p);
  const diff = await p.evaluate(
    ({ a, b, slots }) => {
      const { tiles, state } = (window as any).__app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const w = c.width;
      const inSwapped = (x: number, y: number): boolean =>
        tiles.some(
          (t: any) =>
            slots.includes(t.slot) &&
            x >= t.x &&
            x < t.x + t.width &&
            y >= t.y &&
            y < t.y + t.height,
        );
      let outside = 0;
      let inside = 0;
      for (let i = 0; i < a.length; i += 4) {
        const px = (i / 4) % w;
        const py = Math.floor(i / 4 / w);
        const same =
          a[i] === b[i] &&
          a[i + 1] === b[i + 1] &&
          a[i + 2] === b[i + 2] &&
          a[i + 3] === b[i + 3];
        if (!same) {
          if (inSwapped(px, py)) inside++;
          else outside++;
        }
      }
      return { outside, inside, size: state.assignment.length };
    },
    { a: pixelsBefore, b: pixelsAfter, slots: [0, 3] },
  );
  check(
    'every other tile is pixel-identical after the swap; the swapped tiles changed',
    diff.outside === 0 && diff.inside > 0,
    JSON.stringify(diff),
  );
  const stats = await drawnStats(p);
  check(
    'after a swap each photo still fills its tile (no empty space)',
    Math.abs(stats.coverage - 1) < 1e-9 && stats.assignmentOk,
    String(stats.coverage),
  );
  const cropAfter = await p.evaluate(
    (id) => JSON.stringify((window as any).__app.editor.getState().crops[id]),
    photoA,
  );
  check(
    'a swapped photo keeps its crop',
    cropBefore === cropAfter && photoB !== photoA,
  );
  // Tiles fully painted: no pixel left at the page background inside tiles.
  const unpainted = await p.evaluate(() => {
    const { tiles } = (window as any).__app.view.lastRender();
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let bad = 0;
    for (const t of tiles) {
      for (const [fx, fy] of [
        [0.02, 0.02],
        [0.98, 0.02],
        [0.02, 0.98],
        [0.98, 0.98],
      ] as const) {
        const x = Math.floor(t.x + t.width * fx);
        const y = Math.floor(t.y + t.height * fy);
        const i = (y * c.width + x) * 4;
        // The default background is white; a photo corner is not.
        if (
          data.data[i] === 255 &&
          data.data[i + 1] === 255 &&
          data.data[i + 2] === 255
        ) {
          bad++;
        }
      }
    }
    return bad;
  });
  check('no tile corner is left unpainted after the swap', unpainted === 0);

  // Cancelling a swap: zero commits, nothing changed.
  await resetCommits();
  const keep = await assignment();
  await clickTile(1);
  await swapBtn.click();
  await clickTile(1);
  check(
    'clicking the same tile cancels a pending swap',
    (await kind()) === 'idle' && (await commits()) === 0,
  );
  await clickTile(1);
  await swapBtn.click();
  await outsideClick();
  check(
    'clicking outside cancels a pending swap',
    (await kind()) === 'idle' && (await commits()) === 0,
  );
  await clickTile(1);
  await swapBtn.click();
  await p.keyboard.press('Escape');
  check(
    'Escape cancels a pending swap, with no commit and nothing changed',
    (await kind()) === 'idle' &&
      (await commits()) === 0 &&
      JSON.stringify(await assignment()) === JSON.stringify(keep) &&
      !(await outline.isVisible()),
  );
  await clickTile(1);
  await swapBtn.click();
  await menu.getByRole('button', { name: 'Cancel' }).click();
  check(
    'the Cancel button cancels a pending swap',
    (await kind()) === 'idle' && (await commits()) === 0,
  );

  // Keyboard focus is visible as soon as Tab reaches the canvas.
  const focusIndicator = (): Promise<boolean> =>
    p.evaluate(() => {
      const box = document.querySelector<HTMLElement>('.tile-focus')!;
      const r = box.getBoundingClientRect();
      return (
        !box.hidden &&
        r.width > 4 &&
        r.height > 4 &&
        document.activeElement?.classList.contains('collage-canvas') === true
      );
    });
  const tabToCanvas = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      await p.keyboard.press('Tab');
      if (
        await p.evaluate(() =>
          document.activeElement?.classList.contains('collage-canvas'),
        )
      ) {
        return;
      }
    }
  };
  await p.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
  });
  await tabToCanvas();
  check(
    'Tab to the canvas shows a focus indicator before any arrow key',
    await focusIndicator(),
  );
  await clickTile(1);
  await p.keyboard.press('Escape');
  check(
    'after a mouse click the focus indicator is not shown',
    !(await p.evaluate(
      () => !document.querySelector<HTMLElement>('.tile-focus')!.hidden,
    )),
  );
  await p.keyboard.press('Shift+Tab');
  await tabToCanvas();
  check(
    'after a mouse click, Shift+Tab then Tab shows the focus indicator again',
    await focusIndicator(),
  );

  // Keyboard: focus the canvas, move, select, reach the menu with Tab.
  await p.locator('.collage-canvas').focus();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  const selectedByKey = await p.evaluate(() =>
    (window as any).__app.selection.selectedTile(),
  );
  const label1 = await p.locator('.collage-canvas').getAttribute('aria-label');
  const nameOf = (id: string): Promise<string> =>
    p.evaluate((id) => (window as any).__store.getPhoto(id).file.name, id);
  const selName = selectedByKey ? await nameOf(selectedByKey.photoId) : '';
  check(
    'keyboard: arrow keys and Enter select a tile; the canvas label names the file, position and state',
    selectedByKey !== null &&
      (label1 ?? '').includes(selName) &&
      /tile \d+ of 6, selected/.test(label1 ?? ''),
    label1 ?? '',
  );
  await p.keyboard.press('Tab');
  check(
    'keyboard: Tab from the canvas reaches the Swap button, then Remove',
    (await p.evaluate(() => document.activeElement?.textContent)) === 'Swap' &&
      (await (async () => {
        await p.keyboard.press('Tab');
        return p.evaluate(() => document.activeElement?.textContent);
      })()) === 'Remove',
  );
  await p.keyboard.press('Shift+Tab');
  await p.keyboard.press('Enter'); // Swap
  check(
    'keyboard: Enter on Swap starts a swap and returns focus to the canvas',
    (await kind()) === 'swapping' &&
      (await p.evaluate(() => document.activeElement?.className)) ===
        'collage-canvas swap-pending',
  );
  await resetCommits();
  const kbBefore = await assignment();
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('Enter');
  const kbAfter = await assignment();
  await waitDrawn(p);
  check(
    'keyboard: a second tile chosen with arrows and Enter swaps, as one commit',
    (await commits()) === 1 &&
      kbAfter.filter((id, i) => id !== kbBefore[i]).length === 2,
  );
  await p.keyboard.press('Enter');
  await p.keyboard.press('Escape');
  check(
    'keyboard: Escape clears a selection made by keyboard',
    (await kind()) === 'idle',
  );

  // Remove: gone from the collage, unticked in the tray, one commit.
  await resetCommits();
  await clickTile(2);
  const victim = (await assignment())[2]!;
  const victimName = await nameOf(victim);
  const selectedBefore = await p.evaluate(() =>
    (window as any).__store.getSelectedCount(),
  );
  await removeBtn.click();
  await waitDrawn(p);
  const survivors = await assignment();
  check(
    'Remove takes the photo out of the collage and re-rolls: one commit, no selection left',
    !survivors.includes(victim) &&
      survivors.length === 5 &&
      (await commits()) === 1 &&
      (await kind()) === 'idle' &&
      !(await menu.isVisible()),
    `commits ${String(await commits())}`,
  );
  check(
    'Remove unticks the photo in the tray, which keeps showing it',
    (await p
      .locator(`.thumb[aria-label="${victimName}"]`)
      .getAttribute('aria-pressed')) === 'false' &&
      (await p.evaluate(() => (window as any).__store.getSelectedCount())) ===
        selectedBefore - 1 &&
      (await p.locator('.thumb').count()) === 6,
  );

  // Re-rolls clear the selection.
  await clickTile(0);
  const shuffleBtn = p.getByRole('button', { name: 'Shuffle' });
  await shuffleBtn.click();
  await waitDrawn(p);
  check(
    'Shuffle clears the selection',
    (await kind()) === 'idle' && !(await outline.isVisible()),
  );
  await clickTile(0);
  await setDial(p, 0.9);
  await waitDrawn(p);
  check('changing the dial clears the selection', (await kind()) === 'idle');
  await clickTile(0);
  await p.locator('.thumb').first().click();
  await waitDrawn(p);
  check(
    'including or excluding a photo in the tray clears the selection',
    (await kind()) === 'idle',
  );

  // Selected photo leaves the collage through the tray.
  await clickTile(0);
  const gone = (await assignment())[0]!;
  const goneName = await nameOf(gone);
  await p.locator(`.thumb[aria-label="${goneName}"]`).click();
  await waitDrawn(p);
  check(
    'excluding the selected photo in the tray clears the selection',
    (await kind()) === 'idle' && !(await outline.isVisible()),
  );

  // Keyboard Remove keeps a usable focus target.
  await p.getByRole('button', { name: 'Add all to collage' }).click();
  await waitDrawn(p);
  await p.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
  });
  await tabToCanvas();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Tab');
  await p.keyboard.press('Tab');
  await p.keyboard.press('Enter'); // Remove
  await waitDrawn(p);
  check(
    'keyboard Remove with several photos: focus stays on the canvas with a visible tile indicator',
    (await assignment()).length === 5 && (await focusIndicator()),
  );
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  check(
    'the remaining tiles can be selected by keyboard after Remove',
    (await kind()) === 'selected',
  );
  await p.keyboard.press('Escape');
  // Removing the last photo by keyboard leaves focus on a control.
  await p.getByRole('button', { name: 'Remove all' }).click();
  await p.locator('.thumb').first().click();
  await waitDrawn(p);
  await p.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
  });
  await tabToCanvas();
  await p.keyboard.press('Enter');
  await p.keyboard.press('Tab');
  await p.keyboard.press('Tab');
  await p.keyboard.press('Enter'); // Remove
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 0,
  );
  const emptyFocus = await p.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent,
  }));
  check(
    'keyboard Remove of the last photo moves focus to a control, not the page',
    emptyFocus.tag === 'BUTTON',
    JSON.stringify(emptyFocus),
  );

  if (process.argv.includes('--selection-screenshot')) {
    await p.getByRole('button', { name: 'Add all to collage' }).click();
    await waitDrawn(p);
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await waitDrawn(p);
    await clickTile(1);
    await p.screenshot({
      path: join(root, 'docs', 'screenshots', 'issue-8-selected.png'),
    });
  }
  await ctx.close();
}

// --- Tile crop: zoom and pan (issue #9) ----------------------------------------

const CROP_MODULE = '/src/editor/crop.ts';

interface SyntheticPhoto {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Generated JPEGs, made in the page: gradients in blue-green hues, and a red
 * disc at (0.78, 0.35) of the photo named `marker.jpg`. No photo contains
 * magenta, so magenta in a tile can only be the canvas background.
 */
async function makeSyntheticPhotos(
  p: Page,
  count: number,
  size = 1,
): Promise<SyntheticPhoto[]> {
  const encoded = await p.evaluate(
    async ({ count, size }) => {
      const out: { name: string; data: string }[] = [];
      for (let i = 0; i < count; i++) {
        const marker = i === 0;
        const [w, h] = marker
          ? [1200, 800]
          : ([
              [900, 600],
              [600, 900],
              [800, 800],
              [1200, 500],
              [500, 1000],
            ][i % 5] as number[]);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w! * size);
        canvas.height = Math.round(h! * size);
        const ctx = canvas.getContext('2d')!;
        ctx.scale(size, size);
        const g = ctx.createLinearGradient(0, 0, w!, h!);
        g.addColorStop(0, `hsl(${String(120 + ((i * 29) % 140))} 60% 55%)`);
        g.addColorStop(1, `hsl(${String(150 + ((i * 29) % 110))} 60% 25%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w!, h!);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 72px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(i), w! / 2, h! / 2 + 24);
        if (marker) {
          ctx.fillStyle = '#ff0000';
          ctx.beginPath();
          ctx.arc(w! * 0.78, h! * 0.35, 70, 0, Math.PI * 2);
          ctx.fill();
        }
        const blob = await new Promise<Blob>((res) => {
          canvas.toBlob((b) => {
            res(b!);
          }, 'image/jpeg');
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        out.push({
          name: marker ? 'marker.jpg' : `plain-${String(i)}.jpg`,
          data: btoa(bin),
        });
      }
      return out;
    },
    { count, size },
  );
  return encoded.map((e) => ({
    name: e.name,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(e.data, 'base64'),
  }));
}

async function checkCrop(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles('input[type=file]', await makeSyntheticPhotos(p, 6));
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 6,
  );
  await waitDrawn(p);
  await p.evaluate(() => {
    const w = window as any;
    w.__log = [];
    w.__app.editor.subscribe((s: any, c: { transient: boolean }) => {
      if (c.transient) return;
      const id = w.__app.store
        .getPhotos()
        .find((x: any) => x.file.name === 'marker.jpg').id;
      w.__log.push({ seed: s.seed, crop: s.crops[id] ?? null });
    });
  });
  const log = (): Promise<{ seed: number; crop: any }[]> =>
    p.evaluate(() => (window as any).__log);
  const resetLog = (): Promise<void> =>
    p.evaluate(() => {
      (window as any).__log.length = 0;
    });
  const commits = async (): Promise<number> => (await log()).length;
  const markerId = await p.evaluate(
    () =>
      (window as any).__app.store
        .getPhotos()
        .find((x: any) => x.file.name === 'marker.jpg').id as string,
  );
  const cropOfMarker = (): Promise<{
    x: number;
    y: number;
    zoom: number;
  } | null> =>
    p.evaluate(
      (id) => (window as any).__app.editor.getState().crops[id] ?? null,
      markerId,
    );
  const kind = (): Promise<string> =>
    p.evaluate(() => (window as any).__app.selection.getSelection().kind);
  /** The marker's tile (canvas pixels) and canvas rect (client pixels). */
  const markerTile = (): Promise<{
    slot: number;
    x: number;
    y: number;
    width: number;
    height: number;
    cx: number;
    cy: number;
    left: number;
    top: number;
    scale: number;
  }> =>
    p.evaluate((id) => {
      const app = (window as any).__app;
      const { tiles, state } = app.view.lastRender();
      const slot = state.assignment.indexOf(id);
      const t = tiles.find((t: any) => t.slot === slot);
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const r = c.getBoundingClientRect();
      const scale = r.width / c.width;
      return {
        slot,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        cx: r.left + (t.x + t.width / 2) * scale,
        cy: r.top + (t.y + t.height / 2) * scale,
        left: r.left,
        top: r.top,
        scale,
      };
    }, markerId);
  /** The photo point (fractions) under a client point, via coverSource. */
  const photoPointAt = (
    cx: number,
    cy: number,
  ): Promise<{ x: number; y: number }> =>
    p.evaluate(
      async ({ id, cx, cy, module }) => {
        const { coverSource } = await import(/* @vite-ignore */ module);
        const app = (window as any).__app;
        const { tiles, state } = app.view.lastRender();
        const slot = state.assignment.indexOf(id);
        const t = tiles.find((t: any) => t.slot === slot);
        const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
        const r = c.getBoundingClientRect();
        const photo = app.store.getPhoto(id);
        const crop = state.crops[id];
        const src = coverSource(
          photo.width,
          photo.height,
          t.width,
          t.height,
          crop,
        );
        const fx = ((cx - r.left) * (c.width / r.width) - t.x) / t.width;
        const fy = ((cy - r.top) * (c.height / r.height) - t.y) / t.height;
        return {
          x: (src.sx + fx * src.sw) / photo.width,
          y: (src.sy + fy * src.sh) / photo.height,
        };
      },
      { id: markerId, cx, cy, module: CROP_MODULE },
    );
  /** Counts pixels in the marker's tile matching a colour test. */
  const tilePixels = (
    test: 'red' | 'magenta',
  ): Promise<{ count: number; mx: number; my: number; w: number; h: number }> =>
    p.evaluate(
      ({ id, test }) => {
        const app = (window as any).__app;
        const { tiles, state } = app.view.lastRender();
        const slot = state.assignment.indexOf(id);
        const t = tiles.find((t: any) => t.slot === slot);
        const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
        const x0 = Math.ceil(t.x);
        const y0 = Math.ceil(t.y);
        const w = Math.floor(t.x + t.width) - x0;
        const h = Math.floor(t.y + t.height) - y0;
        const d = c.getContext('2d')!.getImageData(x0, y0, w, h).data;
        let count = 0;
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
          const hit =
            test === 'red'
              ? r > 200 && g < 90 && b < 90
              : r > 200 && g < 60 && b > 200;
          if (hit) {
            count++;
            sx += (i / 4) % w;
            sy += Math.floor(i / 4 / w);
          }
        }
        return {
          count,
          mx: count ? sx / count / w : 0,
          my: count ? sy / count / h : 0,
          w,
          h,
        };
      },
      { id: markerId, test },
    );
  const canvasHash = (): Promise<string> =>
    stableHash(p, () =>
      p.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
        const d = c
          .getContext('2d')!
          .getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]!) | 0;
        return String(h);
      }),
    );
  const select = async (): Promise<void> => {
    if ((await kind()) === 'selected') return;
    const t = await markerTile();
    await p.mouse.click(t.cx, t.cy);
  };
  const menu = p.locator('.tile-menu');
  const slider = menu.getByRole('slider');
  const resetBtn = menu.getByRole('button', { name: 'Reset' });
  const sleep = (ms: number): Promise<void> => p.waitForTimeout(ms);

  await select();
  check(
    'the marker photo is selected and the menu has Zoom and Reset',
    (await kind()) === 'selected' &&
      (await slider.isVisible()) &&
      (await resetBtn.isVisible()),
  );

  // A click without movement is not a crop gesture.
  await resetLog();
  let t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx + 2, t.cy + 1);
  await p.mouse.up();
  await sleep(100);
  check(
    'a click on the selected tile (even with 2 px of jitter) deselects it with 0 commits',
    (await kind()) === 'idle' && (await commits()) === 0,
    `${await kind()} ${String(await commits())}`,
  );

  // A drag on an unselected tile does not pan it.
  const hashBefore = await canvasHash();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx + 40, t.cy + 30, { steps: 5 });
  await p.mouse.up();
  await sleep(100);
  check(
    'dragging an unselected tile does not pan it: 0 commits, crop unchanged',
    (await commits()) === 0 &&
      (await cropOfMarker()) === null &&
      (await canvasHash()) === hashBefore,
  );
  await select();

  // Wheel: zoom about the pointer, one commit per burst.
  t = await markerTile();
  const px = Math.round(t.cx + t.width * t.scale * 0.25);
  const py = Math.round(t.cy - t.height * t.scale * 0.2);
  const grabbed0 = await photoPointAt(px, py);
  await resetLog();
  await p.mouse.move(px, py);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, -80);
    await sleep(20);
  }
  await sleep(500);
  const zoomed = await cropOfMarker();
  const grabbed1 = await photoPointAt(px, py);
  check(
    'a wheel burst over the selected tile zooms it, as exactly one commit',
    zoomed !== null && zoomed.zoom > 1.5 && (await commits()) === 1,
    JSON.stringify({ zoomed, commits: await commits() }),
  );
  check(
    'the wheel zooms about the pointer: the photo point under it stays put',
    Math.abs(grabbed1.x - grabbed0.x) < 1e-3 &&
      Math.abs(grabbed1.y - grabbed0.y) < 1e-3,
    JSON.stringify({ grabbed0, grabbed1 }),
  );
  check(
    'the tile stays selected after wheel zoom',
    (await kind()) === 'selected',
  );
  await resetLog();
  await p.mouse.wheel(0, -60);
  await sleep(500);
  await p.mouse.wheel(0, -60);
  await sleep(500);
  check(
    'two wheel bursts a moment apart are two commits',
    (await commits()) === 2,
    String(await commits()),
  );

  // Pan: drag inside the selected tile.
  await resetLog();
  t = await markerTile();
  const startX = t.cx;
  const startY = t.cy;
  const pointBefore = await photoPointAt(startX, startY);
  const pixelsBefore = await canvasHash();
  await p.mouse.move(startX, startY);
  await p.mouse.down();
  await p.mouse.move(startX + 12, startY + 8, { steps: 4 });
  await p.mouse.move(startX + 25, startY + 14, { steps: 6 });
  await p.mouse.up();
  await sleep(300);
  const pointAfter = await photoPointAt(startX + 25, startY + 14);
  check(
    'dragging the selected tile pans it: pixels move, one commit',
    (await canvasHash()) !== pixelsBefore && (await commits()) === 1,
    String(await commits()),
  );
  check(
    'the point grabbed stays under the pointer',
    Math.abs(pointAfter.x - pointBefore.x) < 1e-3 &&
      Math.abs(pointAfter.y - pointBefore.y) < 1e-3,
    JSON.stringify({ pointBefore, pointAfter }),
  );
  check(
    'the click that ends a drag does not deselect',
    (await kind()) === 'selected',
  );

  // Wheel scrolls nothing over the selected tile, and behaves normally elsewhere.
  const prevented = await p.evaluate(
    ({ over, away }) => {
      const fire = (x: number, y: number): boolean => {
        const target = document.elementFromPoint(x, y)!;
        const e = new WheelEvent('wheel', {
          deltaY: 1,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return { over: fire(over.x, over.y), away: fire(away.x, away.y) };
    },
    { over: { x: startX, y: startY }, away: { x: 5, y: 5 } },
  );
  await sleep(400); // the synthetic wheel above started a burst: let it end
  check(
    'a wheel over the selected tile is cancelled; elsewhere it is not',
    prevented.over && !prevented.away,
    JSON.stringify(prevented),
  );
  const otherTile = await p.evaluate((id) => {
    const app = (window as any).__app;
    const { tiles, state } = app.view.lastRender();
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    const t = tiles.find((t: any) => state.assignment[t.slot] !== id);
    return {
      x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
      y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
    };
  }, markerId);
  const otherPrevented = await p.evaluate(({ x, y }) => {
    const e = new WheelEvent('wheel', {
      deltaY: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    document.elementFromPoint(x, y)!.dispatchEvent(e);
    return e.defaultPrevented;
  }, otherTile);
  check(
    'a wheel over another (unselected) tile is not cancelled',
    !otherPrevented,
  );

  // Reset.
  await resetLog();
  await resetBtn.click();
  await sleep(100);
  check(
    'Reset restores the default crop as one commit',
    (await cropOfMarker()) === null && (await commits()) === 1,
  );
  await resetBtn.click();
  await sleep(100);
  check('Reset when already default is 0 commits', (await commits()) === 1);

  // Zoom slider.
  await resetLog();
  const box = (await slider.boundingBox())!;
  await p.mouse.move(box.x + 4, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, {
    steps: 6,
  });
  await p.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, {
    steps: 6,
  });
  await p.mouse.up();
  await sleep(200);
  const sliderCrop = await cropOfMarker();
  check(
    'dragging the zoom slider zooms the tile as exactly one commit',
    sliderCrop !== null && sliderCrop.zoom > 2 && (await commits()) === 1,
    JSON.stringify({ sliderCrop, commits: await commits() }),
  );
  check(
    'the slider shows the stored zoom',
    Math.abs(Number(await slider.inputValue()) - sliderCrop!.zoom) < 0.02,
  );
  check(
    'the tile stays selected after the slider drag',
    (await kind()) === 'selected',
  );

  // Keyboard: Tab order and Shift+arrows.
  await resetBtn.click();
  await p.locator('.collage-canvas').focus();
  await resetLog();
  await p.keyboard.press('Equal');
  await p.keyboard.press('Equal');
  await p.keyboard.press('Shift+ArrowRight');
  await p.keyboard.press('Shift+ArrowRight');
  await sleep(500);
  const keyed = await cropOfMarker();
  check(
    'Shift+arrows and + on the focused canvas pan and zoom the selected tile (one commit per burst)',
    keyed !== null &&
      keyed.zoom > 1.2 &&
      keyed.x > 0.5 &&
      (await commits()) === 1,
    JSON.stringify({ keyed, commits: await commits() }),
  );
  await p.locator('.collage-canvas').focus();
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    await p.keyboard.press('Tab');
    order.push(
      await p.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return a.tagName === 'INPUT' ? 'slider' : a.textContent.trim();
      }),
    );
  }
  check(
    'Tab from the canvas reaches Swap, Remove, the zoom slider and Reset',
    order.join() === 'Swap,Remove,slider,Reset',
    order.join(),
  );
  // The slider by keyboard: one commit per key press.
  await slider.focus();
  await resetLog();
  await p.keyboard.press('ArrowRight');
  await sleep(100);
  check(
    'the zoom slider changes by keyboard, one commit per key press',
    (await commits()) === 1,
    String(await commits()),
  );
  await resetBtn.click();

  // No empty space, ever: a magenta background, dragged and zoomed hard.
  await editorAction(p, 'setBackground', '#ff00ff');
  await editorAction(p, 'setBorder', 0.01);
  await waitDrawn(p);
  await select();
  let exposed = 0;
  let sawPhoto = true;
  const scan = async (): Promise<void> => {
    await sleep(60);
    const m = await tilePixels('magenta');
    exposed += m.count;
    sawPhoto = sawPhoto && m.w > 0;
  };
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  for (let i = 0; i < 12; i++) {
    await p.mouse.wheel(0, -200);
    await sleep(15);
  }
  await scan();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const) {
    t = await markerTile();
    await p.mouse.move(t.cx, t.cy);
    await p.mouse.down();
    await p.mouse.move(t.cx + dx * 3000, t.cy + dy * 3000, { steps: 8 });
    await scan();
    await p.mouse.up();
    await sleep(40);
    await select();
    await scan();
  }
  // Zoom out and in at the corners of the tile, then drag at the corner.
  for (const [fx, fy] of [
    [0.02, 0.02],
    [0.98, 0.02],
    [0.02, 0.98],
    [0.98, 0.98],
  ] as const) {
    t = await markerTile();
    const x = t.cx + (fx - 0.5) * t.width * t.scale;
    const y = t.cy + (fy - 0.5) * t.height * t.scale;
    await p.mouse.move(x, y);
    await p.mouse.wheel(0, 3000);
    await sleep(40);
    await scan();
    await p.mouse.wheel(0, -3000);
    await sleep(40);
    await scan();
    await p.mouse.wheel(0, 3000);
    await sleep(40);
    await scan();
  }
  const finalZoom = await cropOfMarker();
  check(
    'magenta background: dragging and zooming hard never exposes it inside the tile',
    exposed === 0 && sawPhoto,
    `${String(exposed)} magenta pixels; zoom ${JSON.stringify(finalZoom)}`,
  );
  check(
    'zoom never goes below cover or above the limit (5x)',
    finalZoom === null || (finalZoom.zoom >= 1 && finalZoom.zoom <= 5),
  );
  await editorAction(p, 'setBackground', '#ffffff');
  await editorAction(p, 'setBorder', 0);
  await waitDrawn(p);
  await p.mouse.click(5, 790);
  await resetLog();
  await select();
  await resetBtn.click();

  // Crops survive Shuffle: centred on the same subject in its new tile.
  await editorAction(p, 'setCrop', markerId, { x: 0.78, y: 0.35, zoom: 3 });
  await waitDrawn(p);
  await resetLog();
  const shapes = new Set<string>();
  let shuffleOk = true;
  let detail = '';
  for (let i = 0; i < 8; i++) {
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await waitDrawn(p);
    const tile = await markerTile();
    shapes.add((tile.width / tile.height).toFixed(2));
    const red = await tilePixels('red');
    // The marker is the focal point: visible, and near the middle unless the
    // photo's edge pushed the view (it is 22% from the right edge at zoom 3).
    const ok =
      red.count > 50 &&
      red.mx > 0.15 &&
      red.mx < 0.85 &&
      red.my > 0.15 &&
      red.my < 0.85;
    if (!ok) shuffleOk = false;
    detail += ` ${tile.width}x${tile.height}:${String(red.count)}@${red.mx.toFixed(2)},${red.my.toFixed(2)}`;
  }
  const cropAfterShuffle = await cropOfMarker();
  check(
    'after Shuffle a cropped photo is still centred on the same subject (8 shuffles, marker visible in its new tile)',
    shuffleOk && shapes.size >= 3 && cropAfterShuffle?.zoom === 3,
    `${String(shapes.size)} tile shapes;${detail}`,
  );

  // A press on the selected tile, then a jump straight out of the canvas.
  await editorAction(p, 'setCrop', markerId, { x: 0.5, y: 0.5, zoom: 3 });
  await waitDrawn(p);
  await select();
  await resetLog();
  await p.evaluate(() => {
    const w = window as any;
    document
      .querySelector('.collage-canvas')!
      .addEventListener('pointerdown', (e) => {
        w.__pid = (e as PointerEvent).pointerId;
      });
  });
  let cropBeforeJump = await cropOfMarker();
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(5, 5);
  await p.mouse.up();
  await sleep(300);
  let cropAfterJump = await cropOfMarker();
  check(
    'a press on the selected tile and a jump out of the canvas still pans: crop changed, exactly one commit, tile still selected',
    JSON.stringify(cropBeforeJump) !== JSON.stringify(cropAfterJump) &&
      (await commits()) === 1 &&
      (await kind()) === 'selected',
    `${JSON.stringify(cropAfterJump)} commits ${String(await commits())} ${await kind()}`,
  );
  // A pan ended by pointercancel commits what was panned, once, and leaves
  // nothing stuck: the next drag pans normally.
  await resetLog();
  cropBeforeJump = await cropOfMarker();
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx + 30, t.cy + 20, { steps: 4 });
  await sleep(60);
  await p.evaluate(() => {
    const id = (window as any).__pid as number;
    document
      .querySelector('.collage-canvas')!
      .dispatchEvent(
        new PointerEvent('pointercancel', { pointerId: id, bubbles: true }),
      );
  });
  await p.mouse.up();
  await sleep(300);
  cropAfterJump = await cropOfMarker();
  check(
    'a pan ended by pointercancel commits once and the tile stays selected',
    JSON.stringify(cropBeforeJump) !== JSON.stringify(cropAfterJump) &&
      (await commits()) === 1 &&
      (await kind()) === 'selected',
    `commits ${String(await commits())} ${await kind()}`,
  );
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx - 30, t.cy - 20, { steps: 4 });
  await p.mouse.up();
  await sleep(300);
  check(
    'after a cancelled pan no gesture is stuck: the next drag is one more commit',
    (await commits()) === 2 &&
      !(await p.evaluate(() => (window as any).__app.editor.isDragging())),
    String(await commits()),
  );
  // Escape during a pan commits what was panned (once) and deselects.
  await select();
  await resetLog();
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx + 30, t.cy + 20, { steps: 4 });
  await sleep(60);
  await p.keyboard.press('Escape');
  await p.mouse.move(t.cx + 60, t.cy + 40, { steps: 3 });
  await p.mouse.up();
  await sleep(300);
  check(
    'Escape during a pan commits it once and deselects; the later moves and release do nothing',
    (await commits()) === 1 &&
      (await kind()) === 'idle' &&
      !(await p.evaluate(() => (window as any).__app.editor.isDragging())),
    `commits ${String(await commits())} ${await kind()}`,
  );
  await editorAction(p, 'setCrop', markerId, { x: 0.78, y: 0.35, zoom: 3 });
  await waitDrawn(p);

  // Swap into a differently shaped tile.
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await waitDrawn(p);
  const target = await p.evaluate((id) => {
    const app = (window as any).__app;
    const { tiles, state } = app.view.lastRender();
    const mine = tiles.find((t: any) => state.assignment[t.slot] === id);
    const ratio = mine.width / mine.height;
    let best: any = null;
    let bestDiff = 0;
    for (const t of tiles) {
      if (t === mine) continue;
      const diff = Math.abs(Math.log(t.width / t.height / ratio));
      if (diff > bestDiff) {
        bestDiff = diff;
        best = t;
      }
    }
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    return {
      x: r.left + ((best.x + best.width / 2) * r.width) / c.width,
      y: r.top + ((best.y + best.height / 2) * r.height) / c.height,
      diff: bestDiff,
    };
  }, markerId);
  await select();
  await resetLog();
  const shapeBefore = await markerTile();
  await menu.getByRole('button', { name: 'Swap' }).click();
  // A drag on the pending tile does nothing, and swap still works after it.
  t = await markerTile();
  const hashPending = await canvasHash();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.down();
  await p.mouse.move(t.cx + 30, t.cy + 20, { steps: 5 });
  await p.mouse.up();
  await sleep(100);
  const afterPendingDrag = await kind();
  check(
    'a drag on the tile while a swap is pending is ignored entirely: no pan, 0 commits, and the swap is still pending',
    (await commits()) === 0 &&
      (await canvasHash()) === hashPending &&
      afterPendingDrag === 'swapping',
    `${afterPendingDrag} ${String(await commits())}`,
  );
  // One click on a second tile completes the swap: no restart needed.
  await p.mouse.click(target.x, target.y);
  await waitDrawn(p);
  const shapeAfter = await markerTile();
  const redAfterSwap = await tilePixels('red');
  check(
    'swap still works: one commit, and the photo moved to a differently shaped tile',
    (await commits()) === 1 &&
      shapeAfter.slot !== shapeBefore.slot &&
      Math.abs(
        Math.log(
          shapeAfter.width /
            shapeAfter.height /
            (shapeBefore.width / shapeBefore.height),
        ),
      ) > 0.05,
    `${String(await commits())} commits, shape diff ${String(target.diff)}`,
  );
  check(
    'after a swap into a differently shaped tile the photo is still centred on the same subject',
    redAfterSwap.count > 50 &&
      redAfterSwap.mx > 0.15 &&
      redAfterSwap.mx < 0.85 &&
      redAfterSwap.my > 0.15 &&
      redAfterSwap.my < 0.85 &&
      (await cropOfMarker())?.zoom === 3,
    `${String(redAfterSwap.count)} red px @ ${redAfterSwap.mx.toFixed(2)},${redAfterSwap.my.toFixed(2)}`,
  );

  // A pending wheel burst commits before another action does.
  await select();
  await resetLog();
  t = await markerTile();
  await p.mouse.move(t.cx, t.cy);
  await p.mouse.wheel(0, -100);
  await sleep(40);
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await sleep(300);
  const order2 = await log();
  check(
    'a wheel burst still pending is committed before the next action (Shuffle): two commits, crop first',
    order2.length === 2 &&
      order2[0]!.seed !== order2[1]!.seed &&
      order2[0]!.crop.zoom > 3,
    JSON.stringify(order2),
  );
  if (process.argv.includes('--crop-screenshot')) {
    mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
    await p.mouse.click(5, 790);
    await editorAction(p, 'setCrop', markerId, { x: 0.5, y: 0.5, zoom: 1 });
    // Shuffle until the marker is visible at cover in a good-sized tile.
    for (let i = 0; i < 30; i++) {
      await p.getByRole('button', { name: 'Shuffle' }).click();
      await waitDrawn(p);
      const tile = await markerTile();
      const red = await tilePixels('red');
      if (red.count > 500 && tile.width > 300) break;
    }
    await select();
    await p.screenshot({
      path: join(root, 'docs', 'screenshots', 'issue-9-before.png'),
    });
    t = await markerTile();
    const red = await tilePixels('red');
    const zx = t.cx + (red.mx - 0.5) * t.width * t.scale;
    const zy = t.cy + (red.my - 0.5) * t.height * t.scale;
    await p.mouse.move(zx, zy);
    for (let i = 0; i < 5; i++) {
      await p.mouse.wheel(0, -120);
      await sleep(20);
    }
    await sleep(400);
    await p.mouse.down();
    await p.mouse.move(zx - 40, zy + 25, { steps: 6 });
    await p.mouse.up();
    await sleep(300);
    await p.mouse.move(5, 790);
    await p.screenshot({
      path: join(root, 'docs', 'screenshots', 'issue-9-after.png'),
    });
  }
  await ctx.close();
}

/** Panning and zooming a big tile with 100 photos in the collage. */
async function checkCropPerformance(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles(
    'input[type=file]',
    await makeSyntheticPhotos(p, 100, 1.5),
  );
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 100,
    undefined,
    { timeout: 60000 },
  );
  await waitDrawn(p, 60000);
  await setDial(p, 1);
  await waitDrawn(p, 60000);
  const tile = await p.evaluate(() => {
    const app = (window as any).__app;
    const { tiles } = app.view.lastRender();
    const t = [...tiles].sort(
      (a: any, b: any) => b.width * b.height - a.width * a.height,
    )[0];
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    return {
      x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
      y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
    };
  });
  await p.mouse.click(tile.x, tile.y);
  await p.evaluate(() => {
    const w = window as any;
    w.__frames = [];
    let last = performance.now();
    const loop = (now: number): void => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await p.mouse.wheel(0, -600);
  await p.waitForTimeout(100);
  await p.mouse.move(tile.x, tile.y);
  await p.mouse.down();
  for (let i = 0; i < 90; i++) {
    await p.mouse.move(
      tile.x + Math.sin(i / 8) * 80,
      tile.y + Math.cos(i / 8) * 60,
    );
  }
  await p.mouse.up();
  const frames = await p.evaluate(() => {
    (window as any).__stop = true;
    return [...((window as any).__frames as number[])].slice(2);
  });
  frames.sort((a, b) => a - b);
  const median = frames[Math.floor(frames.length / 2)]!;
  const p95 = frames[Math.floor(frames.length * 0.95)]!;
  console.log(
    `INFO  100 photos, pan and zoom of the largest tile: ${String(frames.length)} frames, median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
  );
  check(
    'panning and zooming a large tile with 100 photos stays smooth (median frame under 25 ms)',
    median < 25,
    `median ${median.toFixed(1)} ms`,
  );
  await ctx.close();
}

/** Instruments the page: every committed editor change, and each photo added. */
function watchImport(p: Page): Promise<void> {
  return p.evaluate(() => {
    const w = window as any;
    const { editor, store } = w.__app;
    const base = editor.getState();
    w.__imp = {
      base,
      commits: 0,
      commitPhotos: [] as number[],
      adds: 0,
      changedMidImport: false,
      progressSeen: 0,
      samples: 0,
    };
    editor.subscribe((state: any, change: any) => {
      if (change.transient) return;
      w.__imp.commits++;
      w.__imp.commitPhotos.push(state.photos.length);
    });
    store.subscribe((c: any) => {
      if (c.kind !== 'added') return;
      w.__imp.adds += c.ids.length;
      if (editor.getState() !== w.__imp.base) w.__imp.changedMidImport = true;
    });
    const bar = document.querySelector<HTMLElement>('.progress')!;
    const tick = () => {
      if (!bar.hidden) w.__imp.progressSeen++;
      w.__imp.samples++;
      w.__imp.raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Imports lay the collage out once, when the whole batch is in (issue #35). */
async function checkImportOnce(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(origin);
  await p.waitForSelector('.tray');
  const named = (files: SyntheticPhoto[], prefix: string): SyntheticPhoto[] =>
    files.map((f) => ({ ...f, name: `${prefix}-${f.name}` }));
  const state = (): Promise<any> => p.evaluate(() => (window as any).__imp);

  // 1. Fifty photos into an empty app: one commit, at the end.
  await watchImport(p);
  await p.setInputFiles(
    'input[type=file]',
    named(await makeSyntheticPhotos(p, 50, 0.5), 'a'),
  );
  await p.waitForFunction(
    () => (window as any).__app.store.getPhotos().length === 50,
    undefined,
    { timeout: 60000 },
  );
  await waitDrawn(p);
  let s = await state();
  check(
    '#35: 50 photos into an empty app give exactly one committed editor change',
    s.commits === 1 && s.commitPhotos[0] === 50,
    JSON.stringify(s.commitPhotos),
  );
  check(
    '#35: the editor never changed while the photos were arriving',
    s.adds === 50 && !s.changedMidImport,
  );
  check(
    '#35: the progress indicator was visible during the import',
    s.progressSeen > 0,
    `${String(s.progressSeen)} of ${String(s.samples)} frames`,
  );

  // 2. Twenty more into a showing collage: nothing moves until the end.
  const before = await canvasPixels(p);
  const stateBefore = await p.evaluate(() => {
    const e = (window as any).__app.editor.getState();
    return JSON.stringify([e.seed, e.assignment, e.plan]);
  });
  await p.evaluate(() => {
    const w = window as any;
    cancelAnimationFrame(w.__imp.raf);
    w.__samples = [];
    w.__baseState = w.__app.editor.getState();
    w.__baseCommits = w.__imp.commits;
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const sig = () => {
      const d = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]!) | 0;
      return h;
    };
    w.__sig0 = sig();
    w.__dim0 = `${String(canvas.width)}x${String(canvas.height)}`;
    const bar = document.querySelector<HTMLElement>('.progress')!;
    const tick = () => {
      w.__samples.push({
        photos: w.__app.store.getPhotos().length,
        same: w.__app.editor.getState() === w.__baseState,
        // The tray's scrollbar can narrow the canvas by a few pixels as it
        // fills; that redraws the same arrangement at another size.
        sig:
          `${String(canvas.width)}x${String(canvas.height)}` !== w.__dim0 ||
          sig() === w.__sig0,
        drawnSame: w.__app.view.lastRender()?.state === w.__baseState,
        busy: !bar.hidden,
        dim: `${String(canvas.width)}x${String(canvas.height)}`,
      });
      w.__imp.raf = requestAnimationFrame(tick);
    };
    tick();
  });
  await p.setInputFiles(
    'input[type=file]',
    named(await makeSyntheticPhotos(p, 20, 0.5), 'b'),
  );
  await p.waitForFunction(
    () => (window as any).__app.store.getPhotos().length === 70,
    undefined,
    { timeout: 60000 },
  );
  await waitDrawn(p);
  const mid = await p.evaluate(() => {
    const w = window as any;
    const during = w.__samples.filter(
      (x: any) => x.busy && x.photos < 70 && x.photos > 50,
    );
    return {
      during: during.length,
      allSame: during.every((x: any) => x.same && x.drawnSame && x.sig),
      dims: [...new Set(w.__samples.map((x: any) => x.dim))].join(' '),
      stateSame: during.every((x: any) => x.same && x.drawnSame),
      pixelsSame: during.every((x: any) => x.sig),
      commits: w.__imp.commits - w.__baseCommits,
      progress: w.__samples.filter((x: any) => x.busy).length,
      photos: w.__app.editor.getState().photos.length,
    };
  });
  s = await state();
  check(
    '#35: 20 more photos leave the showing collage (state and canvas pixels) unchanged until the batch completes',
    mid.during > 0 && mid.allSame,
    `${String(mid.during)} frames sampled mid-import; state ${String(mid.stateSame)}, pixels ${String(mid.pixelsSame)}, canvas ${mid.dims}`,
  );
  check(
    '#35: then the collage re-rolls exactly once, with all 70',
    mid.commits === 1 && mid.photos === 70 && s.commitPhotos.at(-1) === 70,
    `commits ${String(mid.commits)}`,
  );
  const stateAfter = await p.evaluate(() => {
    const e = (window as any).__app.editor.getState();
    return JSON.stringify([e.seed, e.assignment, e.plan]);
  });
  check(
    '#35: the final arrangement differs from the one before the import',
    stateAfter !== stateBefore &&
      (await canvasPixels(p)).join() !== before.join(),
  );
  check(
    '#35: the tray count shows every photo selected during and after',
    (await p.evaluate(() => (window as any).__app.store.getSelectedCount())) ===
      70,
  );

  // 3. Some files that cannot be decoded: still one layout, at the end.
  const good = named(await makeSyntheticPhotos(p, 6, 0.5), 'c');
  const bad = [1, 2, 3].map((n) => ({
    name: `broken-${String(n)}.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(`not an image ${String(n)}`),
  }));
  await p.evaluate(() => {
    const w = window as any;
    w.__baseCommits = w.__imp.commits;
    w.__baseCount = w.__app.editor.getState().photos.length;
  });
  await p.setInputFiles('input[type=file]', [
    ...bad.slice(0, 1),
    ...good,
    ...bad.slice(1),
  ]);
  await p.waitForFunction(
    () => (window as any).__app.store.getPhotos().length === 76,
    undefined,
    { timeout: 60000 },
  );
  await waitDrawn(p);
  const partial = await p.evaluate(() => {
    const w = window as any;
    return {
      commits: w.__imp.commits - w.__baseCommits,
      photos: w.__app.editor.getState().photos.length,
    };
  });
  check(
    '#35: an import with undecodable files re-rolls once, with what was added',
    partial.commits === 1 && partial.photos === 76,
    JSON.stringify(partial),
  );

  // 4. Every file fails: no re-roll at all.
  await p.evaluate(() => {
    const w = window as any;
    w.__baseCommits = w.__imp.commits;
  });
  await p.setInputFiles(
    'input[type=file]',
    bad.map((f) => ({ ...f, name: `again-${f.name}` })),
  );
  await p.waitForSelector('.notice');
  await p.waitForFunction(
    () => document.querySelector<HTMLElement>('.progress')!.hidden,
  );
  await p.waitForTimeout(300);
  check(
    '#35: an import where every file fails causes no re-roll',
    (await state()).commits - 0 ===
      (await p.evaluate(() => (window as any).__baseCommits)),
  );
  check('#35: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/** Include changes during an import wait for it, and say so once (issue #35). */
async function checkDeferredSelection(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(origin);
  await p.waitForSelector('.tray');
  const named = (files: SyntheticPhoto[], prefix: string): SyntheticPhoto[] =>
    files.map((f) => ({ ...f, name: `${prefix}-${f.name}` }));
  await p.setInputFiles(
    'input[type=file]',
    named(await makeSyntheticPhotos(p, 6, 0.5), 'a'),
  );
  await p.waitForFunction(
    () => (window as any).__app.store.getPhotos().length === 6,
  );
  await waitDrawn(p);
  const message = 'Changes to the selection apply when the import finishes.';
  const toasts = (): Promise<number> =>
    p.locator('.notice', { hasText: message }).count();
  const live = (): Promise<string> =>
    p.evaluate(
      () =>
        document.querySelector('.sr-only[aria-live=polite]')?.textContent ?? '',
    );
  const shown = (): Promise<string> =>
    p.evaluate(() =>
      JSON.stringify(
        (window as any).__app.editor.getState().photos.map((x: any) => x.id),
      ),
    );

  // Start a long import (60 photos) and act while it runs.
  const more = named(await makeSyntheticPhotos(p, 60, 0.5), 'b');
  await p.setInputFiles('input[type=file]', more);
  await p.waitForFunction(
    () => (window as any).__app.store.getPhotos().length > 8,
  );
  const before = await shown();
  const midImport = (): Promise<boolean> =>
    p.evaluate(
      () =>
        !document.querySelector<HTMLElement>('.progress')!.hidden &&
        (window as any).__app.store.getPhotos().length < 66,
    );
  check(
    '#35: the import is still running for the selection checks',
    await midImport(),
  );

  // Tile Remove: the screen reader is told it waits, not that it was removed.
  const target = await p.evaluate(() => {
    const { tiles } = (window as any).__app.view.lastRender();
    const t = tiles[0];
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    return {
      x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
      y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
    };
  });
  await p.mouse.click(target.x, target.y);
  await p.locator('.tile-menu').getByRole('button', { name: 'Remove' }).click();
  check(
    '#35: tile Remove during an import announces that it waits',
    (await live()) === message,
    await live(),
  );
  check(
    '#35: and shows one toast, with the collage unchanged',
    (await toasts()) === 1 && (await shown()) === before,
  );
  // A tray toggle, Remove all and Add all: still one toast for this import.
  await p.getByRole('button', { name: 'Remove all' }).click();
  await p.getByRole('button', { name: 'Add all to collage' }).click();
  check(
    '#35: other include changes in the same import add no second toast',
    (await toasts()) === 1 && (await shown()) === before && (await midImport()),
  );

  await p.waitForFunction(
    () => document.querySelector<HTMLElement>('.progress')!.hidden,
    undefined,
    { timeout: 60000 },
  );
  await waitDrawn(p);
  check(
    '#35: when the import finishes the selection applies (everything added back)',
    (await p.evaluate(
      () => (window as any).__app.editor.getState().photos.length,
    )) === 66,
  );

  check(
    '#35: no page errors in the selection checks',
    errors.length === 0,
    errors.join(' | '),
  );
  await ctx.close();
}

/** The collage canvas's pixels. */
function canvasPixels(p: Page): Promise<number[]> {
  return p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    return [...c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data];
  });
}

/** Undo and redo (issue #10), in real Chrome. */
async function checkUndo(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles('input[type=file]', await makeSyntheticPhotos(p, 8));
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 8,
  );
  await waitDrawn(p);
  check(
    'undo toast: the first import (empty history) shows no history notice',
    (await p.locator('.notice', { hasText: 'undo history' }).count()) === 0,
  );
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_s: unknown, c: { transient: boolean }) => {
      if (!c.transient) w.__commits++;
    });
  });
  const commitCount = (): Promise<number> =>
    p.evaluate(() => (window as any).__commits);
  const mac = await p.evaluate(() =>
    /mac|iphone|ipad/i.test(navigator.platform),
  );
  const mod = mac ? 'Meta' : 'Control';
  const snap = (): Promise<string> =>
    p.evaluate(() => JSON.stringify((window as any).__app.editor.getState()));
  const arr = (): Promise<string> => arrangementOf(p);
  const pixelHash = (): Promise<number> =>
    stableHash(p, () =>
      p.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
        const d = c
          .getContext('2d')!
          .getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (const v of d) h = (h * 31 + v) | 0;
        return h;
      }),
    );
  /** The tray and the editor name the same included photos. */
  const agree = (): Promise<boolean> =>
    p.evaluate(() => {
      const a = (window as any).__app;
      const ids: string[] = a.store.getIncludedIds();
      const st = a.editor.getState();
      const ticked = document.querySelectorAll(
        '.thumb[aria-pressed="true"]',
      ).length;
      const total = a.store.getTotalCount();
      const text = document.querySelector('.tray-count')?.textContent ?? '';
      return (
        ids.length === st.photos.length &&
        ids.every((id) => st.photos.some((ph: any) => ph.id === id)) &&
        ticked === ids.length &&
        text === `${String(ids.length)} / ${String(total)} selected` &&
        !a.editor.isDragging()
      );
    });
  const undoBtn = p.getByRole('button', { name: 'Undo', exact: true });
  const redoBtn = p.getByRole('button', { name: 'Redo', exact: true });
  const settle = async (): Promise<void> => {
    await p.waitForTimeout(120);
    // An empty collage draws nothing to wait for.
    if (JSON.parse(await snap()).photos.length > 0) await waitDrawn(p);
  };
  const centre = (slot: number): Promise<{ x: number; y: number }> =>
    p.evaluate((slot) => {
      const { tiles } = (window as any).__app.view.lastRender();
      const t = tiles.find((t: any) => t.slot === slot);
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const r = c.getBoundingClientRect();
      return {
        x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
        y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
      };
    }, slot);
  const clickTile = async (slot: number): Promise<void> => {
    const { x, y } = await centre(slot);
    await p.mouse.click(x, y);
  };
  const selectionKind = (): string =>
    (window as any).__app.selection.getSelection().kind;
  const swapUi = async (a: number, b: number): Promise<void> => {
    // Start from no selection (a click on a selected tile would deselect it
    // instead of selecting it), and wait for each step of the selection
    // before the next click rather than clicking on a timer.
    if ((await p.evaluate(selectionKind)) !== 'idle') {
      await p.mouse.click(5, 790);
      await p.waitForFunction(
        () => (window as any).__app.selection.getSelection().kind === 'idle',
      );
    }
    await clickTile(a);
    await p.locator('.tile-menu').getByRole('button', { name: 'Swap' }).click();
    await p.waitForFunction(
      () => (window as any).__app.selection.getSelection().kind === 'swapping',
    );
    await clickTile(b);
    await p.waitForFunction(
      () => (window as any).__app.selection.getSelection().kind !== 'swapping',
    );
    await settle();
  };
  const sel = (): Promise<string> =>
    p.evaluate(() => (window as any).__app.selection.getSelection().kind);
  const live = (): Promise<string> =>
    p.evaluate(
      () => document.querySelector('.sr-only[role=status]')?.textContent ?? '',
    );

  check(
    'undo: Undo and Redo buttons start disabled, with shortcut tooltips',
    (await undoBtn.isDisabled()) &&
      (await redoBtn.isDisabled()) &&
      ((await undoBtn.getAttribute('title')) ?? '').includes(
        mac ? 'Cmd+Z' : 'Ctrl+Z',
      ) &&
      ((await redoBtn.getAttribute('title')) ?? '').includes(
        mac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
      ),
  );

  // Dragging the dial is one step.
  const start = await snap();
  const box = (await p.locator('#size-variation').boundingBox())!;
  const y = box.y + box.height / 2;
  await p.mouse.move(box.x + 2, y);
  await p.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await p.mouse.move(box.x + 2 + ((box.width - 4) * i) / 20, y);
    await p.waitForTimeout(16);
  }
  // A pointer is held mid-drag: Undo is rejected, the drag carries on.
  const midDrag = await snap();
  const commitsMid = await commitCount();
  await p.keyboard.press(`${mod}+z`);
  await p.keyboard.press(`${mod}+Shift+z`);
  check(
    'undo (held): Cmd/Ctrl+Z mid dial drag does nothing; both buttons are disabled',
    (await snap()) === midDrag &&
      (await commitCount()) === commitsMid &&
      (await undoBtn.isDisabled()) &&
      (await redoBtn.isDisabled()) &&
      (await live()) !== 'Undone.',
  );
  await p.mouse.move(box.x + 2 + (box.width - 4) * 0.9, y);
  await p.mouse.up();
  await settle();
  check(
    'undo (held): the drag commits exactly once on release',
    (await commitCount()) === commitsMid + 1 && (await undoBtn.isEnabled()),
  );
  const afterDial = await snap();
  check('undo: the dial drag changed the state', afterDial !== start);
  await undoBtn.click();
  await settle();
  check(
    'undo: dragging the dial is a single undo step',
    (await snap()) === start && (await undoBtn.isDisabled()),
  );
  check(
    'undo: the dial control follows the restored state',
    (await p.locator('#size-variation').inputValue()) ===
      String(JSON.parse(start).variation),
  );
  check('undo: announces the step', (await live()) === 'Undone.');
  check(
    'undo: focus moved to a visible button when Undo became disabled',
    await p.evaluate(() => document.activeElement?.textContent === 'Redo'),
  );
  await redoBtn.click();
  await settle();
  check('redo: restores the dial drag', (await snap()) === afterDial);
  check(
    'redo: focus moved to Undo when Redo became disabled',
    await p.evaluate(() => document.activeElement?.textContent === 'Undo'),
  );

  // Swap several tiles, then Shuffle: one undo restores the arrangement.
  await swapUi(0, 1);
  await swapUi(2, 3);
  await swapUi(4, 5);
  const swapped = await arr();
  const swappedSnap = await snap();
  const swappedPixels = await pixelHash();
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await settle();
  check('undo: Shuffle changed the arrangement', (await arr()) !== swapped);
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: one undo after Shuffle restores the swapped arrangement exactly',
    (await arr()) === swapped && (await snap()) === swappedSnap,
  );
  check(
    'undo: the canvas pixels match the swapped arrangement',
    (await pixelHash()) === swappedPixels,
  );
  await p.keyboard.press(`${mod}+Shift+z`);
  await settle();
  check('redo: Shift+Cmd/Ctrl+Z redoes the Shuffle', (await arr()) !== swapped);
  await p.keyboard.press(`${mod}+z`);
  await settle();
  if (!mac) {
    await p.keyboard.press('Control+y');
    await settle();
    check('redo: Ctrl+Y redoes on non-Mac', (await arr()) !== swapped);
    await p.keyboard.press(`${mod}+z`);
    await settle();
  }

  // Undo and redo for a swap.
  const beforeSwap = await snap();
  await swapUi(0, 2);
  const afterSwap = await snap();
  check(
    'undo: a swap changed the state',
    afterSwap !== beforeSwap,
    `selection ${await sel()}`,
  );
  await undoBtn.click();
  await settle();
  check('undo: undoes a swap', (await snap()) === beforeSwap);
  await redoBtn.click();
  await settle();
  check('redo: redoes a swap', (await snap()) === afterSwap);

  // Selection and a pending swap are cleared by undo.
  await clickTile(1);
  await p.locator('.tile-menu').getByRole('button', { name: 'Swap' }).click();
  check('undo: a swap is pending', (await sel()) === 'swapping');
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: clears the tile selection and the pending swap',
    (await sel()) === 'idle' &&
      (await p.locator('.tile-menu:visible').count()) === 0,
  );
  await p.keyboard.press(`${mod}+Shift+z`);
  await settle();

  // Crop: a wheel burst, then undo and redo.
  const cropOf = (): Promise<string> =>
    p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState().crops),
    );
  const cropBefore = await cropOf();
  await clickTile(0);
  const c0 = await centre(0);
  await p.mouse.move(c0.x, c0.y);
  for (let i = 0; i < 4; i++) {
    await p.mouse.wheel(0, -120);
    await p.waitForTimeout(20);
  }
  await p.waitForTimeout(400);
  const cropZoomed = await cropOf();
  check('undo: wheel zoom changed the crop', cropZoomed !== cropBefore);
  await undoBtn.click();
  await settle();
  check('undo: undoes a crop zoom', (await cropOf()) === cropBefore);
  await redoBtn.click();
  await settle();
  check('redo: redoes a crop zoom', (await cropOf()) === cropZoomed);
  // Reset is a step too.
  await clickTile(0);
  await p.locator('.tile-menu').getByRole('button', { name: 'Reset' }).click();
  check(
    'undo: Reset restored the default crop',
    (await cropOf()) === cropBefore,
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check('undo: undoes a crop Reset', (await cropOf()) === cropZoomed);

  // A crop pan with the pointer held: Undo is rejected; one commit on release.
  await clickTile(0);
  const prePan = await snap();
  const pc = await centre(0);
  const panCommits = await commitCount();
  await p.mouse.move(pc.x, pc.y);
  await p.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await p.mouse.move(pc.x + i * 6, pc.y + i * 2);
    await p.waitForTimeout(30);
  }
  await p.waitForTimeout(60);
  const midPan = await snap();
  await p.keyboard.press(`${mod}+z`);
  await p.keyboard.press(`${mod}+Shift+z`);
  check(
    'undo (held): Cmd/Ctrl+Z mid crop pan does nothing; both buttons are disabled',
    (await snap()) === midPan &&
      midPan !== prePan &&
      (await commitCount()) === panCommits &&
      (await undoBtn.isDisabled()) &&
      (await redoBtn.isDisabled()),
    `moved ${String(midPan !== prePan)} commits ${String((await commitCount()) - panCommits)} undoDisabled ${String(await undoBtn.isDisabled())} redoDisabled ${String(await redoBtn.isDisabled())}`,
  );
  await p.mouse.up();
  await settle();
  check(
    'undo (held): the pan commits exactly once on release, as one step',
    (await commitCount()) === panCommits + 1 && (await undoBtn.isEnabled()),
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo (held): one undo reverts the whole pan',
    (await snap()) === prePan && (await cropOf()) === cropZoomed,
  );

  // An uncommitted wheel burst pending when Undo is pressed.
  await p.keyboard.press(`${mod}+z`); // back to the default crop
  await settle();
  await clickTile(0);
  const base = await snap();
  const c1 = await centre(0);
  await p.mouse.move(c1.x, c1.y);
  await p.mouse.wheel(0, -200);
  await p.waitForTimeout(40); // well inside the 250 ms burst window
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: a pending wheel burst is committed, then undone (not lost, not stuck)',
    (await snap()) === base &&
      !(await p.evaluate(() => (window as any).__app.editor.isDragging())),
  );
  check('undo: that burst can be redone', await redoBtn.isEnabled());
  await p.keyboard.press(`${mod}+Shift+z`);
  await settle();
  check(
    'redo: restores the burst the undo had committed',
    (await cropOf()) !== cropBefore,
  );
  await p.waitForTimeout(400); // the stale burst timer must not commit again
  check(
    'undo: no stray commit after the burst timer',
    (await undoBtn.isEnabled()) && (await redoBtn.isDisabled()),
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();

  // A drag left unfinished (the colour picker closed on its colour).
  const bgBefore = await snap();
  await p.evaluate(async (module) => {
    const { setBackground } = await import(/* @vite-ignore */ module);
    (window as any).__app.editor.drag((s: unknown) =>
      setBackground(s, '#123456'),
    );
  }, STATE_MODULE);
  check(
    'undo: store is mid-gesture and Undo is available',
    await undoBtn.isEnabled(),
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: an unfinished gesture is committed as its own step then undone',
    (await snap()) === bgBefore && (await redoBtn.isEnabled()),
  );
  await p.keyboard.press(`${mod}+Shift+z`);
  await settle();
  check(
    'redo: the unfinished gesture comes back',
    JSON.parse(await snap()).canvas.background === '#123456',
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();

  // Removal.
  const beforeRemove = await snap();
  await clickTile(3);
  await p.locator('.tile-menu').getByRole('button', { name: 'Remove' }).click();
  await settle();
  const afterRemove = await snap();
  check(
    'undo: Remove took a photo out',
    JSON.parse(afterRemove).photos.length === 7 && (await agree()),
  );
  await undoBtn.click();
  await settle();
  check(
    'undo: undoes a removal (tray ticks it again)',
    (await snap()) === beforeRemove && (await agree()),
  );
  await redoBtn.click();
  await settle();
  check(
    'redo: redoes a removal',
    (await snap()) === afterRemove && (await agree()),
  );
  await undoBtn.click();
  await settle();

  // Typing in the width field keeps the browser's own undo.
  await p.evaluate(() => {
    const w = window as any;
    w.__prevented = [];
    window.addEventListener('keydown', (e) =>
      w.__prevented.push(e.defaultPrevented),
    );
  });
  const field = p.locator('#size-width');
  const fieldBefore = await field.inputValue();
  const stateBeforeTyping = await snap();
  await field.click();
  await p.keyboard.type('99');
  await p.keyboard.press(`${mod}+z`);
  const prevented = await p.evaluate(() => (window as any).__prevented.at(-1));
  check(
    'shortcut: Cmd/Ctrl+Z is left to the browser in the width field',
    prevented === false &&
      (await snap()) === stateBeforeTyping &&
      (await undoBtn.isEnabled()),
    `field ${fieldBefore} -> ${await field.inputValue()}`,
  );
  await p.keyboard.press('Escape');
  await p.locator('.canvas-area').click({ position: { x: 3, y: 3 } });

  // Remove all, then undo.
  const beforeAll = await snap();
  const beforeAllArr = await arr();
  await p.getByRole('button', { name: 'Remove all' }).click();
  await settle();
  check(
    'undo: Remove all emptied the collage',
    JSON.parse(await snap()).photos.length === 0,
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: Remove all undone: every photo ticked in the tray, same arrangement',
    (await snap()) === beforeAll &&
      (await arr()) === beforeAllArr &&
      (await agree()) &&
      (await p.locator('.thumb[aria-pressed="true"]').count()) === 8,
  );
  // A long random sequence, then undo everything and redo everything.
  await p.evaluate(() => {
    const w = window as any;
    w.__hist = [JSON.stringify(w.__app.editor.getState())];
    w.__app.editor.subscribe((s: unknown, c: any) => {
      if (!c.transient && !c.restored) w.__hist.push(JSON.stringify(s));
    });
  });
  await p.evaluate(async (module) => {
    (window as any).__act = await import(/* @vite-ignore */ module);
  }, STATE_MODULE);
  let seedRng = 12345;
  const rnd = (): number => {
    seedRng = (seedRng * 1664525 + 1013904223) % 4294967296;
    return seedRng / 4294967296;
  };
  const thumbs = p.locator('.thumb');
  const tryClick = async (name: string): Promise<void> => {
    const b = p.getByRole('button', { name, exact: true });
    if (await b.isEnabled()) await b.click();
  };
  for (let i = 0; i < 40; i++) {
    const r = Math.floor(rnd() * 11);
    const slot = Math.floor(rnd() * 4);
    if (r === 0) await tryClick('Shuffle');
    else if (r === 1) await setDial(p, Math.round(rnd() * 100) / 100);
    else if (r === 2)
      await p.evaluate((n) => {
        const a = (window as any).__app;
        const s = a.editor.getState();
        const x = n % s.assignment.length;
        const z = (n + 1) % s.assignment.length;
        a.editor.dispatch((st: any) =>
          (window as any).__act.swapTiles(st, x, z),
        );
      }, slot);
    else if (r === 3)
      await p.evaluate((f) => {
        const a = (window as any).__app;
        const id = a.editor.getState().assignment[0];
        if (id !== undefined)
          a.editor.dispatch((st: any) =>
            (window as any).__act.setCrop(st, id, {
              x: f,
              y: 1 - f,
              zoom: 1 + f * 2,
            }),
          );
      }, rnd() * 0.8);
    else if (r === 4)
      await p.evaluate(
        (f) =>
          (window as any).__app.editor.dispatch((st: any) =>
            (window as any).__act.setBorder(st, f),
          ),
        Math.round(rnd() * 20) / 1000,
      );
    else if (r === 5)
      await p.evaluate(
        (c) =>
          (window as any).__app.editor.dispatch((st: any) =>
            (window as any).__act.setBackground(st, c),
          ),
        `#${Math.floor(rnd() * 0xffffff)
          .toString(16)
          .padStart(6, '0')}`,
      );
    else if (r === 6)
      await p
        .locator('.preset')
        .nth(Math.floor(rnd() * 11))
        .click();
    else if (r === 7) await thumbs.nth(Math.floor(rnd() * 8)).click();
    else if (r === 8) await tryClick('Remove all');
    else if (r === 9) await tryClick('Add all to collage');
    else if (
      (await p.evaluate(
        () => (window as any).__app.editor.getState().assignment.length,
      )) > 0
    ) {
      await clickTile(0);
      await p
        .locator('.tile-menu')
        .getByRole('button', { name: 'Remove' })
        .click();
    }
    await settle();
    if (!(await agree())) {
      check(
        'undo: tray and editor agree during the random run',
        false,
        `step ${String(i)}`,
      );
      break;
    }
    // Keep a collage to work on.
    if (JSON.parse(await snap()).photos.length < 3) {
      await tryClick('Add all to collage');
      await settle();
    }
  }
  const hist: string[] = await p.evaluate(() => (window as any).__hist);
  let ok = true;
  let bad = '';
  for (let k = hist.length - 1; k >= 1; k--) {
    await p.keyboard.press(`${mod}+z`);
    await settle();
    if ((await snap()) !== hist[k - 1] || !(await agree())) {
      ok = false;
      bad = `undo to ${String(k - 1)}`;
      break;
    }
  }
  check(
    `undo: ${String(hist.length - 1)} mixed actions undone one by one return to the exact start snapshot, tray and editor agreeing`,
    ok && hist.length > 25 && (await snap()) === hist[0],
    bad || `${String(hist.length - 1)} commits`,
  );
  ok = true;
  for (let k = 1; k < hist.length; k++) {
    await p.keyboard.press(`${mod}+Shift+z`);
    await settle();
    if ((await snap()) !== hist[k] || !(await agree())) {
      ok = false;
      bad = `redo to ${String(k)}`;
      break;
    }
  }
  check(
    'redo: redoing everything returns to the exact end snapshot, tray and editor agreeing',
    ok && (await snap()) === hist.at(-1) && (await redoBtn.isDisabled()),
    bad,
  );

  // A new change clears redo.
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check('redo: available after an undo', await redoBtn.isEnabled());
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await settle();
  check('redo: cleared by a new change', await redoBtn.isDisabled());

  // Import is a boundary; undo pressed during an import never throws.
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await settle();
  check('undo: history exists before an import', await undoBtn.isEnabled());
  await p.setInputFiles(
    'input[type=file]',
    (await makeSyntheticPhotos(p, 3)).map((f, i) => ({
      ...f,
      name: `extra-${String(i)}.jpg`,
    })),
  );
  for (let i = 0; i < 4; i++) {
    await p.keyboard.press(`${mod}+z`);
    await p.waitForTimeout(10);
  }
  await p.waitForFunction(
    () => (window as any).__app.store.getTotalCount() === 11,
  );
  await settle();
  check(
    'undo toast: an import that clears a non-empty history says so',
    (await p
      .locator('.notice', {
        hasText: 'Adding photos cleared the undo history.',
      })
      .count()) === 1,
  );
  while ((await p.locator('.notice button').count()) > 0) {
    await p.locator('.notice button').first().click();
  }
  check(
    'undo: an import is a boundary and undo around it left tray and editor agreeing',
    (await agree()) &&
      JSON.parse(await snap()).photos.length ===
        (await p.evaluate(
          () => (window as any).__app.store.getIncludedIds().length,
        )),
  );
  await p.keyboard.press(`${mod}+z`);
  await settle();
  const total = await p.evaluate(() =>
    (window as any).__app.store.getTotalCount(),
  );
  check(
    'undo: after an import, undo never reaches back across it',
    total === 11 && (await agree()) && (await undoBtn.isDisabled()),
  );
  // History is empty now: another import must not show the notice.
  await p.setInputFiles(
    'input[type=file]',
    (await makeSyntheticPhotos(p, 1)).map((f) => ({
      ...f,
      name: 'more-0.jpg',
    })),
  );
  await p.waitForFunction(
    () => (window as any).__app.store.getTotalCount() === 12,
  );
  await settle();
  check(
    'undo toast: an import into an empty history shows no notice',
    (await p.locator('.notice', { hasText: 'undo history' }).count()) === 0 &&
      (await agree()),
  );
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await settle();
  const afterImportShuffle = await snap();
  await p.keyboard.press(`${mod}+z`);
  await settle();
  check(
    'undo: steps after an import work, keeping the imported photos',
    (await snap()) !== afterImportShuffle && (await agree()),
  );
  await p.keyboard.press(`${mod}+Shift+z`);
  await settle();
  check(
    'undo: no console or page errors',
    errors.length === 0,
    errors.join(' | '),
  );

  if (process.argv.includes('--undo-screenshot')) {
    mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
    await p.mouse.move(640, 700);
    await p.screenshot({
      path: join(root, 'docs', 'screenshots', 'issue-10-undo.png'),
      clip: { x: 0, y: 0, width: 1280, height: 600 },
    });
  }
  await ctx.close();
}

/** One photo's worth of encoded bytes for setInputFiles. */
interface EncodedPhoto {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Photos of `width` × `height` pixels covered in fine vertical stripes (2 px
 * dark, 2 px light), which a 1024 px preview of them cannot show: scaled by
 * a quarter they blur to flat grey, so a tile drawn from the preview shows
 * no stripes, and a tile drawn from the original does.
 */
async function makeDetailPhotos(
  p: Page,
  count: number,
  width: number,
  height: number,
): Promise<EncodedPhoto[]> {
  const encoded = await p.evaluate(
    async ({ count, width, height }) => {
      const out: { name: string; data: string }[] = [];
      for (let i = 0; i < count; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = `hsl(${String((i * 43) % 360)} 50% 90%)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = `hsl(${String((i * 43) % 360)} 60% 12%)`;
        for (let x = 0; x < width; x += 4) ctx.fillRect(x, 0, 2, height);
        const blob = await new Promise<Blob>((res) => {
          canvas.toBlob(
            (b) => {
              res(b!);
            },
            'image/jpeg',
            0.95,
          );
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let k = 0; k < bytes.length; k += 8192) {
          bin += String.fromCharCode(...bytes.subarray(k, k + 8192));
        }
        out.push({ name: `detail-${String(i)}.jpg`, data: btoa(bin) });
      }
      return out;
    },
    { count, width, height },
  );
  return encoded.map((e) => ({
    name: e.name,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(e.data, 'base64'),
  }));
}

interface CacheStatsSnapshot {
  bytes: number;
  budget: number;
  peakBytes: number;
  detailDecodes: number;
}

/** The image cache's accounting, or null before it was exposed (#27). */
function cacheStats(p: Page): Promise<CacheStatsSnapshot | null> {
  return p.evaluate(() => {
    const view = (window as any).__app.view;
    return typeof view.imageCacheStats === 'function'
      ? view.imageCacheStats()
      : null;
  });
}

/**
 * Large tiles are sharp (#27): with 8 detailed photos at the dial's maximum
 * on a 2560 × 1440 window at pixel ratio 2, the largest tile is bigger than
 * its 1024 px preview, and once everything has settled its canvas pixels
 * still show the photo's fine stripes.
 */
async function checkSharpTiles(
  browser: import('playwright-core').Browser,
  screenshots?: string,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles(
    'input[type=file]',
    await makeDetailPhotos(p, 8, 4000, 3000),
  );
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 8,
    undefined,
    { timeout: 60000 },
  );
  await setDial(p, 1);
  await waitDrawn(p, 60000);
  const m = await p.evaluate(() => {
    const app = (window as any).__app;
    const last = app.view.lastRender();
    const t = [...last.tiles].sort(
      (a: any, b: any) => b.width * b.height - a.width * a.height,
    )[0];
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    // Mean absolute difference of neighbouring pixels across the middle of
    // the tile: about 0 for a smooth image, large for 2 px stripes.
    const w = Math.min(400, Math.floor(t.width / 2));
    const h = Math.min(200, Math.floor(t.height / 2));
    const x0 = Math.floor(t.x + (t.width - w) / 2);
    const y0 = Math.floor(t.y + (t.height - h) / 2);
    const d = c.getContext('2d')!.getImageData(x0, y0, w, h).data;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x + 1 < w; x++) {
        const i = (y * w + x) * 4 + 1;
        sum += Math.abs(d[i]! - d[i + 4]!);
        n++;
      }
    }
    return { tileW: t.width, tileH: t.height, score: sum / n };
  });
  console.log(
    `INFO  largest tile ${String(m.tileW)} x ${String(m.tileH)} device px (preview 1024 px): neighbour contrast ${m.score.toFixed(1)} of 255 after settling`,
  );
  check(
    'sharp: the largest tile is drawn larger than its 1024 px preview',
    Math.max(m.tileW, m.tileH) > 1100,
    `${String(m.tileW)} x ${String(m.tileH)} px`,
  );
  check(
    "sharp: the largest tile still shows the photo's 2 px stripes after settling (not drawn from the preview)",
    m.score > 40,
    `contrast ${m.score.toFixed(1)}`,
  );
  const stats = await cacheStats(p);
  check(
    'sharp: the cache total stays within its budget',
    stats !== null && stats.bytes <= stats.budget,
    stats
      ? `${(stats.bytes / 1048576).toFixed(0)} of ${(stats.budget / 1048576).toFixed(0)} MB`
      : 'no stats',
  );
  if (screenshots) {
    // A small crop of the largest tile, for the PR.
    const clip = await p.evaluate(() => {
      const last = (window as any).__app.view.lastRender();
      const t = [...last.tiles].sort(
        (a: any, b: any) => b.width * b.height - a.width * a.height,
      )[0];
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const r = c.getBoundingClientRect();
      const k = r.width / c.width;
      return {
        x: r.left + (t.x + t.width / 2) * k - 60,
        y: r.top + (t.y + t.height / 2) * k - 40,
        width: 120,
        height: 80,
      };
    });
    mkdirSync(screenshots, { recursive: true });
    await p.screenshot({
      path: join(
        screenshots,
        process.env.SHARP_SHOT ?? 'issue-27-sharp-tile.png',
      ),
      clip,
    });
  }
  check('sharp: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/**
 * The decoded-image cache never exceeds its budget (#27), sampled every 10 ms
 * while `count` photos are imported and the collage is shuffled and resized,
 * at pixel ratio 2 on a 2560 × 1440 window.
 */
async function checkCacheCap(
  browser: import('playwright-core').Browser,
  count: number,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.evaluate(() => {
    const w = window as any;
    w.__cacheMax = 0;
    w.__cacheSamples = 0;
    w.__cacheTimer = setInterval(() => {
      const view = w.__app.view;
      if (typeof view.imageCacheStats !== 'function') return;
      const s = view.imageCacheStats();
      w.__cacheSamples++;
      w.__cacheMax = Math.max(w.__cacheMax, s.bytes);
    }, 10);
  });
  await p.setInputFiles(
    'input[type=file]',
    await makeSyntheticPhotos(p, count, count > 150 ? 1 : 1.5),
  );
  await p.waitForFunction(
    (n) => (window as any).__app.editor.getState().photos.length === n,
    count,
    { timeout: 180000 },
  );
  await waitDrawn(p, 180000);
  for (const v of [1, 0, 0.5]) {
    await setDial(p, v);
    await p.waitForTimeout(150);
  }
  for (let i = 0; i < 6; i++) {
    await p.getByRole('button', { name: 'Shuffle' }).click();
    await p.waitForTimeout(120);
  }
  await setDial(p, 1);
  await waitDrawn(p, 180000);
  const sampled = await p.evaluate(() => {
    const w = window as any;
    clearInterval(w.__cacheTimer);
    return { max: w.__cacheMax as number, samples: w.__cacheSamples as number };
  });
  const stats = await cacheStats(p);
  const mb = (n: number): string => (n / 1048576).toFixed(1);
  if (stats) {
    console.log(
      `INFO  ${String(count)} photos at pixel ratio 2: ${String(sampled.samples)} samples, largest total ${mb(sampled.max)} MB, accounted peak ${mb(stats.peakBytes)} MB, final ${mb(stats.bytes)} MB, budget ${mb(stats.budget)} MB`,
    );
  }
  check(
    `cache cap: ${String(count)} photos at pixel ratio 2, the total never exceeds the budget while importing and shuffling`,
    stats !== null &&
      sampled.samples > 20 &&
      sampled.max <= stats.budget &&
      stats.peakBytes <= stats.budget,
    stats ? `${mb(sampled.max)} of ${mb(stats.budget)} MB` : 'no stats',
  );
  check(
    `cache cap: ${String(count)} photos, no page errors`,
    errors.length === 0,
    errors.join(' | '),
  );
  await ctx.close();
}

/**
 * Dragging the dial with 100 photos stays smooth, and starts no decode of an
 * original while the pointer is down (#27). Frame gaps are measured over the
 * drag; the numbers are printed for comparison with the previous release.
 */
async function checkDialDrag(
  browser: import('playwright-core').Browser,
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.setInputFiles(
    'input[type=file]',
    await makeSyntheticPhotos(p, 100, 1.5),
  );
  await p.waitForFunction(
    () => (window as any).__app.editor.getState().photos.length === 100,
    undefined,
    { timeout: 120000 },
  );
  await waitDrawn(p, 120000);
  const medians: number[] = [];
  const p95s: number[] = [];
  let detailDuringDrag = 0;
  let settledOk = true;
  for (let run = 0; run < 3; run++) {
    await setDial(p, 0);
    await waitDrawn(p, 120000);
    const box = (await p.locator('#size-variation').boundingBox())!;
    const y = box.y + box.height / 2;
    await p.evaluate(() => {
      const w = window as any;
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const loop = (now: number): void => {
        w.__frames.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const before = await cacheStats(p);
    await p.mouse.move(box.x + 1, y);
    await p.mouse.down();
    const moves = 120;
    for (let i = 0; i <= moves; i++) {
      const f = i <= moves / 2 ? (2 * i) / moves : 2 - (2 * i) / moves;
      await p.mouse.move(box.x + 1 + (box.width - 2) * f, y);
      await p.waitForTimeout(16);
    }
    // Rest at the maximum with the pointer still down, then release.
    await p.mouse.move(box.x + box.width - 1, y);
    await p.waitForTimeout(450);
    const during = await cacheStats(p);
    detailDuringDrag +=
      before && during ? during.detailDecodes - before.detailDecodes : 0;
    await p.mouse.up();
    const frames = await p.evaluate(() => {
      (window as any).__stop = true;
      return [...((window as any).__frames as number[])].slice(2);
    });
    frames.sort((a, b) => a - b);
    medians.push(frames[Math.floor(frames.length / 2)]!);
    p95s.push(frames[Math.floor(frames.length * 0.95)]!);
    await waitDrawn(p, 60000);
    const last = await p.evaluate(() =>
      (window as any).__app.view.lastRender(),
    );
    settledOk &&= (last.upgrading ?? 0) === 0;
  }
  const mid = (xs: number[]): number => [...xs].sort((a, b) => a - b)[1]!;
  console.log(
    `INFO  100 photos, dragging the dial (3 runs, 1920 x 1080 at pixel ratio 2): frame gap median ${mid(medians).toFixed(1)} ms, p95 ${mid(p95s).toFixed(1)} ms (runs: median ${medians.map((m) => m.toFixed(1)).join('/')}, p95 ${p95s.map((m) => m.toFixed(1)).join('/')})`,
  );
  check(
    'dial drag: frames stay smooth with 100 photos (median gap under 25 ms)',
    mid(medians) < 25,
    `median ${mid(medians).toFixed(1)} ms`,
  );
  check(
    'dial drag: no decode of an original starts while the pointer is down',
    detailDuringDrag === 0,
    `${String(detailDuringDrag)} started`,
  );
  check('dial drag: every tile is final once the drag has settled', settledOk);
  const after = await cacheStats(p);
  check(
    'dial drag: originals are decoded for the large tiles once it has settled',
    after !== null && after.detailDecodes > 0,
    `${String(after?.detailDecodes ?? 0)} decodes of originals`,
  );
  await ctx.close();
}

// Another check may be using the default port: `--port 5301` or
// BROWSER_CHECK_PORT picks another, so two runs can coexist.
const portIndex = process.argv.indexOf('--port');
const port = Number(
  (portIndex >= 0 ? process.argv[portIndex + 1] : undefined) ??
    process.env.BROWSER_CHECK_PORT ??
    5199,
);
const server = await createServer({
  root,
  server: { port, strictPort: true },
  logLevel: 'error',
});
await server.listen();
const origin = `http://localhost:${String(port)}`;

// `--a2-only --engine firefox|chrome`: just the A2 export, in another engine.
if (process.argv.includes('--a2-only')) {
  const engine = process.argv[process.argv.indexOf('--engine') + 1] ?? 'chrome';
  const other =
    engine === 'firefox'
      ? await firefox.launch({ executablePath: process.env.FIREFOX_PATH })
      : await chromium.launch({ channel: 'chrome' });
  console.log(`Browser: ${engine} ${other.version()}`);
  await checkA2(
    other,
    origin,
    check,
    `${engine} ${other.version()}`,
    engine === 'firefox'
      ? 'playwright_firefoxdev_profile'
      : 'playwright_chromiumdev_profile',
  );
  await other.close();
  await server.close();
  process.exit(failures === 0 ? 0 : 1);
}

const browser = await chromium.launch({ channel: 'chrome' });
console.log(`Browser: Chrome ${browser.version()}`);

// `--export-dir <folder>`: A2 export of real photos, numbers only.
const exportDirIndex = process.argv.indexOf('--export-dir');
if (exportDirIndex >= 0) {
  const dir = process.argv[exportDirIndex + 1] ?? '';
  const files = readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => join(dir, f));
  console.log(`Real photos: ${String(files.length)} files (numbers only)`);
  await exportRealFolder(
    browser,
    origin,
    files,
    'playwright_chromiumdev_profile',
  );
  await browser.close();
  await server.close();
  process.exit(0);
}

// `--project-dir <folder>`: save and open a real folder, numbers only.
const projectDirIndex = process.argv.indexOf('--project-dir');
if (projectDirIndex >= 0) {
  const dir = process.argv[projectDirIndex + 1] ?? '';
  const files = readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => join(dir, f));
  await projectRealFolder(browser, origin, files);
  await browser.close();
  await server.close();
  process.exit(0);
}

// `--project-only`: just the save and open checks, while working on them.
if (process.argv.includes('--project-only')) {
  await checkProject(browser, origin, check, {
    screenshots: process.argv.includes('--project-screenshot')
      ? join(root, 'docs', 'screenshots')
      : undefined,
  });
  await browser.close();
  await server.close();
  console.log(
    failures === 0
      ? '\nAll checks passed'
      : `\n${String(failures)} check(s) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// `--export-only`: just the export checks (without A2), while working on them.
if (process.argv.includes('--export-only')) {
  await checkExport(browser, origin, check, {
    screenshots: process.argv.includes('--export-screenshot')
      ? join(root, 'docs', 'screenshots')
      : undefined,
  });
  await browser.close();
  await server.close();
  process.exit(failures === 0 ? 0 : 1);
}
// `--only selection,undo,import`: just those self-contained checks.
const onlyIndex = process.argv.indexOf('--only');
if (onlyIndex >= 0) {
  const names = (process.argv[onlyIndex + 1] ?? '').split(',');
  if (names.includes('selection')) await checkSelection(browser);
  if (names.includes('undo')) await checkUndo(browser);
  if (names.includes('import')) await checkImportOnce(browser);
  if (names.includes('deferred')) await checkDeferredSelection(browser);
  if (names.includes('sharp')) {
    await checkSharpTiles(
      browser,
      process.argv.includes('--sharp-screenshot')
        ? join(root, 'docs', 'screenshots')
        : undefined,
    );
  }
  if (names.includes('cap')) {
    await checkCacheCap(browser, 100);
    await checkCacheCap(browser, 300);
  }
  if (names.includes('drag')) await checkDialDrag(browser);
  await browser.close();
  await server.close();
  process.exit(failures === 0 ? 0 : 1);
}
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

const requests: { url: string; method: string; hasBody: boolean }[] = [];
// Context-wide, so every page this script opens is watched, including the
// real-photo page.
context.on('request', (r) => {
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

// 6b. Notices are overlays: dismissing them must not move or resize the canvas.
const canvasBefore = await page.locator('.canvas-area').boundingBox();
while ((await page.locator('.notice button').count()) > 0) {
  await page.locator('.notice button').first().click();
}
const canvasAfter = await page.locator('.canvas-area').boundingBox();
check(
  'notices do not change the canvas area size',
  canvasBefore?.height === canvasAfter?.height &&
    canvasBefore?.y === canvasAfter?.y,
  `${String(canvasBefore?.height)} vs ${String(canvasAfter?.height)}`,
);

// 6c. A lost dragleave cannot leave the overlay stuck.
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'x.jpg', { type: 'image/jpeg' }));
  document.dispatchEvent(
    new DragEvent('dragenter', {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
    }),
  );
});
check(
  'overlay shows on dragenter',
  await page.locator('.shell.dragging').isVisible(),
);
await page.waitForTimeout(1300);
check(
  'overlay clears itself when the drag just stops (no dragleave)',
  (await page.locator('.shell.dragging').count()) === 0,
);

// 6d. Screen readers: no live region on the per-photo progress text.
check(
  'progress text is not a live region; one polite announcer exists',
  (await page.locator('.progress [role]').count()) === 0 &&
    (await page.locator('.sr-only[role=status]').count()) === 1,
);

// 6e. Transparent PNG gets a white (not black) background in the preview.
await page.setInputFiles('input[type=file]', join(fixtures, 'transparent.png'));
await page.waitForFunction(
  () => document.querySelectorAll('.thumb').length === 47,
);
const pngCorner = await page.evaluate(async () => {
  const store = (window as unknown as { __store: any }).__store;
  const photo = store.getPhotos().at(-1);
  const bitmap = await createImageBitmap(photo.preview);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const thumb = await createImageBitmap(photo.thumbnail);
  const tctx = new OffscreenCanvas(thumb.width, thumb.height).getContext('2d')!;
  tctx.drawImage(thumb, 0, 0);
  return {
    preview: [...ctx.getImageData(3, 3, 1, 1).data],
    thumb: [...tctx.getImageData(2, 2, 1, 1).data],
  };
});
check(
  'transparent PNG: preview and thumbnail corners are white',
  [...pngCorner.preview, ...pngCorner.thumb].every(
    (v, i) => i % 4 === 3 || v > 240,
  ),
  JSON.stringify(pngCorner),
);

// 6f. Removing a photo releases its object URL and its tray item.
const removal = await page.evaluate(() => {
  const store = (window as unknown as { __store: any }).__store;
  const revoked: string[] = [];
  const original = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    original(url);
  };
  const id = store.getPhotos().at(-1).id;
  store.removePhotos([id]);
  URL.revokeObjectURL = original;
  return {
    revoked: revoked.length,
    thumbs: document.querySelectorAll('.thumb').length,
  };
});
check(
  'removePhotos revokes the object URL and removes the tray item',
  removal.revoked === 1 && removal.thumbs === 46,
  JSON.stringify(removal),
);

// 7. The editor canvas (issue #5): the mosaic, the dial and Shuffle.
await checkEditor(page);
await checkEditorContracts(page);
await checkLayout(page);
await checkCanvasSettings(page);
await checkPhysicalSizes(page);
await checkPixelRatio(browser);
await checkSelection(browser);
await checkCrop(browser);
await checkUndo(browser);
await checkImportOnce(browser);
await checkDeferredSelection(browser);
await checkCropPerformance(browser);
await checkSharpTiles(
  browser,
  process.argv.includes('--sharp-screenshot')
    ? join(root, 'docs', 'screenshots')
    : undefined,
);
await checkCacheCap(browser, 100);
await checkCacheCap(browser, 300);
await checkDialDrag(browser);
await checkExport(browser, origin, check, {
  screenshots: process.argv.includes('--export-screenshot')
    ? join(root, 'docs', 'screenshots')
    : undefined,
});
await checkProject(browser, origin, check);
await checkA2(
  browser,
  origin,
  check,
  `Chrome ${browser.version()}`,
  'playwright_chromiumdev_profile',
);

// 7a. Screenshots for issue #6 (synthetic images only), only when asked for:
// a preset other than 16:9, a border, a background colour and the compact
// tray; then the same with the tray expanded.
if (process.argv.includes('--screenshot')) {
  mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
  await page.evaluate(() => {
    document.querySelector('.tray-grid')!.scrollLeft = 0;
  });
  await page.locator('.preset', { hasText: /^4:5$/ }).click();
  await setDial(page, 0.7);
  await editorAction(page, 'setBorder', 0.012);
  await editorAction(page, 'setBackground', '#e8d9b5');
  await waitDrawn(page);
  await page.screenshot({
    path: join(root, 'docs', 'screenshots', 'issue-6-settings.png'),
  });
  await page.getByRole('button', { name: 'Show all' }).click();
  await waitDrawn(page);
  await page.screenshot({
    path: join(root, 'docs', 'screenshots', 'issue-6-tray-expanded.png'),
  });
  await page.getByRole('button', { name: 'Show one row' }).click();
}

// 7a2. Screenshots for issue #7 (synthetic images only), only when asked for:
// the panel in millimetres with A2 portrait at 300 DPI, then a DPI that
// does not fit, with its inline error.
if (process.argv.includes('--physical-screenshot')) {
  mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
  await page.evaluate(() => {
    document.querySelector('.tray-grid')!.scrollLeft = 0;
  });
  await page.getByRole('radio', { name: 'Millimetres' }).check();
  await page.locator('#size-dpi').fill('300');
  await page.locator('#size-dpi').press('Enter');
  await page.getByRole('button', { name: 'A2 portrait' }).click();
  await setDial(page, 0.7);
  await editorAction(page, 'setBorder', 0.012);
  await editorAction(page, 'setBackground', '#e8d9b5');
  await waitDrawn(page);
  await page.screenshot({
    path: join(root, 'docs', 'screenshots', 'issue-7-physical.png'),
  });
  await page.locator('#size-dpi').fill('2400');
  await page.locator('#size-dpi').press('Enter');
  await page.screenshot({
    path: join(root, 'docs', 'screenshots', 'issue-7-physical-error.png'),
  });
  await page.locator('#size-dpi').press('Escape');
  await page.getByRole('radio', { name: 'Pixels' }).check();
}

// 7b. Screenshot of the tray for issue #4, only when asked for, so a normal
// run leaves the committed screenshot alone.
if (process.argv.includes('--tray-screenshot')) {
  await page.getByRole('button', { name: 'Show all' }).click();
  for (const i of [1, 4, 7, 12, 20, 30])
    await page.locator('.thumb').nth(i).click();
  mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
  await page.evaluate(() => {
    document.querySelector('.tray-grid')!.scrollTop = 0;
  });
  await page.screenshot({
    path: join(root, 'docs', 'screenshots', 'photo-tray.png'),
  });
}

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
  await real.evaluate(() => {
    const w = window as any;
    w.__realCommits = 0;
    w.__app.editor.subscribe((_: unknown, change: any) => {
      if (!change.transient) w.__realCommits++;
    });
  });
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
  await real.waitForTimeout(500);
  console.log(
    `  committed editor changes during the import: ${String(await real.evaluate(() => (window as any).__realCommits))}`,
  );
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

  // Editor with every real photo included: drag the dial and measure.
  // Prints numbers only.
  const firstDraw = Date.now();
  await waitDrawn(real, 120000);
  console.log(
    `  collage fully drawn (all images decoded) ${String(Date.now() - firstDraw)} ms after import finished`,
  );
  for (const v of [0, 0.5, 1]) {
    await setDial(real, v);
    await waitDrawn(real);
    const s = await drawnStats(real);
    console.log(
      `  dial ${String(v)}: ${String(s.tiles)} tiles, area CV ${s.areaCv.toFixed(2)}, largest ${(s.largestShare * 100).toFixed(1)}%, portrait photos in portrait tiles ${(s.portraitInPortrait * 100).toFixed(0)}% (${String(s.portraits)} portraits), landscape in landscape ${(s.landscapeInLandscape * 100).toFixed(0)}%`,
    );
  }
  {
    const cs = await cacheStats(real);
    if (cs) {
      console.log(
        `  image cache: ${(cs.bytes / 1048576).toFixed(1)} MB held, accounted peak ${(cs.peakBytes / 1048576).toFixed(1)} MB of ${(cs.budget / 1048576).toFixed(0)} MB budget, ${String(cs.detailDecodes)} decodes of originals`,
      );
    }
  }
  const dragRuns: string[] = [];
  for (let run = 0; run < 3; run++) {
    await setDial(real, 0);
    await waitDrawn(real);
    await real.evaluate(() => {
      const w = window as any;
      w.__gaps = [];
      w.__long = [];
      w.__work = [];
      const editor = w.__app.editor;
      if (!w.__wrapped) {
        w.__wrapped = true;
        const drag = editor.dragVariation.bind(editor);
        editor.dragVariation = (v: number) => {
          const t = performance.now();
          drag(v);
          w.__work.push(performance.now() - t);
        };
      }
    });
    const box = (await real.locator('#size-variation').boundingBox())!;
    const y = box.y + box.height / 2;
    await real.mouse.move(box.x + 1, y);
    await real.mouse.down();
    // About 3 s: full sweep there and back, one move per 16 ms.
    const moves = 180;
    for (let i = 0; i <= moves; i++) {
      const f = i <= moves / 2 ? (2 * i) / moves : 2 - (2 * i) / moves;
      await real.mouse.move(box.x + 1 + (box.width - 2) * f, y);
      await real.waitForTimeout(16);
    }
    await real.mouse.up();
    const d = await real.evaluate(() => {
      const w = window as any;
      const gaps = [...w.__gaps].slice(1).sort((a, b) => a - b);
      const work = [...w.__work].sort((a, b) => a - b);
      const q = (a: number[], f: number) =>
        a[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
      return {
        frames: gaps.length,
        p50: q(gaps, 0.5),
        p95: q(gaps, 0.95),
        max: gaps.at(-1) ?? 0,
        over33: gaps.filter((g: number) => g > 33).length,
        long: w.__long.length,
        longest: Math.max(0, ...w.__long),
        work50: q(work, 0.5),
        work95: q(work, 0.95),
        workMax: work.at(-1) ?? 0,
        steps: work.length,
      };
    });
    dragRuns.push(
      `    run ${String(run + 1)}: ${String(d.frames)} frames, gap p50 ${d.p50.toFixed(1)} ms, p95 ${d.p95.toFixed(1)} ms, max ${d.max.toFixed(1)} ms, ${String(d.over33)} gaps > 33 ms; ${String(d.long)} long tasks (longest ${d.longest.toFixed(0)} ms); state update per step p50 ${d.work50.toFixed(1)} ms, p95 ${d.work95.toFixed(1)} ms, max ${d.workMax.toFixed(1)} ms over ${String(d.steps)} steps`,
    );
  }
  console.log('  dial drag 0 -> 1 -> 0 (~3 s, mouse moves every 16 ms):');
  for (const line of dragRuns) console.log(line);
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
