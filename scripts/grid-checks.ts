/**
 * Real-browser checks for the Grid layout (issue #20), called from
 * browser-check.ts (in the full run, and alone with `--grid-only`). Photos
 * are generated in the page (flat gradients with their number on them), so
 * nothing is read from disk and no real photo is involved. Every check that
 * depends on the arrangement fixes it first with a fixed seed (#54).
 *
 *   node scripts/browser-check.ts --grid-only [--grid-screenshot]
 *   node scripts/browser-check.ts --grid-only --feature-compat <2026.11.0 checkout>
 *
 * With `--feature-compat`, also opens projects across the release: a
 * project saved by 2026.11.0 opens here as a mosaic, and grid projects saved
 * here open in 2026.11.0 (version 1) or are refused by it (version 2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type { Browser, Page } from 'playwright-core';
import { checkSeed } from './check-seed.ts';
import { INIT_SCRIPT, LOAD_EXPORT } from './export-checks.ts';
import {
  act,
  addSized,
  drawn,
  openProject,
  saveProject,
} from './feature-checks.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

const STATE_MODULE = '/src/editor/state.ts';
const LAYOUT_MODULE = '/src/layout/index.ts';
const HELPERS_MODULE = '/src/layout/test-helpers.ts';

export interface GridCheckOptions {
  /** Write docs/screenshots/issue-20-*.png here. */
  readonly screenshots?: string;
  /** The released app's dev server, for the compatibility checks. */
  readonly releaseOrigin?: string;
}

/** 12 photos, mostly landscape, large enough for no resolution warnings. */
const TWELVE: (readonly [number, number])[] = Array.from(
  { length: 12 },
  (_, i) =>
    (
      [
        [2400, 1800],
        [2400, 1800],
        [1800, 2400],
        [2400, 1600],
        [2000, 2000],
        [2400, 1800],
      ] as const
    )[i % 6]!,
);

async function newPage(
  browser: Browser,
  origin: string,
  viewport = { width: 1440, height: 900 },
) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
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
const stateJson = (p: Page): Promise<string> =>
  p.evaluate(() => JSON.stringify((window as any).__app.editor.getState()));
const state = (p: Page): Promise<any> =>
  p.evaluate(() =>
    JSON.parse(JSON.stringify((window as any).__app.editor.getState())),
  );

/** Shuffle with a fixed seed, so geometry checks see a known arrangement. */
async function fix(p: Page, fallback: number): Promise<number> {
  const seed = checkSeed(fallback);
  await act(p, 'shuffle', seed);
  return seed;
}

interface Geometry {
  /** Cells per row, top to bottom. */
  rows: number[];
  /** Largest difference between row heights, in canvas px. */
  heightSpread: number;
  /** Largest difference between cell widths within one row. */
  widthSpread: number;
  /** Largest difference between the cell widths of full rows. */
  fullSpread: number;
  /** Every row starts at the left margin and ends at the right one. */
  spans: boolean;
  /** Whether a partial last row's cells are wider than a full row's. */
  lastWider: boolean | null;
  /** tilingError of the drawn tiles (null: exact). */
  tiling: string | null;
  /** The drawn tiles are tilesFor at the drawn size. */
  drawnIsTilesFor: boolean;
}

/** The grid as drawn on the preview canvas now. */
function geometry(p: Page): Promise<Geometry> {
  return p.evaluate(
    async ({ layout, helpers, stateModule }) => {
      const { gridRows, gridColumnsOf } = await import(
        /* @vite-ignore */ layout
      );
      const { tilingError } = await import(/* @vite-ignore */ helpers);
      const { tilesFor, borderAt } = await import(
        /* @vite-ignore */ stateModule
      );
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const size = { width: c.width, height: c.height };
      const tiles = last.tiles as any[];
      const plan = last.state.plan;
      const rows: number[] = gridRows(plan.count, gridColumnsOf(plan));
      const bySlot: any[] = [];
      for (const t of tiles) bySlot[t.slot] = t;
      const spread = (v: number[]): number =>
        v.length === 0 ? 0 : Math.max(...v) - Math.min(...v);
      const border =
        last.state.canvas.borderFraction > 0
          ? borderAt(last.state, size).effective
          : 0;
      let slot = 0;
      const heights: number[] = [];
      let widthSpread = 0;
      const full: number[] = [];
      let spans = true;
      const firstWidths: number[] = [];
      for (const cells of rows) {
        const row = bySlot.slice(slot, slot + cells);
        slot += cells;
        heights.push(row[0].height);
        widthSpread = Math.max(widthSpread, spread(row.map((t) => t.width)));
        if (cells === rows[0]) full.push(...row.map((t) => t.width));
        firstWidths.push(row[0].width);
        const end = row[row.length - 1];
        spans &&= row[0].x === border && end.x + end.width === c.width - border;
      }
      const partial = rows.length > 1 && rows.at(-1)! < rows[0]!;
      return {
        rows,
        heightSpread: spread(heights),
        widthSpread,
        fullSpread: spread(full),
        spans,
        lastWider: partial ? firstWidths.at(-1)! > firstWidths[0]! : null,
        tiling: tilingError(tiles, c.width, c.height, border, 0),
        drawnIsTilesFor:
          JSON.stringify(tilesFor(last.state, size)) === JSON.stringify(tiles),
      };
    },
    {
      layout: LAYOUT_MODULE,
      helpers: HELPERS_MODULE,
      stateModule: STATE_MODULE,
    },
  );
}

