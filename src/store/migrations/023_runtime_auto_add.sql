-- Runtime-agnostic discovery policy. Added rows retain the first auto-add time
-- for the 24-hour "new" marker; exclusions persist until explicitly cleared.
CREATE TABLE runtime_auto_add (
  runtime_id TEXT PRIMARY KEY CHECK (runtime_id GLOB '[a-z]*' AND runtime_id NOT GLOB '*[^a-z0-9-]*' AND length(runtime_id) BETWEEN 1 AND 32),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  added TEXT NOT NULL CHECK (json_valid(added) AND json_type(added) = 'array' AND json_array_length(added) <= 2000 AND length(added) <= 12000000),
  excluded TEXT NOT NULL CHECK (json_valid(excluded) AND json_type(excluded) = 'array' AND json_array_length(excluded) <= 2000 AND length(excluded) <= 11000000),
  updated_at INTEGER NOT NULL
);
