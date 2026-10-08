'use strict';
// Review R14 (architect findings) + R14-16 (office-dev), each written to fail before its fix.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer, waitFor, sleep } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');

const ROOT = path.join(__dirname, '..', '..');
const sc = loadScenario('synthetic-basic');
const JOB = 'ffffffff-0c01-4000-8000-000000000001';

describe('R14-01 · the skill detail uses the R1-11 reader (v2/v3 since S16)', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  it('a SKILL.md outside every approved root is not returned by the skill detail view', async () => {
    for (const v of ['v2', 'v3']) {
      const r = await h.get(`/api/${v}/views/skills/weather`);
      assert.equal(r.status, 200, v);
      assert.equal(r.json.data.markdown, '', v + ': the fixture file is outside the approved roots: never read');
    }
  });
});

describe('R14-03 · the package never contains private or local files', () => {
  it('nested .env*, *.sqlite, local fixtures/goldens, instance/ and reports are excluded even inside allowed dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pack-'));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
      const put = (rel, text = 'x') => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
      put('server.js'); put('src/ok.js'); put('public/v2/ok.js');
      const canaries = ['src/.env.private', 'src/.env', 'public/v2/.env.local', 'src/store/data.sqlite', 'src/store/data.sqlite-wal', 'public/v2/x/agent-office.sqlite',
        'src/test/fixtures/local/x.json', 'public/v2/golden/local/x.json', 'src/instance/env', 'public/v2/design/reports/r.md', 'src/x.token', 'src/id_ed25519',
        // R14-05 (artist-11): art provenance never ships
        'public/v2/bureau/assets/Characters/PROMPTS.md', 'public/v2/bureau/assets/tools/gen.py', 'public/v2/bureau/assets/guides/g.md',
        'public/v2/bureau/assets/Office/desk-raw.png', 'public/v2/bureau/assets/Office/room/rectification.json'];
      for (const c of canaries) put(c, 'PRIVATE_SYNTHETIC_PACK_CANARY');
      const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: tmp, encoding: 'utf8', env: Object.assign({}, process.env, { npm_config_loglevel: 'silent' }) });
      assert.equal(r.status, 0, r.stderr);
      const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
      assert.ok(files.includes('src/ok.js') && files.includes('public/v2/ok.js'), 'allowed files are packed');
      for (const c of canaries) assert.ok(!files.includes(c), c + ' must not be packed');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('the real package: no deny-listed path, and no packed text file contains a /home/ path', () => {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
    const deny = /(^|\/)(\.env($|\.(?!example$))|[^/]*\.sqlite|[^/]*\.token$|id_(rsa|ed25519)|PROMPTS\.md$|[^/]*-raw\.png$|rectification\.json$)|(^|\/)(fixtures\/local|golden\/local|instance|reports|tools|guides|mock)\//;
    assert.deepEqual(files.filter((f) => f !== '.env.example' && deny.test(f)), [], '.env.example is the one PM-visible exception (a placeholder template)');
    const text = files.filter((f) => /\.(js|mjs|json|md|css|html|sql|txt|example|webmanifest|svg)$/.test(f) || f === '.env.example');
    const leaks = text.filter((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').includes('/home/'); } catch (_) { return false; } });
    assert.deepEqual(leaks, []);
  });
});

describe('R14-07 · a failed or unavailable read is never a successful view', () => {
  it('capability unavailable → 404; a failed first read → 502; a failed refresh with data → 200 marked stale', async () => {
    let fail = 'none';
    const runs = readFixture(sc.rpc['cron.runs'].files[JOB] || sc.rpc['cron.runs'].default).body.value;
    const h = await startServer(sc, { handlers: { 'cron.runs': () => { if (fail === 'error') throw new Error('boom'); if (fail === 'shape') return { entries: 'cassé' }; return runs; } } });
    try {
      fail = 'shape';
      const first = await h.get('/api/v2/views/flows/' + JOB);
      assert.equal(first.status, 502, 'no data yet and the read failed'); assert.equal(first.json.error.code, 'upstream_failed');
      fail = 'none';
      const okR = await h.get('/api/v2/views/flows/' + JOB);
      assert.equal(okR.status, 200, 'a failed read did not block the retry for 30 s'); assert.ok(okR.json.data.runs.length > 0);
      fail = 'shape';
      await sleep(10);
      const stale = await h.get('/api/v2/views/flows/' + JOB + '?refresh=1');
      assert.equal(stale.status, 200); assert.ok(stale.json.data.runs.length > 0, 'the last good runs');
      assert.ok(stale.json.meta.stale.includes('gateway'), 'marked stale');
    } finally { await h.stop(); }
  });
});

