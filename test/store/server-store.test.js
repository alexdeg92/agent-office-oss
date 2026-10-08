'use strict';
// S5 acceptance (migration plan): quarantine counts survive a restart; Discord names appear right after a
// restart without a refetch; every write is audited; staging can't open production's data. (v2 routes since S16.)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openStore } = require('../../src/store');

const ROOT = path.resolve(__dirname, '..', '..');
const SF = '100000000000000001';
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-srv-store-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const readDb = (d, sql) => { const db = new DatabaseSync(path.join(d, 'agent-office.sqlite'), { readOnly: true, timeout: 5000 }); try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); } };

const issues = async (h) => (await h.get('/api/v2/views/health')).json.data.dataQuality.issues;
const profile = async (h) => (await h.get('/api/v2/views/interlocutors/' + encodeURIComponent('discord-user:' + SF))).json.data.profile;
const JSON_UI = { 'content-type': 'application/json', 'x-ao-request': '1' };
const firstJob = async (h) => (await h.get('/api/v2/views/flows')).json.data.flows.find((f) => f.enabled !== false && !f.running).id;

describe('store · server restart', () => {
  it('quarantine issues (count, first seen) and cached Discord names survive a restart', async () => {
    const data = path.join(dir, 'restart');
    // a cached Discord profile, as a previous run would have left it
    const st = openStore({ dir: data, instance: 'test', ownerName: 'test', log: () => {} });
    st.caches.interlocutors.put('discord-user:' + SF, { id: SF, username: 'bobette', globalName: 'Bobette', display: 'Bobette', bot: false, flags: 0, avatar: null, createdMs: 1 }, Date.now());
    st.close();

    const sc = loadScenario('synthetic-basic');
    let h = await startServer(sc, { env: { AO_DATA_DIR: data }, handlers: { 'channels.status': () => { throw new Error('boom'); } } });
    let before;
    try {
      await waitFor(async () => (await issues(h)).some((i) => i.code === 'rpc.failed'), { what: 'rpc.failed' });
      before = (await issues(h)).find((i) => i.code === 'rpc.failed');
      assert.equal((await profile(h)).displayName, 'Bobette');
    } finally { await h.stop(); }
    assert.equal(readDb(data, "SELECT count(*) AS n FROM quarantine WHERE code = 'rpc.failed'")[0].n, 1, 'flushed on SIGTERM');

    h = await startServer(sc, { env: { AO_DATA_DIR: data } });
    try {
      const after = (await issues(h)).find((i) => i.id === before.id);
      assert.ok(after, 'restored');
      assert.ok(after.count >= before.count); assert.equal(after.firstSeenAt, before.firstSeenAt);
      assert.equal((await profile(h)).displayName, 'Bobette', 'name served from the store right after the restart');
    } finally { await h.stop(); }
  });
});

describe('store · audit of the write routes', () => {
  it('records command, target and outcome; never bodies; refused (read-only) and anonymous attempts too (R8-07)', async () => {
    const data = path.join(dir, 'audit');
    const sc = loadScenario('synthetic-basic');
    let h = await startServer(sc, { env: { AO_DATA_DIR: data } });
    try {
      const id = await firstJob(h);
      assert.equal((await h.post(`/api/v2/flows/${encodeURIComponent(id)}/runs`)).status, 200);
      assert.equal((await h.post('/api/v2/flows', { name: 'Rapport secret', cron: '0 9 * * 1', tz: 'UTC', message: 'PORTAL_PASSWORD=rosebud' })).status, 200);
      assert.equal((await h.post('/api/v2/flows', { name: 'Rapport secret', cron: 'not a cron', tz: 'UTC', message: 'PORTAL_PASSWORD=rosebud' })).status, 400);
      await fetch(h.base + `/api/v2/flows/${encodeURIComponent(id)}/enabled`, { method: 'PUT', headers: JSON_UI, body: '{"enabled":false}' });          // no cookie → 401, audited as anonymous
    } finally { await h.stop(); }
    h = await startServer(sc, { env: { AO_DATA_DIR: data }, readonly: true });
    try { await h.post('/api/v2/gateway/restart'); await h.request('PUT', '/api/v2/skills/weather/enabled', { enabled: false }); } finally { await h.stop(); }

    const rows = readDb(data, 'SELECT command, target, outcome, detail, actor_json FROM audit_log WHERE command != \'auth.login\' ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.command, r.outcome, r.detail]), [
      ['flows.run', 'ok', null], ['flows.create', 'ok', null], ['flows.create', 'rejected', 'http-400'], ['flows.setEnabled', 'rejected', 'unauthorized'],
      ['gateway.restart', 'rejected', 'readonly'], ['skills.setEnabled', 'rejected', 'readonly'],
    ]);
    assert.equal(rows[0].target.length > 0, true); assert.equal(rows[4].target, null); assert.equal(rows[5].target, 'weather');
    const owner = readDb(data, 'SELECT id FROM persons WHERE is_owner = 1')[0].id;
    assert.deepEqual(rows.map((r) => JSON.parse(r.actor_json).personId || JSON.parse(r.actor_json).kind),
      [owner, owner, owner, 'anonymous', owner, owner], 'only a verified session is attributed to the owner');
    const all = JSON.stringify(readDb(data, 'SELECT * FROM audit_log'));
    for (const needle of ['rosebud', 'Rapport secret', 'PORTAL_PASSWORD']) assert.ok(!all.includes(needle), needle);
  });
});

