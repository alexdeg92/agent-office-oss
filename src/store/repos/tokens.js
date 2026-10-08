'use strict';
/*
 * api_tokens (S7d): an agent's scoped machine token. The raw token is returned ONCE by create/rotate (to the local
 * script, which writes it to a 0600 file) and never stored, logged or audited. Rows are found by their salted hash.
 */
const crypto = require('crypto');
const { mintId } = require('../ids');

const PREFIX = 'aot_';
const TOKEN_RE = /^aot_[A-Za-z0-9_-]{43}$/;

function createTokensRepo(db, { now = () => Date.now() } = {}) {
  const salt = db.prepare('SELECT salt FROM api_token_salt WHERE id = 1').get().salt;   // per store, from migration 004
  const hashOf = (token) => crypto.createHash('sha256').update(salt + ':' + token).digest('hex');
  const ins = db.prepare('INSERT INTO api_tokens (id, hash, agent_id, scope, created_at) VALUES (?, ?, ?, ?, ?)');
  const live = db.prepare('SELECT id, agent_id, scope, created_at FROM api_tokens WHERE hash = ? AND revoked_at IS NULL');
  const revokeStmt = db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const revokeOthersStmt = db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE agent_id = ? AND id != ? AND revoked_at IS NULL');
  const list = db.prepare('SELECT id, agent_id, scope, created_at, revoked_at FROM api_tokens ORDER BY created_at, rowid');

  return {
    // → { id, token } (the only time the raw token exists outside its owner's file)
    create({ agentId, scope = 'projects-agent' }) {
      const token = PREFIX + crypto.randomBytes(32).toString('base64url');
      const id = mintId('tok');
      ins.run(id, hashOf(token), String(agentId), scope, now());
      return { id, token };
    },
    // a malformed token never reaches the database
    resolve(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const r = live.get(hashOf(token));
      return r ? { id: r.id, agentId: r.agent_id, scope: r.scope, createdAt: r.created_at } : null;
    },
    revoke(id) { return Number(revokeStmt.run(now(), String(id)).changes) > 0; },
    // R15-07: rotation = create (live) → deliver (the caller writes the file) → revokeOthers. A failed delivery revokes
    // only the new one, so the working credential is never lost.
    revokeOthers(agentId, keepId) { return Number(revokeOthersStmt.run(now(), String(agentId), String(keepId)).changes); },
    list: () => list.all().map((r) => ({ id: r.id, agentId: r.agent_id, scope: r.scope, createdAt: r.created_at, revokedAt: r.revoked_at })),
  };
}

module.exports = { createTokensRepo, TOKEN_RE };
