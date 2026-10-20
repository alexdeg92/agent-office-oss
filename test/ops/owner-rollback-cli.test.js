'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../../src/store');
const {hashPassword}=require('../../src/security/password');
const cli=require('../../packaging/bin/agent-office');

async function migratedStore(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-owner-rollback-cli-'));
  let store=openStore({dir,instance:'test',ownerName:'Current database name',log:()=>{}});
  t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  const personId=store.owner.id,owner=store.users.ensureEnv({email:'legacy@example.invalid',personId,fingerprint:'a'.repeat(64)});
  const envHash=await hashPassword('synthetic-legacy-env-password',{N:2**14});
  store.users.migrateEnvOwner({email:owner.email,personId,passwordHash:await hashPassword('synthetic-database-password',{N:2**14}),fingerprint:'b'.repeat(64)});
  store.office.seen([{id:'agent:rollback-preserved',role:'agent',name:'Preserved row'}]);
  store.close();store=null;
  const reopen=()=>openStore({dir,instance:'test',ownerName:'Current database name',log:()=>{}});
  return {dir,reopen,owner,envHash};
}

test('owner rollback CLI dry-run is read-only and apply requires verified environment credentials',async t=>{
  const f=await migratedStore(t),env={AO_ENV:'test',AO_DATA_DIR:f.dir,PORTAL_EMAIL:'legacy@example.invalid',PORTAL_DISPLAY_NAME:'Legacy environment name',PORTAL_SECRET:'synthetic-session-secret-for-owner-rollback',PORTAL_PASSWORD_HASH:f.envHash};
  let out='',err='';const io={stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},readPassword:async()=> 'synthetic-legacy-env-password'};
  const dry=await cli.main(['node','agent-office','owner','rollback-env','--dry-run'],env,io);
  assert.equal(dry,0,err);assert.match(out,/dry-run/i);let store=f.reopen();assert.equal(store.users.owner().credential_source,'database');store.close();
  out='';const denied=await cli.main(['node','agent-office','owner','rollback-env','--apply'],{...env,PORTAL_PASSWORD_HASH:await hashPassword('different-password',{N:2**14})},io);
  assert.equal(denied,1);store=f.reopen();assert.equal(store.users.owner().credential_source,'database');assert.equal(store.db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get().state,'complete');store.close();
  out='';const applied=await cli.main(['node','agent-office','owner','rollback-env','--apply'],env,io);
  assert.equal(applied,0,err);assert.match(out,/rollback complete/i);
  store=f.reopen();const current=store.users.owner();assert.equal(current.id,f.owner.id);assert.equal(current.email,'legacy@example.invalid');assert.equal(current.credential_source,'env');assert.equal(current.password_hash,null);
  assert.equal(store.db.prepare('SELECT name FROM persons WHERE id=?').get(current.person_id).name,'Legacy environment name');
  assert.equal(store.db.prepare("SELECT 1 FROM office_agents_seen WHERE occupant_id='agent:rollback-preserved'").get()?.['1'],1);
  assert.equal(store.db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get().state,'rolled_back');
  assert.ok(store.audit.recent().some(row=>row.command==='auth.owner.rollbackEnv'));
  assert.doesNotMatch(out+err,/legacy@example|synthetic-legacy-env-password|synthetic-session-secret/);
  store.close();
});
