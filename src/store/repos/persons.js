'use strict';
/*
 * persons (storage.md §4, §5.2; data-model Person). S5 only seeds: the owner (from PORTAL_EMAIL's
 * local part until edited) and each configured agent. Everything else arrives with Projets (S15).
 */
const { mintId } = require('../ids');

function createPersonsRepo(db, { now = () => Date.now() } = {}) {
  const owner = db.prepare('SELECT * FROM persons WHERE is_owner = 1');
  const byAgent = db.prepare("SELECT * FROM persons WHERE agent_id = ? AND ifnull(subagent_id, '') = ''");
  const ins = db.prepare(`INSERT INTO persons (id, kind, name, is_owner, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const all = db.prepare('SELECT * FROM persons ORDER BY created_at, rowid');
  const rename_ = db.prepare('UPDATE persons SET name = ?, updated_at = ? WHERE id = ?');
  const discordOf = db.prepare("SELECT external_id FROM person_identities WHERE person_id = ? AND family = 'discord'");
  // G3b (migration 007): a person's Discord id is a person_identities row, no longer persons.discord_user_id
  const discordLink = (id) => { const d = discordOf.get(id); return d ? { discordUserId: d.external_id } : {}; };
  const toPerson = (r) => ({ id: r.id, kind: r.kind, name: r.name, avatarUrl: r.avatar_url,
    links: Object.assign({}, r.is_owner ? { isOwner: true } : {}, r.agent_id ? { agentId: r.agent_id } : {}, r.subagent_id ? { subagentId: r.subagent_id } : {},
      discordLink(r.id), r.git_email_hash ? { gitEmailHash: r.git_email_hash } : {}) });

  return {
    // → the owner Person; created once, never renamed by the seed afterwards
    // `rename`: an explicitly configured name (PORTAL_DISPLAY_NAME) replaces the stored one
    ensureOwner(name, { rename = false } = {}) {
      const r = owner.get();
      if (r && rename && name && r.name !== name) { rename_.run(String(name).slice(0, 80), now(), r.id); return toPerson(owner.get()); }
      if (r) return toPerson(r);
      const t = now(); ins.run(mintId('per'), 'human', String(name || 'Propriétaire').slice(0, 80), 1, null, t, t);
      return toPerson(owner.get());
    },
    ensureAgent(agentId, name) {
      const r = byAgent.get(agentId); if (r) return { person: toPerson(r), created: false };
      const t = now(); ins.run(mintId('per'), 'agent', String(name || agentId).slice(0, 80), 0, agentId, t, t);
      return { person: toPerson(byAgent.get(agentId)), created: true };
    },
    list: () => all.all().map(toPerson),
  };
}

module.exports = { createPersonsRepo };
