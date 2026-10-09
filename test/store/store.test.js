'use strict';
// S5: the store (storage.md). Database, migrations, guards, backups, repositories, engine binding.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, withTx, MIGRATIONS_DIR, DB_FILE } = require('../../src/store/db');
const { openStore, msUntilNextHour } = require('../../src/store');
const { createQuarantine } = require('../../src/engine/quarantine');
const { createEngine } = require('../../src/engine');
const { createDiscord } = require('../../src/enrichers/discord');

const NOW = Date.UTC(2026, 9, 5, 12);
const mode = (p) => fs.statSync(p).mode & 0o777;
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const sub = (n = 'data') => path.join(dir, n);

describe('store · database', () => {
  it('creates the data dir 0700 and the files 0600, applies 001 once, records it', () => {
    const h = openDatabase({ dir: sub(), instance: 'test', now: () => NOW });
    assert.deepEqual(h.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    h.db.exec("INSERT INTO ui_prefs (key, value_json, updated_at) VALUES ('uiTheme', '\"auto\"', 1)");   // forces the WAL
    assert.equal(mode(sub()), 0o700);
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) if (fs.existsSync(path.join(sub(), f))) assert.equal(mode(path.join(sub(), f)), 0o600, f);
    assert.equal(h.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(h.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    h.close();
    const again = openDatabase({ dir: sub(), instance: 'test' });
    assert.deepEqual(again.applied, []);
    assert.deepEqual(again.db.prepare('SELECT version, name FROM schema_migrations').all().map((r) => ({ ...r })), [{ version: 1, name: 'init' }, { version: 2, name: 'projects' }, { version: 3, name: 'sessions' }, { version: 4, name: 'api_tokens' }, { version: 5, name: 'office' }, { version: 6, name: 'locale_pref' }, { version: 7, name: 'open_identities' }, { version: 8, name: 'seen_canonical' }, { version: 9, name: 'seen_id_limit' }, { version: 10, name: 'priority_p9' }, { version: 11, name: 'project_tag_slugs' }, { version: 12, name: 'project_comments' }, { version: 13, name: 'sender_captures' }, { version: 14, name: 'users' }, { version: 15, name: 'setup_owner' }]);
    again.close();
  });

  it('migrations 001–015 hold the store tables (layouts come with their contract, S14b)', () => {
    const h = openDatabase({ dir: sub(), instance: 'test' });
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables, ['api_token_salt', 'api_tokens', 'audit_log', 'history_events', 'interlocutor_cache', 'office_agents_seen', 'office_layout_revisions', 'office_layouts', 'person_identities', 'persons', 'project_comments', 'project_flags', 'project_people', 'project_sources', 'project_tag_slugs', 'projects',
      'quarantine', 'repo_cache', 'revoked_sessions', 'schema_migrations', 'sender_captures', 'store_meta', 'ui_prefs', 'users', 'workspace_snapshots']);
    h.close();
  });

  it('refuses a schema newer than the build', () => {
    openDatabase({ dir: sub(), instance: 'test' }).close();
    const db = new DatabaseSync(path.join(sub(), DB_FILE)); db.prepare('INSERT INTO schema_migrations VALUES (99, ?, 1)').run('future'); db.close();
    assert.throws(() => openDatabase({ dir: sub(), instance: 'test' }), (e) => e.code === 'schema-too-new');
  });

  it('refuses a data dir created by another instance (staging can never open prod data)', () => {
    openDatabase({ dir: sub(), instance: 'production' }).close();
    assert.throws(() => openDatabase({ dir: sub(), instance: 'staging' }), (e) => e.code === 'instance-mismatch');
    openDatabase({ dir: sub(), instance: 'production' }).close();
  });

  it('takes a pre-migration backup when an existing database has a pending migration', () => {
    const mig = sub('migrations'); fs.mkdirSync(mig);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(mig, '001_init.sql'));
    openDatabase({ dir: sub(), instance: 'test', migrationsDir: mig }).close();
    fs.writeFileSync(path.join(mig, '002_extra.sql'), 'CREATE TABLE extra (x INTEGER);');
    const h = openDatabase({ dir: sub(), instance: 'test', migrationsDir: mig, now: () => NOW });
    assert.deepEqual(h.applied, [2]);
    const backups = fs.readdirSync(path.join(sub(), 'backups'));
    assert.equal(backups.length, 1); assert.match(backups[0], /^agent-office-premigrate-v001-\d+\.sqlite$/);
    assert.equal(mode(path.join(sub(), 'backups', backups[0])), 0o600);
    const b = new DatabaseSync(path.join(sub(), 'backups', backups[0]), { readOnly: true });
    assert.equal(b.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 1, 'backup is the pre-migration state');
    b.close(); h.close();
  });

  it('a failed migration rolls back and is not recorded', () => {
    const mig = sub('migrations'); fs.mkdirSync(mig);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(mig, '001_init.sql'));
    fs.writeFileSync(path.join(mig, '002_bad.sql'), 'CREATE TABLE half (x INTEGER); INSERT INTO nope VALUES (1);');
    assert.throws(() => openDatabase({ dir: sub(), instance: 'test', migrationsDir: mig }));
    const db = new DatabaseSync(path.join(sub(), DB_FILE));
    assert.equal(db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'").get().n, 0);
    db.close();
  });

  it('daily backups: VACUUM INTO, one per day, the last 7 kept', () => {
    let t = NOW;
    const h = openDatabase({ dir: sub(), instance: 'test', now: () => t });
    for (let d = 0; d < 9; d++) { h.backup('daily'); t += 86400000; }
    h.backup('daily'); h.backup('daily');                                 // same day twice → replaced, not duplicated
    const files = fs.readdirSync(path.join(sub(), 'backups')).sort();
    assert.equal(files.length, 7); assert.ok(files.every((f) => /^agent-office-\d{8}\.sqlite$/.test(f)));
    h.close();
  });

  it('withTx commits, rolls back on throw, and joins an outer transaction', () => {
    const h = openDatabase({ dir: sub(), instance: 'test' });
    const ins = h.db.prepare("INSERT INTO ui_prefs (key, value_json, updated_at) VALUES ('uiTheme', ?, 1)");
    assert.throws(() => withTx(h.db, () => { ins.run('"a"'); throw new Error('boom'); }));
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM ui_prefs').get().n, 0);
    withTx(h.db, () => withTx(h.db, () => ins.run('"b"')));
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM ui_prefs').get().n, 1);
    h.close();
  });

  it('the next maintenance run is at 04:00 local', () => {
    const from = new Date(2026, 9, 5, 3, 30);
    assert.equal(msUntilNextHour(4, from), 30 * 60000);
    assert.equal(msUntilNextHour(4, new Date(2026, 9, 5, 4, 0)), 24 * 3600000);
  });
});

