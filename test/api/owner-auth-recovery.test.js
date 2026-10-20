'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {DatabaseSync}=require('node:sqlite');
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {openStore}=require('../../src/store');
const {createAuth,COOKIE}=require('../../src/auth');
const {errorMiddleware}=require('../../src/api/v2/errors');
const {createRouteGuard}=require('../../src/security/route-policy');
const {hashPassword}=require('../../src/security/password');

test('environment recovery login is a 10-minute repair-only session, audited and revoked after one repair',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-login-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=openStore({dir,instance:'test',ownerName:'Original display name',now:Date.now,log:()=>{}});t.after(()=>{try{store.close();}catch{}});
  const owner=store.users.createOwner({email:'owner@example.invalid',personId:store.owner.id,passwordHash:await hashPassword('database-password',{N:2**14})});
  const envHash=await hashPassword('environment-recovery-password',{N:2**14}),audit=[],logs=[];
  const identity={users:store.users,state:store.rbac.state};
  const auth=createAuth({secret:'synthetic-session-secret-for-recovery',ttlMs:3600000,email:'owner@example.invalid',passwordHash:envHash,
    identity,allowMultiUser:true,allowRecoveryLogin:true,revocations:store.sessions,audit:row=>audit.push(row),log:line=>logs.push(line)});
  const app=express();app.use(express.json());auth.mountRoutes(app,{isGwConnected:()=>false});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@example.invalid',password:'environment-recovery-password'})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0],value=decodeURIComponent(cookie.slice(COOKIE.length+1));
  assert.equal(response.headers.get('set-cookie').includes('__Secure-ao_refresh'),false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0,'repair-only cookie login never creates a bearer family');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM human_access_tokens').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,0);
  const session=auth.verifySession(value);assert.equal(session.recoveryOnly,true);assert.equal(session.userId,owner.id);assert.ok(session.exp-Date.now()<=600000);
  assert.ok(audit.some(row=>row.command==='auth.login'&&row.detail==='recovery-login'));
  assert.ok(audit.some(row=>row.command==='access.recoveryLogin'&&row.detail==='recovery-login'));
  assert.ok(logs.some(line=>line.includes('repair-only')));assert.doesNotMatch(JSON.stringify(audit)+logs.join(''),/environment-recovery-password|owner@example/);

  const policySpec={kind:'self',requirements:[],reason:'synthetic recovery access test',command:null,writeClass:null,sensitive:false,audit:'none',agent:false};
  const guard=createRouteGuard(policySpec,{auth,store});
  const admit=(method,route)=>{let error=null;const req={method,baseUrl:'/api/v3',path:route,headers:{cookie},ip:'127.0.0.1'};guard(req,{},value=>{error=value||null;});return {error,req};};
  assert.equal(admit('GET','/settings/recovery').error,null);
  assert.equal(admit('POST','/settings/reauth').error,null);
  assert.equal(admit('PUT','/settings/owner').error,null);
  assert.equal(admit('POST','/settings/password').error,null);
  assert.equal(admit('GET','/settings').error.code,'unauthorized');
  assert.equal(admit('GET','/settings/access').error.code,'unauthorized');

  const request={method:'POST',baseUrl:'/api/v3',path:'/settings/reauth',headers:{cookie},ip:'127.0.0.1'};assert.deepEqual(await auth.confirmPassword(request,'environment-recovery-password'),{ok:true});
  const current=store.users.owner();
  const result=store.selfAccount.profile({expectedRevision:current.permission_revision,displayName:'Repaired display name'},
    {userId:current.id,authGeneration:current.auth_generation,requestId:'req_recovery_test',recoveryOnly:true,authorize:()=>{}});
  assert.equal(result.user.name,'Repaired display name');assert.equal(store.users.owner().auth_generation,current.auth_generation+1);
  let cleared=null;auth.refreshSession({session},{setHeader:(name,value)=>{if(name==='Set-Cookie')cleared=value;}},{revokeOthers:true});
  assert.match(cleared,/Max-Age=0/);assert.equal(auth.verifySession(value),null);

  const disabled=createAuth({secret:'synthetic-session-secret-for-recovery',ttlMs:3600000,email:'owner@example.invalid',passwordHash:envHash,identity,allowMultiUser:true,allowRecoveryLogin:false,revocations:store.sessions});
  assert.equal(disabled.verifySession(value),null);
});

