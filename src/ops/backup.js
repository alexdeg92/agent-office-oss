'use strict';
/*
 * G8 (docs/architecture/operations.md §2): backup and restore of an instance.
 *   backup:  SQLite's online backup of the store (the server may be running), plus the non-secret config file and,
 *            only when asked, the secrets file, in one 0600 SQLite file (table ao_backup). Verified before it is renamed.
 *   restore: refused while a server owns the data dir (its OS lock), or on an invalid backup, a newer schema or another
 *            instance's backup. The current store is kept as a pre-restore copy; no secret stays in the live store.
 * → { ok: true, … } or throws OpsError { code: 'refused' (exit 1) | 'failed' (exit 2), reason }.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_FILE, listMigrations, MIGRATIONS_DIR } = require('../store/db');
const { acquireDirLock, SERVER_LOCK } = require('./lock');

const FORMAT = '1';
class OpsError extends Error { constructor(code, reason) { super(reason); this.code = code; this.reason = reason; } }
const refuse = (reason) => new OpsError('refused', reason);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sqlite = () => require('node:sqlite');
const rand = () => crypto.randomBytes(6).toString('hex');
const knownSchema = () => { const m = listMigrations(MIGRATIONS_DIR); return m.length ? m[m.length - 1].version : 0; };
const readIf = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
// R30-03: a payload is accepted only if it parses and validates against its schema (a digest only says it is intact)
function validPayload(kind, text) {
  const IC = require('../instance-config'), S = require('../schema');
  let value; try { value = JSON.parse(text); } catch (_) { return false; }
  const r = S.validate(kind === 'config' ? IC.ConfigSchema : IC.SecretsSchema, value);
  return !!(r && r.ok);
}

function storeFacts(db) {
  const inst = db.prepare("SELECT value FROM store_meta WHERE key = 'instance'").get();
  const v = db.prepare('SELECT max(version) AS v FROM schema_migrations').get();
  return { instance: inst ? inst.value : null, schema: v ? v.v || 0 : 0 };
}
function integrityOk(db) { const r = db.prepare('PRAGMA integrity_check').get(); return !!r && Object.values(r)[0] === 'ok'; }
const metaOf = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM ao_backup').all().map((r) => [r.key, r.value]));
function privateTemp(dir, base) {
  const tmp = path.join(dir, `.${base}.${process.pid}.${rand()}.tmp`);
  fs.closeSync(fs.openSync(tmp, 'wx', 0o600));
  return tmp;
}

/** The backup's metadata after a full check (integrity, format, payload digests). Never returns secrets' text. */
function inspectBackup(file) {
  if (!fs.existsSync(file)) throw refuse('no such backup file');
  const { DatabaseSync } = sqlite();
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (_) { throw refuse('not a backup file'); }
  try {
    let meta;
    try { if (!integrityOk(db)) throw new Error('integrity'); meta = metaOf(db); } catch (_) { throw refuse('not a valid backup (integrity or format)'); }
    if (meta.format !== FORMAT) throw refuse('unknown backup format');
    const facts = storeFacts(db);
    if (facts.instance !== meta.instance || String(facts.schema) !== meta.schema) throw refuse('backup metadata does not match its store');
    for (const k of ['config', 'secrets']) if (meta[k] != null && sha(meta[k]) !== meta[k + 'Sha256']) throw refuse(`the backup's ${k} payload is damaged`);
    for (const k of ['config', 'secrets']) if (meta[k] != null && !validPayload(k, meta[k])) throw refuse(`the backup's ${k} payload is not a valid ${k} file`);
    return { instance: meta.instance, schema: Number(meta.schema), createdAt: Number(meta.createdAt), hasConfig: meta.config != null, hasSecrets: meta.secrets != null };
  } finally { db.close(); }
}

async function backup({ dataDir, paths, out, includeSecrets = false, force = false, now = Date.now }) {
  const src = path.join(dataDir, DB_FILE);
  if (!fs.existsSync(src)) throw refuse('no store in the data directory');
  out = path.resolve(out);
  if (fs.existsSync(out) && !force) throw refuse('the backup file exists (use --force to replace it)');
  // R30-03: never publish a backup whose config or secrets would be refused at restore (value-free reasons)
  const config = readIf(paths && paths.file), secrets = includeSecrets ? readIf(paths && paths.secrets) : null;
  if (config != null && !validPayload('config', config)) throw refuse('the config file is not valid: fix it before a backup');
  if (secrets != null && !validPayload('secrets', secrets)) throw refuse('the secrets file is not valid: fix it before a backup');
  const { DatabaseSync } = sqlite();
  const tmp = privateTemp(path.dirname(out), path.basename(out));
  try {
    const source = new DatabaseSync(src, { readOnly: true });
    let facts;
    try { facts = storeFacts(source); await sqlite().backup(source, tmp); } finally { source.close(); }
    fs.chmodSync(tmp, 0o600);
    const db = new DatabaseSync(tmp);
    try {
      db.exec('CREATE TABLE ao_backup (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const put = db.prepare('INSERT INTO ao_backup VALUES (?, ?)');
      put.run('format', FORMAT); put.run('instance', String(facts.instance)); put.run('schema', String(facts.schema)); put.run('createdAt', String(now()));
      if (config != null) { put.run('config', config); put.run('configSha256', sha(config)); }
      if (secrets != null) { put.run('secrets', secrets); put.run('secretsSha256', sha(secrets)); }
    } finally { db.close(); }
    const info = inspectBackup(tmp);   // verify after write, before the rename
    if (info.instance !== facts.instance || info.schema !== facts.schema || info.hasSecrets !== (secrets != null)) throw new OpsError('failed', 'verification failed');
    fs.renameSync(tmp, out); fs.chmodSync(out, 0o600);
    return Object.assign({ ok: true, file: out }, info);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* gone */ }
    if (e instanceof OpsError) throw e;
    throw new OpsError('failed', 'backup failed (' + (e.code || 'error') + ')');
  }
}

