'use strict';
const path = require('path'), os = require('os');
// The openclaw executable: the first `openclaw` on PATH, then <home>/.npm-global/bin/openclaw (npm's user prefix).
function findOpenclawBin(env, home) {
  const fs = require('fs');
  const isExec = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch (_) { return false; } };
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, 'openclaw'); if (isExec(f)) return f;
  }
  return path.join(home, '.npm-global', 'bin', 'openclaw');
}
function openclawPaths(env) {
  const home = path.resolve(env.OC_HOME || env.HOME || os.homedir());   // also the HOME the openclaw CLI runs with
  const dir = env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(home, '.openclaw');
  return {
    openclawHome: home,
    identityPath: env.OC_IDENTITY || path.join(dir, 'identity', 'device.json'),
    stateDbPath: env.OC_STATE_DB || path.join(dir, 'state', 'openclaw.sqlite'),
    openclawConfigPath: env.OC_CONFIG || path.join(dir, 'openclaw.json'),
    openclawBin: env.OC_BIN || findOpenclawBin(env, home),
  };
}
module.exports = { paths: openclawPaths };
