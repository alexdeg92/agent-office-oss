-- Migration 003 (S6, R1-09): logout revokes the session server-side. A revoked session id is kept until
-- the cookie it belonged to would have expired anyway, then pruned.
CREATE TABLE revoked_sessions (
  sid         TEXT PRIMARY KEY CHECK (length(sid) BETWEEN 16 AND 64),
  expires_at  INTEGER NOT NULL
);
