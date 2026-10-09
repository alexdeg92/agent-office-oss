'use strict';
/*
 * `agent-office backup <file> [--data dir] [--config file] [--include-secrets] [--force]`
 * `agent-office restore <file> [--data dir] [--config file] [--force]`        (operations.md §2)
 * Exit: 0 done and verified; 1 refused (nothing changed); 2 failed while writing (nothing changed). One line on stdout
 * (done) or stderr (why), never a secret or a payload.
 */
const path = require('path');
const { backup, restore, OpsError } = require('./backup');
const { configPaths } = require('../instance-config');
const { defaultDataDir } = require('../config');

function parse(args) {
  const o = { file: null, data: null, config: null, includeSecrets: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--include-secrets') o.includeSecrets = true;
    else if (a === '--force') o.force = true;
    else if (a === '--data' || a === '--config') { const v = args[++i]; if (!v || v.startsWith('-')) throw new Error(`missing value for ${a}`); o[a.slice(2)] = v; }
    else if (a.startsWith('-')) throw new Error(`unknown argument: ${a}`);
    else if (!o.file) o.file = a;
    else throw new Error('one file only');
  }
  if (!o.file) throw new Error('a file is required');
  return o;
}

async function run(command, args, env = process.env, out = (m) => process.stdout.write(m + '\n'), err = (m) => process.stderr.write(m + '\n')) {
  let o;
  try { o = parse(args); } catch (e) { err(`agent-office ${command}: ${e.message}`); return 1; }
  if (command === 'restore' && o.includeSecrets) { err('agent-office restore: --include-secrets is a backup option (a restore writes what the backup has)'); return 1; }
  const instance = env.AO_ENV || (env.PORTAL_READONLY === '1' ? 'staging' : env.NODE_ENV === 'production' ? 'production' : 'dev');
  const dataDir = path.resolve(o.data || env.AO_DATA_DIR || defaultDataDir(env, instance));
  const paths = configPaths(Object.assign({}, env, o.config ? { AO_CONFIG: o.config } : {}));
  try {
    if (command === 'backup') {
      const r = await backup({ dataDir, paths, out: o.file, includeSecrets: o.includeSecrets, force: o.force });
      out(`backup ok: instance ${r.instance}, schema v${r.schema}${r.hasConfig ? ', config' : ''}${r.hasCredentialHashes ? ', credential hashes (sensitive; keep this file private)' : ''}${r.hasSecretsFile ? ', secrets file (keep this file private)' : r.hasCredentialHashes ? ', no secrets file' : ', no secrets'}`);
    } else {
      const r = await restore({ dataDir, paths, file: o.file, instance, force: o.force });
      out(`restore ok: instance ${r.instance}, schema v${r.schema}${r.prerestore ? ', previous store kept in backups/' : ''}${Object.entries(r.files).map(([k, v]) => `, ${k} ${v}`).join('')}`);
      // R32-01: committed and verified, but a moved-aside original could not be deleted: say which, never roll back
      if (r.leftovers && r.leftovers.length) err(`agent-office restore: done, but ${r.leftovers.length} previous file(s) could not be deleted; remove them by hand: ${r.leftovers.join(', ')}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof OpsError) { err(`agent-office ${command}: ${e.code}: ${e.reason}`); return e.code === 'refused' ? 1 : 2; }
    err(`agent-office ${command}: failed (${e.code || 'error'})`); return 2;
  }
}

module.exports = { run, parse };
