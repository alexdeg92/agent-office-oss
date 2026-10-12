'use strict';
// Typed legacy projection. Immutable history/audit records keep their original
// bytes; their links are projected on read. Mutable identity columns are migrated
// transactionally at publication/boot before the canonical engine is bound.
const { scopedId, parseId } = require('../runtime-ids');
const { withTx } = require('./db');
const legacy = (kind, value) => value == null || parseId(value, kind) ? value : scopedId('legacy', kind, value);
function references(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(references);
  const result = { ...value };
  for (const [field, kind] of [['agentId', 'agent'], ['subagentId', 'agent'], ['sessionKey', 'session'], ['parentKey', 'session'], ['jobId', 'flow'], ['cronJobId', 'flow'], ['runId', 'run']]) {
    if (typeof result[field] === 'string') result[field] = legacy(kind, result[field]);
  }
  for (const field of ['sessionKeys', 'childKeys']) if (Array.isArray(result[field])) result[field] = result[field].map(v => legacy('session', v));
  for (const field of ['actor', 'author', 'ref', 'evidence', 'ack', 'delivery', 'summaryMeta', 'links']) if (result[field] && typeof result[field] === 'object') result[field] = references(result[field]);
  if (value.kind === 'session' && value.dedupeKey === `session:${value.sessionKey}@${value.at}`) result.dedupeKey = `session:${result.sessionKey}@${value.at}`;
  return result;
}
function occupant(value) {
  if (typeof value !== 'string' || !value.includes(':')) return value;
  const cut = value.indexOf(':'), prefix = value.slice(0, cut), native = value.slice(cut + 1);
  if (prefix === 'agent' || prefix === 'subagent') return prefix + ':' + legacy('agent', native);
  if (prefix === 'scheduled' || prefix === 'cron') return prefix + ':' + legacy('flow', native);
  if (prefix === 'conversation') return prefix + ':' + legacy('session', native);
  return value; // primary alias and external interlocutor identities remain data.
}
function layout(value) {
  const result = structuredClone(value);
  for (const agent of result.agents || []) {
    agent.agentId = occupant(agent.agentId);
    if (agent.match?.agentId) agent.match.agentId = legacy('agent', agent.match.agentId);
  }
  return result;
}
function createRuntimeReferences(db) {
  const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_migration' AND type='table'").get();
  const hasBindings = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_instance_bindings' AND type='table'").get();
  const requireSchema = () => { if (!hasTable || !hasBindings) throw Object.assign(new Error('runtime identity schema unavailable'), { code: 'EMIGRATION' }); };
  const state = () => hasTable && db.prepare('SELECT config_digest FROM runtime_migration WHERE id=1').get();
  const project = value => state() ? references(value) : value;
  function migrate(digest) {
    requireSchema();
    if (state()) return false;
    return withTx(db, () => {
      if (state()) return false;
      for (const table of ['persons', 'api_tokens']) {
        for (const row of db.prepare(`SELECT id, agent_id${table === 'persons' ? ', subagent_id' : ''} FROM ${table} WHERE agent_id IS NOT NULL${table === 'persons' ? ' OR subagent_id IS NOT NULL' : ''}`).iterate()) {
          db.prepare(`UPDATE ${table} SET agent_id=?${table === 'persons' ? ', subagent_id=?' : ''} WHERE id=?`).run(legacy('agent', row.agent_id), ...(table === 'persons' ? [legacy('agent', row.subagent_id)] : []), row.id);
        }
      }
      for (const row of db.prepare("SELECT id,data_json FROM project_sources WHERE kind='sessionGroup'").iterate()) {
        const next = references(JSON.parse(row.data_json));
        db.prepare('UPDATE project_sources SET data_json=?,ref_key=? WHERE id=?').run(JSON.stringify(next), require('../projects/validate').refKeyOf(next.kind, next.ref), row.id);
      }
      for (const row of db.prepare('SELECT rowid AS seq, * FROM project_comments').iterate()) {
        const mentions = JSON.parse(row.mentions_json).map(v => legacy('agent', v));
        const delivery = row.delivery_json ? references(JSON.parse(row.delivery_json)) : null;
        db.prepare('UPDATE project_comments SET author_id=?,mentions_json=?,delivery_json=? WHERE rowid=?').run(
          row.author_kind === 'agent' ? legacy('agent', row.author_id) : row.author_id, JSON.stringify(mentions), delivery && JSON.stringify(delivery), row.seq);
      }
      for (const table of ['office_layouts', 'office_layout_revisions']) for (const row of db.prepare(`SELECT rowid AS seq,data_json,updated_by_json FROM ${table}`).iterate()) {
        db.prepare(`UPDATE ${table} SET data_json=?,updated_by_json=? WHERE rowid=?`).run(JSON.stringify(layout(JSON.parse(row.data_json))), JSON.stringify(references(JSON.parse(row.updated_by_json))), row.seq);
      }
      for (const row of db.prepare('SELECT * FROM office_agents_seen').iterate()) {
        const next = occupant(row.occupant_id);
        if (next !== row.occupant_id) db.prepare('UPDATE office_agents_seen SET occupant_id=? WHERE occupant_id=?').run(next, row.occupant_id);
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_automatic_looks'").get()) {
        for (const row of db.prepare('SELECT identity_id FROM office_automatic_looks').all()) {
          const next = occupant(row.identity_id);
          if (next !== row.identity_id) db.prepare('UPDATE office_automatic_looks SET identity_id=? WHERE identity_id=?').run(next, row.identity_id);
        }
      }
      // Attribution cache uses adapter-native event keys for exact lookups; only
      // the runtime instance changes. Session/event body keys are never guessed.
      // Capture repositories continue to use native message keys internally;
      // a scoped repository wrapper below supplies the instance discriminator.
      db.prepare('INSERT INTO runtime_migration VALUES(1,?)').run(digest);
      return true;
    });
  }
  // Legacy repository readers also run against pre-019 databases during upgrades.
  // They need no binding table; namespace writes still require the complete schema.
  let binding;
  const bindingOf = () => binding || (binding = db.prepare('SELECT adapter FROM runtime_instance_bindings WHERE id=?'));
  function bind(entries) { requireSchema(); for (const r of entries) { const old=bindingOf().get(r.id); if (old && old.adapter !== r.adapter) throw Object.assign(new Error('runtime identity already bound'), {code:'EIDENTITY'}); db.prepare('INSERT OR IGNORE INTO runtime_instance_bindings VALUES(?,?)').run(r.id,r.adapter); } }
  return { migrate, project, layout, legacy, active: () => !!state(), bind, adapterFor: id => hasBindings ? bindingOf().get(id)?.adapter || null : null };
}
module.exports = { createRuntimeReferences, references, occupant, layout, legacy };
