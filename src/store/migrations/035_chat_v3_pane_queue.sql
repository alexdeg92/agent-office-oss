-- Durable owner-scoped delivery queue for pane-backed ChatV3 targets.
ALTER TABLE chat_v3_turn_dispatches ADD COLUMN send_now INTEGER NOT NULL DEFAULT 0 CHECK (send_now IN (0,1));

CREATE TABLE chat_v3_pane_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_v3_sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 36 AND 64),
  pane_member_id TEXT NOT NULL CHECK (length(pane_member_id) BETWEEN 1 AND 256),
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  principal_id TEXT CHECK (principal_id IS NULL OR length(principal_id) BETWEEN 1 AND 128),
  queued_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending')),
  UNIQUE(session_id, turn_id)
);
CREATE INDEX chat_v3_pane_queue_fifo ON chat_v3_pane_queue(pane_member_id, state, queue_id);
