'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const A = require('../../src/adapters/cursor');
const { createFiles, openSqliteReadonly, MAX_META } = require('../../src/adapters/cursor/files');
const { parseMeta, PROFILE } = require('../../src/adapters/cursor/profile');
const { adapterById, ADAPTER_IDS } = require('../../src/adapters');
const { createEngine } = require('../../src/engine');
const NOW = 1791600000000;
const WS = 'a'.repeat(32), CHAT = '11111111-2222-4333-8444-555555555555';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cursor-synthetic-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const chat = (workspace = WS, chatId = CHAT, meta = {}, withStore = true) => {
    const dir = path.join(home, 'chats', workspace, chatId);
    fs.mkdirSync(dir, { recursive: true });
    const body = {
      schemaVersion: 1, createdAtMs: NOW - 60_000, updatedAtMs: NOW - 1_000,
      hasConversation: true, title: 'Synthetic Cursor chat', cwd: '/synthetic/private/agent-office', ...meta,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(body));
    if (withStore) {
      const db = new DatabaseSync(path.join(dir, 'store.db'));
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', JSON.stringify({ synthetic: true }));
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('a'.repeat(64), Buffer.from('synthetic-blob'));
      db.close();
    }
    return dir;
  };
  return { home, chat };
}

async function startAndWait(runtime, engine) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Cursor initial refresh timed out')), 5000);
    runtime.start(engine, { refreshed: () => { clearTimeout(timer); resolve(); } });
  });
}

test('Cursor is registered beside Codex and Claude Code', () => {
  assert.ok(ADAPTER_IDS.includes('cursor'));
  assert.equal(adapterById('cursor').definition.id, 'cursor');
  assert.equal(adapterById('cursor').definition.mark.providerName, 'Cursor');
  assert.equal(A.setup.settings.detectedValues({}, { HOME: '/tmp/synthetic-home' }).home, '/tmp/synthetic-home/.cursor');
  assert.equal(A.paths({ HOME: '/tmp/h', CURSOR_HOME: '/tmp/custom/.cursor' }).cursorHome, '/tmp/custom/.cursor');
});

test('Cursor meta profile keeps only safe fields', () => {
  const counters = {};
  const parsed = parseMeta({
    schemaVersion: 1, createdAtMs: NOW, updatedAtMs: NOW, hasConversation: true,
    title: 'Synthetic title', cwd: '/synthetic/private/agent-office', secretExtra: 'nope',
  }, { sessionId: CHAT, workspaceHash: WS, counters });
  assert.equal(parsed.projectName, 'agent-office');
  assert.equal(parsed.sessionId, CHAT);
  assert.equal(parsed.title, 'Synthetic title');
  assert.equal(counters.unknownKeys, 1);
  assert.equal(PROFILE, 'cursor-meta-v1');
  assert.equal(parseMeta(null, { counters: {} }), null);
});

test('Cursor scanner reads synthetic meta.json, bounds store verification, and never needs blob text', async t => {
  const h = fixture(t);
  h.chat();
  h.chat('b'.repeat(32), '22222222-2222-4222-8222-222222222222', { title: 'Other', cwd: '/synthetic/other/demo-project' });
  const files = createFiles({ home: h.home, now: () => NOW, agentGrouping: 'project' });
  t.after(() => files.close());
  const rows = await files.scan();
  assert.equal(rows.length, 2);
  const traces = await Promise.all(rows.map(row => files.read(row.key)));
  assert.ok(traces.every(tr => tr && tr.events.length === 0));
  assert.ok(files.rows().every(row => row.projectName === 'agent-office' || row.projectName === 'demo-project'));
  assert.equal(JSON.stringify(traces).includes('/synthetic/private'), false);
  assert.ok(await files.verifyStore(files.rows()[0]));
  assert.ok(files.stats.bytes <= MAX_META * 2);
});

test('Cursor opens WAL-mode store.db with immutable=1 and creates no -shm/-wal beside it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cursor-wal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.db');
  const seed = new DatabaseSync(file);
  seed.exec('PRAGMA journal_mode=WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  seed.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('blob', Buffer.alloc(64 * 1024, 7));
  seed.close();
  // Drop any sidecars the seed connection left so the open under test starts clean.
  for (const name of fs.readdirSync(dir)) {
    if (name === 'store.db') continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
  assert.deepEqual(fs.readdirSync(dir), ['store.db']);
  const db = await openSqliteReadonly(file);
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  assert.ok(tables.has('blobs') && tables.has('meta'));
  assert.deepEqual(fs.readdirSync(dir), ['store.db'], 'immutable open must not create store.db-shm or store.db-wal');
});

