// Development-only page for eyeballing the layout engine. Not part of the app
// build: Vite only bundles index.html. Open /demo/layout.html under `npm run dev`.
import { layoutMosaic, type Tile } from '../src/layout';

const RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [3, 4],
  [16, 9],
  [1, 2],
];
const FIXED_DIALS = [0, 0.25, 0.5, 0.75, 1];
const PANEL = 170;

function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
  return el;
}

const grid = document.getElementById('grid');
const dialValue = document.getElementById('dial-value');
if (!grid || !dialValue) throw new Error('missing demo elements');

function colour(tile: Tile): string {
  const aspect = tile.width / tile.height;
  const shade = 52 + ((tile.slot * 37) % 23);
  if (aspect < 1 / 1.15) return `hsl(18 70% ${String(shade)}%)`;
  if (aspect > 1.15) return `hsl(205 60% ${String(shade)}%)`;
  return `hsl(95 25% ${String(shade)}%)`;
}

function panel(ratio: readonly [number, number], dial: number): HTMLElement {
  const [rw, rh] = ratio;
  const scale = PANEL / Math.max(rw, rh);
  const width = rw * scale;
  const height = rh * scale;
  const count = Math.max(1, Math.round(input('count').valueAsNumber || 1));
  const seed = input('seed').valueAsNumber || 0;
  const border =
    ((input('border').valueAsNumber || 0) / 100) * Math.min(width, height);

  const started = performance.now();
  const tiles = layoutMosaic({
    width,
    height,
    count,
    variation: dial,
    seed,
    border,
  });
  const elapsed = performance.now() - started;

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${String(width)}px`;
  canvas.style.height = `${String(height)}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  for (const tile of tiles) {
    ctx.fillStyle = colour(tile);
    ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
  }

  const areas = tiles.map((t) => t.width * t.height);
  const aspects = tiles.map((t) =>
    Math.max(t.width / t.height, t.height / t.width),
  );
  const figure = document.createElement('figure');
  figure.style.width = `${String(PANEL)}px`;
  const caption = document.createElement('figcaption');
  caption.textContent =
    `max/min area ${(Math.max(...areas) / Math.min(...areas)).toFixed(1)}× · ` +
    `max aspect ${Math.max(...aspects).toFixed(2)} · ${elapsed.toFixed(1)} ms`;
  figure.append(canvas, caption);
  return figure;
}

function render(): void {
  if (!grid || !dialValue) return;
  const live = input('dial').valueAsNumber;
  dialValue.textContent = live.toFixed(2);
  const dials = [...FIXED_DIALS, live];
  grid.style.setProperty('--cols', String(dials.length));
  const cells: HTMLElement[] = [document.createElement('div')];
  for (const [i, dial] of dials.entries()) {
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent =
      i === FIXED_DIALS.length
        ? `Live dial (${dial.toFixed(2)})`
        : `Dial ${String(dial)}`;
    cells.push(head);
  }
  for (const ratio of RATIOS) {
    const label = document.createElement('div');
    label.className = 'head';
    label.textContent = `${String(ratio[0])}:${String(ratio[1])}`;
    cells.push(label);
    for (const dial of dials) cells.push(panel(ratio, dial));
  }
  grid.replaceChildren(...cells);
}

// Controls can be preset from the URL, e.g. layout.html?count=120&seed=2.
for (const [key, value] of new URLSearchParams(location.search)) {
  const el = document.getElementById(key);
  if (el instanceof HTMLInputElement) el.value = value;
}
document.getElementById('controls')?.addEventListener('input', render);
render();
