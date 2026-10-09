'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
function safePath(file, env) {
  const resolved = require('./safe-fs').canonicalPath(file);
  if (env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT) {
    const tmp = require('./safe-fs').canonicalPath(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tmp)) throw Object.assign(new Error('detector tests require temporary paths'), { code: 'ETESTPATH' });
    if (fs.existsSync(resolved) && !fs.realpathSync(resolved).startsWith(tmp)) throw Object.assign(new Error('detector path escapes fixtures'), { code: 'ETESTPATH' });
  }
  return resolved;
}
const exists = (file, env) => fs.existsSync(safePath(file, env));
function read(file, env) {
  try { const p = safePath(file, env); if (fs.statSync(p).size > 1024 * 1024) return null; return fs.readFileSync(p, 'utf8'); }
  catch (e) { if (e.code === 'ETESTPATH') throw e; return null; }
}
function binary(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
module.exports = { safePath, exists, read, binary };
