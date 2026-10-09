-- Minimal runtime-neutral attribution cache. No message content or transport payloads.
CREATE TABLE sender_captures (
  runtime TEXT NOT NULL CHECK(length(runtime) BETWEEN 1 AND 128),
  session_key TEXT NOT NULL CHECK(length(session_key) BETWEEN 1 AND 1024),
  event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 1024),
  sender_json TEXT NOT NULL CHECK(length(sender_json) <= 2048),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16384),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (runtime, session_key, event_key)
) STRICT;
CREATE INDEX sender_captures_retention ON sender_captures(captured_at);
