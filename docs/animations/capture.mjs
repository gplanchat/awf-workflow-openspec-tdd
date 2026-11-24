// Renders <name>.html frame by frame through Chromium (DevTools protocol), then encodes <name>.gif with ffmpeg.
// Usage: node docs/animations/capture.mjs <cycle|comparison> [--chromium <binary>] [--frames <dir>]
// Needs Node 22 or later (global WebSocket), Chromium and ffmpeg. Binds only to 127.0.0.1.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

class CaptureFailed extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
// Stage size of each page, frame rate, and width of the GIF (scaled down when smaller than the stage).
const PAGES = { cycle: { W: 960, H: 720, FPS: 15, GIF_W: 960 }, comparison: { W: 1080, H: 1080, FPS: 25, GIF_W: 800 } };
const name = process.argv[2];
if (!PAGES[name]) throw new CaptureFailed(`Give the animation to render: ${Object.keys(PAGES).join(' or ')}.`);
const { W, H, FPS, GIF_W } = PAGES[name];
const CHROMIUM = arg('chromium', 'chromium');
const frames = arg('frames', mkdtempSync(join(tmpdir(), `${name}-frames-`)));

const types = { '.html': 'text/html', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const file = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '');
  if (!file || file.includes('..') || file.includes('/')) { res.writeHead(404).end(); return; }
  let body;
  try { body = readFileSync(join(here, file)); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const page = `http://127.0.0.1:${server.address().port}/${name}.html?export`;

const profile = mkdtempSync(join(tmpdir(), `${name}-chromium-`));
const browser = spawn(CHROMIUM, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},${H}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((ok, ko) => {
  let err = '';
  browser.stderr.on('data', d => { err += d; const m = /DevTools listening on (ws:\S+)/.exec(err); if (m) ok(m[1]); });
  browser.on('exit', code => ko(new CaptureFailed(`Chromium exited with code ${code} before opening DevTools: ${err.slice(-400)}`)));
});

const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(ok => ws.addEventListener('open', ok, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (!pending.has(msg.id)) return;
  const { ok, ko } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) ko(new CaptureFailed(`DevTools: ${msg.error.message}`)); else ok(msg.result);
});
const send = (method, params = {}) => new Promise((ok, ko) => { pending.set(++id, { ok, ko }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new CaptureFailed(`Page error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
};

try {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url: page });
  await evaluate('new Promise(ok => document.readyState === "complete" ? ok() : addEventListener("load", ok))');
  await evaluate('document.fonts.ready.then(() => document.fonts.size)');
  const short = await evaluate('window.__captionCheck()');
  if (short.length) throw new CaptureFailed(`Texts shorter than their reading time: ${JSON.stringify(short)}`);
  const duration = await evaluate('window.DURATION');
  const count = Math.round(duration * FPS);
  mkdirSync(frames, { recursive: true });
  for (let i = 0; i < count; i++) {
    await evaluate(`window.render(${i / FPS})`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    writeFileSync(join(frames, `f${String(i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
  }
  console.log(`${count} frames, ${duration.toFixed(1)} s, in ${frames}`);
} finally {
  ws.close();
  // A snap-confined Chromium cannot receive a signal from outside its sandbox (kill fails with EACCES): close it
  // through its own DevTools endpoint instead.
  const closer = new WebSocket(wsUrl);
  await new Promise(ok => closer.addEventListener('open', ok, { once: true }));
  closer.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise(ok => browser.once('exit', ok));
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const gif = join(here, `${name}.gif`);
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.png'),
  '-vf', `scale=${GIF_W}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  '-loop', '0', gif], { stdio: 'inherit' });
if (ff.status !== 0) throw new CaptureFailed(`ffmpeg failed with code ${ff.status}`);
console.log(`Wrote ${gif}`);