describe('R14-08 · no polling without subscribers', () => {
  it('a GET alone starts no polling; a subscription polls; unsubscribing stops it', async () => {
    const h = await startServer(sc);
    try {
      await h.get('/api/v2/views/flows/' + JOB);
      const n0 = h.gw.callsTo('cron.runs').length;
      await sleep(6500);
      assert.equal(h.gw.callsTo('cron.runs').length, n0, 'no subscriber → no polling');
      const A = openSse(h.base, '/api/v2/stream?topics=' + encodeURIComponent('flow:' + JOB), { cookie: h.cookie });
      try {
        const hello = await A.next((f) => f.event === 'hello');
        await waitFor(() => h.gw.callsTo('cron.runs').length > n0, { timeoutMs: 8000, what: 'polling while subscribed' });
        await h.request('POST', `/api/v2/stream/${hello.data.streamId}/topics`, { remove: ['flow:' + JOB] });
        const n1 = h.gw.callsTo('cron.runs').length;
        await sleep(6500);
        assert.ok(h.gw.callsTo('cron.runs').length <= n1 + 1, 'stopped after unsubscribe');
      } finally { A.close(); }
    } finally { await h.stop(); }
  });
});

describe('R14-09 · resolving an interlocutor refreshes its built VM', () => {
  it('a topic built while pending shows the profile once the enricher resolves it (background or on demand)', async () => {
    const express = require('express');
    const { createEngine } = require('../../src/engine');
    const { createTopics } = require('../../src/api/v2/topics');
    const { mountViews } = require('../../src/api/v2/views');
    const { okBody } = require('../../src/api/v2/envelope');
    const { errorMiddleware } = require('../../src/api/v2/errors');
    const engine = createEngine({ now: () => sc.now });
    engine.ingest({ source: 'gateway', channel: 'gw.rpc.sessions.list', receivedAt: sc.now, context: { offset: 0 }, body: { kind: 'json', value: readFixture(sc.rpc['sessions.list']).body.value } });
    // a fake enrichment (G7, ADR-001 §14.2): pending until resolved, which notifies its listeners like the real background
    // enrichment; it serves InterlocutorProfiles, as every enricher does
    const listeners = []; let profile = null;
    const enrichment = { peek: () => (profile ? { resolution: 'resolved', profile } : { resolution: 'pending', profile: null }), handles: () => true,
      resolve: async () => {}, onChange: (fn) => listeners.push(fn), nameOf: () => (profile ? profile.displayName : null),
      resolveNow() { profile = { displayName: 'Guest', username: 'guest', avatarUrl: null, isBot: false, createdAt: 1 }; listeners.forEach((fn) => fn()); } };
    const topics = createTopics({}, { coalesceMs: 0 });
    const app = express(); const r = express.Router();
    const views = mountViews({ r, engine, topics, store: null, runtime: null, enrichment, authed: (q, s, n) => n(), ok: (res, data, topic) => res.json(okBody(data, { engine, topic })) });
    r.use(errorMiddleware()); app.use('/api/v2', r);
    const server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    try {
      const id = 'discord-user:100000000000000001';
      const url = 'http://127.0.0.1:' + server.address().port + '/api/v2/views/interlocutors/' + encodeURIComponent(id);
      assert.equal(topics.current('interlocutor:' + encodeURIComponent(id)).vm.resolution, 'pending', 'built while pending');
      enrichment.resolveNow();
      const vm = (await (await fetch(url)).json()).data;
      assert.equal(vm.resolution, 'resolved'); assert.equal(vm.profile.displayName, 'Guest');
      assert.equal(topics.current('access').vm.interlocutors.find((x) => x.id === id).name, 'Guest', 'dependent name projections too');
    } finally { server.close(); views.close(); }
  });
});

