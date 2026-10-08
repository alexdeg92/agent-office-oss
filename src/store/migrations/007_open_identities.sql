-- Migration 007 (G3b, ADR-001 §12.5; planned as "004" in the ADR, renumbered: 004–006 were taken by S7d, S14b, G3c).
-- 1. interlocutor_cache ids widen from Discord-only to any channel family: '<family>-(user|room):<opaque>'
--    (family = a ChannelRef slug; opaque = 1–128 chars, no control characters). Discord's rows are kept exactly:
--    'discord-channel:' stays a legal 2.x alias of 'discord-room:', and 'discord-guild:' stays (guild names).
--    SQLite can't alter a CHECK constraint: the table is rebuilt, rows kept.
CREATE TABLE interlocutor_cache_new (
  id           TEXT PRIMARY KEY CHECK (
                 length(id) <= 170
                 AND id NOT GLOB ('*[' || char(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127) || ']*')
                 AND (id GLOB '[a-z]*-user:?*' OR id GLOB '[a-z]*-room:?*'
                      OR id GLOB 'discord-channel:[0-9]*' OR id GLOB 'discord-guild:[0-9]*')),
  resolution   TEXT NOT NULL CHECK (resolution IN ('resolved','failed')),
  profile_json TEXT,
  fetched_at   INTEGER NOT NULL
);
INSERT INTO interlocutor_cache_new (id, resolution, profile_json, fetched_at) SELECT id, resolution, profile_json, fetched_at FROM interlocutor_cache;
DROP TABLE interlocutor_cache;
ALTER TABLE interlocutor_cache_new RENAME TO interlocutor_cache;

-- 2. A person's external identities, one per (family, id): persons.discord_user_id generalised. The column is copied
--    here, stays readable until the 3.0 cleanup, and is no longer written.
CREATE TABLE person_identities (
  person_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  family       TEXT NOT NULL CHECK (length(family) BETWEEN 1 AND 32 AND family GLOB '[a-z]*' AND family NOT GLOB '*[^a-z0-9-]*'),
  external_id  TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128
                 AND external_id NOT GLOB ('*[' || char(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127) || ']*')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (family, external_id),
  UNIQUE (person_id, family)
);
INSERT INTO person_identities (person_id, family, external_id, created_at)
  SELECT id, 'discord', discord_user_id, updated_at FROM persons WHERE discord_user_id IS NOT NULL;
