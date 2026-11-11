/**
 * Frame times while dragging the size-variation dial with 300 photos, in
 * real Chrome (not run in CI). It only uses what every version of the app
 * has, so the same file can be run on `master` and on a branch to compare:
 *
 *   node scripts/dial-perf.ts --port 5392 [--runs 5] [--config sharp|all-low]
 *
 * Two collages, both with 300 generated photos (nothing from disk):
 *
 * - "sharp": 1920 x 1080 and 1x photos, so no tile is low resolution;
 * - "all-low": a 7016 x 4961 canvas and tiny photos, so (with the low
 *   resolution warnings of #15) nearly every tile carries a badge, the worst
 *   case for them. On a version without warnings it is just another collage.
 *
 * Prints the gap between animation frames over a drag from 0 to 1 and back
 * (180 mouse moves, one per 16 ms): median, 95th percentile, maximum, the
 * number of gaps over 33 ms, and long tasks over 50 ms. Frame gaps stop at
 * the display's refresh interval (16.7 ms at 60 Hz), so it also reports the
 * main thread's busy time during the drag (Chrome's TaskDuration and
 * ScriptDuration metrics), which shows extra work even when no frame is late.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { action, addPhotos, waitDrawn } from './export-checks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const port = Number(arg('--port', '5392'));
const runs = Number(arg('--runs', '5'));
const only = arg('--config', 'both');
/** `--off`: turn the resolution warnings off first (when the app has them). */
const off = process.argv.includes('--off');

const server = await createServer({
  root,
  server: { port, strictPort: true },
  logLevel: 'error',
});
await server.listen();
const origin = `http://localhost:${String(port)}`;
const browser = await chromium.launch({ channel: 'chrome' });
console.log(
  `Chrome ${browser.version()}, 300 photos, ${String(runs)} runs each`,
);

const q = (a: number[], f: number): number =>
  a[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
const median = (a: number[]): number =>
  q(
    [...a].sort((x, y) => x - y),
    0.5,
  );

for (const [label, scale, canvas] of [
  ['sharp (1920 x 1080, no warnings)', 1, null],
  ['all-low (7016 x 4961, tiny photos)', 0.25, [7016, 4961]],
] as const) {
  if (only !== 'both' && !label.startsWith(only)) continue;
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const p = await context.newPage();
  await p.goto(origin);
  await p.waitForSelector('.tray');
  await addPhotos(p, 300, scale);
  if (canvas) await action(p, 'setCanvasSize', canvas[0], canvas[1]);
  if (off) await p.locator('.res-toggle input').uncheck();
  await waitDrawn(p);
  const badges = await p.evaluate(
    () => document.querySelectorAll('.res-badge:not(.res-badge-tray)').length,
  );
  const medians: number[] = [];
  const p95s: number[] = [];
  const maxes: number[] = [];
  const slow: number[] = [];
  const longs: number[] = [];
  const busy: number[] = [];
  const script: number[] = [];
  const client = await context.newCDPSession(p);
  await client.send('Performance.enable');
  const metric = async (name: string): Promise<number> =>
    (await client.send('Performance.getMetrics')).metrics.find(
      (m) => m.name === name,
    )?.value ?? 0;
  for (let run = 0; run < runs; run++) {
    await p.locator('#size-variation').fill('0');
    await waitDrawn(p);
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const w = window as any;
      w.__frames = [];
      w.__long = [];
      w.__stop = false;
      let last = performance.now();
      const loop = (now: number): void => {
        w.__frames.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push(e.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    const box = (await p.locator('#size-variation').boundingBox())!;
    const y = box.y + box.height / 2;
    const task0 = await metric('TaskDuration');
    const script0 = await metric('ScriptDuration');
    await p.mouse.move(box.x + 1, y);
    await p.mouse.down();
    const moves = 180;
    for (let i = 0; i <= moves; i++) {
      const f = i <= moves / 2 ? (2 * i) / moves : 2 - (2 * i) / moves;
      await p.mouse.move(box.x + 1 + (box.width - 2) * f, y);
      await p.waitForTimeout(16);
    }
    await p.mouse.up();
    busy.push(((await metric('TaskDuration')) - task0) * 1000);
    script.push(((await metric('ScriptDuration')) - script0) * 1000);
    const d = await p.evaluate(() => {
      const w = window as any;
      w.__stop = true;
      return {
        frames: [...w.__frames].slice(2) as number[],
        long: [...w.__long] as number[],
      };
    });
    const frames = [...d.frames].sort((a, b) => a - b);
    medians.push(q(frames, 0.5));
    p95s.push(q(frames, 0.95));
    maxes.push(frames.at(-1) ?? 0);
    slow.push(frames.filter((g) => g > 33).length);
    longs.push(d.long.length);
    await waitDrawn(p);
  }
  const fmt = (a: number[]): string => a.map((v) => v.toFixed(1)).join('/');
  console.log(`\n${label}; ${String(badges)} badges on the canvas`);
  console.log(
    `  frame gap median ${median(medians).toFixed(1)} ms (runs ${fmt(medians)})`,
  );
  console.log(
    `  frame gap p95 ${median(p95s).toFixed(1)} ms (runs ${fmt(p95s)}), max ${median(maxes).toFixed(1)} ms (runs ${fmt(maxes)})`,
  );
  console.log(
    `  main thread busy during the drag: median ${median(busy).toFixed(0)} ms (runs ${busy.map((v) => v.toFixed(0)).join('/')}), of which script ${median(script).toFixed(0)} ms (runs ${script.map((v) => v.toFixed(0)).join('/')})`,
  );
  console.log(
    `  gaps over 33 ms per run ${slow.join('/')}, long tasks per run ${longs.join('/')}`,
  );
  await context.close();
}
await browser.close();
await server.close();
