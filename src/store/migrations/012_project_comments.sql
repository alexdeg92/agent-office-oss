-- Migration 012 (architect-57, Owner: Projets ≈ a Slack project): a comment thread on each project. A person writes;
-- a mentioned agent's reply comes back as an agent comment; delivery states per mention. Soft delete (the row stays).
-- kind 'event': a thread line, not a message (body = its code, e.g. 'summary-requested'; the author is who did it).
CREATE TABLE project_comments (
  id             TEXT PRIMARY KEY CHECK (id LIKE 'cmt\_%' ESCAPE '\'),
  project_id     TEXT NOT NULL REFERENCES projects(id),
  kind           TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','event')),
  author_kind    TEXT NOT NULL CHECK (author_kind IN ('person','agent','system')),
  author_id      TEXT,
  author_name    TEXT NOT NULL CHECK (length(author_name) BETWEEN 1 AND 120),
  body           TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  mentions_json  TEXT NOT NULL DEFAULT '[]',     -- [agentId]
  reply_to       TEXT,
  delivery_json  TEXT,                           -- [{ agentId, status: pending|replied|failed|unavailable, reason }]
  created_at     INTEGER NOT NULL,
  edited_at      INTEGER,
  deleted_at     INTEGER
);
CREATE INDEX project_comments_thread ON project_comments(project_id, created_at);
