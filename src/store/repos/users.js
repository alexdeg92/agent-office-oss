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
    migrateEnvOwner({email,personId,passwordHash,fingerprint}) {
      if(typeof email!=='string'||email.length>320||!/^[^@\s]+@[^@\s]+$/.test(email)||!isHash(passwordHash)||!/^[a-f0-9]{64}$/.test(fingerprint||''))throw new Error('invalid owner migration');
      return withTx(db,()=>{
        const migration=db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get();
        const current=owner.get();
        if(!migration||!current||current.status!=='active')throw new Error('owner migration unavailable');
        if(migration.state==='complete') {
          if(current.credential_source!=='database')throw new Error('owner migration state mismatch');
          return {owner:current,converted:false,state:migration.state};
        }
        if(migration.state==='rolled_back') {
          if(current.credential_source!=='env')throw new Error('owner migration state mismatch');
          return {owner:current,converted:false,state:migration.state};
        }
        if(current.credential_source==='database') {
          const changed=db.prepare("UPDATE owner_auth_migration SET state='complete',completed_at=? WHERE singleton=1 AND state='pending'").run(now());
          if(changed.changes!==1)throw new Error('owner migration compare-and-swap failed');
          return {owner:current,converted:false,state:'complete'};
        }
        if(current.credential_source!=='env'||current.email!==email.trim().toLowerCase()||current.person_id!==personId)throw new Error('owner migration identity mismatch');
        const marked=db.prepare("UPDATE owner_auth_migration SET state='complete',completed_at=? WHERE singleton=1 AND state='pending'").run(now());
        if(marked.changes!==1)throw new Error('owner migration compare-and-swap failed');
        db.prepare("UPDATE users SET password_hash=?,role_id='rol_admin',status='active',credential_source='database',auth_generation=auth_generation+1,permission_revision=permission_revision+1,updated_at=? WHERE id=? AND credential_source='env' AND email=? AND person_id=?")
          .run(passwordHash,now(),current.id,email.trim().toLowerCase(),personId);
        if(!db.prepare('SELECT changes() AS n').get().n)throw new Error('owner migration owner compare-and-swap failed');
        db.prepare('UPDATE authorization_state SET env_fingerprint=NULL WHERE singleton=1').run();
        db.prepare('DELETE FROM user_overrides WHERE user_id=?').run(current.id);
        db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(now(),current.id);
        return {owner:owner.get(),converted:true,state:'complete'};
      });
    },
    rollbackEnvOwner({email,displayName,fingerprint,personId,auditWrite=null}) {
      if(typeof email!=='string'||email.length>320||!/^[^@\s]+@[^@\s]+$/.test(email)||typeof displayName!=='string'||!displayName.trim()||displayName.length>80||!/^[a-f0-9]{64}$/.test(fingerprint||''))throw new Error('invalid owner rollback');
      if(auditWrite!==null&&typeof auditWrite!=='function')throw new Error('invalid owner rollback audit');
      return withTx(db,()=>{
        const migration=db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get(),current=owner.get();
        if(migration?.state!=='complete'||!current||current.status!=='active'||current.credential_source!=='database'||current.person_id!==personId)throw new Error('owner rollback unavailable');
        const marked=db.prepare("UPDATE owner_auth_migration SET state='rolled_back',completed_at=NULL WHERE singleton=1 AND state='complete'").run();
        if(marked.changes!==1)throw new Error('owner rollback compare-and-swap failed');
        db.prepare("UPDATE users SET email=?,password_hash=NULL,role_id='rol_admin',credential_source='env',auth_generation=auth_generation+1,permission_revision=permission_revision+1,updated_at=? WHERE id=? AND credential_source='database'")
          .run(email.trim().toLowerCase(),now(),current.id);
        if(!db.prepare('SELECT changes() AS n').get().n)throw new Error('owner rollback owner compare-and-swap failed');
        db.prepare('UPDATE persons SET name=?,updated_at=? WHERE id=?').run(displayName.trim(),now(),personId);
        db.prepare('UPDATE authorization_state SET env_fingerprint=? WHERE singleton=1').run(fingerprint);
        db.prepare('DELETE FROM user_overrides WHERE user_id=?').run(current.id);
        auditWrite?.(owner.get());
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
