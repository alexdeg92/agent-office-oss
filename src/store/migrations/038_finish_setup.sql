-- Migration 038 (onboarding B-lite): an install whose login comes from the environment and that had no config.json
-- offers "Finish setting up your office" in Settings until the owner hides it. settings_state key 'finish_setup':
-- 1 open, 2 hidden; absent: never offered (wizard installs, and env installs that already had config.json).
-- SQLite can't alter a CHECK constraint: the table is rebuilt with the wider key set, rows kept.
CREATE TABLE settings_state_new (
  key TEXT PRIMARY KEY CHECK (key IN ('revision', 'auth_generation', 'finish_setup')),
  value INTEGER NOT NULL CHECK (value >= 0)
);
INSERT INTO settings_state_new (key, value) SELECT key, value FROM settings_state;
DROP TABLE settings_state;
ALTER TABLE settings_state_new RENAME TO settings_state;
