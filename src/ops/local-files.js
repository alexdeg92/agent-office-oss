'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { AsyncLocalStorage } = require('node:async_hooks');
const budget = new AsyncLocalStorage(), MAX_FILE = 1024 * 1024;
const limit = () => Object.assign(new Error('discovery capacity exceeded'), { code: 'EDETECTIONLIMIT' });
function charge(bytes = 0) {
  const b = budget.getStore();
  if (b && (++b.operations > 2048 || (b.bytes += bytes) > 8 * MAX_FILE)) throw limit();
}
const withReadBudget = fn => budget.run({ operations: 0, bytes: 0 }, fn);
function safePath(file, env) {
  const resolved = require('./safe-fs').canonicalPath(file);
  if (env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT) {
    const tmp = require('./safe-fs').canonicalPath(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tmp)) throw Object.assign(new Error('detector tests require temporary paths'), { code: 'ETESTPATH' });
    if (fs.existsSync(resolved) && !fs.realpathSync(resolved).startsWith(tmp)) throw Object.assign(new Error('detector path escapes fixtures'), { code: 'ETESTPATH' });
  }
  return resolved;
}
const exists = (file, env) => { charge(); return fs.existsSync(safePath(file, env)); };
function executable(file, env) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0')) return null;
  try {
    charge(); const p = safePath(file, env);
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile() ? p : null;
  } catch (e) { if (['ETESTPATH', 'EDETECTIONLIMIT'].includes(e.code)) throw e; return null; }
}
function read(file, env) {
  let fd;
  try {
    charge(); const p = safePath(file, env), leaf = fs.lstatSync(p);
    if (!leaf.isFile() || leaf.size > MAX_FILE) return null;
    // A replacement FIFO cannot block open; every read is bound to this regular
    // descriptor and a fixed buffer, including files that grow during the read.
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE)) return null;
    const capacity = Number(before.size) + 1; charge(capacity);
    const bytes = Buffer.alloc(capacity); let count = 0, n;
    while (count < capacity && (n = fs.readSync(fd, bytes, count, capacity - count, null))) count += n;
    const after = fs.fstatSync(fd, { bigint: true });
    if (count !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return null;
    return bytes.subarray(0, count).toString('utf8');
  } catch (e) { if (['ETESTPATH', 'EDETECTIONLIMIT'].includes(e.code)) throw e; return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function binary(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    charge();
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
module.exports = { safePath, exists, read, binary, executable, withReadBudget, limit };
