'use strict';
/*
 * T-0073 P0: no script under test/ may touch the operator's real HOME. A bare `node --test` (no glob) runs EVERY
 * .js/.cjs/.mjs file under test/ as its own process, so on 2026-10-11 a helper meant to be spawned with a scratch HOME
 * ran with the real one and overwrote ~/.openclaw/openclaw.json.
 *
 *   requireScratchHome(file)  for scripts that run as their own process (spawned children, manual capture tools): exit
 *                             unless HOME is a scratch directory the parent created — AO_TEST_SCRATCH_HOME === HOME,
 *                             strictly inside os.tmpdir(), and not the account's home directory.
 *   refuseEntry(file)         for helper modules (only ever imported): exit when started as the process entry point.
 *
 * Both exit with status 78 (EX_CONFIG) before doing anything else, and write nothing.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fileURLToPath } = require('node:url');

const REFUSED = 78;
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const fileOf = (file) => (String(file).startsWith('file:') ? fileURLToPath(file) : file);

function scratchHomeOk(env = process.env) {
  const home = env.HOME, marker = env.AO_TEST_SCRATCH_HOME;
  if (!home || !marker || marker !== home) return false;
  const h = real(home), tmp = real(os.tmpdir()), account = real(os.userInfo().homedir);
  return !!(h && tmp && h !== tmp && h.startsWith(tmp + path.sep) && h !== account);
}

function refuse(file, why) {
  process.stderr.write(`refusing to run ${path.relative(path.resolve(__dirname, '../..'), fileOf(file))}: ${why}\n`);
  process.exit(REFUSED);
}

function requireScratchHome(file) {
  if (!scratchHomeOk()) refuse(file, `HOME must be a scratch directory created by its parent (AO_TEST_SCRATCH_HOME === HOME, inside ${os.tmpdir()})`);
}

function refuseEntry(file) {
  const entry = process.argv[1] && real(process.argv[1]);
  if (entry && entry === real(fileOf(file))) refuse(file, 'a test helper module, not an entry point (run the suite with node --test "test/**/*.test.js")');
}

module.exports = { scratchHomeOk, requireScratchHome, refuseEntry, REFUSED };
refuseEntry(__filename);
