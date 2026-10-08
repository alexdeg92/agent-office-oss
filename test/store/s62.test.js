'use strict';
// S6.2 (review R8): store isolation, flush retry, backup ordering, path round trips.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS_DIR, DB_FILE } = require('../../src/store/db');
const { openStore } = require('../../src/store');
const { createEngine } = require('../../src/engine');
const { loadConfig } = require('../../src/config');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-s62-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const sub = (n) => path.join(dir, n);
// every file of a data dir: name → sha256 + mode (byte-for-byte and permission identity)
const snapshot = (d) => Object.fromEntries(fs.readdirSync(d, { recursive: true }).sort().filter((f) => fs.statSync(path.join(d, f)).isFile())
  .map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(d, f))).digest('hex') + ':' + (fs.statSync(path.join(d, f)).mode & 0o777).toString(8)]));
const quiet = { log: () => {} };

describe('R8-01 · instance and path identity are checked before any mutation', () => {
  it('another instance\'s store is refused and left byte-for-byte unchanged, even with a pending migration', () => {
    const mig = sub('migrations'); fs.mkdirSync(mig);
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
    openDatabase({ dir: sub('data'), instance: 'production', migrationsDir: mig }).close();
    fs.chmodSync(path.join(sub('data'), DB_FILE), 0o644);                 // a mode the open would "fix"
    fs.writeFileSync(path.join(mig, '099_extra.sql'), 'CREATE TABLE extra (x INTEGER);');
    const before = snapshot(sub('data'));
    assert.throws(() => openDatabase({ dir: sub('data'), instance: 'staging', migrationsDir: mig }), (e) => e.code === 'instance-mismatch');
    assert.deepEqual(snapshot(sub('data')), before, 'no migration, backup, chmod or WAL');
    const db = new DatabaseSync(path.join(sub('data'), DB_FILE), { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'extra'").get().n, 0);
    db.close();
  });

  it('a schema newer than the build is refused unchanged', () => {
    openDatabase({ dir: sub('data'), instance: 'test' }).close();
    const db = new DatabaseSync(path.join(sub('data'), DB_FILE)); db.prepare('INSERT INTO schema_migrations VALUES (999, ?, 1)').run('future'); db.close();
    const before = snapshot(sub('data'));
    assert.throws(() => openDatabase({ dir: sub('data'), instance: 'test' }), (e) => e.code === 'schema-too-new');
    assert.deepEqual(snapshot(sub('data')), before);
  });

  it('a symlink alias of production\'s default directory is refused for staging (existing or not)', () => {
    const home = sub('home');
    const prod = path.join(home, '.local', 'share', 'agent-office');
    fs.mkdirSync(path.dirname(prod), { recursive: true });
    const alias = sub('alias');
    fs.symlinkSync(prod, alias);                                       // dangling: production's dir doesn't exist yet
    const env = { OC_GATEWAY_TOKEN: 't', PORTAL_EMAIL: 'a@b.c', PORTAL_PASSWORD: 'p', PORTAL_SECRET: 's', HOME: home, PORTAL_READONLY: '1', AO_DATA_DIR: alias };
    const exit = process.exit, error = console.error;
    let code = null;
    process.exit = (c) => { code = c; throw new Error('exit'); }; console.error = () => {};
    try { assert.throws(() => loadConfig(env), /exit/); } finally { process.exit = exit; console.error = error; }
    assert.equal(code, 1);
    assert.equal(fs.existsSync(prod), false, 'nothing created at production\'s location');
  });
});

describe('R8-04 · a failed quarantine flush is retried, never lost', () => {
  const issue = { channel: 'gw.rpc.cron.list', code: 'shape.invalid', severity: 'warn', path: '$.jobs[].schedule' };
  it('upserts and deletes survive a failed commit, then land on the next flush and across a restart', () => {
    let t = Date.UTC(2026, 9, 5);
    const st = openStore({ dir: sub('data'), instance: 'test', ownerName: 'a', now: () => t, ...quiet });
    const e = createEngine({ now: () => t }); st.bindEngine(e);
    e.quarantine.record(issue);
    st.db.exec("CREATE TRIGGER no_q BEFORE INSERT ON quarantine BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => st.flushQuarantine(), /injected/);
    st.db.exec('DROP TRIGGER no_q');
    assert.equal(st.flushQuarantine(), 1, 'the failed batch is retried');
    assert.equal(st.db.prepare('SELECT count(*) AS n FROM quarantine').get().n, 1);
    // a failed delete is retried too
    for (let i = 0; i < 10; i++) e.quarantine.markClean(issue.channel);
    st.flushQuarantine();
    t += 31 * 86400000;
    e.quarantine.prune(t - 30 * 86400000);
    st.db.exec("CREATE TRIGGER no_d BEFORE DELETE ON quarantine BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => st.flushQuarantine(), /injected/);
    st.db.exec('DROP TRIGGER no_d');
    st.flushQuarantine();
    st.close();
    const st2 = openStore({ dir: sub('data'), instance: 'test', ownerName: 'a', ...quiet });
    assert.equal(st2.db.prepare('SELECT count(*) AS n FROM quarantine').get().n, 0, 'the pruned issue is gone after the retry');
    st2.close();
  });
});

describe('R8-05 · a failed backup keeps the previous one', () => {
  it('today\'s backup and the retention inventory survive a failing VACUUM', () => {
    const h = openDatabase({ dir: sub('data'), instance: 'test', now: () => Date.UTC(2026, 9, 5, 12) });
    const first = h.backup('daily');
    const before = snapshot(path.join(sub('data'), 'backups'));
    h.db.exec('BEGIN');                                                  // VACUUM INTO fails inside a transaction
    assert.throws(() => h.backup('daily'));
    h.db.exec('ROLLBACK');
    assert.ok(fs.existsSync(first));
    assert.deepEqual(snapshot(path.join(sub('data'), 'backups')), before, 'no temp file left, nothing deleted');
    h.close();
  });
});

describe('R8-14 · normalised paths round-trip through a real restart', () => {
  it('record, array and undeclared paths keep their form and fingerprint', () => {
    const st = openStore({ dir: sub('data'), instance: 'test', ownerName: 'a', ...quiet });
    const e = createEngine({ now: () => Date.UTC(2026, 9, 5) }); st.bindEngine(e);
    e.ingest({ source: 'gateway', channel: 'gw.rpc.channels.status', receivedAt: 1, body: { kind: 'json', value: { channels: { discord: { configured: 'no' } } } } });
    e.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: 1, body: { kind: 'json', value: { agents: [{ id: 'main', 'Two Words': 1 }] } } });
    const before = e.quarantine.list();
    assert.ok(before.some((i) => i.path === '$.channels.{}.configured') && before.some((i) => i.path === '$.agents[].<undeclared>'));
    st.close();
    const st2 = openStore({ dir: sub('data'), instance: 'test', ownerName: 'a', ...quiet });
    const e2 = createEngine({ now: () => Date.UTC(2026, 9, 5) }); st2.bindEngine(e2);
    assert.deepEqual(e2.quarantine.list(), before);
    st2.close();
  });
});
