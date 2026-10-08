'use strict';
// revoked_sessions (S6, R1-09): logout revokes the signed cookie's session id server-side, so a copied
// cookie stops working too. Rows live until the cookie would have expired anyway.
function createSessionsRepo(db) {
  const ins = db.prepare('INSERT INTO revoked_sessions (sid, expires_at) VALUES (?, ?) ON CONFLICT (sid) DO NOTHING');
  const has = db.prepare('SELECT 1 FROM revoked_sessions WHERE sid = ?');
  const prune = db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?');
  const cache = new Set();
  return {
    revoke(sid, expiresAt) { if (!sid) return; ins.run(String(sid), Number(expiresAt) || 0); cache.add(String(sid)); },
    isRevoked(sid) { if (!sid) return false; if (cache.has(sid)) return true; const r = !!has.get(String(sid)); if (r) cache.add(sid); return r; },
    prune(before) { cache.clear(); return Number(prune.run(before).changes); },
  };
}
module.exports = { createSessionsRepo };
