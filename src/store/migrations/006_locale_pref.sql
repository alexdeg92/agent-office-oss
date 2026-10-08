-- Migration 006 (G3c, explorer-06): the UI locale is a preference (ui_prefs key 'locale': "fr" | "en").
-- SQLite can't alter a CHECK constraint: the table is rebuilt with the wider key set, rows kept.
CREATE TABLE ui_prefs_new (
  key         TEXT PRIMARY KEY CHECK (key IN ('uiTheme', 'locale')),
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
INSERT INTO ui_prefs_new (key, value_json, updated_at) SELECT key, value_json, updated_at FROM ui_prefs;
DROP TABLE ui_prefs;
ALTER TABLE ui_prefs_new RENAME TO ui_prefs;
