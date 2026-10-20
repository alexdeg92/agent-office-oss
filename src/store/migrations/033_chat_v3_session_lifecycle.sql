-- Principal-owned chat list controls. Deleted sessions remain undoable for a short window;
-- after purge, only the Agent Office copy is removed (runtime transcripts are adapter-owned).
ALTER TABLE chat_v3_sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE chat_v3_sessions ADD COLUMN delete_after INTEGER;
CREATE INDEX chat_v3_sessions_delete_due ON chat_v3_sessions(delete_after) WHERE delete_after IS NOT NULL;
