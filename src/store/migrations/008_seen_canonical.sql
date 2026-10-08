-- Migration 008 (review-22 R22-04, G5): the seen-occupant inventory is stored in the CANONICAL (3.0) vocabulary, whatever
-- contract's office build saw it; LayoutVM serves it per version. Existing 2.x rows are converted (ids and roles).
-- SQLite can't alter a CHECK constraint: the table is rebuilt. R24-01: ids are bounded by OCCUPANT_ID_MAX (213, src/engine/
-- model/kinds.js): a legal 200-char 2.x id grows by at most 5 ('cron:' → 'scheduled:') and always fits.
CREATE TABLE office_agents_seen_new (
  occupant_id  TEXT PRIMARY KEY CHECK (length(occupant_id) BETWEEN 1 AND 213),
  role         TEXT NOT NULL CHECK (role IN ('primary','subagent','scheduled','direct','group','conversation')),
  name         TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
INSERT OR REPLACE INTO office_agents_seen_new (occupant_id, role, name, last_seen_at)
  SELECT CASE
           WHEN occupant_id = 'main'            THEN 'primary'
           WHEN occupant_id LIKE 'cron:%'       THEN 'scheduled:' || substr(occupant_id, 6)
           WHEN occupant_id LIKE 'dm:%'         THEN 'direct:' || substr(occupant_id, 4)
           WHEN occupant_id LIKE 'channel:%'    THEN 'group:' || substr(occupant_id, 9)
           ELSE occupant_id END,
         CASE role WHEN 'main' THEN 'primary' WHEN 'cron' THEN 'scheduled' WHEN 'dm' THEN 'direct' WHEN 'channel' THEN 'group' ELSE role END,
         name, last_seen_at
  FROM office_agents_seen ORDER BY last_seen_at;
DROP TABLE office_agents_seen;
ALTER TABLE office_agents_seen_new RENAME TO office_agents_seen;
