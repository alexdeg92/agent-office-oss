'use strict';
// Review R15 (architect findings), each written to fail before its fix. R15-01 (CSRF) is test/api/csrf.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { bind: bindCommands } = require('../../src/adapters/openclaw/commands');
const { main: tokenCli } = require('../../scripts/agent-token');

const sc = loadScenario('synthetic-basic');
const JOB = 'ffffffff-0c01-4000-8000-000000000001';
const UI = { 'content-type': 'application/json', 'x-ao-request': '1' };
const quiet = (fn) => { const w = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = w; } };

describe('R15-02 · a read-only binding refuses every write, RPC included', () => {
  it('restartGateway on a read-only binding: no RPC, no service call', async () => {
    let rpc = 0, svc = 0;
    const gw = { call: async () => { rpc++; return {}; } };
    const cli = { run: async () => ({ ok: false, refused: 'readonly', out: '', err: '' }), parseJson: () => null };
    const c = bindCommands(cli, { gw, restartService: async () => { svc++; return { ok: true }; }, readonly: true });
    assert.deepEqual(await c.restartGateway(), { failed: 'readonly' });
    for (const [fn, args] of [['flowCreate', [{ name: 'a', cron: '0 9 * * 1', tz: 'UTC', message: 'm', agentId: 'main' }]], ['flowEdit', [JOB, { name: 'b' }]], ['flowSetEnabled', [JOB, true]],
      ['flowRun', [JOB]], ['flowDelete', [JOB]], ['skillSetEnabled', ['weather', true]], ['agentTurn', [{ agentId: 'main', text: 'x' }]]]) {
      const r = await c[fn](...args); assert.ok(r.failed, fn);
    }
    assert.deepEqual([rpc, svc], [0, 0]);
  });
});

describe('R15-08 · a negative JSON acknowledgement is a failure', () => {
  const run = (out, ok = true) => bindCommands({ run: async () => ({ ok, code: ok ? 0 : 1, out, err: '' }), parseJson: (o) => { const i = String(o).indexOf('{'); try { return i < 0 ? null : JSON.parse(o.slice(i)); } catch (_) { return null; } } });
  it('flowCreate: {ok:false} → failed; malformed → failed; {ok:true,id} → the id', async () => {
    assert.deepEqual(await run('{"ok":false,"error":"synthetic refusal"}').flowCreate({ name: 'a', cron: '0 9 * * 1', tz: 'UTC', message: 'm', agentId: 'main' }), { failed: 'not-ok' });
    assert.deepEqual(await run('pas de json').flowCreate({ name: 'a', cron: '0 9 * * 1', tz: 'UTC', message: 'm', agentId: 'main' }), { failed: 'invalid-output' });
    assert.deepEqual(await run('{"ok":true,"id":"job-9"}').flowCreate({ name: 'a', cron: '0 9 * * 1', tz: 'UTC', message: 'm', agentId: 'main' }), { ok: true, jobId: 'job-9' });
    assert.deepEqual(await run('{"ok":false}').flowDelete(JOB), { failed: 'not-ok' });
  });
});

describe('R15-03 / R15-14 · chat over the real stream', () => {
  it('a successful reply survives a failed transcript read; pending → reply over SSE; a held turn makes a second message 409', async () => {
    const h = await startServer(sc, { env: { FAKE_OC_AGENT_DELAY_MS: '600' }, handlers: { 'sessions.get': () => { throw new Error('unavailable'); } } });
    try {
      const A = openSse(h.base, '/api/v2/stream?topics=chat', { cookie: h.cookie });
      try {
        await A.next((f) => f.event === 'snapshot' && f.data.topic === 'chat');
        const r = await h.request('POST', '/api/v2/chat/messages', { text: 'Bonjour' });
        assert.equal(r.status, 202);
        const dup = await h.request('POST', '/api/v2/chat/messages', { text: 'Encore' });
        assert.equal(dup.status, 409, 'the turn is held for 600 ms: a second message is ALWAYS refused'); assert.deepEqual(dup.json.error.details, [{ issue: 'turn-pending' }]);
        const vmOf = async () => (await h.get('/api/v2/views/chat')).json.data;
        const done = await waitFor(async () => { const v = await vmOf(); return v.turnPending === null && v; }, { what: 'the turn to finish' });
        assert.deepEqual(done.messages.map((m) => [m.role, m.text]), [['user', 'Bonjour'], ['assistant', 'Réponse factice.']], 'kept although the transcript read failed');
        await waitFor(() => A.frames.some((f) => f.data && f.data.topic === 'chat' && JSON.stringify(f.data).includes('Réponse factice.')), { what: 'the reply over SSE' });
      } finally { A.close(); }
    } finally { await h.stop(); }
  });
});

