-- ao:foreign-keys-off
CREATE TABLE users_owner (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'owner'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO users_owner SELECT * FROM users;
DROP TABLE users;
ALTER TABLE users_owner RENAME TO users;
CREATE UNIQUE INDEX users_one_owner ON users(role);
CREATE TABLE store_meta_setup (
  key TEXT PRIMARY KEY CHECK (key IN ('instance', 'created_at', 'setup_status', 'setup_config_hash')),
  value TEXT NOT NULL
);
INSERT INTO store_meta_setup SELECT * FROM store_meta;
DROP TABLE store_meta;
ALTER TABLE store_meta_setup RENAME TO store_meta;
CREATE TABLE office_agents_seen_peers (
  occupant_id TEXT PRIMARY KEY CHECK (length(occupant_id) BETWEEN 1 AND 213),
  role TEXT NOT NULL CHECK (role IN ('primary','agent','subagent','scheduled','direct','group','conversation')),
  name TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
INSERT INTO office_agents_seen_peers SELECT * FROM office_agents_seen;
DROP TABLE office_agents_seen;
ALTER TABLE office_agents_seen_peers RENAME TO office_agents_seen;
