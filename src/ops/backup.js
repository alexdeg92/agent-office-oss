'use strict';
// CLI backups are sensitive SQLite artifacts. Ordinary payloads use descriptor
// I/O; SQLite destinations use private stages. Every publish/swap/undo uses safe-fs
// identity receipts. Never remove a replacement entry during cleanup or rollback.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const safe = require('./safe-fs');
const { Stage } = require('./sqlite-artifacts');
const { DB_FILE, listMigrations, MIGRATIONS_DIR } = require('../store/db');
const { acquireDirLock, SERVER_LOCK } = require('./lock');
const FORMAT = '1';
class OpsError extends Error { constructor(code, reason) { super(reason); this.code = code; this.reason = reason; } }
const refuse = reason => new OpsError('refused', reason);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const knownSchema = () => { const m = listMigrations(MIGRATIONS_DIR); return m.at(-1)?.version || 0; };
function validPayload(kind, text) {
  const IC = require('../instance-config'), S = require('../schema');
  let value; try { value = JSON.parse(text); } catch { return false; }
  return S.validate(kind === 'config' ? IC.ConfigSchema : IC.SecretsSchema, value).ok;
}
const sql = (query, mode = 'get', params = []) => ({ sql: query, mode, params });
function facts(stage) {
  const [instance, version] = stage.sql([
    sql("SELECT value FROM store_meta WHERE key = 'instance'"), sql('SELECT max(version) AS v FROM schema_migrations'),
  ], { readOnly: true });
  return { instance: instance?.value || null, schema: version?.v || 0 };
}
function integrity(stage) {
  const [row] = stage.sql([sql('PRAGMA integrity_check')], { readOnly: true });
  return row && Object.values(row)[0] === 'ok';
}
function hashes(stage) {
  const [table] = stage.sql([sql("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")], { readOnly: true });
  return table ? !!stage.sql([sql("SELECT 1 FROM users WHERE password_hash IS NOT NULL AND password_hash <> '' LIMIT 1")], { readOnly: true })[0] : false;
}
function inspectStage(stage) {
  let meta;
  try {
    if (!integrity(stage)) throw new Error('integrity');
    meta = Object.fromEntries(stage.sql([sql('SELECT key, value FROM ao_backup', 'all')], { readOnly: true })[0].map(r => [r.key, r.value]));
  } catch { throw refuse('not a valid backup (integrity or format)'); }
  if (meta.format !== FORMAT) throw refuse('unknown backup format');
  const f = facts(stage);
  if (f.instance !== meta.instance || String(f.schema) !== meta.schema) throw refuse('backup metadata does not match its store');
  for (const kind of ['config', 'secrets']) {
    if (meta[kind] != null && sha(meta[kind]) !== meta[kind + 'Sha256']) throw refuse(`the backup's ${kind} payload is damaged`);
    if (meta[kind] != null && !validPayload(kind, meta[kind])) throw refuse(`the backup's ${kind} payload is not a valid ${kind} file`);
  }
  const hasCredentialHashes = hashes(stage), hasSecretsFile = meta.secrets != null;
  if (meta.hasCredentialHashes != null && meta.hasCredentialHashes !== String(hasCredentialHashes)) throw refuse('backup credential classification does not match its store');
  return { info: { instance: meta.instance, schema: Number(meta.schema), createdAt: Number(meta.createdAt), hasConfig: meta.config != null,
    hasCredentialHashes, hasSecretsFile, hasSecrets: hasSecretsFile || hasCredentialHashes }, meta };
}
function translate(error, action) {
  if (error instanceof OpsError) return error;
  return new OpsError(error.code === 'EUNSAFEPATH' ? 'refused' : 'failed', `${action} failed (${error.code || 'error'}); changed or shared paths are not accepted`);
}
function ensureDir(dir, created = null) {
  dir = safe.canonicalPath(dir);
  const parent = safe.capture(path.dirname(dir)); safe.verifyTrusted(parent.chain);
  const before = fs.existsSync(dir) ? fs.lstatSync(dir, { bigint: true }) : null;
  const made = safe.mutate(dir, { type: 'mkdir', trusted: true, expectedParents: parent.chain,
    expectedIdentity: before ? { dev: String(before.dev), ino: String(before.ino) } : null });
  if (created && made.changed) {
    for (const entry of made.receipt.createdDirs) {
      created.push({ file: entry.path, parents: made.receipt.chain.filter(p => entry.path.startsWith(p.path + path.sep) || p.path === path.parse(entry.path).root), identity: entry });
    }
    created.push({ file: dir, parents: made.receipt.chain, identity: made.receipt.after });
  }
  safe.verifyTrusted(safe.capture(dir).chain);
  return dir;
}
function readIf(file) {
  if (!file) return null;
  const cap = safe.receipt(file, { missing: true });
  return cap.identity ? safe.guarded(cap, { type: 'read', identity: cap.identity, maxBytes: 16 * 1024 * 1024 }).text : null;
}
function inspectBackup(file) {
  let stage;
  try {
    const source = safe.receipt(file); stage = privateSnapshot(source, safe.receipt(source.file + '-wal', { missing: true }), path.dirname(source.file), { label: 'inspect' });
    return inspectStage(stage).info;
  } catch (e) { if (e.code === 'ENOENT') throw refuse('no such backup file'); throw translate(e, 'inspection'); }
  finally { stage?.cleanup(); }
}
async function backup({ dataDir, paths, out, includeSecrets = false, force = false, now = Date.now, hook = () => {} }) {
  let stage;
  try {
    const source = safe.receipt(path.join(dataDir, DB_FILE));
    const target = safe.receipt(out, { missing: true });
    if (target.identity && !force) throw refuse('the backup file exists (use --force to replace it)');
    const config = readIf(paths?.file), secrets = includeSecrets ? readIf(paths?.secrets) : null;
    if (config != null && !validPayload('config', config)) throw refuse('the config file is not valid: fix it before a backup');
    if (secrets != null && !validPayload('secrets', secrets)) throw refuse('the secrets file is not valid: fix it before a backup');
    stage = new Stage(path.dirname(target.file), { hook, label: 'backup' });
    stage.run('sqlite-copy', { source });
    const f = facts(stage), metadata = { format: FORMAT, instance: String(f.instance), schema: String(f.schema), createdAt: String(now()), hasCredentialHashes: String(hashes(stage)) };
    if (config != null) { metadata.config = config; metadata.configSha256 = sha(config); }
    if (secrets != null) { metadata.secrets = secrets; metadata.secretsSha256 = sha(secrets); }
    stage.sql([sql('PRAGMA journal_mode = DELETE'), sql('CREATE TABLE ao_backup (key TEXT PRIMARY KEY, value TEXT NOT NULL)', 'exec'),
      ...Object.entries(metadata).map(entry => sql('INSERT INTO ao_backup VALUES (?, ?)', 'run', entry))]);
    const { info } = inspectStage(stage);
    stage.publish(target, { exclusive: !force });
    hook('backup:published', { file: target.file });
    return { ok: true, file: target.file, ...info };
  } catch (e) { if (e.code === 'ENOENT') throw refuse('no store in the data directory'); if (e.code === 'EEXIST') throw refuse('the backup file exists (use --force to replace it)'); throw translate(e, 'backup'); }
  finally { stage?.cleanup(); }
}
function privateSnapshot(live, wal, directory, options) {
  const stage = new Stage(directory, options);
  try {
    stage.copy(live); if (wal?.identity) stage.copy(wal, '-wal');
    return stage;
  } catch (e) { stage.cleanup(); throw e; }
}
const random = () => crypto.randomBytes(18).toString('hex');
function movedAside(cap, operation) {
  const destination = '.' + path.basename(cap.file) + '.rollback-' + random();
  operation('move', cap.file, path.join(path.dirname(cap.file), destination));
  const moved = safe.guarded(cap, { type: 'move', destination, destinationIdentity: null });
  return { original: cap, aside: { file: path.join(path.dirname(cap.file), destination), parents: cap.parents, identity: moved.destinationIdentity } };
}

