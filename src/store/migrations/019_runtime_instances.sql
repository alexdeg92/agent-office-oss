-- Scoped runtime identities are longer than native agent names. Token material,
-- scope and revocation stay unchanged; the principal is still exact data.
CREATE TABLE api_tokens_scoped (
  id TEXT PRIMARY KEY CHECK (id LIKE 'tok\_%' ESCAPE '\'),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 5510),
  scope TEXT NOT NULL CHECK (scope IN ('projects-agent')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
INSERT INTO api_tokens_scoped SELECT * FROM api_tokens;
DROP TABLE api_tokens;
ALTER TABLE api_tokens_scoped RENAME TO api_tokens;
CREATE INDEX api_tokens_live ON api_tokens(hash) WHERE revoked_at IS NULL;

-- The publication digest is a durable, idempotent namespace checkpoint.
CREATE TABLE runtime_migration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_digest TEXT NOT NULL CHECK (length(config_digest) = 64)
);

-- Keep the native inventory bound while admitting validated scoped identities.
CREATE TABLE office_agents_seen_scoped (
  occupant_id TEXT PRIMARY KEY CHECK (length(occupant_id) BETWEEN 1 AND 213 OR
    (length(occupant_id) BETWEEN 1 AND 5526 AND occupant_id GLOB '*:rt:*')),
  role TEXT NOT NULL CHECK (role IN ('primary','agent','subagent','scheduled','direct','group','conversation')),
  name TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
INSERT INTO office_agents_seen_scoped SELECT * FROM office_agents_seen;
DROP TABLE office_agents_seen;
ALTER TABLE office_agents_seen_scoped RENAME TO office_agents_seen;

-- A removed source's ID cannot later be assigned to a different adapter kind.
CREATE TABLE runtime_instance_bindings (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL
);
