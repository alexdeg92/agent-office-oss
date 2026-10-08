-- Migration 011 (architect-55, PM decision): projects the agent's project tag created on its own. A slug is claimed
-- once, for good: the same tag never creates a second project, and an archived (or renamed, or unlinked) project is
-- never re-created by an old tag.
CREATE TABLE project_tag_slugs (
  slug        TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 2 AND 64),
  project_id  TEXT NOT NULL REFERENCES projects(id),
  created_at  INTEGER NOT NULL
);
