'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store'),{createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {createApp}=require('../../src/api/http'),{createCsrfGuard}=require('../../src/api/csrf'),{createHumanAuthTransport}=require('../../src/api/human-auth');
const {createAccessBoundary}=require('../../src/security/access-boundary'),{createRefreshLimits}=require('../../src/security/refresh-limits'),{createLoginThrottle}=require('../../src/security/login-throttle');
const {createViewProjection}=require('../../src/security/view-projection'),{buildMeVM}=require('../../src/api/v2/vm/meta');
const ORIGIN='https://office.example.invalid';let hash;before(async()=>{hash=await hashPassword('synthetic-transport-password');});
async function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-human-auth-')),store=openStore({dir,instance:'test',ownerName:'Synthetic admin',log:()=>{}}),cfg={readonly:!!options.readonly,readonlyStore:true};
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash}),ctx={userId:admin.id,authGeneration:admin.auth_generation,requestId:'req_fixture',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'reader@example.invalid',name:'Reader',roleId:'rol_reader'},ctx);store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});const reader=store.users.byId(invite.user.id);
  const throttle=createLoginThrottle(),auth=createAuth({secret:'synthetic-cookie-secret',ttlMs:3600000,passwordHash:options.recoveryHash||hash,email:admin.email,identity:{users:store.users,state:store.rbac.state},revocations:store.sessions,allowMultiUser:true,allowRecoveryLogin:!!options.recoveryHash,throttle});
  let policy=createAccessBoundary({installationId:store.rbac.state().installation_id,apiPublicUrl:'https://api.example.invalid/backend',origins:[ORIGIN]}),verifications=0;
  const projector=createViewProjection({store,cfg}),verify=async(...args)=>{verifications++;return options.verify?options.verify(auth,...args):auth.verifyAdmittedCredentials(...args);};
  const transport=createHumanAuthTransport({store,auth,boundary:()=>policy,partitioned:!!options.partitioned,timeoutMs:options.timeoutMs||15000,limits:options.limits||createRefreshLimits(),verify,me:session=>projector.project(session.userId,'me',buildMeVM({session,cfg,engine:{gateway:()=>({connected:false})},ownerName:()=>store.owner.name}))});
  const app=createApp({readonly:cfg.readonly,readonlyStore:true,publicDir:path.resolve('public'),apiOnly:true,trustProxy:options.trustProxy===undefined?'loopback':options.trustProxy,routeSecurity:{store,auth},humanTransport:transport,csrf:createCsrfGuard(),mountRoutes:app=>auth.mountRoutes(app,{isGwConnected:()=>false})});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  async function request(body,{headers={},cookie=null,csrf=null,signal,path='/api/auth/refresh',raw}={}) {
    const res=await fetch(base+path,{method:'POST',headers:{origin:ORIGIN,'x-ao-request':'1','content-type':'application/json','x-forwarded-proto':'https',...(cookie?{cookie}:{}),...(csrf?{'x-ao-csrf':csrf}:{}),...headers},body:raw===undefined?JSON.stringify(body):raw,signal});
    return {status:res.status,headers:res.headers,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function challenge(purpose='login',cookie=null){return request({operation:'challenge',purpose},{cookie});}
  async function login(user=reader,cookie=null,extra={}){const c=await challenge('login',cookie);assert.equal(c.status,200);return request({operation:'login',email:user.email,password:'synthetic-transport-password'},{cookie,csrf:c.body.csrfToken,...extra});}
  return {store,admin,reader,ctx,auth,throttle,base,request,challenge,login,verifications:()=>verifications,policy:()=>policy,setPolicy:origins=>{policy=createAccessBoundary({installationId:store.rbac.state().installation_id,apiPublicUrl:'https://api.example.invalid/backend',origins});}};
}
test('actual guarded refresh endpoint uses the prefix-scoped secure cookie, current MeVM and digested one-use rotation',async t=>{
  const f=await fixture(t,{partitioned:true,readonly:true});
  const preflight=await fetch(f.base+'/API/AUTH/REFRESH/',{method:'OPTIONS',headers:{origin:ORIGIN,'x-forwarded-proto':'https','access-control-request-method':'POST','access-control-request-headers':'content-type,x-ao-request,x-ao-csrf'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');assert.equal(f.verifications(),0);
  const login=await f.login();assert.equal(login.status,200);assert.match(login.body.accessToken,/^ao_at_/);assert.equal(login.body.me.user.id,f.reader.id);assert.equal(login.body.me.displayName,'Reader');assert.equal(login.body.me.permissions.logs,'none');assert.equal(login.body.me.permissionRevision.user,f.reader.permission_revision);
  const setCookie=login.headers.get('set-cookie');assert.match(setCookie,/^__Secure-ao_refresh=ao_rt_/);for(const part of ['HttpOnly','Secure','SameSite=None','Path=/backend/api/auth/refresh','Partitioned'])assert.ok(setCookie.includes(part),part);assert.ok(!setCookie.includes('Domain='));assert.ok(!setCookie.includes('taco_sess'));assert.equal(login.headers.get('cache-control'),'no-store');assert.equal(login.headers.get('access-control-allow-origin'),ORIGIN);
  const challenge=await f.challenge('refresh',login.cookie);assert.equal(challenge.status,200);
  const rotated=await f.request({operation:'refresh'},{cookie:login.cookie,csrf:challenge.body.csrfToken});assert.equal(rotated.status,200);assert.notEqual(rotated.cookie,login.cookie);assert.notEqual(rotated.body.accessToken,login.body.accessToken);assert.equal(rotated.body.me.user.id,f.reader.id);
  assert.equal(f.store.humanTokens.resolveAccess(rotated.body.accessToken,{audience:f.policy().audience,origin:ORIGIN}).ok,true);
  const audit=f.store.audit.recent().find(e=>e.command==='auth.refresh'&&e.outcome==='ok');assert.equal(audit.actor.personId,f.reader.person_id);assert.equal(audit.origin,ORIGIN);const data=JSON.stringify(f.store.audit.recent());for(const raw of [login.body.accessToken,rotated.body.accessToken,login.cookie.split('=')[1],challenge.body.csrfToken,'synthetic-transport-password'])assert.ok(!data.includes(raw));
});
test('split-origin recovery credentials cannot mint bearer or refresh families',async t=>{
  const recoveryPassword='synthetic-environment-recovery-password',recoveryHash=await hashPassword(recoveryPassword),f=await fixture(t,{recoveryHash});
  const challenge=await f.challenge('login');assert.equal(challenge.status,200);
  const login=await f.request({operation:'login',email:f.admin.email,password:recoveryPassword},{csrf:challenge.body.csrfToken});
  assert.equal(login.status,401);assert.equal(login.body.error.code,'unauthorized');
  assert.equal(login.body.accessToken,undefined);assert.equal(login.cookie,undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM human_access_tokens').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,0);
  const refreshChallenge=await f.challenge('refresh');assert.equal(refreshChallenge.status,401);
  const refresh=await f.request({operation:'refresh'},{csrf:refreshChallenge.body.csrfToken});assert.equal(refresh.status,401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,0);
});
test('split-origin auth refuses transport without HTTPS from a trusted proxy',async t=>{
  const f=await fixture(t);
  const refused=await f.request({operation:'challenge',purpose:'login'},{headers:{'x-forwarded-proto':'http'}});
  assert.equal(refused.status,403);assert.equal(refused.body.error.details[0].issue,'https-required');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_bootstrap_challenges').get().n,0);
  assert.equal(f.verifications(),0);
  const untrusted=await fixture(t,{trustProxy:false});
  const spoofed=await untrusted.request({operation:'challenge',purpose:'login'});
  assert.equal(spoofed.status,403);assert.equal(spoofed.body.error.details[0].issue,'https-required');
});
test('HTTP lost-response exact replay revokes the successor and expires only the presented refresh cookie',async t=>{
  const f=await fixture(t),login=await f.login(),independent=await f.login(f.admin),c=await f.challenge('refresh',login.cookie),args={cookie:login.cookie,csrf:c.body.csrfToken};
  const rotated=await f.request({operation:'refresh'},args);assert.equal(rotated.status,200);
  const replay=await f.request({operation:'refresh'},args);assert.equal(replay.status,401);assert.match(replay.headers.get('set-cookie'),/^__Secure-ao_refresh=;/);assert.ok(replay.headers.get('set-cookie').includes('Max-Age=0'));assert.ok(replay.headers.get('set-cookie').includes('Path=/backend/api/auth/refresh'));
  assert.equal(f.store.humanTokens.resolveAccess(rotated.body.accessToken,{audience:f.policy().audience,origin:ORIGIN}).issue,'unauthorized');assert.equal(f.store.humanTokens.resolveAccess(independent.body.accessToken,{audience:f.policy().audience,origin:ORIGIN}).ok,true);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,3);
});
test('HTTP token login verifies and revokes the actual same-user taco_sess while leaving another account cookie untouched',async t=>{
  const f=await fixture(t),exp=Date.now()+60000,sid='synthetic-real-cookie',legacy='taco_sess='+f.auth.signSession({email:f.reader.email,userId:f.reader.id,authGeneration:f.reader.auth_generation,exp,sid});
  const result=await f.login(f.reader,legacy);assert.equal(result.status,200);assert.equal(f.auth.sessionOf({headers:{cookie:legacy}}),null);
  const family=f.store.db.prepare('SELECT * FROM auth_families').get();assert.equal(family.linked_cookie_sid,sid);assert.equal(family.linked_cookie_expires_at,exp);
  const other='taco_sess='+f.auth.signSession({email:f.admin.email,userId:f.admin.id,authGeneration:f.admin.auth_generation,exp,sid:'synthetic-other-cookie'});
  assert.equal((await f.login(f.reader,other)).status,200);assert.equal(f.auth.sessionOf({headers:{cookie:other}}).userId,f.admin.id);
});
test('media/parser/header/origin/duplicate-cookie refusals happen before password work and mint no credentials',async t=>{
  const variants=[
    {status:400,raw:'{bad'}, {status:413,raw:JSON.stringify({operation:'login',password:'x'.repeat(5000)})},
    {status:415,headers:{'content-type':'text/plain'}},{status:415,headers:{'content-encoding':'gzip'}},{status:415,headers:{'content-type':'application/json; charset=iso-8859-1'}},
    {status:403,headers:{'x-ao-request':'0'}},{status:403,headers:{authorization:'Bearer ao_at_invalid'}},{status:403,headers:{authorization:''}},
    {status:403,headers:{origin:'null'}},{status:403,headers:{origin:'https://evil.example.invalid'}},{status:403,headers:{origin:'',referer:ORIGIN+'/'}},
    {status:401,cookie:'__Secure-ao_refresh=ao_rt_invalid; __Secure-ao_refresh=ao_rt_other'},{status:400,path:'/api/auth/refresh?token=synthetic'},
    {status:401},{status:400,body:{operation:'login',email:'a',password:'b',userId:'forged'}}
  ];
  for(const v of variants) {
    const f=await fixture(t),res=await f.request(v.body||{operation:'login',email:f.reader.email,password:'synthetic-transport-password'},v);assert.equal(res.status,v.status,JSON.stringify(v));assert.equal(f.verifications(),0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
    assert.ok(f.store.audit.recent().some(e=>e.command==='auth.refresh'||e.command==='auth.login'));for(const e of f.store.audit.recent())assert.ok(e.origin===undefined||e.origin===null||e.origin===ORIGIN);
  }
});
test('live config and generation changes after password verification prevent committing captured authority',async t=>{
  for(const change of ['policy','generation']) {
    let release,arrived;const ready=new Promise(r=>arrived=r),barrier=new Promise(r=>release=r);
    const f=await fixture(t,{verify:async(auth,...args)=>{const result=await auth.verifyAdmittedCredentials(...args);arrived();await barrier;return result;}}),c=await f.challenge(),promise=f.request({operation:'login',email:f.reader.email,password:'synthetic-transport-password'},{csrf:c.body.csrfToken});
    await ready;if(change==='policy')f.setPolicy([]);else f.store.userManagement.revoke(f.reader.id,{expectedRevision:1},f.ctx);release();
    const result=await promise;assert.equal(result.status,change==='policy'?403:401);assert.equal(result.cookie,undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);if(change==='policy')assert.equal(result.headers.get('access-control-allow-origin'),null);
  }
});
test('timed out and disconnected HTTP login cannot commit and keeps its shared hash admission until settlement',async t=>{
  for(const variant of ['timeout','disconnect']) {
    let release,arrived;const ready=new Promise(r=>arrived=r),barrier=new Promise(r=>release=r);
    const f=await fixture(t,{timeoutMs:variant==='timeout'?200:15000,verify:async(auth,req,...args)=>{const result=await auth.verifyAdmittedCredentials(req,...args);arrived(req);await barrier;return result;}}),c=await f.challenge(),controller=new AbortController(),promise=f.request({operation:'login',email:f.reader.email,password:'synthetic-transport-password'},{csrf:c.body.csrfToken,signal:controller.signal});
    const req=await ready;
    if(variant==='disconnect'){const closed=new Promise(r=>req.res.once('close',r));controller.abort();await assert.rejects(promise);await closed;}else assert.equal((await promise).status,408);
    assert.equal(f.throttle._state().inflightAll,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);release();
    for(let i=0;i<100&&f.throttle._state().inflightAll;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.throttle._state().inflightAll,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
  }
});
test('family refresh rate survives successor-token changes; trusted proxy supplies the client IP bucket',async t=>{
  const f=await fixture(t,{limits:createRefreshLimits({ipLimit:100,familyLimit:4})}),login=await f.login();let cookie=login.cookie;
  for(let i=0;i<2;i++){const c=await f.challenge('refresh',cookie);assert.equal(c.status,200);const result=await f.request({operation:'refresh'},{cookie,csrf:c.body.csrfToken});assert.equal(result.status,200);cookie=result.cookie;}
  const denied=await f.challenge('refresh',cookie);assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,3);
  const ip=await fixture(t,{limits:createRefreshLimits({ipLimit:2})});for(let i=0;i<2;i++)assert.equal((await ip.challenge()).status,200);assert.equal((await ip.request({operation:'challenge',purpose:'login'})).status,429);
});
test('logout is purpose-bound, clears identical cookie attributes and revokes its family; already absent is idempotent',async t=>{
  const f=await fixture(t,{partitioned:true}),login=await f.login(),c=await f.challenge('logout',login.cookie),result=await f.request({operation:'logout'},{cookie:login.cookie,csrf:c.body.csrfToken});assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true});assert.ok(result.headers.get('set-cookie').includes('Partitioned'));assert.ok(result.headers.get('set-cookie').includes('Path=/backend/api/auth/refresh'));assert.equal(f.store.humanTokens.resolveAccess(login.body.accessToken,{audience:f.policy().audience,origin:ORIGIN}).issue,'unauthorized');assert.equal(f.store.audit.recent().find(e=>e.command==='auth.logout').actor.personId,f.reader.person_id);
  assert.equal((await f.request({operation:'logout'})).status,200);
});
test('refresh limits count refusals, retain active buckets at capacity and use rolling expiry',()=>{
  let now=0;const limits=createRefreshLimits({now:()=>now,ipLimit:2,familyLimit:2,maxIps:2,maxFamilies:1});
  assert.equal(limits.admit('ip-a','family-a').ok,true);assert.equal(limits.admit('ip-b','family-a').ok,true);assert.equal(limits.admit('ip-c').ok,false,'cannot evict active IP');assert.equal(limits.admit('ip-a','family-b').ok,false,'cannot evict active family');assert.equal(limits.admit('ip-a','family-a').ok,false);
  now=59999;assert.equal(limits.admit('ip-a','family-a').ok,false);now=60001;assert.equal(limits.admit('ip-b','family-a').ok,true);assert.equal(limits.admit('ip-a','family-a').ok,false,'recent refusal stays counted across a fixed-minute boundary');now=120002;assert.equal(limits.admit('ip-c','family-b').ok,true);
});
test('audit origin accepts canonical HTTPS or absence and rejects unchecked origin/header/token values',async t=>{
  const f=await fixture(t),entry={at:Date.now(),requestId:'req_origin',actor:{kind:'anonymous'},command:'auth.refresh',target:null,outcome:'rejected',detail:'unauthorized'};
  for(const origin of ['null','*','https://*.example.invalid','http://office.example.invalid',ORIGIN+'/','ao_at_synthetic',ORIGIN+'\n'])assert.throws(()=>f.store.audit.append({...entry,origin}),/schema/);
  f.store.audit.append({...entry,origin:ORIGIN});assert.equal(f.store.audit.recent().find(e=>e.requestId==='req_origin').origin,ORIGIN);
});
test('audit failure rolls back successful login replacement and rotation before any cookie/token is returned',async t=>{
  const f=await fixture(t),previous=await f.login(f.admin),c=await f.challenge('login',previous.cookie);
  f.store.db.exec("CREATE TRIGGER synthetic_auth_audit BEFORE INSERT ON audit_log WHEN NEW.command='auth.login' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  const options={cookie:previous.cookie,csrf:c.body.csrfToken},body={operation:'login',email:f.reader.email,password:'synthetic-transport-password'};
  const failed=await f.request(body,options);assert.equal(failed.status,500);assert.equal(failed.cookie,undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,1);assert.equal(f.store.humanTokens.resolveAccess(previous.body.accessToken,{audience:f.policy().audience,origin:ORIGIN}).ok,true);
  f.store.db.exec('DROP TRIGGER synthetic_auth_audit');const login=await f.request(body,options);assert.equal(login.status,200);
  const rc=await f.challenge('refresh',login.cookie),refreshOptions={cookie:login.cookie,csrf:rc.body.csrfToken},before=f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n;
  f.store.db.exec("CREATE TRIGGER synthetic_auth_audit BEFORE INSERT ON audit_log WHEN NEW.command='auth.refresh' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  const rotation=await f.request({operation:'refresh'},refreshOptions);assert.equal(rotation.status,500);assert.equal(rotation.cookie,undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,before);
  f.store.db.exec('DROP TRIGGER synthetic_auth_audit');assert.equal((await f.request({operation:'refresh'},refreshOptions)).status,200);
});
test('unauthenticated challenges and empty logout preserve actual HTTP password failures and IP lockout',async t=>{
  const f=await fixture(t);
  const fail=()=>f.request({email:f.reader.email,password:'wrong-synthetic-password'},{path:'/api/login'});
  for(let i=0;i<5;i++)assert.equal((await fail()).status,401);
  const before=f.throttle._state();assert.equal(before.global,5);assert.equal(before.ips,1);
  for(let i=0;i<3;i++) {
    assert.equal((await f.challenge()).status,200);
    assert.equal((await f.request({operation:'logout'})).status,200);
    assert.deepEqual(f.throttle._state(),before,'protocol success must not change password failures');
  }
  assert.equal((await fail()).status,401); // sixth failure starts the IP lock
  assert.equal((await fail()).status,429);
  assert.equal((await f.challenge()).status,200);assert.equal((await f.request({operation:'logout'})).status,200);
  assert.equal((await fail()).status,429,'protocol success cannot clear an active IP lock');
});
test('protocol requests cannot refund distributed password failures or clear global lockout',async t=>{
  const f=await fixture(t);
  for(let i=0;i<20;i++) {
    const gate=f.auth.reserveCredentialAttempt({ip:'synthetic-distributed-'+i});assert.equal(gate.ok,true);gate.release(false);
  }
  const before=f.throttle._state();assert.equal(before.global,20);
  for(let i=0;i<3;i++) {
    assert.equal((await f.challenge()).status,200);assert.equal((await f.request({operation:'logout'})).status,200);
    assert.deepEqual(f.throttle._state(),before,'distributed failure history remains unchanged');
  }
  const gate=f.auth.reserveCredentialAttempt({ip:'synthetic-distributed-next'});assert.equal(gate.ok,true);gate.release(false);
  assert.equal(f.throttle.check('synthetic-unrelated').scope,'global');const locked=f.throttle._state();
  assert.equal((await f.challenge()).status,200);assert.equal((await f.request({operation:'logout'})).status,200);
  assert.deepEqual(f.throttle._state(),locked);assert.equal(f.auth.reserveCredentialAttempt({ip:'synthetic-unrelated'}).scope,'global');
  const c=await f.challenge(),result=await f.request({operation:'login',email:f.reader.email,password:'synthetic-transport-password'},{csrf:c.body.csrfToken});
  assert.equal(result.status,429);assert.ok(Number(result.headers.get('retry-after'))>0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
});
test('valid refresh and logout preserve password failures; only a committed password login refunds its attempt',async t=>{
  const f=await fixture(t),login=await f.login();
  for(let i=0;i<5;i++)assert.equal((await f.request({email:f.reader.email,password:'wrong-synthetic-password'},{path:'/api/login'})).status,401);
  const before=f.throttle._state(),rc=await f.challenge('refresh',login.cookie);
  const rotated=await f.request({operation:'refresh'},{cookie:login.cookie,csrf:rc.body.csrfToken});assert.equal(rotated.status,200);assert.deepEqual(f.throttle._state(),before);
  const lc=await f.challenge('logout',rotated.cookie);assert.equal((await f.request({operation:'logout'},{cookie:rotated.cookie,csrf:lc.body.csrfToken})).status,200);assert.deepEqual(f.throttle._state(),before);
  assert.equal((await f.login()).status,200);assert.equal(f.throttle._state().ips,0);assert.equal(f.throttle._state().global,5,'only the verified attempt is removed from global history');
});
