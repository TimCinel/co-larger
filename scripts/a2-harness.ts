/**
 * Page side of scripts/a2-browser.ts: the A2 export (issue #11) in a browser
 * Playwright cannot drive (stock Firefox, Safari). Generates about 100 photos
 * of camera size, exports PNG and JPEG with the app's own exportCollage at
 * 4961 x 7016, checks the files and reports to the local server.
 */
import { createEditorState } from '../src/editor/index.ts';
import {
  browserDeps,
  exportCollage,
  type ExportFormat,
  type ExportPhoto,
} from '../src/export/index.ts';

const params = new URLSearchParams(location.search);
const report = params.get('report') ?? '';
const count = Number(params.get('count') ?? '100');
const log = document.querySelector('#log')!;

function send(message: Record<string, unknown>): Promise<unknown> {
  log.textContent += `\n${JSON.stringify(message)}`;
  return fetch(report, {
    method: 'POST',
    body: JSON.stringify(message),
  }).catch(() => undefined);
}

const SIZES: [number, number][] = [
  [4000, 3000],
  [3000, 4000],
  [3500, 3500],
  [4800, 2000],
  [2000, 4800],
  [4000, 2667],
  [2667, 4000],
];

async function makeFiles(): Promise<Map<string, ExportPhoto>> {
  const photos = new Map<string, ExportPhoto>();
  const cache = new Map<number, Blob>();
  for (let i = 0; i < count; i++) {
    const shape = i % SIZES.length;
    const key = i % (SIZES.length * 3);
    const [w, h] = SIZES[shape] as [number, number];
    let blob = cache.get(key);
    if (!blob) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${String((key * 41) % 360)} 60% 55%)`);
      g.addColorStop(1, `hsl(${String((key * 41 + 90) % 360)} 60% 25%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 300px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(key), w / 2, h / 2 + 100);
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      cache.set(key, blob);
    }
    photos.set(`p${String(i)}`, {
      name: `cam-${String(i)}.jpg`,
      file: blob,
      width: w,
      height: h,
    });
  }
  return photos;
}

async function inspect(blob: Blob): Promise<Record<string, unknown>> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const colours = new Set<number>();
  let opaque = 0;
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const d = ctx.getImageData(
        Math.floor(((gx + 0.5) / 8) * bitmap.width),
        Math.floor(((gy + 0.5) / 8) * bitmap.height),
        1,
        1,
      ).data;
      if (d[3] === 255) opaque++;
      colours.add(d[0]! * 65536 + d[1]! * 256 + d[2]!);
    }
  }
  const result = {
    width: bitmap.width,
    height: bitmap.height,
    opaque,
    distinct: colours.size,
  };
  bitmap.close();
  return result;
}

try {
  await send({ kind: 'start', agent: navigator.userAgent });
  const t0 = performance.now();
  const photos = await makeFiles();
  await send({ kind: 'generated', seconds: (performance.now() - t0) / 1000 });
  const shapes = [...photos].map(([id, p]) => ({
    id,
    aspect: p.width / p.height,
  }));
  const state = createEditorState({
    seed: 11,
    photos: shapes,
    variation: 0.6,
    canvas: { width: 4961, height: 7016, borderFraction: 0.01 },
  });
  for (const format of ['png', 'jpeg'] as ExportFormat[]) {
    await send({ kind: 'exporting', format });
    const started = performance.now();
    let phase = '';
    try {
      const result = await exportCollage({
        state,
        photos,
        format,
        quality: 0.92,
        deps: browserDeps,
        onProgress: (p) => {
          phase = p.phase;
        },
      });
      const seconds = (performance.now() - started) / 1000;
      await send({
        kind: 'result',
        format,
        ok: true,
        seconds,
        bytes: result.blob.size,
        mime: result.blob.type,
        ...(await inspect(result.blob)),
      });
    } catch (error) {
      await send({
        kind: 'result',
        format,
        ok: false,
        phase,
        error: String(error),
        seconds: (performance.now() - started) / 1000,
      });
    }
  }
} catch (error) {
  await send({ kind: 'crash', error: String(error) });
}
await send({ kind: 'done' });
