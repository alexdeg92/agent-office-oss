-- Last real owner-visible discovery result. Credentials/transcripts never enter
-- this bounded cache; a later scan replaces this singleton atomically.
CREATE TABLE runtime_detection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL CHECK (json_valid(value) AND length(CAST(value AS BLOB)) <= 1048576)
);
