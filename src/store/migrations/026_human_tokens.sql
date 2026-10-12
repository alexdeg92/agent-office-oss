-- ADR-003: opaque human credentials. All credential material is digested at rest.
CREATE TABLE auth_families (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
  audience TEXT NOT NULL CHECK(length(audience) BETWEEN 1 AND 1024),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>=0),
  created_at INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL CHECK(absolute_expires_at>created_at),
  linked_cookie_sid TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK(revoked_reason IS NULL OR revoked_reason IN ('logout','reuse','logout-everywhere','credentials-changed','origin-removed','audience-changed','login-replaced','expired')),
  CHECK(idle_expires_at>created_at AND idle_expires_at<=absolute_expires_at)
);
CREATE INDEX auth_families_user ON auth_families(user_id);
CREATE TABLE human_access_tokens (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64),
  family_id TEXT NOT NULL REFERENCES auth_families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>=0),
  role_id TEXT NOT NULL, -- historical claim; a revoked/stale token must not prevent role deletion
  role_revision INTEGER NOT NULL CHECK(role_revision>=1),
  permission_revision INTEGER NOT NULL CHECK(permission_revision>=1),
  registry_revision INTEGER NOT NULL CHECK(registry_revision>=1),
  revoked_at INTEGER
);
CREATE INDEX human_access_family ON human_access_tokens(family_id);
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64),
  family_id TEXT NOT NULL REFERENCES auth_families(id) ON DELETE CASCADE,
  parent_id TEXT UNIQUE REFERENCES refresh_tokens(id),
  successor_id TEXT UNIQUE REFERENCES refresh_tokens(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER
);
CREATE INDEX refresh_family ON refresh_tokens(family_id);
CREATE TABLE stream_tickets (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64),
  user_id TEXT NOT NULL REFERENCES users(id),
  family_id TEXT REFERENCES auth_families(id) ON DELETE CASCADE,
  cookie_sid TEXT,
  origin TEXT NOT NULL,
  audience TEXT NOT NULL,
  topics_json TEXT NOT NULL CHECK(json_valid(topics_json)),
  fingerprint TEXT NOT NULL,
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER,
  revoked_at INTEGER,
  resume_json TEXT CHECK(resume_json IS NULL OR json_valid(resume_json)),
  CHECK((family_id IS NULL)<>(cookie_sid IS NULL))
);
CREATE INDEX stream_tickets_family ON stream_tickets(family_id);
CREATE TABLE auth_bootstrap_challenges (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64),
  purpose TEXT NOT NULL CHECK(purpose IN ('login','refresh','logout')),
  origin TEXT NOT NULL,
  family_id TEXT REFERENCES auth_families(id) ON DELETE CASCADE,
  refresh_digest TEXT CHECK(refresh_digest IS NULL OR length(refresh_digest)=64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER,
  CHECK((purpose='login') OR (family_id IS NOT NULL AND refresh_digest IS NOT NULL))
);
CREATE INDEX auth_challenges_expiry ON auth_bootstrap_challenges(expires_at);
ALTER TABLE audit_log ADD COLUMN origin TEXT;
