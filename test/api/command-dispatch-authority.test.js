'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {openStore}=require('../../src/store'),{createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed'),{loadScenario}=require('../helpers/scenario');
const {createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {mountV2}=require('../../src/api/v2/routes'),{requestId}=require('../../src/api/v2/errors');
const {waitFor}=require('../helpers/harness');
let hash;before(async()=>{hash=await hashPassword('synthetic-dispatch-password');});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{multi=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-dispatch-')),store=openStore({dir,instance:'test',ownerName:'Historical admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_dispatch',authorize:()=>{}};
  const link=store.userManagement.invite({email:'editor@example.invalid',name:'Actual caller',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const user=store.users.byId(link.user.id);let engine=feed(createEngine(),loadScenario('synthetic-basic'));
  const auth=createAuth({secret:'synthetic-dispatch-secret',identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
  const calls=[],childRuntime={definition:{id:'synthetic'},commands:{},refreshFlows:async()=>{calls.push('refreshFlows');},refreshSkills:async()=>{calls.push('refreshSkills');}};
  let runtime=childRuntime,controller=null;
  if(multi) {
    const {definition}=require('../../src/adapters/openclaw');
    controller=require('../../src/multi-runtime-controller').createMultiRuntimeController({store,cfg:{runtimeInstances:[{id:'legacy',adapter:'openclaw',enabled:true,cfg:{}}]},
      resolveAdapter:()=>({definition,createRuntime:()=>Object.assign(childRuntime,{definition,attach:e=>{
        feed(e,loadScenario('synthetic-basic'));e.setReads(Object.fromEntries(['transcript','flowRuns','skillInfo'].map(op=>[op,async key=>{calls.push({op,key});return {ok:true};}])));
      }})})});
    engine=controller.engine;runtime=controller.runtime;
  }
  if(!multi)engine.request=async(op,key)=>{calls.push({op,key});return {ok:true};};
  const app=express();app.use(requestId,express.json());
  const api=mountV2(app,{auth,engine,store,runtime,enforceAuthorization:true,cfg:{instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,timeZone:'UTC'}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const cookie=row=>'taco_sess='+auth.signSession({userId:row.id,authGeneration:row.auth_generation,sid:'dispatch-'+row.id,exp:Date.now()+60000});
  const request=async(method,route,body,row=user)=>{
    const res=await fetch(base+route,{method,headers:{cookie:cookie(row),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json()};
  };
  const set=(resource,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,resource,level);
  t.after(async()=>{api.close();controller?.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,user,admin,engine,auth,api,calls,runtime,childRuntime,request,set,cookie};
}
test('real flow writes do not acquire log-read authority; permitted history refreshes still work on both aliases',async t=>{
  const f=await fixture(t),job=f.engine.cronJobs()[0].id;
  f.runtime.commands.flowRun=async()=>{f.calls.push('run');return {ok:true};};
  for(const version of [2,3]) {
    f.set('logs','none');f.calls.length=0;
    assert.equal((await f.request('POST','/api/v'+version+'/flows/'+job+'/runs',{})).status,200);
    assert.deepEqual(f.calls,['run','refreshFlows']);
    f.set('logs','read');f.calls.length=0;
    assert.equal((await f.request('POST','/api/v'+version+'/flows/'+job+'/runs',{})).status,200);
    assert.deepEqual(f.calls,['run','refreshFlows',{op:'flowRuns',key:job}]);
  }
});
test('a live authority check after the awaited list refresh prevents a subsequent history dispatch',async t=>{
  for(const resource of ['logs','flows.run']) {
    const f=await fixture(t),job=f.engine.cronJobs()[0].id,start=deferred(),finish=deferred();
    f.runtime.commands.flowRun=async()=>({ok:true});
    f.runtime.refreshFlows=async()=>{f.calls.push('refreshFlows');start.resolve();await finish.promise;};
    const pending=f.request('POST','/api/v3/flows/'+job+'/runs',{});await start.promise;f.set(resource,'none');finish.resolve();
    assert.equal((await pending).status,resource==='logs'?200:403);
    assert.deepEqual(f.calls,['refreshFlows']);
  }
});
test('revocation during an already dispatched flow or skill write prevents every new user-triggered refresh',async t=>{
  for(const kind of ['flow','skill']) {
    const f=await fixture(t),start=deferred(),finish=deferred();
    const write=async()=>{f.calls.push('accepted-write');start.resolve();await finish.promise;return {ok:true};};
    f.runtime.commands.flowRun=write;f.runtime.commands.skillSetEnabled=write;
    const route=kind==='flow'?'/flows/'+f.engine.cronJobs()[0].id+'/runs':'/skills/'+f.engine.skills()[0].name+'/enabled';
    const pending=f.request(kind==='flow'?'POST':'PUT','/api/v3'+route,kind==='flow'?{}:{enabled:false});
    await start.promise;f.set(kind==='flow'?'flows.run':'skills','none');finish.resolve();
    assert.equal((await pending).status,403);assert.deepEqual(f.calls,['accepted-write']);
  }
});
test('the real mounted chat handler rechecks permission and generation after acknowledgement before queued dispatch',async t=>{
  for(const change of ['permission','generation']) {
    const f=await fixture(t);f.runtime.commands.agentTurn=async()=>{f.calls.push('turn');return {text:'reply'};};
    const route=f.api.router.stack.find(l=>l.route?.path==='/chat/messages').route;
    const req={method:'POST',apiVersion:3,headers:{cookie:f.cookie(f.user)},body:{text:'Queued'},params:{},requestId:'req_queued'};
    let response;
    const res={req,status(n){this.statusCode=n;return this;},json(value){response=value;
      if(change==='permission')f.set('chat','none');else f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id);
    }};
    // Dispatch the actual route stack; the acknowledgement hook creates the precise pre-microtask race.
    route.dispatch(req,res,error=>{if(error)throw error;});
    assert.equal(res.statusCode,202);assert.ok(response.data.result.turnId);
    await waitFor(()=>f.api.commands.chatState().pending===null,{what:'cancelled queued turn'});
    assert.deepEqual(f.calls,[]);assert.equal(f.api.commands.chatState().errors.length,1);
    const observed=await f.request('GET','/api/v3/views/chat',undefined,f.admin);
    assert.ok(!observed.json.data.messages.some(m=>m.text==='Queued'),'cancelled turns do not become sent messages');
  }
});
test('chat pending, completed and echoed messages preserve the actual accepted Person',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();
  f.runtime.commands.agentTurn=async()=>{start.resolve();await finish.promise;return {text:'A reply'};};
  const accepted=await f.request('POST','/api/v3/chat/messages',{text:'A unique new message'});assert.equal(accepted.status,202);await start.promise;
  const since=f.api.commands.chatState().pending.since;
  const identity=vm=>{const m=vm.messages.find(m=>m.text==='A unique new message');assert.ok(m);assert.equal(m.senderInfo.id,f.user.person_id);assert.equal(m.senderInfo.name,'Actual caller');assert.notEqual(m.senderInfo.id,f.store.owner.id);};
  identity((await f.request('GET','/api/v3/views/chat')).json.data);
  finish.resolve();await waitFor(()=>f.api.commands.chatState().pending===null,{what:'completed chat'});
  identity((await f.request('GET','/api/v3/views/chat')).json.data);
  f.engine.transcript=()=>({events:[{id:'echo_new',kind:'user',text:'A unique new message',at:since+1},{id:'echo_reply',kind:'assistant',text:'A reply',at:since+2,model:null,outputTokens:null}]});
  f.api.topics.invalidate('chat');
  const response=await f.request('GET','/api/v3/views/chat');assert.equal(response.status,200,JSON.stringify(response));const echoed=response.json.data;identity(echoed);
  assert.equal(echoed.messages.filter(m=>m.text==='A unique new message').length,1);
});
test('revoking chat during an accepted turn preserves its result and actor, but skips the follow-up transcript read',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();
  f.runtime.commands.agentTurn=async()=>{f.calls.push('turn');start.resolve();await finish.promise;return {text:'Accepted reply'};};
  assert.equal((await f.request('POST','/api/v3/chat/messages',{text:'Accepted text'})).status,202);await start.promise;
  f.set('chat','none');finish.resolve();await waitFor(()=>f.api.commands.chatState().pending===null,{what:'accepted turn to settle'});
  assert.deepEqual(f.calls,['turn']);
  const vm=(await f.request('GET','/api/v3/views/chat',undefined,f.admin)).json.data;
  assert.equal(vm.messages.find(m=>m.text==='Accepted text').senderInfo.id,f.user.person_id);
  assert.ok(vm.messages.some(m=>m.text==='Accepted reply'));
});
test('real multi-runtime child queues deny command/read dispatch after facade admission without faulting the source',async t=>{
  for(const change of ['permission','generation'])for(const kind of ['command','read']) {
    const f=await fixture(t,{multi:true});
    f.childRuntime.commands.flowRun=async()=>{f.calls.push('child-run');return {ok:true};};
    const path=kind==='command'?'/flows/:jobId/runs':'/views/sessions/:key';
    const route=f.api.router.stack.find(l=>l.route?.path===path).route;
    const params=kind==='command'?{jobId:f.engine.cronJobs()[0].id}:{key:f.engine.sessions()[0].key};
    const req={method:kind==='command'?'POST':'GET',apiVersion:3,headers:{cookie:f.cookie(f.user)},body:{},params,requestId:'req_controller',query:{}};
    const done=deferred();
    const res={req,json(value){done.resolve({value});},status(){return this;}};
    route.dispatch(req,res,error=>done.resolve({error}));
    if(change==='permission')f.set(kind==='command'?'flows.run':'logs','none');else f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id);
    const result=await done.promise;assert.equal(result.error?.code,change==='permission'?'forbidden':'unauthorized');assert.deepEqual(f.calls,[]);
    assert.equal(f.engine.instances[0].failure,null,'user denial is not a runtime failure');
    if(change==='permission')f.set(kind==='command'?'flows.run':'logs','read');
    if(kind==='command')f.set('flows.run','write');
    const current=f.store.users.byId(f.user.id),url=kind==='command'?'/flows/'+params.jobId+'/runs':'/views/sessions/'+encodeURIComponent(params.key);
    const allowed=await f.request(req.method,'/api/v3'+url,kind==='command'?{}:undefined,current);
    assert.equal(allowed.status,200,JSON.stringify(allowed));assert.ok(f.calls.length>0,'a fresh authorized caller reaches the healthy child');
  }
});
test('real controller refresh callbacks retain the trusted service authority across their deferred queue',async t=>{
  const f=await fixture(t,{multi:true}),{createRouteGuard}=require('../../src/security/route-policy'),{ROUTES}=require('../../src/security/route-declarations');
  const req={headers:{cookie:f.cookie(f.user)}};let error;
  createRouteGuard(ROUTES.get('POST /flows/:jobId/runs'),{store:f.store,auth:f.auth})(req,{},e=>error=e);assert.equal(error,undefined);
  const {runAuthorized}=require('../../src/security/dispatch-context');
  const pending=runAuthorized(req.authorize,()=>f.runtime.refreshFlows());f.set('flows.run','none');
  const result=await pending;assert.equal(result[0].status,'rejected');assert.equal(result[0].reason.code,'forbidden');assert.deepEqual(f.calls,[]);assert.equal(f.engine.instances[0].failure,null);
  f.set('flows.run','write');await runAuthorized(req.authorize,()=>f.runtime.refreshFlows());assert.deepEqual(f.calls,['refreshFlows']);
});
test('same-text local and pending turns from different Persons never reconcile with each other',()=>{
  const {buildChatVM}=require('../../src/api/v2/vm/chat');
  const sender=id=>({kind:'human',id,name:id,runtime:'synthetic',channel:null,avatarHint:null});
  const local=[{id:'first',role:'user',text:'Same text',at:10000,since:10000,meta:null,senderInfo:sender('person-first')},
    {id:'second',role:'user',text:'Same text',at:10001,since:10001,meta:null,senderInfo:sender('person-second')}];
  for(const events of [[],[{id:'one-echo',kind:'user',text:'Same text',at:10000}]]) {
    const vm=buildChatVM({sessionKey:'portal',transcript:{events},local,pending:{turnId:'third',text:'Same text',since:10002,senderInfo:sender('person-third')}});
    assert.equal(vm.messages.length,3);assert.deepEqual(vm.messages.map(m=>m.senderInfo.id),['person-first','person-second','person-third']);
    assert.equal(new Set(vm.messages.map(m=>m.id)).size,3);
  }
});
