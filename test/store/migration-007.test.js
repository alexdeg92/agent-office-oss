'use strict';
// G3b · migration 007 (ADR-001 §12.5): interlocutor ids open to any channel family; person identities generalised.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
const { createCachesRepo } = require('../../src/store/repos/caches');
const { createPersonsRepo } = require('../../src/store/repos/persons');
const { createFacades } = require('../../src/store/repos/projects');

const SF = '100000000000000001', SF2 = '100000000000000002', GUILD = '100000000000000003';
const user = { id: SF, username: 'u', globalName: null, display: 'U', bot: false, flags: 0, avatar: null, createdMs: 1 };
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-m007-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function at006() {
  const mig = path.join(dir, 'migrations'); fs.mkdirSync(mig);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 6) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
  const h = openDatabase({ dir: path.join(dir, 'data'), instance: 'test', migrationsDir: mig });
  const ins = h.db.prepare('INSERT INTO interlocutor_cache VALUES (?, ?, ?, ?)');
  ins.run('discord-user:' + SF, 'resolved', JSON.stringify(user), 10);
  ins.run('discord-channel:' + SF2, 'failed', null, 11);
  ins.run('discord-guild:' + GUILD, 'resolved', JSON.stringify({ name: 'G' }), 12);
  h.db.prepare("INSERT INTO persons (id, kind, name, is_owner, discord_user_id, created_at, updated_at) VALUES ('per_human1', 'human', 'Camille', 0, ?, 1, 2)").run(SF);
  h.close();
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '007_open_identities.sql'), path.join(mig, '007_open_identities.sql'));
  return openDatabase({ dir: path.join(dir, 'data'), instance: 'test', migrationsDir: mig });
}

describe('G3b · migration 007', () => {
  it('keeps every Discord cache row byte-identical and copies persons.discord_user_id into person_identities', () => {
    const h = at006();
    try {
      assert.deepEqual(h.applied, [7]);
      assert.deepEqual(h.db.prepare('SELECT id, resolution, fetched_at FROM interlocutor_cache ORDER BY id').all().map((r) => [r.id, r.resolution, r.fetched_at]),
        [['discord-channel:' + SF2, 'failed', 11], ['discord-guild:' + GUILD, 'resolved', 12], ['discord-user:' + SF, 'resolved', 10]]);
      assert.deepEqual(createCachesRepo(h.db).interlocutors.get('discord-user:' + SF).profile, user);
      assert.deepEqual(h.db.prepare('SELECT person_id, family, external_id FROM person_identities').all().map((r) => ({ ...r })),
        [{ person_id: 'per_human1', family: 'discord', external_id: SF }]);
      assert.deepEqual(createPersonsRepo(h.db).list().find((p) => p.id === 'per_human1').links, { discordUserId: SF }, 'the Discord link reads from person_identities');
    } finally { h.close(); }
  });

  it('accepts any family with an opaque id and the generic profile; refuses malformed ids and profiles (CHECK and repo)', () => {
    const h = at006();
    try {
      const c = createCachesRepo(h.db).interlocutors;
      c.put('telegram-user:foreign-user', { displayName: 'Foreign User', avatarUrl: null }, 20);
      c.put('matrix-room:!room:example.org', null, 21);
      c.put('discord-room:' + SF2, null, 22);   // the 3.0 spelling of a Discord channel
      assert.deepEqual(c.get('telegram-user:foreign-user'), { id: 'telegram-user:foreign-user', resolution: 'resolved', profile: { displayName: 'Foreign User', avatarUrl: null }, fetchedAt: 20 });
      assert.equal(c.get('matrix-room:!room:example.org').resolution, 'failed');
      for (const bad of ['Telegram-user:x', 'telegram-guild:x', 'telegram-user:', 'telegram-user:a\nb', 'discord-user:not-a-snowflake', 'telegram-channel:x', 'x'.repeat(40) + '-user:y'])
        assert.throws(() => c.put(bad, null, 1), /bad interlocutor cache id/, bad);
      assert.throws(() => c.put('slack-user:U1', { displayName: 'x', avatarUrl: null, extra: 1 }, 1), /rejected/);
      // the CHECK itself refuses what the repository would (defence in depth)
      for (const bad of ['Telegram-user:x', 'telegram-user:a' + String.fromCharCode(10), 'telegram-guild:x'])
        assert.throws(() => h.db.prepare("INSERT INTO interlocutor_cache VALUES (?, 'failed', NULL, 1)").run(bad), /CHECK/, JSON.stringify(bad));
    } finally { h.close(); }
  });

  it('a person link is written to person_identities only; unique per (family, id); removed with the link', () => {
    const h = at006();
    try {
      const f = createFacades(h.db);
      f.persons.set('per_agent1', { kind: 'agent', name: 'Atlas', avatarUrl: null, links: { agentId: 'atlas', discordUserId: SF2 } });
      assert.equal(h.db.prepare("SELECT discord_user_id FROM persons WHERE id = 'per_agent1'").get().discord_user_id, null, 'the legacy column is not written');
      assert.deepEqual(f.persons.get('per_agent1').links, { agentId: 'atlas', discordUserId: SF2 });
      assert.throws(() => f.persons.set('per_agent2', { kind: 'agent', name: 'B', avatarUrl: null, links: { agentId: 'b', discordUserId: SF2 } }), /UNIQUE/);
      f.persons.set('per_agent1', { kind: 'agent', name: 'Atlas', avatarUrl: null, links: { agentId: 'atlas' } });
      assert.deepEqual(f.persons.get('per_agent1').links, { agentId: 'atlas' });
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM person_identities WHERE person_id = 'per_agent1'").get().n, 0);
    } finally { h.close(); }
  });
});
