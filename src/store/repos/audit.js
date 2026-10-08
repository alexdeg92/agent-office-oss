'use strict';
/*
 * audit_log (storage.md §4, §7): one row per write command, whatever the outcome. `detail` is a
 * category (http-403, cli-not-ok, …), never a message or a request body. Kept 365 days.
 */
const s = require('../../schema');

const Actor = s.discriminated('kind', {
  human: s.object({ kind: s.literal('human'), personId: s.string().min(1) }, { extra: 'reject' }),
  agent: s.object({ kind: s.literal('agent'), personId: s.string().min(1) }, { extra: 'reject' }),
  system: s.object({ kind: s.literal('system'), component: s.enumOf(['engine', 'risk-monitor', 'scheduler']) }, { extra: 'reject' }),
  anonymous: s.object({ kind: s.literal('anonymous') }, { extra: 'reject' }),   // R8-07: an attempt without a verified session
});
const Entry = s.object({
  at: s.int().min(0), requestId: s.string().min(1).max(64), actor: Actor, command: s.string().refine((c) => /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/.test(c), 'command'),
  target: s.string().max(200).nullable(), outcome: s.enumOf(['ok', 'rejected', 'failed']),
  // a category, optionally followed by the agent token's id (S7d: `token-scope token:tok_…`); or the token id alone
  detail: s.string().refine((d) => /^(?:[a-z][a-z0-9-]{0,40}(?: token:tok_[a-z0-9]{8,32})?|token:tok_[a-z0-9]{8,32})$/.test(d), 'category').nullable(),
}, { extra: 'reject' });

function createAuditRepo(db) {
  const ins = db.prepare('INSERT INTO audit_log (at, request_id, actor_json, command, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const recent = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?');
  const prune = db.prepare('DELETE FROM audit_log WHERE at < ?');
  return {
    append(e) {
      if (!s.validate(Entry, e).ok) throw new Error('audit entry rejected by the store schema');
      ins.run(e.at, e.requestId, JSON.stringify(e.actor), e.command, e.target, e.outcome, e.detail);
    },
    recent: (limit = 50) => recent.all(limit).map((r) => ({ id: r.id, at: r.at, requestId: r.request_id, actor: JSON.parse(r.actor_json),
      command: r.command, target: r.target, outcome: r.outcome, detail: r.detail })),
    prune: (before) => Number(prune.run(before).changes),
  };
}

module.exports = { createAuditRepo };