describe('R15-05 / R15-06 / R15-14 · agent token', () => {
  let h, token;
  const call = (method, p, body, raw) => fetch(h.base + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const rows = () => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true }); try { return db.prepare('SELECT command, outcome, detail, actor_json FROM audit_log ORDER BY id').all().map((r) => ({ ...r })); } finally { db.close(); } };
  const mint = (agent) => { const f = path.join(h.tmp, 'tok-' + agent + '-' + Date.now()); quiet(() => tokenCli(['create', '--agent', agent, '--out', f], { AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), HOME: h.tmp })); return fs.readFileSync(f, 'utf8').trim(); };
  before(async () => { h = await startServer(sc); token = mint('main'); });
  after(async () => { if (h) await h.stop(); });

  it('R15-14: a valid appendHistory is persisted as the agent (not merely "not refused by the gate")', async () => {
    const p = (await h.request('POST', '/api/v2/projects', { name: 'Essai' })).json.data.vm;
    const r = await call('POST', `/api/v2/projects/${p.id}/history`, { expectedRevision: p.revision, kind: 'agent-action', action: 'commented', subjectPersonId: null, note: 'Vérifié' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ev = (await h.get(`/api/v2/views/projects/${p.id}`)).json.data.recentHistory.find((e) => e.kind === 'agent-action');
    assert.ok(ev); assert.equal(ev.actor.name, 'Timmy');
  });

  it('R15-05: malformed JSON is rate-counted and audited like any other attempt', async () => {
    token = mint('main');
    const before = rows().length;
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await call('PUT', '/api/v2/projects/x/status', null, '{bad')).status);
    assert.equal(statuses[30], 429, 'the 31st attempt is throttled, malformed or not');
    assert.ok(statuses.slice(0, 30).every((s) => s === 400));
    assert.ok(rows().length - before >= 31, 'every attempt audited');
    assert.ok(!JSON.stringify(rows()).includes('{bad'));
  });

  it('R15-06: a token of another agent never writes as the primary agent: refused (until G3a)', async () => {
    const helper = mint('scout');
    const p = (await h.request('POST', '/api/v2/projects', { name: 'Autre' })).json.data.vm;
    const r = await fetch(h.base + `/api/v2/projects/${p.id}`, { method: 'PATCH', headers: { authorization: 'Bearer ' + helper, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: p.revision, summary: 'x' }) });
    assert.equal(r.status, 403);
    assert.equal((await h.get(`/api/v2/views/projects/${p.id}`)).json.data.summary, '');
  });
});

describe('R15-07 · a failed rotation keeps the working token', () => {
  it('rename onto a directory fails: the old token still works, no new live token, no temp file left', async () => {
    const h = await startServer(sc);
    try {
      const env = { AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), HOME: h.tmp };
      const file = path.join(h.tmp, 'agent.token');
      quiet(() => tokenCli(['create', '--agent', 'main', '--out', file], env));
      const old = fs.readFileSync(file, 'utf8').trim();
      const dir = path.join(h.tmp, 'a-directory'); fs.mkdirSync(dir);
      const exits = []; const exit = process.exit; process.exit = (c) => { exits.push(c); throw new Error('exit ' + c); };
      const err = process.stderr.write; process.stderr.write = () => true;
      try { assert.throws(() => tokenCli(['rotate', '--agent', 'main', '--out', dir], env)); } finally { process.exit = exit; process.stderr.write = err; }
      const ok = await fetch(h.base + '/api/v2/projects/x/status', { method: 'PUT', headers: { authorization: 'Bearer ' + old, 'content-type': 'application/json' }, body: '{"expectedRevision":1,"status":"todo"}' });
      assert.notEqual(ok.status, 401, 'the old token still authenticates');
      const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true });
      const live = db.prepare('SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL').get().n; db.close();
      assert.equal(live, 1, 'no orphan live token');
      assert.deepEqual(fs.readdirSync(h.tmp).filter((f) => f.endsWith('.tmp')), []);
    } finally { await h.stop(); }
  });
});

describe('R15-12 · legacy writes: ids validated, never option-like; no dotted skill paths', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  // since S16 on the v2/v3 commands: an option-like id is not a known job or skill, so it is refused before the CLI
  it('--help as an id → refused and no CLI call; a dotted skill name → refused; a valid id runs with `--`', async () => {
    const n = () => h.cliCalls().length;
    const c0 = n();
    for (const [m, p, body] of [['POST', '/api/v2/flows/--help/runs', '{}'], ['DELETE', '/api/v2/flows/-rf', undefined], ['PATCH', '/api/v3/flows/--all', '{"name":"x"}'],
      ['PUT', '/api/v2/skills/a.b/enabled', '{"enabled":true}'], ['PUT', '/api/v3/skills/--help/enabled', '{"enabled":true}']]) {
      const r = await fetch(h.base + p, { method: m, headers: Object.assign({ cookie: h.cookie }, UI), body });
      assert.ok([400, 404].includes(r.status), m + ' ' + p + ' → ' + r.status);
    }
    assert.equal(n(), c0, 'nothing reached the CLI');
    assert.equal((await fetch(h.base + `/api/v2/flows/${JOB}/runs`, { method: 'POST', headers: Object.assign({ cookie: h.cookie }, UI), body: '{}' })).status, 200);
    assert.deepEqual(h.cliCalls().pop(), ['cron', 'run', '--', JOB]);
  });
});
