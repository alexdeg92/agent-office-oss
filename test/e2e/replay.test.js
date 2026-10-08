'use strict';
// G10: real OpenClaw-shaped traffic (the local captures), replayed into the real server in engine-only mode, compressed
// by AO_TIME_SCALE (src/ops/timescale.js, test instance only): every periodic loop runs its full simulated count
// (refreshes, config, skills, session groups, host metrics, live pulls, the health sampler, the quarantine flush).
// The gateway alternates between the two captured snapshots (sessions start and stop), replays every captured live
// event in a cycle, and v2 + v3 clients read the views and keep subscribed streams open.
//
// Two phases:
//   1. warm-up, until a structured signal: both streams' resume buffers are full (stream.js BUFFER frames each; the
//      largest bounded structure that fills with traffic, measured at ~14 simulated minutes);
//   2. MINUTES simulated minutes (default 10) measured: no new quarantine fingerprint, no new quarantine row in the
//      store, the live heap after a full GC (inspector protocol on the test child) stays flat, RSS stays bounded.
// Captures are local-only (test/fixtures/local, never committed): skipped without them.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadScenario, readFixture, gatewayHandlers, hasScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { BUFFER } = require('../../src/api/v2/stream');

const A = 'capture-20261005-active', B = 'capture-20261005';
const skip = hasScenario(A) && hasScenario(B) ? false : `local captures ${A} and ${B} absent (test/fixtures/local/ is never committed)`;
const MINUTES = Number(process.env.REPLAY_MINUTES) || 10;
const SCALE = 30;                                   // 10 simulated minutes = 20 s
const MEASURE_MS = (MINUTES * 60000) / SCALE;
const WARMUP_MAX_MS = 240000;                       // the buffers fill in ~45 s real (the frame rate is real-time-bound)
const EVENT_EVERY_MS = 5000 / SCALE;                // one captured live event every 5 simulated seconds
const HEAP_GROWTH_MAX_MB = 3;                       // live heap after GC, across the measured phase (seen: < 0.5)
const RSS_GROWTH_MAX_MB = 32;                       // allocator noise included (seen: < 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid) => { const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : NaN; };
const median = (xs) => { const s = xs.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// both captures' handlers; each top-level read alternates between them call by call (the real gateway's churn)
function alternatingHandlers(a, b) {
  const ha = gatewayHandlers(a), hb = gatewayHandlers(b), out = Object.assign({}, hb, ha);
  for (const m of Object.keys(ha)) {
    if (!hb[m] || typeof a.rpc[m] !== 'string') continue;
    let n = 0; out[m] = (p) => ((n++ % 2) ? hb[m](p) : ha[m](p));
  }
  for (const m of ['sessions.get', 'sessions.describe', 'cron.runs']) {   // keyed reads: whichever capture has the key
    if (!ha[m] || !hb[m]) continue;
    out[m] = (p) => { const r = ha[m](p); return r && r.__error ? hb[m](p) : r; };
  }
  return out;
}
const observed = (sc) => ((sc.events && sc.events.observed) || []).map((rel) => {
  const f = readFixture(rel, sc.fixturesDir);
  return { event: f.$fixture.channel.replace(/^gw\.event\./, ''), payload: f.body.value };
});

// the server's live heap after a full GC, through the inspector protocol (NODE_OPTIONS=--inspect on the test child only)
async function inspector(output) {
  const WebSocket = require('ws');
  const url = (/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(output) || [])[0];
  if (!url) throw new Error('no inspector URL in the server output');
  const ws = new WebSocket(url); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    async heapMb() {
      await send('HeapProfiler.collectGarbage');
      const r = await send('Runtime.evaluate', { expression: 'process.memoryUsage().heapUsed', returnByValue: true });
      return r.result.result.value / 1048576;
    },
    close: () => ws.close(),
  };
}

