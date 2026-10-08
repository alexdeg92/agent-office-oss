-- Migration 002 (S5, projects-05): the project tables (storage.md §4, data-model §9).
-- One row per entity with typed key columns; the domain object of a flag, source, override or event is
-- stored as JSON and validated by the projects module's schemas on write AND on read (src/projects/validate.js).
-- Session-group snapshots are not stored (they are session data; rebuilt from the engine after a boot).

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY CHECK (id LIKE 'prj\_%' ESCAPE '\'),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status             TEXT NOT NULL CHECK (status IN ('idea','todo','in-progress','in-review','shipped')),
  priority           TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  summary            TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
  summary_meta_json  TEXT,                       -- { author: ActorRef, at } | NULL
  last_activity_at   INTEGER NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  created_at         INTEGER NOT NULL,
  archived_at        INTEGER
);
CREATE INDEX projects_board ON projects(archived_at, status, priority, last_activity_at DESC);

CREATE TABLE project_sources (
  id            TEXT PRIMARY KEY CHECK (id LIKE 'src\_%' ESCAPE '\'),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  kind          TEXT NOT NULL CHECK (kind IN ('github','workspace','sessionGroup','manual')),
  ref_key       TEXT NOT NULL,                   -- canonical string form ('owner/repo' lowercased, …): uniqueness
  data_json     TEXT NOT NULL,                   -- the ProjectSource
  UNIQUE (project_id, kind, ref_key)
);
CREATE INDEX project_sources_github ON project_sources(kind, ref_key);

CREATE TABLE project_flags (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  kind        TEXT NOT NULL CHECK (kind IN ('label','risk','feature')),   -- 'priority' is derived, never stored
  key         TEXT NOT NULL,
  data_json   TEXT NOT NULL,                     -- the stored flag (label / risk with ack and evidence / feature with state)
  PRIMARY KEY (project_id, kind, key)
);

CREATE TABLE project_people (                    -- manual overrides only; derived membership is computed
  project_id  TEXT NOT NULL REFERENCES projects(id),
  person_id   TEXT NOT NULL REFERENCES persons(id),
  role        TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  added       INTEGER NOT NULL DEFAULT 0 CHECK (added IN (0,1)),
  PRIMARY KEY (project_id, person_id)
);

CREATE TABLE history_events (                    -- append-only
  id           TEXT PRIMARY KEY CHECK (id LIKE 'evt\_%' ESCAPE '\'),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('project-created','status','priority','commit','flow-run','cron-run','session',
                 'risk-raised','risk-cleared','risk-acked','flag-added','flag-removed','summary-edited',
                 'source-linked','source-unlinked','agent-action',
                 'renamed','risk-unacked','archived','restored','people-override','flags-updated')),
  dedupe_key   TEXT,
  data_json    TEXT NOT NULL,                    -- the whole event (actor and payload)
  UNIQUE (project_id, dedupe_key)
);
CREATE INDEX history_by_project ON history_events(project_id, at DESC, id);
CREATE TRIGGER history_no_update BEFORE UPDATE ON history_events BEGIN SELECT RAISE(ABORT, 'history is append-only'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON history_events BEGIN SELECT RAISE(ABORT, 'history is append-only'); END;

-- Caches (safe to delete; rebuilt from sources)
CREATE TABLE repo_cache (
  owner_repo       TEXT PRIMARY KEY,             -- 'owner/repo' (lowercased)
  data_json        TEXT,                         -- Repo; NULL until the first successful fetch (R3-20)
  authors_json     TEXT NOT NULL DEFAULT '[]',   -- [{ name, emailHash }]: commit author hints, never raw emails
  last_attempt_at  INTEGER,
  last_error       TEXT CHECK (last_error IS NULL OR last_error GLOB '[a-z]*')   -- a SourceErrorCategory, never a message
);
CREATE TABLE workspace_snapshots (
  source_id   TEXT PRIMARY KEY,
  data_json   TEXT NOT NULL                      -- { authors, branch, commits }
);
