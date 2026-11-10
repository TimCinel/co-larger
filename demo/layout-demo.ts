// Development-only page for eyeballing the layout engine. Not part of the app
// build: Vite only bundles index.html. Open /demo/layout.html under `npm run dev`.
import {
  assignPhotos,
  cropFraction,
  maxBorderForAspect,
  placeLayout,
  planLayout,
  weightedCrop,
  type PhotoShape,
  type Tile,
} from '../src/layout';
import { createRandom, shuffledIndices } from '../src/layout/random';

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

function select(id: string): string {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`missing #${id}`);
  return el.value;
}

/** How a panel is drawn: slot shapes, or photo fit by a placement method. */
type View = 'shapes' | 'auto' | 'random';

/** Photo aspects for the "Photo mix" control, repeated to the tile count. */
const MIXES: Record<string, readonly number[]> = {
  // 60% landscape (4:3 and 3:2), 30% portrait 3:4, 10% square.
  realistic: [4 / 3, 3 / 2, 3 / 4, 4 / 3, 3 / 2, 3 / 4, 4 / 3, 3 / 2, 3 / 4, 1],
  panoramas: [4 / 3, 3 / 2, 3 / 4, 4 / 3, 3 / 2, 3 / 4, 3, 1 / 3, 6, 1],
  landscape: [3 / 2],
  portrait: [3 / 4],
};

function photosFor(count: number): PhotoShape[] {
  const mix = MIXES[select('mix')] ?? [1];
  return Array.from({ length: count }, (_, i) => ({
    id: `photo-${String(i)}`,
    aspect: mix[i % mix.length] as number,
  }));
}

/** Green for a perfect fit through to red at half the photo cropped away. */
function cropColour(crop: number, lightness: number): string {
  const hue = 120 * (1 - Math.min(1, crop / 0.5));
  return `hsl(${hue.toFixed(0)} 65% ${String(lightness)}%)`;
}

/**
 * Draws a tile coloured by how much of its photo is cropped, with the whole
 * photo drawn inside it at "contain" size: the darker margin around the
 * light rectangle is exactly the share of the photo that cover cropping cuts
 * away.
 */
function drawFit(
  ctx: CanvasRenderingContext2D,
  tile: Tile,
  photoAspect: number,
): void {
  const crop = cropFraction(photoAspect, tile.width / tile.height);
  ctx.fillStyle = cropColour(crop, 38);
  ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
  const scale = Math.min(tile.width / photoAspect, tile.height);
  const w = photoAspect * scale;
  const h = scale;
  ctx.fillStyle = cropColour(crop, 78);
  ctx.fillRect(
    tile.x + (tile.width - w) / 2,
    tile.y + (tile.height - h) / 2,
    w,
    h,
  );
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

function panel(
  ratio: readonly [number, number],
  dial: number,
  view: View,
): HTMLElement {
  const [rw, rh] = ratio;
  const scale = PANEL / Math.max(rw, rh);
  const width = rw * scale;
  const height = rh * scale;
  const count = Math.max(1, Math.round(input('count').valueAsNumber || 1));
  const seed = input('seed').valueAsNumber || 0;
  const requested =
    ((input('border').valueAsNumber || 0) / 100) * Math.min(width, height);

  const started = performance.now();
  const plan = planLayout({ width, height, count, variation: dial, seed });
  // Clamp the border the way the editor should: no tile beyond 3:1 and none
  // under a pixel.
  const limit = maxBorderForAspect(plan, width, height, 3);
  const border = Math.min(requested, limit);
  const tiles = placeLayout(plan, { width, height, border });
  const elapsed = performance.now() - started;

  // Assign photos against the borderless slots, as the editor should, so the
  // border never changes which photo goes where.
  const slots = placeLayout(plan, { width, height });
  const photos = photosFor(count);
  const assignStarted = performance.now();
  const auto = assignPhotos(slots, photos, { seed });
  const assignElapsed = performance.now() - assignStarted;
  const random = shuffledIndices(count, createRandom(seed)).map(
    (p) => (photos[p] as PhotoShape).id,
  );
  const assignment = view === 'random' ? random : auto;
  const aspectOf = new Map(photos.map((p) => [p.id, p.aspect]));

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
    if (view === 'shapes') {
      ctx.fillStyle = colour(tile);
      ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
    } else {
      const id = assignment[tile.slot] as string;
      drawFit(ctx, tile, aspectOf.get(id) as number);
    }
  }

  const areas = tiles.map((t) => t.width * t.height);
  const aspects = tiles.map((t) =>
    Math.max(t.width / t.height, t.height / t.width),
  );
  const figure = document.createElement('figure');
  figure.style.width = `${String(PANEL)}px`;
  const caption = document.createElement('figcaption');
  const fit =
    view === 'shapes'
      ? ''
      : `crop ${pct(weightedCrop(slots, photos, assignment))}` +
        (view === 'auto'
          ? ` (random ${pct(weightedCrop(slots, photos, random))}) · ` +
            `assigned in ${assignElapsed.toFixed(1)} ms`
          : ` (auto ${pct(weightedCrop(slots, photos, auto))})`) +
        '\n';
  caption.textContent =
    fit +
    `max/min area ${(Math.max(...areas) / Math.min(...areas)).toFixed(1)}× · ` +
    `max aspect ${Math.max(...aspects).toFixed(2)} · ${elapsed.toFixed(1)} ms` +
    (border < requested ? ` · border clamped to ${border.toFixed(2)} px` : '');
  figure.append(canvas, caption);
  return figure;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
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
  const mode = select('view');
  const views: readonly View[] =
    mode === 'compare' ? ['auto', 'random'] : [mode as View];
  for (const ratio of RATIOS) {
    for (const view of views) {
      const label = document.createElement('div');
      label.className = 'head';
      label.textContent = `${String(ratio[0])}:${String(ratio[1])}`;
      if (view !== 'shapes') {
        label.append(document.createElement('br'), view);
      }
      cells.push(label);
      for (const dial of dials) cells.push(panel(ratio, dial, view));
    }
  }
  grid.replaceChildren(...cells);
}

// Controls can be preset from the URL, e.g. layout.html?count=120&seed=2.
for (const [key, value] of new URLSearchParams(location.search)) {
  const el = document.getElementById(key);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    el.value = value;
  }
}
document.getElementById('controls')?.addEventListener('input', render);
render();
