'use strict';
// One publisher for setup and authenticated settings. No caller writes config.json.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const safe = require('./safe-fs');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error('configuration publication refused'), { code });
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
function acquirePublishLock(dir) {
  const { DatabaseSync } = require('node:sqlite');
  dir = safe.canonicalPath(dir);
  safe.mutate(dir, { type: 'mkdir', private: true });
  const parents = safe.capture(dir).chain;
  safe.verifyTrusted(parents);
  const file = path.join(dir, '.publish-lock.sqlite');
  try { safe.mutate(file, { type: 'write', exclusive: true, text: '', mode: 0o600, expectedIdentity: null, expectedParents: parents, trusted: true }); }
  catch (e) { if (!['EEXIST', 'EUNSAFEPATH'].includes(e.code) || !fs.existsSync(file)) throw e; }
  const cap = safe.receipt(file);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let db;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || !same(st, cap.identity)) throw fail('EUNSAFEPATH');
    safe.guarded(cap, { type: 'guard' });
    fs.fchmodSync(fd, 0o600);
    // SQLite's pathname open is bound to the reviewed descriptor, not a replaceable leaf.
    const pinned = ['/proc/self/fd/', '/dev/fd/'].map(base => base + fd).find(f => fs.existsSync(f));
    if (!pinned) throw fail('ENOTSUP');
    db = new DatabaseSync(pinned, { timeout: 0 });
    safe.guarded(cap, { type: 'guard' });
    try { db.exec('BEGIN IMMEDIATE'); } catch (e) {
      if (/locked|busy/i.test(String(e.message))) throw fail('EBUSY'); throw e;
    }
  } catch (e) { db?.close(); fs.closeSync(fd); throw e; }
  let released = false;
  return () => { if (released) return; released = true; try { db.exec('ROLLBACK'); } finally { db.close(); fs.closeSync(fd); } };
}
function publish(paths, config, secrets, { replace = false, expectedDigest, commit = () => {}, hook = null } = {}) {
  if (hook && !process.env.NODE_TEST_CONTEXT) throw fail('EINVAL');
  const dir = path.dirname(paths.file);
  if (path.dirname(paths.secrets) !== dir || paths.file === paths.secrets) throw fail('EUNSAFEPATH');
  const release = acquirePublishLock(dir);
  try {
    const configCap = safe.receipt(paths.file, { missing: true }), secretCap = safe.receipt(paths.secrets, { missing: true });
    if (!replace && configCap.identity) throw fail('EEXIST');
    if (expectedDigest !== undefined) {
      const old = configCap.identity ? JSON.parse(safe.read(paths.file, { roots: [dir], maxBytes: 1024 * 1024 }).text) : null;
      if (digest(old) !== expectedDigest) throw fail('ECONFLICT');
    }
    safe.transaction([paths.file, paths.secrets], path.join(dir, '.publish-backups'), () => {
      if (!replace && secretCap.identity) safe.guarded(secretCap, { type: 'remove', identity: secretCap.identity });
      const newSecretCap = !replace ? { ...secretCap, identity: null } : secretCap;
      safe.guarded(newSecretCap, { type: 'write', text: JSON.stringify(secrets, null, 2) + '\n', mode: 0o600, exclusive: !replace });
      hook?.('secrets');
      safe.guarded(configCap, { type: 'write', text: JSON.stringify(config, null, 2) + '\n', mode: 0o600, exclusive: !replace });
      hook?.('config');
      commit(digest(config));
    });
    return { digest: digest(config) };
  } finally { release(); }
}
module.exports = { publish, digest, acquirePublishLock };
