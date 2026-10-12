'use strict';
const { mintId } = require('../ids');
const { isHash } = require('../../security/password');
const { withTx } = require('../tx');
function createUsersRepo(db, { now = Date.now } = {}) {
  const owner = db.prepare('SELECT * FROM users WHERE id=(SELECT owner_user_id FROM authorization_state WHERE singleton=1)');
  const byEmail = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND status<>'deleted' LIMIT 1");
  const byId = db.prepare('SELECT * FROM users WHERE id=?');
  return {
    owner: () => owner.get() || null,
    byId: id => typeof id==='string' ? byId.get(id)||null : null,
    authGeneration: (id) => (id ? byId.get(id) : owner.get())?.auth_generation ?? 0,
    prepareLegacy(ttlMs) {
      if(!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new Error('invalid session lifetime');
      const applied=db.prepare('SELECT applied_at FROM schema_migrations WHERE version=24').get()?.applied_at ?? now();
      if(!Number.isSafeInteger(applied+ttlMs))throw new Error('invalid session lifetime');
      db.prepare('UPDATE authorization_state SET legacy_cookie_deadline=? WHERE singleton=1 AND legacy_cookie_deadline IS NULL').run(applied+ttlMs);
    },
    ensureEnv({email,personId,fingerprint}) {
      if(typeof email!=='string'||email.length>320||!/^[^@\s]+@[^@\s]+$/.test(email)||!/^[a-f0-9]{64}$/.test(fingerprint||''))throw new Error('invalid env identity');
      return withTx(db,()=>{
        const current=owner.get(),state=db.prepare('SELECT * FROM authorization_state WHERE singleton=1').get(),at=now();
        if(!current) {
          const id=mintId('usr');
          db.prepare("INSERT INTO users(id,person_id,email,role_id,status,credential_source,created_at,updated_at) VALUES (?,?,?,'rol_admin','active','env',?,?)").run(id,personId,email.trim().toLowerCase(),at,at);
          db.prepare('UPDATE authorization_state SET owner_user_id=?,env_fingerprint=? WHERE singleton=1').run(id,fingerprint);
        } else {
          if(current.status==='deleted')throw new Error('historical identity deleted');
          const sourceChanged=current.credential_source!=='env',changed=sourceChanged || state.env_fingerprint!==null && state.env_fingerprint!==fingerprint;
          db.prepare('DELETE FROM user_overrides WHERE user_id=?').run(current.id);
          db.prepare("UPDATE users SET email=?,password_hash=NULL,role_id='rol_admin',status='active',credential_source='env',auth_generation=auth_generation+?,permission_revision=permission_revision+?,updated_at=? WHERE id=?")
            .run(email.trim().toLowerCase(),changed?1:0,sourceChanged?1:0,at,current.id);
          if(changed)db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(at,current.id);
          db.prepare('UPDATE authorization_state SET env_fingerprint=? WHERE singleton=1').run(fingerprint);
        }
        return owner.get();
      });
    },
    touchSeen(id) {return db.prepare("UPDATE users SET last_seen_at=? WHERE id=? AND status='active' AND (last_seen_at IS NULL OR last_seen_at<=?)").run(now(),id,now()-60000).changes;},
    rotatePassword(passwordHash) {
      if (!isHash(passwordHash)) throw new Error('invalid owner credential');
      return withTx(db,()=>{
        const current = owner.get(); if (!current || current.credential_source!=='database' || current.status!=='active') throw new Error('owner missing');
        db.prepare('UPDATE users SET password_hash=?, auth_generation=auth_generation+1, updated_at=? WHERE id=?').run(passwordHash, now(), current.id);
        // Legacy Settings callers read the owner generation through this repository.
        db.prepare("UPDATE settings_state SET value=value+1 WHERE key='auth_generation'").run();
      });
    },
    credential: (email) => byEmail.get(String(email).trim().toLowerCase()) || null,
    amendOwner({ email, passwordHash, personId }) {
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('invalid owner credential');
      const current = owner.get();
      if (!current) return this.createOwner({ email, passwordHash, personId });
      if (passwordHash != null && !isHash(passwordHash)) throw new Error('invalid owner credential');
      if(current.credential_source!=='database' || current.status!=='active') throw new Error('invalid owner credential');
      db.prepare('UPDATE users SET email = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(email.trim().toLowerCase(), passwordHash || current.password_hash, now(), current.id);
      return owner.get();
    },
    createOwner({ email, passwordHash, personId }) {
      if (!isHash(passwordHash) || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('invalid owner credential');
      return withTx(db,()=>{
        if (owner.get()) throw Object.assign(new Error('owner already exists'), { code: 'EOWNER' });
        const t = now(), id=mintId('usr');
        db.prepare("INSERT INTO users (id,person_id,email,password_hash,role_id,status,credential_source,created_at,updated_at) VALUES (?,?,?,?,'rol_admin','active','database',?,?)")
          .run(id,personId,email.trim().toLowerCase(),passwordHash,t,t);
        db.prepare('UPDATE authorization_state SET owner_user_id=? WHERE singleton=1').run(id);
        return owner.get();
      });
    },
  };
}
module.exports = { createUsersRepo };