describe('G10 · captured OpenClaw traffic, engine-only, compressed', { skip }, () => {
  let h, a, b, insp, streams = [];
  before(async () => {
    a = loadScenario(A); b = loadScenario(B);
    h = await startServer(a, { handlers: alternatingHandlers(a, b),
      env: { AO_API_ONLY: '1', AO_TIME_SCALE: String(SCALE), NODE_OPTIONS: '--inspect=127.0.0.1:0' } });
    await h.waitReady();
    insp = await inspector(h.output);
  });
  after(async () => { for (const s of streams) s.close(); if (insp) insp.close(); if (h) await h.stop(); });

  it(`${MINUTES} simulated minutes after the warm-up: zero quarantine growth, a flat heap`, { timeout: WARMUP_MAX_MS + MEASURE_MS + 60000 }, async () => {
    assert.equal((await h.get('/api/summary')).status, 404, 'engine-only: v1 is not mounted');
    const logs = (await h.get('/api/v3/views/logs')).json.data;
    const key = (logs.items || []).map((x) => x.key).find(Boolean);
    const topics = ['office', 'logs', 'health', 'access', 'flows', 'skills'].concat(key ? ['session:' + encodeURIComponent(key)] : []).join(',');
    streams = ['v2', 'v3'].map((v) => openSse(h.base, `/api/${v}/stream?topics=${topics}`, { cookie: h.cookie }));
    await Promise.all(streams.map((s) => s.opened));
    for (const s of streams) assert.equal(s.status, 200);

    const events = observed(a).concat(observed(b));
    assert.ok(events.length >= 7, 'the captured live events');
    const errors = [];
    const quarantine = async () => {
      const issues = (await h.get('/api/v2/views/health')).json.data.dataQuality.issues;
      const stored = h.withStore((db) => db.prepare('SELECT count(*) AS n FROM quarantine').get().n);
      // the health VM is value-free and has no fingerprint: code + severity + channel + path identify an issue there
      const fp = (i) => [i.code, i.severity, i.channel, i.path].join('|');
      return { fingerprints: new Set(issues.map(fp)), fp, issues, stored };
    };
    let sent = 0, nextEvent = Date.now(), nextRead = Date.now();
    const drive = async () => {   // the gateway's events and a UI's reads, both versions
      const now = Date.now();
      if (now >= nextEvent) { const e = events[sent++ % events.length]; h.gw.emit(e.event, e.payload); nextEvent += EVENT_EVERY_MS; }
      if (now >= nextRead) {
        for (const p of ['/api/v2/views/office', '/api/v3/views/office', '/api/v3/views/logs', '/api/v2/views/access', '/api/v3/views/flows']) {
          const r = await h.get(p); if (r.status !== 200) errors.push(p + ' ' + r.status);
        }
        nextRead += 1000;
      }
      await sleep(10);
    };

    // 1. warm-up: until both resume buffers are full
    const w0 = Date.now();
    while (!streams.every((s) => s.frames.length > BUFFER + 10)) {
      assert.ok(Date.now() - w0 < WARMUP_MAX_MS, `the stream buffers did not fill within ${WARMUP_MAX_MS} ms (${streams.map((s) => s.frames.length)})`);
      await drive();
    }
    const warmupSimMin = ((Date.now() - w0) * SCALE) / 60000;
    await sleep(5000 / SCALE + 100);   // one quarantine flush (FLUSH_MS, compressed)
    const start = await quarantine();

    // 2. measured phase
    const heaps = [], rss = [];
    const t0 = Date.now(); let nextSample = t0;
    while (Date.now() - t0 < MEASURE_MS) {
      await drive();
      if (Date.now() >= nextSample) { heaps.push(await insp.heapMb()); rss.push(rssMb(h.child.pid)); nextSample += 1000; }
    }
    await sleep(5000 / SCALE + 100);
    const end = await quarantine();
    heaps.push(await insp.heapMb()); rss.push(rssMb(h.child.pid));

    assert.deepEqual(errors, [], 'every read succeeded');
    assert.equal(h.child.exitCode, null, 'the server is alive');
    for (const s of streams) assert.equal(s.ended, false, 'the streams stayed open');
    for (const s of streams) assert.ok(s.frames.filter((f) => f.event === 'delta' || f.event === 'snapshot').length > BUFFER, 'the streams carried updates');

    const added = [...end.fingerprints].filter((f) => !start.fingerprints.has(f));
    assert.deepEqual(added, [], 'no new quarantine fingerprint: ' + JSON.stringify(end.issues.filter((x) => added.includes(end.fp(x))).map((x) => [x.code, x.channel, x.path])));
    assert.equal(end.stored, start.stored, 'no new quarantine row in the store');

    const k = Math.max(1, Math.floor(heaps.length / 4));
    const heapStart = median(heaps.slice(0, k)), heapEnd = median(heaps.slice(-k));
    const rssStart = median(rss.slice(0, k)), rssPeak = Math.max(...rss);
    console.log(`# G10 replay: warm-up ${warmupSimMin.toFixed(1)} simulated min, then ${MINUTES} at x${SCALE}: ${sent} events, `
      + `quarantine ${end.fingerprints.size} fingerprints (${end.issues.map((x) => x.code + '/' + x.severity + ' ' + x.channel + ' ' + x.path).join('; ') || 'none'}), `
      + `heap ${heapStart.toFixed(1)} → ${heapEnd.toFixed(1)} MB, RSS ${rssStart.toFixed(0)} → peak ${rssPeak.toFixed(0)} MB`);
    if (process.env.REPLAY_TRACE) console.log('# heap ' + heaps.map((x) => x.toFixed(1)).join(' ') + '\n# rss ' + rss.map((x) => x.toFixed(0)).join(' '));
    assert.ok(heapEnd - heapStart <= HEAP_GROWTH_MAX_MB, `the live heap grew ${(heapEnd - heapStart).toFixed(1)} MB (max ${HEAP_GROWTH_MAX_MB})`);
    assert.ok(rssPeak - rssStart <= RSS_GROWTH_MAX_MB, `RSS grew ${(rssPeak - rssStart).toFixed(1)} MB (max ${RSS_GROWTH_MAX_MB})`);
  });
});
