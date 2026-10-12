-- A cooldown survives API process restarts and applies to every owner session.
CREATE TABLE settings_restart (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  accepted_at INTEGER NOT NULL
);
