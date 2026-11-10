/**
 * The A2 export (issue #11) in a browser Playwright cannot drive: stock
 * Firefox, or Safari (opened in the real app, as a page that reports back).
 *
 *   node scripts/a2-browser.ts firefox
 *   node scripts/a2-browser.ts safari
 *
 * Prints timings and the peak resident memory of the browser's processes.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? 'firefox';

function processes(): {
  pid: number;
  ppid: number;
  rss: number;
  command: string;
}[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]),
      command: m[4] ?? '',
    }));
}

/** Resident MB of the browser: Firefox's process tree, or Safari's WebKit processes. */
function rssMb(rootPid: number | null): number {
  const all = processes();
  if (target === 'safari') {
    return (
      all
        .filter((p) =>
          /com\.apple\.WebKit\.(WebContent|GPU)|Safari\.app/.test(p.command),
        )
        .reduce((s, p) => s + p.rss, 0) / 1024
    );
  }
  const tree = new Set<number>([rootPid ?? -1]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all) {
      if (tree.has(p.ppid) && !tree.has(p.pid)) {
        tree.add(p.pid);
        changed = true;
      }
    }
  }
  return (
    all.filter((p) => tree.has(p.pid)).reduce((s, p) => s + p.rss, 0) / 1024
  );
}

const vite = await createServer({
  root,
  server: { port: 5198 },
  logLevel: 'error',
});
await vite.listen();

const messages: Record<string, unknown>[] = [];
let finish: () => void = () => undefined;
const finished = new Promise<void>((resolveDone) => {
  finish = resolveDone;
});
const http = createHttp((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    res.end('ok');
    try {
      const message = JSON.parse(body) as Record<string, unknown>;
      messages.push(message);
      console.log(' ', JSON.stringify(message));
      if (message.kind === 'done') finish();
    } catch {
      // Ignore anything that is not JSON.
    }
  });
});
await new Promise<void>((r) => http.listen(5197, r));

const url = `http://localhost:5198/scripts/a2-harness.html?report=${encodeURIComponent('http://localhost:5197/')}&count=100`;
let child: ReturnType<typeof spawn> | null = null;
const profile = mkdtempSync(join(tmpdir(), 'co-larger-a2-'));
if (target === 'safari') {
  execFileSync('open', ['-a', 'Safari', url]);
} else {
  child = spawn(
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    ['-no-remote', '-profile', profile, '-headless', url],
    { stdio: 'ignore' },
  );
}
console.log(`${target}: ${url}`);
const baseline = rssMb(child?.pid ?? null);
let peak = baseline;
const timer = setInterval(() => {
  peak = Math.max(peak, rssMb(child?.pid ?? null));
}, 200);
const timeout = setTimeout(
  () => {
    console.log('timed out');
    finish();
  },
  15 * 60 * 1000,
);
await finished;
clearInterval(timer);
clearTimeout(timeout);
console.log(
  `peak browser memory ${peak.toFixed(0)} MB (before: ${baseline.toFixed(0)} MB)`,
);
child?.kill();
if (target === 'safari') {
  try {
    execFileSync('osascript', [
      '-e',
      'tell application "Safari" to close (every tab of every window whose URL contains "a2-harness")',
    ]);
  } catch {
    console.log('(close the Safari tab by hand)');
  }
}
http.close();
await vite.close();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
