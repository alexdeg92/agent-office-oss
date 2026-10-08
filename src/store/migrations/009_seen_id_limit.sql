-- Migration 009 (review-24 R24-01): a store that ran the first version of 008 has the seen-occupant ids bounded at 200,
-- below what a canonical id can be. Rebuilt with the one limit, OCCUPANT_ID_MAX (213, src/engine/model/kinds.js); rows
-- are kept (they all fit). On a store whose 008 already had 213, this is a no-op rebuild.
CREATE TABLE office_agents_seen_new (
  occupant_id  TEXT PRIMARY KEY CHECK (length(occupant_id) BETWEEN 1 AND 213),
  role         TEXT NOT NULL CHECK (role IN ('primary','subagent','scheduled','direct','group','conversation')),
  name         TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
INSERT INTO office_agents_seen_new (occupant_id, role, name, last_seen_at) SELECT occupant_id, role, name, last_seen_at FROM office_agents_seen;
DROP TABLE office_agents_seen;
ALTER TABLE office_agents_seen_new RENAME TO office_agents_seen;
