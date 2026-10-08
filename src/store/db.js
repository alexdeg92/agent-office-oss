'use strict';
/*
 * The Agent Office store (storage.md): one node:sqlite DatabaseSync per process, opened at boot.
 *   - the data directory is 0700 and the database file 0600 (SQLite gives -wal/-shm the file's mode);
 *   - migrations are numbered SQL files, each applied in its own BEGIN IMMEDIATE, recorded in schema_migrations;
 *   - a pre-migration backup is taken when an existing database has a pending migration;
 *   - boot guards: a schema newer than this build, or a data dir created by another instance, refuses to start.
 * Ad-hoc SQL lives only here and in repos/*.js.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DB_FILE = 'agent-office.sqlite';
const KEEP = { daily: 7, premigrate: 3 };

class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f.slice(4, -4), sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };

// withTx(db, fn): BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw. A nested call joins the outer transaction.
function withTx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}

/**
 * openDatabase({ dir, instance, now, migrationsDir }) → { db, file, dir, applied, backup(kind), close() }
 * `instance` ('production' | 'staging' | 'dev' | 'test') is written on first open and checked on every later one.
 */
// R8-01: what an existing store is, read before anything is created or changed (inspectExisting below: never an unlocked
// read of a file another process may be writing, architect-53); the regular checks after opening still apply.
const BUSY_TIMEOUT_MS = 5000;

