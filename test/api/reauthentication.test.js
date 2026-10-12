'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
const {createReauthentication,WINDOW_MS}=require('../../src/security/reauthentication');
let adminHash,userHash;before(async()=>{[adminHash,userHash]=await Promise.all([hashPassword('synthetic-admin-password'),hashPassword('synthetic-user-password')]);});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-reauthentication-')),store=openStore({dir,instance:'test',ownerName:'Admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:adminHash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_reauth',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'editor@example.invalid',name:'Éditeur',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:userHash},{requestId:'req_accept'});
  const user=store.users.byId(invite.user.id),clock={wall:Date.now(),monotonic:0};
  const auth=createAuth({secret:'synthetic-reauth-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true,revocations:store.sessions});
  const service=createReauthentication({store,auth,now:()=>clock.wall,elapsed:()=>clock.monotonic});
  const request=(row=user,sid='synthetic-session')=>({headers:{cookie:'taco_sess='+auth.signSession({userId:row.id,authGeneration:row.auth_generation,sid,exp:Date.now()+60000})},ip:'synthetic',user:row,authorize:()=>{}});
  t.after(()=>{service.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,auth,service,clock,admin,user,ctx,request};
}
test('actual credential confirmation cannot inherit the owner password, another user or another session',async t=>{
  const f=fixture(t),req=f.request();
  assert.throws(()=>f.service.requireRecent(req),{code:'forbidden'});
  await assert.rejects(f.service.confirm(req,'synthetic-admin-password'),{code:'unauthorized'});
  const proof=await f.service.confirm(req,'synthetic-user-password');assert.equal(proof.expiresAt,f.clock.wall+WINDOW_MS);
  assert.equal(f.service.requireRecent(req).userId,f.user.id);
  assert.equal(f.service.expiresAt(f.request(f.admin)),null,'same sid for another user is distinct');
  assert.equal(f.service.expiresAt(f.request(f.user,'different-session')),null);
  f.service.clear(req);assert.equal(f.service.expiresAt(req),null);
});
test('confirmation expires on the monotonic clock even when wall time moves backwards',async t=>{
  const f=fixture(t),req=f.request();await f.service.confirm(req,'synthetic-user-password');
  f.clock.wall-=3600000;f.clock.monotonic=WINDOW_MS-1;assert.ok(f.service.expiresAt(req));
  f.clock.monotonic=WINDOW_MS;assert.equal(f.service.expiresAt(req),null);assert.throws(()=>f.service.requireRecent(req),{code:'forbidden'});
});
test('grant/role/registry revisions and target generation revoke only the affected confirmations',async t=>{
  const f=fixture(t),userReq=f.request(),adminReq=f.request(f.admin);
  await f.service.confirm(userReq,'synthetic-user-password');await f.service.confirm(adminReq,'synthetic-admin-password');
  f.store.userManagement.editRole('rol_editor',{expectedRevision:1,permissions:[{resource:'office',level:'read'}]},f.ctx);
  assert.equal(f.service.expiresAt(userReq),null);assert.ok(f.service.expiresAt(adminReq));
  await f.service.confirm(userReq,'synthetic-user-password');
  f.store.db.prepare('UPDATE users SET permission_revision=permission_revision+1 WHERE id=?').run(f.user.id);
  assert.equal(f.service.expiresAt(userReq),null,'live fingerprint works without notification');
  await f.service.confirm(userReq,'synthetic-user-password');
  f.store.userManagement.revoke(f.user.id,{expectedRevision:2},f.ctx);
  assert.equal(f.service.expiresAt(userReq),null);assert.ok(f.service.expiresAt(adminReq));
  f.store.registry.register([{key:'flows.futurereauth',parent:'flows',labelKey:'permissions.flows.futurereauth',privileged:false}],'core');f.store.rbac.sync(f.store.registry);
  assert.equal(f.service.expiresAt(adminReq),null);
});
test('a role mutation or credential swap during asynchronous password verification cannot establish proof',async t=>{
  const f=fixture(t),req=f.request(),original=f.auth.confirmPassword;
  for(const mutate of [()=>f.store.db.prepare('UPDATE roles SET revision=revision+1 WHERE id=?').run(f.user.role_id),()=>f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id)]) {
    let finish,entered;const started=new Promise(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
    f.auth.confirmPassword=async()=>{entered();await pending;return {ok:true};};
    const proof=f.service.confirm(req,'synthetic-user-password');await started;mutate();finish();
    await assert.rejects(proof,{code:'unauthorized'});assert.equal(f.service.expiresAt(req),null);
  }
  f.auth.confirmPassword=original;
});
test('shared throttle errors propagate retry-after, machine/unknown credentials fail, and close removes observers',async t=>{
  const f=fixture(t),req=f.request(),headers={};
  f.auth.confirmPassword=async()=>({ok:false,rateLimit:{retryAfterSec:9}});
  await assert.rejects(f.service.confirm(req,'synthetic-user-password',{setHeader:(key,value)=>headers[key]=value}),{code:'rate_limited'});assert.equal(headers['Retry-After'],'9');
  assert.throws(()=>f.service.requireRecent({...req,principal:{kind:'agent'}}),{code:'unauthorized'});
  assert.throws(()=>f.service.requireRecent({headers:{},authorize:()=>{}}),{code:'unauthorized'});
  const before=f.store.authorizationEvents.listenerCount('change');f.service.close();assert.equal(f.store.authorizationEvents.listenerCount('change'),before-1);
  assert.throws(()=>f.service.requireRecent(req),{code:'unauthorized'});
});
test('family linked-session revocation clears its confirmation immediately and preserves same-user independent sessions',async t=>{
  const f=fixture(t),linked=f.request(f.user,'synthetic-linked-confirm'),other=f.request(f.user,'synthetic-independent-confirm');
  await f.service.confirm(linked,'synthetic-user-password');await f.service.confirm(other,'synthetic-user-password');
  const issued=f.store.humanTokens.createFamily({userId:f.user.id,expectedGeneration:f.user.auth_generation,origin:'https://office.example.invalid',audience:'synthetic@https://api.example.invalid',linkedCookieSid:'synthetic-linked-confirm',linkedCookieExpiresAt:Date.now()+60000});
  f.store.humanTokens.revokeFamily(issued.familyId,'logout');assert.equal(f.service.expiresAt(linked),null);assert.ok(f.service.expiresAt(other));
});
