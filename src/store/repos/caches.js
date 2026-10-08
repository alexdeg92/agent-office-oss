'use strict';
/*
 * interlocutor_cache (storage.md §4): interlocutor lookups survive a restart, so names show at once and no refetch
 * storm follows a boot. Profiles are an enricher's mapped objects (never raw API payloads), validated on write and on
 * read. G3b (migration 007, ADR §12.5): any channel family. Discord keeps its snowflake schemas ('discord-channel' is
 * its 2.x room alias, 'discord-guild' its guild names); a family without an enricher schema gets the generic profile.
 */
const s = require('../../schema');

// G7 (ADR-001 §14.2): each enricher declares its stored profiles and id pattern; a family with no enricher keeps the
// generic profile. Rows are unchanged (no migration).
const { cacheSchemas, prefixOf, familyOf } = require('../../enrichers');
const GENERIC_ID = /^([a-z][a-z0-9-]{0,31})-(user|room):([^\u0000-\u001f\u007f]{1,128})$/u;   // R26-01: code points
const nstr = () => s.string().nullable();
const GENERIC = s.object({ displayName: nstr(), avatarUrl: nstr() }, { extra: 'reject' });
const SCHEMAS = cacheSchemas();
const PROFILE = Object.assign({ generic: GENERIC }, SCHEMAS.profiles);
const enricherOwns = (id) => Object.prototype.hasOwnProperty.call(SCHEMAS.profiles, prefixOf(id));
// a family an enricher owns takes that enricher's id pattern; any other family the generic one
const validId = (id) => { const o = SCHEMAS.owners.find((x) => x.families.includes(familyOf(id))); return o ? o.ids.test(id) : GENERIC_ID.test(id); };
const kindOf = (id) => (enricherOwns(id) ? prefixOf(id) : 'generic');

function createCachesRepo(db, { onInvalid = () => {} } = {}) {
  const put = db.prepare(`INSERT INTO interlocutor_cache (id, resolution, profile_json, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET resolution = excluded.resolution, profile_json = excluded.profile_json, fetched_at = excluded.fetched_at`);
  const all = db.prepare('SELECT * FROM interlocutor_cache');
  const get = db.prepare('SELECT * FROM interlocutor_cache WHERE id = ?');

  function fromRow(r) {
    if (!validId(r.id)) return null;
    if (r.resolution === 'failed') return { id: r.id, resolution: 'failed', profile: null, fetchedAt: r.fetched_at };
    let p; try { p = JSON.parse(r.profile_json); } catch (_) { return null; }
    if (!s.validate(PROFILE[kindOf(r.id)], p).ok) return null;
    return { id: r.id, resolution: 'resolved', profile: p, fetchedAt: r.fetched_at };
  }
  const read = (r) => { const e = fromRow(r); if (!e) onInvalid('interlocutor_cache'); return e; };

  return {
    interlocutors: {
      all: () => all.all().map(read).filter(Boolean),
      get: (id) => { const r = get.get(id); return r ? read(r) : null; },
      // profile null ⇒ the lookup failed (retried after the failure TTL)
      put(id, profile, fetchedAt) {
        if (!validId(id)) throw new Error('bad interlocutor cache id');
        if (profile != null && !s.validate(PROFILE[kindOf(id)], profile).ok) throw new Error('interlocutor profile rejected by the store schema');
        put.run(id, profile == null ? 'failed' : 'resolved', profile == null ? null : JSON.stringify(profile), fetchedAt);
      },
    },
  };
}

module.exports = { createCachesRepo, PROFILE };
