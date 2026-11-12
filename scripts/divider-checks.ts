/**
 * Real-browser checks for dragging dividers to resize tiles (issue #16),
 * called from browser-check.ts (in the full run and with --divider-only).
 * Photos are generated in the page (flat gradients with a number), so
 * nothing is read from disk and no real photo is involved.
 *
 *   node scripts/browser-check.ts --divider-only [--divider-screenshot]
 *   node scripts/browser-check.ts --divider-only --feature-compat <checkout>
 *
 * With `--feature-compat` (a checkout of the released 2026.11.0, served
 * beside this one), it also opens a project saved by the release here, and
 * hand-resized projects saved here in the release.
 *
 * Every measurement is of drawn tiles: the editor's last render, or tilesFor
 * and dividersFor at the size drawn, which the renderer and export use.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import type { Browser, Page } from 'playwright-core';
import { addPhotos, INIT_SCRIPT, LOAD_EXPORT } from './export-checks.ts';
import {
  act,
  addSized,
  drawn,
  exportPng,
  openProject,
  saveProject,
} from './feature-checks.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

const STATE_MODULE = '/src/editor/state.ts';
const LAYOUT_MODULE = '/src/layout/index.ts';
const HELPERS_MODULE = '/src/layout/test-helpers.ts';
const CROP_MODULE = '/src/editor/crop.ts';

export interface DividerCheckOptions {
  /** Write docs/screenshots/issue-16-*.png here. */
  readonly screenshots?: string;
  /** The released app's dev server, for the compatibility checks. */
  readonly releaseOrigin?: string;
}

async function newPage(
  browser: Browser,
  origin: string,
  viewport = { width: 1440, height: 900 },
  deviceScaleFactor = 1,
) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor,
    acceptDownloads: true,
  });
  await ctx.addInitScript(INIT_SCRIPT);
  // No save dialog: Save project downloads a file.
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await p.evaluate(() => {
    const w = window as any;
    w.__commits = 0;
    w.__app.editor.subscribe((_s: unknown, change: any) => {
      if (!change.transient && !change.restored) w.__commits++;
    });
  });
  return { ctx, p, errors };
}

const commits = (p: Page): Promise<number> =>
  p.evaluate(() => (window as any).__commits as number);

/** 12 photos: landscape, portrait and square, large enough for no warnings. */
const TWELVE: (readonly [number, number])[] = Array.from(
  { length: 12 },
  (_, i) =>
    (
      [
        [2400, 1800],
        [1800, 2400],
        [2400, 1600],
        [2000, 2000],
      ] as const
    )[i % 4]!,
);

interface Line {
  path: string;
  axis: 'x' | 'y';
  depth: number;
  fraction: number;
  /** The centre of the line in client (CSS) px, and its ends across. */
  x: number;
  y: number;
  from: number;
  to: number;
  /** Its gap in CSS px (0 with no border). */
  gap: number;
  /** CSS px per canvas px. */
  s: number;
}

/** Every divider as drawn now, in client coordinates. */
function lines(p: Page): Promise<Line[]> {
  return p.evaluate(async (module) => {
    const { dividersFor } = await import(/* @vite-ignore */ module);
    const app = (window as any).__app;
    const last = app.view.lastRender();
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    const s = r.width / c.width;
    return dividersFor(last.state, c).map((d: any) => {
      const centre = (d.cut + d.border / 2) * s;
      const mid = ((d.from + d.to) / 2) * s;
      const x = d.axis === 'x';
      return {
        path: d.path,
        axis: d.axis,
        depth: d.depth,
        fraction: d.fraction,
        x: r.left + (x ? centre : mid),
        y: r.top + (x ? mid : centre),
        from: (x ? r.top : r.left) + d.from * s,
        to: (x ? r.top : r.left) + d.to * s,
        gap: d.border * s,
        s,
      };
    });
  }, STATE_MODULE);
}

const root = async (p: Page): Promise<Line> =>
  (await lines(p)).find((l) => l.path === '')!;

/** The plan as JSON, and the drawn tiles. */
const planJson = (p: Page): Promise<string> =>
  p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().plan),
  );
const drawnTiles = (p: Page): Promise<any[]> =>
  p.evaluate(() => (window as any).__app.view.lastRender().tiles);

/** Whether the drawn tiles tile the preview canvas exactly. */
function tilingOk(p: Page): Promise<string | null> {
  return p.evaluate(
    async ({ helpers, state }) => {
      const { tilingError } = await import(/* @vite-ignore */ helpers);
      const { tilesFor, borderAt } = await import(/* @vite-ignore */ state);
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const size = { width: c.width, height: c.height };
      const border =
        last.state.canvas.borderFraction > 0
          ? borderAt(last.state, size).effective
          : 0;
      // The drawn tiles are tilesFor at the drawn size, exactly.
      const again = JSON.stringify(tilesFor(last.state, size));
      if (again !== JSON.stringify(last.tiles)) return 'drawn tiles differ';
      return tilingError(last.tiles, c.width, c.height, border, 0);
    },
    { helpers: HELPERS_MODULE, state: STATE_MODULE },
  );
}

/** The highlight's box and classes, and the canvas cursor. */
function highlight(p: Page) {
  return p.evaluate(() => {
    const h = document.querySelector<HTMLElement>('.divider-highlight')!;
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = h.getBoundingClientRect();
    return {
      shown: !h.hidden && r.width > 0 && r.height > 0,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      limit: h.classList.contains('at-limit'),
      dragging: h.classList.contains('dragging'),
      cursor: getComputedStyle(c).cursor,
    };
  });
}

/** Moves the mouse in `steps` from (x0, y0) to (x1, y1), 16 ms apart. */
async function glide(
  p: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  steps = 8,
): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await p.mouse.move(
      x0 + ((x1 - x0) * i) / steps,
      y0 + ((y1 - y0) * i) / steps,
    );
    await p.waitForTimeout(16);
  }
}

/** Waits for the next animation frame. */
function nextFrame(p: Page): Promise<unknown> {
  return p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
  );
}

/**
 * Records the events that can end a drag (and blur), for the detail of a
 * check that fails: which one ended a drag early, and when.
 */
async function logEnds(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as any;
    w.__ends = [];
    if (w.__endsInstalled) return;
    w.__endsInstalled = true;
    for (const type of [
      'pointerdown',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'gotpointercapture',
      'blur',
    ]) {
      window.addEventListener(
        type,
        (e) => {
          const t = e.target as Partial<HTMLElement> | null;
          const id = e instanceof PointerEvent ? String(e.pointerId) : '';
          const name = t?.className ?? (t === window ? 'window' : 'document');
          w.__ends.push(
            `${type}#${id}@${String(Math.round(e.timeStamp))}:${name}`,
          );
        },
        true,
      );
    }
  });
}
const ends = (p: Page): Promise<string> =>
  p.evaluate(() => ((window as any).__ends as string[]).join(' '));

/**
 * A point on the line `l` with nothing drawn over it (the selected tile's
 * menu can be: there the press is the menu's), nearest its middle, and the
 * line moved there. `under` is what covers the line's middle, if anything.
 */
async function uncovered(
  p: Page,
  l: Line,
): Promise<{ line: Line; under: string | null }> {
  return p.evaluate((l) => {
    const c = document.querySelector('.collage-canvas');
    const at = (t: number): [number, number] => {
      const along = l.from + (l.to - l.from) * t;
      return l.axis === 'x' ? [l.x, along] : [along, l.y];
    };
    const [mx, my] = at(0.5);
    const mid = document.elementFromPoint(mx, my);
    const under = mid === c ? null : mid ? mid.className : 'nothing';
    for (let i = 0; i <= 40; i++) {
      // 0.5, then outwards: 0.5 ± 0.0225, ± 0.045, ... up to 0.05 and 0.95.
      const t = 0.5 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.0225;
      const [x, y] = at(t);
      if (document.elementFromPoint(x, y) === c) {
        return { line: { ...l, x, y }, under };
      }
    }
    return { line: l, under };
  }, l);
}

/** Drags the divider `l` by `delta` CSS px across its line. */
async function dragBy(p: Page, l: Line, delta: number): Promise<void> {
  const dx = l.axis === 'x' ? delta : 0;
  const dy = l.axis === 'y' ? delta : 0;
  await p.mouse.move(l.x, l.y);
  await p.mouse.down();
  await glide(p, l.x, l.y, l.x + dx, l.y + dy);
  await p.mouse.up();
  await drawn(p);
}