async function restore({ dataDir, paths, file, instance, force = false, now = Date.now, inject = null, ops = {}, hook = () => {} }) {
  const stages = [], moved = [], placed = [], created = [];
  let release, input, prerestore = null, committed = false;
  const operation = (kind, from, to) => ops.beforeOperation?.(kind, from, to);
  const fail = step => { hook('restore:' + step, { dataDir }); if (inject === step) throw Object.assign(new Error('injected failure'), { code: 'EIO' }); };
  const newStage = (directory, label) => { const stage = new Stage(directory, { hook, label }); stages.push(stage); return stage; };
  const remove = cap => { operation('remove', cap.file); return safe.guarded(cap, { type: 'remove', identity: cap.identity }); };
  try {
    const source = safe.receipt(file); input = privateSnapshot(source, safe.receipt(source.file + '-wal', { missing: true }), path.dirname(source.file), { hook, label: 'restore-input' }); stages.push(input);
    const { info, meta } = inspectStage(input);
    if (info.schema > knownSchema()) throw refuse('the backup is from a newer version of Agent Office');
    dataDir = ensureDir(dataDir);
    try { release = acquireDirLock(dataDir, SERVER_LOCK); } catch (e) { if (e.code === 'EBUSY') throw refuse('a server is running on this data directory: stop it first'); throw e; }
    const live = safe.receipt(path.join(dataDir, DB_FILE), { missing: true });
    const wal = safe.receipt(live.file + '-wal', { missing: true }), shm = safe.receipt(live.file + '-shm', { missing: true });
    let previous;
    if (live.identity) { previous = privateSnapshot(live, wal, dataDir, { hook, label: 'restore-previous' }); stages.push(previous); }
    const targetInstance = previous ? facts(previous).instance : instance;
    if (info.instance !== targetInstance) throw refuse(`the backup is of the ${info.instance} instance, not ${targetInstance}`);
    const store = newStage(dataDir, 'restore-store'); store.copy(input.cap);
    store.sql([sql('PRAGMA journal_mode = DELETE'), sql('DROP TABLE ao_backup', 'exec'), sql('VACUUM', 'exec')]);
    const f = facts(store);
    if (!integrity(store) || f.instance !== info.instance || f.schema !== info.schema) throw new OpsError('failed', 'the restored store did not verify');
    const payloads = [];
    for (const kind of ['config', 'secrets']) {
      if (meta[kind] == null || !paths) continue;
      const destination = safe.canonicalPath(kind === 'config' ? paths.file : paths.secrets), dir = path.dirname(destination);
      if (!fs.existsSync(dir)) ensureDir(dir, created);
      const target = safe.receipt(destination, { missing: true });
      if (target.identity && !force) { payloads.push({ kind, target, state: 'kept' }); continue; }
      const stage = newStage(dir, 'restore-' + kind); stage.write(meta[kind]);
      if (safe.guarded(stage.cap, { type: 'read', identity: stage.cap.identity, maxBytes: 16 * 1024 * 1024 }).text !== meta[kind]) throw new OpsError('failed', 'a restored file did not verify');
      payloads.push({ kind, target, stage, state: 'written' });
    }
    fail('staged');
    if (previous) {
      const directory = ensureDir(path.join(dataDir, 'backups'));
      const target = safe.receipt(path.join(directory, `agent-office-prerestore-${now()}.sqlite`), { missing: true });
      if (target.identity) throw refuse('a pre-restore recovery copy already exists');
      const stage = newStage(directory, 'restore-prerestore'); stage.run('sqlite-copy', { source: previous.cap, vacuum: true });
      stage.publish(target); prerestore = { ...target, identity: stage.cap.identity };
    }
    for (const cap of [live, wal, shm]) if (cap.identity) moved.push(movedAside(cap, operation));
    const place = (stage, target) => {
      operation('place', stage.file, target.file);
      const result = stage.publish({ ...target, identity: null });
      placed.push({ ...target, identity: result.receipt.after });
    };
    place(store, live); fail('store');
    for (const p of payloads) {
      if (p.state === 'kept') { safe.guarded(p.target, { type: 'guard' }); continue; }
      if (p.target.identity) moved.push(movedAside(p.target, operation));
      place(p.stage, p.target); fail(p.kind);
    }
    const published = placed.find(p => p.file === live.file);
    const probe = privateSnapshot(published, null, dataDir, { hook, label: 'restore-verify' }); stages.push(probe);
    const actual = facts(probe);
    if (!integrity(probe) || actual.instance !== info.instance || actual.schema !== info.schema) throw new OpsError('failed', 'the restored store did not verify in place');
    committed = true;
    const leftovers = [];
    for (const entry of moved) try { remove(entry.aside); } catch { leftovers.push(path.basename(entry.aside.file)); }
    return { ok: true, instance: info.instance, schema: info.schema, prerestore: !!prerestore, files: Object.fromEntries(payloads.map(p => [p.kind, p.state])), leftovers };
  } catch (e) {
    if (committed) throw e;
    let partial = false; const restored = new Set();
    for (const entry of moved.toReversed()) {
      try {
        const current = placed.find(p => p.file === entry.original.file);
        operation('rollback', entry.aside.file, entry.original.file);
        safe.guarded(entry.aside, { type: 'move', destination: path.basename(entry.original.file), destinationIdentity: current?.identity || null });
        restored.add(entry.original.file);
      } catch { partial = true; }
    }
    for (const cap of placed.toReversed()) if (!restored.has(cap.file) && !moved.some(m => m.original.file === cap.file)) try { remove(cap); } catch { partial = true; }
    if (partial) throw new OpsError('failed', 'restore failed and could not be rolled back completely: recovery copies retained' + (prerestore ? `, and the previous store as backups/${path.basename(prerestore.file)}` : ''));
    if (prerestore) try { remove(prerestore); } catch { /* retain an intact spare */ }
    if (e instanceof OpsError) throw e;
    throw translate(e, 'restore; nothing changed');
  } finally {
    for (const stage of stages.toReversed()) stage.cleanup();
    for (const dir of created.toReversed()) try { safe.guarded(dir, { type: 'emptyDir' }); } catch { /* preserve changed or nonempty directories */ }
    release?.();
  }
}
module.exports = { backup, restore, inspectBackup, OpsError, FORMAT };
