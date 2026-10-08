-- Migration 001 (S5): the store core. storage.md §4.
-- Project tables (S15a), repo_cache (S15b) and office layouts (S14b) come in their own migrations,
-- once the 2.1 contract merges settle them (forward-only: no table is created before its contract is final).

CREATE TABLE store_meta (               -- instance identity: the boot guard refuses a data dir created by another instance
  key         TEXT PRIMARY KEY CHECK (key IN ('instance', 'created_at')),
  value       TEXT NOT NULL
);

-- People (humans, agents, git identities); seeded at boot (owner, configured agents)
CREATE TABLE persons (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'per\_%' ESCAPE '\'),
  kind            TEXT NOT NULL CHECK (kind IN ('human','agent','git')),
  name            TEXT NOT NULL,
  avatar_url      TEXT,
  is_owner        INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
  agent_id        TEXT,
  subagent_id     TEXT,
  discord_user_id TEXT,
  git_email_hash  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX persons_owner   ON persons(is_owner) WHERE is_owner = 1;
CREATE UNIQUE INDEX persons_agent   ON persons(agent_id, ifnull(subagent_id, '')) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX persons_discord ON persons(discord_user_id) WHERE discord_user_id IS NOT NULL;
CREATE UNIQUE INDEX persons_git     ON persons(git_email_hash) WHERE git_email_hash IS NOT NULL;

CREATE TABLE ui_prefs (                 -- single user; one row per key
  key         TEXT PRIMARY KEY CHECK (key IN ('uiTheme')),
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Caches (safe to delete; rebuilt from sources)
CREATE TABLE interlocutor_cache (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'discord-user:[0-9]*' OR id GLOB 'discord-channel:[0-9]*' OR id GLOB 'discord-guild:[0-9]*'),
  resolution   TEXT NOT NULL CHECK (resolution IN ('resolved','failed')),
  profile_json TEXT,
  fetched_at   INTEGER NOT NULL
);

-- Engine and audit
CREATE TABLE quarantine (              -- value-free by construction (engine.md §5.3): no sample, detail or source text
  fingerprint TEXT PRIMARY KEY CHECK (fingerprint GLOB '[0-9a-f]*' OR fingerprint = 'overflow'),
  code        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('error','warn','info')),
  channel     TEXT NOT NULL,
  path        TEXT CHECK (path IS NULL OR path GLOB '$*'),
  count       INTEGER NOT NULL CHECK (count >= 1),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('open','resolved','muted'))
);
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  request_id  TEXT NOT NULL,
  actor_json  TEXT NOT NULL,
  command     TEXT NOT NULL,
  target      TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','rejected','failed')),
  detail      TEXT CHECK (detail IS NULL OR detail GLOB '[a-z]*')   -- a category, never a message or a body
);
CREATE INDEX audit_by_time ON audit_log(at DESC);
