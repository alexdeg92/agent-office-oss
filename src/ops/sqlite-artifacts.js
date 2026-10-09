'use strict';
// SQLite necessarily opens pathnames. Writes and artifact inspection happen in
// an owner-private stage in safe-fs's pinned worker. Online backup sources are
// opened read-only under separately verified trusted parents. Guard descriptors
// stay open across handoffs; untrusted writable parents are never accepted.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const unsafe = () => Object.assign(new Error('artifact identity changed'), { code: 'EUNSAFEPATH' });
const same = (s, id) => s && String(s.dev) === id.dev && String(s.ino) === id.ino;
const identity = s => ({ dev: String(s.dev), ino: String(s.ino) });
function validate(target, fsx = fs) {
  const safe = require('./safe-fs');
  safe.verifyTrusted(target.parents, fsx);
  const s = fsx.lstatSync(target.file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || !same(s, target.identity)) throw unsafe();
}
function openSource(target, fsx) {
  validate(target, fsx);
  const fd = fsx.openSync(target.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const s = fsx.fstatSync(fd, { bigint: true }); if (!s.isFile() || !same(s, target.identity)) throw unsafe(); validate(target, fsx); return fd; }
  catch (e) { fsx.closeSync(fd); throw e; }
}
async function execute({ job, op, before, chain, revalidate, changed, fsx }) {
  if (op.type === 'move') {
    if (!before || !op.destination || path.basename(op.destination) !== op.destination) throw unsafe();
    revalidate();
    let dest = null; try { dest = fsx.lstatSync(op.destination, { bigint: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (op.destinationIdentity ? !dest?.isFile() || dest.isSymbolicLink() || !same(dest, op.destinationIdentity) : dest) throw unsafe();
    if (!same(fsx.lstatSync(job.file, { bigint: true }), identity(before))) throw unsafe();
    fsx.renameSync(job.file, op.destination); revalidate();
    return { ...changed(null), destinationIdentity: identity(before) };
  }
  if (op.type === 'publish') {
    const fd = openSource(op.source, fsx);
    try {
      // Mode is set on the reviewed inode BEFORE it can become the public name.
      fsx.fchmodSync(fd, 0o600); fsx.fsyncSync(fd); validate(op.source, fsx); revalidate();
      if (op.exclusive) fsx.linkSync(op.source.file, job.file);
      else fsx.renameSync(op.source.file, job.file);
      const published = fsx.lstatSync(job.file, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || !same(published, op.source.identity)) throw unsafe();
      revalidate(); return changed(identity(published));
    } finally { fsx.closeSync(fd); }
  }
  if (!before) throw unsafe();
  const fd = fsx.openSync(job.file, (op.readOnly ? fs.constants.O_RDONLY : fs.constants.O_RDWR) | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const check = () => {
    revalidate(); const s = fsx.lstatSync(job.file, { bigint: true }), opened = fsx.fstatSync(fd, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || !same(s, identity(before)) || !same(opened, identity(before))) throw unsafe();
  };
  let sourceFd, db;
  try {
    check();
    if (!op.readOnly) { fsx.fchmodSync(fd, 0o600); fsx.fsyncSync(fd); }
    let results;
    if (op.type === 'copy') {
      sourceFd = openSource(op.source, fsx);
      const buffer = Buffer.alloc(64 * 1024); let offset = 0, n;
      fsx.ftruncateSync(fd, 0);
      while ((n = fsx.readSync(sourceFd, buffer, 0, buffer.length, offset))) {
        let done = 0; while (done < n) done += fsx.writeSync(fd, buffer, done, n - done, offset + done); offset += n;
      }
      validate(op.source, fsx); fsx.fsyncSync(fd);
    } else {
      const sqlite = require('node:sqlite');
      if (op.type === 'sqlite-copy') {
        sourceFd = openSource(op.source, fsx); check();
        db = new sqlite.DatabaseSync(op.source.file, { readOnly: true, timeout: 5000 });
        validate(op.source, fsx); check();
        if (op.vacuum) db.prepare('VACUUM INTO ?').run(job.file);
        else await sqlite.backup(db, job.file);
        validate(op.source, fsx);
      } else {
        check(); db = new sqlite.DatabaseSync(job.file, { readOnly: !!op.readOnly, timeout: 5000 }); check();
        results = op.statements.map(({ sql, params = [], mode = 'run' }) => {
          check();
          if (mode === 'exec') { db.exec(sql); return null; }
          return db.prepare(sql)[mode](...params);
        });
      }
      db.close(); db = null;
      if (!op.readOnly) { fsx.fchmodSync(fd, 0o600); fsx.fsyncSync(fd); }
    }
    check();
    const auxiliary = [];
    for (const suffix of ['-wal', '-shm', '-journal']) {
      let s; try { s = fsx.lstatSync(job.file + suffix, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!s.isFile() || s.isSymbolicLink()) throw unsafe();
      auxiliary.push({ suffix, identity: identity(s) });
    }
    return { results, auxiliary, ...changed(identity(before)) };
  } finally { if (db) db.close(); if (sourceFd !== undefined) fsx.closeSync(sourceFd); fsx.closeSync(fd); }
}

// Main-process facade: each capability is bound to the original parent/leaf
// identities. A private stage never becomes an arbitrary user-selected pathname.
class Stage {
  constructor(dir, { hook = () => {}, label = 'stage' } = {}) {
    const safe = require('./safe-fs');
    this.hook = hook; this.label = label; this.owned = new Map();
    const parent = safe.capture(dir); safe.verifyTrusted(parent.chain);
    this.directory = path.join(safe.canonicalPath(dir), '.agent-office-stage-' + crypto.randomBytes(18).toString('hex'));
    const made = safe.mutate(this.directory, { type: 'mkdir', trusted: true, expectedParents: parent.chain, expectedIdentity: null });
    this.dirIdentity = made.receipt.after;
    this.parents = [...made.receipt.chain, { path: this.directory, ...this.dirIdentity, mode: 0o700 }];
    this.hook(label + ':directory', { directory: this.directory });
    this.file = path.join(this.directory, 'artifact.sqlite');
    this.add(this.file);
  }
  add(file) {
    const safe = require('./safe-fs');
    const made = safe.mutate(file, { type: 'write', trusted: true, expectedParents: this.parents, expectedIdentity: null, exclusive: true, mode: 0o600, text: '' });
    const cap = { file, parents: this.parents, identity: made.receipt.after };
    this.owned.set(file, cap); if (file === this.file) this.cap = cap;
    return cap;
  }
  run(type, options = {}) {
    const safe = require('./safe-fs');
    this.hook(this.label + ':' + type, { directory: this.directory, file: this.file });
    const result = safe.guarded(this.cap, { type, timeoutMs: 120000, ...options });
    if (result.receipt?.after) { this.cap = { ...this.cap, identity: result.receipt.after }; this.owned.set(this.file, this.cap); }
    for (const { suffix, identity } of result.auxiliary || []) {
      const file = this.file + suffix; this.owned.set(file, { file, parents: this.parents, identity });
    }
    return result.results;
  }
  copy(source, suffix = '') {
    if (!suffix) { this.run('copy', { source }); return; }
    const safe = require('./safe-fs'), cap = this.add(this.file + suffix);
    safe.guarded(cap, { type: 'copy', source });
  }
  write(text) { this.run('write', { text, mode: 0o600 }); }
  sql(statements, { readOnly = false } = {}) { return this.run('sqlite', { statements, readOnly }); }
  publish(target, { exclusive = true } = {}) {
    this.hook(this.label + ':publish', { directory: this.directory, file: this.file, destination: target.file });
    const result = require('./safe-fs').guarded(target, { type: 'publish', source: this.cap, exclusive });
    if (!exclusive) this.owned.delete(this.file);
    return result;
  }
  cleanup() {
    const safe = require('./safe-fs'); let clean = true;
    for (const cap of [...this.owned.values()].reverse()) {
      try { safe.guarded(cap, { type: 'remove', identity: cap.identity }); }
      catch (e) { if (e.code !== 'ENOENT') clean = false; }
    }
    if (clean) try { safe.mutate(this.directory, { type: 'emptyDir', trusted: true, expectedIdentity: this.dirIdentity, expectedParents: this.parents.slice(0, -1) }); } catch { clean = false; }
    return clean;
  }
}
module.exports = { execute, Stage, validate };