const gridOk = (g: Geometry): boolean =>
  g.tiling === null &&
  g.drawnIsTilesFor &&
  g.heightSpread <= 1 &&
  g.widthSpread <= 1 &&
  g.fullSpread <= 1 &&
  g.spans;

const describeGeometry = (g: Geometry): string =>
  `rows ${g.rows.join('+')}; heights within ${String(g.heightSpread)} px, cells within ${String(g.widthSpread)} px, full rows within ${String(g.fullSpread)} px; ${g.spans ? 'every row spans' : 'a row does not span'}${g.lastWider === null ? '' : `; last row wider: ${String(g.lastWider)}`}${g.tiling ? `; ${g.tiling}` : ''}${g.drawnIsTilesFor ? '' : '; drawn tiles differ from tilesFor'}`;

/** The client point at the centre of a slot's tile. */
function centre(p: Page, slot: number): Promise<{ x: number; y: number }> {
  return p.evaluate((slot) => {
    const { tiles } = (window as any).__app.view.lastRender();
    const t = tiles.find((t: any) => t.slot === slot);
    const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    const r = c.getBoundingClientRect();
    return {
      x: r.left + ((t.x + t.width / 2) * r.width) / c.width,
      y: r.top + ((t.y + t.height / 2) * r.height) / c.height,
    };
  }, slot);
}

/** Clicks Undo in the top bar and waits for the result to be drawn. */
async function undo(p: Page): Promise<void> {
  await p.getByRole('button', { name: /^Undo/ }).click();
  await drawn(p);
}

/** The panel's boxes, for the fit checks. */
function panelFit(p: Page) {
  return p.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.settings')!;
    const pr = panel.getBoundingClientRect();
    const sections = [
      ...panel.querySelectorAll<HTMLElement>('.settings-section'),
    ].filter((el) => el.getClientRects().length > 0);
    const overlaps: string[] = [];
    for (let i = 1; i < sections.length; i++) {
      const a = sections[i - 1]!.getBoundingClientRect();
      const b = sections[i]!.getBoundingClientRect();
      if (b.top < a.bottom - 0.5) {
        overlaps.push(
          `${sections[i - 1]!.getAttribute('aria-labelledby') ?? ''} / ${sections[i]!.getAttribute('aria-labelledby') ?? ''}`,
        );
      }
    }
    // Every visible control lies within the panel's width.
    const outside = [
      ...panel.querySelectorAll<HTMLElement>('button, input, select, output'),
    ]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < pr.left - 0.5 || r.right > pr.right + 0.5;
      })
      .map((el) => el.id || el.className || el.tagName);
    const canvas = document
      .querySelector('.collage-canvas')!
      .getBoundingClientRect();
    const intersects =
      canvas.left < pr.right &&
      canvas.right > pr.left &&
      canvas.top < pr.bottom &&
      canvas.bottom > pr.top;
    const before = panel.scrollTop;
    panel.scrollTop = panel.scrollHeight;
    const footer = panel
      .querySelector('.settings-footer')!
      .getBoundingClientRect();
    const footerVisible = footer.bottom <= pr.bottom + 0.5;
    const scrolled = panel.scrollTop;
    panel.scrollTop = before;
    return {
      first: sections[0]?.getAttribute('aria-labelledby') ?? '',
      scrollable: panel.scrollHeight > panel.clientHeight,
      scrolled,
      footerVisible,
      horizontal: panel.scrollWidth > panel.clientWidth,
      overlaps,
      outside,
      intersects,
      inViewport:
        pr.top >= 0 && pr.bottom <= innerHeight + 0.5 && pr.right <= innerWidth,
    };
  });
}

