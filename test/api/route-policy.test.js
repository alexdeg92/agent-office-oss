'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
const {createResourceRegistry}=require('../../src/security/resources');
const {ROUTES,COMMANDS,TOPICS}=require('../../src/security/route-declarations');
const {declareRoute,decorateRouter,trackMounts,enumerateRoutes,assertRouteCoverage,validateDeclaration,createRouteGuard}=require('../../src/security/route-policy');
const {errorMiddleware}=require('../../src/api/v2/errors');
const {createVersionedTopics}=require('../../src/api/v2/topics');
let hash;
before(async()=>{hash=await hashPassword('synthetic-policy-password');});
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-route-policy-'));
  const store=openStore({dir,instance:'test',ownerName:'Policy admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_policy',authorize:()=>{}};
  const link=store.userManagement.invite({name:'Reader',email:'reader@example.invalid',roleId:'rol_reader'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const user=store.users.byId(link.user.id);
  const auth=createAuth({secret:'synthetic-cookie-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
  const cookie=row=>'taco_sess='+auth.signSession({userId:row.id,authGeneration:row.auth_generation,sid:'synthetic-'+row.id,exp:Date.now()+60000});
  const app=trackMounts(express()),r=trackMounts(express.Router());
  app.use(express.json());app.use(['/api/v2','/api/v3'],r);app.use(errorMiddleware());
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=(method,route,row=user)=>fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:row?{cookie:cookie(row)}:{}});
  const set=(resource,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,resource,level);
  return {app,r,store,admin,user,auth,ctx,request,set,deps:{store,auth}};
}
const permission=(resource,level)=>({kind:'permissions',requirements:[{resource,level}],reason:'synthetic policy coverage',command:null,writeClass:level==='write'?'store':null,agent:false,sensitive:false,audit:'none'});
test('S73-01: forged markers never count as guards or bypass guarded registration',async t=>{
  const f=await fixture(t),{DECLARATION}=require('../../src/security/route-policy');let calls=0;
  const forged=(req,res)=>{calls++;res.json({unguarded:true});};
  Object.defineProperty(forged,DECLARATION,{value:ROUTES.get('GET /views/logs')});
  const raw=express.Router();raw.get('/forged',forged);
  assert.throws(()=>assertRouteCoverage(raw,f.store.registry),/missing or duplicate route policy/);
  decorateRouter(f.r,ROUTES,f.deps);f.r.get('/views/logs',forged);
  const rows=assertRouteCoverage(f.app,f.store.registry);
  assert.ok(rows.every(row=>row.declarations.length===1&&row.policyFirst));
  f.set('logs','none');
  for(const version of [2,3])for(const method of ['GET','HEAD'])assert.equal((await f.request(method,'/api/v'+version+'/views/logs')).status,403);
  assert.equal((await f.request('GET','/api/v3/views/logs',null)).status,401);assert.equal(calls,0);
  f.set('logs','read');assert.equal((await f.request('GET','/api/v3/views/logs')).status,200);assert.equal(calls,1);
  const otherAuth={sessionOf:()=>null},other=express.Router();decorateRouter(other,ROUTES,f.deps);
  assert.throws(()=>other.get('/views/logs',createRouteGuard(ROUTES.get('GET /views/logs'),{store:f.store,auth:otherAuth}),forged),/route declaration mismatch/);
});
test('actual mounted stacks expand both API aliases and implicit HEAD; an undecorated canary fails',async t=>{
  const f=await fixture(t);
  decorateRouter(f.r,ROUTES,f.deps);
  f.r.get('/views/flows',(req,res)=>res.json({ok:true}));
  f.r.post('/flows/:jobId/runs',(req,res)=>res.json({ok:true}));
  const rows=assertRouteCoverage(f.app,f.store.registry);
  assert.deepEqual(rows.map(row=>row.method+' '+row.path),[
    'GET /api/v2/views/flows','HEAD /api/v2/views/flows','POST /api/v2/flows/:jobId/runs',
    'GET /api/v3/views/flows','HEAD /api/v3/views/flows','POST /api/v3/flows/:jobId/runs',
  ]);
  assert.throws(()=>f.r.post('/flows/purge',(req,res)=>res.json({ok:true})),/undeclared route/);
  f.app.get('/api/v3/canary',(req,res)=>res.json({ok:true}));
  assert.throws(()=>assertRouteCoverage(f.app,f.store.registry),/missing or duplicate route policy GET \/api\/v3\/canary/);
});
test('S53-01: mounted terminating handlers before a genuine guard fail GET/HEAD coverage on both aliases',async t=>{
  const f=await fixture(t),spec=validateDeclaration(permission('flows','read'),f.store.registry);
  const terminate=(req,res)=>res.json({unguarded:true});
  f.r.get('/misordered',terminate,createRouteGuard(spec,f.deps));
  const rows=enumerateRoutes(f.app);
  assert.deepEqual(rows.map(row=>row.method+' '+row.path),[
    'GET /api/v2/misordered','HEAD /api/v2/misordered',
    'GET /api/v3/misordered','HEAD /api/v3/misordered',
  ]);
  for(const row of rows){assert.equal(row.declarations.length,1);assert.equal(row.policyFirst,false);}
  assert.throws(()=>assertRouteCoverage(f.app,f.store.registry),/route policy must precede handlers/);
  for(const version of [2,3])for(const method of ['get','head']) {
    const app=trackMounts(express()),r=express.Router();
    r[method]('/probe',terminate,createRouteGuard(spec,f.deps));app.use('/api/v'+version,r);
    assert.throws(()=>assertRouteCoverage(app,f.store.registry),new RegExp('route policy must precede handlers '+method.toUpperCase()+' /api/v'+version+'/probe'));
    const correct=trackMounts(express()),guarded=express.Router();
    declareRoute(guarded,method,'/probe',spec,f.deps,terminate);correct.use('/api/v'+version,guarded);
    assert.equal(assertRouteCoverage(correct,f.store.registry).every(row=>row.policyFirst),true);
  }
});
test('live HTTP resource × none/read/write matrix uses policy before handlers on both mount versions',async t=>{
  const f=await fixture(t);let calls=0;
  for(const [index,resource] of f.store.registry.list().entries()) {
    const path='/probe/'+index,handler=(req,res)=>{calls++;res.json({actor:req.user.id});};
    declareRoute(f.r,'get',path,permission(resource.key,'read'),f.deps,handler);
    declareRoute(f.r,'post',path,permission(resource.key,'write'),f.deps,handler);
    if(resource.parent)f.set(resource.parent,'read');
    for(const level of ['none','read','write']) {
      f.set(resource.key,level);
      for(const version of [2,3])for(const [method,required] of [['GET','read'],['POST','write']]) {
        const before=calls,response=await f.request(method,'/api/v'+version+path),allow=level==='write'||level===required;
        assert.equal(response.status,allow?200:403,resource.key+' '+level+' '+required);
        const data=await response.json();
        assert.equal(calls,before+(allow?1:0),'forbidden request never reaches a handler');
        if(allow)assert.equal(data.actor,f.user.id);else assert.equal(data.error.details[0].issue,'permission-denied');
      }
    }
    assert.equal((await f.request('POST','/api/v3'+path,f.admin)).status,200);
  }
  assertRouteCoverage(f.app,f.store.registry);
});
test('reauthorization after async work rejects changed generation/permissions before dispatch',async t=>{
  for(const change of ['permissions','generation']) {
    const f=await fixture(t);let entered,continueRequest;
    const ready=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{continueRequest=resolve;});let dispatched=0;
    f.set('flows','write');
    declareRoute(f.r,'post','/delayed',permission('flows.run','write'),f.deps,async(req,res)=>{
      entered();await waiting;req.authorize();dispatched++;res.json({ok:true});
    });
    const request=f.request('POST','/api/v3/delayed');await ready;
    if(change==='permissions')f.store.userManagement.overrides(f.user.id,{expectedRevision:1,permissions:[{resource:'flows',level:'none'}]},f.ctx);
    else f.store.userManagement.revoke(f.user.id,{expectedRevision:1},f.ctx);
    continueRequest();assert.equal((await request).status,change==='permissions'?403:401);assert.equal(dispatched,0);
  }
});
test('new exact child does not inherit a parent override in a mounted command route',async t=>{
  const f=await fixture(t);f.store.registry.register([{key:'flows.purge',parent:'flows',labelKey:'flows.purge',privileged:true}],'core');f.store.rbac.sync(f.store.registry);
  f.set('flows','write');let dispatched=0;
  declareRoute(f.r,'post','/purge',permission('flows.purge','write'),f.deps,(req,res)=>{dispatched++;res.json({ok:true});});
  assert.equal((await f.request('POST','/api/v2/purge')).status,403);assert.equal(dispatched,0);
  f.set('flows.purge','write');assert.equal((await f.request('POST','/api/v3/purge')).status,200);assert.equal(dispatched,1);
  f.set('flows','none');assert.equal((await f.request('POST','/api/v3/purge')).status,403);
});
test('route/topic/command declarations have known exact resources; unknown declarations cannot register',()=>{
  const registry=createResourceRegistry();
  for(const spec of ROUTES.values())validateDeclaration(spec,registry);
  for(const spec of COMMANDS.values())validateDeclaration(spec,registry);
  for(const topic of TOPICS.values())assert.equal(registry.has(topic.resource),true);
  assert.throws(()=>validateDeclaration(permission('flows.unknown','write'),registry),/invalid route requirement/);
  assert.throws(()=>validateDeclaration({...permission('flows','read'),kind:'public'},registry),/invalid route exception/);
});
test('a machine principal uses only declared machine routes and never reads a human cookie',()=>{
  const deps={auth:{sessionOf:()=>{throw new Error('cookie fallback');}},store:{}};
  const req={principal:{kind:'agent'},headers:{cookie:'synthetic-human-cookie'}};
  let error;
  createRouteGuard(permission('projects','write'),deps)(req,{},e=>{error=e;});
  assert.equal(error.code,'forbidden');assert.equal(error.details[0].issue,'token-scope');
  createRouteGuard({...permission('projects','write'),agent:true},deps)(req,{},e=>{error=e;});
  assert.equal(error,undefined);assert.equal(req.user,undefined);
});
test('both actual versioned topic registries require a declaration, including direct-registry canaries',()=>{
  const registry=createResourceRegistry(),topics=createVersionedTopics({2:{P:{}},3:{P:{}}},{policyDeclarations:TOPICS,resourceRegistry:registry});
  try {
    for(const name of TOPICS.keys())topics.define(name,{build:()=>({})});
    for(const version of [2,3])for(const name of topics.of(version).names())assert.deepEqual(topics.of(version).declaration(name),TOPICS.get(name));
    assert.throws(()=>topics.define('canary',{build:()=>({})}),/undeclared topic policy/);
    assert.throws(()=>topics.of(3).define('direct-canary',{build:()=>({})}),/undeclared topic policy/);
    assert.throws(()=>topics.of(2).define('bad-resource',{permission:{resource:'unknown',level:'read'},build:()=>({})}),/undeclared topic policy/);
  } finally {topics.close();}
});
