'use strict';
/*
 * persons (storage.md §4, §5.2; data-model Person). S5 only seeds: the owner (from PORTAL_EMAIL's
 * local part until edited) and each configured agent. Everything else arrives with Projets (S15).
 */
const { mintId } = require('../ids');

function createPersonsRepo(db, { now = () => Date.now() } = {}) {
  // Repositories are constructed after migrations. Partial/legacy ladders before
  // 014 have no credential table; their owner still comes from persons.is_owner.
  const hasUsers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const hasRbac = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authorization_state'").get();
  const owner = db.prepare(hasRbac
    ? 'SELECT * FROM persons WHERE id=coalesce((SELECT person_id FROM users WHERE id=(SELECT owner_user_id FROM authorization_state WHERE singleton=1)),(SELECT id FROM persons WHERE is_owner=1))'
    : hasUsers
    ? "SELECT * FROM persons WHERE id = coalesce((SELECT person_id FROM users WHERE role = 'owner'), (SELECT id FROM persons WHERE is_owner = 1))"
    : 'SELECT * FROM persons WHERE is_owner = 1');
  const byAgent = db.prepare("SELECT * FROM persons WHERE agent_id = ? AND ifnull(subagent_id, '') = ''");
  const ins = db.prepare(`INSERT INTO persons (id, kind, name, is_owner, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const all = db.prepare('SELECT * FROM persons ORDER BY created_at, rowid');
  const rename_ = db.prepare('UPDATE persons SET name = ?, updated_at = ? WHERE id = ?');
  const identitiesOf = db.prepare('SELECT family, external_id FROM person_identities WHERE person_id = ?');
  const discordOf = db.prepare("SELECT external_id FROM person_identities WHERE person_id = ? AND family = 'discord'");
  // G3b (migration 007): a person's Discord id is a person_identities row, no longer persons.discord_user_id
  const discordLink = (id) => { const d = discordOf.get(id); return d ? { discordUserId: d.external_id } : {}; };
  const toPerson = (r) => ({ id: r.id, kind: r.kind, name: r.name, avatarUrl: r.avatar_url,
    links: Object.assign({}, owner.get()?.id === r.id ? { isOwner: true } : {}, r.agent_id ? { agentId: r.agent_id } : {}, r.subagent_id ? { subagentId: r.subagent_id } : {},
      discordLink(r.id), r.git_email_hash ? { gitEmailHash: r.git_email_hash } : {}) });

  return {
    owner: () => { const row = owner.get(); return row ? toPerson(row) : null; },
    // → the owner Person; created once, never renamed by the seed afterwards
    // `rename`: an explicitly configured name (PORTAL_DISPLAY_NAME) replaces the stored one
    ensureOwner(name, { rename = false } = {}) {
      const r = owner.get();
      if (r && rename && name && r.name !== name) { rename_.run(String(name).slice(0, 80), now(), r.id); return toPerson(owner.get()); }
      if (r) return toPerson(r);
      const t = now(); ins.run(mintId('per'), 'human', String(name || 'Propriétaire').slice(0, 80), 1, null, t, t);
      return toPerson(owner.get());
    },
    ensureAgent(agentId, name, { rename = false } = {}) {
      const r = byAgent.get(agentId); if (r) { if (rename && name && name !== r.name) rename_.run(String(name).slice(0, 80), now(), r.id); return { person: toPerson(byAgent.get(agentId)), created: false }; }
      const t = now(); ins.run(mintId('per'), 'agent', String(name || agentId).slice(0, 80), 0, agentId, t, t);
      return { person: toPerson(byAgent.get(agentId)), created: true };
    },
    // Neutral identity projection for sender matching; the existing Person/links wire shape is unchanged.
    senderPeople: () => all.all().map((r) => ({ ...toPerson(r), identities: identitiesOf.all(r.id).map((i) => ({ channel: i.family, id: `${i.family}-user:${i.external_id}` })) })),
    list: () => all.all().map(toPerson),
  };
}

module.exports = { createPersonsRepo };