export async function checkGrid(
  browser: Browser,
  origin: string,
  check: Check,
  options: GridCheckOptions = {},
): Promise<void> {
  console.log('\nGrid layout (issue #20)');
  const { ctx, p, errors } = await newPage(browser, origin);
  await addSized(p, TWELVE);
  await fix(p, 2001);
  await act(p, 'setVariation', 0.23);
  const mosaicState = await stateJson(p);

  // --- The Layout control --------------------------------------------------
  const control = await p.evaluate(() => {
    const first = document.querySelector('.settings .settings-section');
    const group = document.querySelector(
      '[role=radiogroup][aria-label=Layout]',
    );
    const radios = [
      ...(group?.querySelectorAll<HTMLInputElement>('input[type=radio]') ?? []),
    ];
    return {
      firstHeading: first?.querySelector('h2')?.textContent ?? '',
      inFirst: !!group && !!first?.contains(group),
      labels: radios.map((r) => r.parentElement?.textContent ?? ''),
      checked: radios.filter((r) => r.checked).map((r) => r.value),
      columnsHidden:
        document.querySelector<HTMLElement>('.columns-row')!.hidden &&
        document.querySelector('.columns-row')!.getClientRects().length === 0,
      topbarHasLayout: !!document.querySelector(
        '.topbar [name=layout-kind], .topbar #grid-columns',
      ),
    };
  });
  check(
    'the Layout control is the first settings section: a radio group "Layout" with Mosaic and Grid, Mosaic checked',
    control.firstHeading === 'Layout' &&
      control.inFirst &&
      control.labels.join(',') === 'Mosaic,Grid' &&
      control.checked.join(',') === 'mosaic',
    JSON.stringify(control),
  );
  check(
    'Columns is hidden in Mosaic, and nothing was added to the top bar',
    control.columnsHidden && !control.topbarHasLayout,
  );

  // Switch with the keyboard: arrow keys move and select in a radio group.
  await p.focus('input[name=layout-kind][value=mosaic]');
  const c0 = await commits(p);
  await p.keyboard.press('ArrowRight');
  await drawn(p);
  const inGrid = await p.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    const dial = document.querySelector<HTMLInputElement>('#size-variation')!;
    const describedBy = dial.getAttribute('aria-describedby') ?? '';
    const select = document.querySelector<HTMLSelectElement>('#grid-columns')!;
    return {
      layout: s.layout,
      kind: s.plan.kind,
      variation: s.variation,
      dialDisabled: dial.disabled,
      dialValue: dial.valueAsNumber,
      description: document.getElementById(describedBy)?.textContent ?? '',
      columnsVisible: select.getClientRects().length > 0,
      label: select.labels[0]?.textContent ?? '',
      firstOption: select.options[0]?.textContent ?? '',
      value: select.value,
    };
  });
  const autoColumns = await p.evaluate(async (layout) => {
    const { gridColumnsOf } = await import(/* @vite-ignore */ layout);
    return gridColumnsOf(
      (window as any).__app.editor.getState().plan,
    ) as number;
  }, LAYOUT_MODULE);
  check(
    'arrow key in the Layout group switches to Grid: one commit, the plan is a grid',
    inGrid.layout === 'grid' &&
      inGrid.kind === 'grid' &&
      (await commits(p)) === c0 + 1,
    JSON.stringify(inGrid),
  );
  check(
    'in Grid the dial is disabled, keeps its value, and is described to assistive technology',
    inGrid.dialDisabled &&
      inGrid.variation === 0.23 &&
      inGrid.dialValue === 0.23 &&
      inGrid.description.includes('does not apply to the Grid layout'),
    `${inGrid.description} (value ${String(inGrid.dialValue)})`,
  );
  check(
    'a labelled Columns control appears, on Auto, naming the column count Auto chose',
    inGrid.columnsVisible &&
      inGrid.label === 'Columns' &&
      inGrid.value === 'auto' &&
      inGrid.firstOption === `Auto (${String(autoColumns)})`,
    `${inGrid.label}: ${inGrid.firstOption}`,
  );
  await p.keyboard.press('Tab');
  check(
    'Tab moves from the Layout group to the Columns control',
    (await p.evaluate(() => document.activeElement?.id)) === 'grid-columns',
  );

  // --- A full grid: geometry with a border ----------------------------------
  await act(p, 'setBorder', 0.012);
  await act(p, 'setColumns', 4);
  const full = await geometry(p);
  check(
    '12 photos in 4 columns: 3 full rows of equal height and equal-width cells, filling the canvas exactly (1% border, snapped)',
    gridOk(full) && full.rows.join(',') === '4,4,4',
    describeGeometry(full),
  );
  if (options.screenshots) {
    await p.screenshot({
      path: join(options.screenshots, 'issue-20-full-grid.png'),
    });
  }

  // --- Columns by hand: a partial last row ----------------------------------
  const before5 = await stateJson(p);
  const c1 = await commits(p);
  await p.selectOption('#grid-columns', '5');
  await drawn(p);
  const partial = await geometry(p);
  check(
    'choosing 5 columns: one commit; rows 5+5+2, the last row wider and spanning the width',
    (await commits(p)) === c1 + 1 &&
      gridOk(partial) &&
      partial.rows.join(',') === '5,5,2' &&
      partial.lastWider === true,
    describeGeometry(partial),
  );
  if (options.screenshots) {
    await p.screenshot({
      path: join(options.screenshots, 'issue-20-partial-grid.png'),
    });
    await p
      .locator('.settings-section')
      .first()
      .screenshot({
        path: join(options.screenshots, 'issue-20-columns-control.png'),
      });
  }
  await undo(p);
  check(
    'Undo after changing columns restores the previous grid exactly',
    (await stateJson(p)) === before5,
  );
  await p.selectOption('#grid-columns', '5');
  await drawn(p);
  const c2 = await commits(p);
  await p.selectOption('#grid-columns', 'auto');
  await drawn(p);
  const backAuto = await state(p);
  check(
    'Columns returns to Auto: one commit, no columns key, the Auto column count',
    (await commits(p)) === c2 + 1 &&
      !('columns' in backAuto) &&
      (await geometry(p)).rows[0] === autoColumns,
  );
  // A setting above the photo count is offered, kept, and clamped.
  await p.selectOption('#grid-columns', '12');
  await drawn(p);
  const oneRow = await geometry(p);
  check(
    '12 columns for 12 photos: a single row',
    gridOk(oneRow) && oneRow.rows.join(',') === '12',
    describeGeometry(oneRow),
  );
  await p.selectOption('#grid-columns', '4');
  await drawn(p);

  // --- Shuffle --------------------------------------------------------------
  const beforeShuffle = await state(p);
  const c3 = await commits(p);
  await p.getByRole('button', { name: 'Shuffle' }).click();
  await drawn(p);
  const shuffled = await state(p);
  check(
    'Shuffle in a grid: one commit; the same cells, photos in other cells',
    (await commits(p)) === c3 + 1 &&
      JSON.stringify(shuffled.plan.root) ===
        JSON.stringify(beforeShuffle.plan.root) &&
      JSON.stringify(shuffled.assignment) !==
        JSON.stringify(beforeShuffle.assignment) &&
      shuffled.layout === 'grid',
  );
  await undo(p);
  check(
    'Undo after Shuffle restores the previous arrangement exactly',
    (await stateJson(p)) === JSON.stringify(beforeShuffle),
  );

  // --- Swap and Remove through the tile menu --------------------------------
  {
    const s = await state(p);
    const a = await centre(p, 0);
    await p.mouse.click(a.x, a.y);
    await p.locator('.tile-menu').getByRole('button', { name: 'Swap' }).click();
    const b = await centre(p, 6);
    const c4 = await commits(p);
    await p.mouse.click(b.x, b.y);
    await drawn(p);
    const after = await state(p);
    check(
      'Swap in a grid exchanges the two cells’ photos: one commit, the grid unchanged',
      (await commits(p)) === c4 + 1 &&
        after.assignment[0] === s.assignment[6] &&
        after.assignment[6] === s.assignment[0] &&
        JSON.stringify(after.plan) === JSON.stringify(s.plan),
    );
    const r = await centre(p, 3);
    await p.mouse.click(r.x, r.y);
    await p
      .locator('.tile-menu')
      .getByRole('button', { name: 'Remove' })
      .click();
    await drawn(p);
    const removed = await state(p);
    const g = await geometry(p);
    check(
      'Remove in a grid: 11 photos re-arranged as a grid with a partial last row',
      removed.photos.length === 11 &&
        removed.layout === 'grid' &&
        gridOk(g) &&
        g.rows.join(',') === '4,4,3' &&
        g.lastWider === true,
      describeGeometry(g),
    );
  }

  // --- Crop, feature and the dividers ----------------------------------------
  {
    const s = await state(p);
    const id = s.assignment[1] as string;
    await act(p, 'setCrop', id, { x: 0.2, y: 0.6, zoom: 1.8 });
    const cropped = await state(p);
    const zoomed = await p.evaluate(() => {
      const last = (window as any).__app.view.lastRender();
      return last.state.crops !== undefined;
    });
    check(
      'a crop in a grid changes only that photo’s crop: same plan and cells',
      zoomed &&
        cropped.crops[id]?.zoom === 1.8 &&
        JSON.stringify(cropped.plan) === JSON.stringify(s.plan) &&
        JSON.stringify(cropped.assignment) === JSON.stringify(s.assignment),
    );
    // Feature the photo in the top-left cell: it moves into a wide cell of
    // the partial last row, with one swap, and its star is drawn there.
    const target = cropped.assignment[0] as string;
    await act(p, 'setFeatured', target, true);
    const featured = await state(p);
    const starOnTile = await p.evaluate((target) => {
      const app = (window as any).__app;
      const last = app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const cr = c.getBoundingClientRect();
      const sc = cr.width / c.width;
      const star = [
        ...document.querySelectorAll<HTMLElement>('.feat-layer .feat-star'),
      ].find((el) => el.dataset.photoId === target);
      if (!star || star.getClientRects().length === 0) return false;
      const r = star.getBoundingClientRect();
      const slot = last.state.assignment.indexOf(target);
      const t = last.tiles.find((x: any) => x.slot === slot);
      return (
        r.left >= cr.left + t.x * sc - 0.5 &&
        r.right <= cr.left + (t.x + t.width) * sc + 0.5 &&
        r.top >= cr.top + t.y * sc - 0.5 &&
        r.bottom <= cr.top + (t.y + t.height) * sc + 0.5
      );
    }, target);
    const moved = featured.assignment.filter(
      (x: string, i: number) => x !== cropped.assignment[i],
    ).length;
    check(
      'featuring a photo in a grid moves it into a wide last-row cell with one swap, star on its tile',
      featured.assignment.indexOf(target) >= 8 && moved === 2 && starOnTile,
      `slot ${String(featured.assignment.indexOf(target))}, ${String(moved)} moved`,
    );
    // Featuring the photo in the other wide cell moves nothing.
    const other = featured.assignment.find(
      (x: string, i: number) => i >= 8 && x !== target,
    ) as string;
    await act(p, 'setFeatured', other, true);
    check(
      'featuring a photo already in a wide cell moves nothing',
      JSON.stringify((await state(p)).assignment) ===
        JSON.stringify(featured.assignment),
    );

    // Drag the divider between the first two rows down by 30 px.
    const line = await p.evaluate(async (module) => {
      const { dividersFor } = await import(/* @vite-ignore */ module);
      const last = (window as any).__app.view.lastRender();
      const c = document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
      const r = c.getBoundingClientRect();
      const s = r.width / c.width;
      const d = dividersFor(last.state, c).find((x: any) => x.path === '');
      return {
        x: r.left + ((d.from + d.to) / 2) * s,
        y: r.top + (d.cut + d.border / 2) * s,
        axis: d.axis as string,
      };
    }, STATE_MODULE);
    const beforeDrag = await stateJson(p);
    const c5 = await commits(p);
    await p.mouse.move(line.x, line.y);
    await p.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await p.mouse.move(line.x, line.y + (30 * i) / 8);
      await p.waitForTimeout(16);
    }
    await p.mouse.up();
    await drawn(p);
    const dragged = await p.evaluate(async (module) => {
      const { validateEditorState } = await import(/* @vite-ignore */ module);
      const s = (window as any).__app.editor.getState();
      let valid = true;
      try {
        validateEditorState(JSON.parse(JSON.stringify(s)));
      } catch {
        valid = false;
      }
      return {
        fraction: s.plan.root.fraction as number,
        valid,
        kind: s.plan.kind,
      };
    }, STATE_MODULE);
    const g = await geometry(p);
    check(
      'dragging the first row divider in a grid: one commit, the row grows, the plan stays a valid grid, tiles still fill the canvas',
      line.axis === 'y' &&
        (await commits(p)) === c5 + 1 &&
        dragged.fraction > 1 / 3 &&
        dragged.valid &&
        dragged.kind === 'grid' &&
        g.tiling === null &&
        g.drawnIsTilesFor,
      `fraction ${dragged.fraction.toFixed(4)}`,
    );
    await undo(p);
    check(
      'Undo after a divider drag restores the grid exactly',
      (await stateJson(p)) === beforeDrag,
    );
  }

  // --- Back to Mosaic: the dial and the mosaic come back (a fresh page) ---
  const { ctx: ctx2, p: q } = await newPage(browser, origin);
  await addSized(q, TWELVE);
  await fix(q, 2001);
  await act(q, 'setVariation', 0.23);
  const startMosaic = await stateJson(q);
  check(
    'the same photos and seed give the same mosaic in a fresh page (fixed seed)',
    JSON.stringify(JSON.parse(startMosaic).plan) ===
      JSON.stringify(JSON.parse(mosaicState).plan),
  );
  await q.locator('input[name=layout-kind][value=grid]').check();
  await drawn(q);
  await act(q, 'setColumns', 3);
  const cBack = await commits(q);
  await q.locator('input[name=layout-kind][value=mosaic]').check();
  await drawn(q);
  const back = await q.evaluate(() => {
    const s = (window as any).__app.editor.getState();
    const dial = document.querySelector<HTMLInputElement>('#size-variation')!;
    return {
      json: JSON.stringify({ ...s, columns: undefined }),
      columns: s.columns,
      dial: dial.valueAsNumber,
      disabled: dial.disabled,
      describedBy: dial.getAttribute('aria-describedby'),
      columnsHidden:
        document.querySelector('.columns-row')!.getClientRects().length === 0,
    };
  });
  check(
    'back to Mosaic: one commit, the dial enabled at its kept value, the same mosaic as before Grid (the column setting kept)',
    (await commits(q)) === cBack + 1 &&
      back.json === JSON.stringify({ ...JSON.parse(startMosaic) }) &&
      back.columns === 3 &&
      back.dial === 0.23 &&
      !back.disabled &&
      back.describedBy === null &&
      back.columnsHidden,
    `dial ${String(back.dial)}, columns ${String(back.columns)}`,
  );
  await undo(q);
  check(
    'Undo after switching layout restores the grid exactly',
    (await state(q)).layout === 'grid' &&
      (await q.evaluate(
        () =>
          document.querySelector<HTMLInputElement>('#size-variation')!.disabled,
      )),
  );
  if (options.screenshots) {
    await act(q, 'setColumns', 'auto');
    await q.locator('input[name=layout-kind][value=mosaic]').check();
    await drawn(q);
    await q
      .locator('.settings-section')
      .first()
      .screenshot({
        path: join(options.screenshots, 'issue-20-layout-control.png'),
      });
  }
  // --- Low-resolution warning on a grid cell ---------------------------------
  {
    await act(q, 'setLayout', 'grid');
    await addSized(q, [[300, 225]]);
    const badge = await q.evaluate(() => {
      const app = (window as any).__app;
      const s = app.editor.getState();
      const small = app.store
        .getPhotos()
        .find((x: any) => x.file.name.endsWith('-300x225.jpg'));
      return {
        layout: s.layout,
        inCollage: s.assignment.includes(small?.id),
        badges: [
          ...document.querySelectorAll<HTMLElement>('.res-layer .res-badge'),
        ].filter((el) => el.getClientRects().length > 0).length,
      };
    });
    check(
      'a low-resolution photo added to a grid gets its warning badge',
      badge.layout === 'grid' && badge.inCollage && badge.badges >= 1,
      JSON.stringify(badge),
    );
  }

  await ctx2.close();

  // --- The settings panel still fits ----------------------------------------
  for (const [w, h] of [
    [900, 620],
    [1440, 900],
  ] as const) {
    await p.setViewportSize({ width: w, height: h });
    await p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await drawn(p);
    const fit = await panelFit(p);
    check(
      `the settings panel at ${String(w)} x ${String(h)} in Grid: Layout first, no overlaps, nothing outside it, no horizontal scroll, scrolls to its footer`,
      fit.first === 'settings-layout' &&
        fit.overlaps.length === 0 &&
        fit.outside.length === 0 &&
        !fit.horizontal &&
        !fit.intersects &&
        fit.inViewport &&
        fit.footerVisible &&
        (fit.scrollable ? fit.scrolled > 0 : true),
      JSON.stringify(fit),
    );
    if (options.screenshots && w === 900) {
      await p.screenshot({
        path: join(options.screenshots, 'issue-20-900x620.png'),
      });
    }
  }
  check(
    'no console errors in the grid page',
    errors.length === 0,
    errors.join(' | '),
  );
  await ctx.close();

  await checkGridExport(browser, origin, check);
  await checkGridProjects(browser, origin, check, options);
}