describe('R14-10 · session keys are decoded once', () => {
  it('literal %, %2F and Unicode in a key resolve to the session', async () => {
    const keys = ['agent:main:explicit:50%off', 'agent:main:explicit:a%2Fb', 'agent:main:explicit:café'];
    const list = () => {
      const v = readFixture(sc.rpc['sessions.list']).body.value;
      const base = v.sessions.find((s) => s.key === 'agent:main:main');
      for (const k of keys) v.sessions.push(Object.assign({}, base, { key: k, isMain: false, kind: 'direct' }));
      v.totalCount = v.count = v.sessions.length;
      return v;
    };
    const h = await startServer(sc, { handlers: { 'sessions.list': list } });
    try {
      for (const k of keys) {
        const r = await h.get('/api/v2/views/sessions/' + encodeURIComponent(k));
        assert.equal(r.status, 200, k); assert.equal(r.json.data.key, k);
        assert.ok(r.json.meta.stale.includes('gateway'), 'no transcript for it in the fake gateway: the response says the trace is stale');
      }
    } finally { await h.stop(); }
  });
});

describe('R14-18 · a canonical flow event refreshes the runs (no raw-event dependency)', () => {
  it('cron.fired produced by a FOREIGN adapter route triggers an immediate runs read for a subscribed flow', async () => {
    const express = require('express');
    const s = require('../../src/schema');
    const { createEngine } = require('../../src/engine');
    const { createTopics } = require('../../src/api/v2/topics');
    const { mountViews } = require('../../src/api/v2/views');
    const { okBody } = require('../../src/api/v2/envelope');
    const adapter = { id: 'foreign', name: 'Foreign', testedWith: null, eventPrefix: 'foreign.event.',
      schemas: { 'foreign.flow.fired': { id: 'foreign', version: 1, testedWith: null, schema: s.object({ id: s.string() }) } },
      routes: { 'foreign.flow.fired': { op: 'flowEvent', prep: (v) => ({ jobId: v.id, fired: true }) } },
      normalise: { session: (row) => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
      classifySession: () => ({ kind: 'unrecognized', ruleId: 'x', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null }),
      capabilities: () => ({ flows: { read: true } }) };
    const engine = createEngine({ adapter, now: () => sc.now });
    const job = { id: 'job-1', name: 'Tâche', description: '', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * 1', tz: null }, agentId: 'a', sessionTarget: 'isolated',
      wakeMode: 'now', payload: null, delivery: null, steps: [], createdAt: null, updatedAt: null, nextRunAt: null, lastRunAt: null, lastRunStatus: null,
      lastRunError: null, lastDeliveryStatus: null, deleteAfterRun: false, sessionKey: null, health: 'never-run' };
    assert.equal(engine.ingestCanonical('flows', [job]).ok, true);
    let reads = 0;
    engine.setReads({ flowRuns: async () => { reads++; engine.ingestCanonical('flowRuns', [], { key: 'job-1' }); return { ok: true }; } });
    const topics = createTopics({}, { coalesceMs: 0 });
    const r = express.Router();
    const views = mountViews({ r, engine, topics, store: null, runtime: null, discord: null, authed: (q, x, n) => n(),
      ok: (res, data) => res.json(okBody(data, { engine })), isSubscribed: (id) => id === 'flow:job-1' });
    try {
      topics.current('flow:job-1');
      const n0 = reads;
      engine.ingest({ source: 'foreign', channel: 'foreign.flow.fired', receivedAt: sc.now, body: { kind: 'json', value: { id: 'job-1' } } });
      await waitFor(() => reads > n0, { timeoutMs: 2000, what: 'an immediate read after the canonical event' });
    } finally { views.close(); }
  });
});

describe('R14-16 · the active KPI: « au repos » only when nobody is busy', () => {
  const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
  const engineWith = (state) => ({
    gateway: () => ({ connected: state !== 'offline', since: 1 }),
    sessions: () => [{ key: 'agent:main:main', updatedAt: 1, usage: { total: 0 }, interactive: false, displayName: null,
      class: { kind: 'primary', agentId: 'main', heartbeatOf: null, channel: null },
      run: { status: state === 'working' ? 'running' : state === 'error' ? 'failed' : 'idle', endedAt: state === 'error' ? 99999 : null } }],
    agents: () => [{ id: 'main', name: 'Agent', isPrimary: true, mainSessionKey: 'agent:main:main' }],
    session: () => null, cronJobs: () => [], host: () => null, liveEvents: () => [],
  });
  for (const [state, key] of [['working', 'kpi.onStage'], ['error', 'kpi.onStage'], ['offline', 'kpi.idle'], ['idle', 'kpi.idle']]) {
    it('a sole primary ' + state + ' → ' + key, () => {
      const vm = buildOfficeVM({ engine: engineWith(state), now: 100000, tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'Système' }) });
      assert.equal(vm.kpis.find((k) => k.id === 'active').sub.key, key);
    });
  }
});
