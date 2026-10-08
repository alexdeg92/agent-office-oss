#!/usr/bin/env node
'use strict';
/*
 * The agent's scoped API token (S7d), managed locally. Never prints the token: it's written to a 0600 file that
 * the agent's skill reads. The store must already exist (the server creates it); this script never creates one.
 *
 *   node scripts/agent-token.js create --agent <id> [--out <file>]   a new token (fails if the file exists)
 *   node scripts/agent-token.js rotate --agent <id> [--out <file>]   revoke the agent's live tokens, write a new one
 *   node scripts/agent-token.js revoke --id <tok_…>                  revoke one token
 *   node scripts/agent-token.js list                                 ids, agents, dates (never hashes or tokens)
 *
 * The data dir is the instance's (AO_DATA_DIR, else the default for AO_ENV), as for the server.
 * Default --out: $XDG_CONFIG_HOME/agent-office/agent-<id>.token (else ~/.config/…).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultDataDir } = require('../src/config');
const { openDatabase } = require('../src/store/db');
const { createTokensRepo } = require('../src/store/repos/tokens');

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const die = (msg, code = 2) => { process.stderr.write('agent-token: ' + msg + '\n'); process.exit(code); };

function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
  if (!['create', 'rotate', 'revoke', 'list'].includes(cmd)) die('usage: agent-token.js create|rotate --agent <id> [--out <file>] | revoke --id <tok_…> | list');

  const instance = env.AO_ENV || (env.PORTAL_READONLY === '1' ? 'staging' : env.NODE_ENV === 'production' ? 'production' : 'dev');
  const dir = env.AO_DATA_DIR ? path.resolve(env.AO_DATA_DIR) : defaultDataDir(env, instance);
  if (!fs.existsSync(path.join(dir, 'agent-office.sqlite'))) die('no store in ' + dir + ' (start the server once first)');
  const handle = openDatabase({ dir, instance, log: () => {} });
  try {
    const tokens = createTokensRepo(handle.db);
    if (cmd === 'list') {
      for (const t of tokens.list()) process.stdout.write([t.id, t.agentId, t.scope, new Date(t.createdAt).toISOString(), t.revokedAt ? 'revoked' : 'live'].join('\t') + '\n');
      return 0;
    }
    if (cmd === 'revoke') {
      const id = opt('id');
      if (!id || !/^tok_[a-z0-9]+$/.test(id)) die('--id tok_… is required');
      if (!tokens.revoke(id)) die('no live token ' + id, 1);
      process.stdout.write('revoked ' + id + '\n');
      return 0;
    }
    const agentId = opt('agent');
    if (!agentId || !AGENT_ID.test(agentId)) die('--agent <id> is required');
    const home = env.HOME || os.homedir();
    const out = path.resolve(opt('out') || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-office', 'agent-' + agentId + '.token'));
    if (cmd === 'create' && fs.existsSync(out)) die(out + ' exists (use rotate)');
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    // R15-07: the new token is created, DELIVERED (a 0600 temp file renamed into place), and only then do older tokens
    // stop working. A failed delivery revokes the new token and removes the temp file; the old one keeps working.
    const { id, token } = tokens.create({ agentId });
    const tmp = path.join(path.dirname(out), '.agent-token.' + process.pid + '.tmp');
    try {
      fs.writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, out);
      fs.chmodSync(out, 0o600);
    } catch (e) {
      tokens.revoke(id);
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* already gone */ }
      die('could not write ' + out + ' (' + (e.code || 'error') + '); nothing changed');
    }
    if (cmd === 'rotate') tokens.revokeOthers(agentId, id);
    process.stdout.write((cmd === 'create' ? 'created ' : 'rotated: new token ') + id + ' for agent ' + agentId + ', written to ' + out + '\n');
    return 0;
  } finally { handle.close(); }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