/** Export of a grid matches the editor (the export checks' comparison). */
async function checkGridExport(
  browser: Browser,
  origin: string,
  check: Check,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin, {
    width: 1280,
    height: 800,
  });
  await addSized(
    p,
    Array.from({ length: 7 }, (_, i) =>
      i % 2 ? ([1800, 2400] as const) : ([2400, 1800] as const),
    ),
  );
  await fix(p, 2002);
  await act(p, 'setCanvasSize', 2400, 1800);
  await act(p, 'setBorder', 0.02);
  await act(p, 'setBackground', '#ff00ff');
  await act(p, 'setLayout', 'grid');
  await act(p, 'setColumns', 3);
  const g = await geometry(p);
  check(
    'export page: 7 photos in 3 columns, rows 3+3+1, equal cells',
    gridOk(g) && g.rows.join(',') === '3,3,1',
    describeGeometry(g),
  );
  await p.evaluate(() => {
    const canvas =
      document.querySelector<HTMLCanvasElement>('.collage-canvas')!;
    (window as any).__preview = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height);
  });
  await p.locator('.export-option', { hasText: 'PNG' }).click();
  await Promise.all([
    p.waitForEvent('download', { timeout: 120_000 }),
    p.locator('.export-download').click(),
  ]);
  await p.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.export-download')!.disabled,
    undefined,
    { timeout: 120_000 },
  );
  const analysis = await p.evaluate(
    async ({ load, stateModule, layout }) => {
      const w = window as any;
      const { ctx, c } = await (0, eval)(`(${load})`)();
      const { tilesFor } = await import(/* @vite-ignore */ stateModule);
      const { gridRows, gridColumnsOf } = await import(
        /* @vite-ignore */ layout
      );
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
      // At the export size: magenta just outside every tile, photo inside.
      const tiles = tilesFor(state, { width: c.width, height: c.height });
      const magenta = (x: number, y: number): boolean => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return d[0] > 240 && d[1] < 15 && d[2] > 240;
      };
      let edges = 0;
      let edgesOk = 0;
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
          edges++;
          if (magenta(x, y) === outside) edgesOk++;
        }
      }
      // Equal cells at the export size too.
      const rows: number[] = gridRows(
        state.plan.count,
        gridColumnsOf(state.plan),
      );
      let slot = 0;
      let spread = 0;
      const heights: number[] = [];
      for (const cells of rows) {
        const row = tiles.slice(slot, slot + cells);
        slot += cells;
        const ws = row.map((t: any) => t.width);
        spread = Math.max(spread, Math.max(...ws) - Math.min(...ws));
        heights.push(row[0].height);
      }
      return {
        width: c.width,
        height: c.height,
        meanDiff: sum / (got.length / 4),
        bigFraction: big / (got.length / 4),
        edges,
        edgesOk,
        cellSpread: spread,
        heightSpread: Math.max(...heights) - Math.min(...heights),
      };
    },
    { load: LOAD_EXPORT, stateModule: STATE_MODULE, layout: LAYOUT_MODULE },
  );
  check(
    'grid export: 2400 x 1800, pixels match the editor preview (downscaled export vs preview)',
    analysis.width === 2400 &&
      analysis.height === 1800 &&
      analysis.meanDiff < 4 &&
      analysis.bigFraction < 0.03,
    `mean abs diff ${analysis.meanDiff.toFixed(2)}, ${(analysis.bigFraction * 100).toFixed(2)}% of pixels over 48`,
  );
  check(
    'grid export: border and background exactly around every cell, cells equal within a pixel at 2400 x 1800',
    analysis.edges > 0 &&
      analysis.edgesOk === analysis.edges &&
      analysis.cellSpread <= 1 &&
      analysis.heightSpread <= 1,
    `${String(analysis.edgesOk)} / ${String(analysis.edges)} edges; cells within ${String(analysis.cellSpread)} px, rows within ${String(analysis.heightSpread)} px`,
  );
  await ctx.close();
}