test('recovery scope blocks ordinary routes and logout aliases revoke cookie and split sessions with RBAC on or off',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-recovery-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',log:()=>{}});t.after(()=>{try{store.close();}catch{}});
  const owner=store.users.createOwner({email:'owner@example.invalid',personId:store.owner.id,passwordHash:await hashPassword('database-password',{N:2**14})});
  const recoveryPassword='synthetic-environment-recovery-password',recoveryHash=await hashPassword(recoveryPassword,{N:2**14});
  const auth=createAuth({secret:'synthetic-session-secret-for-recovery-scope',ttlMs:3600000,email:owner.email,passwordHash:recoveryHash,
    identity:{users:store.users,state:store.rbac.state},allowMultiUser:true,allowRecoveryLogin:true,revocations:store.sessions});
  const loginApp=express();loginApp.use(express.json());auth.mountRoutes(loginApp,{isGwConnected:()=>false});
  const loginServer=await new Promise(resolve=>{const server=loginApp.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>new Promise(resolve=>loginServer.close(resolve)));
  for(const rbacEnabled of [false,true])for(const authMode of ['cookie','split']) {
    const login=await fetch(`http://127.0.0.1:${loginServer.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:owner.email,password:recoveryPassword})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const scoped=createAuth({secret:'synthetic-session-secret-for-recovery-scope',ttlMs:3600000,email:owner.email,passwordHash:recoveryHash,
      identity:{users:store.users,state:store.rbac.state},allowMultiUser:true,allowRecoveryLogin:true,revocations:store.sessions});
    if(authMode==='split')scoped.useHumanAccess({resolve:()=>null,cookieAllowed:()=>true});
    // Match the legacy v2 authed middleware used when RBAC route guards are off.
    const app=express(),guard=scoped.requireSession||((req,res,next)=>{if(req.principal||req.session)return next();const session=scoped.sessionOf(req);if(!session)return res.status(401).json({error:'unauthorized'});req.session=session;next();});
    scoped.mountRoutes(app,{isGwConnected:()=>false});
    app.get('/api/v2/views/office',guard,(_req,res)=>res.sendStatus(200));
    app.get('/api/v3/views/office',guard,(_req,res)=>res.sendStatus(200));
    app.get('/api/v3/settings/recovery',guard,(_req,res)=>res.sendStatus(200));
    app.use(errorMiddleware(()=>{}));
    const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
    try {
      for(const version of [2,3]) {
        const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v${version}/views/office`,{headers:{cookie}});
        assert.ok([401,403].includes(response.status),`RBAC ${rbacEnabled?'on':'off'}, ${authMode}, v${version} must refuse recovery scope`);
      }
      const repair=await fetch(`http://127.0.0.1:${server.address().port}/api/v3/settings/recovery`,{headers:{cookie}});assert.equal(repair.status,200,`RBAC ${rbacEnabled?'on':'off'}, ${authMode}: repair endpoint remains available`);
      const logoutPath=rbacEnabled?'/API/LOGOUT':'/api/logout/';
      const logout=await fetch(`http://127.0.0.1:${server.address().port}${logoutPath}`,{method:'POST',headers:{cookie}});assert.equal(logout.status,200);
      const replay=await fetch(`http://127.0.0.1:${server.address().port}/api/v3/settings/recovery`,{headers:{cookie}});assert.equal(replay.status,401,`RBAC ${rbacEnabled?'on':'off'}, ${authMode}, ${logoutPath}: logout alias revokes the recovery session, not just its browser cookie`);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
});
