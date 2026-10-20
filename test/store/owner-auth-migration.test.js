'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../../src/store');
const {prepareAuthIdentity}=require('../../src/security/auth-identity');
const {hashPassword}=require('../../src/security/password');

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-owner-auth-migration-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic legacy owner',now:()=>1700000000000,log:()=>{}});
  t.after(()=>{try{store.close();}catch{}});
  return store;
}

test('first configured boot converts the same env owner once and a later env change cannot replace it',async t=>{
  const store=await fixture(t),hash=await hashPassword('synthetic-owner-password',{N:2**14});
  const envOwner=store.users.ensureEnv({email:'owner@example.invalid',personId:store.owner.id,fingerprint:'a'.repeat(64)});
  const before=store.users.owner();
  const cfg={authDatabase:false,loginEmail:'owner@example.invalid',loginPassword:null,passwordHash:hash,sessionSecret:'synthetic-session-secret',sessionTtlMs:3600000};
  await prepareAuthIdentity({cfg,store});
  const converted=store.users.owner();
  assert.equal(converted.id,envOwner.id);assert.equal(converted.person_id,envOwner.person_id);
  assert.equal(converted.email,'owner@example.invalid');assert.equal(converted.credential_source,'database');
  assert.equal(converted.password_hash,hash);assert.equal(converted.auth_generation,before.auth_generation+1);
  assert.equal(store.db.prepare('SELECT env_fingerprint FROM authorization_state').get().env_fingerprint,null);
  const generation=converted.auth_generation,revision=converted.permission_revision;
  await prepareAuthIdentity({cfg:{...cfg,loginEmail:'changed@example.invalid',loginPassword:'changed-env-password'},store});
  const again=store.users.owner();
  assert.equal(again.id,converted.id);assert.equal(again.email,converted.email);assert.equal(again.password_hash,hash);
  assert.equal(again.auth_generation,generation);assert.equal(again.permission_revision,revision);
});

test('an incomplete env credential refuses conversion without modifying the owner or marker',async t=>{
  const store=await fixture(t);
  store.users.ensureEnv({email:'owner@example.invalid',personId:store.owner.id,fingerprint:'b'.repeat(64)});
  const before=store.users.owner();
  assert.throws(()=>prepareAuthIdentity({cfg:{authDatabase:false,loginEmail:'owner@example.invalid',loginPassword:null,passwordHash:null,sessionSecret:'synthetic-session-secret',sessionTtlMs:3600000},store}));
  const after=store.users.owner();
  assert.equal(after.id,before.id);assert.equal(after.credential_source,'env');assert.equal(after.auth_generation,before.auth_generation);
});

test('in-place rollback restores verified env owner profile and preserves application rows',async t=>{
  const store=await fixture(t),hash=await hashPassword('synthetic-owner-password',{N:2**14});
  const envOwner=store.users.ensureEnv({email:'owner@example.invalid',personId:store.owner.id,fingerprint:'c'.repeat(64)});
  const cfg={authDatabase:false,loginEmail:'owner@example.invalid',loginPassword:null,passwordHash:hash,sessionSecret:'synthetic-session-secret',sessionTtlMs:3600000};
  await prepareAuthIdentity({cfg,store});
  store.office.seen([{id:'agent:rollback-sentinel',role:'agent',name:'Rollback sentinel'}]);
  const before=store.users.owner();
  const rolled=store.users.rollbackEnvOwner({email:'owner@example.invalid',displayName:'Synthetic legacy owner',fingerprint:'d'.repeat(64),personId:envOwner.person_id});
  assert.equal(rolled.id,envOwner.id);assert.equal(rolled.credential_source,'env');assert.equal(rolled.password_hash,null);
  assert.equal(rolled.email,'owner@example.invalid');assert.equal(rolled.auth_generation,before.auth_generation+1);
  assert.equal(store.db.prepare('SELECT name FROM persons WHERE id=?').get(envOwner.person_id).name,'Synthetic legacy owner','pre-migration release receives the configured environment display name');
  assert.equal(store.db.prepare("SELECT 1 FROM office_agents_seen WHERE occupant_id='agent:rollback-sentinel'").get()?.['1'],1);
  assert.equal(store.db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get().state,'rolled_back');
});
