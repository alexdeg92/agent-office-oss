'use strict';
// Review R17a residuals of R16-05, R16-07, R16-10 (go-live gate), each written to fail before its fix.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { isHash } = require('../../src/security/password');

const sc = loadScenario('synthetic-basic');
const rows = (h) => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true }); try { return db.prepare("SELECT outcome, detail FROM audit_log WHERE command = 'auth.login' ORDER BY id").all().map((r) => ({ ...r })); } finally { db.close(); } };

describe('R16-05 residual · every pre-parse login refusal counts and is audited', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  it('gzip, a foreign charset and an oversized body: refused before parsing, audited, counted (6 refusals lock the client)', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.70' };
    const good = JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const post = (headers, body) => fetch(h.base + '/api/login', { method: 'POST', headers: Object.assign({}, ip, headers), body }).then((r) => r.status);
    const before = rows(h).length;
    assert.equal(await post({ 'content-type': 'application/json', 'content-encoding': 'gzip' }, zlib.gzipSync(good)), 415, 'compressed: never inflated');
    assert.equal(await post({ 'content-type': 'application/json; charset=utf-16' }, Buffer.from(good, 'utf16le')), 415);
    assert.equal(await post({ 'content-type': 'application/json' }, JSON.stringify({ email: TEST_EMAIL, password: 'x'.repeat(20000) })), 413);
    assert.deepEqual(rows(h).slice(before).map((r) => [r.outcome, r.detail]), [['rejected', 'content-encoding'], ['rejected', 'charset'], ['rejected', 'too-large']]);
    for (let i = 0; i < 3; i++) await post({ 'content-type': 'application/json', 'content-encoding': 'deflate' }, zlib.deflateSync(good));
    assert.equal(await post({ 'content-type': 'application/json' }, good), 429, 'six refusals lock the client, even with the right password');
  });
});

describe('R16-07 residual · a shared (chat) transcript pull sets traceState from its own outcome', () => {
  it('unit: any pull of a transcript records its outcome for the session view (views.pull)', async () => {
    const express = require('express');
    const { createEngine } = require('../../src/engine');
    const { createTopics } = require('../../src/api/v2/topics');
    const { mountViews } = require('../../src/api/v2/views');
    const { readFixture } = require('../helpers/scenario');
    const engine = createEngine({ now: () => sc.now });
    engine.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: sc.now, context: { offset: 0 }, body: { kind: 'json', value: readFixture(sc.rpc['sessions.list']).body.value } });
    let ok = true;
    engine.setReads({ transcript: async (key) => {
      if (!ok) return { ok: false, category: 'timeout' };
      engine.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.get', receivedAt: sc.now, context: { key }, body: { kind: 'json', value: { messages: [{ role: 'user', content: 'x', timestamp: sc.now }] } } });
      return { ok: true };
    } });
    const topics = createTopics({}, { coalesceMs: 0 });
    const views = mountViews({ r: express.Router(), engine, topics, store: null, runtime: null, discord: null, authed: (q, s, n) => n(), ok: () => {} });
    try {
      const key = 'agent:main:main';
      await views.pull('transcript', key, {}, { force: true });
      assert.equal(topics.current('session:' + encodeURIComponent(key)).vm.traceState, 'fresh');
      ok = false;
      await views.pull('transcript', key, {}, { force: true });   // e.g. the chat's or the ticker's pull
      assert.equal(topics.current('session:' + encodeURIComponent(key)).vm.traceState, 'stale');
    } finally { views.close(); }
  });
});

describe('R16-10 residual · only sane, runnable scrypt costs', () => {
  const salt = crypto.randomBytes(16).toString('base64url'), key = crypto.randomBytes(32).toString('base64url');
  const h = (N, r, p) => `scrypt:${N}:${r}:${p}:${salt}:${key}`;
  it('refuses a low r, a too-high p, an excessive total cost; accepts the defaults', () => {
    for (const [N, r, p] of [[32768, 1, 1], [32768, 4, 1], [32768, 8, 17], [65536, 8, 16], [16384, 8, 0]]) assert.equal(isHash(h(N, r, p)), false, `${N}/${r}/${p}`);
    for (const [N, r, p] of [[32768, 8, 1], [16384, 8, 1], [65536, 8, 1]]) assert.equal(isHash(h(N, r, p)), true, `${N}/${r}/${p}`);
  });
});

describe('R17-05 · a chunked login body (no Content-Length) gets the same 4 KiB ceiling', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  it('a 20 KB chunked login → 413 too-large, audited and counted; a small chunked login still works', async () => {
    const http = require('http');
    const u = new URL(h.base + '/api/login');
    const chunked = (body, ip) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', 'x-forwarded-for': ip } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      for (let i = 0; i < body.length; i += 1000) req.write(body.slice(i, i + 1000));   // several chunks, no length
      req.end();
    });
    const before = rows(h).length;
    assert.equal(await chunked(JSON.stringify({ email: TEST_EMAIL, password: 'x'.repeat(20000) }), '203.0.113.80'), 413);
    assert.deepEqual(rows(h).slice(before).map((r) => [r.outcome, r.detail]), [['rejected', 'too-large']]);
    assert.equal(await chunked(JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }), '203.0.113.81'), 200, 'a normal chunked login');
  });
});