describe('store · repositories', () => {
  it('persons: the owner is seeded once; agents once each', () => {
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    assert.equal(st.owner.kind, 'human'); assert.equal(st.owner.name, 'Owner'); assert.match(st.owner.id, /^per_[a-z2-7]{16}$/);
    st.close();
    const st2 = openStore({ dir: sub(), instance: 'test', ownerName: 'renamed', log: () => {} });
    assert.equal(st2.owner.id, st.owner.id); assert.equal(st2.owner.name, 'Owner');
    assert.equal(st2.persons.ensureAgent('main', 'Timmy').created, true);
    assert.equal(st2.persons.ensureAgent('main', 'Timmy').created, false);
    assert.deepEqual(st2.persons.list().map((p) => p.links), [{ isOwner: true }, { agentId: 'main' }]);
    st2.close();
  });

  it('audit: entries are validated; a message-like detail or an unknown outcome is refused', () => {
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const ok = { at: NOW, requestId: 'r1', actor: { kind: 'human', personId: st.owner.id }, command: 'flows.run', target: 'job-1', outcome: 'ok', detail: null };
    st.audit.append(ok);
    assert.throws(() => st.audit.append({ ...ok, detail: 'Error: token abc rejected' }));
    assert.throws(() => st.audit.append({ ...ok, outcome: 'maybe' }));
    assert.throws(() => st.audit.append({ ...ok, actor: { kind: 'human', name: 'Owner' } }));
    assert.deepEqual(st.audit.recent().map((e) => [e.command, e.outcome]), [['flows.run', 'ok']]);
    assert.equal(st.audit.prune(NOW + 1), 1);
    st.close();
  });

  it('interlocutor cache: round trip; a failed lookup is stored without a profile; bad rows are skipped and reported', () => {
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const u = { id: '100000000000000001', username: 'bob', globalName: 'Bob', display: 'Bob', bot: false, flags: 0, avatar: null, createdMs: 1 };
    st.caches.interlocutors.put('discord-user:100000000000000001', u, NOW);
    st.caches.interlocutors.put('discord-channel:100000000000000002', null, NOW);
    assert.throws(() => st.caches.interlocutors.put('discord-user:100000000000000003', { id: 'x', token: 'nope' }, NOW));
    assert.throws(() => st.caches.interlocutors.put('alice', u, NOW));
    st.db.prepare("INSERT INTO interlocutor_cache VALUES ('discord-user:100000000000000009', 'resolved', '{not json', 1)").run();
    const e = createEngine({ now: () => NOW }); st.bindEngine(e);
    assert.deepEqual(st.caches.interlocutors.all().map((x) => [x.id, x.resolution]),
      [['discord-user:100000000000000001', 'resolved'], ['discord-channel:100000000000000002', 'failed']]);
    assert.ok(e.quarantine.list().some((i) => i.code === 'store.invalid' && i.channel === 'store.interlocutor_cache'));
    st.close();
  });
});