describe('store · instance guards at boot', () => {
  const baseEnv = (extra) => Object.assign({ PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), OC_GATEWAY_TOKEN: 't', PORTAL_EMAIL: 'a@b.c', PORTAL_PASSWORD: 'p',
    PORTAL_SECRET: 's', PORT: '0', OC_GATEWAY_URL: 'ws://127.0.0.1:9', OC_STATE_DB: path.join(dir, 'none.sqlite'), OC_IDENTITY: path.join(dir, 'none.json') }, extra);
  const boot = (env) => spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { env: baseEnv(env), encoding: 'utf8', timeout: 10000 });

  it('a staging (read-only) instance refuses production\'s default data dir', () => {
    const r = boot({ PORTAL_READONLY: '1', AO_DATA_DIR: path.join(dir, 'home', '.local', 'share', 'agent-office') });
    assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to start: the staging instance would use production's data dir/);
  });
  it('a read-only instance cannot claim to be production', () => {
    const r = boot({ PORTAL_READONLY: '1', AO_ENV: 'production', AO_DATA_DIR: path.join(dir, 'x') });
    assert.equal(r.status, 1); assert.match(r.stderr, /PORTAL_READONLY=1 with AO_ENV=production/);
  });
  it('a data dir created by another instance is refused', () => {
    const data = path.join(dir, 'prod-like');
    openStore({ dir: data, instance: 'production', ownerName: 'x', log: () => {} }).close();
    const r = boot({ AO_ENV: 'staging', AO_DATA_DIR: data });
    assert.equal(r.status, 1); assert.match(r.stderr, /store unavailable \(instance-mismatch\)/);
  });
  it('staging defaults to its own directory (agent-office-staging)', () => {
    const { loadConfig } = require('../../src/config');
    const cfg = loadConfig(baseEnv({ PORTAL_READONLY: '1', NODE_ENV: 'production' }));
    assert.equal(cfg.instance, 'staging'); assert.equal(cfg.dataDir, path.join(dir, 'home', '.local', 'share', 'agent-office-staging'));
    const prod = loadConfig(baseEnv({ NODE_ENV: 'production' }));
    assert.equal(prod.instance, 'production'); assert.equal(prod.dataDir, path.join(dir, 'home', '.local', 'share', 'agent-office'));
  });
});

describe('store · audit identity and route variants (R8-06, R8-07)', () => {
  const { createAuth } = require('../../src/auth');
  const expiredCookie = (h) => 'taco_sess=' + createAuth({ secret: h.secret, ttlMs: 1, email: 'x', password: 'y' }).signSession({ email: 'test@example.invalid', exp: loadScenario('synthetic-basic').now - 1000,   // the server's clock is frozen at the scenario time
    sid: '0123456789abcdef0123456789abcdef' });
  const rowsOf = (data) => readDb(data, 'SELECT command, target, outcome, detail, actor_json FROM audit_log WHERE command != \'auth.login\' ORDER BY id').map((r) => Object.assign(r, { actor: JSON.parse(r.actor_json).kind }));

  it('writable: every accepted variant of a write route is audited; anonymous and expired-cookie attempts are anonymous', async () => {
    const data = path.join(dir, 'variants');
    const h = await startServer(loadScenario('synthetic-basic'), { env: { AO_DATA_DIR: data } });
    let runs;
    try {
      const id = encodeURIComponent(await firstJob(h));
      for (const p of [`/api/v2/flows/${id}/runs`, `/api/v2/flows/${id}/runs/`, `/API/V2/FLOWS/${id}/RUNS`.replace('RUNS', 'runs'), `/api/v3/flows/${id}/runs`]) assert.equal((await h.post(p)).status, 200, p);
      runs = h.cliCalls().filter((a) => a[0] === 'cron' && a[1] === 'run').length;
      await fetch(h.base + `/api/v2/flows/${id}/runs`, { method: 'POST', headers: JSON_UI });
      await fetch(h.base + `/api/v2/flows/${id}/runs`, { method: 'POST', headers: Object.assign({ cookie: expiredCookie(h) }, JSON_UI) });
    } finally { await h.stop(); }
    const rows = rowsOf(data);
    assert.equal(runs, 4);
    assert.deepEqual(rows.map((r) => [r.command, r.outcome, r.detail, r.actor]), [
      ['flows.run', 'ok', null, 'human'], ['flows.run', 'ok', null, 'human'], ['flows.run', 'ok', null, 'human'], ['flows.run', 'ok', null, 'human'],
      ['flows.run', 'rejected', 'unauthorized', 'anonymous'], ['flows.run', 'rejected', 'unauthorized', 'anonymous'],
    ], 'one row per executed write, whatever the spelling');
  });

  it('read-only: an anonymous refused attempt is recorded as anonymous, never attributed to the owner', async () => {
    const data = path.join(dir, 'ro-anon');
    const h = await startServer(loadScenario('synthetic-basic'), { env: { AO_DATA_DIR: data }, readonly: true });
    try {
      assert.equal((await fetch(h.base + '/api/v2/gateway/restart', { method: 'POST', headers: JSON_UI })).status, 403);
      assert.equal((await fetch(h.base + '/API/V2/Gateway/Restart/', { method: 'POST', headers: Object.assign({ cookie: expiredCookie(h) }, JSON_UI) })).status, 403);
      assert.equal((await h.post('/api/v2/gateway/restart')).status, 403);
    } finally { await h.stop(); }
    assert.deepEqual(rowsOf(data).map((r) => [r.command, r.detail, r.actor]),
      [['gateway.restart', 'readonly', 'anonymous'], ['gateway.restart', 'readonly', 'anonymous'], ['gateway.restart', 'readonly', 'human']]);
  });
});
