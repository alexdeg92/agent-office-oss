-- ao:foreign-keys-off
-- Keep tombstoned identities and their audit/session references, but allow a
-- new user id to be invited to the same address after the old account is deleted.
DROP TRIGGER last_admin_update;
DROP TRIGGER last_admin_delete;
DROP TRIGGER admin_promotion_overrides;
DROP TRIGGER admin_override_insert;
DROP TRIGGER admin_override_update;

CREATE TABLE users_email_reuse (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES persons(id),
  email TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  role_id TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL CHECK(status IN ('invited','active','disabled','deleted')),
  credential_source TEXT NOT NULL CHECK(credential_source IN ('database','env','oidc')),
  auth_generation INTEGER NOT NULL DEFAULT 0 CHECK(auth_generation>=0),
  permission_revision INTEGER NOT NULL DEFAULT 1 CHECK(permission_revision>=1),
  last_seen_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(status<>'active' OR credential_source<>'database' OR password_hash IS NOT NULL),
  CHECK(status<>'deleted' OR (password_hash IS NULL AND deleted_at IS NOT NULL))
);
INSERT INTO users_email_reuse SELECT id,person_id,email,password_hash,role_id,status,credential_source,
  auth_generation,permission_revision,last_seen_at,deleted_at,created_at,updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_email_reuse RENAME TO users;
CREATE UNIQUE INDEX users_live_email ON users(email COLLATE NOCASE) WHERE status<>'deleted';

CREATE TRIGGER last_admin_update BEFORE UPDATE OF role_id,status ON users
 WHEN OLD.status='active' AND OLD.role_id='rol_admin'
 AND (NEW.status<>'active' OR NEW.role_id<>'rol_admin')
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND status='active' AND role_id='rol_admin')
 BEGIN SELECT RAISE(ABORT,'last-active-admin'); END;
CREATE TRIGGER last_admin_delete BEFORE DELETE ON users
 WHEN OLD.status='active' AND OLD.role_id='rol_admin'
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND status='active' AND role_id='rol_admin')
 BEGIN SELECT RAISE(ABORT,'last-active-admin'); END;
CREATE TRIGGER admin_promotion_overrides BEFORE UPDATE OF role_id ON users
 WHEN NEW.role_id='rol_admin' AND EXISTS(SELECT 1 FROM user_overrides WHERE user_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'admin-overrides'); END;
CREATE TRIGGER admin_override_insert BEFORE INSERT ON user_overrides
 WHEN (SELECT role_id FROM users WHERE id=NEW.user_id)='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER admin_override_update BEFORE UPDATE ON user_overrides
 WHEN (SELECT role_id FROM users WHERE id=NEW.user_id)='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
