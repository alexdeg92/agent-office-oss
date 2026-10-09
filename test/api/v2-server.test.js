'use strict';
// S6 acceptance: API v2 envelope/errors/meta, the health view and topic, mute, the typed SSE stream
// (api.md §4.6 sequences), R1-09 (expiry/logout) and R1-10 (cookie attributes), against the real server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { compareExample } = require('../helpers/contract-shape');
const { apply } = require('../../src/api/v2/diff');

const sc = loadScenario('synthetic-basic');
const degrade = (h, degraded) => h.gw.emit('health', { ok: true, eventLoop: { degraded, delayP99Ms: degraded ? 900 : 12 } });

describe('API v2 · envelope, errors, meta, me', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('meta needs no auth; one Ok envelope; contract 2.4; labels include the 2.1 namespaces', async () => {
    const r = await fetch(h.base + '/api/v2/meta');
    assert.equal(r.status, 200); assert.match(r.headers.get('x-request-id'), /^req_[0-9a-f]{12}$/); assert.equal(r.headers.get('cache-control'), 'no-store');
    const b = await r.json();
    assert.deepEqual(Object.keys(b).sort(), ['data', 'meta']);
    assert.equal(b.data.contractVersion, '2.7'); assert.equal(b.data.env, 'dev');
    assert.deepEqual(b.data.capabilities, { openclawWrites: true, storeWrites: true });
    for (const k of ['sourceError.timeout', 'error.unauthorized', 'historyKind.status', 'sessionKind.cron', 'runEnd.timeout', 'healthSub.cores']) assert.ok(b.data.labels[k], k);
    assert.ok(b.data.enums.sessionKind.includes('cron'));
  });

  it('errors: one format with the request id (401, 404, invalid JSON, unknown field)', async () => {
    const r401 = await fetch(h.base + '/api/v2/me');
    const e401 = await r401.json();
    assert.equal(r401.status, 401); assert.equal(e401.error.code, 'unauthorized'); assert.equal(e401.error.requestId, r401.headers.get('x-request-id'));
    const r404 = await h.get('/api/v2/nope');
    assert.equal(r404.status, 404); assert.equal(r404.json.error.code, 'not_found');
    const bad = await fetch(h.base + '/api/v2/health/issues/x/muted', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-ao-request': '1', cookie: h.cookie }, body: '{bad' });
    assert.equal(bad.status, 400); assert.deepEqual((await bad.json()).error.details, [{ issue: 'invalid-json' }]);
    const extra = await h.request('PUT', '/api/v2/health/issues/x/muted', { muted: true, nope: 1 });
    assert.equal(extra.status, 400); assert.deepEqual(extra.json.error.details, [{ field: 'nope', issue: 'unexpected-field' }]);
  });

  it('me: email, gateway, capabilities, session expiry', async () => {
    const r = await h.get('/api/v2/me');
    assert.equal(r.status, 200); assert.equal(r.json.data.gateway, 'up');
    assert.equal(r.json.data.displayName, 'test', 'default: the e-mail local part (S6.1)');
    assert.ok(Number.isInteger(r.json.data.sessionExpiresAt));
  });

  it('health view matches the authoritative example and backs the `health` topic', async () => {
    const r = await h.get('/api/v2/views/health');
    assert.equal(r.status, 200);
    assert.deepEqual(compareExample('health-vm', r.json.data), []);
    assert.deepEqual(Object.keys(r.json).sort(), ['data', 'meta']);
    assert.equal(r.json.meta.topic.id, 'health'); assert.ok(r.json.meta.topic.rev >= 1);
  });
});

describe('API v2 · mute (api.md §5.3)', () => {
  let h;
  before(async () => { h = await startServer(sc, { handlers: { 'channels.status': () => { throw new Error('boom'); } } }); });
  after(async () => { if (h) await h.stop(); });

  it('warn/info issues mute and unmute; an error issue is refused; an unknown id is 404', async () => {
    h.gw.emit('unknown.event', { a: 1 });   // info: event.unknown
    await waitFor(async () => (await h.get('/api/v2/views/health')).json.data.dataQuality.issues.some((i) => i.code === 'event.unknown'), { what: 'info issue' });
    const issues = (await h.get('/api/v2/views/health')).json.data.dataQuality.issues;
    const info = issues.find((i) => i.code === 'event.unknown'), err = issues.find((i) => i.severity === 'error');
    let r = await h.request('PUT', `/api/v2/health/issues/${info.id}/muted`, { muted: true });
    assert.equal(r.status, 200); assert.deepEqual(r.json.data, { ok: true, result: { state: 'muted' }, revision: null, vm: null });
    r = await h.request('PUT', `/api/v2/health/issues/${info.id}/muted`, { muted: false });
    assert.equal(r.json.data.result.state, 'open');
    r = await h.request('PUT', `/api/v2/health/issues/${err.id}/muted`, { muted: true });
    assert.equal(r.status, 400); assert.deepEqual(r.json.error.details, [{ issue: 'error-not-mutable' }]);
    r = await h.request('PUT', '/api/v2/health/issues/0000000000000000/muted', { muted: true });
    assert.equal(r.status, 404);
  });
});

describe('API v2 · SSE (api.md §4.6)', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('two clients: hello, a snapshot at the CURRENT rev, then the same delta (rev + 1, baseRev) to both', async () => {
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    const B = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    try {
      const helloA = await A.next((f) => f.event === 'hello');
      assert.equal(helloA.data.resumed, false); assert.deepEqual(helloA.data.topics, ['health']); assert.equal(helloA.data.contractVersion, '2.7');
      assert.match(helloA.id, /^str_[0-9A-Za-z]{22}:1$/);
      const sA = await A.next((f) => f.event === 'snapshot'), sB = await B.next((f) => f.event === 'snapshot');
      assert.equal(sA.id.split(':')[1], '2');
      assert.equal(sA.data.rev, sB.data.rev, 'the current rev for every stream');
      assert.equal((await h.get('/api/v2/views/health')).json.meta.topic.rev, sA.data.rev);
      degrade(h, true);
      const dA = await A.next((f) => f.event === 'delta' || (f.event === 'snapshot' && f.data.rev > sA.data.rev));
      const dB = await B.next((f) => f.event === 'delta' || (f.event === 'snapshot' && f.data.rev > sB.data.rev));
      assert.equal(dA.data.rev, sA.data.rev + 1); assert.deepEqual(dA.data, dB.data);
      if (dA.event === 'delta') {
        assert.equal(dA.data.baseRev, sA.data.rev);
        const vm = apply(sA.data.data, dA.data.ops);
        assert.equal(vm.cards.find((c) => c.id === 'event-loop').level, 'alert');
      }
    } finally { A.close(); B.close(); degrade(h, false); }
  });

  it('gap → resync: POST resync answers {queued:true} and sends a snapshot at the current rev', async () => {
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    try {
      const hello = await A.next((f) => f.event === 'hello');
      await A.next((f) => f.event === 'snapshot');
      const r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/resync`, { topic: 'health' });
      assert.equal(r.status, 200); assert.deepEqual(r.json.data, { queued: true });
      await waitFor(async () => A.frames.filter((f) => f.event === 'snapshot').length === 2, { what: 'resync snapshot' });
      const bad = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/resync`, { topic: 'nope' });
      assert.equal(bad.status, 400); assert.deepEqual(bad.json.error.details, [{ field: 'topic', issue: 'unknown-topic' }]);
    } finally { A.close(); }
  });

  it('topics: unknown ones are reported (hello.rejected / rejected), never rejecting the known ones; add sends a snapshot; remove stops it', async () => {
    const O = openSse(h.base, '/api/v2/stream?topics=health,nope', { cookie: h.cookie });
    try {
      const hello = await O.next((f) => f.event === 'hello');
      assert.deepEqual(hello.data.topics, ['health']); assert.deepEqual(hello.data.rejected, [{ topic: 'nope', issue: 'unknown-topic' }]);
      const batch = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/topics`, { add: ['office', 'layoutX', 'flows'] });
      assert.equal(batch.status, 200); assert.deepEqual(batch.json.data.rejected, [{ topic: 'layoutX', issue: 'unknown-topic' }]);
      assert.deepEqual(batch.json.data.topics.sort(), ['flows', 'health', 'office']);
    } finally { O.close(); }
    const A = openSse(h.base, '/api/v2/stream', { cookie: h.cookie });
    try {
      const hello = await A.next((f) => f.event === 'hello');
      assert.deepEqual(hello.data.topics, []);
      let r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/topics`, { add: ['health'] });
      assert.deepEqual(r.json.data, { topics: ['health'] });
      await A.next((f) => f.event === 'snapshot' && f.data.topic === 'health');
      r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/topics`, { add: ['nope'] });
      assert.equal(r.status, 200); assert.deepEqual(r.json.data, { topics: ['health'], rejected: [{ topic: 'nope', issue: 'unknown-topic' }] });
      r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/topics`, { remove: ['health'] });
      assert.deepEqual(r.json.data, { topics: [] });
    } finally { A.close(); }
  });

  it("another session's stream id is 404", async () => {
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    try {
      const hello = await A.next((f) => f.event === 'hello');
      const mine = h.cookie;
      await h.login();                                   // a second session (new sid)
      assert.notEqual(h.cookie, mine);
      const r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/resync`, { topic: 'health' });
      assert.equal(r.status, 404);
      h.cookie = mine;
    } finally { A.close(); }
  });

  it('resume within 2 min: Last-Event-ID replays the missed frames with their original ids; an unknown id gets a new stream', async () => {
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    const hello = await A.next((f) => f.event === 'hello');
    const snap = await A.next((f) => f.event === 'snapshot');
    A.close();
    await new Promise((r) => setTimeout(r, 100));
    degrade(h, true);                                    // a change while disconnected: buffered
    await new Promise((r) => setTimeout(r, 600));
    const R = openSse(h.base, '/api/v2/stream?topics=ignored', { cookie: h.cookie, lastEventId: snap.id });
    try {
      const h2 = await R.next((f) => f.event === 'hello');
      assert.equal(h2.data.resumed, true); assert.equal(h2.data.streamId, hello.data.streamId); assert.deepEqual(h2.data.topics, ['health']);
      assert.equal(h2.id, undefined, 'the resume hello has no id');
      const missed = await R.next((f) => f.event === 'delta' || (f.event === 'snapshot' && f.data.rev > snap.data.rev));
      assert.equal(missed.id, `${hello.data.streamId}:${Number(snap.id.split(':')[1]) + 1}`, 'original id');
    } finally { R.close(); degrade(h, false); }
    const N = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie, lastEventId: 'str_AAAAAAAAAAAAAAAAAAAAAA:9' });
    try { const h3 = await N.next((f) => f.event === 'hello'); assert.equal(h3.data.resumed, false); assert.notEqual(h3.data.streamId, hello.data.streamId); } finally { N.close(); }
  });
});

describe('API v2 · R1-09 logout revocation, R1-10 cookie attributes', () => {
  let h;
  const secret = crypto.randomBytes(16).toString('hex');
  before(async () => { h = await startServer(sc, { env: { PORTAL_SECRET: secret } }); });
  after(async () => { if (h) await h.stop(); });

  it('logout revokes the session server-side: a copied cookie is refused (/api/me, v2, v3) and its streams close', async () => {
    const copy = h.cookie;
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: copy });
    await A.next((f) => f.event === 'snapshot');
    const out = await h.post('/api/logout');
    assert.equal(out.status, 200);
    const sys = await A.next((f) => f.event === 'system');
    assert.equal(sys.data.closing, 'logged-out');
    await A.ended$();
    for (const p of ['/api/v2/me', '/api/v3/me', '/api/me']) {
      const r = await fetch(h.base + p, { headers: { cookie: copy } });
      assert.equal(r.status, 401, p);
    }
    await h.login();
  });

  it('the test instance sets no Secure attribute (HTTP); PORTAL_COOKIE_SECURE / production decide', async () => {
    const ok = await h.login();
    const set = ok.headers.get('set-cookie') || '';
    assert.match(set, /^taco_sess=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
    assert.doesNotMatch(set, /Secure/);
    const { loadConfig } = require('../../src/config');
    const base = { OC_GATEWAY_TOKEN: 't', PORTAL_EMAIL: 'a@b.c', PORTAL_PASSWORD: 'p', PORTAL_SECRET: 's', HOME: '/tmp/x' };
    assert.equal(loadConfig(Object.assign({}, base, { NODE_ENV: 'production' })).cookieSecure, true);
    assert.equal(loadConfig(Object.assign({}, base, { PORTAL_READONLY: '1', NODE_ENV: 'production' })).cookieSecure, false, 'staging: never silently');
    assert.equal(loadConfig(Object.assign({}, base, { PORTAL_READONLY: '1', PORTAL_COOKIE_SECURE: '1' })).cookieSecure, true);
    assert.equal(loadConfig(Object.assign({}, base, { NODE_ENV: 'production', PORTAL_COOKIE_SECURE: '0' })).cookieSecure, false);
  });
});

describe('API v2 · read-only instance (§5.0)', () => {
  let h;
  before(async () => { h = await startServer(sc, { readonly: true }); });
  after(async () => { if (h) await h.stop(); });

  it('transport control is never guarded; store writes follow PORTAL_READONLY_STORE; capabilities say so', async () => {
    const meta = (await h.get('/api/v2/meta')).json.data;
    assert.deepEqual(meta.capabilities, { openclawWrites: false, storeWrites: true }); assert.equal(meta.readonly, true);
    const A = openSse(h.base, '/api/v2/stream?topics=health', { cookie: h.cookie });
    try {
      const hello = await A.next((f) => f.event === 'hello');
      const r = await h.request('POST', `/api/v2/stream/${hello.data.streamId}/resync`, { topic: 'health' });
      assert.equal(r.status, 200);
      const m = await h.request('PUT', '/api/v2/health/issues/0000000000000000/muted', { muted: true });
      assert.equal(m.status, 404, 'a store write reaches the route (404 = unknown id, not 403)');
    } finally { A.close(); }
  });
});

describe('API v2 · MeVM.displayName (S6.1)', () => {
  let h;
  before(async () => { h = await startServer(sc, { env: { PORTAL_DISPLAY_NAME: 'Owner' } }); });
  after(async () => { if (h) await h.stop(); });
  it('PORTAL_DISPLAY_NAME is the display name (and the owner Person\'s name)', async () => {
    assert.equal((await h.get('/api/v2/me')).json.data.displayName, 'Owner');
  });
});
