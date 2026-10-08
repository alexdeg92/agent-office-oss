'use strict';
// Minimal SSE client for tests (no dependency): parses frames ({ id, event, data }) as they arrive.
const http = require('http');

function openSse(base, path, { cookie, lastEventId } = {}) {
  const frames = [];
  const waiters = [];
  let ended = false, status = null, resolveOpen, rejectOpen;
  const opened = new Promise((r, j) => { resolveOpen = r; rejectOpen = j; });
  const headers = { accept: 'text/event-stream' };
  if (cookie) headers.cookie = cookie;
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const req = http.get(base + path, { headers }, (res) => {
    status = res.statusCode;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const f = {};
        for (const line of block.split('\n')) {
          const c = line.indexOf(':'); if (c <= 0) continue;
          const k = line.slice(0, c), v = line.slice(c + 1).replace(/^ /, '');
          if (k === 'data') f.data = JSON.parse(v); else if (k === 'id' || k === 'event') f[k] = v;
        }
        if (f.event) { frames.push(f); check(); }
      }
    });
    res.on('end', () => { ended = true; check(); });
    resolveOpen(res);
  });
  req.on('error', (e) => { ended = true; rejectOpen(e); check(); });
  function check() { for (const w of waiters.slice()) { const hit = frames.find(w.pred); if (hit || (ended && w.allowEnd)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(hit || null); } } }
  return {
    frames, opened,
    get status() { return status; }, get ended() { return ended; },
    // resolves with the first frame matching pred (already received or future); rejects after ms
    next(pred, ms = 5000) {
      const hit = frames.find(pred); if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, allowEnd: false };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no matching frame within ' + ms + ' ms; got ' + frames.map((f) => f.event).join(','))); } }, ms);
      });
    },
    ended$: (ms = 5000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => (ended ? resolve(true) : Date.now() - t0 > ms ? reject(new Error('stream did not end')) : setTimeout(tick, 20)); tick(); }),
    close() { req.destroy(); },
  };
}

module.exports = { openSse };