// R8-01: the instance and schema of an existing store, read BEFORE anything is created or changed (no -wal/-shm, no
// chmod). architect-53: never an unlocked read of a file another process may be writing. `immutable=1` (no locks, no
// WAL) was used here, and a read racing another process's checkpoint saw torn pages: "database disk image is
// malformed" (72 in 347k reads under a checkpoint loop; 0 with locks). Now:
//   - a -shm file exists → a WAL connection may be live: an ordinary read-only connection, with SQLite's locks and the
//     busy timeout (it creates nothing: the WAL files are already there);
//   - no -shm → no live WAL connection: an immutable read, accepted only if the file and the absence of -shm are the
//     same before and after it (identity, size, mtime in ns); otherwise (or on an error while they changed) read again,
//     which takes the locked path once a connection exists.
const fileState = (file) => {
  const st = fs.statSync(file, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${fs.existsSync(file + '-shm')}`;
};
function readFacts(db) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const version = has('schema_migrations') ? (db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0) : 0;
  const row = has('store_meta') ? db.prepare("SELECT value FROM store_meta WHERE key = 'instance'").get() : null;
  return { version, instance: row ? row.value : null };
}
function inspectExisting(file, { attempts = 50 } = {}) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let k = 0; ; k++) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
    if (fs.existsSync(file + '-shm')) {
      const ro = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
      try { return readFacts(ro); } finally { ro.close(); }
    }
    const before = fileState(file);
    const uri = 'file:' + path.resolve(file).split('/').map(encodeURIComponent).join('/') + '?immutable=1';
    let facts = null, error = null;
    try { const ro = new DatabaseSync(uri, { readOnly: true }); try { facts = readFacts(ro); } finally { ro.close(); } } catch (e) { error = e; }
    let same = false; try { same = fileState(file) === before; } catch (_) { /* gone meanwhile */ }
    if (same) { if (error) throw error; return facts; }   // a stable file: the read is the file's, error or not
    if (k + 1 >= attempts) throw Object.assign(new Error('the store kept changing while it was inspected'), { code: 'ESTOREBUSY' });
    Atomics.wait(pause, 0, 0, 10);
  }
}


// Tests can never open a real store (PM after architect-38): under the test runner (NODE_TEST_CONTEXT) or for the
// 'test' instance (every test server), the data dir must resolve (symlinks followed) under os.tmpdir(), checked BEFORE
// anything is created.
function assertTestSafeDir(dir, instance) {
  if (!process.env.NODE_TEST_CONTEXT && instance !== 'test') return;
  const { identityOf } = require('../config');
  const tmp = identityOf(require('os').tmpdir());
  const real = identityOf(dir);
  if (real !== tmp && !real.startsWith(tmp + path.sep)) {
    throw Object.assign(new Error(`refusing a store outside ${tmp} under test: ${dir}`), { code: 'ETESTDIR' });
  }
}

function openDatabase({ dir, instance, now = () => Date.now(), migrationsDir = MIGRATIONS_DIR, log = () => {} }) {
  if (!dir) throw new StoreError('no-data-dir', 'AO_DATA_DIR is not set');
  assertTestSafeDir(dir, instance);
  const migrationsKnown = listMigrations(migrationsDir);
  const knownVersion = migrationsKnown.length ? migrationsKnown[migrationsKnown.length - 1].version : 0;
  // R8-01: refuse BEFORE any mutation (mkdir/chmod/pragma/backup/migration): another instance's store, or a schema
  // newer than this build, is rejected while its files stay byte-for-byte unchanged.
  const pre = inspectExisting(path.join(dir, DB_FILE));
  if (pre && pre.instance && pre.instance !== String(instance)) {
    throw new StoreError('instance-mismatch', `data dir ${dir} belongs to the '${pre.instance}' instance, not '${instance}'; refusing to start`);
  }
  if (pre && pre.version > knownVersion) {
    throw new StoreError('schema-too-new', `store schema v${pre.version} is newer than this build (v${knownVersion}); refusing to start`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, DB_FILE);
  const existed = fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));   // created 0600 before SQLite opens it
  fs.chmodSync(file, 0o600);

  // The busy timeout comes FIRST: switching to WAL needs a lock, and a previous process on this dir may still be
  // checkpointing on its way out (a quick restart). Without it, boot failed at once with "database is locked".
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');

  const migrations = listMigrations(migrationsDir);
  const known = migrations.length ? migrations[migrations.length - 1].version : 0;
  const current = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0;
  if (current > known) { db.close(); throw new StoreError('schema-too-new', `store schema v${current} is newer than this build (v${known}); refusing to start`); }

  const backupsDir = path.join(dir, 'backups');
  function backup(kind = 'daily') {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const name = kind === 'daily' ? `agent-office-${stamp(now())}.sqlite` : `agent-office-premigrate-v${String(current).padStart(3, '0')}-${now()}.sqlite`;
    const out = path.join(backupsDir, name);
    // R8-05: VACUUM INTO a unique temporary file, chmod it, then atomically rename it over the destination. A failed
    // backup leaves the previous one (and the retention inventory) untouched.
    const tmp = path.join(backupsDir, `.tmp-${process.pid}-${now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      db.prepare('VACUUM INTO ?').run(tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, out);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      throw e;
    }
    const prefix = kind === 'daily' ? /^agent-office-\d{8}\.sqlite$/ : /^agent-office-premigrate-/;
    const all = fs.readdirSync(backupsDir).filter((f) => prefix.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP[kind === 'daily' ? 'daily' : 'premigrate']))) fs.rmSync(path.join(backupsDir, f));
    return out;
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length && existed && current > 0) log(`store: pre-migration backup ${path.basename(backup('premigrate'))}`);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of pending) {
    // A migration that rebuilds a table other tables reference declares `-- ao:foreign-keys-off` (SQLite's documented
    // procedure: the pragma only takes effect OUTSIDE a transaction; the references are checked before the commit).
    const fkOff = /^--\s*ao:foreign-keys-off\b/m.test(m.sql);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      withTx(db, () => {
        db.exec(m.sql);
        if (fkOff && db.prepare('PRAGMA foreign_key_check').all().length) throw new StoreError('migration-failed', `migration ${m.version} broke a reference`);
        record.run(m.version, m.name, now());
      });
    } finally { if (fkOff) db.exec('PRAGMA foreign_keys = ON'); }
    log(`store: applied migration ${String(m.version).padStart(3, '0')}_${m.name}`);
  }

  // Instance guard: a data dir belongs to one instance for its whole life.
  const meta = db.prepare("SELECT value FROM store_meta WHERE key = 'instance'").get();
  if (!meta) {
    withTx(db, () => {
      db.prepare("INSERT INTO store_meta (key, value) VALUES ('instance', ?)").run(String(instance));
      db.prepare("INSERT INTO store_meta (key, value) VALUES ('created_at', ?)").run(String(now()));
    });
  } else if (meta.value !== String(instance)) {
    db.close();
    throw new StoreError('instance-mismatch', `data dir ${dir} belongs to the '${meta.value}' instance, not '${instance}'; refusing to start`);
  }

  return { db, file, dir, applied: pending.map((m) => m.version), version: known, backup, close: () => { if (db.isOpen) db.close(); } };
}

module.exports = { assertTestSafeDir, inspectExisting, openDatabase, withTx, listMigrations, StoreError, DB_FILE, MIGRATIONS_DIR };