describe('store · quarantine persistence', () => {
  const issue = { source: 'gateway', channel: 'gw.rpc.cron.list', code: 'shape.invalid', severity: 'warn', path: '$.jobs[].schedule', detail: 'expected object, got string', sample: { kind: 'string' } };

  it('a mute survives recurrence; resolve-after-clean still applies to open issues', () => {
    const q = createQuarantine({ now: () => NOW });
    q.record(issue); const fp = q.list()[0].fingerprint;
    q.restore([{ ...q.list()[0], state: 'muted' }]);
    q.record(issue);
    assert.equal(q.list()[0].state, 'muted'); assert.equal(q.list()[0].count, 2);
    assert.equal(q.takeDirty().upserts[0].fingerprint, fp);
    assert.deepEqual(q.takeDirty(), { upserts: [], deletes: [] });
  });

  it('counts, first-seen and state survive a restart (write-behind flush + restore)', () => {
    let t = NOW;
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', now: () => t, log: () => {} });
    const e = createEngine({ now: () => t }); st.bindEngine(e);
    e.quarantine.record(issue); t += 1000; e.quarantine.record(issue);
    const before = e.quarantine.list();
    st.close();                                                        // flushes
    const st2 = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const e2 = createEngine({ now: () => t }); st2.bindEngine(e2);
    assert.deepEqual(e2.quarantine.list(), before);
    assert.deepEqual(e2.dataQuality().open, { error: 0, warn: 1, info: 0 });
    st2.close();
  });

  it('restored issues are not sanitised twice (placeholders stay stable)', () => {
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const e = createEngine({ now: () => NOW }); st.bindEngine(e);
    e.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: NOW, body: { kind: 'json', value: { agents: [{ id: 'main', 'Two Words': 'Alice' }] } } });
    const before = JSON.stringify(e.quarantine.list());
    st.close();
    const st2 = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const e2 = createEngine({ now: () => NOW }); st2.bindEngine(e2);
    assert.equal(JSON.stringify(e2.quarantine.list()), before);
    assert.ok(!before.includes('Alice') && !before.includes('Two Words'));
    st2.close();
  });

  it('maintenance: resolved issues older than 30 days and audit rows older than 365 days are dropped; a backup is written', () => {
    let t = NOW;
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', now: () => t, log: () => {} });
    const e = createEngine({ now: () => t }); st.bindEngine(e);
    e.quarantine.record(issue);
    for (let i = 0; i < 10; i++) e.quarantine.markClean(issue.channel);
    assert.equal(e.quarantine.list()[0].state, 'resolved');
    st.audit.append({ at: t, requestId: 'r', actor: { kind: 'human', personId: st.owner.id }, command: 'flows.run', target: null, outcome: 'ok', detail: null });
    st.flushQuarantine();
    t += 366 * 86400000;
    const r = st.maintenance();
    assert.equal(r.pruned.audit, 1);
    assert.equal(st.db.prepare('SELECT count(*) AS n FROM quarantine').get().n, 0, 'the resolved issue is gone from the store too');
    assert.equal(e.quarantine.list().length, 0);
    assert.ok(fs.existsSync(r.backup));
    st.close();
  });

  it('agents listed by the gateway are seeded as persons', () => {
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const e = createEngine({ now: () => NOW }); st.bindEngine(e);
    e.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: NOW, body: { kind: 'json', value: { defaultId: 'main', agents: [{ id: 'main', name: 'Timmy' }, { id: 'helper' }] } } });
    assert.deepEqual(st.persons.list().filter((p) => p.kind === 'agent').map((p) => [p.links.agentId, p.name]), [['main', 'Timmy'], ['helper', 'helper']]);
    st.close();
  });
});

describe('store · Discord cache (no refetch storm after a restart)', () => {
  let realFetch, calls;
  beforeEach(() => { realFetch = global.fetch; calls = []; global.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({ id: url.split('/').pop(), username: 'bob', global_name: 'Bob' }) }; }; });
  afterEach(() => { global.fetch = realFetch; });

  it('fresh entries are served from the cache; stale ones (7 days) are refetched', async () => {
    let t = NOW;
    const st = openStore({ dir: sub(), instance: 'test', ownerName: 'Owner', log: () => {} });
    const d1 = createDiscord({ getToken: () => 'tok', cache: st.caches.interlocutors, now: () => t });
    await d1.userProfile('100000000000000001');
    assert.equal(calls.length, 1);
    const d2 = createDiscord({ getToken: () => 'tok', cache: st.caches.interlocutors, now: () => t });   // "restart"
    assert.equal(d2.userName('100000000000000001'), 'Bob', 'name known at once');
    await d2.resolveAll(['100000000000000001'], []);
    assert.equal(calls.length, 1, 'no refetch');
    t += 8 * 86400000;
    const d3 = createDiscord({ getToken: () => 'tok', cache: st.caches.interlocutors, now: () => t });
    assert.equal(d3.userName('100000000000000001'), undefined);
    await d3.userProfile('100000000000000001');
    assert.equal(calls.length, 2);
    st.close();
  });
});