test('Cursor refuses a symlinked store.db', async t => {
  const h = fixture(t);
  const chatDir = h.chat(WS, CHAT, {}, false);
  const real = path.join(h.home, 'elsewhere.db');
  const seed = new DatabaseSync(real);
  seed.exec('CREATE TABLE blobs (id TEXT); CREATE TABLE meta (key TEXT);');
  seed.close();
  fs.symlinkSync(real, path.join(chatDir, 'store.db'));
  const files = createFiles({ home: h.home, now: () => NOW });
  t.after(() => files.close());
  const rows = await files.scan();
  assert.equal(rows.length, 1);
  assert.equal(await files.verifyStore(rows[0]), false);
  assert.ok(files.stats.unreadableStores >= 1);
});

test('Cursor include/exclude filters by project basename', async t => {
  const h = fixture(t);
  h.chat(WS, CHAT, { cwd: '/synthetic/keep/keep-me' });
  h.chat('c'.repeat(32), '33333333-3333-4333-8333-333333333333', { cwd: '/synthetic/drop/drop-me' });
  const files = createFiles({ home: h.home, include: ['keep-me'], exclude: [], now: () => NOW });
  t.after(() => files.close());
  const rows = await files.filterRows(await files.scan());
  assert.equal(rows.length, 1);
  assert.equal((await files.read(rows[0].key)).projectName, 'keep-me');
});

test('Cursor probe reports connected / not-configured / unsupported-format', async t => {
  const missing = await A.setup.settings.probe({ runtime: { home: path.join(os.tmpdir(), 'ao-cursor-absent-' + process.pid) } });
  assert.equal(missing.status, 'not-configured');

  const h = fixture(t); h.chat();
  const ok = await A.setup.settings.probe({ runtime: { home: h.home, include: [], exclude: [], agentGrouping: 'project' } });
  assert.equal(ok.status, 'connected');
  assert.ok(ok.fileCount >= 1);

  const bad = fixture(t);
  const dir = path.join(bad.home, 'chats', WS, CHAT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), '{not-json');
  const unsupported = await A.setup.settings.probe({ runtime: { home: bad.home, include: [], exclude: [], agentGrouping: 'project' } });
  assert.equal(unsupported.status, 'unsupported-format');
});

test('Cursor discover lists one agent per project from synthetic chats', async t => {
  const h = fixture(t);
  h.chat(WS, CHAT, { cwd: '/synthetic/a/project-one' });
  h.chat('d'.repeat(32), '44444444-4444-4444-8444-444444444444', { cwd: '/synthetic/a/project-one' });
  h.chat('e'.repeat(32), '55555555-5555-4555-8555-555555555555', { cwd: '/synthetic/b/project-two' });
  const agents = await A.setup.discover({ runtime: { home: h.home, include: [], exclude: [], agentGrouping: 'project' } });
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map(a => a.name).sort(), ['project-one', 'project-two']);
});

test('Cursor runtime publishes agents and sessions from synthetic meta', async t => {
  const h = fixture(t);
  h.chat(WS, CHAT, { title: 'Synthetic office chat', cwd: '/synthetic/private/agent-office' });
  const runtime = A.createRuntime({ runtimeConfig: { cursor: { home: h.home, include: [], exclude: [], agentGrouping: 'project' } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close());
  runtime.attach(engine);
  await startAndWait(runtime, engine);
  assert.equal(engine.agents().length, 1);
  assert.equal(engine.agents()[0].name, 'agent-office');
  assert.equal(engine.sessions().length, 1);
  assert.equal(engine.sessions()[0].displayName, 'Synthetic office chat');
  assert.equal(engine.sessions()[0].summarySource, 'runtime');
  assert.equal(engine.sessions()[0].cwd, null);
  assert.equal(engine.sessions()[0].projectLabel, 'agent-office');
  assert.deepEqual(runtime.projectDirectoryHints(), [{ cwd: '/synthetic/private/agent-office' }]);
});

test('Cursor settings resolve and values honour HOME / CURSOR_HOME', () => {
  const resolved = A.setup.settings.resolve({ include: 'a\nb', exclude: '', agentGrouping: 'project' }, { home: '/tmp/x/.cursor' });
  assert.equal(resolved.adapter, 'cursor');
  assert.deepEqual(resolved.include, ['a', 'b']);
  assert.equal(A.setup.settings.values({ runtimeConfig: { cursor: { home: '/tmp/y/.cursor', include: ['p'], exclude: [], agentGrouping: 'runtime' } } }).home, '/tmp/y/.cursor');
});
