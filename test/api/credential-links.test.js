'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth');
const {hashPassword,verifyPassword}=require('../../src/security/password');
const {createLoginThrottle}=require('../../src/security/login-throttle');
const {createCredentialLinks}=require('../../src/api/credential-links');
const {createApp}=require('../../src/api/http');
const {createCsrfGuard}=require('../../src/api/csrf');
const {auditMiddleware}=require('../../src/api/audit');
const {errorMiddleware}=require('../../src/api/v2/errors');
let hash;before(async()=>{hash=await hashPassword('synthetic-chosen-password');});
async function fixture(t,{derivePassword,throttle,timeoutMs,readonly=false,onResponse,trustProxy=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-credential-links-')),store=openStore({dir,instance:'test',ownerName:'Admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_public',authorize:()=>{}};
  const auth=createAuth({secret:'synthetic-link-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true,throttle});
  const links=createCredentialLinks({store,auth,derivePassword,timeoutMs,readonly:()=>readonly});
  const app=createApp({readonly,apiOnly:true,trustProxy,publicDir:dir,credentialLinks:links,csrf:createCsrfGuard(),audit:auditMiddleware({store,sessionOf:req=>auth.sessionOf(req)}),
    mountRoutes:app=>{if(onResponse)app.use((req,res,next)=>{onResponse(req,res);next();});auth.mountRoutes(app,{isGwConnected:()=>false});links.mount(app);app.use(errorMiddleware());}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(body,{route='/api/auth/invitations/accept',headers={},raw=false,signal}={})=>{
    const res=await fetch(base+route,{method:'POST',signal,headers:{'content-type':'application/json',...headers},body:raw?body:JSON.stringify(body)});
    return {status:res.status,json:await res.json(),headers:res.headers};
  };
  let next=0;const invite=()=>store.userManagement.invite({name:'Invitée',email:'invite'+(++next)+'@example.invalid',roleId:'rol_reader'},ctx);
  return {store,auth,ctx,admin,request,invite,base};
}
const password='synthetic-chosen-password';
test('IP and global lockouts refuse login, confirmation and both link purposes with Retry-After before derivation',async t=>{
  for(const scope of ['ip','global']) {
    const ip='203.0.113.90',throttle=createLoginThrottle({now:()=>1000});let hashes=0,verifications=0;
    const f=await fixture(t,{throttle,trustProxy:'loopback',derivePassword:async()=>{hashes++;return hash;}}),link=f.invite();
    const reset=f.store.userManagement.resetPassword(f.admin.id,{expectedRevision:1},f.ctx);
    const verifier=f.auth.verifyAdmittedCredentials;f.auth.verifyAdmittedCredentials=(...args)=>{verifications++;return verifier(...args);};
    for(let i=0;i<(scope==='ip'?6:21);i++)throttle.failure(scope==='ip'?ip:'synthetic-source-'+i);
    const before=throttle._state();
    for(const [route,body] of [
      ['/api/login',{email:f.admin.email,password}],
      ['/api/auth/invitations/accept',{token:link.token,password}],
      ['/api/auth/password-reset/accept',{token:reset.token,password}],
    ]) {
      const result=await f.request(body,{route,headers:{'x-forwarded-for':ip}});assert.equal(result.status,429,scope+' '+route);assert.equal(result.headers.get('retry-after'),'2');assert.deepEqual(throttle._state(),before);
    }
    const user=f.store.users.byId(f.admin.id),req={ip,headers:{cookie:'taco_sess='+f.auth.signSession({userId:user.id,authGeneration:user.auth_generation,sid:'synthetic-lockout',exp:Date.now()+60000})}};
    const reauth=require('../../src/security/reauthentication').createReauthentication({store:f.store,auth:f.auth});
    try {const headers={};await assert.rejects(reauth.confirm(req,password,{setHeader:(key,value)=>headers[key]=value}),{code:'rate_limited'});assert.equal(headers['Retry-After'],'2');}finally{reauth.close();}
    assert.deepEqual(throttle._state(),before);assert.equal(hashes,0);assert.equal(verifications,0);
    assert.equal(f.store.users.byId(link.user.id).status,'invited');
  }
});
test('public acceptance sets only the chosen credential, consumes once and issues no session; reset revokes old cookies',async t=>{
  const f=await fixture(t),link=f.invite();
  const accepted=await f.request({token:link.token,password});assert.equal(accepted.status,200);assert.deepEqual(accepted.json.data,{accepted:true});
  assert.equal(accepted.headers.get('set-cookie'),null);assert.equal(accepted.headers.get('cache-control'),'no-store');assert.equal(accepted.headers.get('referrer-policy'),'no-referrer');
  const user=f.store.users.byId(link.user.id);assert.equal(user.status,'active');assert.ok(await verifyPassword(password,user.password_hash));
  const replay=await f.request({token:link.token,password});assert.equal(replay.status,400);assert.deepEqual(replay.json.error.details,[{issue:'invalid-link'}]);
  const old=f.auth.signSession({userId:user.id,authGeneration:user.auth_generation,sid:'old',exp:Date.now()+60000});
  const reset=f.store.userManagement.resetPassword(user.id,{expectedRevision:user.permission_revision},f.ctx);
  assert.equal(f.auth.verifySession(old),null);
  const done=await f.request({token:reset.token,password},{route:'/api/auth/password-reset/accept'});assert.equal(done.status,200);assert.equal(done.headers.get('set-cookie'),null);
  const audit=f.store.audit.recent().filter(row=>['users.acceptInvitation','users.acceptReset'].includes(row.command));
  assert.equal(audit.filter(row=>row.outcome==='ok').length,2);assert.ok(audit.filter(row=>row.outcome==='ok').every(row=>row.actor.personId===user.person_id));
  assert.doesNotMatch(JSON.stringify(audit),/ao_inv_|ao_rst_|scrypt:|synthetic-chosen-password/);
});
test('two racing hashes run outside transactions and only one acceptance commits; privilege changes during hashing defeat the link',async t=>{
  let started=0,enter,release;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);
  let f;f=await fixture(t,{derivePassword:async()=>{assert.equal(f.store.db.isTransaction,false);if(++started===2)enter();await wait;return hash;}});
  const link=f.invite(),first=f.request({token:link.token,password}),second=f.request({token:link.token,password});
  await entered;release();const results=await Promise.all([first,second]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.equal(f.store.audit.recent().filter(row=>row.command==='users.acceptInvitation'&&row.outcome==='ok').length,1);
  let enteredRace,releaseRace;const raceEntered=new Promise(resolve=>enteredRace=resolve),raceWait=new Promise(resolve=>releaseRace=resolve);
  const g=await fixture(t,{derivePassword:async()=>{enteredRace();await raceWait;return hash;}}),pendingLink=g.invite();
  const pending=g.request({token:pendingLink.token,password});await raceEntered;
  g.store.userManagement.editUser(pendingLink.user.id,{expectedRevision:1,roleId:'rol_editor'},g.ctx);releaseRace();
  assert.equal((await pending).status,400);assert.equal(g.store.users.byId(pendingLink.user.id).password_hash,null);
});
test('acceptance audit failure rolls back consumption and permits a clean retry',async t=>{
  const f=await fixture(t,{derivePassword:async()=>hash}),link=f.invite(),append=f.store.audit.append;
  f.store.audit.append=row=>{if(row.command==='users.acceptInvitation'&&row.outcome==='ok')throw new Error('synthetic audit failure');return append(row);};
  const failed=await f.request({token:link.token,password});assert.equal(failed.status,500);assert.equal(f.store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at,null);
  assert.equal(f.store.users.byId(link.user.id).password_hash,null);f.store.audit.append=append;
  assert.equal((await f.request({token:link.token,password})).status,200);
});
test('admission precedes parsing and hashing, rejects oversized/chunked/compressed/strict bodies and shares login throttle',async t=>{
  let calls=0;const throttle=createLoginThrottle(),f=await fixture(t,{throttle,derivePassword:async()=>{calls++;return hash;}});
  const bad=await f.request('{',{raw:true});assert.equal(bad.status,400);assert.equal(throttle._state().global,1);assert.equal(throttle._state().inflightAll,0);assert.equal(calls,0);
  const big=await f.request({token:'ao_inv_'+'x'.repeat(43),password:'x'.repeat(5000)});assert.equal(big.status,413);assert.equal(calls,0);
  const chunk=await new Promise((resolve,reject)=>{
    const req=http.request(f.base+'/api/auth/invitations/accept',{method:'POST',headers:{'content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"password":"'+'x'.repeat(4500));req.end('"}');
  });assert.equal(chunk,413);assert.equal(calls,0);
  assert.equal((await f.request('{}',{raw:true,headers:{'content-encoding':'gzip'}})).status,415);
  assert.equal((await f.request({token:'ao_inv_'+'x'.repeat(43),password,actor:'spoof'})).status,400);
  assert.equal((await f.request({token:'ao_inv_'+'x'.repeat(43),password:'short'})).status,400);
  assert.equal(calls,0);
  const blocked=await f.request({token:'ao_inv_'+'x'.repeat(43),password});assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  const login=await fetch(f.base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.admin.email,password})});assert.equal(login.status,429,'acceptance failures lock the same login budget');
});
test('invalid, expired, revoked, wrong-purpose and used links share one fixed rejection; readonly/header/query paths never hash',async t=>{
  let calls=0;const throttle={reserve:()=>({ok:true,release:()=>{}})},f=await fixture(t,{throttle,derivePassword:async()=>{calls++;return hash;}});
  const expired=f.invite();f.store.db.prepare('UPDATE invitations SET created_at=0,expires_at=1').run();
  const revoked=f.invite();f.store.userManagement.resendInvitation(revoked.user.id,{expectedRevision:1},f.ctx);
  for(const token of ['ao_inv_'+'x'.repeat(43),expired.token,revoked.token]) {
    const result=await f.request({token,password});assert.equal(result.status,400);assert.deepEqual(result.json.error.details,[{issue:'invalid-link'}]);
  }
  const wrong=await f.request({token:f.invite().token,password},{route:'/api/auth/password-reset/accept'});assert.equal(wrong.status,400);assert.deepEqual(wrong.json.error.details,[{issue:'invalid-link'}]);
  const before=calls;
  assert.equal((await f.request({token:f.invite().token,password},{headers:{authorization:'Bearer machine'}})).status,403);
  assert.equal((await f.request({token:f.invite().token,password},{route:'/api/auth/invitations/accept?token=forbidden'})).status,400);
  const g=await fixture(t,{readonly:true,derivePassword:async()=>{calls++;return hash;}});
  assert.equal((await g.request({token:g.invite().token,password})).status,403);assert.equal(calls,before);
});
test('timed out or disconnected acceptance cannot commit after an awaited hash',async t=>{
  let release,enter;const wait=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
  const f=await fixture(t,{timeoutMs:50,derivePassword:async()=>{enter();await wait;return hash;}}),link=f.invite();
  const pending=f.request({token:link.token,password});await entered;const result=await pending;assert.equal(result.status,400);release();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.store.users.byId(link.user.id).password_hash,null);
  let start,finish,closed;const started=new Promise(resolve=>start=resolve),blocked=new Promise(resolve=>finish=resolve),disconnected=new Promise(resolve=>closed=resolve);let releases=0;
  const g=await fixture(t,{onResponse:(req,res)=>res.once('close',closed),throttle:{reserve:()=>({ok:true,release:()=>releases++})},derivePassword:async()=>{start();await blocked;return hash;}}),second=g.invite(),controller=new AbortController();
  const aborted=g.request({token:second.token,password},{signal:controller.signal}).catch(error=>error.name);await started;controller.abort();assert.equal(await aborted,'AbortError');
  await disconnected;assert.equal(releases,0);finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(releases,1);assert.equal(g.store.users.byId(second.user.id).password_hash,null);
});

test('disconnected pending hashes retain the real per-IP admission cap until each settles',async t=>{
  const actual=createLoginThrottle(),releaseCounts=[];const throttle={reserve:ip=>{const gate=actual.reserve(ip);if(!gate.ok)return gate;const i=releaseCounts.push(0)-1;return {...gate,release:ok=>{releaseCounts[i]++;gate.release(ok);}};}};
  let enter,release,closed,starts=0,closes=0;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve),disconnected=new Promise(resolve=>closed=resolve);
  const f=await fixture(t,{throttle,onResponse:(req,res)=>res.once('close',()=>{if(++closes===2)closed();}),derivePassword:async()=>{if(++starts===2)enter();await wait;return hash;}}),link=f.invite();
  const controllers=[new AbortController(),new AbortController()],pending=controllers.map(controller=>f.request({token:link.token,password},{signal:controller.signal}).catch(()=>null));
  await entered;controllers.forEach(c=>c.abort());await Promise.all(pending);await disconnected;
  assert.equal(actual._state().inflightAll,2);assert.deepEqual(releaseCounts,[0,0]);
  const third=await f.request({token:'ao_inv_'+'x'.repeat(43),password});assert.equal(third.status,429);assert.equal(third.headers.get('retry-after'),'1');assert.equal(starts,2);
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(actual._state().inflightAll,0);assert.deepEqual(releaseCounts,[1,1]);assert.equal(f.store.users.byId(link.user.id).password_hash,null);
});
test('timed-out pending hashes retain the real global cap; resolve and reject release each slot exactly once',async t=>{
  const actual=createLoginThrottle(),releaseCounts=[];const throttle={reserve:ip=>{const gate=actual.reserve(ip);if(!gate.ok)return gate;const i=releaseCounts.push(0)-1;return {...gate,release:ok=>{releaseCounts[i]++;gate.release(ok);}};}};
  let enter,release,starts=0;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{throttle,trustProxy:'loopback',timeoutMs:200,derivePassword:async()=>{const i=++starts;if(starts===16)enter();await wait;if(i===1)throw new Error('synthetic hash failure');return hash;}}),link=f.invite();
  const pending=Array.from({length:16},(_,i)=>f.request({token:link.token,password},{headers:{'x-forwarded-for':'10.0.1.'+(i+1)}}));
  await entered;const results=await Promise.all(pending);assert.ok(results.every(r=>r.status===400));
  assert.equal(actual._state().inflightAll,16);assert.ok(releaseCounts.every(n=>n===0));
  const blocked=await f.request({token:'ao_inv_'+'x'.repeat(43),password},{headers:{'x-forwarded-for':'10.0.2.1'}});assert.equal(blocked.status,429);assert.equal(starts,16);
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(actual._state().inflightAll,0);assert.ok(releaseCounts.every(n=>n===1));assert.equal(f.store.users.byId(link.user.id).password_hash,null);
});
