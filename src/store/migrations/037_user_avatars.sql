CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'photo')),
  character_id TEXT,
  look_json TEXT,
  blob_id TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'character' AND character_id IS NOT NULL AND look_json IS NOT NULL AND blob_id IS NULL)
      OR (kind = 'photo' AND character_id IS NULL AND look_json IS NULL AND blob_id GLOB '[0-9a-f]*'))
);
CREATE UNIQUE INDEX user_avatars_blob_id ON user_avatars(blob_id) WHERE blob_id IS NOT NULL;
