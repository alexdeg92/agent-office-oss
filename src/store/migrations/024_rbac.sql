-- ao:foreign-keys-off
-- ADR-002: migrate identity, never recreate the owner's stable ids or generation.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  builtin INTEGER NOT NULL CHECK(builtin IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO roles VALUES
 ('rol_admin','admin','Administrateur',1,1,0,0),
 ('rol_editor','editor','Éditeur',1,1,0,0),
 ('rol_reader','reader','Lecteur',1,1,0,0);
CREATE TABLE permission_resources (
  key TEXT PRIMARY KEY,
  parent TEXT REFERENCES permission_resources(key),
  namespace TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
INSERT INTO permission_resources(key,namespace) VALUES
 ('office','core'),('chat','core'),('flows','core'),('projects','core'),
 ('access','core'),('logs','core'),('skills','core'),('health','core'),('store','core'),
 ('settings.runtimes','core'),('settings.integrations','core'),('settings.instance','core'),
 ('settings.network','core'),('settings.restart','core'),('users','core'),('gateway.restart','core');
INSERT INTO permission_resources(key,parent,namespace) VALUES
 ('flows.create','flows','core'),('flows.edit','flows','core'),('flows.run','flows','core'),
 ('flows.enable','flows','core'),('flows.delete','flows','core'),
 ('projects.comment','projects','core'),('projects.regenerate','projects','core');
CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  resource TEXT NOT NULL REFERENCES permission_resources(key),
  mode TEXT NOT NULL CHECK(mode IN ('explicit','inherit-parent')),
  level TEXT CHECK(level IN ('none','read','write')),
  PRIMARY KEY(role_id,resource),
  CHECK((mode='explicit' AND level IS NOT NULL) OR (mode='inherit-parent' AND level IS NULL))
);
INSERT INTO role_permissions(role_id,resource,mode,level)
 SELECT 'rol_editor',key,'explicit',CASE
   WHEN key IN ('chat','flows','projects','skills','store') THEN 'write'
   WHEN key IN ('office','access','logs','health') THEN 'read'
   ELSE 'none' END FROM permission_resources WHERE parent IS NULL;
INSERT INTO role_permissions(role_id,resource,mode,level)
 SELECT 'rol_reader',key,'explicit',CASE
   WHEN key IN ('office','chat','flows','projects','skills','health','store') THEN 'read'
   ELSE 'none' END FROM permission_resources WHERE parent IS NULL;
-- Only this closed, reviewed child list is seeded. Future registry additions get no rows.
INSERT INTO role_permissions(role_id,resource,mode,level)
 SELECT roles.id,key,'inherit-parent',NULL FROM permission_resources CROSS JOIN roles
 WHERE parent IS NOT NULL AND roles.id IN ('rol_editor','rol_reader');
CREATE TABLE authorization_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL,
  registry_revision INTEGER NOT NULL DEFAULT 1 CHECK(registry_revision>=1),
  owner_user_id TEXT REFERENCES users(id),
  legacy_cookie_deadline INTEGER,
  legacy_cookie_generation INTEGER NOT NULL,
  env_fingerprint TEXT
);
INSERT INTO authorization_state(singleton,installation_id,owner_user_id,legacy_cookie_generation)
 SELECT 1,lower(hex(randomblob(16))),(SELECT id FROM users WHERE role='owner'),
 (SELECT value FROM settings_state WHERE key='auth_generation');
CREATE TABLE users_rbac (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES persons(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
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
INSERT INTO users_rbac(id,person_id,email,password_hash,role_id,status,credential_source,auth_generation,created_at,updated_at)
 SELECT id,person_id,email,password_hash,'rol_admin','active','database',
 (SELECT value FROM settings_state WHERE key='auth_generation'),created_at,updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_rbac RENAME TO users;
CREATE TABLE user_overrides (
  user_id TEXT NOT NULL REFERENCES users(id),
  resource TEXT NOT NULL REFERENCES permission_resources(key),
  level TEXT NOT NULL CHECK(level IN ('none','read','write')),
  PRIMARY KEY(user_id,resource)
);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('invite','password-reset')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER,
  revoked_at INTEGER,
  target_generation INTEGER NOT NULL,
  target_revision INTEGER NOT NULL
);
CREATE INDEX invitations_user ON invitations(user_id,purpose);
CREATE TABLE permission_audit_changes (
  audit_id INTEGER PRIMARY KEY REFERENCES audit_log(id) ON DELETE CASCADE,
  changes_json TEXT NOT NULL CHECK(json_valid(changes_json))
);
CREATE TRIGGER last_admin_update BEFORE UPDATE OF role_id,status ON users
 WHEN OLD.status='active' AND OLD.role_id='rol_admin'
 AND (NEW.status<>'active' OR NEW.role_id<>'rol_admin')
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND status='active' AND role_id='rol_admin')
 BEGIN SELECT RAISE(ABORT,'last-active-admin'); END;
CREATE TRIGGER last_admin_delete BEFORE DELETE ON users
 WHEN OLD.status='active' AND OLD.role_id='rol_admin'
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND status='active' AND role_id='rol_admin')
 BEGIN SELECT RAISE(ABORT,'last-active-admin'); END;
CREATE TRIGGER admin_role_update BEFORE UPDATE ON roles WHEN OLD.id='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER builtin_role_delete BEFORE DELETE ON roles WHEN OLD.builtin=1
 BEGIN SELECT RAISE(ABORT,'builtin-role'); END;
CREATE TRIGGER admin_permission_insert BEFORE INSERT ON role_permissions WHEN NEW.role_id='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER admin_permission_update BEFORE UPDATE ON role_permissions WHEN NEW.role_id='rol_admin' OR OLD.role_id='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER child_inheritance_insert BEFORE INSERT ON role_permissions
 WHEN NEW.mode='inherit-parent' AND (SELECT parent FROM permission_resources WHERE key=NEW.resource) IS NULL
 BEGIN SELECT RAISE(ABORT,'root-inheritance'); END;
CREATE TRIGGER child_inheritance_update BEFORE UPDATE ON role_permissions
 WHEN NEW.mode='inherit-parent' AND (SELECT parent FROM permission_resources WHERE key=NEW.resource) IS NULL
 BEGIN SELECT RAISE(ABORT,'root-inheritance'); END;
CREATE TRIGGER admin_override_insert BEFORE INSERT ON user_overrides
 WHEN (SELECT role_id FROM users WHERE id=NEW.user_id)='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER admin_override_update BEFORE UPDATE ON user_overrides
 WHEN (SELECT role_id FROM users WHERE id=NEW.user_id)='rol_admin'
 BEGIN SELECT RAISE(ABORT,'admin-immutable'); END;
CREATE TRIGGER admin_promotion_overrides BEFORE UPDATE OF role_id ON users
 WHEN NEW.role_id='rol_admin' AND EXISTS(SELECT 1 FROM user_overrides WHERE user_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'admin-overrides'); END;
