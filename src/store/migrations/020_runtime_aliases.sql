-- Permanent bounded compatibility refusal history. Never pruned with upstream
-- rows, sessions, runtime instance bindings, or ordinary audit retention.
CREATE TABLE runtime_alias_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hashes TEXT NOT NULL CHECK (length(hashes) <= 4096 * 67 + 2 AND json_valid(hashes) AND json_type(hashes) = 'array' AND json_array_length(hashes) <= 4096),
  overflow INTEGER NOT NULL CHECK (overflow IN (0, 1))
);
