/**
 * Local real-browser check for photo import (issue #4), the editor canvas
 * (issue #5) and the canvas settings and page layout (issue #6). Not run in
 * CI: it needs
 * a locally installed Chrome. Decoding, EXIF handling and drag and drop cannot
 * be verified in Node.
 *
 *   node scripts/browser-check.ts                 # synthetic fixtures
 *   node scripts/browser-check.ts --screenshot    # also rewrite docs/screenshots/issue-6-*.png
 *   node scripts/browser-check.ts --tray-screenshot  # and docs/screenshots/photo-tray.png
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
        state.photos.length === included.length &&
        included.every((id) => state.photos.some((ph: any) => ph.id === id))
      );
    },
    undefined,
    { timeout, polling: 50 },
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
  const grey = await countColour(p, [0xd4, 0xd6, 0xdb]);
  // (A placeholder tile is thousands of pixels; the synthetic photos' white
  // numerals leave a few dozen light-grey anti-aliased pixels.)
  check(
    'no placeholder tiles once images are decoded',
    grey < 500,
    `${String(grey)} px`,
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

  // Portrait photos land in portrait tiles.
  check(
    'portrait photos mostly land in portrait tiles (synthetic set)',
    stats.portraitInPortrait >= 0.8,
    `${(stats.portraitInPortrait * 100).toFixed(0)}% of ${String(stats.portraits)} portraits; landscape in landscape ${(stats.landscapeInLandscape * 100).toFixed(0)}%`,
  );

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
  await p.locator('.preset', { hasText: /^16:9$/ }).click();
  await waitDrawn(p);
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
      await lock.check();
      await p.locator('.preset', { hasText: /^16:9$/ }).click();
      await waitDrawn(p);
      return fine;
    })(),
  );

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
    for (const f of [0.1, 0.3, 0.6, 0.45, 0.5]) {
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
    await p.mouse.move(sat(0.5), sy);
    await p.mouse.down();
    await p.mouse.move(sat(0.9), sy, { steps: 8 });
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
    await p.mouse.move(sat(0.9), sy);
    await p.mouse.down();
    await p.mouse.move(sat(0.3), sy, { steps: 5 });
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

  // The slider's range follows the arrangement; the request is kept.
  await editorAction(p, 'setBorder', 0.25);
  await waitDrawn(p);
  const ranges: string[] = [];
  const rangeProblems: string[] = [];
  for (let i = 0; i < 6; i++) {
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
        max: range.max,
        requested: e.canvas.borderFraction,
        limited: range.limited,
        noteShown: !note.hidden,
        note: note.textContent,
      };
    }, SETTINGS_MODULE);
    ranges.push(r.max.toFixed(3));
    if (Math.abs(r.sliderMax - r.max) > 1e-9)
      rangeProblems.push(`max ${String(r.sliderMax)} vs ${String(r.max)}`);
    if (Math.abs(r.sliderValue - Math.min(r.requested, r.max)) > 1e-9)
      rangeProblems.push(`value ${String(r.sliderValue)}`);
    if (r.requested !== 0.25)
      rangeProblems.push(`request changed to ${String(r.requested)}`);
    if (!r.limited || !r.noteShown || !r.note.includes('You asked for 25.0%'))
      rangeProblems.push(`note: ${r.note}`);
  }
  check(
    'after each re-roll the slider range follows the new arrangement, the 25% request is kept and a note says less is drawn',
    rangeProblems.length === 0 && new Set(ranges).size > 1,
    `${rangeProblems.join('; ')} maxima ${ranges.join(' ')}`,
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
await checkPixelRatio(browser);

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
