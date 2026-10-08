-- ao:foreign-keys-off
-- Migration 010 (architect-55, PM decision): project priorities widen from P0–P3 to P0–P9 (P0 the most urgent and
-- important). Stored values are kept as they are (no remap). SQLite can't alter a CHECK: the table is rebuilt, with
-- the references from the other project tables checked before the commit (the runner's ao:foreign-keys-off).
CREATE TABLE projects_new (
  id                 TEXT PRIMARY KEY CHECK (id LIKE 'prj\_%' ESCAPE '\'),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status             TEXT NOT NULL CHECK (status IN ('idea','todo','in-progress','in-review','shipped')),
  priority           TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3','P4','P5','P6','P7','P8','P9')),
  summary            TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
  summary_meta_json  TEXT,
  last_activity_at   INTEGER NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  created_at         INTEGER NOT NULL,
  archived_at        INTEGER
);
INSERT INTO projects_new (id, name, status, priority, summary, summary_meta_json, last_activity_at, revision, created_at, archived_at)
  SELECT id, name, status, priority, summary, summary_meta_json, last_activity_at, revision, created_at, archived_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
CREATE INDEX projects_board ON projects(archived_at, status, priority, last_activity_at DESC);
