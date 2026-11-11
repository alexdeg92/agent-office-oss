'use strict';
// Worker half of cli-bindings.js: per OpenClaw agent store, the newest rows only (rowid order, no sort), the
// two binding objects only (never activity summaries or messages), stopping once the claim budget is spent.
const fs = require('node:fs'), path = require('node:path'), { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const SESSION_REF = /^[A-Za-z0-9._:-]{1,256}$/, MAX_JSON = 16 * 1024;
// OpenClaw's CLI backend names → the Agent Office adapter that indexes that CLI's own sessions.
const RUNTIME_OF = { 'claude-cli': 'claude-code', 'codex-cli': 'codex' };
const BINDINGS_SQL = `SELECT CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.cliSessionBindings') END AS bindings,
  CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.cliSessionIds') END AS ids
  FROM session_nodes ORDER BY rowid DESC LIMIT ?`;
const objectOf = text => { if (typeof text !== 'string' || text.length > MAX_JSON) return null; try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

const { stateDir, agentIds, limits } = workerData, sessions = [], seen = new Set();
const claim = (agentId, cli, ref) => {
  const runtimeKind = RUNTIME_OF[cli], key = runtimeKind + '\0' + ref;
  if (!runtimeKind || typeof ref !== 'string' || !SESSION_REF.test(ref) || seen.has(key) || sessions.length >= limits.claims) return;
  seen.add(key); sessions.push({ agentId, runtimeKind, sessionRef: ref });
};
for (const agentId of agentIds) {
  if (sessions.length >= limits.claims) break;
  const file = path.join(stateDir, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
  let stat; try { stat = fs.lstatSync(file); } catch { continue; }
  if (!stat.isFile() || stat.isSymbolicLink()) continue;
  let db;
  try {
    // immutable=1: no locking and no WAL index, so nothing is ever written beside OpenClaw's store.
    // Bindings still only in the WAL are picked up after OpenClaw checkpoints.
    const url = pathToFileURL(file); url.searchParams.set('immutable', '1');
    db = new (require('node:sqlite').DatabaseSync)(url, { readOnly: true });
    for (const row of db.prepare(BINDINGS_SQL).iterate(limits.rowsPerStore)) {
      for (const [cli, binding] of Object.entries(objectOf(row.bindings) || {})) claim(agentId, cli, binding?.sessionId);
      for (const [cli, ref] of Object.entries(objectOf(row.ids) || {})) claim(agentId, cli, ref);
      if (sessions.length >= limits.claims) break;
    }
  } catch { /* unreadable store or another schema: no claims */ } finally { try { db?.close(); } catch { /* closed */ } }
}
parentPort.postMessage({ sessions });
