'use strict';
// An OS lock on a directory (R22-01's design): a SQLite write transaction on `<dir>/<name>`, held for the owner's whole
// life, released by the OS when it exits or dies. → release(); throws code 'EBUSY' when another process holds it.
const fs = require('fs');
const path = require('path');

function acquireDirLock(dir, name) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600); } catch (_) { /* reported by the open below */ }
  const db = new DatabaseSync(file, { timeout: 0 });
  try { db.exec('BEGIN IMMEDIATE'); } catch (e) {
    db.close();
    if (/locked|busy/i.test(String(e.message))) throw Object.assign(new Error('in use by another process'), { code: 'EBUSY' });
    throw e;
  }
  let released = false;
  return () => { if (released) return; released = true; try { db.exec('ROLLBACK'); } finally { db.close(); } };
}

const SERVER_LOCK = '.server-lock.sqlite';
module.exports = { acquireDirLock, SERVER_LOCK };
