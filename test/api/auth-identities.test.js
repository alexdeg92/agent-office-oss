'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const express=require('express');
const {openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
let hash,otherHash;
before(async()=>{[hash,otherHash]=await Promise.all([hashPassword('synthetic-admin-password'),hashPassword('synthetic-reader-password')]);});
async function fixture(t,{env=false,multi=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-auth-identities-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic admin',log:()=>{}});
  const fp=value=>crypto.createHmac('sha256','synthetic-private-key').update(value).digest('hex');
  const admin=env ? store.users.ensureEnv({email:'admin@example.invalid',personId:store.owner.id,fingerprint:fp('env-v1')})
    : store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:admin.auth_generation,requestId:'req_invite',authorize:()=>{}};
  const link=store.userManagement.invite({name:'Reader',email:'reader@example.invalid',roleId:'rol_reader'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:otherHash},{requestId:'req_accept'});
  const reader=store.users.byId(link.user.id);
  store.users.prepareLegacy(3600000);
  const auth=createAuth({secret:'synthetic-cookie-secret',ttlMs:3600000,passwordHash:hash,identity:{users:store.users,state:store.rbac.state},allowMultiUser:multi,revocations:store.sessions,audit:e=>store.audit.append(e)});
  const app=express();app.use(express.json());auth.mountRoutes(app,{isGwConnected:()=>false});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function login(email,password) {
    const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
    return {status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0],body:await res.json()};
  }
  return {store,admin,reader,auth,fp,login,base:'http://127.0.0.1:'+server.address().port,ctx};
}
test('identity cookies resolve the actual database actor, confirmation validates that user, generation revocation is targeted',async t=>{
  const f=await fixture(t),admin=await f.login(f.admin.email,'synthetic-admin-password'),reader=await f.login(f.reader.email,'synthetic-reader-password');
  assert.equal(admin.status,200);assert.equal(reader.status,200);
  const req={headers:{cookie:reader.cookie},ip:'synthetic'},session=f.auth.sessionOf(req);
  assert.equal(session.userId,f.reader.id);assert.equal(session.personId,f.reader.person_id);
  assert.deepEqual(await f.auth.confirmPassword(req,'synthetic-admin-password'),{ok:false});
  assert.deepEqual(await f.auth.confirmPassword(req,'synthetic-reader-password'),{ok:true});
  assert.equal(f.store.audit.recent().find(e=>e.command==='auth.login').actor.personId,f.reader.person_id);
  f.store.userManagement.revoke(f.reader.id,{expectedRevision:1},f.ctx);
  assert.equal(f.auth.sessionOf(req),null);
  assert.equal(f.auth.sessionOf({headers:{cookie:admin.cookie}}).userId,f.admin.id);
  const seen=f.store.users.byId(f.admin.id).last_seen_at;assert.ok(seen);assert.equal(f.store.users.touchSeen(f.admin.id),0);
});
test('env identity is stable, does not persist its credential and permits independent invited database login',async t=>{
  const f=await fixture(t,{env:true}),admin=await f.login(f.admin.email,'synthetic-admin-password');assert.equal(admin.status,200);
  const again=f.store.users.ensureEnv({email:f.admin.email,personId:f.admin.person_id,fingerprint:f.fp('env-v1')});
  assert.equal(again.id,f.admin.id);assert.equal(again.auth_generation,f.admin.auth_generation);assert.equal(again.password_hash,null);
  assert.equal((await f.login(f.reader.email,'synthetic-reader-password')).status,200);
  assert.equal((await f.login(f.reader.email,'synthetic-admin-password')).status,401,'env credential never falls back for a database user');
  const changed=f.store.users.ensureEnv({email:f.admin.email,personId:f.admin.person_id,fingerprint:f.fp('env-v2')});
  assert.equal(changed.auth_generation,again.auth_generation+1);assert.equal(f.auth.sessionOf({headers:{cookie:admin.cookie}}),null);
  for(const operation of [()=>f.store.userManagement.editUser(changed.id,{expectedRevision:changed.permission_revision,roleId:'rol_reader'},{...f.ctx,authGeneration:changed.auth_generation}),()=>f.store.userManagement.deleteUser(changed.id,{expectedRevision:changed.permission_revision},{...f.ctx,authGeneration:changed.auth_generation}),()=>f.store.userManagement.resetPassword(changed.id,{expectedRevision:changed.permission_revision},{...f.ctx,authGeneration:changed.auth_generation})])assert.throws(operation,/external-account/);
});
test('legacy env cookies map only to the historical identity and expire at the persisted migration window; sid-less logout revokes copies',async t=>{
  const f=await fixture(t,{env:true}),state=f.store.rbac.state();
  const legacy=f.auth.signSession({email:f.reader.email,exp:Date.now()+60000});
  const req={headers:{cookie:'taco_sess='+legacy}};
  assert.equal(f.auth.sessionOf(req).userId,f.admin.id,'signed legacy email never selects another user');
  assert.equal(f.auth.verifySession(f.auth.signSession({email:f.admin.email,exp:state.legacy_cookie_deadline+1})),null);
  assert.equal(f.auth.verifySession(legacy+'.extra'),null);
  assert.equal(f.auth.verifySession(f.auth.signSession({email:f.admin.email,authGeneration:1,exp:Date.now()+60000})),null);
  const res=await fetch(f.base+'/api/logout',{method:'POST',headers:{cookie:req.headers.cookie,'content-type':'application/json'},body:'{}'});assert.equal(res.status,200);
  assert.equal(f.auth.sessionOf(req),null,'a copied no-sid cookie is also revoked');
  const deadline=f.store.rbac.state().legacy_cookie_deadline;f.store.users.prepareLegacy(7200000);assert.equal(f.store.rbac.state().legacy_cookie_deadline,deadline,'restart/config changes do not extend migration grace');
  f.store.db.prepare('UPDATE authorization_state SET legacy_cookie_deadline=?').run(Date.now()-1);
  assert.equal(f.auth.verifySession(f.auth.signSession({email:f.admin.email,exp:Date.now()+60000})),null);
});
test('an identity-aware compatibility checkpoint cannot enable other human logins accidentally',async t=>{
  const f=await fixture(t,{multi:false});assert.equal((await f.login(f.admin.email,'synthetic-admin-password')).status,200);
  assert.equal((await f.login(f.reader.email,'synthetic-reader-password')).status,401);
  const readerCookie=f.auth.signSession({userId:f.reader.id,authGeneration:f.reader.auth_generation,sid:'synthetic-previously-issued',exp:Date.now()+60000});
  assert.equal(f.auth.verifySession(readerCookie),null,'owner-only verification also refuses previously issued non-owner sessions');
});
test('authenticated legacy upgrade preserves expiry and a shared revocation id for the original cookie',async t=>{
  for(const sid of [null,'synthetic-pre-upgrade-sid']) {
    const f=await fixture(t,{env:true}),exp=Date.now()+60000;
    const old=f.auth.signSession({email:f.admin.email,exp,...(sid?{sid}:{})});
    const req={headers:{cookie:'taco_sess='+old}},session=f.auth.sessionOf(req);
    const response=await fetch(f.base+'/api/me',{headers:req.headers});assert.equal(response.status,200);
    const upgraded=response.headers.get('set-cookie').split(';')[0],modern=f.auth.sessionOf({headers:{cookie:upgraded}});
    assert.equal(modern.userId,f.admin.id);assert.equal(modern.exp,exp);assert.equal(modern.sid,sid||session.legacyId);assert.equal(modern.legacy,undefined);
    assert.equal((await fetch(f.base+'/api/logout',{method:'POST',headers:{cookie:upgraded,'content-type':'application/json'},body:'{}'})).status,200);
    assert.equal(f.auth.sessionOf(req),null);assert.equal(f.auth.sessionOf({headers:{cookie:upgraded}}),null);
  }
});
test('login rechecks the target generation after asynchronous password verification',async t=>{
  const f=await fixture(t),read=f.store.users.credential;
  f.store.users.credential=email=>{
    const account=read(email);
    if(account?.id===f.reader.id)queueMicrotask(()=>f.store.userManagement.revoke(f.reader.id,{expectedRevision:1},f.ctx));
    return account;
  };
  const result=await f.login(f.reader.email,'synthetic-reader-password');
  assert.equal(result.status,401);assert.equal(result.cookie,undefined);
});
test('an OIDC identity cannot use another account password while its provider login is unimplemented',async t=>{
  const f=await fixture(t);
  f.store.db.prepare("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES ('per_oidc','human','OIDC',0,1,1)").run();
  f.store.db.prepare("INSERT INTO users(id,person_id,email,role_id,status,credential_source,created_at,updated_at) VALUES ('usr_oidc','per_oidc','oidc@example.invalid','rol_reader','active','oidc',1,1)").run();
  assert.equal((await f.login('oidc@example.invalid','synthetic-admin-password')).status,401);
  const cookie=f.auth.signSession({userId:'usr_oidc',authGeneration:0,sid:'synthetic-oidc-session',exp:Date.now()+60000});
  assert.deepEqual(await f.auth.confirmPassword({headers:{cookie:'taco_sess='+cookie},ip:'synthetic'},'synthetic-admin-password'),{ok:false},'owner password cannot reauthenticate an OIDC identity');
});
test('env password cannot reauthenticate a signed unsupported-provider identity',async t=>{
  const f=await fixture(t,{env:true});
  f.store.db.prepare("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES ('per_oidc','human','OIDC',0,1,1)").run();
  f.store.db.prepare("INSERT INTO users(id,person_id,email,role_id,status,credential_source,created_at,updated_at) VALUES ('usr_oidc','per_oidc','oidc@example.invalid','rol_reader','active','oidc',1,1)").run();
  const cookie=f.auth.signSession({userId:'usr_oidc',authGeneration:0,sid:'synthetic-oidc-session',exp:Date.now()+60000});
  assert.deepEqual(await f.auth.confirmPassword({headers:{cookie:'taco_sess='+cookie},ip:'synthetic'},'synthetic-admin-password'),{ok:false});
});
test('store observers are isolated and once observers retain EventEmitter semantics',async t=>{
  const f=await fixture(t);let calls=0,once=0;
  f.store.authorizationEvents.on('change',()=>{throw new Error('synthetic-observer-fault');});
  f.store.authorizationEvents.on('change',()=>calls++);
  f.store.authorizationEvents.once('change',()=>once++);
  f.store.userManagement.createRole({name:'One'},f.ctx);f.store.userManagement.createRole({name:'Two'},f.ctx);
  assert.equal(calls,2);assert.equal(once,1);
});
test('admitted password verification binds one derivation to this auth instance/request and returns only current identity',async t=>{
  const f=await fixture(t),req={ip:'synthetic-admission',headers:{}},input={email:f.reader.email,password:'synthetic-reader-password'},gate=f.auth.reserveCredentialAttempt(req);
  for(const candidate of [undefined,{ok:true,release:()=>{}}])await assert.rejects(f.auth.verifyAdmittedCredentials(req,input,candidate),/requires current admission/);
  await assert.rejects(f.auth.verifyAdmittedCredentials({...req},input,gate),/requires current admission/);
  const other=createAuth({secret:'synthetic-other',ttlMs:3600000,passwordHash:hash});await assert.rejects(other.verifyAdmittedCredentials(req,input,gate),/requires current admission/);
  const pending=f.auth.verifyAdmittedCredentials(req,input,gate);await assert.rejects(f.auth.verifyAdmittedCredentials(req,input,gate),/requires current admission/);
  const verified=await pending;assert.deepEqual(verified,{ok:true,identity:{email:f.reader.email,userId:f.reader.id,personId:f.reader.person_id,authGeneration:f.reader.auth_generation}});
  gate.release(true);await assert.rejects(f.auth.verifyAdmittedCredentials(req,input,gate),/requires current admission/);
});
test('withdrawing an admitted verification keeps its expensive-work slot until hashing settles and cannot return an identity',async()=>{
  const {createLoginThrottle}=require('../../src/security/login-throttle'),throttle=createLoginThrottle();
  const auth=createAuth({secret:'synthetic',ttlMs:3600000,email:'synthetic@example.invalid',passwordHash:hash,throttle});
  const req={ip:'synthetic-release'},gate=auth.reserveCredentialAttempt(req),pending=auth.verifyAdmittedCredentials(req,{email:'synthetic@example.invalid',password:'synthetic-admin-password'},gate);
  gate.release(true);assert.equal(throttle._state().inflightAll,1,'abandoned hash still occupies admission');
  assert.deepEqual(await pending,{ok:false});assert.equal(throttle._state().inflightAll,0);assert.equal(throttle._state().global,1,'withdrawn attempt is never refunded');gate.release(true);assert.equal(throttle._state().inflightAll,0);
});
test('concurrency-only credential admission cannot refund without verification and promotes before hashing',async()=>{
  const {createLoginThrottle}=require('../../src/security/login-throttle');let now=1000;
  const throttle=createLoginThrottle({now:()=>now}),auth=createAuth({secret:'synthetic',ttlMs:3600000,email:'synthetic@example.invalid',passwordHash:hash,throttle});
  const req={ip:'synthetic-work'};
  for(let i=0;i<5;i++){const gate=auth.reserveCredentialAttempt(req);gate.release(false);}
  const before=throttle._state(),work=auth.reserveCredentialWork(req);assert.equal(work.beginPassword,undefined);work.release(true);assert.deepEqual(throttle._state(),before);
  const one=auth.reserveCredentialWork(req),two=auth.reserveCredentialWork(req);assert.equal(auth.reserveCredentialWork(req).scope,'busy');
  const pending=auth.verifyAdmittedCredentials(req,{email:'synthetic@example.invalid',password:'wrong-synthetic-password'},one);
  assert.equal(throttle._state().global,6,'password attempt is counted synchronously before hashing');
  assert.equal(throttle.check(req.ip).scope,'ip');
  assert.equal((await auth.verifyAdmittedCredentials(req,{email:'synthetic@example.invalid',password:'synthetic-admin-password'},two)).retryAfterSec,2);
  two.release(true);assert.equal(throttle._state().global,6,'blocked promotion cannot refund');assert.equal((await pending).ok,false);one.release(true);assert.equal(throttle._state().global,6,'incorrect password cannot refund even when caller requests success');
  now+=2001;const success=auth.reserveCredentialWork(req);assert.equal((await auth.verifyAdmittedCredentials(req,{email:'synthetic@example.invalid',password:'synthetic-admin-password'},success)).ok,true);success.release(true);
  assert.equal(throttle._state().ips,0);assert.equal(throttle._state().global,6);assert.equal(throttle._state().inflightAll,0);
});
test('ordinary credential reservation honors both lock scopes and a denial at its second clock check',()=>{
  const {createLoginThrottle}=require('../../src/security/login-throttle');
  for(const scope of ['ip','global']) {
    let now=1000,reads=null;const throttle=createLoginThrottle({now:()=>reads?.length?reads.shift():now});
    const auth=createAuth({secret:'synthetic',ttlMs:60000,passwordHash:hash,throttle});
    for(let i=0;i<(scope==='ip'?6:21);i++)throttle.failure(scope==='ip'?'synthetic-locked':'synthetic-source-'+i);
    const before=throttle._state(),req={ip:scope==='ip'?'synthetic-locked':'synthetic-new'};
    const denied=auth.reserveCredentialAttempt(req);assert.equal(denied.ok,false);assert.equal(denied.scope,scope);assert.equal(denied.retryAfterSec,2);assert.deepEqual(throttle._state(),before);
    // Permit the first check at the deadline, then move the wall clock back
    // before promotion. The second denial must release its acquired slot.
    reads=[3000,1000];const changed=auth.reserveCredentialAttempt(req);assert.equal(changed.ok,false);assert.equal(changed.scope,scope);assert.equal(changed.retryAfterSec,2);assert.deepEqual(throttle._state(),before);
  }
});
