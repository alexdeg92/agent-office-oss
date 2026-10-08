-- Migration 004 (S7d, projects-13 plan): scoped machine tokens for an agent (the primary agent's Projets writes).
-- Only a salted hash is at rest: sha256(<per-store salt> ':' <token>). The salt is generated once per store here,
-- so a hash copied into another instance's store never matches there. Lookup is by hash (no secret comparison in JS).
CREATE TABLE api_token_salt (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  salt  TEXT NOT NULL CHECK (length(salt) = 64)
);
INSERT INTO api_token_salt (id, salt) VALUES (1, lower(hex(randomblob(32))));

CREATE TABLE api_tokens (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'tok\_%' ESCAPE '\'),
  hash        TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  agent_id    TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 64),   -- the principal: stored at creation (ADR-001 §12.2)
  scope       TEXT NOT NULL CHECK (scope IN ('projects-agent')),
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX api_tokens_live ON api_tokens(hash) WHERE revoked_at IS NULL;