/*
 * R30-02: a restore is all or nothing. Everything is validated and STAGED first (the store in a temporary next to the live
 * one, verified; each payload in a private temporary next to its destination), so a refusal or a staging failure changes
 * nothing. The commit then moves the current files aside (the store with its -wal/-shm, a replaced config/secrets), puts
 * the staged ones in place, and only then deletes what it moved aside; a failure during the commit puts every moved file
 * back, byte for byte. `inject` (tests only) fails the commit at a named step.
 */
// the store where it now lives, checked from a private copy (with its WAL) so the live files are never opened
function verifyLive(live, info) {
  const { DatabaseSync } = sqlite();
  const probe = fs.mkdtempSync(path.join(path.dirname(live), '.restore-probe-'));
  try {
    fs.copyFileSync(live, path.join(probe, DB_FILE)); if (fs.existsSync(live + '-wal')) fs.copyFileSync(live + '-wal', path.join(probe, DB_FILE + '-wal'));
    const db = new DatabaseSync(path.join(probe, DB_FILE));
    try { const f = storeFacts(db); if (!integrityOk(db) || f.instance !== info.instance || f.schema !== info.schema) throw new OpsError('failed', 'the restored store did not verify in place'); } finally { db.close(); }
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
const aside = (f) => path.join(path.dirname(f), `.${path.basename(f)}.rollback-${process.pid}-${rand()}`);

function stagePayload(file, text, force, created) {
  let st = null; try { st = fs.lstatSync(file); } catch (_) { /* absent */ }
  if (st && !st.isFile()) throw refuse(`the ${path.basename(file)} destination is not a file`);
  if (st && !force) return { file, state: 'kept' };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); created.push(dir); }
  const tmp = privateTemp(dir, path.basename(file));
  fs.writeFileSync(tmp, text);
  if (sha(fs.readFileSync(tmp, 'utf8')) !== sha(text)) throw new OpsError('failed', 'a restored file did not verify');
  return { file, tmp, state: 'written', replaces: !!st };
}

