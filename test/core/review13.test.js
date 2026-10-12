'use strict';
// Review R13 (architect findings), each written to fail before its fix.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createEngine } = require('../../src/engine');
const { bind: bindCommands } = require('../../src/adapters/openclaw/commands');
const { bind: bindReads } = require('../../src/adapters/openclaw/reads');
const { tapGateway } = require('../../src/adapters/openclaw/taps');
const { CONTRACT_VERSION } = require('../../src/api/v2/envelope');

const ROOT = path.join(__dirname, '..', '..');
const NOW = Date.UTC(2026, 9, 6, 12);

// ---- a canonical (fake) adapter, as in test/core/fake-adapter.test.js ----
const fakeAdapter = () => ({ id: 'fake', name: 'Fake', testedWith: null, schemas: {}, routes: {}, eventPrefix: 'fake.event.',
  normalise: { session: (row) => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized', ruleId: 'fake', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null }),
  capabilities: () => ({ sessions: true, transcripts: true, sessionGroups: true, flows: { read: true }, skills: { detail: true } }) });
const session = (key, over = {}) => Object.assign({ key, sessionId: null,
  class: { kind: 'primary', ruleId: 'fake.main', agentId: 'helper', channel: null, heartbeatOf: null, background: false, rawClassification: null },
  displayName: null, model: null, provider: null, usage: { total: 1, input: null, output: null }, updatedAt: NOW,
  run: { status: 'idle', endReason: null, evidence: 'none', startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null }, over);

describe('R13-03 · canonical ingestion keeps last-good rows and never deletes on rejected evidence', () => {
  it('an invalid replacement of A plus an absent B: A keeps its good row, B is not deleted, the outcome fails, the source is not fresh', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    assert.equal(engine.ingestCanonical('sessions.snapshot', [session('A', { displayName: 'bon' }), session('B')]).ok, true);
    const r = engine.ingestCanonical('sessions.snapshot', [session('A', { usage: { total: -1, input: null, output: null } })]);
    assert.equal(r.ok, false, 'a rejected row fails the snapshot');
    assert.deepEqual(engine.sessions().map((s) => [s.key, s.displayName]), [['A', 'bon'], ['B', null]]);
    assert.equal(engine.sessionsMeta().complete, false, 'not a complete snapshot');
    const src = engine.sources().find((s) => s.id === 'fake');
    assert.equal(src.channels.find((c) => c.channel === 'canonical.sessions.snapshot').state, 'stale');
  });
  it('an invalid upsert keeps the existing row', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    engine.ingestCanonical('sessions.snapshot', [session('A', { displayName: 'bon' })]);
    assert.equal(engine.ingestCanonical('sessions.upsert', session('A', { displayName: 'mauvais', usage: { total: -1, input: null, output: null } })).ok, false);
    assert.equal(engine.session('A').displayName, 'bon');
  });
  it('an invalid group catalog keeps the last good catalog and is not fresh', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    engine.ingestCanonical('sessionGroups', [{ id: 'g1', name: 'Un', position: 0 }]);
    const r = engine.ingestCanonical('sessionGroups', [{ id: 'g2', name: 'Deux', position: -5 }]);
    assert.equal(r.ok, false);
    assert.deepEqual(engine.sessionGroups().map((g) => g.id), ['g1']);
  });
});