/** A slot's tile centre in client px, from the last render. */
function tileCentre(p: Page, slot: number): Promise<{ x: number; y: number }> {
  return p.evaluate((slot) => {
    const app = (window as any).__app;
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    const s = r.width / c.width;
    const t = app.view.lastRender().tiles.find((x: any) => x.slot === slot);
    return {
      x: r.left + (t.x + t.width / 2) * s,
      y: r.top + (t.y + t.height / 2) * s,
    };
  }, slot);
}

/** Slots on the first and second side of the divider at `path`. */
function sides(
  p: Page,
  path: string,
): Promise<{ first: number[]; second: number[] }> {
  return p.evaluate((path) => {
    let node = (window as any).__app.editor.getState().plan.root;
    for (const step of path) node = step === '0' ? node.first : node.second;
    const slots = (n: any): number[] =>
      n.kind === 'leaf' ? [n.slot] : [...slots(n.first), ...slots(n.second)];
    return { first: slots(node.first), second: slots(node.second) };
  }, path);
}

/** A fresh plan for the state's own inputs (what a re-roll makes). */
function isFresh(p: Page): Promise<boolean> {
  return p.evaluate(async (module) => {
    const { arrange, featuredOf } = await import(/* @vite-ignore */ module);
    const s = (window as any).__app.editor.getState();
    const fresh = arrange(
      s.canvas,
      s.photos,
      s.variation,
      s.seed,
      featuredOf(s),
    );
    return JSON.stringify(fresh.plan) === JSON.stringify(s.plan);
  }, STATE_MODULE);
}