async function restore({ dataDir, paths, file, instance, force = false, now = Date.now, inject = null, ops = {} }) {
  const xfs = ops.fs || fs;   // tests only: renames and unlinks of the swap, cleanup and rollback, with injected failures
  file = path.resolve(file);
  const info = inspectBackup(file);   // integrity, format, digests and (R30-03) valid payloads
  if (info.schema > knownSchema()) throw refuse('the backup is from a newer version of Agent Office');
  let release;
  try { release = acquireDirLock(dataDir, SERVER_LOCK); } catch (e) { if (e.code === 'EBUSY') throw refuse('a server is running on this data directory: stop it first'); throw e; }
  const { DatabaseSync } = sqlite();
  const live = path.join(dataDir, DB_FILE);
  const staged = [], created = [], moved = [], placed = [];
  let tmp = null, prerestore = null, committed = false;
  const fail = (step) => { if (inject === step) throw new Error('injected failure: ' + step); };
  try {
    let target = instance;
    // read from a private copy of the store and its WAL: even a read-only open rewrites the live -shm index
    const probe = fs.existsSync(live) ? fs.mkdtempSync(path.join(dataDir, '.restore-probe-')) : null;
    if (probe) {
      try {
        fs.chmodSync(probe, 0o700);
        fs.copyFileSync(live, path.join(probe, DB_FILE)); if (fs.existsSync(live + '-wal')) fs.copyFileSync(live + '-wal', path.join(probe, DB_FILE + '-wal'));
        const db = new DatabaseSync(path.join(probe, DB_FILE)); try { target = storeFacts(db).instance; } finally { db.close(); }
      } finally { fs.rmSync(probe, { recursive: true, force: true }); }
    }
    if (info.instance !== target) throw refuse(`the backup is of the ${info.instance} instance, not ${target}`);
    // 1. stage the backup's store, without its ao_backup table (no secret stays in a live store: dropped, then vacuumed)
    tmp = privateTemp(dataDir, DB_FILE);
    fs.copyFileSync(file, tmp); fs.chmodSync(tmp, 0o600);
    let config = null, secrets = null;
    { const db = new DatabaseSync(tmp); try { const m = metaOf(db); config = m.config != null ? m.config : null; secrets = m.secrets != null ? m.secrets : null; db.exec('PRAGMA journal_mode = DELETE'); db.exec('DROP TABLE ao_backup'); db.exec('VACUUM'); } finally { db.close(); } }
    { const db = new DatabaseSync(tmp, { readOnly: true }); try {   // one self-contained file (no -wal to lose in the rename)
      const f = storeFacts(db);
      if (!integrityOk(db) || f.instance !== info.instance || f.schema !== info.schema || db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ao_backup'").get()) throw new OpsError('failed', 'the restored store did not verify');
    } finally { db.close(); } }
    // 2. stage the payloads next to their destinations
    if (config != null && paths) staged.push(Object.assign({ kind: 'config' }, stagePayload(paths.file, config, force, created)));
    if (secrets != null && paths) staged.push(Object.assign({ kind: 'secrets' }, stagePayload(paths.secrets, secrets, force, created)));
    fail('staged');
    // 3. a copy of the current store, for the operator (read-only: the live files are not touched)
    if (fs.existsSync(live)) {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      prerestore = path.join(dir, `agent-office-prerestore-${now()}.sqlite`);
      // from a private copy again (the live -shm stays untouched)
      const probe = fs.mkdtempSync(path.join(dataDir, '.restore-probe-'));
      try {
        fs.copyFileSync(live, path.join(probe, DB_FILE)); if (fs.existsSync(live + '-wal')) fs.copyFileSync(live + '-wal', path.join(probe, DB_FILE + '-wal'));
        const db = new DatabaseSync(path.join(probe, DB_FILE)); try { db.prepare('VACUUM INTO ?').run(prerestore); } finally { db.close(); }
      } finally { fs.rmSync(probe, { recursive: true, force: true }); }
      fs.chmodSync(prerestore, 0o600);
    }
    // 4. commit: move the current files aside, put the staged ones in place
    for (const f of [live, live + '-wal', live + '-shm']) if (fs.existsSync(f)) { const a = aside(f); xfs.renameSync(f, a); moved.push([f, a]); }
    xfs.renameSync(tmp, live); placed.push(live); tmp = null;
    fail('store');
    for (const p of staged) {
      if (p.state !== 'written') continue;
      if (p.replaces) { const a = aside(p.file); xfs.renameSync(p.file, a); moved.push([p.file, a]); }
      xfs.renameSync(p.tmp, p.file); placed.push(p.file); p.tmp = null; fs.chmodSync(p.file, 0o600);
      fail(p.kind);
    }
    // 5. COMMIT POINT: the new store is verified where it now lives (a private copy: integrity, instance, schema). Before
    // it, any failure rolls back; after it, nothing is rolled back (R32-01): the originals may already be gone.
    verifyLive(live, info);
    committed = true;
    // 6. cleanup, after the commit: what was moved aside goes. A failure leaves that file and says so (never a rollback);
    // the pre-restore copy is kept whatever happens here.
    const leftovers = [];
    for (const [, a] of moved) try { xfs.rmSync(a, { force: true }); } catch (_) { leftovers.push(path.basename(a)); }
    return { ok: true, instance: info.instance, schema: info.schema, prerestore: !!prerestore, files: Object.fromEntries(staged.map((p) => [p.kind, p.state])), leftovers };
  } catch (e) {
    if (committed) throw e;   // unreachable: nothing after the commit throws
    // roll back: each moved file goes back OVER what replaced it (one atomic rename, so a failure still leaves a live
    // file); placed files that replaced nothing are removed; then the temporaries and anything created
    let partial = false;
    const restored = new Set();
    for (const [f, a] of moved.slice().reverse()) try { xfs.renameSync(a, f); restored.add(f); } catch (_) { partial = true; }
    for (const f of placed.slice().reverse()) if (!restored.has(f) && !moved.some(([m]) => m === f)) try { xfs.rmSync(f, { force: true }); } catch (_) { partial = true; }
    for (const t of [tmp].concat(staged.map((p) => p.tmp))) if (t) for (const x of [t, t + '-wal', t + '-shm', t + '-journal']) try { fs.rmSync(x, { force: true }); } catch (_) { /* gone */ }
    for (const d of created.reverse()) try { fs.rmdirSync(d); } catch (_) { /* not empty */ }
    // the pre-restore copy goes only after a COMPLETE rollback (R32-01): otherwise it may be the one intact previous store
    if (partial) {
      const kept = moved.filter(([f]) => !restored.has(f)).map(([, a]) => path.basename(a));
      throw new OpsError('failed', `restore failed and could not be rolled back completely: kept ${kept.join(', ') || 'no file'} next to the originals` +
        (prerestore ? `, and the previous store as backups/${path.basename(prerestore)}` : ''));
    }
    if (prerestore) try { xfs.rmSync(prerestore, { force: true }); } catch (_) { /* a spare copy of a store that is back in place */ }
    if (e instanceof OpsError) throw e;
    throw new OpsError('failed', 'restore failed, nothing changed (' + (e.code || 'error') + ')');
  } finally { release(); }
}

module.exports = { backup, restore, inspectBackup, OpsError, FORMAT };
