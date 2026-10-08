'use strict';
// Review R16 (NO-GO items, architect), each written to fail before its fix.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { isHash } = require('../../src/security/password');
const { main: tokenCli } = require('../../scripts/agent-token');

const sc = loadScenario('synthetic-basic');
const login = (h, body, headers = {}) => fetch(h.base + '/api/login', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers),
  body: typeof body === 'string' ? body : JSON.stringify(body) }).then((r) => r.status);
const auditRows = (h, where = "command = 'auth.login'") => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT command, outcome, detail, actor_json FROM audit_log WHERE ${where} ORDER BY id`).all().map((r) => ({ ...r })); } finally { db.close(); } };

describe('R16-01 · concurrent logins can\'t bypass the throttle', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  it('32 parallel wrong-password logins from one client: at most 5 are verified, the rest 429', async () => {
    const statuses = await Promise.all(Array.from({ length: 32 }, () => login(h, { email: TEST_EMAIL, password: 'wrong' }, { 'x-forwarded-for': '203.0.113.50' })));
    const n401 = statuses.filter((s) => s === 401).length, n429 = statuses.filter((s) => s === 429).length;
    assert.ok(n401 <= 5, `${n401} verified (≤ 5 free attempts)`);
    assert.equal(n401 + n429, 32);
  });
});

describe('R16-02 · proxy trust: loopback by default; an explicit list otherwise', () => {
  it('with AO_TRUST_PROXY naming another proxy, a forged X-Forwarded-For can\'t open a new bucket', async () => {
    const h = await startServer(sc, { env: { AO_TRUST_PROXY: '10.9.9.9' } });
    try {
      for (let i = 0; i < 6; i++) await login(h, { email: TEST_EMAIL, password: 'wrong' }, { 'x-forwarded-for': '198.51.100.' + i });
      assert.equal(await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD }, { 'x-forwarded-for': '198.51.100.99' }), 429, 'the socket address is the bucket');
    } finally { await h.stop(); }
  });
  it('config default: loopback only', () => {
    const { loadConfig } = require('../../src/config');
    const cfg = loadConfig({ HOME: '/tmp', AO_ENV: 'test', AO_DATA_DIR: '/tmp/ao-r16', PORTAL_EMAIL: 'a@b.c', PORTAL_SECRET: 's', PORTAL_PASSWORD: 'p' });
    assert.equal(cfg.trustProxy, 'loopback');
  });
});

describe('R16-05 · refusals before parsing still count and are audited', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  it('a text/plain login and a malformed JSON login: refused, audited as auth.login, counted toward the throttle', async () => {
    const before = auditRows(h).length;
    const ip = { 'x-forwarded-for': '203.0.113.60' };
    assert.equal(await login(h, '{"email":"x"}', Object.assign({ 'content-type': 'text/plain' }, ip)), 415);
    assert.equal(await login(h, '{bad', ip), 400);
    const rows = auditRows(h).slice(before);
    assert.deepEqual(rows.map((r) => [r.outcome, r.detail]), [['rejected', 'not-json'], ['rejected', 'invalid-json']]);
    for (let i = 0; i < 4; i++) await login(h, '{bad', ip);
    assert.equal(await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD }, ip), 429, 'six refused attempts lock the client');
  });
  it('a bearer request refused for its media type is attributed to the token and rate-counted; CSRF is not "readonly"', async () => {
    const f = path.join(h.tmp, 'tok'); const w = process.stdout.write; process.stdout.write = () => true;
    try { tokenCli(['create', '--agent', 'main', '--out', f], { AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), HOME: h.tmp }); } finally { process.stdout.write = w; }
    const token = fs.readFileSync(f, 'utf8').trim();
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await fetch(h.base + '/api/v2/projects/x/status', { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body: 'x' })).status);
    assert.equal(statuses[30], 429, 'counted');
    // the audit router writes its row when the response FINISHES (it records the final status), which can be after the
    // client has the response: wait for the rows instead of racing them (flaky under load before)
    await waitFor(() => auditRows(h, "command = 'projects.setStatus'").length >= 30, { what: 'the 30 media-type audit rows' });
    const rows = auditRows(h, "command = 'projects.setStatus'");
    assert.ok(rows.length >= 30 && rows.every((r) => JSON.parse(r.actor_json).kind === 'agent' && /token:tok_/.test(r.detail || '')), 'attributed to the token');
    const csrf = await fetch(h.base + '/api/v2/gateway/restart', { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"confirm":"redemarrer"}' });
    assert.equal(csrf.status, 403);
    await waitFor(() => auditRows(h, "command = 'gateway.restart'").length > 0, { what: 'the csrf audit row' });
    const last = auditRows(h, "command = 'gateway.restart'").at(-1);
    assert.equal(last.detail, 'csrf');
  });
});

describe('R16-07 · session detail reports an unavailable or failed trace', () => {
  it('traceState: fresh after a good read; stale when the read failed (last good kept); unavailable without the capability', async () => {
    let fail = false;
    const h = await startServer(sc, { handlers: { 'sessions.get': (p) => { if (fail) throw new Error('unavailable'); return { messages: [{ role: 'user', content: 'Bonjour', timestamp: sc.now }] }; } } });
    try {
      const key = encodeURIComponent('agent:main:main');
      const a = (await h.get('/api/v2/views/sessions/' + key)).json.data;
      assert.equal(a.traceState, 'fresh'); assert.equal(a.events.length, 1);
      fail = true;
      const b = (await h.get('/api/v2/views/sessions/' + key)).json.data;
      assert.equal(b.traceState, 'stale'); assert.equal(b.events.length, 1, 'the last good trace');
    } finally { await h.stop(); }
    const { buildSessionVM } = require('../../src/api/v2/vm/logs');
    const s = { key: 'k', class: { kind: 'main', heartbeatOf: null, channel: null }, model: null, provider: null, usage: { total: 0 }, updatedAt: null, cwd: null,
      run: { status: 'idle', endReason: null }, messageCount: null, displayName: null };
    assert.equal(buildSessionVM(s, null, {}, 'unavailable').traceState, 'unavailable');
  });
});

describe('R16-10 · config refuses scrypt costs the verifier can\'t run', () => {
  it('N=131072 r=8 (over the memory cap) is not a usable hash; N=32768 is', () => {
    const salt = crypto.randomBytes(16).toString('base64url'), key = crypto.randomBytes(32).toString('base64url');
    assert.equal(isHash(`scrypt:131072:8:1:${salt}:${key}`), false);
    assert.equal(isHash(`scrypt:32768:8:1:${salt}:${key}`), true);
    assert.equal(isHash(`scrypt:32768:64:1:${salt}:${key}`), false);
  });
});
