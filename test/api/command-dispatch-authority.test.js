'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {openStore}=require('../../src/store'),{createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed'),{loadScenario}=require('../helpers/scenario');
const {createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {mountV2}=require('../../src/api/v2/routes'),{requestId}=require('../../src/api/v2/errors');
const {waitFor}=require('../helpers/harness');
const {openSse}=require('../helpers/sse-client');
const {scopeForAccount,sessionRefForScope}=require('../../src/api/chat-identity');
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
  const calls=[],childRuntime={definition:{id:'synthetic',sessionKeyFor:(agentId,ref)=>'agent:'+agentId+':explicit:'+ref},commands:{},refreshFlows:async()=>{calls.push('refreshFlows');},refreshSkills:async()=>{calls.push('refreshSkills');}};
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
  return {store,user,admin,engine,auth,api,calls,runtime,childRuntime,base,request,set,cookie};
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
    const chatState=()=>f.api.commands.chatState(scopeForAccount(f.user.id,f.store));
    const route=f.api.router.stack.find(l=>l.route?.path==='/chat/messages').route;
    const req={method:'POST',apiVersion:3,headers:{cookie:f.cookie(f.user)},body:{text:'Queued'},params:{},requestId:'req_queued'};
    let response;
    const res={req,status(n){this.statusCode=n;return this;},json(value){response=value;
      if(change==='permission')f.set('chat','none');else f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id);
    }};
    // Dispatch the actual route stack; the acknowledgement hook creates the precise pre-microtask race.
    route.dispatch(req,res,error=>{if(error)throw error;});
    assert.equal(res.statusCode,202);assert.ok(response.data.result.turnId);
    await waitFor(()=>chatState().pending===null,{what:'cancelled queued turn'});
    assert.deepEqual(f.calls,[]);assert.equal(chatState().errors.length,1);
    const observed=await f.request('GET','/api/v3/views/chat',undefined,f.admin);
    assert.ok(!observed.json.data.messages.some(m=>m.text==='Queued'),'cancelled turns do not become sent messages');
  }
});
test('chat history, live topic and send session are isolated between the admin and a member',async t=>{
  const f=await fixture(t),sent=[],adminRuns=new Map();
  f.runtime.commands.agentTurn=async({agentId,text,sessionRef})=>{
    sent.push({agentId,text,sessionRef});
    const gate=adminRuns.get(text);
    if(gate){gate.started.resolve();await gate.finish.promise;}
    return {text:'reply:'+text};
  };
  for(const version of [2,3]) {
    const adminStream=openSse(f.base,`/api/v${version}/stream?topics=chat`,{cookie:f.cookie(f.admin)});
    const memberStream=openSse(f.base,`/api/v${version}/stream?topics=chat`,{cookie:f.cookie(f.user)});
    const spoofedStream=openSse(f.base,`/api/v${version}/stream?topics=${encodeURIComponent('chat?scope=owner')}`,{cookie:f.cookie(f.user)});
    t.after(()=>{adminStream.close();memberStream.close();spoofedStream.close();});
    await Promise.all([adminStream.opened,memberStream.opened,spoofedStream.opened]);
    await Promise.all([
      adminStream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat'),
      memberStream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat'),
      spoofedStream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat?scope=owner'),
    ]);
    const adminText=`admin-private-message-v${version}`,memberText=`member-private-message-v${version}`;
    const gate={started:deferred(),finish:deferred()};adminRuns.set(adminText,gate);
    assert.equal((await f.request('POST',`/api/v${version}/chat/messages`,{text:adminText},f.admin)).status,202);
    await gate.started.promise;
    assert.equal((await f.request('POST',`/api/v${version}/chat/messages`,{text:memberText},f.user)).status,202,'another account can chat while the admin turn is pending');
    gate.finish.resolve();
    await waitFor(async()=> (await f.request('GET',`/api/v${version}/views/chat`,undefined,f.admin)).json.data.turnPending===null,{what:'admin chat turn'});
    await waitFor(async()=> (await f.request('GET',`/api/v${version}/views/chat`,undefined,f.user)).json.data.turnPending===null,{what:'member chat turn'});

    const adminHistory=(await f.request('GET',`/api/v${version}/views/chat`,undefined,f.admin)).json.data;
    const memberHistory=(await f.request('GET',`/api/v${version}/views/chat`,undefined,f.user)).json.data;
    const texts=vm=>vm.messages.map(message=>message.text);
    assert.ok(texts(adminHistory).includes(adminText));
    assert.ok(!texts(adminHistory).includes(memberText),'admin chat history cannot reveal the member conversation');
    assert.ok(texts(memberHistory).includes(memberText));
    assert.ok(!texts(memberHistory).includes(adminText),'member chat history cannot reveal the admin conversation');
    assert.notEqual(adminHistory.sessionKey,memberHistory.sessionKey,'each account dispatches through its own runtime chat session');
    f.set('logs','none');
    const knownSession=f.engine.sessions().find(session=>session.class.kind==='explicit'&&session.class.explicitKey==='portal-chat')?.key;
    assert.ok(knownSession,'fixture has an existing owner session');
    const knownDetail=await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(knownSession)}`,undefined,f.user);
    const missingDetail=await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent('agent:main:explicit:not-a-session')}`,undefined,f.user);
    assert.equal(knownDetail.status,403);
    assert.equal(missingDetail.status,knownDetail.status,'unauthorized session reads do not reveal whether a session exists');
    assert.equal((await f.request('GET',`/api/v${version}/views/logs`,undefined,f.user)).status,403,'session lists require explicit Logs permission');
    f.set('logs','read');
    await waitFor(()=>adminStream.frames.some(frame=>JSON.stringify(frame.data).includes(adminText))
      && memberStream.frames.some(frame=>JSON.stringify(frame.data).includes(memberText)),{what:'owner-specific live chat frames'});
    assert.ok(!adminStream.frames.some(frame=>JSON.stringify(frame.data).includes(memberText)),'admin SSE never receives member chat');
    assert.ok(!memberStream.frames.some(frame=>JSON.stringify(frame.data).includes(adminText)),'member SSE never receives admin chat');
    assert.ok(!spoofedStream.frames.some(frame=>JSON.stringify(frame.data).includes(adminText)),'a member cannot select the owner topic scope');
  }
  assert.equal(sent.length,4);
  assert.notEqual(sent[0].sessionRef,sent[1].sessionRef,'the adapter receives distinct account-scoped session references');
});
test('chat pending, completed and echoed messages preserve the actual accepted Person',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();
  const chatState=()=>f.api.commands.chatState(scopeForAccount(f.user.id,f.store));
  f.runtime.commands.agentTurn=async()=>{start.resolve();await finish.promise;return {text:'A reply'};};
  const accepted=await f.request('POST','/api/v3/chat/messages',{text:'A unique new message'});assert.equal(accepted.status,202);await start.promise;
  const since=chatState().pending.since;
  const identity=vm=>{const m=vm.messages.find(m=>m.text==='A unique new message');assert.ok(m);assert.equal(m.senderInfo.id,f.user.person_id);assert.equal(m.senderInfo.name,'Actual caller');assert.notEqual(m.senderInfo.id,f.store.owner.id);};
  identity((await f.request('GET','/api/v3/views/chat')).json.data);
  finish.resolve();await waitFor(()=>chatState().pending===null,{what:'completed chat'});
  identity((await f.request('GET','/api/v3/views/chat')).json.data);
  f.engine.transcript=()=>({events:[{id:'echo_new',kind:'user',text:'A unique new message',at:since+1},{id:'echo_reply',kind:'assistant',text:'A reply',at:since+2,model:null,outputTokens:null}]});
  f.api.topics.invalidate('chat');
  const response=await f.request('GET','/api/v3/views/chat');assert.equal(response.status,200,JSON.stringify(response));const echoed=response.json.data;identity(echoed);
  assert.equal(echoed.messages.filter(m=>m.text==='A unique new message').length,1);
});
test('portal chat ownership is private across Chat, Logs, session detail, Office projection inputs and SSE for admins and Logs readers',async t=>{
  const f=await fixture(t);f.set('logs','read');
  f.engine.runtimeFor=()=>({capabilities:{chat:true,chatSessionScope:'principal'}});
  const ownerScope=scopeForAccount(f.admin.id,f.store),memberScope=scopeForAccount(f.user.id,f.store);
  const byKey=new Map(),template=f.engine.sessions()[0];
  const make=(key,ref,label,kind='explicit')=>{
    const row=structuredClone(template);row.key=key;row.class={...row.class,kind,explicitKey:ref,agentId:'main'};
    row.displayName=label;row.updatedAt=Date.now();row.usage={...row.usage,total:11};row.run={...row.run,status:'idle'};return row;
  };
  const ownerRow=make('agent:main:explicit:'+sessionRefForScope(ownerScope),sessionRefForScope(ownerScope),'Owner private');
  ownerRow.usage.total=12345;ownerRow.run={...ownerRow.run,status:'running',evidence:'status-field'};
  const memberRow=make('agent:main:explicit:'+sessionRefForScope(memberScope),sessionRefForScope(memberScope),'Member private');
  const legacy=make('agent:main:explicit:portal-chat','portal-chat','Legacy shared history');
  const ordinary=make('agent:main:discord:dm:synthetic','not-a-portal-chat','Other channel session','conversation-direct');
  const rows=[ownerRow,memberRow,legacy,ordinary];
  for(const row of rows)byKey.set(row.key,row);
  f.engine.sessions=()=>rows;
  f.engine.session=key=>byKey.get(key)||null;
  const legacyCanary='LEGACY_MEMBER_PRIVATE_CANARY';
  const transcripts=new Map([[legacy.key,{events:[{id:'legacy-user',kind:'user',text:legacyCanary,at:Date.now(),truncated:false}],participants:[],window:{from:0,to:1}}]]);
  f.engine.transcript=key=>transcripts.get(key)||null;
  f.engine.request=async()=>({ok:true});
  for(const version of [2,3]) {
    const adminLogs=openSse(f.base,`/api/v${version}/stream?topics=logs`,{cookie:f.cookie(f.admin)});
    const memberLogs=openSse(f.base,`/api/v${version}/stream?topics=logs`,{cookie:f.cookie(f.user)});
    const adminChat=openSse(f.base,`/api/v${version}/stream?topics=chat`,{cookie:f.cookie(f.admin)});
    const memberChat=openSse(f.base,`/api/v${version}/stream?topics=chat`,{cookie:f.cookie(f.user)});
    const adminForeignSession=openSse(f.base,`/api/v${version}/stream?topics=${encodeURIComponent('session:'+memberRow.key)}`,{cookie:f.cookie(f.admin)});
    const memberForeignSession=openSse(f.base,`/api/v${version}/stream?topics=${encodeURIComponent('session:'+ownerRow.key)}`,{cookie:f.cookie(f.user)});
    for(const stream of [adminLogs,memberLogs,adminChat,memberChat,adminForeignSession,memberForeignSession])t.after(()=>stream.close());
    const opened=await Promise.all([adminLogs,memberLogs,adminChat,memberChat,adminForeignSession,memberForeignSession].map(stream=>stream.opened));
    const [aHello,mHello]=await Promise.all([adminForeignSession.next(frame=>frame.event==='hello'),memberForeignSession.next(frame=>frame.event==='hello')]);
    assert.ok(aHello.data.rejected.some(item=>item.issue==='permission-denied'));
    assert.ok(mHello.data.rejected.some(item=>item.issue==='permission-denied'));
    const [aLogs,mLogs]=await Promise.all([
      adminLogs.next(frame=>frame.event==='snapshot'&&frame.data.topic==='logs'),
      memberLogs.next(frame=>frame.event==='snapshot'&&frame.data.topic==='logs'),
    ]);
    const serialized=frame=>JSON.stringify(frame.data.data);
    assert.ok(serialized(aLogs).includes(ownerRow.key));
    assert.ok(!serialized(aLogs).includes(memberRow.key));
    assert.ok(serialized(mLogs).includes(memberRow.key));
    assert.ok(!serialized(mLogs).includes(ownerRow.key));
    assert.match(serialized(aLogs),/Legacy shared history/,'ambiguous legacy history remains visible under Logs permission');
    const adminChatVm=(await f.request('GET',`/api/v${version}/views/chat`,undefined,f.admin)).json.data;
    const memberChatVm=(await f.request('GET',`/api/v${version}/views/chat`,undefined,f.user)).json.data;
    assert.ok(!JSON.stringify(adminChatVm).includes(legacyCanary));assert.ok(!JSON.stringify(memberChatVm).includes(legacyCanary));
    await waitFor(()=>adminChat.frames.some(frame=>frame.event==='snapshot')&&memberChat.frames.some(frame=>frame.event==='snapshot'),{what:'isolated chat snapshots'});
    assert.ok(!adminChat.frames.some(frame=>JSON.stringify(frame.data).includes(legacyCanary)));
    assert.ok(!memberChat.frames.some(frame=>JSON.stringify(frame.data).includes(legacyCanary)));
    assert.equal((await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(ownerRow.key)}`,undefined,f.admin)).status,200);
    assert.equal((await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(memberRow.key)}`,undefined,f.user)).status,200);
    assert.equal((await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(memberRow.key)}`,undefined,f.admin)).status,404);
    assert.equal((await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(ownerRow.key)}`,undefined,f.user)).status,404);
    assert.equal((await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(legacy.key)}`,undefined,f.user)).status,200);
    // Canonical explicit sessions do not create standalone occupants. Office
    // must still scope their token/run contributions for HTTP and SSE.
    const adminOffice=(await f.request('GET',`/api/v${version}/views/office`,undefined,f.admin)).json.data;
    const memberOffice=(await f.request('GET',`/api/v${version}/views/office`,undefined,f.user)).json.data;
    const kpi=(vm,id)=>vm.kpis.find(row=>row.id===id)?.value;
    assert.ok(!adminOffice.occupants.some(row=>row.sessionKey===memberRow.key));
    assert.ok(!memberOffice.occupants.some(row=>row.sessionKey===ownerRow.key));
    assert.equal(kpi(adminOffice,'tokens'),12356,'owner sees own session plus ordinary sessions, not legacy history');
    assert.equal(kpi(memberOffice,'tokens'),22,'member does not see the owner private session or ambiguous legacy history');
    assert.equal(kpi(adminOffice,'runs'),1,'owner run total includes only own private running session');
    assert.equal(kpi(memberOffice,'runs'),0,'foreign private run does not change the member total');
    const adminOfficeStream=openSse(f.base,`/api/v${version}/stream?topics=office`,{cookie:f.cookie(f.admin)});
    const memberOfficeStream=openSse(f.base,`/api/v${version}/stream?topics=office`,{cookie:f.cookie(f.user)});
    t.after(()=>adminOfficeStream.close());t.after(()=>memberOfficeStream.close());
    await Promise.all([adminOfficeStream.opened,memberOfficeStream.opened]);
    const [adminFrame,memberFrame]=await Promise.all([
      adminOfficeStream.next(frame=>frame.event==='snapshot'&&String(frame.data.topic).includes('office')),
      memberOfficeStream.next(frame=>frame.event==='snapshot'&&String(frame.data.topic).includes('office')),
    ]);
    assert.equal(kpi(adminFrame.data.data,'tokens'),12356);
    assert.equal(kpi(memberFrame.data.data,'tokens'),22);
    assert.deepEqual(opened.map(response=>response.statusCode),[200,200,200,200,200,200]);
  }
  // The bounded event journal may outlive a removed canonical session. Missing
  // inventory cannot turn an owner-private event into public office activity.
  rows.splice(rows.indexOf(ownerRow),1);byKey.delete(ownerRow.key);
  const retainedPrivateEvent={id:'retained-owner-private-run',at:Date.now(),kind:'run.started',sessionKey:ownerRow.key,
    occupantId:'primary',actor:{kind:'system'},count:1};
  f.engine.liveEvents=()=>[retainedPrivateEvent];
  for(const version of [2,3]) {
    f.api.topics.invalidate('office');
    const http=(await f.request('GET',`/api/v${version}/views/office`,undefined,f.user)).json.data;
    assert.equal(http.journal.some(event=>event.id===retainedPrivateEvent.id),false,'HTTP fails closed when the source session left the snapshot');
    const stream=openSse(f.base,`/api/v${version}/stream?topics=office`,{cookie:f.cookie(f.user)});t.after(()=>stream.close());await stream.opened;
    const frame=await stream.next(event=>event.event==='snapshot'&&String(event.data.topic).includes('office'));
    assert.equal(frame.data.data.journal.some(event=>event.id===retainedPrivateEvent.id),false,'SSE applies the same lifecycle fence');
  }
});
test('chat capability without principal-scoped sessions is denied on HTTP, cached topic builds, and v2/v3 SSE',async t=>{
  const f=await fixture(t),row=structuredClone(f.engine.sessions()[0]);
  row.key='agent:main:explicit:portal-chat';row.class={...row.class,kind:'explicit',explicitKey:'portal-chat',agentId:'main'};f.engine.sessions=()=>[row];
  f.engine.runtimeFor=()=>({capabilities:{chat:true}});
  f.engine.transcript=()=>({events:[{id:'legacy-leak',kind:'user',text:'UNSCOPED_CHAT_PRIVATE_CANARY',at:Date.now()}],participants:[],window:{from:0,to:1}});
  for(const version of [2,3]) {
    assert.equal((await f.request('GET',`/api/v${version}/views/chat`,undefined,f.admin)).status,404);
    const direct=()=>f.api.topics.current('chat?scope='+encodeURIComponent(scopeForAccount(f.admin.id,f.store)),version);
    assert.throws(direct,{code:'not_found'},'a cached/topic builder cannot bypass the same adapter capability fence');
    const stream=openSse(f.base,`/api/v${version}/stream?topics=chat`,{cookie:f.cookie(f.admin)});t.after(()=>stream.close());await stream.opened;
    const hello=await stream.next(frame=>frame.event==='hello');
    assert.ok(hello.data.rejected.some(item=>item.topic==='chat'&&item.issue==='permission-denied'));
    assert.equal(stream.frames.some(frame=>JSON.stringify(frame.data).includes('UNSCOPED_CHAT_PRIVATE_CANARY')),false);
  }
});
test('revoking chat during an accepted turn preserves its result and actor, but skips the follow-up transcript read',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();
  const chatState=()=>f.api.commands.chatState(scopeForAccount(f.user.id,f.store));
  f.runtime.commands.agentTurn=async()=>{f.calls.push('turn');start.resolve();await finish.promise;return {text:'Accepted reply'};};
  assert.equal((await f.request('POST','/api/v3/chat/messages',{text:'Accepted text'})).status,202);await start.promise;
  f.set('chat','none');finish.resolve();await waitFor(()=>chatState().pending===null,{what:'accepted turn to settle'});
  assert.deepEqual(f.calls,['turn']);
  f.set('chat','write');
  const vm=(await f.request('GET','/api/v3/views/chat',undefined,f.user)).json.data;
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
  for(const events of [[],[{id:'one-echo',kind:'user',text:'Same text',at:10000,senderInfo:sender('person-first')}]]) {
    const vm=buildChatVM({sessionKey:'portal',transcript:{events},local,pending:{turnId:'third',text:'Same text',since:10002,senderInfo:sender('person-third')}});
    assert.equal(vm.messages.length,3);assert.deepEqual(vm.messages.map(m=>m.senderInfo.id),['person-first','person-second','person-third']);
    assert.equal(new Set(vm.messages.map(m=>m.id)).size,3);
  }
});
