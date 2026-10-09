'use strict';
// Minimal headless-Chrome harness for office DOM tests (review R4-18): a static server for the
// checkout plus a CDP client on Node's built-in WebSocket. No dependencies. Tests skip when no
// Chrome binary is found (set CHROME_BIN to override, OFFICE_DOM_TESTS=0 to disable).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function findChrome() {
  if (process.env.OFFICE_DOM_TESTS === '0') return null;
  for (const p of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.normalize(path.join(ROOT, url));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  const bin = findChrome();
  if (!bin) return null;
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-dom-'));
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
  const browser = new WebSocket(wsUrl);
  await new Promise((r, j) => { browser.onopen = r; browser.onerror = j; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  browser.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    browser.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) }));
  });

  let initialTarget = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'page')?.targetId ?? null;

  async function page(urlPath) {
    // Reuse the browser's initial blank tab once (a fresh target's first navigation stalls ~20 s in
    // new headless), then open new tabs.
    let targetId = initialTarget;
    initialTarget = null;
    if (!targetId) ({ result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' }));
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    // No network in tests: bureau.css @imports Google Fonts, which would stall the first load offline.
    await send('Network.enable', {}, sessionId);
    await send('Network.setBlockedURLs', { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] }, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: new URL(urlPath, base).href }, sessionId);
    const api = {
      /** Evaluate an async function body in the page; returns its JSON value or throws the page error. */
      async eval(body) {
        const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
        return r.result?.result?.value;
      },
      async waitFor(expr, ms = 30000) {
        const until = Date.now() + ms;
        for (;;) {
          if (await api.eval(`return !!(${expr});`)) return;
          if (Date.now() > until) throw new Error(`timeout waiting for ${expr}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      /** Real key events through the browser input pipeline (focus, Tab order, Enter activation). */
      async key(key, { code = key, modifiers = 0, text } = {}) {
        const vk = { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }[key] ?? key.toUpperCase().charCodeAt(0);
        const t = text ?? (key === 'Enter' ? '\r' : key.length === 1 ? key : undefined);
        await send('Input.dispatchKeyEvent', { type: t ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(t && { text: t }) }, sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);
      },
      /** Touch input (O4 mobile tests): emulate a touch screen, then dispatch touch points (CSS px). */
      async emulateTouch() { await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId); },
      async viewport(width, height, deviceScaleFactor = 1) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: width <= 480 }, sessionId);
      },
      async screenshot(clip) {
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip && { clip: { ...clip, scale: 1 } }) }, sessionId);
        return Buffer.from(r.result.data, 'base64');
      },
      async touch(type, points) { await send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) }, sessionId); },
      async close() { await send('Target.closeTarget', { targetId }); },
      logs,
    };
    return api;
  }

  return {
    page,
    async close() {
      try { browser.close(); } catch {}
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGKILL');
      await exited;
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { launch, findChrome, ROOT };
