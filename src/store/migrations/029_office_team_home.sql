-- Stable, private spatial assignments for canonical team roots. The layout revision
-- scopes these pins: any explicit owner layout save starts a fresh placement plan.
CREATE TABLE office_team_home_placements (
  layout_revision INTEGER NOT NULL CHECK (layout_revision >= 1),
  team_key TEXT NOT NULL CHECK (length(team_key) = 64 AND team_key NOT GLOB '*[^a-f0-9]*'),
  assignments_json TEXT NOT NULL CHECK (
    json_valid(assignments_json) AND json_type(assignments_json) = 'object'
    AND length(CAST(assignments_json AS BLOB)) <= 8192
  ),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (layout_revision, team_key)
);