export async function checkDividers(
  browser: Browser,
  origin: string,
  check: Check,
  options: DividerCheckOptions = {},
): Promise<void> {
  console.log('\nDividers (issue #16)');
  const { ctx, p, errors } = await newPage(browser, origin);
  await addSized(p, TWELVE);
  // A fixed arrangement, so a failure reproduces (DIVIDER_SEED picks another).
  const seed = Number(process.env.DIVIDER_SEED ?? 16016);
  await act(p, 'shuffle', seed);
  console.log(`INFO  dividers: seed ${String(seed)}`);
  await act(p, 'setBorder', 0.01);
  await act(p, 'setBackground', '#f2efe9');

  // --- 1. Hover: resize cursor and the whole line highlighted ----------------
  const r0 = await root(p);
  await p.mouse.move(r0.x, r0.y);
  await p.waitForTimeout(50);
  const hover = await highlight(p);
  const along = r0.axis === 'x' ? hover.rect.y : hover.rect.x;
  const length = r0.axis === 'x' ? hover.rect.height : hover.rect.width;
  check(
    'divider hover: a resize cursor, and the whole line is highlighted',
    hover.shown &&
      hover.cursor === (r0.axis === 'x' ? 'col-resize' : 'row-resize') &&
      Math.abs(along - r0.from) < 1 &&
      Math.abs(length - (r0.to - r0.from)) < 1,
    JSON.stringify({ ...hover, from: r0.from, to: r0.to }),
  );
  if (options.screenshots) {
    await p.screenshot({
      path: join(options.screenshots, 'issue-16-hover.png'),
    });
  }
  const t0 = await tileCentre(p, 0);
  await p.mouse.move(t0.x, t0.y);
  await p.waitForTimeout(50);
  const off = await highlight(p);
  check(
    'away from a divider: no highlight and no resize cursor',
    !off.shown && !off.cursor.includes('resize'),
    JSON.stringify(off),
  );

  // --- 2. Drag: live, one commit, undo in one step, Escape cancels -----------
  const beforePlan = await planJson(p);
  const beforeTiles = await drawnTiles(p);
  const beforeAssignment = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  if (options.screenshots) {
    await p.screenshot({
      path: join(options.screenshots, 'issue-16-before.png'),
    });
  }
  const c0 = await commits(p);
  await logEnds(p);
  const delta = 90;
  const dx = r0.axis === 'x' ? delta : 0;
  const dy = r0.axis === 'y' ? delta : 0;
  await p.mouse.move(r0.x, r0.y);
  await p.mouse.down();
  await glide(p, r0.x, r0.y, r0.x + dx, r0.y + dy);
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
  );
  const mid = await p.evaluate(() => {
    const app = (window as any).__app;
    return {
      dragging: app.editor.isDragging(),
      drawnState: app.view.lastRender().state === app.editor.getState(),
    };
  });
  const midTiles = await drawnTiles(p);
  const midCommits = await commits(p);
  const midHighlight = await highlight(p);
  await p.mouse.up();
  await drawn(p);
  const r1 = await root(p);
  const sideSlots = await sides(p, '');
  const afterTiles = await drawnTiles(p);
  // Each side keeps its proportions: along the axis every tile scales by
  // its side's factor (within the 1 px of snapping), across nothing moves.
  const x = r0.axis === 'x';
  const span = (tiles: any[], slots: number[]): number => {
    const lo = Math.min(...slots.map((s) => (x ? tiles[s].x : tiles[s].y)));
    const hi = Math.max(
      ...slots.map((s) =>
        x ? tiles[s].x + tiles[s].width : tiles[s].y + tiles[s].height,
      ),
    );
    return hi - lo;
  };
  let proportionsOk = true;
  for (const slots of [sideSlots.first, sideSlots.second]) {
    const k = span(afterTiles, slots) / span(beforeTiles, slots);
    for (const s of slots) {
      const a = afterTiles[s];
      const b = beforeTiles[s];
      const alongA = x ? a.width : a.height;
      const alongB = x ? b.width : b.height;
      const acrossA = x ? a.height : a.width;
      const acrossB = x ? b.height : b.width;
      if (Math.abs(alongA - alongB * k) > 2 || acrossA !== acrossB) {
        proportionsOk = false;
      }
    }
  }
  const afterAssignment = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState().assignment),
  );
  check(
    'divider drag: the tiles redraw live while the pointer is down, with no commit yet',
    mid.dragging &&
      mid.drawnState &&
      JSON.stringify(midTiles) !== JSON.stringify(beforeTiles) &&
      midCommits === c0 &&
      midHighlight.dragging,
    JSON.stringify({ mid, midCommits, c0 }),
  );
  const moved = x ? r1.x - r0.x : r1.y - r0.y;
  check(
    'divider drag: releasing commits exactly once, and the line is where the pointer left it',
    (await commits(p)) === c0 + 1 && Math.abs(moved - delta) <= 1.5,
    `${String((await commits(p)) - c0)} commits; moved ${moved.toFixed(2)} of ${String(delta)} CSS px` +
      (Math.abs(moved - delta) <= 1.5 ? '' : `; events: ${await ends(p)}`),
  );
  check(
    "divider drag: tiles on both sides resize, keeping each side's proportions; no photo changes tile",
    proportionsOk && afterAssignment === beforeAssignment,
  );
  check(
    'divider drag: the drawn tiles fill the canvas with no gaps or overlaps',
    (await tilingOk(p)) === null,
    (await tilingOk(p)) ?? '',
  );
  if (options.screenshots) {
    await p.mouse.move(r1.x, r1.y);
    await p.waitForTimeout(50);
    await p.screenshot({
      path: join(options.screenshots, 'issue-16-after.png'),
    });
  }
  const afterPlan = await planJson(p);
  await p.getByRole('button', { name: 'Undo' }).click();
  await drawn(p);
  check(
    'divider drag: one Undo restores the previous layout',
    (await planJson(p)) === beforePlan &&
      JSON.stringify(await drawnTiles(p)) === JSON.stringify(beforeTiles),
  );
  await p.getByRole('button', { name: 'Redo' }).click();
  await drawn(p);
  check('divider drag: Redo puts it back', (await planJson(p)) === afterPlan);

  // Escape mid-drag cancels, before the release, and the release commits
  // nothing.
  const c1 = await commits(p);
  const r2 = await root(p);
  await p.mouse.move(r2.x, r2.y);
  await p.mouse.down();
  await glide(p, r2.x, r2.y, r2.x - dx, r2.y - dy);
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
  );
  const changedMid = (await planJson(p)) !== afterPlan;
  await p.keyboard.press('Escape');
  await drawn(p);
  const cancelledMid = (await planJson(p)) === afterPlan;
  await glide(p, r2.x - dx, r2.y - dy, r2.x - 2 * dx, r2.y - 2 * dy, 4);
  await p.mouse.up();
  await drawn(p);
  check(
    'divider drag: Escape cancels mid-drag; the layout is back at once and the release commits nothing',
    changedMid &&
      cancelledMid &&
      (await planJson(p)) === afterPlan &&
      (await commits(p)) === c1,
  );

  // Losing pointer capture, or a pointercancel, before the release cancels
  // the drag: the layout goes back, nothing is committed, and the release
  // that follows does nothing.
  for (const how of ['capture lost', 'pointercancel'] as const) {
    const cBefore = await commits(p);
    const planBefore = await planJson(p);
    const l = await root(p);
    await p.mouse.move(l.x, l.y);
    await p.mouse.down();
    await glide(p, l.x, l.y, l.x + dx / 2, l.y + dy / 2, 4);
    await nextFrame(p);
    const changed = (await planJson(p)) !== planBefore;
    await p.evaluate((how) => {
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      // The mouse is pointer 1 in Chrome.
      if (how === 'capture lost') c.releasePointerCapture(1);
      else {
        c.dispatchEvent(
          new PointerEvent('pointercancel', {
            pointerId: 1,
            isPrimary: true,
            bubbles: true,
          }),
        );
      }
    }, how);
    // A capture released by script is lost at the next pointer event.
    await p.mouse.move(l.x + dx / 2 + 1, l.y + dy / 2 + 1);
    await drawn(p);
    const back = (await planJson(p)) === planBefore;
    await glide(p, l.x + dx / 2, l.y + dy / 2, l.x + dx, l.y + dy, 4);
    await p.mouse.up();
    await drawn(p);
    const state = await p.evaluate(() => ({
      dragging: (window as any).__app.editor.isDragging(),
      busy: (window as any).__app.dividers.isBusy(),
      cls: document
        .querySelector('.collage-canvas')!
        .classList.contains('divider-dragging'),
    }));
    check(
      `divider drag: ${how} mid-drag cancels it: the layout goes back, nothing is committed, and the release does nothing`,
      changed &&
        back &&
        (await planJson(p)) === planBefore &&
        (await commits(p)) === cBefore &&
        !state.dragging &&
        !state.busy &&
        !state.cls,
      JSON.stringify({ changed, back, ...state }),
    );
  }

  // A second pointer pressed during a drag (a finger, a pen) is ignored: no
  // selection, no pan, no second divider; the drag carries on and commits
  // once, moving only its own divider.
  {
    const cBefore = await commits(p);
    const before = await p.evaluate(() => {
      const s = (window as any).__app.editor.getState();
      return JSON.stringify({ crops: s.crops, assignment: s.assignment });
    });
    const l = await root(p);
    const other = (await lines(p)).find((d) => d.path !== '')!;
    const t = await tileCentre(p, 0);
    await p.mouse.move(l.x, l.y);
    await p.mouse.down();
    await glide(p, l.x, l.y, l.x + dx / 2, l.y + dy / 2, 4);
    await p.evaluate(
      (points) => {
        const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
        for (const [x, y] of points) {
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
            c.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 7,
                pointerType: 'touch',
                isPrimary: false,
                bubbles: true,
                cancelable: true,
                clientX: x + (type === 'pointermove' ? 30 : 0),
                clientY: y + (type === 'pointermove' ? 30 : 0),
                button: type === 'pointermove' ? -1 : 0,
                buttons: type === 'pointerup' ? 0 : 1,
              }),
            );
          }
        }
      },
      [
        [t.x, t.y],
        [other.x, other.y],
      ] as [number, number][],
    );
    await glide(p, l.x + dx / 2, l.y + dy / 2, l.x + dx, l.y + dy, 4);
    await p.mouse.up();
    await drawn(p);
    const after = await p.evaluate(() => {
      const s = (window as any).__app.editor.getState();
      return JSON.stringify({ crops: s.crops, assignment: s.assignment });
    });
    const l2 = await root(p);
    const o2 = (await lines(p)).find((d) => d.path === other.path)!;
    const selection = await p.evaluate(
      () => (window as any).__app.selection.getSelection().kind,
    );
    const movedBy = l.axis === 'x' ? l2.x - l.x : l2.y - l.y;
    check(
      'divider drag: a second pointer pressed during the drag is ignored; the drag commits once',
      (await commits(p)) === cBefore + 1 &&
        movedBy > 20 &&
        o2.fraction === other.fraction &&
        after === before &&
        selection === 'idle',
      `${String((await commits(p)) - cBefore)} commits, moved ${movedBy.toFixed(1)}, selection ${String(selection)}`,
    );
    await p.getByRole('button', { name: 'Undo' }).click();
    await drawn(p);
  }

  // A mouse move reported with no button down while the script holds the
  // button: what a real mouse moving over a headed test window sends. Chrome
  // then drops the pointer capture (lostpointercapture, no pointerup), which
  // once made a check's drag commit early. It cancels the drag: the layout
  // goes back, nothing is committed, and the later moves and release do
  // nothing.
  {
    const cBefore = await commits(p);
    const planBefore = await planJson(p);
    const l = await root(p);
    await logEnds(p);
    await p.mouse.move(l.x, l.y);
    await p.mouse.down();
    await glide(p, l.x, l.y, l.x + dx / 4, l.y + dy / 4, 2);
    await nextFrame(p);
    const changed = (await planJson(p)) !== planBefore;
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: l.x + dx / 4 + 1,
      y: l.y + dy / 4 + 1,
      button: 'none',
      buttons: 0,
    });
    await drawn(p);
    const back = (await planJson(p)) === planBefore;
    await glide(p, l.x + dx / 4, l.y + dy / 4, l.x + dx, l.y + dy, 4);
    await p.mouse.up();
    await drawn(p);
    const log = await ends(p);
    const cAfter = (await commits(p)) - cBefore;
    const same = (await planJson(p)) === planBefore;
    check(
      'divider drag: a move with the button up but no release (Chrome drops the capture) cancels the drag; later moves and the release do nothing',
      changed &&
        back &&
        log.includes('lostpointercapture') &&
        cAfter === 0 &&
        same,
      `${JSON.stringify({ changed, back, commits: cAfter, same })} ${log}`,
    );
    await cdp.detach();
  }

  // Released outside the window: commits once, at the clamped position.
  {
    const cBefore = await commits(p);
    const l = await root(p);
    const range = await p.evaluate(async (module) => {
      const { dividerRange } = await import(/* @vite-ignore */ module);
      return dividerRange((window as any).__app.editor.getState().plan, '');
    }, LAYOUT_MODULE);
    await p.mouse.move(l.x, l.y);
    await p.mouse.down();
    const outX = l.axis === 'x' ? -200 : l.x;
    const outY = l.axis === 'y' ? -200 : l.y;
    await glide(p, l.x, l.y, outX, outY, 10);
    await p.mouse.up();
    await drawn(p);
    const f = await p.evaluate(
      () => (window as any).__app.editor.getState().plan.root.fraction,
    );
    check(
      'divider drag: released outside the window, it commits once at the clamped position',
      (await commits(p)) === cBefore + 1 && Math.abs(f - range.min) < 1e-9,
      `${String((await commits(p)) - cBefore)} commits, fraction ${String(f)} (min ${String(range.min)})`,
    );
    await p.getByRole('button', { name: 'Undo' }).click();
    await drawn(p);
  }

  // --- 3. Limits ---------------------------------------------------------------
  await act(p, 'setBorder', 0);
  const minimum = async (slots: number[], axis: 'x' | 'y') =>
    p.evaluate(
      async ({ module, slots, axis }) => {
        const { tilesFor } = await import(/* @vite-ignore */ module);
        const s = (window as any).__app.editor.getState();
        const tiles = tilesFor(s, s.canvas);
        return Math.min(
          ...slots.map((i: number) =>
            axis === 'x' ? tiles[i].width : tiles[i].height,
          ),
        );
      },
      { module: STATE_MODULE, slots, axis },
    );
  const canvasSize = await p.evaluate(
    () => (window as any).__app.editor.getState().canvas,
  );
  const m = 0.04 * Math.min(canvasSize.width, canvasSize.height);
  const r3 = await root(p);
  const s3 = await sides(p, '');
  await p.mouse.move(r3.x, r3.y);
  await p.mouse.down();
  // Far beyond the canvas edge, towards the first side.
  const far = -2000;
  await glide(
    p,
    r3.x,
    r3.y,
    r3.x + (r3.axis === 'x' ? far : 0),
    r3.y + (r3.axis === 'y' ? far : 0),
    10,
  );
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          r(null);
        }),
      ),
  );
  const atLimit = await highlight(p);
  if (options.screenshots) {
    await p.screenshot({
      path: join(options.screenshots, 'issue-16-limit.png'),
    });
  }
  await p.mouse.up();
  await drawn(p);
  const smallest = await minimum(s3.first, r3.axis);
  check(
    'divider limit: dragged far beyond the edge, the highlight shows the limit and the smallest tile stops at 4% of the shorter side',
    atLimit.limit &&
      smallest >= Math.floor(m) - 1 &&
      smallest <= Math.ceil(m) + 1,
    `smallest ${String(smallest)} px, minimum ${m.toFixed(1)} px`,
  );
  // The deepest divider, both ways: nothing on either side, at any depth,
  // goes below the minimum (or below what it was, if already smaller).
  const all = await lines(p);
  const deep = all.reduce((a, b) => (b.depth > a.depth ? b : a));
  const deepSides = await sides(p, deep.path);
  const beforeDeep = await p.evaluate(
    async ({ module }) => {
      const { tilesFor } = await import(/* @vite-ignore */ module);
      const s = (window as any).__app.editor.getState();
      return tilesFor(s, s.canvas);
    },
    { module: STATE_MODULE },
  );
  let deepOk = true;
  const deepDetail: string[] = [];
  for (const sign of [-1, 1]) {
    const l = (await lines(p)).find((d) => d.path === deep.path)!;
    await dragBy(p, l, sign * 2000);
    const shrinking = sign < 0 ? deepSides.first : deepSides.second;
    const got = await minimum(shrinking, deep.axis);
    const was = Math.min(
      ...shrinking.map((i) =>
        deep.axis === 'x' ? beforeDeep[i].width : beforeDeep[i].height,
      ),
    );
    deepDetail.push(`${String(got)} px (was ${String(was)})`);
    if (got < Math.min(Math.floor(m), was) - 1) deepOk = false;
  }
  check(
    `divider limit: the deepest divider (depth ${String(deep.depth)}) stops at the minimum both ways`,
    deepOk && (await tilingOk(p)) === null,
    deepDetail.join(', '),
  );

  // --- 4. No border: dividers can be grabbed; tile gestures still work -------
  // A fresh arrangement: the limits above left the root divider at one end.
  await act(p, 'shuffle', seed + 1);
  const band = await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    return c.getBoundingClientRect().width / c.width;
  });
  const r4 = await root(p);
  const at = (dx: number) =>
    p.evaluate(
      ({ x, y }) =>
        (window as any).__app.dividers.dividerAtClientPoint(x, y)?.path ?? null,
      {
        x: r4.x + (r4.axis === 'x' ? dx : 0),
        y: r4.y + (r4.axis === 'y' ? dx : 0),
      },
    );
  check(
    'no border: the divider is found within 4 CSS px of the shared edge, and not beyond',
    r4.gap === 0 &&
      (await at(0)) === '' &&
      (await at(3)) === '' &&
      (await at(-3)) === '' &&
      (await at(6)) !== '' &&
      (await at(-6)) !== '',
    `scale ${band.toFixed(3)}`,
  );
  await dragBy(p, r4, 40);
  const r4b = await root(p);
  check(
    'no border: the divider can be dragged',
    Math.abs((r4b.axis === 'x' ? r4b.x - r4.x : r4b.y - r4.y) - 40) <= 1.5,
  );
  // Select a tile at its centre, pan inside it, zoom with the wheel, swap.
  const slot = s3.second[0]!;
  const id = await p.evaluate(
    (slot) => (window as any).__app.editor.getState().assignment[slot],
    slot,
  );
  const tc = await tileCentre(p, slot);
  await p.mouse.click(tc.x, tc.y);
  const selected = await p.evaluate(() =>
    (window as any).__app.selection.getSelection(),
  );
  const planBeforePan = await planJson(p);
  const crop0 = await p.evaluate(
    (id) => (window as any).__app.editor.getState().crops[id] ?? null,
    id,
  );
  await p.mouse.move(tc.x, tc.y);
  await p.mouse.down();
  await glide(p, tc.x, tc.y, tc.x + 30, tc.y + 20, 6);
  await p.mouse.up();
  await drawn(p);
  const crop1 = await p.evaluate(
    (id) => (window as any).__app.editor.getState().crops[id] ?? null,
    id,
  );
  await p.mouse.move(tc.x, tc.y);
  await p.mouse.wheel(0, -300);
  await p.waitForTimeout(400);
  await drawn(p);
  const crop2 = await p.evaluate(
    (id) => (window as any).__app.editor.getState().crops[id] ?? null,
    id,
  );
  check(
    'no border: away from the edge band, a tile is selected, panned and zoomed as before',
    selected.kind === 'selected' &&
      selected.photoId === id &&
      JSON.stringify(crop1) !== JSON.stringify(crop0) &&
      crop2 !== null &&
      crop2.zoom > (crop1?.zoom ?? 1) &&
      (await planJson(p)) === planBeforePan,
    JSON.stringify({ selected, crop0, crop1, crop2 }),
  );
  // A press in the band drags the divider, not the selected photo, and the
  // tile stays selected. The press is where nothing covers the line: the
  // selected tile's menu may cover part of it, and there the menu gets the
  // press (checked below).
  const { line: r4c, under: r4under } = await uncovered(p, await root(p));
  const crop3 = await p.evaluate(
    (id) => (window as any).__app.editor.getState().crops[id] ?? null,
    id,
  );
  const pressed = await p.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return {
        target: el?.className ?? null,
        hit:
          (window as any).__app.dividers.dividerAtClientPoint(x, y)?.path ??
          null,
      };
    },
    { x: r4c.x, y: r4c.y },
  );
  await dragBy(p, r4c, -25);
  const after4 = await p.evaluate(
    (id) => ({
      crop: (window as any).__app.editor.getState().crops[id] ?? null,
      selection: (window as any).__app.selection.getSelection(),
    }),
    id,
  );
  check(
    "no border: inside the band the divider takes priority over the selected tile's pan, and the selection stays",
    (await planJson(p)) !== planBeforePan &&
      JSON.stringify(after4.crop) === JSON.stringify(crop3) &&
      after4.selection.kind === 'selected',
    JSON.stringify({ ...after4, crop3, pressed, middleCoveredBy: r4under }),
  );
  // Swap still works by pointer.
  const assignmentBefore = await p.evaluate(
    () => (window as any).__app.editor.getState().assignment,
  );
  await p.getByRole('button', { name: 'Swap' }).click();
  const other = s3.first.find((s) => s !== slot)!;
  const oc = await tileCentre(p, other);
  await p.mouse.click(oc.x, oc.y);
  await drawn(p);
  const assignmentAfter = await p.evaluate(
    () => (window as any).__app.editor.getState().assignment,
  );
  check(
    'no border: swapping two tiles by pointer still works',
    assignmentAfter[slot] === assignmentBefore[other] &&
      assignmentAfter[other] === assignmentBefore[slot],
  );
  await p.keyboard.press('Escape');

  // The selected tile's menu drawn over a divider: what the user sees wins.
  // The menu is moved (as placement might put it) so that the root divider
  // runs through its Reset button.
  {
    await act(p, 'setCrop', id, { x: 0.3, y: 0.6, zoom: 1.4 });
    const idSlot = await p.evaluate(
      (id) => (window as any).__app.editor.getState().assignment.indexOf(id),
      id,
    );
    const ic = await tileCentre(p, idSlot);
    await p.mouse.click(ic.x, ic.y);
    const l = await root(p);
    const target = await p.evaluate((l) => {
      const menu = document.querySelector<HTMLElement>('.tile-menu')!;
      const reset = [...menu.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Reset',
      )!;
      const r = reset.getBoundingClientRect();
      // The Reset button's centre onto the line, at a third of its length.
      const along = l.from + (l.to - l.from) / 3;
      const [x, y] = l.axis === 'x' ? [l.x, along] : [along, l.y];
      // As a translation: the menu keeps its own placement (it is placed
      // again on focus and on every render), and moves with it.
      menu.style.translate = `${String(x - (r.left + r.width / 2))}px ${String(y - (r.top + r.height / 2))}px`;
      const z = menu.querySelector<HTMLElement>('.tile-menu-zoom span')!;
      const zr = z.getBoundingClientRect();
      return {
        x,
        y,
        zoomX: zr.left + zr.width / 2,
        zoomY: zr.top + zr.height / 2,
      };
    }, l);
    const planBefore = await planJson(p);
    const cBefore = await commits(p);
    await p.mouse.move(target.x, target.y);
    await p.waitForTimeout(50);
    const hoverMenu = await p.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement;
      return {
        inMenu: el.closest('.tile-menu') !== null,
        cursor: getComputedStyle(el).cursor,
        highlight:
          !document.querySelector<HTMLElement>('.divider-highlight')!.hidden,
        hit:
          (window as any).__app.dividers.dividerAtClientPoint(x, y)?.path ??
          null,
      };
    }, target);
    check(
      'menu over a divider: hovering the menu there shows no divider highlight or resize cursor',
      hoverMenu.inMenu &&
        hoverMenu.hit === '' &&
        !hoverMenu.highlight &&
        !hoverMenu.cursor.includes('resize'),
      JSON.stringify(hoverMenu),
    );
    await p.mouse.down();
    await glide(p, target.x, target.y, target.x + 2, target.y + 2, 2);
    await p.mouse.up();
    await drawn(p);
    const afterReset = await p.evaluate(
      (id) => ({
        crop: (window as any).__app.editor.getState().crops[id] ?? null,
        selection: (window as any).__app.selection.getSelection(),
      }),
      id,
    );
    check(
      'menu over a divider: a press there operates the menu (Reset), moves no divider, and keeps the selection',
      (await planJson(p)) === planBefore &&
        (await commits(p)) === cBefore + 1 &&
        (afterReset.crop === null ||
          (afterReset.crop.zoom === 1 &&
            afterReset.crop.x === 0.5 &&
            afterReset.crop.y === 0.5)) &&
        afterReset.selection.kind === 'selected' &&
        afterReset.selection.photoId === id,
      JSON.stringify(afterReset),
    );
    // A press on the menu's Zoom label, dragged off onto another tile and
    // released there, is not a click away: the selection stays (the click
    // goes to an element holding both, which used to read as one).
    const away = await tileCentre(p, idSlot === 0 ? 1 : 0);
    const zoom = await p.evaluate(() => {
      const z = document.querySelector<HTMLElement>('.tile-menu-zoom span')!;
      const r = z.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const cLabel = await commits(p);
    await p.mouse.move(zoom.x, zoom.y);
    await p.mouse.down();
    await glide(p, zoom.x, zoom.y, away.x, away.y, 6);
    await p.mouse.up();
    await drawn(p);
    const afterLabel = await p.evaluate(() =>
      (window as any).__app.selection.getSelection(),
    );
    check(
      "menu: a press on the menu's Zoom label released over another tile keeps the selection and changes nothing",
      afterLabel.kind === 'selected' &&
        afterLabel.photoId === id &&
        (await planJson(p)) === planBefore &&
        (await commits(p)) === cLabel,
      JSON.stringify(afterLabel),
    );
    // The way out: Escape removes the menu, and the divider is draggable
    // where the menu was.
    await p.keyboard.press('Escape');
    await p.evaluate(() => {
      document.querySelector<HTMLElement>('.tile-menu')!.style.translate = '';
    });
    const menuGone = await p.evaluate(
      () => document.querySelector<HTMLElement>('.tile-menu')!.hidden,
    );
    await dragBy(p, { ...l, x: target.x, y: target.y }, 20);
    const l2 = await root(p);
    check(
      'menu over a divider: Escape removes the menu, and the divider is then draggable where it was',
      menuGone &&
        Math.abs((l.axis === 'x' ? l2.x - l.x : l2.y - l.y) - 20) <= 1.5,
      `menu hidden ${String(menuGone)}`,
    );
  }

  // --- 5. Crops keep their focal point; nothing letterboxed or distorted -----
  await act(p, 'setBackground', '#ff00ff');
  await act(p, 'setCrop', id, { x: 0.3, y: 0.6, zoom: 1.4 });
  const cropBefore = await p.evaluate(
    (id) => (window as any).__app.editor.getState().crops[id],
    id,
  );
  for (const d of [120, -260]) await dragBy(p, await root(p), d);
  const fit = await p.evaluate(
    async ({ crop, id }) => {
      const { coverSource } = await import(/* @vite-ignore */ crop);
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const ctx = c.getContext('2d')!;
      const photos = app.store.getPhotos();
      let magenta = 0;
      let distorted = 0;
      let offFocus = 0;
      for (const t of last.tiles) {
        const pid = last.state.assignment[t.slot];
        const photo = photos.find((x: any) => x.id === pid);
        const cr = last.state.crops[pid] ?? { x: 0.5, y: 0.5, zoom: 1 };
        const src = coverSource(
          photo.width,
          photo.height,
          t.width,
          t.height,
          cr,
        );
        if (
          Math.abs(src.sw / src.sh - t.width / t.height) >
          1e-6 * (t.width / t.height)
        ) {
          distorted++;
        }
        // Centred on the focal point unless pushed back inside the photo.
        const cx = src.sx + src.sw / 2;
        const cy = src.sy + src.sh / 2;
        const atEdgeX = src.sx <= 1e-6 || src.sx + src.sw >= photo.width - 1e-6;
        const atEdgeY =
          src.sy <= 1e-6 || src.sy + src.sh >= photo.height - 1e-6;
        if (
          (!atEdgeX &&
            Math.abs(cx - cr.x * photo.width) > 1e-6 * photo.width) ||
          (!atEdgeY && Math.abs(cy - cr.y * photo.height) > 1e-6 * photo.height)
        ) {
          offFocus++;
        }
        // Inner edge pixels: never the magenta background.
        for (const [px, py] of [
          [t.x, t.y],
          [t.x + t.width - 1, t.y],
          [t.x, t.y + t.height - 1],
          [t.x + t.width - 1, t.y + t.height - 1],
          [t.x + Math.floor(t.width / 2), t.y],
          [t.x, t.y + Math.floor(t.height / 2)],
          [t.x + t.width - 1, t.y + Math.floor(t.height / 2)],
          [t.x + Math.floor(t.width / 2), t.y + t.height - 1],
        ]) {
          const d = ctx.getImageData(px, py, 1, 1).data;
          if (d[0]! > 230 && d[1]! < 30 && d[2]! > 230) magenta++;
        }
      }
      return { magenta, distorted, offFocus, crop: last.state.crops[id] };
    },
    { crop: CROP_MODULE, id },
  );
  check(
    'crops: as tiles change shape each photo keeps its crop and focal point, with no letterboxing or distortion',
    JSON.stringify(fit.crop) === JSON.stringify(cropBefore) &&
      fit.magenta === 0 &&
      fit.distorted === 0 &&
      fit.offFocus === 0,
    JSON.stringify(fit),
  );
  await act(p, 'setBackground', '#f2efe9');

  // --- 6. What keeps and what replaces a hand-resized layout -----------------
  const resize = async (): Promise<string> => {
    const l = await root(p);
    await dragBy(p, l, l.axis === 'x' ? 70 : 50);
    return planJson(p);
  };
  let hand = await resize();
  const keeps: [string, () => Promise<void>][] = [
    ['the border', () => act(p, 'setBorder', 0.02)],
    ['the background', () => act(p, 'setBackground', '#203040')],
    [
      'the canvas size at the same ratio',
      async () => {
        const c = await p.evaluate(
          () => (window as any).__app.editor.getState().canvas,
        );
        await act(p, 'setCanvasSize', c.width * 2, c.height * 2);
      },
    ],
    ['a swap', () => act(p, 'swapTiles', 0, 1)],
    ['a crop', () => act(p, 'setCrop', id, { x: 0.7, y: 0.2, zoom: 2 })],
    ['featuring', () => act(p, 'setFeatured', id, true)],
  ];
  const kept: string[] = [];
  for (const [name, run] of keeps) {
    await run();
    if ((await planJson(p)) === hand) kept.push(name);
  }
  // Save and open.
  const stateBefore = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState()),
  );
  const pngBefore = await exportPng(p);
  const saved = await saveProject(p, 'divider-hand');
  const openError = await openProject(p, saved);
  const stateAfter = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState()),
  );
  const pngAfter = await exportPng(p);
  if (openError === '' && stateAfter === stateBefore)
    kept.push('save and open');
  check(
    'a hand-resized layout survives the border, background, canvas size at the same ratio, swap, crop, feature, save and open',
    kept.length === keeps.length + 1,
    `kept by: ${kept.join(', ')}${openError ? `; open failed: ${openError}` : ''}`,
  );
  check(
    'the export of a reopened hand-resized project is byte-identical',
    pngBefore === pngAfter,
  );
  const replaces: [string, () => Promise<void>][] = [
    ['Shuffle', () => p.getByRole('button', { name: 'Shuffle' }).click()],
    [
      'the dial',
      async () => {
        const v = await p.evaluate(
          () => (window as any).__app.editor.getState().variation,
        );
        await p
          .locator('#size-variation')
          .fill(String(v > 0.5 ? v - 0.03 : v + 0.03));
      },
    ],
    [
      'a ratio change',
      async () => {
        const c = await p.evaluate(
          () => (window as any).__app.editor.getState().canvas,
        );
        await act(p, 'setCanvasSize', c.height, c.width);
      },
    ],
    [
      'excluding a photo',
      () =>
        p.evaluate(() => {
          const app = (window as any).__app;
          app.store.setIncluded(app.editor.getState().assignment.at(-1), false);
        }),
    ],
    [
      'including it again',
      () =>
        p.evaluate(() => {
          const app = (window as any).__app;
          for (const ph of app.store.getPhotos())
            app.store.setIncluded(ph.id, true);
        }),
    ],
  ];
  const replaced: string[] = [];
  for (const [name, run] of replaces) {
    hand = await resize();
    await run();
    await drawn(p);
    if ((await planJson(p)) !== hand && (await isFresh(p))) replaced.push(name);
  }
  check(
    'a hand-resized layout is replaced by a fresh arrangement on Shuffle, the dial, a ratio change, and include/exclude',
    replaced.length === replaces.length,
    `replaced by: ${replaced.join(', ')}`,
  );

  // --- 7. Export matches the editor's arrangement exactly --------------------
  await act(p, 'setCanvasSize', 1800, 1200);
  await act(p, 'setBorder', 0.015);
  await act(p, 'setBackground', '#ff00ff');
  await resize();
  const deepest = (await lines(p)).reduce((a, b) =>
    b.depth > a.depth ? b : a,
  );
  await dragBy(p, deepest, 15);
  await p.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    (window as any).__preview = c
      .getContext('2d')!
      .getImageData(0, 0, c.width, c.height);
  });
  await exportPng(p);
  const exported = await p.evaluate(
    async ({ module, load }) => {
      const w = window as any;
      const { ctx, c } = await (0, eval)(`(${load})`)();
      const { tilesFor } = await import(/* @vite-ignore */ module);
      const state = w.__app.editor.getState();
      const preview: ImageData = w.__preview;
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
          if (outside && !magenta(x, y)) continue;
          edges++;
          if (magenta(x, y) === outside) edgesOk++;
        }
      }
      return {
        width: c.width,
        height: c.height,
        meanDiff: sum / (got.length / 4),
        bigFraction: big / (got.length / 4),
        edgesOk,
        edges,
      };
    },
    { module: STATE_MODULE, load: LOAD_EXPORT },
  );
  check(
    'export of a hand-resized layout: every tile edge is exactly where the editor puts it (magenta outside, photo inside), and the pixels match the preview',
    exported.width === 1800 &&
      exported.height === 1200 &&
      exported.edges > 0 &&
      exported.edgesOk === exported.edges &&
      exported.meanDiff < 4 &&
      exported.bigFraction < 0.03,
    JSON.stringify(exported),
  );

  // --- 8. Saved format: version 1 unless a tile is stretched by hand ---------
  // A gentle resize keeps every tile within the planner's limit: version 1.
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await drawn(p);
  const gentle = await root(p);
  await dragBy(p, gentle, 12);
  const gentleZip = await saveProject(p, 'divider-gentle');
  const gentleState = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState()),
  );
  const projectJson = (path: string): any =>
    JSON.parse(
      Buffer.from(
        unzipSync(new Uint8Array(readFileSync(path)))['project.json']!,
      ).toString('utf8'),
    );
  const sizes = (): Promise<string> =>
    p.evaluate(async (module) => {
      const { checkTileSizes } = await import(/* @vite-ignore */ module);
      return checkTileSizes((window as any).__app.editor.getState().plan);
    }, LAYOUT_MODULE);
  const gentleSizes = await sizes();
  // Stretch: every divider to one end, until a tile is beyond 2.5:1.
  for (let i = 0; i < 6 && (await sizes()) !== 'resized'; i++) {
    const l = (await lines(p))[i];
    if (l) await dragBy(p, l, -2000);
  }
  const stretchedSizes = await sizes();
  const stretchedZip = await saveProject(p, 'divider-stretched');
  const stretchedState = await p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState()),
  );
  check(
    'save: a gently resized layout is written as version 1, a stretched one as version 2',
    gentleSizes === 'planned' &&
      projectJson(gentleZip).version === 1 &&
      stretchedSizes === 'resized' &&
      projectJson(stretchedZip).version === 2,
    `${gentleSizes} v${String(projectJson(gentleZip).version)}, ${stretchedSizes} v${String(projectJson(stretchedZip).version)}`,
  );
  const fresh = await newPage(browser, origin);
  const e1 = await openProject(fresh.p, stretchedZip);
  const reopened = await fresh.p.evaluate(() =>
    JSON.stringify((window as any).__app.editor.getState()),
  );
  check(
    'open: a stretched (version 2) layout opens here exactly as saved',
    e1 === '' && reopened === stretchedState,
    e1,
  );
  // Save, open, save: project.json is byte for byte the same, and so is its
  // version, for a gently resized and a stretched layout.
  {
    const raw = (path: string): Buffer =>
      Buffer.from(
        unzipSync(new Uint8Array(readFileSync(path)))['project.json']!,
      );
    const results: string[] = [];
    let ok = true;
    for (const [name, zip] of [
      ['stretched', stretchedZip],
      ['gentle', gentleZip],
    ] as const) {
      const e = name === 'stretched' ? '' : await openProject(fresh.p, zip);
      const again = await saveProject(fresh.p, `divider-again-${name}`);
      const same = e === '' && raw(again).equals(raw(zip));
      const v = projectJson(again).version;
      ok &&= same && v === projectJson(zip).version;
      results.push(`${name}: ${same ? 'identical' : 'differs'}, v${String(v)}`);
    }
    check(
      'save, open, save: project.json is byte-identical with the same version (gentle and stretched)',
      ok,
      results.join('; '),
    );
  }
  // Hostile split values are refused, and the open project stays as it was.
  {
    const entries = unzipSync(new Uint8Array(readFileSync(gentleZip)));
    const json = projectJson(gentleZip);
    const cases: [string, unknown][] = [
      ['0', 0],
      ['1', 1],
      ['negative', -0.25],
      ['above 1', 1.5],
      ['null (NaN in JSON)', null],
      ['a string', '0.5'],
      ['so small a tile has no size', 1e-12],
    ];
    const before = await fresh.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    const failures: string[] = [];
    for (const [what, value] of cases) {
      const project = structuredClone(json);
      project.state.plan.root.fraction = value;
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const [name, bytes] of Object.entries(entries)) {
        files[name] = [
          name === 'project.json'
            ? new TextEncoder().encode(JSON.stringify(project))
            : bytes,
          { level: 0 },
        ];
      }
      const path = join(
        tmpdir(),
        `divider-hostile-${String(Date.now())}-${String(Math.random()).slice(2)}.zip`,
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
      if (!error.includes('Could not open the project') || after !== before) {
        failures.push(`${what}: ${error.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    check(
      `a project whose split fraction is 0, 1, negative, above 1, null, a string or tiny is refused, and the open project is unchanged`,
      failures.length === 0,
      failures.join(' | '),
    );
  }
  await fresh.ctx.close();

  if (options.releaseOrigin) {
    // This build opens a project saved by 2026.11.0 unchanged.
    const rel = await newPage(browser, options.releaseOrigin);
    await addSized(rel.p, TWELVE.slice(0, 9));
    const relState = await rel.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    const relZip = await saveProject(rel.p, 'divider-release');
    const here = await newPage(browser, origin);
    const e2 = await openProject(here.p, relZip);
    const hereState = await here.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    check(
      'compat: a project saved by 2026.11.0 opens here unchanged',
      e2 === '' && hereState === relState,
      e2,
    );
    await here.ctx.close();
    // 2026.11.0 opens a gently resized (version 1) project, hand resizing
    // included, and refuses a stretched (version 2) one with a clear
    // message, leaving its open project as it was.
    const e3 = await openProject(rel.p, gentleZip);
    const inRelease = await rel.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    // The release ignores the featured mark (#14); everything else is the
    // same, the hand-resized plan included.
    const unmarked = JSON.parse(gentleState);
    delete unmarked.featured;
    check(
      'compat: 2026.11.0 opens a gently resized project (version 1) with the same layout',
      e3 === '' &&
        inRelease === JSON.stringify(unmarked) &&
        JSON.parse(inRelease).plan.root.fraction !==
          JSON.parse(relState).plan.root.fraction,
      e3 || `${inRelease.length} vs ${JSON.stringify(unmarked).length} chars`,
    );
    const before = await rel.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    const e4 = await openProject(rel.p, stretchedZip);
    const after = await rel.p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState()),
    );
    check(
      'compat: 2026.11.0 refuses a stretched project (version 2) as "saved by a newer version", leaving its project as it was',
      e4.includes('newer version') && after === before,
      e4.replace(/\s+/g, ' ').slice(0, 200),
    );
    console.log(
      `INFO  2026.11.0 on a version 2 file: ${e4.replace(/\s+/g, ' ').slice(0, 200)}`,
    );
    await rel.ctx.close();
  }

  // --- 9. Features and warnings ----------------------------------------------
  {
    const featured = await p.evaluate(
      () => (window as any).__app.editor.getState().featured ?? [],
    );
    const a0 = await p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState().assignment),
    );
    const l = await root(p);
    await dragBy(p, l, 80);
    const a1 = await p.evaluate(() =>
      JSON.stringify((window as any).__app.editor.getState().assignment),
    );
    check(
      'features: a divider drag moves no photo, featured or not',
      featured.length > 0 && a0 === a1,
      `${String(featured.length)} featured`,
    );
  }
  await ctx.close();

  // Low-resolution warnings update live during a drag.
  {
    const w = await newPage(browser, origin);
    // Small photos on a large canvas: each tile is near the warning line.
    await addSized(
      w.p,
      Array.from({ length: 6 }, () => [1200, 800] as const),
    );
    await act(w.p, 'setCanvasSize', 4000, 2500);
    const levels = (): Promise<string> =>
      w.p.evaluate(() => {
        const app = (window as any).__app;
        return app.editor
          .getState()
          .assignment.map(
            (id: string) => app.resolution.warningFor(id)?.level ?? 'ok',
          )
          .join(',');
      });
    const l0 = await levels();
    const l = await root(w.p);
    await w.p.mouse.move(l.x, l.y);
    await w.p.mouse.down();
    // Far towards each side in turn, in one drag: the tiles on the growing
    // side get as large as they may, so their photos are stretched further.
    const readings: string[] = [];
    let stillDown = true;
    for (const reach of [2000, -2000]) {
      await glide(
        w.p,
        l.x,
        l.y,
        l.x + (l.axis === 'x' ? reach : 0),
        l.y + (l.axis === 'y' ? reach : 0),
      );
      await w.p.waitForTimeout(100);
      readings.push(await levels());
      stillDown &&= await w.p.evaluate(() =>
        (window as any).__app.editor.isDragging(),
      );
    }
    await w.p.mouse.up();
    await drawn(w.p);
    check(
      'warnings: low-resolution warnings update live while the divider is dragged',
      stillDown && readings.some((r) => r !== l0),
      `${l0} -> ${readings.join(' -> ')}`,
    );
    await w.ctx.close();
  }

  // --- 10. Keyboard -------------------------------------------------------------
  {
    const k = await newPage(browser, origin);
    await addSized(k.p, TWELVE);
    const kp = k.p;
    const sepInfo = () =>
      kp.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return {
          sep: a.classList.contains('divider-sep'),
          role: a.getAttribute('role'),
          path: a.dataset.path ?? null,
          orientation: a.getAttribute('aria-orientation'),
          now: Number(a.getAttribute('aria-valuenow')),
          min: Number(a.getAttribute('aria-valuemin')),
          max: Number(a.getAttribute('aria-valuemax')),
          text: a.getAttribute('aria-valuetext'),
          label: a.getAttribute('aria-label'),
          stops: document.querySelectorAll('.divider-sep[tabindex="0"]').length,
          seps: document.querySelectorAll('.divider-sep').length,
          highlight:
            !document.querySelector<HTMLElement>('.divider-highlight')!.hidden,
        };
      });
    // Tab order: canvas, the tile menu (with a tile selected), then the
    // dividers.
    await kp.locator('.collage-canvas').focus();
    await kp.keyboard.press('Enter');
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      await kp.keyboard.press('Tab');
      order.push(
        await kp.evaluate(() => {
          const a = document.activeElement as HTMLElement;
          if (a.classList.contains('divider-sep')) return 'divider';
          return a.tagName === 'INPUT' ? 'slider' : a.textContent.trim();
        }),
      );
      if (order.at(-1) === 'divider') break;
    }
    check(
      'keyboard: Tab goes canvas, tile menu, then the dividers',
      order.join() === 'Swap,Remove,Feature,slider,Reset,divider',
      order.join(),
    );
    await kp.keyboard.press('Escape');
    const s0 = await sepInfo();
    check(
      'keyboard: the dividers are one tab stop of separators, announced with orientation, value and range',
      s0.sep &&
        s0.role === 'separator' &&
        s0.stops === 1 &&
        s0.seps === 11 &&
        (s0.orientation === 'vertical' || s0.orientation === 'horizontal') &&
        s0.min < s0.now &&
        s0.now < s0.max &&
        /% (left|top), /.test(s0.text ?? '') &&
        /^Divider 1 of 11, between \d+ tiles? (on the left|above) and \d+ tiles? (on the right|below)$/.test(
          s0.label ?? '',
        ) &&
        s0.highlight,
      JSON.stringify(s0),
    );
    const vertical = s0.orientation === 'vertical';
    const more = vertical ? 'ArrowRight' : 'ArrowDown';
    const less = vertical ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
    const kc0 = await commits(kp);
    const plan0 = await planJson(kp);
    await kp.keyboard.press(more);
    await kp.keyboard.press(more);
    await kp.keyboard.press(`Shift+${more}`);
    await kp.waitForTimeout(500);
    await drawn(kp);
    const s1 = await sepInfo();
    check(
      'keyboard: arrow keys move the divider (Shift for a bigger step); one sequence is one commit',
      s1.now > s0.now + 5 && (await commits(kp)) === kc0 + 1 && s1.sep,
      `${String(s0.now)} -> ${String(s1.now)}, ${String((await commits(kp)) - kc0)} commits`,
    );
    await kp.keyboard.press('Control+z');
    await kp.keyboard.press('Meta+z');
    await drawn(kp);
    check(
      'keyboard: one undo restores the layout before the key sequence',
      (await planJson(kp)) === plan0,
    );
    const plan1 = await planJson(kp);
    const kc1 = await commits(kp);
    await kp.locator('.divider-sep[tabindex="0"]').focus();
    await kp.keyboard.press(less);
    await kp.keyboard.press(less);
    await kp.waitForTimeout(50);
    const movedByKeys = (await planJson(kp)) !== plan1;
    await kp.keyboard.press('Escape');
    await kp.waitForTimeout(400);
    await drawn(kp);
    check(
      'keyboard: Escape cancels an uncommitted key sequence',
      movedByKeys &&
        (await planJson(kp)) === plan1 &&
        (await commits(kp)) === kc1,
    );
    await kp.keyboard.press(nextKey);
    const s2 = await sepInfo();
    check(
      'keyboard: the arrow keys along the line go to the next divider, still one tab stop',
      s2.sep && s2.path !== s0.path && s2.stops === 1,
      JSON.stringify(s2),
    );
    await kp.keyboard.press('End');
    await kp.waitForTimeout(400);
    const s3k = await sepInfo();
    check(
      'keyboard: End moves a divider to its limit',
      Math.abs(s3k.now - s3k.max) < 0.11,
      JSON.stringify(s3k),
    );
    await kp.keyboard.press('Tab');
    const left = await kp.evaluate(
      () => !document.activeElement?.classList.contains('divider-sep'),
    );
    check('keyboard: Tab leaves the dividers in one step', left);
    // Whatever the menu covers, the keyboard reaches every divider: with a
    // tile selected (its menu showing), Tab to the dividers and walk along.
    {
      await kp.locator('.collage-canvas').focus();
      await kp.keyboard.press('Enter');
      for (let i = 0; i < 8; i++) {
        await kp.keyboard.press('Tab');
        if ((await sepInfo()).sep) break;
      }
      const menuShown = await kp.evaluate(
        () => !document.querySelector<HTMLElement>('.tile-menu')!.hidden,
      );
      // Back to the first divider, then along every one.
      for (let i = 0; i < 40; i++) {
        const s = await sepInfo();
        await kp.keyboard.press(
          s.orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft',
        );
        if ((await sepInfo()).path === s.path) break;
      }
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const s = await sepInfo();
        if (!s.sep || s.path === null) break;
        seen.add(s.path);
        if (seen.size === s.seps) break;
        await kp.keyboard.press(
          s.orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight',
        );
      }
      const total = (await sepInfo()).seps;
      check(
        "keyboard: with a tile's menu showing, every divider is reached from the keyboard",
        menuShown && seen.size === total && total === 11,
        `${String(seen.size)} of ${String(total)}`,
      );
    }
    if (k.errors.length > 0) {
      check(
        'dividers: no console errors (keyboard page)',
        false,
        k.errors.join(' | '),
      );
    }
    await k.ctx.close();
  }

  // Sharper decodes wait for the drag, then start once it has ended: three
  // large photos, so the tiles need more than their 1024 px previews.
  {
    const d = await newPage(browser, origin, { width: 1440, height: 900 }, 2);
    await addSized(d.p, [
      [6000, 4000],
      [4000, 6000],
      [6000, 4000],
    ]);
    const settle = () =>
      d.p.waitForFunction(
        () => {
          const last = (window as any).__app.view.lastRender();
          return last && (last.upgrading ?? 0) === 0;
        },
        undefined,
        { timeout: 60_000 },
      );
    await drawn(d.p);
    await settle();
    const decodes = (): Promise<number> =>
      d.p.evaluate(
        () => (window as any).__app.view.imageCacheStats().detailDecodes,
      );
    // Each side in turn grows as far as it may, until a drag needs sharper
    // images (one side may already be as sharp as it can get).
    const runs: string[] = [];
    let ok = true;
    let started = false;
    for (const grow of [2000, -2000]) {
      const n0 = await decodes();
      const l = await root(d.p);
      await d.p.mouse.move(l.x, l.y);
      await d.p.mouse.down();
      await glide(
        d.p,
        l.x,
        l.y,
        l.x + (l.axis === 'x' ? grow : 0),
        l.y + (l.axis === 'y' ? grow : 0),
        12,
      );
      await d.p.waitForTimeout(600);
      const n1 = await decodes();
      await d.p.mouse.up();
      await drawn(d.p);
      // The cache waits a moment after the last change before decoding.
      await d.p
        .waitForFunction(
          (n) => (window as any).__app.view.imageCacheStats().detailDecodes > n,
          n1,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      await settle();
      const n2 = await decodes();
      runs.push(`${String(n1 - n0)} during, ${String(n2 - n1)} after`);
      ok &&= n1 === n0;
      if (n2 > n1) {
        started = true;
        break;
      }
    }
    check(
      'divider drag: no decode of an original starts while the pointer is down, and they start once it is released',
      ok && started,
      runs.join('; '),
    );
    await d.ctx.close();
  }

  // --- 11. 300 photos: dragging a divider stays smooth -----------------------
  // (DIVIDER_SKIP_PERF=1 leaves it out, for quick sweeps over seeds.)
  if (process.env.DIVIDER_SKIP_PERF !== '1') {
    const big = await newPage(
      browser,
      origin,
      { width: 1920, height: 1080 },
      2,
    );
    await addPhotos(big.p, 300);
    await drawn(big.p);
    const stats = () =>
      big.p.evaluate(() => (window as any).__app.view.imageCacheStats());
    const measure = async (
      drive: (f: number) => Promise<void>,
    ): Promise<{ median: number; p95: number; detail: number }> => {
      await big.p.evaluate(() => {
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
      const before = await stats();
      const moves = 120;
      for (let i = 0; i <= moves; i++) {
        const f = i <= moves / 2 ? (2 * i) / moves : 2 - (2 * i) / moves;
        await drive(f);
        await big.p.waitForTimeout(16);
      }
      await big.p.waitForTimeout(450);
      const during = await stats();
      const frames = await big.p.evaluate(() => {
        (window as any).__stop = true;
        return [...((window as any).__frames as number[])].slice(2);
      });
      frames.sort((a, b) => a - b);
      return {
        median: frames[Math.floor(frames.length / 2)]!,
        p95: frames[Math.floor(frames.length * 0.95)]!,
        detail: during.detailDecodes - before.detailDecodes,
      };
    };
    const results: { dial: any[]; divider: any[] } = { dial: [], divider: [] };
    for (let run = 0; run < 3; run++) {
      // The dial, as on master.
      const box = (await big.p.locator('#size-variation').boundingBox())!;
      const y = box.y + box.height / 2;
      await big.p.mouse.move(box.x + 1, y);
      await big.p.mouse.down();
      results.dial.push(
        await measure((f) =>
          big.p.mouse.move(box.x + 1 + (box.width - 2) * 0.3 * f, y),
        ),
      );
      await big.p.mouse.up();
      await big.p.waitForFunction(
        () => !(window as any).__app.editor.isDragging(),
      );
      await drawn(big.p);
      // The root divider, a third of the canvas each way.
      const l = await root(big.p);
      const reach = l.axis === 'x' ? 300 : 180;
      const c0 = await commits(big.p);
      await big.p.mouse.move(l.x, l.y);
      await big.p.mouse.down();
      results.divider.push(
        await measure((f) =>
          big.p.mouse.move(
            l.x + (l.axis === 'x' ? reach * (f - 0.5) * 2 : 0),
            l.y + (l.axis === 'y' ? reach * (f - 0.5) * 2 : 0),
          ),
        ),
      );
      await big.p.mouse.up();
      await drawn(big.p);
      if ((await commits(big.p)) !== c0 + 1)
        results.divider.at(-1).commits = false;
    }
    const mid = (xs: number[]): number => [...xs].sort((a, b) => a - b)[1]!;
    const fmt = (rs: any[]) =>
      `median ${mid(rs.map((r) => r.median)).toFixed(1)} ms, p95 ${mid(rs.map((r) => r.p95)).toFixed(1)} ms (runs: ${rs.map((r) => `${r.median.toFixed(1)}/${r.p95.toFixed(1)}`).join(', ')})`;
    console.log(
      `INFO  300 photos, 1920 x 1080 at pixel ratio 2, frame gaps while dragging: the dial ${fmt(results.dial)}; a divider ${fmt(results.divider)}`,
    );
    check(
      'divider drag with 300 photos stays smooth (median frame gap under 25 ms, one commit per drag)',
      mid(results.divider.map((r) => r.median)) < 25 &&
        results.divider.every((r) => r.commits !== false),
      fmt(results.divider),
    );
    check(
      'divider drag with 300 photos: no decode of an original starts while the pointer is down',
      results.divider.every((r) => r.detail === 0),
      results.divider.map((r) => String(r.detail)).join('/'),
    );
    await big.ctx.close();
  }

  check('dividers: no console errors', errors.length === 0, errors.join(' | '));
}
