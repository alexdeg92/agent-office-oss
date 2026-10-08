'use strict';
/*
 * The server-side screenshot capturer (S7d; projects' capture interface, docs/architecture/projects.md "Image priority"):
 *   capture({ url, width, height, timeoutMs, maxBytes }) → { url, bytes } | { timedOut: true } | null
 * Headless Chrome renders the page at width×height. ALL of its traffic goes through the egress proxy (egress-proxy.js),
 * which refuses every special-purpose address and pins each connection to the address it checked; WebRTC's direct UDP
 * and QUIC are disabled so nothing bypasses the proxy. One capture at a time; Chrome is killed (its whole process
 * group) at the timeout. The PNG is stored under <dataDir>/shots/<sha256(url)>.png (0600) and served by the API; the
 * returned URL is absolute and public (instance.publicUrl). Without Chrome or a public URL there is no capturer
 * (projects falls back to the OpenGraph card).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createEgressProxy } = require('./egress-proxy');

const SHOT_ID = /^[0-9a-f]{64}$/;

function findChrome(env = process.env) {
  if (env.AO_CHROME_BIN) return env.AO_CHROME_BIN;
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
      const f = path.join(dir, name);
      try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) { /* next */ }
    }
  }
  return null;
}

/**
 * @param {object} o
 * @param {string|null} o.chromeBin
 * @param {string} o.dataDir
 * @param {{ forApi(pathname): string|null }} o.publicUrls
 * @param {Function} [o.lookup]     injectable resolver for the proxy (tests)
 * → the capture function, or null when it can't produce public URLs or has no browser
 */
function createCapturer({ chromeBin, dataDir, publicUrls, lookup, log = () => {} }) {
  if (!chromeBin || !publicUrls || !publicUrls.forApi('/api/v2/shots/x.png') || !/^https:/.test(publicUrls.forApi('/api/v2/shots/x.png'))) return null;
  const dir = path.join(dataDir, 'shots');
  let queue = Promise.resolve();

  async function once({ url, width, height, timeoutMs, maxBytes }) {
    const proxy = createEgressProxy({ lookup });
    const port = await proxy.listen();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-shot-'));
    const out = path.join(tmp, 'shot.png');
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps',
      '--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy',
      '--proxy-server=http://127.0.0.1:' + port, '--proxy-bypass-list=<-loopback>',
      '--user-data-dir=' + path.join(tmp, 'profile'), '--window-size=' + width + ',' + height, '--virtual-time-budget=4000',
      '--screenshot=' + out, url];
    let timedOut = false;
    try {
      await new Promise((resolve) => {
        const child = spawn(chromeBin, args, { stdio: 'ignore', detached: true, env: Object.assign({}, process.env, { HOME: tmp }) });
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        child.on('error', () => { clearTimeout(timer); resolve(); });
        child.on('exit', () => { clearTimeout(timer); kill(); resolve(); });
      });
      if (timedOut) return { timedOut: true };
      if (proxy.stats.overBudget) return null;
      let st; try { st = fs.statSync(out); } catch (_) { return null; }
      if (!st.isFile() || st.size === 0) return null;
      if (st.size > maxBytes) return { url: null, bytes: st.size };
      const head = Buffer.alloc(8); const fd = fs.openSync(out, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
      if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;   // a PNG, nothing else
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = crypto.createHash('sha256').update(url).digest('hex');
      const dest = path.join(dir, id + '.png');
      fs.copyFileSync(out, dest); fs.chmodSync(dest, 0o600);
      return { url: publicUrls.forApi('/api/v2/shots/' + id + '.png'), bytes: st.size };
    } catch (e) {
      log('capture: failed (' + (e && e.code || 'error') + ')');
      return null;
    } finally {
      await proxy.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // one at a time (Chrome is heavy); a failure never blocks the queue
  return function capture(req) {
    const p = queue.then(() => once(req));
    queue = p.catch(() => null);
    return p;
  };
}

// GET /api/v2/shots/:file → the stored PNG (authenticated like the views; never a path outside shots/)
function shotPath(dataDir, file) {
  const m = /^([0-9a-f]{64})\.png$/.exec(String(file || ''));
  if (!m || !SHOT_ID.test(m[1])) return null;
  const f = path.join(dataDir, 'shots', m[1] + '.png');
  try { return fs.statSync(f).isFile() ? f : null; } catch (_) { return null; }
}

module.exports = { createCapturer, findChrome, shotPath };
