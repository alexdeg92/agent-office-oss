-- Principal-private chat targets, messages, staged attachments and mutation receipts.
CREATE TABLE chat_v3_targets (
  target_id TEXT PRIMARY KEY CHECK (length(target_id) BETWEEN 35 AND 35),
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('agent','team')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 4096),
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) BETWEEN 1 AND 80),
  native_agent_id TEXT NOT NULL CHECK (length(native_agent_id) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL,
  UNIQUE(principal_scope, target_kind, source_ref)
);
CREATE INDEX chat_v3_targets_owner ON chat_v3_targets(principal_scope,target_kind);
CREATE TABLE chat_v3_sessions (
  session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 35 AND 64),
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  agent_id TEXT NOT NULL REFERENCES chat_v3_targets(target_id),
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) BETWEEN 1 AND 80),
  native_agent_id TEXT NOT NULL CHECK (length(native_agent_id) BETWEEN 1 AND 4096),
  native_session_ref TEXT NOT NULL CHECK (length(native_session_ref) BETWEEN 1 AND 4096),
  title TEXT NOT NULL CHECK (length(title) <= 160),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count BETWEEN 0 AND 100000),
  pending_turn_id TEXT,
  pending_since INTEGER,
  retry_eligible_turn_id TEXT,
  deleted_at INTEGER,
  CHECK ((pending_turn_id IS NULL) = (pending_since IS NULL))
);
CREATE INDEX chat_v3_sessions_owner_agent ON chat_v3_sessions(principal_scope, agent_id, updated_at DESC);
CREATE TABLE chat_v3_messages (
  session_id TEXT NOT NULL REFERENCES chat_v3_sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  message_id TEXT NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 36 AND 72),
  turn_id TEXT,
  at INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','error')),
  kind TEXT NOT NULL CHECK (kind IN ('message','subagent-result')),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 65536),
  title TEXT,
  status TEXT,
  status_label_json TEXT,
  meta_json TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'array'),
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0,1)),
  PRIMARY KEY (session_id, sequence)
);
CREATE INDEX chat_v3_messages_page ON chat_v3_messages(session_id, sequence DESC);
CREATE TABLE chat_v3_attachments (
  attachment_id TEXT PRIMARY KEY CHECK (length(attachment_id) BETWEEN 36 AND 72),
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  session_id TEXT NOT NULL REFERENCES chat_v3_sessions(session_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf','text/plain','image/png','image/jpeg','image/gif','image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  storage_name TEXT NOT NULL UNIQUE CHECK (length(storage_name) = 64 AND storage_name NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('staged','bound','consumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX chat_v3_attachments_owner ON chat_v3_attachments(principal_scope, state, created_at);
CREATE TABLE chat_v3_upload_reservations (
  reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) = 64 AND reservation_id NOT GLOB '*[^a-f0-9]*'),
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  session_id TEXT NOT NULL REFERENCES chat_v3_sessions(session_id) ON DELETE CASCADE,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 20971520),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX chat_v3_upload_reservations_owner ON chat_v3_upload_reservations(principal_scope, session_id, expires_at);
CREATE TABLE chat_v3_idempotency (
  principal_scope TEXT NOT NULL CHECK (length(principal_scope) = 64 AND principal_scope NOT GLOB '*[^a-f0-9]*'),
  method TEXT NOT NULL,
  route_key TEXT NOT NULL,
  idem_key TEXT NOT NULL CHECK (length(idem_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('in-flight','complete','uncertain')),
  status_code INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (principal_scope, method, route_key, idem_key)
);
CREATE INDEX chat_v3_idempotency_expiry ON chat_v3_idempotency(expires_at);
CREATE TABLE chat_v3_turn_dispatches (
  session_id TEXT NOT NULL REFERENCES chat_v3_sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  principal_id TEXT CHECK (principal_id IS NULL OR length(principal_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('queued','dispatching')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX chat_v3_turn_dispatches_queue ON chat_v3_turn_dispatches(state, created_at);
