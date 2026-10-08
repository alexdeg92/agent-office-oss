-- Migration 005 (S14b): office layouts, their revisions (last 20, with who saved them) and the inventory of
-- occupants seen (LayoutVM.agentsSeen, R3-14). storage.md §4 "Office"; revisions also keep updated_by_json (2.1 LayoutVM).
CREATE TABLE office_layouts (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'lay\_%' ESCAPE '\'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  data_json   TEXT NOT NULL,          -- OfficeLayoutDataV1 (design/office/layout.schema.json)
  updated_at  INTEGER NOT NULL,
  updated_by_json TEXT NOT NULL
);
CREATE UNIQUE INDEX office_layouts_active ON office_layouts(active) WHERE active = 1;
CREATE TABLE office_layout_revisions (  -- last 20 per layout, for « Annuler » / restore
  layout_id   TEXT NOT NULL REFERENCES office_layouts(id),
  revision    INTEGER NOT NULL,
  data_json   TEXT NOT NULL,
  saved_at    INTEGER NOT NULL,
  updated_by_json TEXT NOT NULL,
  PRIMARY KEY (layout_id, revision)
);
CREATE TABLE office_agents_seen (       -- id, role, source name, last seen: no session content
  occupant_id  TEXT PRIMARY KEY CHECK (length(occupant_id) BETWEEN 1 AND 200),
  role         TEXT NOT NULL CHECK (role IN ('main','subagent','cron','dm','channel')),
  name         TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