const projectJson = (path: string): any =>
  JSON.parse(
    Buffer.from(
      unzipSync(new Uint8Array(readFileSync(path)))['project.json']!,
    ).toString('utf8'),
  );
const rawJson = (path: string): Buffer =>
  Buffer.from(unzipSync(new Uint8Array(readFileSync(path)))['project.json']!);

/** Save, open and compatibility with release 2026.11.0. */
async function checkGridProjects(
  browser: Browser,
  origin: string,
  check: Check,
  options: GridCheckOptions,
): Promise<void> {
  const { ctx, p } = await newPage(browser, origin);
  await addSized(p, TWELVE);
  await fix(p, 2003);
  await act(p, 'setBorder', 0.012);
  await act(p, 'setLayout', 'grid');
  await act(p, 'setColumns', 4);
  // A swap, so the arrangement saved is not just the canonical one.
  await act(p, 'swapTiles', 0, 7);
  const gridState = await stateJson(p);
  const gentle = await saveProject(p, 'grid-gentle');
  // One column of 12 on 16:9: cells 21:1, beyond 2026.11.0's limit.
  await act(p, 'setColumns', 1);
  const stripState = await stateJson(p);
  const strip = await saveProject(p, 'grid-strip');
  await ctx.close();

  const results: string[] = [];
  let ok = true;
  for (const [name, zip, expected, version] of [
    ['4 columns', gentle, gridState, 1],
    ['1 column', strip, stripState, 2],
  ] as const) {
    const { ctx: c2, p: q } = await newPage(browser, origin);
    const error = await openProject(q, zip);
    const opened = await stateJson(q);
    const again = await saveProject(q, `grid-again-${name.replace(' ', '-')}`);
    const same = rawJson(again).equals(rawJson(zip));
    const v = projectJson(zip).version as number;
    const fine = error === '' && opened === expected && same && v === version;
    ok &&= fine;
    results.push(
      `${name}: ${error ? 'error' : 'opened'}, state ${opened === expected ? 'equal' : 'differs'}, re-save ${same ? 'identical' : 'differs'}, v${String(v)}`,
    );
    await c2.close();
  }
  check(
    'grid projects: save, open restores layout, columns and arrangement; save again is byte-identical (version 1 for 4 columns, 2 for a 21:1 column)',
    ok,
    results.join('; '),
  );

  if (!options.releaseOrigin) return;
  // --- Release 2026.11.0, both directions -----------------------------------
  const rel = await newPage(browser, options.releaseOrigin);
  await addSized(rel.p, TWELVE.slice(0, 9));
  const relState = await stateJson(rel.p);
  const relZip = await saveProject(rel.p, 'grid-release');
  {
    const here = await newPage(browser, origin);
    const e = await openProject(here.p, relZip);
    const s = await state(here.p);
    const layoutRadio = await here.p.evaluate(
      () =>
        document.querySelector<HTMLInputElement>(
          'input[name=layout-kind]:checked',
        )?.value,
    );
    check(
      'compat: a project saved by 2026.11.0 opens here as Mosaic, unchanged',
      e === '' &&
        JSON.stringify(s) === relState &&
        !('layout' in s) &&
        !('kind' in s.plan) &&
        layoutRadio === 'mosaic',
      e,
    );
    await here.ctx.close();
  }
  {
    // A version 1 grid opens in the release: the saved cells, as a mosaic
    // state (it ignores layout, columns and the plan's kind).
    const e = await openProject(rel.p, gentle);
    const inRelease = await state(rel.p);
    const saved = JSON.parse(gridState);
    const expected = { ...saved, plan: { ...saved.plan } };
    delete expected.layout;
    delete expected.columns;
    delete expected.plan.kind;
    // How unequal the release draws a row's cells with the border (its cut
    // rule takes the gap before sharing, see LayoutPlan.kind).
    const relSpread = await rel.p.evaluate(() => {
      const last = (window as any).__app.view.lastRender();
      const tiles = [...last.tiles].sort((a: any, b: any) => a.slot - b.slot);
      let spread = 0;
      for (let r = 0; r < 3; r++) {
        const ws = tiles.slice(r * 4, r * 4 + 4).map((t: any) => t.width);
        spread = Math.max(spread, Math.max(...ws) - Math.min(...ws));
      }
      return { spread, width: last.tiles[0].width as number };
    });
    check(
      'compat: 2026.11.0 opens a version 1 grid project with the saved plan and arrangement (as a mosaic state)',
      e === '' && JSON.stringify(inRelease) === JSON.stringify(expected),
      `${e}; in the release a row's cells differ by up to ${String(relSpread.spread)} px at a ${String(relSpread.width)} px cell (1.2% border)`,
    );
    // Its next re-roll makes a mosaic.
    await rel.p.getByRole('button', { name: 'Shuffle' }).click();
    await drawn(rel.p);
    const reRolled = await state(rel.p);
    const isGrid = await (async () => {
      const here = await newPage(browser, origin);
      const r = await here.p.evaluate(
        async ({ layout, plan }) => {
          const { validatePlan } = await import(/* @vite-ignore */ layout);
          try {
            validatePlan({ ...plan, kind: 'grid' });
            return true;
          } catch {
            return false;
          }
        },
        { layout: LAYOUT_MODULE, plan: reRolled.plan },
      );
      await here.ctx.close();
      return r;
    })();
    check(
      'compat: in 2026.11.0, Shuffle on that project makes a mosaic',
      !isGrid && reRolled.plan.count === 12,
    );
    const before = await stateJson(rel.p);
    const e2 = await openProject(rel.p, strip);
    const after = await stateJson(rel.p);
    check(
      'compat: 2026.11.0 refuses a version 2 grid (cells beyond its limit) as "saved by a newer version", leaving its project as it was',
      e2.includes('newer version') && after === before,
      e2.replace(/\s+/g, ' ').slice(0, 160),
    );
    if (e2) {
      await rel.p.getByRole('button', { name: 'OK' }).click();
    }
  }
  await rel.ctx.close();
}