describe('R13-04 · boot without a runtime token', () => {
  it('loadConfig accepts a missing OC_GATEWAY_TOKEN (portal secrets stay required)', () => {
    const { loadConfig } = require('../../src/config');
    const cfg = loadConfig({ HOME: os.tmpdir(), AO_ENV: 'test', AO_DATA_DIR: path.join(os.tmpdir(), 'ao-r13'), PORTAL_EMAIL: 'a@b.c', PORTAL_PASSWORD: 'p', PORTAL_SECRET: 's' });
    assert.equal(cfg.gatewayToken, null);
  });
  it('the real server boots with no OC_* at all and reports the gateway source not-configured', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-notoken-'));
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
    const env = { PATH: '/usr/bin:/bin', HOME: home, PORT: String(port), HOST: '127.0.0.1', NODE_OPTIONS: '',
      PORTAL_EMAIL: 'owner@example.invalid', PORTAL_PASSWORD: 'pw', PORTAL_SECRET: 'secret-for-test', AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data') };
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const base = 'http://127.0.0.1:' + port;
    try {
      let up = false;
      for (let i = 0; i < 100 && !up && child.exitCode === null; i++) { try { up = (await fetch(base + '/api/v2/meta')).status === 200; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }
      assert.ok(up, 'server up\n' + out);
      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.invalid', password: 'pw' }) });
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const h = await (await fetch(base + '/api/v2/views/health', { headers: { cookie } })).json();
      const gw = h.data.sources.find((s) => s.id === 'gateway');
      assert.deepEqual([gw.state, gw.lastError], ['down', 'not-configured']);
      assert.match(out, /not configured \(no-token\)/);
    } finally { child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// A recording CLI: run(argv) → the scripted result
const recordingCli = (result) => {
  const calls = [];
  return { calls, run: async (argv) => {
    calls.push(argv);
    if (argv[0] === 'gateway' && !result?.refused) {
      const p = JSON.parse(argv.find(a => a.startsWith('--params=')).slice(9));
      return { ok: true, out: JSON.stringify({ ok: true, key: p.key, entry: { sendPolicy: 'deny' } }) };
    }
    return typeof result === 'function' ? result(argv) : result;
  },
    parseJson: (out) => { const i = String(out || '').indexOf('{'); if (i < 0) return null; try { return JSON.parse(out.slice(i)); } catch (_) { return null; } } };
};
const okReply = { ok: true, code: 0, out: JSON.stringify({ result: { payloads: [{ text: 'Bonjour' }], meta: { durationMs: 9, agentMeta: { model: 'm', provider: 'p', usage: { total: 3 } } } } }), err: '' };

describe('R13-05 · agentTurn argv: every flag keeps its own value', () => {
  it('with and without a session ref; a message starting with a dash stays a value', async () => {
    const cli = recordingCli(okReply);
    const c = bindCommands(cli);
    await c.agentTurn({ agentId: 'helper', text: '--danger', sessionRef: 'summary:test', timeoutMs: 150000 });
    await c.agentTurn({ agentId: 'helper', text: 'Salut', timeoutMs: 60000 });
    assert.deepEqual(cli.calls.filter(a => a[0] === 'agent'), [
      ['agent', '--message=--danger', '--agent=helper', '--json', '--timeout=150', '--channel=webchat', '--reply-channel=webchat', '--session-key=agent:helper:explicit:summary:test'],
      ['agent', '--message=Salut', '--agent=helper', '--json', '--timeout=60', '--channel=webchat', '--reply-channel=webchat', '--session-key=agent:helper:ao-internal'],
    ]);
  });
});

describe('R13-06 · a failed CLI process never yields a reply', () => {
  it('nonzero exit with parseable stdout, JSON ok:false, a refused run, no JSON → failures; a good run → the text', async () => {
    const run = (r) => bindCommands(recordingCli(r)).agentTurn({ agentId: 'a', text: 'x' });
    assert.ok((await run({ ok: false, code: 1, out: okReply.out, err: '' })).failed);
    assert.ok((await run({ ok: true, code: 0, out: '{"ok":false,"error":"nope"}', err: '' })).failed);
    assert.equal((await run({ ok: false, out: '', err: 'Instance de test', refused: 'readonly' })).failed, 'readonly');
    assert.equal((await run({ ok: true, code: 0, out: 'pas de json', err: '' })).failed, 'invalid-output');
    assert.equal((await run({ ok: true, code: 0, out: '{"result":{"payloads":"pas une liste"}}', err: '' })).failed, 'invalid-output');
    const good = await run(okReply);
    assert.equal(good.text, 'Bonjour'); assert.equal(good.failed, undefined);
  });
});

describe('R13-07 · a typed read fails when ingestion rejects the answer', () => {
  it('first read rejected, then valid, then invalid again: failure, success, failure (last-good kept)', async () => {
    const { EventEmitter } = require('events');
    let answer = { unexpected: 'synthetic' };
    const gw = Object.assign(new EventEmitter(), { connected: true, call: async () => answer });
    const engine = createEngine({ now: () => NOW });
    tapGateway(gw, engine);
    engine.setReads(bindReads({ gw, cli: { run: async () => ({ ok: false }) } }));
    const first = await engine.request('transcript', 'agent:main:main');
    assert.equal(first.ok, false); assert.equal(first.category, 'payload-rejected');
    answer = { messages: [{ role: 'user', content: 'Bonjour', timestamp: NOW }] };
    const second = await engine.request('transcript', 'agent:main:main');
    assert.equal(second.ok, true); assert.equal(second.value.events.length, 1);
    answer = { messages: 'cassé' };
    const third = await engine.request('transcript', 'agent:main:main');
    assert.equal(third.ok, false);
    assert.equal(engine.transcript('agent:main:main').events.length, 1, 'the last good transcript is kept');
  });
});

describe('R13-08 · every /v2 index alias gets the rendered shell', () => {
  it('encoded and extensionless aliases render basePath /v2/ and an empty API base', async () => {
    const express = require('express');
    const { createApp } = require('../../src/api/http');
    const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r13-pub-'));
    fs.mkdirSync(path.join(pub, 'v2'));
    fs.writeFileSync(path.join(pub, 'v2', 'index.html'), `<!doctype html><html><head><base href="/"><meta name="ao-config" content='{"basePath":"/","apiBase":"/backend"}'></head><body>x</body></html>`);
    fs.writeFileSync(path.join(pub, 'index.html'), 'v1');
    const app = createApp({ readonly: false, publicDir: pub, mountRoutes: () => {} });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    void express;
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const p of ['/v2/', '/v2/index.html', '/v%32/index.html', '/v2/%69ndex.html', '/v%32/', '/v2/index', '/v2']) {
        const r = await fetch(base + p, { redirect: 'manual' });
        const t = await r.text();
        assert.equal(r.status, 200, p);
        assert.match(t, /<base href="\/v2\/">/, p);
        assert.match(t, /&quot;apiBase&quot;:&quot;&quot;/, p);
      }
    } finally { server.close(); fs.rmSync(pub, { recursive: true, force: true }); }
  });
});

describe('R13-14 · the normative version literals equal CONTRACT_VERSION', () => {
  it('api.md declares contractVersion and illustrations with the current version only', () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'api.md'), 'utf8');
    const literals = [...md.matchAll(/contractVersion["']?\s*:\s*["'](\d+\.\d+)["']/g)].map((m) => m[1]);
    assert.ok(literals.length >= 2, 'found the declarations');
    assert.deepEqual([...new Set(literals)], [CONTRACT_VERSION]);
  });
});
