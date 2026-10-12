-- Owner Settings revisions and persisted password revocation generation.
CREATE TABLE settings_state (
  key TEXT PRIMARY KEY CHECK (key IN ('revision', 'auth_generation')),
  value INTEGER NOT NULL CHECK (value >= 0)
);
INSERT INTO settings_state VALUES ('revision', 1), ('auth_generation', 0);
