'use strict';
/*
 * G6 · the `demo` runtime adapter: a synthesised team on the adapter interface alone (canonical ingestion, no OpenClaw
 * shapes, no network), deterministic by seed, live, read-only; selected by AO_RUNTIME, the instance config or setup.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { createEngine } = require('../../src/engine');
const demo = require('../../src/adapters/demo');
const { hashPassword } = require('../../src/security/password');
const { loadScenario } = require('../helpers/scenario');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { TOKENS } = require('../portability/personal-literals');

const NOW = Date.UTC(2026, 9, 6, 12);
function run(seed, ticks, locale = 'en') {
  let t = NOW;
  const engine = createEngine({ adapter: demo.definition, now: () => t });
  const rt = demo.createRuntime({ demoSeed: seed, instanceLocale: locale });
  rt.attach(engine); rt.start(engine, {}); rt.close();   // no timer: ticks are driven here
  const snaps = [];
  for (let i = 0; i < ticks; i++) { t += demo.TICK_MS; rt.tick(1); snaps.push(JSON.stringify(engine.sessions().map((s) => [s.key, s.run.status, s.usage.total]))); }
  return { engine, rt, snaps };
}

describe('G6 · demo runtime (unit)', () => {
  it('deterministic: the same seed and ticks give the same team history; another seed differs', () => {
    assert.deepEqual(run(42, 40).snaps, run(42, 40).snaps);
    assert.notDeepEqual(run(42, 40).snaps, run(43, 40).snaps);
  });

  it('a believable, live team: every session kind, the primary is Nova, things change tick by tick, flows get runs', async () => {
    const { engine, rt, snaps } = run(7, 60);
    const kinds = new Set(engine.sessions().map((s) => s.class.kind));
    for (const k of ['primary', 'conversation-direct', 'conversation-group', 'scheduled', 'subagent']) assert.ok(kinds.has(k), k);
    assert.equal(engine.primaryAgent().id, 'nova');
    assert.ok(new Set(snaps).size > 30, 'the state moves on most ticks');
    assert.ok(engine.liveEvents().some((e) => e.kind.startsWith('run.')), 'run events reach the journal');
    const job = engine.cronJobs()[0];
    assert.equal((await engine.request('flowRuns', job.id)).ok, true);
    assert.ok(engine.cronRuns(job.id).runs.length > 0);
    const s = engine.sessions().find((x) => x.class.kind === 'conversation-direct');
    assert.equal((await engine.request('transcript', s.key)).ok, true);
    assert.ok(engine.transcript(s.key).events.length >= 2);
    assert.equal(rt.definition.capabilities().flows.write, false);
  });

  it('every value is canonical: no data-quality issue at all over 200 ticks; generic names only', () => {
    const { engine } = run(3, 200);
    assert.deepEqual(engine.dataQuality().issues, []);
    const text = JSON.stringify([engine.sessions(), engine.agents(), engine.cronJobs()]);
    for (const t of TOKENS) assert.ok(!text.includes(t), t);
  });

  it('French and English texts', () => {
    const fr = run(1, 0, 'fr-CA').engine, en = run(1, 0, 'en').engine;
    assert.match(fr.cronJobs()[0].name, /quotidien/); assert.match(en.cronJobs()[0].name, /Daily/);
  });

  it('no network: no socket is ever opened', () => {
    const connect = net.Socket.prototype.connect;
    let opened = 0;
    net.Socket.prototype.connect = function (...a) { opened++; return connect.apply(this, a); };
    try { run(5, 50); } finally { net.Socket.prototype.connect = connect; }
    assert.equal(opened, 0);
  });
});

describe('G6 · the server on the demo runtime (AO_RUNTIME=demo)', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic'), { env: { AO_RUNTIME: 'demo', AO_LOCALE: 'en' } }); });
  after(async () => { if (h) await h.stop(); });

  it('meta names the demo runtime and is read-only; the views are full and valid (the runtime check throws in test)', async () => {
    const ownerCookie = h.cookie;
    h.cookie = '';
    const anonymous = (await h.get('/api/v3/meta')).json.data;
    assert.equal(anonymous.runtime, null, 'public bootstrap does not disclose runtime metadata');
    assert.equal(anonymous.primaryAgent, null, 'public bootstrap does not disclose the primary agent');
    h.cookie = ownerCookie;
    const meta = (await h.get('/api/v3/meta')).json.data;
    assert.deepEqual([meta.runtime.id, meta.runtime.name, meta.readonly, meta.capabilities.openclawWrites, meta.primaryAgent.name], ['demo', 'Demo', true, false, 'Nova']);
    for (const v of ['v2', 'v3']) for (const p of ['office', 'logs', 'flows', 'access', 'health', 'skills']) assert.equal((await h.get(`/api/${v}/views/${p}`)).status, 200, `${v} ${p}`);
    const office = (await h.get('/api/v3/views/office')).json.data;
    assert.equal(office.occupants[0].name, 'Nova');
    const access = (await h.get('/api/v3/views/access')).json.data;
    assert.ok(access.interlocutors.some((i) => i.id === 'telegram-user:alice' && i.resolution === 'unresolvable'));
    const flows = (await h.get('/api/v3/views/flows')).json.data;
    assert.match(flows.flows[0].name, /Daily digest/);
    assert.equal((await h.get('/api/v3/views/flows/' + flows.flows[0].id)).status, 200);
    const s = (await h.get('/api/v3/views/logs')).json.data.items.find((x) => x.kind === 'conversation-direct');
    assert.ok((await h.get('/api/v3/views/sessions/' + encodeURIComponent(s.id))).json.data.events.length >= 2);
    assert.equal((await h.get('/api/v3/views/skills/summarise')).status, 200);
  });

  it('runtime writes don\'t exist (capability false → 404, R22-05; meta stays readonly); no CLI and no v1 exist', async () => {
    for (const [m, p, b] of [['POST', '/api/v3/flows', { name: 'x', cron: '0 9 * * *', tz: 'UTC', message: 'x' }], ['POST', '/api/v3/chat/messages', { text: 'hi' }],
      ['PUT', '/api/v3/skills/notes/enabled', { enabled: false }], ['POST', '/api/v3/gateway/restart', { confirm: 'redemarrer' }]]) {
      const r = await h.request(m, p, b);
      assert.equal(r.status, 404, p); assert.equal(r.json.error.code, 'not_found', p);
    }
    assert.deepEqual(h.cliCalls(), []);
    assert.equal((await h.get('/api/summary')).status, 404, 'v1 needs OpenClaw: never mounted with demo');
  });
});

describe('G6 · selected by the instance config, and by setup', () => {
  it('runtime: { adapter: "demo" } in the config file selects it', async () => {
    // no AO_RUNTIME in the env: only the file can choose the demo runtime (`demo: true` is the harness's readiness check)
    const h = await startServer(loadScenario('synthetic-basic'), { demo: true, prepare: async (tmp) => {
      const dir = path.join(tmp, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, instance: { name: 'Try-out', locale: 'fr', timeZone: 'UTC' },
        owner: { displayName: 'Camille', email: 'camille@example.invalid' }, runtime: { adapter: 'demo', demo: { seed: 9 } }, agents: { primary: null, looks: {} } }), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: await hashPassword('x'.repeat(12)), runtimeToken: null }), { mode: 0o600 });
    } });
    try {
      // the env (harness login) wins for the login; the file supplies the runtime choice and its seed
      assert.equal((await h.get('/api/v3/meta')).json.data.runtime.id, 'demo');
      assert.ok((await h.get('/api/v3/views/flows')).json.data.flows.some((f) => f.name === 'Résumé quotidien'), 'the file\'s locale (fr) and team');
      assert.deepEqual(h.cliCalls(), [], 'no OpenClaw CLI was ever run');
    } finally { await h.stop(); }
  });

  it('setup: a fresh install can choose demo (no connection fields), and boots on it', async () => {
    const h = await startServer(loadScenario('synthetic-basic'), { setupMode: true });
    try {
      const code = h.setupCode();
      const vm = (await h.get('/api/v2/setup')).json.data;
      assert.deepEqual(vm.adapters.find((a) => a.id === 'demo'), { id: 'demo', name: 'Démo', connect: true, fields: [], defaultGatewayUrl: null });
      const post = (p, b, m = 'POST') => fetch(h.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ setupCode: code }, b)) }).then(async (r) => ({ status: r.status, json: await r.json() }));
      assert.equal((await post('/api/v2/setup/check', { runtime: { adapter: 'demo' } })).json.data.result.status, 'connected');
      assert.deepEqual((await post('/api/v2/setup/discover', { runtime: { adapter: 'demo' } })).json.data.result.agents.map((a) => a.id), ['nova', 'sage', 'pixel']);
      const saved = await post('/api/v2/setup', { instance: { name: 'Try-out', locale: 'en', timeZone: 'UTC' }, owner: { displayName: 'Camille', email: TEST_EMAIL, password: TEST_PASSWORD },
        runtime: { adapter: 'demo' }, agents: { primary: 'nova' } }, 'PUT');
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      await h.waitReady();
      assert.equal((await h.get('/api/v3/meta')).json.data.runtime.id, 'demo');
    } finally { await h.stop(); }
  });
});
