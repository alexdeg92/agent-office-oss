CREATE TABLE users (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role = 'owner';
