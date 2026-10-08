'use strict';
// G8 · /healthz and /readyz (docs/architecture/operations.md §1, examples/ops/): unauthenticated, minimal, no instance data.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { TOKENS } = require('../portability/personal-literals');

const EX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'architecture', 'examples', 'ops', n + '.json'), 'utf8'));
const get = (h, p) => fetch(h.base + p).then(async (r) => ({ status: r.status, json: await r.json(), cache: r.headers.get('cache-control'), text: '' }));
const CLOSED = { status: ['ok', 'ready', 'not-ready'], mode: ['app', 'setup'], store: ['ok', 'unavailable', 'none'], runtime: ['connected', 'disconnected', 'not-configured'] };
function closedOnly(j) {
  assert.deepEqual(Object.keys(j).sort(), j.checks ? ['checks', 'status'] : ['status']);
  assert.ok(CLOSED.status.includes(j.status));
  if (j.checks) { assert.deepEqual(Object.keys(j.checks).sort(), ['mode', 'runtime', 'store']); for (const k of ['mode', 'store', 'runtime']) assert.ok(CLOSED[k].includes(j.checks[k]), k); }
}

describe('G8 · health probes, configured app', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('/healthz: 200 { status: ok }, no auth, no-store, never audited', async () => {
    const r = await get(h, '/healthz');
    assert.equal(r.status, 200); assert.deepEqual(r.json, EX('healthz')); assert.match(r.cache, /no-store/);
    const audited = h.withStore((db) => db.prepare("SELECT count(*) AS n FROM audit_log WHERE command LIKE '%health%'").get().n);
    assert.equal(audited, 0);
  });
  it('/readyz: 200 ready, with closed-set checks only (app, store ok, runtime connected)', async () => {
    const r = await get(h, '/readyz');
    assert.equal(r.status, 200); closedOnly(r.json);
    assert.deepEqual(r.json, EX('readyz'));
  });
  it('no instance data: no name, email, version, path or id in either answer', async () => {
    const text = JSON.stringify([(await get(h, '/healthz')).json, (await get(h, '/readyz')).json]);
    for (const leak of ['test@example', 'synthetic', '2026', '/tmp', 'main', 'agent-office', ...TOKENS]) assert.ok(!text.includes(leak), leak);
  });
  it('a runtime that is down keeps the instance ready (it serves stale data)', async () => {
    await h.gw.stop();
    let r;
    for (let i = 0; i < 60; i++) { r = await get(h, '/readyz'); if (r.json.checks.runtime === 'disconnected') break; await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(r.status, 200); assert.equal(r.json.checks.runtime, 'disconnected');
  });
});

describe('G8 · health probes, setup mode and API-only', () => {
  it('setup mode: live, and ready (setup must be reachable): mode setup, store none', async () => {
    const h = await startServer(loadScenario('foreign-instance'), { setupMode: true });
    try {
      assert.deepEqual((await get(h, '/healthz')).json, EX('healthz'));
      const r = await get(h, '/readyz'); assert.equal(r.status, 200); assert.deepEqual(r.json, EX('readyz-setup'));
    } finally { await h.stop(); }
  });
  it('API-only: both probes answer at the root (not the JSON 404)', async () => {
    const h = await startServer(loadScenario('synthetic-basic'), { env: { AO_API_ONLY: '1' } });
    try { assert.equal((await get(h, '/healthz')).status, 200); assert.equal((await get(h, '/readyz')).status, 200); } finally { await h.stop(); }
  });
});

describe('G8 · readiness follows the store', () => {
  it('a store that stops answering → 503 not-ready (store: unavailable); liveness stays 200', () => {
    const { readiness } = require('../../src/ops/health');
    const ok = readiness({ mode: 'app', store: { ping: () => true }, engine: { runtime: () => ({ state: 'connected' }) } });
    assert.deepEqual(ok, { status: 200, body: EX('readyz') });
    const down = readiness({ mode: 'app', store: { ping: () => { throw new Error('closed'); } }, engine: { runtime: () => ({ state: 'disconnected' }) } });
    assert.deepEqual(down, { status: 503, body: EX('readyz-503') });
  });
});
