-- Private ownership and idempotency receipt for project creation kickoffs.
-- The public ProjectVM never exposes this principal binding or target reference.
CREATE TABLE project_kickoffs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  principal_scope TEXT NOT NULL CHECK (length(principal_scope)=64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 35 AND 35),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 35 AND 64),
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 36 AND 72),
  connector_id TEXT CHECK (connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  UNIQUE(principal_scope, idempotency_key)
);
CREATE INDEX project_kickoffs_principal ON project_kickoffs(principal_scope, project_id);
