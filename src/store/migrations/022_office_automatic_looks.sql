-- Automatic appearances survive absence, restarts and layout revisions. No session content.
CREATE TABLE office_automatic_looks (
  identity_id TEXT PRIMARY KEY CHECK (length(identity_id) BETWEEN 1 AND 5526),
  family TEXT NOT NULL,
  look_json TEXT NOT NULL CHECK (json_valid(look_json) AND length(CAST(look_json AS BLOB)) <= 2048),
  assigned_at INTEGER NOT NULL
);
CREATE INDEX office_automatic_looks_family ON office_automatic_looks(family);
-- Keep OCCUPANT_ID_MAX (213) and migration 019's scoped identity exception.
ALTER TABLE office_agents_seen ADD COLUMN automatic_look_json TEXT
  CHECK (automatic_look_json IS NULL OR (
    (length(occupant_id) BETWEEN 1 AND 213 OR
      (length(occupant_id) BETWEEN 1 AND 5526 AND occupant_id GLOB '*:rt:*')) AND
    json_valid(automatic_look_json) AND length(CAST(automatic_look_json AS BLOB)) <= 2048));
