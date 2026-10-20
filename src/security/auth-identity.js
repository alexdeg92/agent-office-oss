'use strict';
const crypto=require('node:crypto');
const {isHash,hashPasswordSync}=require('./password');
// Boot-only binding. Store a keyed change detector, never the environment credential itself.
function prepareAuthIdentity({cfg,store}) {
  store.users.prepareLegacy(cfg.sessionTtlMs);
  const email=String(cfg.loginEmail||'').trim().toLowerCase();
  const fingerprint=crypto.createHmac('sha256',cfg.sessionSecret)
    .update(JSON.stringify(['agent-office/env-credential/v1',email,cfg.passwordHash?'hash':'password',cfg.passwordHash||cfg.loginPassword]))
    .digest('hex');
  let current=store.users.owner();
  if(!current&&!cfg.authDatabase)current=store.users.ensureEnv({email,personId:store.owner.id,fingerprint});
  if(!current)throw new Error('database identity unavailable');
  const migration=store.db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get();
  if(!migration)throw new Error('owner migration marker unavailable');
  let authDatabase=cfg.authDatabase===true;
  if(migration.state==='rolled_back') {
    if(!cfg.authDatabase)store.users.ensureEnv({email,personId:store.owner.id,fingerprint});
    else if(store.users.owner().credential_source!=='database')throw new Error('database identity unavailable');
    authDatabase=cfg.authDatabase===true;
  } else {
    let passwordHash=cfg.passwordHash;
    if(!isHash(passwordHash)&&typeof cfg.loginPassword==='string'&&cfg.loginPassword.length)passwordHash=hashPasswordSync(cfg.loginPassword);
    if(!isHash(passwordHash)&&current.credential_source==='database')passwordHash=current.password_hash;
    const result=store.users.migrateEnvOwner({email,personId:store.owner.id,passwordHash,fingerprint});
    authDatabase=true;
    if(result.converted)store.audit.append({at:Date.now(),requestId:'req_owner_auth_migration',actor:{kind:'system',component:'engine'},command:'auth.owner.migrate',target:null,outcome:'ok',detail:'env-to-database'});
  }
  return {users:store.users,state:store.rbac.state,authDatabase};
}
module.exports={prepareAuthIdentity};
