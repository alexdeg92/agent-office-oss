'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const express=require('express');
const {openStore}=require('../../src/store');
const {createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed');
const {loadScenario}=require('../helpers/scenario');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
const {mountV2}=require('../../src/api/v2/routes');
const {requestId}=require('../../src/api/v2/errors');
const {waitFor}=require('../helpers/harness');
const {openSse}=require('../helpers/sse-client');
const {dimensionsFromHeader,createPreviewReadLimiter,MAX_PREVIEW_PIXELS}=require('../../src/api/v3/chat-preview');
let passwordHash;before(async()=>{passwordHash=await hashPassword('synthetic-v3-chat-password');});
const key=()=>crypto.randomBytes(18).toString('base64url');
const opaque=prefix=>prefix+'_'+crypto.randomBytes(24).toString('base64url');
function enableFixtureConversationAttachments(f,{send=async()=>({accepted:true}),history=async()=>({messages:[{id:'synthetic-attachment-reply',role:'assistant',at:Date.now(),text:'Attachment received'}]})}={}){
  f.runtime.capabilities.chatAttachments.enabled=true;f.runtime.capabilities.conversations={read:true,send:true,events:true,attachments:true};
  f.runtime.conversations={send,history,async subscribe(){return()=>{};}};
}

async function fixture(t,{fullApp=false,deferChatDispatch=false,teamTarget=false,expireRequestCookieAfterResponse=false,paneTarget=false,paneWritable=true,paneBusy=false,lateReply=null,targetInventory=null,chatRuntimeWritable=true,multiRuntimeAdapter=null}={}){
  const pendingChatDispatches=[];
  const chatDispatchScheduler=deferChatDispatch?{schedule(fn){pendingChatDispatches.push(fn);return fn;},cancel(fn){const i=pendingChatDispatches.indexOf(fn);if(i>=0)pendingChatDispatches.splice(i,1);}}:undefined;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-v3-chat-'));let store=openStore({dir,instance:'test',ownerName:'Synthetic owner',log:()=>{}});
  let owner=store.users.createOwner({email:'chat-owner@example.invalid',personId:store.owner.id,passwordHash});
  const context={userId:owner.id,authGeneration:owner.auth_generation,requestId:'req_chat_fixture',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'chat-member@example.invalid',name:'Synthetic member',roleId:'rol_editor'},context);
  store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash},{requestId:'req_chat_accept'});let member=store.users.byId(invite.user.id);const ownerId=owner.id,memberId=member.id;
  let engine=feed(createEngine(),loadScenario('synthetic-basic')),calls=[],logs=[],multiController=null;
  let runtime={adapterId:'synthetic',name:'Synthetic',connected:true,capabilities:{chat:true,chatSessionScope:'principal',chatAttachments:{enabled:false,maxBytes:1024*1024,maxCountPerMessage:3,maxCountPerSession:10,mimeTypes:['text/plain','application/pdf']}},definition:{id:'synthetic'},commands:{agentTurn:async args=>{calls.push(args);return {text:'Synthetic response'};}}};
  if(multiRuntimeAdapter){
    multiController=require('../../src/multi-runtime-controller').createMultiRuntimeController({cfg:{primaryAgent:'rt:demo:agent:nova',runtimeInstances:[{id:'demo',adapter:'demo',enabled:true,cfg:{agentNames:{},hiddenAgents:[],configuredAgents:null}}]},store,resolveAdapter:()=>multiRuntimeAdapter});
    engine=multiController.engine;runtime=multiController.runtime;runtime.start(engine);
  }
  if(targetInventory){engine.agents=()=>targetInventory.agents;engine.sessions=()=>targetInventory.sessions;engine.primaryAgent=()=>targetInventory.primary;engine.runtimeFor=id=>targetInventory.runtimes[require('../../src/runtime-ids').parseId(id,'agent')?.runtime]||runtime;engine.runtimeForInstance=id=>targetInventory.runtimes[id]||runtime;engine.connectorById=id=>targetInventory.connectors[id]||null;}
  engine.runtime=()=>runtime;if(!targetInventory)engine.runtimeFor=()=>runtime;
  const paneCalls=[];let paneEvents=[];let paneStatus=paneBusy?'working':'idle';let orchestratorTeams=targetInventory?.orchestratorTeams||(teamTarget?{getSnapshot:()=>({team:{id:'team_synthetic',label:'Synthetic team'},members:[{id:'member_lead',teamId:'team_synthetic',roleKind:'lead',hostAgentId:'host_primary',parentMemberId:null}],identityLinks:[{hostAgentId:'host_primary',agentId:engine.primaryAgent().id,confidence:'exact'}]})}:null);
  if(paneTarget){
    const agent=engine.agents().find(item=>!item.isPrimary)||engine.primaryAgent(),sessionKey='synthetic:private-session-key',sessionRef='synthetic-private-session-ref';
    const originalSessions=engine.sessions.bind(engine);engine.sessions=()=>[...originalSessions(),{key:sessionKey,class:{agentId:agent.id,explicitKey:sessionRef},updatedAt:Date.now(),title:'Synthetic pane history'}];
    paneEvents=[{id:'pane-before-user',kind:'user',at:Date.now()-1000,text:'Earlier request'},{id:'pane-before-reply',kind:'assistant',at:Date.now()-500,text:'Earlier reply'}];
    engine.transcript=key=>key===sessionKey?{events:paneEvents}:null;engine.request=async(op,key)=>op==='transcript'&&key===sessionKey?{ok:true,value:{events:paneEvents}}:{ok:false};
    const snapshot=()=>({team:null,members:[{id:'member_synthetic',name:'Synthetic pane agent',roleKind:'member',roleLabel:'builder',teamId:'team_synthetic',parentMemberId:'member_lead',hostAgentId:'host_synthetic',sessionStatus:'known'}],agents:[{id:'host_synthetic',status:paneStatus,staleAfter:Date.now()+60000}],privateMemberSessionRefs:{member_synthetic:{sessionKey,sessionRef,runtimeKind:'synthetic',agentId:agent.id}}});
    orchestratorTeams={chatPaneMessaging:{sendText:paneWritable,exactPaneIdentity:true,readTranscript:true},getSnapshot:snapshot,async refresh(){return snapshot();},async sendPaneText(args){paneCalls.push(args);paneEvents=[...paneEvents,{id:'pane-after-reply-'+paneCalls.length,kind:'assistant',at:Date.now(),text:'Pane reply'}];return {sent:true};}};
  }
  let auth=null,api=null,server=null,base='';
  const boot=async()=>{auth=createAuth({secret:'synthetic-v3-chat-secret',identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
    const mount=app=>{api=mountV2(app,{auth,engine,store,runtime,enforceAuthorization:true,log:event=>logs.push(event),...(chatDispatchScheduler?{chatDispatchScheduler}:{}),chatLateReply:lateReply||{timeoutMs:60,intervalMs:5,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))},...(orchestratorTeams?{orchestratorTeams}:{}),cfg:{instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,timeZone:'UTC',runtimeWritable:chatRuntimeWritable}});};
    let app;
    if(fullApp){const {createApp}=require('../../src/api/http'),{createCsrfGuard}=require('../../src/api/csrf'),{auditMiddleware}=require('../../src/api/audit');app=createApp({readonly:false,apiOnly:true,publicDir:dir,csrf:createCsrfGuard(),audit:auditMiddleware({store,sessionOf:req=>auth.sessionOf(req)}),mountRoutes:mount});}
    else{app=express();app.use(requestId,express.json());if(expireRequestCookieAfterResponse)app.use((req,res,next)=>{if(req.method==='POST'&&/\/chat\/sessions\/[^/]+\/messages$/.test(req.path))res.once('finish',()=>{req.headers.cookie='taco_sess=expired-after-response';});next();});mount(app);}
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;};
  const stop=async()=>{if(api){api.close();api=null;}if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}if(multiController){multiController.close();multiController=null;}};
  await boot();
  const cookieFor=row=>'taco_sess='+auth.signSession({userId:row.id,authGeneration:row.auth_generation,sid:'chat-v3-'+row.id,exp:Date.now()+60000});
  const request=async(method,route,body,headers={},row=owner)=>{const raw=headers.__rawBody;const actualHeaders={...headers};delete actualHeaders.__rawBody;const response=await fetch(base+route,{method,headers:{cookie:cookieFor(row),...(body===undefined?{}:{'content-type':'application/json'}),...(fullApp?{origin:base,'x-ao-request':'1'}:{}),...actualHeaders},body:raw??(body===undefined?undefined:JSON.stringify(body))});return {status:response.status,json:response.headers.get('content-type')?.includes('json')?await response.json():null,response};};
  const reboot=async()=>{await stop();store.close();store=openStore({dir,instance:'test',ownerName:'Synthetic owner',log:()=>{}});owner=store.users.byId(ownerId);member=store.users.byId(memberId);await boot();};
  t.after(async()=>{await stop();try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  const flushChatDispatch=()=>{for(const fn of pendingChatDispatches.splice(0))fn();};
  return {dir,get store(){return store;},get owner(){return owner;},get member(){return member;},engine,runtime,calls,logs,paneCalls,setPaneStatus(value){paneStatus=value;},get api(){return api;},get base(){return base;},get cookie(){return cookieFor(owner);},cookieFor,request,reboot,flushChatDispatch};
}

test('v3 agent index, per-agent session, send and history are mounted and principal-private',async t=>{
  const f=await fixture(t),listed=f.engine.agents.bind(f.engine);f.engine.agents=()=>listed().map(agent=>({...agent,summary:'/private/workspace/never-project-this'}));
  const index=await f.request('GET','/api/v3/chat/agents');assert.equal(index.status,200);assert.ok(index.json.data.agents.length);
  const agent=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(agent);assert.equal(agent.context,null,'workspace path is never projected as chat context');assert.equal(agent.contextLabel,null);assert.equal(agent.capabilities.startSession,true);
  const memberIndex=await f.request('GET','/api/v3/chat/agents',undefined,{},f.member);assert.notEqual(memberIndex.json.data.agents.find(row=>row.kind==='agent').id,agent.id,'target IDs are principal-scoped');
  const agentsStream=openSse(f.base,'/api/v3/stream?topics=chat-agents',{cookie:f.cookie});t.after(()=>agentsStream.close());
  const initial=await agentsStream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-agents');assert.ok(initial.data.data.agents.some(row=>row.id===agent.id));
  const createKey=key(),created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':createKey});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId;assert.match(sessionId,/^cs_[a-f0-9]{48}$/);
  const replay=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':createKey});assert.equal(replay.status,201);assert.equal(replay.json.data.result.sessionId,sessionId);
  const foreign=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},f.member);assert.equal(foreign.status,404,'another account cannot read an owned session');
  const messageKey=key(),sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Synthetic prompt'}, {'Idempotency-Key':messageKey});assert.equal(sent.status,202);
  const sendReplay=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Synthetic prompt'}, {'Idempotency-Key':messageKey});assert.equal(sendReplay.status,202);assert.equal(sendReplay.json.data.result.turnId,sent.json.data.result.turnId);
  const sessionStream=openSse(f.base,`/api/v3/stream?topics=${encodeURIComponent('chat-session:'+sessionId)}`,{cookie:f.cookie});t.after(()=>sessionStream.close());
  const sessionFrame=await sessionStream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-session:'+sessionId);assert.equal(sessionFrame.data.data.id,sessionId);
  await waitFor(()=>f.calls.length===1,{what:'synthetic chat dispatch'});
  assert.equal(f.calls[0].text,'Synthetic prompt');assert.match(f.calls[0].sessionRef,/^portal-chat:user:[a-f0-9]{64}:session:cs_/);
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);assert.equal(detail.json.data.messages.length,2);
  assert.equal(detail.json.data.messages[0].text,'Synthetic prompt');assert.equal(detail.json.data.messages[1].text,'Synthetic response');
  assert.equal(detail.json.data.title,'Synthetic prompt','the first accepted message gives the private session a useful title');
  await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'A later message must not rename the session'}, {'Idempotency-Key':key()});
  await waitFor(()=>f.calls.length===2&&!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'second chat turn completion'});
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`)).json.data.title,'Synthetic prompt','the session title is set only once');
  const missing=await f.request('GET',`/api/v3/chat/sessions/${opaque('cs')}`);assert.equal(missing.status,404);
});

test('adapter-backed stored conversation creates its remote session before subscribing and returns canonical history',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId,target=f.store.chatV3.target(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),agent.id);
  f.runtime.capabilities.conversations={read:true,send:true,events:true};
  const calls=[];let onEvent=null,sendAccepted=false,reads=0;
  f.runtime.commands.agentTurn=async()=>{throw new Error('OpenClaw stored chat must not use the CLI agent-turn path');};
  f.runtime.conversations={async send(params){calls.push('send');assert.equal(params.sessionRef,`portal-chat:user:${require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store)}:session:${sessionId}`);assert.equal(params.expectedLeafId,null);sendAccepted=true;
      return {accepted:true};},
    async subscribe(params){calls.push('subscribe');assert.equal(sendAccepted,true,'new session subscription starts only after the send receipt');assert.equal(params.agentId,target.native_agent_id);onEvent=params.onChange;return async()=>{};},
    async history(params){calls.push('history');assert.equal(sendAccepted,true,'the new conversation is read only after the send receipt');assert.equal(params.agentId,target.native_agent_id);reads++;
      return {messages:[{id:'msg-user',role:'user',at:Date.now()-5,text:'Stored prompt'},
        {id:'msg-assistant',role:'assistant',at:Date.now(),text:'Webchat answer',model:'synthetic-model'}],cursor:'opaque-adapter-cursor',conversationId:'adapter-conversation-1'};}};
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Stored prompt'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'Gateway chat reply reconciliation'});
  assert.deepEqual(calls.slice(0,3),['send','subscribe','history']);assert.equal(reads>=1,true);
  onEvent?.();
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);
  assert.deepEqual(detail.json.data.messages.map(message=>message.text),['Stored prompt','Webchat answer']);
  assert.equal(detail.json.data.messages.some(message=>message.text.includes('discord')),false);
});

test('mounted chat returns a complete oversized history page and continues into older runtime pages',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.runtime.capabilities.conversations={read:true,send:true,events:true};const requests=[];
  const page=Array.from({length:50},(_,i)=>({id:`remote-${String(i).padStart(2,'0')}`,role:'assistant',at:1000+i,text:`message-${i}:`+'\n'.repeat(8000)}));
  const older=Array.from({length:50},(_,i)=>({id:`older-${String(i).padStart(2,'0')}`,role:'assistant',at:i,text:`older-message-${i}`}));
  f.runtime.conversations={async send(){return {accepted:true};},async subscribe(){return async()=>{};},async history(args){requests.push(args);return args.before
    ?{messages:older,hasOlder:false,olderCursor:null}
    :{messages:page,hasOlder:true,olderCursor:'50'};}};
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
  const messages=detail.json.data.messages;
  assert.equal(messages.length,page.length,'cache bounds do not truncate a valid page returned to the caller');
  assert.equal(messages[0].text.startsWith('message-0:'),true,'the oldest message in the current runtime page remains visible');
  assert.ok(messages.at(-1).text.startsWith('message-49:'),'the newest message remains available in the response');
  assert.equal(detail.json.data.pagination.hasOlder,true);
  const cursor=detail.json.data.pagination.olderCursor;assert.equal(typeof cursor,'string');assert.notEqual(cursor,'50','runtime continuation offsets stay private behind a signed API cursor');
  const previous=await f.request('GET',`/api/v3/chat/sessions/${sessionId}?before=${encodeURIComponent(cursor)}`);assert.equal(previous.status,200);
  assert.equal(previous.json.data.messages.length,older.length);assert.equal(previous.json.data.messages[0].text,'older-message-0');
  assert.equal(previous.json.data.pagination.hasOlder,false);assert.equal(requests[1].before,'50');
});

test('read-only conversation adapters and runtime policy expose no send or session-creation affordance',async t=>{
  for(const {runtimeWritable,adapterSend,missingPort} of [{runtimeWritable:false,adapterSend:true},{runtimeWritable:true,adapterSend:false},{runtimeWritable:true,adapterSend:true,missingPort:true}]){
    const f=await fixture(t,{chatRuntimeWritable:runtimeWritable}),sent=[];
    if(missingPort)f.runtime.capabilities.chatAttachments.enabled=true;
    else{
      f.runtime.capabilities.conversations={read:true,send:adapterSend,events:true};
      f.runtime.conversations={async send(args){sent.push(args);return {accepted:true};},async history(){return {messages:[]};},async subscribe(){return async()=>{};}};
    }
    const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
    assert.equal(agent.capabilities.sendMessage,false);assert.equal(agent.capabilities.startSession,false);
    if(missingPort)assert.equal(agent.capabilities.attachments.allowed,false,'an attachment-capable runtime without its conversation port is not writable');
    const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()});
    assert.equal(created.status,404);assert.equal(sent.length,0,'neither readonly source accepts a turn');
  }
});

test('an OpenClaw-led team keeps its principal agent-turn dispatch path',async t=>{
  const f=await fixture(t,{teamTarget:true});
  const index=await f.request('GET','/api/v3/chat/agents');
  const team=index.json.data.agents.find(row=>row.kind==='team');assert.ok(team);
  assert.deepEqual(team.contextLabel,{key:'chat.target.team'},'team role/context is a backend-authored label ref');
  assert.equal(team.capabilities.startSession,true);assert.equal(team.capabilities.sendMessage,true);
  const created=await f.request('POST',`/api/v3/chat/agents/${team.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId;
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'OpenClaw team dispatch'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>f.calls.length===1,{what:'OpenClaw-led team agent-turn dispatch'});
  assert.equal(f.calls[0].text,'OpenClaw team dispatch');assert.equal(f.calls[0].agentId,f.engine.primaryAgent().id);
});

test('T-0197 prod-shaped agent index keeps only primary, registered members and their descendants with each source provider',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const id=(runtime,local)=>scopedId(runtime,'agent',local),session=(runtime,local,agentId,extra={})=>({...extra,key:scopedId(runtime,'session',local),class:{kind:'conversation',agentId,...extra.class},updatedAt:Date.now()});
  const primaryId=id('openclaw','main'),pmId=id('claude-code','pm-session-agent'),builderId=id('codex','builder-session-agent'),childId=id('claude-code','pm-subagent');
  const noiseIds=['agent-office-redesign-a','agent-office-redesign-b','dev','agent-office-connect-ux','Project 8a5edab28263'].map((name,n)=>id(n%2?'codex':'openclaw','noise-'+n));
  const agents=[
    {id:primaryId,name:'Atlas',isPrimary:true,mainSessionKey:scopedId('openclaw','session','main-session')},
    {id:pmId,name:'Project Manager',isPrimary:false,mainSessionKey:scopedId('claude-code','session','pm-thread')},
    {id:builderId,name:'backend-codex',isPrimary:false,mainSessionKey:scopedId('codex','session','builder-thread')},
    {id:childId,name:'PM helper',isPrimary:false,spawnedBy:{agentId:pmId,sessionKey:scopedId('claude-code','session','pm-thread'),via:'subagent-tool',label:'Review helper'},mainSessionKey:scopedId('claude-code','session','child-thread')},
    ...noiseIds.map((agentId,n)=>({id:agentId,name:['agent-office-redesign','agent-office-redesign','dev','agent-office-connect-ux','Project 8a5edab28263'][n],isPrimary:false,mainSessionKey:scopedId(require('../../src/runtime-ids').parseId(agentId,'agent').runtime,'session','noise-thread-'+n)}))
  ];
  const sessions=[
    session('openclaw','main-session',primaryId),session('claude-code','pm-thread',pmId),session('codex','builder-thread',builderId),
    session('claude-code','child-thread',childId,{class:{kind:'subagent'}}),
    ...noiseIds.map((agentId,n)=>session(require('../../src/runtime-ids').parseId(agentId,'agent').runtime,'noise-thread-'+n,agentId))
  ];
  const connector=(id,name,mark)=>({id,adapter:id,name,mark:{monogram:mark,color:'#225577',providerName:name,logo:`assets/connectors/${mark==='CC'?'claude-code':mark==='CX'?'codex':'openclaw'}.svg`}});
  const connectors={openclaw:connector('openclaw','OpenClaw','OC'),'claude-code':connector('claude-code','Claude Code','CC'),codex:connector('codex','Codex','CX')};
  const runtimes=Object.fromEntries(Object.keys(connectors).map(key=>[key,{adapterId:key,name:connectors[key].name,connected:true,capabilities:key==='openclaw'?{chat:true,chatSessionScope:'principal'}:{chat:false}}]));
  const members=[
    {id:'member:pm',name:'PM',teamId:'team:pm',roleKind:'lead',parentMemberId:null,hostAgentId:'host_pm',sessionStatus:'known'},
    {id:'member:builder',name:'backend-codex',teamId:'team:pm',roleKind:'member',parentMemberId:'member:pm',sessionStatus:'known'}
  ];
  const pmThread=scopedId('claude-code','session','pm-thread'),paneCalls=[],pmEvents=[];
  const orchestratorTeams={getSnapshot:()=>({observedAt:Date.now(),team:{id:'team:pm',label:'PM team'},members,agents:[{id:'host_pm',status:'idle',staleAfter:Date.now()+60000}],privateMemberSessionRefs:{
    'member:pm':{agentId:pmId,runtimeKind:'claude-code',sessionRef:'pm-native-ref',sessionKey:pmThread},
    'member:builder':{agentId:builderId,runtimeKind:'codex',sessionRef:'builder-native-ref',sessionKey:scopedId('codex','session','builder-thread')}
  }}),async refresh(){return this.getSnapshot();},async sendPaneText(args){paneCalls.push(args);pmEvents.push({id:'team-pane-reply-'+paneCalls.length,kind:'assistant',at:Date.now(),text:'Pane team response'});}};
  const f=await fixture(t,{deferChatDispatch:true,targetInventory:{agents,sessions,primary:agents[0],connectors,runtimes,orchestratorTeams}}),index=await f.request('GET','/api/v3/chat/agents');
  f.engine.transcript=key=>key===pmThread?{events:pmEvents}:null;f.engine.request=async(op,key)=>op==='transcript'&&key===pmThread?{ok:true,value:{events:pmEvents}}:{ok:false};
  assert.equal(index.status,200);const rows=index.json.data.agents;
  const names=rows.map(row=>row.name);
  assert.ok(names.includes('Atlas'));assert.ok(names.includes('PM'));assert.ok(names.includes('backend-codex'));assert.ok(names.includes('PM helper'));
  for(const noise of ['agent-office-redesign','dev','agent-office-connect-ux','Project 8a5edab28263'])assert.ok(!names.includes(noise),`session/project group ${noise} is not an agent target`);
  assert.equal(names.filter(name=>name==='PM').length,1);assert.equal(names.filter(name=>name==='Project Manager').length,0,'member identity replaces the duplicate runtime session label');
  const agentRows=rows.filter(row=>row.kind==='agent'),byName=Object.fromEntries(agentRows.map(row=>[row.name,row]));
  assert.equal(byName.Atlas.provider.id,'openclaw');assert.equal(byName.PM.provider.id,'claude-code');assert.equal(byName['backend-codex'].provider.id,'codex');assert.equal(byName['PM helper'].provider.id,'claude-code');
  assert.equal(agentRows.length,4,'each canonical agent appears exactly once');
  const nonAgentKinds=[...new Set(rows.filter(row=>row.kind!=='agent').map(row=>row.kind))];
  assert.deepEqual(nonAgentKinds,['team'],'team grouping remains the sole non-agent target; workspace/session groups never appear');
  for(const row of agentRows.filter(row=>row.provider.id!=='openclaw')){assert.equal(row.capabilities.startSession,false);assert.equal(row.capabilities.sendMessage,false);}
  const helper=agentRows.find(row=>row.name==='PM helper');assert.ok(helper);const start=await f.request('POST',`/api/v3/chat/agents/${helper.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(start.status,404,'a read-only delegated runtime cannot start a session via the OpenClaw command proxy');assert.equal(f.calls.length,0);
  let team=rows.find(row=>row.kind==='team');assert.ok(team,'the approved team grouping target remains available');assert.equal(team.capabilities.startSession,false);assert.equal(team.capabilities.sendMessage,false,'a Claude lead is read-only until the exact pane-send path is available');
  assert.equal((await f.request('POST',`/api/v3/chat/agents/${team.id}/sessions`,{}, {'Idempotency-Key':key()})).status,404);
  orchestratorTeams.chatPaneMessaging={sendText:true,exactPaneIdentity:true,readTranscript:true};f.api.topics.invalidate();
  team=(await f.request('GET','/api/v3/chat/agents')).json.data.agents.find(row=>row.kind==='team');assert.equal(team.capabilities.startSession,true);assert.equal(team.capabilities.sendMessage,true,'a ready lead pane enables team chat');
  const teamSession=await f.request('POST',`/api/v3/chat/agents/${team.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(teamSession.status,201);const teamId=teamSession.json.data.result.sessionId;
  const stored=f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),teamId);assert.equal(stored.native_session_ref,'pm-native-ref','team chat binds to the exact lead pane session');
  const sent=await f.request('POST',`/api/v3/chat/sessions/${teamId}/messages`,{text:'Team dispatch remains enabled'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);assert.equal(paneCalls.length,0,'accepted turns dispatch after the HTTP response');f.flushChatDispatch();await waitFor(()=>paneCalls.length===1&&!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),teamId).pending_turn_id,{what:'deferred team message dispatch and reply through the lead pane'});
  assert.deepEqual(paneCalls,[{memberId:'member:pm',sessionRef:'pm-native-ref',runtimeKind:'claude-code',text:'Team dispatch remains enabled'}]);assert.equal(f.calls.length,0,'a Claude lead never falls through to the runtime command proxy');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${teamId}`)).json.data.messages.at(-1).text,'Pane team response');

  const recovered=await f.request('POST',`/api/v3/chat/agents/${team.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(recovered.status,201);
  const recoveredId=recovered.json.data.result.sessionId,recoveredTurn=opaque('turn'),recoveredMessage={id:opaque('msg'),turnId:recoveredTurn,role:'user',at:Date.now(),body:{text:'Resume queued team message after restart'},attachments:[]};
  const recoveredScope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  assert.equal(f.store.chatV3.acceptTurn({scope:recoveredScope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:key(),requestHash:'b'.repeat(64),sessionId:recoveredId,turnId:recoveredTurn,at:recoveredMessage.at,message:recoveredMessage,principalId:f.owner.id}).kind,'accepted');
  await f.reboot();
  assert.equal(f.flushChatDispatch(),undefined);
  await waitFor(()=>paneCalls.length===2&&!f.store.chatV3.get(recoveredScope,recoveredId).pending_turn_id,{what:'startup recovery of a queued team turn with an empty principal scope cache'});
  assert.deepEqual(paneCalls[1],{memberId:'member:pm',sessionRef:'pm-native-ref',runtimeKind:'claude-code',text:'Resume queued team message after restart'});
  assert.equal(f.store.chatV3.queuedTurnDispatches().length,0);assert.equal(f.store.chatV3.dispatchingTurnDispatches().length,0);
});

test('a Codex-led team without the verified pane sender is read-only',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const primaryId=scopedId('openclaw','agent','main'),leadId=scopedId('codex','agent','lead'),leadSession=scopedId('codex','session','lead');
  const adapters=['openclaw','codex'],connectors=Object.fromEntries(adapters.map(adapter=>{const definition=require('../../src/adapters/'+adapter).definition;return [adapter,{id:'fixture-'+adapter,adapter,name:definition.name,mark:definition.mark}];}));
  const runtimes={openclaw:{adapterId:'openclaw',connected:true,capabilities:{chat:true,chatSessionScope:'principal'}},codex:{adapterId:'codex',connected:true,capabilities:{chat:false}}};
  const agents=[{id:primaryId,name:'Primary',isPrimary:true},{id:leadId,name:'Codex lead',isPrimary:false}],sessions=[
    {key:scopedId('openclaw','session','main'),class:{kind:'conversation',agentId:primaryId},updatedAt:Date.now()},
    {key:leadSession,class:{kind:'conversation',agentId:leadId},updatedAt:Date.now()}
  ];
  const orchestratorTeams={getSnapshot:()=>({team:{id:'team:codex',label:'Codex team'},members:[{id:'member:codex-lead',name:'Codex lead',teamId:'team:codex',roleKind:'lead',parentMemberId:null,sessionStatus:'known'}],privateMemberSessionRefs:{'member:codex-lead':{agentId:leadId,runtimeKind:'codex',sessionRef:'codex-lead-ref',sessionKey:leadSession}}})};
  const f=await fixture(t,{targetInventory:{agents,sessions,primary:agents[0],connectors,runtimes,orchestratorTeams}});
  const team=(await f.request('GET','/api/v3/chat/agents')).json.data.agents.find(row=>row.kind==='team');assert.ok(team);
  assert.equal(team.capabilities.startSession,false);assert.equal(team.capabilities.sendMessage,false);
  assert.equal((await f.request('POST',`/api/v3/chat/agents/${team.id}/sessions`,{}, {'Idempotency-Key':key()})).status,404);
});

test('T-0197 private parent chat hides delegated child targets from another account',async t=>{
  const {scopedId}=require('../../src/runtime-ids'),{scopeForAccount,sessionRefForScope}=require('../../src/api/chat-identity');
  const primaryId=scopedId('openclaw','agent','main'),childId=scopedId('claude-code','agent','foreign-child');
  const privateKey=scopedId('openclaw','session','foreign-private-parent'),foreignRef=sessionRefForScope(scopeForAccount('another-account',null))+':session:cs_'+ 'a'.repeat(48);
  const agents=[{id:primaryId,name:'Atlas',isPrimary:true},{id:childId,name:'Private helper',isPrimary:false,spawnedBy:{agentId:primaryId,sessionKey:privateKey,via:'subagent-tool'}}];
  const sessions=[{key:privateKey,class:{kind:'conversation',agentId:primaryId,explicitKey:foreignRef}}];
  const f=await fixture(t,{targetInventory:{agents,sessions,primary:agents[0],connectors:{},runtimes:{}}});
  const index=await f.request('GET','/api/v3/chat/agents');assert.equal(index.status,200);assert.deepEqual(index.json.data.agents.filter(row=>row.kind==='agent').map(row=>row.name),['Atlas']);
});

test('T-0198 Discuter lists and reads only principal-owned stored chat sessions',async t=>{
  const {scopedId}=require('../../src/runtime-ids'),{scopeForAccount}=require('../../src/api/chat-identity');
  const primaryId=scopedId('openclaw','agent','main'),nativeKey=scopedId('openclaw','session','discord-dm-native');
  const agents=[{id:primaryId,name:'Atlas',isPrimary:true}],sessions=[{key:nativeKey,class:{kind:'conversation',agentId:primaryId},updatedAt:Date.now(),title:'Discord private conversation'}];
  const f=await fixture(t,{targetInventory:{agents,sessions,primary:agents[0],connectors:{},runtimes:{}}});
  f.engine.transcript=key=>key===nativeKey?{events:[{kind:'user',text:'private chat identifier 123456789012345'}]}:null;
  const target=(await f.request('GET','/api/v3/chat/agents')).json.data.agents.find(row=>row.kind==='agent');assert.ok(target);
  const oldVirtualId='cs_'+crypto.createHash('sha256').update('chat-readonly-session\0'+scopeForAccount(f.owner.id,f.store)+'\0'+target.id+'\0'+nativeKey).digest('hex').slice(0,48);
  const before=await f.request('GET',`/api/v3/chat/agents/${target.id}/sessions`);assert.equal(before.status,200);assert.deepEqual(before.json.data.sessions,[],'native Discord/cron/runtime history is not imported into Discuter');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${oldVirtualId}`)).status,404,'legacy virtual native-session ids are no longer readable');
  const stream=openSse(f.base,`/api/v3/stream?topics=${encodeURIComponent('chat-session:'+oldVirtualId)}`,{cookie:f.cookie});t.after(()=>stream.close());
  await stream.opened;const hello=await stream.next(frame=>frame.event==='hello');assert.ok(hello.data.rejected?.some(item=>item.topic==='chat-session:'+oldVirtualId),'native history cannot be subscribed as a Discuter conversation');
  const created=await f.request('POST',`/api/v3/chat/agents/${target.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const storedId=created.json.data.result.sessionId,after=await f.request('GET',`/api/v3/chat/agents/${target.id}/sessions`);
  assert.deepEqual(after.json.data.sessions.map(row=>row.id),[storedId],'the list contains only the session created in Discuter');
  const memberAgents=await f.request('GET','/api/v3/chat/agents',undefined,{},f.member),memberTarget=memberAgents.json.data.agents.find(row=>row.kind==='agent');assert.ok(memberTarget);
  const memberCreated=await f.request('POST',`/api/v3/chat/agents/${memberTarget.id}/sessions`,{}, {'Idempotency-Key':key()},f.member);assert.equal(memberCreated.status,201);
  const memberSessionId=memberCreated.json.data.result.sessionId;
  const ownerList=await f.request('GET',`/api/v3/chat/agents/${target.id}/sessions`),memberList=await f.request('GET',`/api/v3/chat/agents/${memberTarget.id}/sessions`,undefined,{},f.member);
  assert.deepEqual(ownerList.json.data.sessions.map(row=>row.id),[storedId],'an administrator sees only their own Discuter sessions');
  assert.deepEqual(memberList.json.data.sessions.map(row=>row.id),[memberSessionId],'a second account sees only its own Discuter sessions');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${memberSessionId}`)).status,404,'even an administrator cannot read another principal’s session');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${storedId}`,undefined,{},f.member)).status,404,'the other principal cannot read the owner’s session');
});

test('pane-linked members appear by identity with read-only transcript, and admins send only to the exact pane',async t=>{
  const f=await fixture(t,{fullApp:true,paneTarget:true}),index=await f.request('GET','/api/v3/chat/agents'),member=index.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  assert.ok(member,'an exact linked pane is listed even when it is not a runtime.chat target');assert.equal(member.capabilities.read,true);assert.equal(member.capabilities.sendMessage,true);assert.equal(member.capabilities.attachments.allowed,false);
  assert.equal(index.json.data.agents.filter(row=>row.name==='Synthetic pane agent').length,1,'the runtime session folds into its member identity');
  const history=await f.request('GET',`/api/v3/chat/agents/${member.id}/sessions`);assert.equal(history.status,200);assert.deepEqual(history.json.data.sessions,[],'pane transcript history is not a Discuter session until the owner starts a stored chat');
  const created=await f.request('POST',`/api/v3/chat/agents/${member.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId,scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),session=f.store.chatV3.get(scope,sessionId);
  assert.equal(session.native_session_ref,'synthetic-private-session-ref','the stored session binds to the exact adapter-private session identity');
  const injection=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'safe\ncommand'},{'Idempotency-Key':key()});assert.equal(injection.status,400);assert.equal(f.paneCalls.length,0);
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'A safe pane message'},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'pane transcript reply'});
  const audit=f.store.db.prepare("SELECT command,target,detail FROM audit_log WHERE command='chat.send' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({...audit},{command:'chat.send',target:sessionId,detail:null},'pane sends are audited against the opaque conversation id without recording message text');
  assert.equal(f.paneCalls.length,1);assert.deepEqual(f.paneCalls[0],{memberId:'member_synthetic',sessionRef:'synthetic-private-session-ref',runtimeKind:'synthetic',text:'A safe pane message'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.messages.at(-1).text,'Pane reply');
  for(let attempt=1;attempt<12;attempt++){
    const next=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:`Pane message ${attempt}`},{'Idempotency-Key':key()});assert.equal(next.status,202);
    await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'rate-limit setup pane reply'});
  }
  const limited=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Thirteenth pane message'},{'Idempotency-Key':key()});assert.equal(limited.status,429,'pane sends are rate-limited before accepting another turn');
  assert.equal(f.paneCalls.length,12);
  const denied=await f.request('GET',`/api/v3/chat/agents`,undefined,{},f.member);if(denied.status===200)assert.ok(!denied.json.data.agents.some(row=>row.id===member.id),'target ids are scoped and team data requires teams.read');
  assert.equal(f.store.policy.can(f.member,'chat.pane.send','write'),false,'pane send is not granted to a non-admin member');
  const stolen=await f.request('POST',`/api/v3/chat/agents/${member.id}/sessions`,{}, {'Idempotency-Key':key()},f.member);assert.ok([403,404].includes(stolen.status),'another account cannot address an administrator pane target');
});

test('an exact pane link is retained when its runtime agent is also the primary chat target',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const agentId=scopedId('claude-code','agent','pm'),sessionKey=scopedId('claude-code','session','pm-thread'),sessionRef='synthetic-pm-pane-ref';
  const agents=[{id:agentId,name:'PM',isPrimary:true,mainSessionKey:sessionKey}],sessions=[{key:sessionKey,class:{kind:'conversation',agentId,explicitKey:sessionRef},updatedAt:Date.now()}];
  const member={id:'member:pm',name:'PM',teamId:'team:pm',roleKind:'lead',parentMemberId:null,hostAgentId:'host-pm',sessionStatus:'known'};
  const snapshot={team:{id:'team:pm',label:'PM'},members:[member],agents:[{id:'host-pm',status:'idle',staleAfter:Date.now()+60_000}],privateMemberSessionRefs:{'member:pm':{agentId,runtimeKind:'claude-code',sessionKey,sessionRef}}};
  const sent=[],orchestratorTeams={chatPaneMessaging:{sendText:true,exactPaneIdentity:true,readTranscript:true},getSnapshot:()=>snapshot,async refresh(){return snapshot;},async sendPaneText(args){sent.push(args);return {sent:true};}};
  const connectors={'claude-code':{id:'claude-code',adapter:'claude-code',name:'Claude Code',mark:{monogram:'CC',color:'#334455',providerName:'Claude Code'}}};
  const runtimes={'claude-code':{adapterId:'claude-code',connected:true,capabilities:{chat:false}}};
  const f=await fixture(t,{targetInventory:{agents,sessions,primary:agents[0],connectors,runtimes,orchestratorTeams}});
  const index=await f.request('GET','/api/v3/chat/agents'),primary=index.json.data.agents.find(row=>row.kind==='agent');
  assert.equal(index.status,200);assert.ok(primary);assert.equal(primary.name,'PM');
  assert.equal(primary.capabilities.startSession,true,'the registered exact pane makes the primary target startable despite runtime chat:false');
  const created=await f.request('POST',`/api/v3/chat/agents/${primary.id}/sessions`,{}, {'Idempotency-Key':key()});
  assert.equal(created.status,201);const saved=f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),created.json.data.result.sessionId);
  assert.equal(saved.native_session_ref,sessionRef,'the startable primary target retains its exact pane session identity');
  f.engine.transcript=()=>({events:[]});
  f.engine.request=async(op,requestedSessionKey)=>({ok:true,value:{events:sent.length?[{id:'pm-pane-reply',kind:'assistant',at:Date.now(),text:'PM pane reply'}]:[]}});
  const sentTurn=await f.request('POST',`/api/v3/chat/sessions/${created.json.data.result.sessionId}/messages`,{text:'Reach the PM pane'},{'Idempotency-Key':key()});
  assert.equal(sentTurn.status,202);await waitFor(()=>sent.length===1&&!f.store.chatV3.get(saved.principal_scope,saved.session_id).pending_turn_id,{what:'primary pane target dispatch'});
  assert.deepEqual(sent,[{memberId:member.id,sessionRef,runtimeKind:'claude-code',text:'Reach the PM pane'}]);
});

test('a deferred primary pane turn fails closed when its link disappears before dispatch',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const agentId=scopedId('claude-code','agent','pm'),sessionKey=scopedId('claude-code','session','pm-thread'),sessionRef='deferred-pm-pane-ref';
  const agents=[{id:agentId,name:'PM',isPrimary:true,mainSessionKey:sessionKey}],sessions=[{key:sessionKey,class:{kind:'conversation',agentId,explicitKey:sessionRef},updatedAt:Date.now()}];
  const member={id:'member:pm-deferred',name:'PM',teamId:'team:pm',roleKind:'lead',parentMemberId:null,hostAgentId:'host-pm',sessionStatus:'known'};
  const snapshot={team:{id:'team:pm',label:'PM'},members:[member],agents:[{id:'host-pm',status:'idle',staleAfter:Date.now()+60_000}],privateMemberSessionRefs:{[member.id]:{agentId,runtimeKind:'claude-code',sessionKey,sessionRef}}};
  const sent=[],orchestratorTeams={chatPaneMessaging:{sendText:true,exactPaneIdentity:true,readTranscript:true},getSnapshot:()=>snapshot,async refresh(){return snapshot;},async sendPaneText(args){sent.push(args);return {sent:true};}};
  const f=await fixture(t,{fullApp:true,deferChatDispatch:true,targetInventory:{agents,sessions,primary:agents[0],connectors:{},runtimes:{'claude-code':{adapterId:'claude-code',connected:true,capabilities:{chat:false}}},orchestratorTeams}});
  const primary=(await f.request('GET','/api/v3/chat/agents')).json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${primary.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId,scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  const accepted=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Must not fall through'},{'Idempotency-Key':key()});assert.equal(accepted.status,202);
  snapshot.members=[];snapshot.privateMemberSessionRefs={};f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'failed closed deferred pane turn'});
  const messages=f.store.chatV3.messages(sessionId,{limit:8});assert.equal(messages.at(-1).status,'failed');
  assert.equal(sent.length,0,'the missing pane identity is never sent');assert.equal(f.calls.length,0,'a stored pane turn cannot fall through to ordinary agentTurn');
});

test('revoking teams.read blocks a primary pane session detail, read acknowledgement, send and SSE snapshot',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const agentId=scopedId('claude-code','agent','pm'),sessionKey=scopedId('claude-code','session','pm-thread'),sessionRef='revocable-pm-pane-ref';
  const agents=[{id:agentId,name:'PM',isPrimary:true,mainSessionKey:sessionKey}],sessions=[{key:sessionKey,class:{kind:'conversation',agentId},updatedAt:Date.now()}];
  const member={id:'member:pm-revocable',name:'PM',teamId:'team:pm',roleKind:'lead',parentMemberId:null,hostAgentId:'host-pm',sessionStatus:'known'};
  const snapshot={team:{id:'team:pm',label:'PM'},members:[member],agents:[{id:'host-pm',status:'idle',staleAfter:Date.now()+60_000}],privateMemberSessionRefs:{[member.id]:{agentId,runtimeKind:'claude-code',sessionKey,sessionRef}}};
  const orchestratorTeams={chatPaneMessaging:{sendText:true,exactPaneIdentity:true,readTranscript:true},getSnapshot:()=>snapshot,async refresh(){return snapshot;},async sendPaneText(){return {sent:true};}};
  const f=await fixture(t,{fullApp:true,targetInventory:{agents,sessions,primary:agents[0],connectors:{},runtimes:{'claude-code':{adapterId:'claude-code',connected:true,capabilities:{chat:false}}},orchestratorTeams}});
  const viewer=f.member;
  f.store.db.prepare("INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level").run(viewer.id,'teams','read');
  const index=await f.request('GET','/api/v3/chat/agents',undefined,{},viewer);assert.equal(index.status,200);
  const primary=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(primary);
  const scope=require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),sessionId=opaque('cs'),messageId=opaque('msg');
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:primary.id,runtimeId:'claude-code',nativeAgentId:'pm',nativeSessionRef:sessionRef,paneMemberId:member.id,title:'Private PM pane'});
  assert.equal(f.store.chatV3.get(scope,sessionId).pane_member_id,member.id,'the stored session retains its pane provenance independently of the current registry');
  f.store.chatV3.addMessage(sessionId,{id:messageId,role:'assistant',at:Date.now(),body:{text:'Pane transcript',blocks:[{type:'text',text:'Pane transcript'}]},attachments:[]},{unread:true});
  f.api.topics.invalidate();
  const beforeRevoke=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},viewer);assert.equal(beforeRevoke.status,200,JSON.stringify({response:beforeRevoke.json,logs:f.logs}));
  const beforeIndex=await f.request('GET','/api/v3/chat/agents',undefined,{},viewer),beforePrimary=beforeIndex.json.data.agents.find(item=>item.id===primary.id);
  assert.equal(beforePrimary.defaultSessionId,sessionId);assert.equal(beforePrimary.unread.count,1);
  const agentsAuthorized=openSse(f.base,'/api/v3/stream?topics=chat-agents',{cookie:f.cookieFor(viewer)});t.after(()=>agentsAuthorized.close());
  const authorizedAgentsFrame=await agentsAuthorized.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-agents');
  const authorizedPrimary=authorizedAgentsFrame.data.data.agents.find(item=>item.id===primary.id);
  assert.equal(authorizedPrimary.defaultSessionId,sessionId);assert.equal(authorizedPrimary.unread.count,1);
  const live=openSse(f.base,`/api/v3/stream?topics=${encodeURIComponent('chat-session:'+sessionId)}`,{cookie:f.cookieFor(viewer)});t.after(()=>live.close());
  await live.opened;await live.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-session:'+sessionId);
  snapshot.members=[];snapshot.privateMemberSessionRefs={};
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},viewer)).status,200,'a removed live link does not erase stored pane provenance for an authorized viewer');
  f.store.db.prepare("UPDATE user_overrides SET level='none' WHERE user_id=? AND resource='teams'").run(viewer.id);
  assert.equal((await f.request('GET',`/api/v3/chat/agents/${primary.id}/sessions`,undefined,{},viewer)).status,403,'the private pane conversation list is also hidden after revocation');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},viewer)).status,403);
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/read`,{throughMessageId:messageId},{'Idempotency-Key':key()},viewer)).status,403);
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Denied after revocation'},{'Idempotency-Key':key()},viewer)).status,403);
  const afterIndex=await f.request('GET','/api/v3/chat/agents',undefined,{},viewer),afterPrimary=afterIndex.json.data.agents.find(item=>item.id===primary.id);
  assert.equal(afterPrimary.defaultSessionId,null,'the revoked viewer cannot learn the pane conversation id from the agent index');assert.equal(afterPrimary.unread.count,0);
  agentsAuthorized.close();await new Promise(resolve=>setTimeout(resolve,25));
  const resumed=openSse(f.base,'/api/v3/stream?topics=chat-agents',{cookie:f.cookieFor(viewer),lastEventId:authorizedAgentsFrame.id});t.after(()=>resumed.close());
  const resumedHello=await resumed.next(frame=>frame.event==='hello');assert.equal(resumedHello.data.resumed,false,'a resumed stream cannot replay a buffer built for the old teams.read partition');
  const resumedSnapshot=await resumed.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-agents');
  const resumedPrimary=resumedSnapshot.data.data.agents.find(item=>item.id===primary.id);
  assert.equal(resumedPrimary.defaultSessionId,null);assert.equal(resumedPrimary.unread.count,0);
  const agentsRevoked=openSse(f.base,'/api/v3/stream?topics=chat-agents',{cookie:f.cookieFor(viewer)});t.after(()=>agentsRevoked.close());
  const agentsSnapshot=await agentsRevoked.next(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-agents');
  const streamedPrimary=agentsSnapshot.data.data.agents.find(item=>item.id===primary.id);assert.equal(streamedPrimary.defaultSessionId,null);assert.equal(streamedPrimary.unread.count,0);
  const revoked=openSse(f.base,`/api/v3/stream?topics=${encodeURIComponent('chat-session:'+sessionId)}`,{cookie:f.cookieFor(viewer)});
  t.after(()=>revoked.close());await revoked.opened;await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(revoked.frames.some(frame=>frame.event==='snapshot'&&frame.data.topic==='chat-session:'+sessionId),false,'a new SSE subscription cannot replay a pane transcript after teams.read is revoked');
});

test('a primary agent with multiple pane sessions requires the exact main session and existing sessions resolve by exact ref',async t=>{
  const {scopedId}=require('../../src/runtime-ids');
  const agentId=scopedId('claude-code','agent','pm'),keyA=scopedId('claude-code','session','pm-a'),keyB=scopedId('claude-code','session','pm-b');
  const inventory=mainSessionKey=>{
    const agents=[{id:agentId,name:'PM',isPrimary:true,...(mainSessionKey?{mainSessionKey}:{})}],sessions=[{key:keyA,class:{kind:'conversation',agentId,explicitKey:'ref-a'}},{key:keyB,class:{kind:'conversation',agentId,explicitKey:'ref-b'}}];
    const members=[['member:pm-a','pane-a',keyA,'ref-a'],['member:pm-b','pane-b',keyB,'ref-b']].map(([id,hostAgentId,sessionKey,sessionRef])=>({id,name:id.endsWith('a')?'PM A':'PM B',teamId:'team:pm',roleKind:'lead',parentMemberId:null,hostAgentId,sessionStatus:'known',sessionKey,sessionRef}));
    const refs=Object.fromEntries(members.map((member,i)=>[member.id,{agentId,runtimeKind:'claude-code',sessionKey:i?keyB:keyA,sessionRef:i?'ref-b':'ref-a'}]));
    const snapshot={team:{id:'team:pm',label:'PM'},members,agents:members.map(member=>({id:member.hostAgentId,status:'idle',staleAfter:Date.now()+60_000})),privateMemberSessionRefs:refs};
    const sent=[],orchestratorTeams={chatPaneMessaging:{sendText:true,exactPaneIdentity:true,readTranscript:true},getSnapshot:()=>snapshot,async refresh(){return snapshot;},async sendPaneText(args){sent.push(args);return {sent:true};}};
    return {agents,sessions,sent,orchestratorTeams,targetInventory:{agents,sessions,primary:agents[0],connectors:{},runtimes:{'claude-code':{adapterId:'claude-code',connected:true,capabilities:{chat:false}}},orchestratorTeams}};
  };
  const ambiguous=inventory(null),f=await fixture(t,{targetInventory:ambiguous.targetInventory});
  const index=await f.request('GET','/api/v3/chat/agents');assert.equal(index.status,200);
  assert.ok(index.json.data.agents.some(row=>row.name==='PM A')&&index.json.data.agents.some(row=>row.name==='PM B'),JSON.stringify(index.json.data.agents));
  const primary=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(primary);assert.equal(primary.capabilities.startSession,false,'an agent-id-only choice cannot select between registered pane sessions');
  assert.equal((await f.request('POST',`/api/v3/chat/agents/${primary.id}/sessions`,{}, {'Idempotency-Key':key()})).status,404);
  const exact=inventory(keyA),g=await fixture(t,{targetInventory:exact.targetInventory});
  const exactIndex=await g.request('GET','/api/v3/chat/agents'),exactPrimary=exactIndex.json.data.agents.find(row=>row.kind==='agent');
  assert.equal(exactPrimary.capabilities.startSession,true,JSON.stringify(exactPrimary));
  const started=await g.request('POST',`/api/v3/chat/agents/${exactPrimary.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(started.status,201);
  assert.equal(g.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(g.owner.id,g.store),started.json.data.result.sessionId).native_session_ref,'ref-a');
  const scope=require('../../src/api/chat-identity').scopeForAccount(g.owner.id,g.store),sessionId=opaque('cs');
  g.store.chatV3.createSession({sessionId,principalScope:scope,agentId:exactPrimary.id,runtimeId:'claude-code',nativeAgentId:'pm',nativeSessionRef:'ref-b',title:'Exact pane B'});
  g.engine.request=async()=>({ok:true,value:{events:[{id:'pane-b-reply',kind:'assistant',at:Date.now(),text:'Reply from pane B'}]}});
  const result=await g.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Route by exact session ref'},{'Idempotency-Key':key()});assert.equal(result.status,202);
  await waitFor(()=>exact.sent.length===1&&!g.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'exact pane selection for an existing primary session'});
  assert.deepEqual(exact.sent,[{memberId:'member:pm-b',sessionRef:'ref-b',runtimeKind:'claude-code',text:'Route by exact session ref'}]);
});

test('pane targets queue messages while busy and deliver them when the pane becomes idle',async t=>{
  const readonly=await fixture(t,{paneTarget:true,paneWritable:false}),index=await readonly.request('GET','/api/v3/chat/agents'),member=index.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  assert.ok(member);assert.equal(member.capabilities.read,true);assert.equal(member.capabilities.sendMessage,false);assert.equal(member.capabilities.storyboard.available,false);
  assert.equal(member.capabilities.storyboard.reason.key,'chat.storyboard.unavailable');
  const sessions=await readonly.request('GET',`/api/v3/chat/agents/${member.id}/sessions`);assert.deepEqual(sessions.json.data.sessions,[]);
  const start=await readonly.request('POST',`/api/v3/chat/agents/${member.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(start.status,404);
  const busy=await fixture(t,{paneTarget:true,paneBusy:true}),busyIndex=await busy.request('GET','/api/v3/chat/agents'),busyMember=busyIndex.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  assert.ok(busyMember);assert.equal(busyMember.capabilities.startSession,true,'busy pane targets can start a conversation');assert.equal(busyMember.capabilities.sendMessage,true);
  const created=await busy.request('POST',`/api/v3/chat/agents/${busyMember.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const workingDetail=await busy.request('GET',`/api/v3/chat/sessions/${created.json.data.result.sessionId}`);
  assert.equal(workingDetail.json.data.capabilities.sendMessage,true,'working pane sessions remain messageable');
  assert.ok(workingDetail.json.data.capabilities.sendNowWarning?.key,'backend supplies a warning for explicit immediate delivery');
  assert.equal(workingDetail.json.data.capabilities.storyboard.available,false,'working pane status disables storyboard in session detail');
  const sessionId=created.json.data.result.sessionId;
  const queued=await busy.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'First queued message'},{'Idempotency-Key':key()});assert.equal(queued.status,202);
  const cancelled=await busy.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Cancel this queued message'},{'Idempotency-Key':key()});assert.equal(cancelled.status,202);
  const cancelResult=await busy.request('DELETE',`/api/v3/chat/sessions/${sessionId}/queued/${cancelled.json.data.result.turnId}`,undefined,{'Idempotency-Key':key()});assert.equal(cancelResult.status,200);
  const finalQueued=await busy.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Last queued message'},{'Idempotency-Key':key()});assert.equal(finalQueued.status,202);
  assert.equal(busy.paneCalls.length,0,'a default send never interrupts a working pane');
  let detail=await busy.request('GET',`/api/v3/chat/sessions/${sessionId}`);
  assert.equal(detail.json.data.messages[0].status,'queued');
  assert.equal(detail.json.data.messages[0].statusLabel.key,'chat.pane.messageQueued');
  assert.equal(detail.json.data.messages[1].status,'cancelled');
  assert.equal(detail.json.data.messages[1].statusLabel.key,'chat.pane.messageCancelled');
  busy.setPaneStatus('idle');
  await waitFor(()=>busy.paneCalls.length===2&&!busy.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(busy.owner.id,busy.store),sessionId).pending_turn_id,{what:'queued pane sends after idle'});
  assert.deepEqual(busy.paneCalls.map(call=>call.text),['First queued message','Last queued message'],'the pane queue delivers in acceptance order and skips cancellation');
  detail=await busy.request('GET',`/api/v3/chat/sessions/${sessionId}`);
  assert.equal(detail.json.data.messages[0].status,'sent','successful pane delivery persists a sent state on the original user bubble');
  assert.equal(detail.json.data.messages[0].statusLabel.key,'chat.pane.messageSent');
});

test('pane queue saturation returns a backend-authored LabelRef for the sender',async t=>{
  const f=await fixture(t,{paneTarget:true,paneBusy:true}),agents=await f.request('GET','/api/v3/chat/agents'),pane=agents.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${pane.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.store.chatV3.enqueuePaneMessage=()=>({kind:'queue-full'});
  const response=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Queue cap notice'},{'Idempotency-Key':key()});
  assert.equal(response.status,429);
  assert.deepEqual(response.json.error.details[0],{issue:'pane-queue-full',label:{key:'chat.pane.queueLimitReached'}});
});

test('pane queue survives server restart and sendNow exposes a backend warning while bypassing the queue',async t=>{
  const f=await fixture(t,{paneTarget:true}),index=await f.request('GET','/api/v3/chat/agents'),member=index.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  f.setPaneStatus('unknown');const created=await f.request('POST',`/api/v3/chat/agents/${member.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId;const queued=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Persist me'},{'Idempotency-Key':key()});assert.equal(queued.status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  assert.equal(f.store.chatV3.messages(sessionId)[0].status,'queued');await f.reboot();assert.equal(f.store.chatV3.messages(sessionId)[0].status,'queued');
  f.setPaneStatus('idle');await waitFor(()=>f.paneCalls.length===1&&!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'restart-resumed pane queue'});
  assert.equal(f.paneCalls[0].text,'Persist me');

  f.setPaneStatus('working');const immediate=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Send now',sendNow:true},{'Idempotency-Key':key()});assert.equal(immediate.status,202);
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.capabilities.sendNowWarning.key,'chat.pane.sendNowWarning');
  await waitFor(()=>f.paneCalls.length===2&&!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'explicit sendNow pane message'});
  assert.equal(f.paneCalls[1].text,'Send now');
});

test('a queued pane message can be sent immediately with an owner-scoped command and backend delivered label',async t=>{
  const f=await fixture(t,{paneTarget:true,paneBusy:true}),index=await f.request('GET','/api/v3/chat/agents'),member=index.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${member.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId,queued=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Send this now'},{'Idempotency-Key':key()});assert.equal(queued.status,202);
  let detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);const queuedMessage=detail.json.data.messages[0];
  assert.equal(queuedMessage.status,'queued');assert.equal(queuedMessage.queueActions.turnId,queued.json.data.result.turnId);
  assert.equal(queuedMessage.queueActions.sendNowLabel.key,'chat.pane.sendNowAction');assert.equal(queuedMessage.queueActions.warningLabel.key,'chat.pane.sendNowWarning');
  const sendNowRoute=`/api/v3/chat/sessions/${sessionId}/queued/${queuedMessage.queueActions.turnId}/send-now`,sendNowKey=key();
  const sentNow=await f.request('POST',sendNowRoute,{}, {'Idempotency-Key':sendNowKey});assert.equal(sentNow.status,202);
  const replay=await f.request('POST',sendNowRoute,{}, {'Idempotency-Key':sendNowKey});assert.equal(replay.status,202);assert.deepEqual(replay.json.data.result,sentNow.json.data.result);
  await waitFor(()=>f.paneCalls.length===1&&!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'explicit queued pane send-now'});
  detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.messages[0].status,'sent');
  assert.deepEqual(detail.json.data.messages[0].statusLabel,{key:'chat.pane.messageSent',params:{name:'Synthetic pane agent'}});
  assert.equal(detail.json.data.messages[0].queueActions,null);
});

test('pane sends queue unknown host status, and editor reset cannot grant pane-send',async t=>{
  const f=await fixture(t,{paneTarget:true}),index=await f.request('GET','/api/v3/chat/agents'),member=index.json.data.agents.find(row=>row.name==='Synthetic pane agent');
  assert.ok(member);f.setPaneStatus('unknown');
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),saved=f.store.chatV3.target(scope,member.id);
  const sessionId='cs_'+crypto.randomBytes(24).toString('hex');
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:member.id,runtimeId:saved.runtime_id,nativeAgentId:saved.native_agent_id,
    nativeSessionRef:'synthetic-private-session-ref',title:'Existing pane history'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);
  assert.equal(detail.status,200);assert.equal(detail.json.data.capabilities.sendMessage,true,'unknown pane status still accepts a durable queued message');
  assert.equal(detail.json.data.capabilities.sendNowWarning.key,'chat.pane.sendNowWarning','unknown pane status supplies the explicit-send warning');
  assert.equal(detail.json.data.capabilities.storyboard.available,false,'unknown pane status disables storyboard in session detail');
  const queued=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'wait for the unknown pane'},{'Idempotency-Key':key()});
  assert.equal(queued.status,202,'unknown/stale host status accepts the message into the durable queue');
  assert.equal(f.store.chatV3.get(scope,sessionId).pending_turn_id,null);
  assert.equal(f.store.chatV3.messages(sessionId,{limit:10})[0].status,'queued');
  assert.equal(f.paneCalls.length,0);

  const revision=f.store.rbac.role('rol_editor').revision;
  f.store.userManagement.resetRole('rol_editor',{expectedRevision:revision},{userId:f.owner.id,authGeneration:f.owner.auth_generation,requestId:'req_reset_pane_permission',authorize:()=>true});
  assert.equal(f.store.policy.can(f.member,'chat.pane.send','write'),false,'the built-in editor reset does not inherit privileged pane-send');
  const editor=f.store.users.byId(f.member.id);
  f.store.db.prepare("INSERT OR REPLACE INTO role_permissions(role_id,resource,mode,level) VALUES ('rol_editor','chat.pane.send','explicit','write')").run();
  assert.equal(f.store.policy.can(editor,'chat.pane.send','write'),false,'even an explicit editor grant cannot enable admin-only pane-send');
});

test('accepted chat reply survives request-cookie rotation after the HTTP response',async t=>{
  const f=await fixture(t,{deferChatDispatch:true,expireRequestCookieAfterResponse:true}),index=await f.request('GET','/api/v3/chat/agents');
  const agent=index.json.data.agents.find(row=>row.kind==='agent'),created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic prompt'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  f.flushChatDispatch();
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'reply after the request cookie is no longer valid'});
  assert.equal(f.calls.length,1,'the accepted turn reaches its adapter');
  const rows=f.store.db.prepare('SELECT role,body_json FROM chat_v3_messages WHERE session_id=? ORDER BY sequence').all(sessionId);
  assert.equal(rows.at(-1).role,'assistant');assert.match(rows.at(-1).body_json,/Synthetic response/);
  assert.deepEqual(f.logs,[],'an expired request cookie does not reject the still-authorized principal');
});

test('v3 completes an empty OpenClaw CLI envelope from the exact refreshed transcript',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const calls=[],cli={parseJson:JSON.parse,async run(argv){calls.push(argv);if(argv[0]==='gateway'){
      const params=JSON.parse(argv.find(value=>value.startsWith('--params=')).slice(9));return {ok:true,out:JSON.stringify({ok:true,path:'/scratch/agents/main/agent/openclaw-agent.sqlite',key:params.key.toLowerCase(),entry:{sessionId:'8f0b3782-0fff-4a97-b161-824608a44ace',lifecycleRevision:'2a267349-1426-405f-823d-f29b8d01eddb',updatedAt:1792031718511,createdVia:'operator',createdAt:1792031718511,sendPolicy:'deny'},resolved:{modelProvider:'openai',model:'gpt-6-astra',agentRuntime:{id:'codex',source:'implicit'},runtimeSelectionLocked:false}})};}
    return {ok:true,out:JSON.stringify({result:{payloads:[]}})};}};
  f.runtime.definition.sessionKeyFor=require('../../src/adapters/openclaw').definition.sessionKeyFor;
  f.runtime.commands.agentTurn=require('../../src/adapters/openclaw/commands').bind(cli).agentTurn;
  const event={id:'synthetic-chat-reply',kind:'assistant',at:Date.now()-600000,text:'Transcript-backed reply'};
  f.engine.transcript=()=>({events:[]});f.engine.request=async(op,sessionKey)=>{assert.equal(op,'transcript');assert.match(sessionKey,/^agent:main:explicit:portal-chat:user:[a-f0-9]{64}:session:cs_/);return {ok:true,value:{events:[event]}};};
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic prompt'}, {'Idempotency-Key':key()})).status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'transcript-backed synthetic reply'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`),reply=detail.json.data.messages.at(-1);
  assert.equal(reply.text,'Transcript-backed reply');assert.equal(reply.role,'assistant');assert.equal(reply.senderInfo.kind,'agent');
  assert.deepEqual(calls.map(argv=>argv[0]),['gateway','agent']);assert.equal(f.logs.length,0);
});

test('v3 keeps legacy mixed-case OpenClaw session ids aligned across policy, dispatch and transcript reads',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const sessionId='cs_'+'A'.repeat(16)+'a'.repeat(16),scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  const target=f.store.chatV3.target(scope,agent.id),nativeSessionRef=`portal-chat:user:${scope}:session:${sessionId}`;
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:agent.id,runtimeId:target.runtime_id,nativeAgentId:target.native_agent_id,nativeSessionRef,title:'Existing mixed-case session'});
  f.runtime.definition=require('../../src/adapters/openclaw').definition;
  const canonicalKey=`agent:main:explicit:${nativeSessionRef}`.toLowerCase(),calls=[];
  const receipt={ok:true,path:'/scratch/agents/main/agent/openclaw-agent.sqlite',key:canonicalKey,
    entry:{sessionId:'8f0b3782-0fff-4a97-b161-824608a44ace',lifecycleRevision:'2a267349-1426-405f-823d-f29b8d01eddb',updatedAt:1792031718511,createdVia:'operator',createdAt:1792031718511,sendPolicy:'deny'},
    resolved:{modelProvider:'openai',model:'gpt-6-astra',agentRuntime:{id:'codex',source:'implicit'},runtimeSelectionLocked:false}};
  const cli={parseJson:JSON.parse,async run(argv){calls.push(argv);return argv[0]==='gateway'?{ok:true,out:JSON.stringify(receipt)}:{ok:true,out:JSON.stringify({result:{payloads:[]}})};}};
  f.runtime.commands.agentTurn=require('../../src/adapters/openclaw/commands').bind(cli).agentTurn;
  f.engine.transcript=sessionKey=>{assert.equal(sessionKey,canonicalKey,'pre-dispatch session lookup uses the canonical key');return {events:[]};};
  f.engine.request=async(op,sessionKey)=>{assert.equal(op,'transcript');assert.equal(sessionKey,canonicalKey,'post-dispatch transcript refresh uses the canonical key');
    return {ok:true,value:{events:[{id:'legacy-canonical-reply',kind:'assistant',at:Date.now(),text:'Canonical reply'}]}};};
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic prompt'},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'reply from the normalized legacy session'});
  assert.equal(JSON.parse(calls[0].find(value=>value.startsWith('--params=')).slice(9)).key,canonicalKey);
  assert.ok(calls[1].includes('--session-key='+canonicalKey));
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.messages.at(-1).text,'Canonical reply');
});

test('v3 refuses a case-folded legacy session collision across principals before transcript lookup or dispatch',async t=>{
  const f=await fixture(t),ownerIndex=await f.request('GET','/api/v3/chat/agents'),ownerAgent=ownerIndex.json.data.agents.find(row=>row.kind==='agent');
  const memberIndex=await f.request('GET','/api/v3/chat/agents',undefined,{},f.member),memberAgent=memberIndex.json.data.agents.find(row=>row.kind==='agent');
  const ownerScope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),memberScope=require('../../src/api/chat-identity').scopeForAccount(f.member.id,f.store);
  const ownerTarget=f.store.chatV3.target(ownerScope,ownerAgent.id),memberTarget=f.store.chatV3.target(memberScope,memberAgent.id);
  const upperId='cs_'+'A'.repeat(16)+'a'.repeat(16),lowerId=upperId.toLowerCase(),sharedRef=`portal-chat:user:${ownerScope}:session:${upperId}`;
  f.store.chatV3.createSession({sessionId:upperId,principalScope:ownerScope,agentId:ownerAgent.id,runtimeId:ownerTarget.runtime_id,nativeAgentId:ownerTarget.native_agent_id,nativeSessionRef:sharedRef,title:'legacy uppercase'});
  // Simulate an older/corrupt principal row whose distinct session id folds
  // onto the same OpenClaw key. The guard must cover the entire runtime key
  // space, not just the current owner's visible session list.
  f.store.chatV3.createSession({sessionId:lowerId,principalScope:memberScope,agentId:memberAgent.id,runtimeId:memberTarget.runtime_id,nativeAgentId:memberTarget.native_agent_id,nativeSessionRef:sharedRef,title:'legacy lowercase'});
  f.runtime.definition=require('../../src/adapters/openclaw').definition;f.runtime.capabilities.chatRetry=true;
  const calls=[];f.runtime.commands.agentTurn=async args=>{calls.push(args);return {text:'must never dispatch'};};
  let transcriptReads=0;f.engine.transcript=()=>{transcriptReads++;throw new Error('collision must be checked first');};
  const sent=await f.request('POST',`/api/v3/chat/sessions/${upperId}/messages`,{text:'private prompt'},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(ownerScope,upperId).pending_turn_id,{what:'collision refusal settles the turn'});
  assert.equal(calls.length,0);assert.equal(transcriptReads,0);
  const detail=await f.request('GET',`/api/v3/chat/sessions/${upperId}`),failed=detail.json.data.messages.at(-1);
  assert.equal(failed.status,'failed');assert.equal(failed.body.text,'');assert.equal(detail.json.data.retryEligible,true,'the turn settles into a retryable failed state');
  assert.deepEqual(f.logs,[{event:'chat.turn.dispatch_failed',runtime:'synthetic',stage:'dispatch',reason:'session-key-collision',targetKind:'agent',authorized:true,valueHadText:false}]);
  assert.doesNotMatch(JSON.stringify(f.logs),/private prompt|portal-chat:user|cs_/);
});

test('v3 uses one OpenClaw canonical key for a legacy mixed-case session through transcript reconciliation',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const sessionId='cs_'+'A'.repeat(16)+'a'.repeat(16),scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  const target=f.store.chatV3.target(scope,agent.id),sessionRef=`portal-chat:user:${scope}:session:${sessionId}`;
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:agent.id,runtimeId:target.runtime_id,nativeAgentId:target.native_agent_id,nativeSessionRef:sessionRef,title:'Mixed-case legacy session'});
  f.runtime.definition=require('../../src/adapters/openclaw').definition;
  const calls=[],expectedKey=`agent:main:explicit:${sessionRef}`.toLowerCase();
  const cli={parseJson:JSON.parse,async run(argv){calls.push(argv);if(argv[0]==='gateway')return {ok:true,out:JSON.stringify({ok:true,path:'/scratch/agents/main/agent/openclaw-agent.sqlite',key:expectedKey,entry:{sessionId:'8f0b3782-0fff-4a97-b161-824608a44ace',lifecycleRevision:'2a267349-1426-405f-823d-f29b8d01eddb',updatedAt:1792031718511,createdVia:'operator',createdAt:1792031718511,sendPolicy:'deny'},resolved:{modelProvider:'openai',model:'gpt-6-astra',agentRuntime:{id:'codex',source:'implicit'},runtimeSelectionLocked:false}})};
    return {ok:true,out:JSON.stringify({result:{payloads:[]}})};}};
  f.runtime.commands.agentTurn=require('../../src/adapters/openclaw/commands').bind(cli).agentTurn;
  f.engine.transcript=sessionKey=>{assert.equal(sessionKey,expectedKey,'prior transcript lookup uses the canonical key');return {events:[]};};
  f.engine.request=async(op,sessionKey)=>{assert.equal(op,'transcript');assert.equal(sessionKey,expectedKey,'post-turn transcript refresh uses the same canonical key');return {ok:true,value:{events:[{id:'canonical-reply',kind:'assistant',at:Date.now(),text:'Canonical transcript reply'}]}};};
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic prompt'},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'canonical legacy-key transcript reply'});
  assert.equal(JSON.parse(calls[0].find(value=>value.startsWith('--params=')).slice(9)).key,expectedKey);
  assert.ok(calls[1].includes('--session-key='+expectedKey));
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.messages.at(-1).text,'Canonical transcript reply');
});

test('v3 failed dispatch is logged without content and keeps the agent author with a LabelRef',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.engine.request=async()=>({ok:true,value:{events:[]}});f.runtime.commands.agentTurn=async()=>({failed:'not-ok'});
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'private synthetic prompt'}, {'Idempotency-Key':key()})).status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id||f.logs.length,{what:'failed synthetic dispatch or diagnostic'});
  assert.equal(f.store.chatV3.get(scope,sessionId).pending_turn_id,null,JSON.stringify(f.logs));
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`),failure=detail.json.data.messages.at(-1);
  assert.equal(failure.role,'assistant');assert.equal(failure.senderInfo.kind,'agent');assert.equal(failure.status,'failed');
  assert.deepEqual(failure.statusLabel,{key:'chat.turnFailed'});assert.equal(failure.body.text,'');
  assert.deepEqual(f.logs,[{event:'chat.turn.dispatch_failed',runtime:'synthetic',stage:'dispatch',reason:'not-ok',targetKind:'agent',authorized:true,valueHadText:false}]);
  assert.doesNotMatch(JSON.stringify(f.logs),/private synthetic prompt|portal-chat:user|synthetic-v3-chat-secret/);
  const next=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),nextSessionId=next.json.data.result.sessionId;
  f.runtime.commands.agentTurn=async()=>{throw new Error('synthetic upstream detail must not be logged');};
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${nextSessionId}/messages`,{text:'another private synthetic prompt'}, {'Idempotency-Key':key()})).status,202);
  await waitFor(()=>!f.store.chatV3.get(scope,nextSessionId).pending_turn_id,{what:'thrown synthetic dispatch'});
  assert.deepEqual(f.logs.at(-1),{event:'chat.turn.dispatch_failed',runtime:'synthetic',stage:'dispatch',reason:'provider-failed',targetKind:'agent',authorized:true,valueHadText:false});
  assert.doesNotMatch(JSON.stringify(f.logs),/upstream detail|another private synthetic prompt|portal-chat:user|synthetic-v3-chat-secret/);
});

for(const refreshMode of ['resolve','reject'])test(`v3 suppresses transcript and envelope replies when access is revoked during a ${refreshMode} refresh`,async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents',undefined,{},f.member),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()},f.member),sessionId=created.json.data.result.sessionId;
  f.runtime.definition.sessionKeyFor=(agentId,ref)=>`synthetic:session:${agentId}:${ref}`;f.engine.transcript=()=>({events:[]});
  let dispatchStarted,releaseDispatch,refreshStarted,releaseRefresh;
  const started=new Promise(resolve=>dispatchStarted=resolve),response=new Promise(resolve=>releaseDispatch=resolve);
  const refreshing=new Promise(resolve=>refreshStarted=resolve),refreshResponse=new Promise((resolve,reject)=>releaseRefresh=()=>refreshMode==='reject'?reject(new Error('private transcript fetch detail')):resolve({ok:true,value:{events:[{id:'revoked-private-reply',kind:'assistant',at:Date.now(),text:'must not be ingested after revocation'}]}}));
  f.runtime.commands.agentTurn=async()=>{dispatchStarted();await response;return {text:'must not be persisted from the envelope after revocation'};};let transcriptReads=0;
  f.engine.request=async()=>{transcriptReads++;refreshStarted();return refreshResponse;};
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic prompt'}, {'Idempotency-Key':key()},f.member)).status,202);
  await started;releaseDispatch();await refreshing;
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(f.member.id,'chat','none');
  releaseRefresh();
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.member.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:`revoked post-dispatch ${refreshMode} transcript refresh settles`});
  assert.equal(transcriptReads,1,'the test crosses the native transcript-refresh boundary');
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},f.member);assert.equal(detail.status,403,'revoked principal cannot read the session');
  const rows=f.store.db.prepare('SELECT role,body_json FROM chat_v3_messages WHERE session_id=? ORDER BY sequence').all(sessionId);
  assert.equal(rows.some(row=>row.body_json.includes('must not be ingested after revocation')||row.body_json.includes('must not be persisted from the envelope')),false,'neither transcript nor adapter-envelope content is persisted after revocation');
  assert.equal(rows.at(-1).role,'assistant');
  assert.deepEqual(f.logs.at(-1),{event:'chat.turn.dispatch_failed',runtime:'synthetic',stage:'reply-reconciliation',reason:'dispatch-failed',targetKind:'agent',authorized:false,valueHadText:true});
});

test('v3 session-list previews flatten structured and Markdown table content into bounded plain text',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'assistant',at:Date.now(),body:{text:'**Progress update**\n\n| Control | Result |\n| --- | --- |\n| Sync | Ready |',blocks:[
    {type:'text',text:'**Progress update**'},{type:'table',headers:['Control','Result'],rows:[['Sync','Ready']]}
  ]},attachments:[]});
  let list=await f.request('GET',`/api/v3/chat/agents/${agent.id}/sessions`);assert.equal(list.status,200);
  let preview=list.json.data.sessions.find(row=>row.id===sessionId).preview;
  assert.equal(preview,'Progress update · Control: Sync · Result: Ready');assert.ok(preview.length<=180);assert.doesNotMatch(preview,/[|*_`~]|---/);
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'assistant',at:Date.now()+1,body:{text:'## **'+('Readable preview content ').repeat(20)+'**',blocks:[]},attachments:[]});
  f.api.topics.invalidate();
  list=await f.request('GET',`/api/v3/chat/agents/${agent.id}/sessions`);preview=list.json.data.sessions.find(row=>row.id===sessionId).preview;
  assert.ok(preview.length>40&&preview.length<=180&&preview.length<('## **'+('Readable preview content ').repeat(20)+'**').length,'long Markdown previews are stripped and capped by the backend');assert.doesNotMatch(preview,/[|*_`~]|---/);
});

test('v3 project kickoff uses a send-capable viewer target once and durably links owner, session and connector',async t=>{
  const f=await fixture(t),viewer=f.member;f.engine.connectorOf=()=>({id:'runtime-synthetic',adapter:'synthetic',name:'Synthetic'});
  const choices=await f.request('GET','/api/v3/views/project-create',undefined,{},viewer);assert.equal(choices.status,200);
  const target=choices.json.data.targets.find(row=>row.capabilities.sendMessage);assert.ok(target);
  const existingPerson=f.store.db.prepare("SELECT id FROM persons WHERE agent_id=? AND ifnull(subagent_id,'')='' ").get(f.engine.primaryAgent().id)?.id;
  assert.equal(choices.json.data.defaultTargetId,target.id);assert.equal(choices.json.data.targets.every(row=>row.capabilities.sendMessage),true);
  const missingKey=await f.request('POST','/api/v3/projects',{name:'Kickoff contract',summary:'Build the synthetic proof',status:'todo',priority:'P1',targetAgentId:target.id},{},viewer);
  assert.equal(missingKey.status,400,'project+turn must be idempotent');
  const keyValue=key(),body={name:'Kickoff contract',summary:'Build the synthetic proof',status:'todo',priority:'P1',targetAgentId:target.id};
  const created=await f.request('POST','/api/v3/projects',body,{'Idempotency-Key':keyValue},viewer);assert.equal(created.status,200,JSON.stringify(created.json));
  const projectId=created.json.data.vm.id,kickoff=created.json.data.vm.kickoff;
  assert.equal(Object.hasOwn(kickoff,'projectId'),false,'the project-scoped kickoff summary omits the redundant id and matches ProjectVM');
  assert.equal(kickoff.status,'queued');assert.equal(kickoff.canRetry,false);assert.match(kickoff.sessionId,/^cs_[a-f0-9]{48}$/);assert.match(kickoff.turnId,/^turn_[A-Za-z0-9_-]{32}$/);
  const scope=require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),session=f.store.chatV3.get(scope,kickoff.sessionId);
  assert.ok(session);assert.equal(session.agent_id,target.id);assert.match(session.native_session_ref,/^portal-chat:user:[a-f0-9]{64}:session:cs_/);
  const assignment=f.store.db.prepare("SELECT p.id,p.kind,p.agent_id,pp.role FROM project_people pp JOIN persons p ON p.id=pp.person_id WHERE pp.project_id=? AND pp.role='owner'").get(projectId);
  assert.equal(assignment.kind,'agent');assert.equal(assignment.agent_id,f.engine.primaryAgent().id);
  assert.equal(assignment.id,existingPerson||require('../../src/projects/runtime-sources').personId('runtime-synthetic',f.engine.primaryAgent().id));
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM persons WHERE agent_id=? AND ifnull(subagent_id,'')='' ").get(f.engine.primaryAgent().id).n,1);
  const linked=f.store.db.prepare("SELECT connector_ids_json,data_json FROM project_sources WHERE project_id=? AND kind='sessionGroup'").get(projectId);
  assert.deepEqual(JSON.parse(linked.connector_ids_json),['runtime-synthetic']);assert.equal(JSON.parse(linked.data_json).ref.name,'Kickoff contract');
  const replay=await f.request('POST','/api/v3/projects',body,{'Idempotency-Key':keyValue},viewer);assert.equal(replay.status,200);
  assert.equal(replay.json.data.vm.id,projectId);assert.equal(replay.json.data.vm.kickoff.sessionId,kickoff.sessionId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(projectId).n,1);
  await waitFor(()=>f.calls.length===1&&!f.store.chatV3.get(scope,kickoff.sessionId).pending_turn_id,{what:'project kickoff dispatch completion'});
  assert.match(f.calls[0].text,/Project: Kickoff contract/);assert.match(f.calls[0].text,/Summary: Build the synthetic proof/);
  assert.match(f.calls[0].text,/Stage: todo/);assert.match(f.calls[0].text,/Priority: P1/);assert.ok(f.calls[0].text.includes('/projets/'+projectId));
  const status=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`,undefined,{},viewer);assert.equal(status.status,200);assert.equal(status.json.data.status,'sent');
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'chat','none');
  const revokedReplay=await f.request('POST','/api/v3/projects',body,{'Idempotency-Key':keyValue},viewer);assert.equal(revokedReplay.status,403,'an idempotency replay cannot return kickoff identifiers after chat access is revoked');
  f.store.db.prepare("DELETE FROM user_overrides WHERE user_id=? AND resource='chat'").run(viewer.id);
  const conflict=await f.request('POST','/api/v3/projects',{...body,name:'Different request'},{'Idempotency-Key':keyValue},viewer);assert.equal(conflict.status,409);
  const foreign=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`,undefined,{},f.owner);assert.equal(foreign.status,404,'kickoff/session status is creator-private');
});

test('failed project kickoff dispatch keeps the project and reports retry only through ChatV3 capability',async t=>{
  const f=await fixture(t);f.runtime.capabilities.chatRetry=true;
  f.runtime.commands.agentTurn=async args=>{f.calls.push(args);return {failed:'synthetic upstream refusal'};};
  const choices=await f.request('GET','/api/v3/views/project-create'),target=choices.json.data.targets[0];
  const created=await f.request('POST','/api/v3/projects',{name:'Retained project',targetAgentId:target.id},{'Idempotency-Key':key()});
  assert.equal(created.status,200);const projectId=created.json.data.vm.id;
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'failed project kickoff settles'});
  const status=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`);assert.equal(status.json.data.status,'failed');
  assert.equal(status.json.data.canRetry,false,'a post-dispatch failure cannot be retried even if the adapter says retryable');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(projectId).n,1,'delivery failure never rolls back or deletes the project');
});

test('project kickoff rechecks chat grants immediately before asynchronous dispatch',async t=>{
  const f=await fixture(t,{deferChatDispatch:true}),viewer=f.member,choices=await f.request('GET','/api/v3/views/project-create',undefined,{},viewer),target=choices.json.data.targets[0];
  const created=await f.request('POST','/api/v3/projects',{name:'Permission race',targetAgentId:target.id},{'Idempotency-Key':key()},viewer);
  assert.equal(created.status,200);const projectId=created.json.data.vm.id;
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'chat','read');
  f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'revoked project kickoff settles without dispatch'});
  assert.equal(f.calls.length,0,'revoked chat write permission prevents the scheduled adapter call');
  const status=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`,undefined,{},viewer);
  assert.equal(status.status,200);assert.equal(status.json.data.status,'failed');assert.equal(status.json.data.canRetry,false,'retry stays hidden without current chat-write capability');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(projectId).n,1);
});

test('project kickoff retry rechecks chat grants immediately before asynchronous dispatch',async t=>{
  const f=await fixture(t,{deferChatDispatch:true}),viewer=f.member;f.runtime.capabilities.chatRetry=true;
  const choices=await f.request('GET','/api/v3/views/project-create',undefined,{},viewer),target=choices.json.data.targets[0];
  const created=await f.request('POST','/api/v3/projects',{name:'Retry permission race',targetAgentId:target.id},{'Idempotency-Key':key()},viewer);
  assert.equal(created.status,200);const projectId=created.json.data.vm.id;
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'chat','read');
  f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'initial permission-revoked kickoff settles'});
  f.store.db.prepare("DELETE FROM user_overrides WHERE user_id=? AND resource='chat'").run(viewer.id);
  const eligible=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`,undefined,{},viewer);assert.equal(eligible.json.data.canRetry,true);
  const retried=await f.request('POST',`/api/v3/projects/${projectId}/kickoff/retry`,{}, {'Idempotency-Key':key()},viewer);assert.equal(retried.status,202,JSON.stringify(retried.json));
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'chat','read');
  f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'revoked retry settles without dispatch'});
  assert.equal(f.calls.length,0,'revoked chat write permission prevents the accepted retry from reaching the adapter');
});

test('team project kickoff retry rechecks teams.read immediately before asynchronous dispatch',async t=>{
  const f=await fixture(t,{deferChatDispatch:true,teamTarget:true}),viewer=f.member;f.runtime.capabilities.chatRetry=true;
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'teams','read');
  const choices=await f.request('GET','/api/v3/views/project-create',undefined,{},viewer),target=choices.json.data.targets.find(row=>row.name==='Synthetic team');assert.ok(target,JSON.stringify(choices.json.data.targets));
  const created=await f.request('POST','/api/v3/projects',{name:'Team retry permission race',targetAgentId:target.id},{'Idempotency-Key':key()},viewer);
  assert.equal(created.status,200);const projectId=created.json.data.vm.id;
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'teams','none');
  f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'team permission-revoked kickoff settles'});
  f.store.db.prepare("UPDATE user_overrides SET level='read' WHERE user_id=? AND resource='teams'").run(viewer.id);
  const eligible=await f.request('GET',`/api/v3/projects/${projectId}/kickoff`,undefined,{},viewer);assert.equal(eligible.json.data.canRetry,true);
  const retried=await f.request('POST',`/api/v3/projects/${projectId}/kickoff/retry`,{}, {'Idempotency-Key':key()},viewer);assert.equal(retried.status,202,JSON.stringify(retried.json));
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'teams','none');
  f.flushChatDispatch();
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store),created.json.data.vm.kickoff.sessionId).pending_turn_id,{what:'revoked team retry settles without dispatch'});
  assert.equal(f.calls.length,0,'revoked teams.read permission prevents the accepted team retry from reaching the adapter');
});

test('v3 chat projects canonical message authors, Office portraits, and provider-declared labels',async t=>{
  const f=await fixture(t);f.engine.connectorOf=()=>({adapter:'synthetic',name:'Synthetic provider',mark:{monogram:'SY',color:'#123456',providerName:'Synthetic provider'}});
  const office=await f.request('GET','/api/v3/views/office');assert.equal(office.status,200);
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(agent);
  const canonicalAgent=f.engine.agents().find(row=>row.name===agent.name),officeAgent=canonicalAgent&&office.json.data.occupants.find(row=>row.id===`agent:${canonicalAgent.id}`);
  if(canonicalAgent?.id===f.engine.primaryAgent()?.id){const officePrimary=office.json.data.occupants.find(row=>row.role==='primary'||row.role==='main');if(officePrimary?.look)assert.deepEqual(agent.portrait.look,officePrimary.look);}
  else if(officeAgent?.look)assert.deepEqual(agent.portrait.look,officeAgent.look);
  assert.equal(agent.provider.label.key,'chat.provider.named');assert.equal(agent.provider.label.params.name,'Synthetic provider');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Synthetic prompt'}, {'Idempotency-Key':key()});
  await waitFor(()=>f.calls.length===1,{what:'author projection chat dispatch'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
  const [userMessage,agentMessage]=detail.json.data.messages;
  assert.equal(userMessage.senderInfo.kind,'human');assert.equal(userMessage.senderInfo.id,f.owner.person_id);
  assert.equal(agentMessage.senderInfo.kind,'agent');assert.equal(agentMessage.senderInfo.name,agent.name);
  assert.deepEqual(agentMessage.avatar,agent.portrait.look);
  const {VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas'),validate=require('../../src/schema').validate;
  assert.equal(validate(VM_SCHEMAS_V3.chatSession,detail.json.data).ok,true);
});

test('a delegated child missing from OfficeVM never inherits its parent portrait',async t=>{
  const f=await fixture(t),savedCurrent=f.api.topics.current,savedSession=f.engine.session;
  const parentLook={lookId:'parent-only-sentinel',palette:'synthetic-parent'};
  const childKey='synthetic:delegated:finished-child';
  f.api.topics.current=(topic,version)=>topic==='office'&&version===3?{vm:{occupants:[{
    id:'agent:'+f.engine.primaryAgent().id,role:'primary',look:parentLook,
  }]}}:savedCurrent(topic,version);
  f.engine.session=key=>key===childKey?{key,class:{kind:'subagent',subagentId:'child-with-private-identity'}}:savedSession(key);
  try{
    const look=f.api.views.chatAvatarFor({kind:'agent',id:'agent:'+f.engine.primaryAgent().id,
      delegation:{sessionKey:childKey}},{officeRead:true});
    assert.notDeepEqual(look,parentLook,'an absent delegated child cannot borrow the parent/target appearance');
  }finally{f.api.topics.current=savedCurrent;f.engine.session=savedSession;}
});

test('mounted projectSession keeps a missing delegated child portrait neutral',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),target=index.json.data.agents.find(row=>row.kind==='agent');
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId=opaque('cs'),messageId=opaque('msg');
  const childKey='synthetic:delegated:stale-child';
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:target.id,runtimeId:'synthetic',nativeAgentId:'primary',nativeSessionRef:'private-delegated-chat',title:'Synthetic delegated chat'});
  f.store.chatV3.addMessage(sessionId,{id:messageId,role:'assistant',at:Date.now(),body:{text:'Completed child',blocks:[{type:'text',text:'Completed child'}]},attachments:[],meta:{senderInfo:{
    kind:'agent',id:'agent:'+f.engine.primaryAgent().id,name:'Parent target',runtime:'synthetic',channel:null,avatarHint:null,
    delegation:{sessionKey:childKey,label:'Completed child'},
  }}});
  const savedCurrent=f.api.topics.current,parentLook={lookId:'parent-target-sentinel',palette:'synthetic-parent'};
  f.api.topics.current=(topic,version)=>topic==='office'&&version===3?{vm:{occupants:[{
    id:'agent:'+f.engine.primaryAgent().id,role:'primary',look:parentLook,
  }]}}:savedCurrent(topic,version);
  try{
    const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
    assert.equal(detail.json.data.messages[0].avatar,null,'projectSession must not fall back to its parent target when child identity is stale');
  }finally{f.api.topics.current=savedCurrent;}
});

test('mounted createApp streams multipart only on the declared Chat upload route after CSRF checks',async t=>{
  const f=await fixture(t,{fullApp:true});enableFixtureConversationAttachments(f);const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const bytes=Buffer.from('Mounted synthetic attachment'),boundary='mounted-chat-upload';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const common={'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(body.length),__rawBody:body};
  const wrong=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,undefined,common);assert.equal(wrong.status,415,'multipart remains refused everywhere except the upload route');
  const foreign=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{...common,origin:'https://foreign.example'});assert.equal(foreign.status,403,'the route exception retains the origin check');
  const uploaded=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,common);assert.equal(uploaded.status,201,JSON.stringify(uploaded.json));
  assert.equal(uploaded.json.data.result.name,'proof.txt');
});

test('adapter-reported post-dispatch failures are never exposed as safe retries',async t=>{
  const f=await fixture(t);f.runtime.capabilities.chatRetry=true;let dispatches=0;
  f.runtime.commands.agentTurn=async args=>{f.calls.push(args);dispatches++;return {failed:'upstream',retryable:true};};
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Do not replay this'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>dispatches===1&&!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'failed dispatched turn completion'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.json.data.retryEligible,false);
  const retry=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/retry`,{turnId:sent.json.data.result.turnId},{'Idempotency-Key':key()});
  assert.equal(retry.status,404);assert.equal(dispatches,1,'the failed provider dispatch is not repeated');
});

test('chat grants project read-only capability and unavailable creation does not strand its idempotency key',async t=>{
  const f=await fixture(t),role='rol_editor',reader=f.member;
  f.store.db.prepare("UPDATE role_permissions SET mode='explicit',level='read' WHERE role_id=? AND resource='chat'").run(role);
  const index=await f.request('GET','/api/v3/chat/agents',undefined,{},reader);assert.equal(index.status,200);
  const agent=index.json.data.agents.find(row=>row.kind==='agent');assert.equal(agent.capabilities.startSession,false);assert.equal(agent.capabilities.sendMessage,false);
  const denied=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()},reader);assert.equal(denied.status,403);
  const {scopeForAccount}=require('../../src/api/chat-identity'),scope=scopeForAccount(reader.id,f.store),targetId=opaque('ca'),sessionId=opaque('cs'),messageId=opaque('msg');
  f.store.chatV3.createTarget({id:targetId,principalScope:scope,kind:'agent',sourceRef:'agent:synthetic:readonly',runtimeId:'synthetic',nativeAgentId:'readonly'});
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:targetId,runtimeId:'synthetic',nativeAgentId:'readonly',nativeSessionRef:'private-ref',title:'Conversation'});
  f.store.chatV3.addMessage(sessionId,{id:messageId,role:'user',at:Date.now(),body:{text:'Visible'},attachments:[]});
  const ack=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/read`,{throughMessageId:messageId},{'Idempotency-Key':key()},reader);assert.equal(ack.status,200,'chat.read alone may acknowledge visible messages');
  const ownerIndex=await f.request('GET','/api/v3/chat/agents'),ownerAgent=ownerIndex.json.data.agents.find(row=>row.kind==='agent'),idem=key();
  f.runtime.connected=false;const unavailable=await f.request('POST',`/api/v3/chat/agents/${ownerAgent.id}/sessions`,{}, {'Idempotency-Key':idem});assert.equal(unavailable.status,404);
  f.runtime.connected=true;const recovered=await f.request('POST',`/api/v3/chat/agents/${ownerAgent.id}/sessions`,{}, {'Idempotency-Key':idem});assert.equal(recovered.status,201);
});

test('chat.read without office.read receives neutral target and message portraits',async t=>{
  const f=await fixture(t),reader=f.member,role='rol_editor';
  f.store.db.prepare("UPDATE role_permissions SET mode='explicit',level='read' WHERE role_id=? AND resource='chat'").run(role);
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(reader.id,'office','none');
  const index=await f.request('GET','/api/v3/chat/agents',undefined,{},reader);assert.equal(index.status,200);
  const target=index.json.data.agents.find(row=>row.kind==='agent');assert.ok(target);
  assert.equal(target.portrait.look,null,'target portraits are withheld without office.read');
  const scope=require('../../src/api/chat-identity').scopeForAccount(reader.id,f.store),sessionId=opaque('cs'),messageId=opaque('msg');
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:target.id,runtimeId:'synthetic',nativeAgentId:'primary',nativeSessionRef:'private-chat-session',title:'Synthetic chat'});
  f.store.chatV3.addMessage(sessionId,{id:messageId,role:'assistant',at:Date.now(),body:{text:'Synthetic reply',blocks:[{type:'text',text:'Synthetic reply'}]},attachments:[]});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},reader);assert.equal(detail.status,200);
  assert.equal(detail.json.data.messages[0].avatar,null,'message portraits are withheld without office.read');
});

test('v3 chat streams typed attachment bytes, verifies digest, and serves only private authorized files',async t=>{
  const f=await fixture(t);f.runtime.capabilities.chatAttachments.enabled=true;f.runtime.capabilities.conversations={read:true,send:true,events:true,attachments:true};let received=null;
  f.runtime.conversations={async send(args){received=args.attachments;return{accepted:true};},async history(){return{messages:[{id:'stored-attachment-reply',role:'assistant',at:Date.now(),text:'Attachment received'}]};},async subscribe(){return()=>{};}};
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const text=Buffer.from('Synthetic private attachment');const boundary='ao-chat-test-boundary';
  f.runtime.capabilities.chatAttachments.maxCountPerSession=1;
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n`),text,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(text).digest('base64')+':';
  const uploadKey=key(),uploadHeaders={'Idempotency-Key':uploadKey,'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(body.length),__rawBody:body};
  const uploaded=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,uploadHeaders);
  assert.equal(uploaded.status,201);const attachment=uploaded.json.data.result;
  const uploadReplay=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,uploadHeaders);
  assert.equal(uploadReplay.status,201);assert.equal(uploadReplay.json.data.result.attachmentId,attachment.attachmentId,'idempotency replay returns the original result before checking the now-full session cap');
  const filePath=path.join(f.dir,'chat-attachments');const names=fs.readdirSync(filePath);assert.equal(names.length,1);assert.match(names[0],/^[a-f0-9]{64}$/);
  const staged=await f.request('GET',`/api/v3/chat/attachments/${attachment.attachmentId}`);assert.equal(staged.status,404,'staged uploads are not downloadable before being attached to a message');
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'',attachmentIds:[attachment.attachmentId]}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>received?.length===1,{what:'synthetic attachment dispatch'});assert.equal(received[0].mimeType,'text/plain');assert.deepEqual(received[0].content,text);assert.equal(JSON.stringify(received).includes(filePath),false);
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
  assert.deepEqual(detail.json.data.title,{key:'chat.newSession'},'attachment-only sessions keep a neutral stored title and localize the default through a LabelRef');
  assert.equal(f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).title,'','localized default titles are never persisted');
  const sessionRows=await f.request('GET',`/api/v3/chat/agents/${agent.id}/sessions`);assert.deepEqual(sessionRows.json.data.sessions[0].title,{key:'chat.newSession'});
  f.runtime.connected=false;const download=await f.request('GET',`/api/v3/chat/attachments/${attachment.attachmentId}`);assert.equal(download.status,200,'owned message attachments remain readable after the runtime disconnects');assert.equal(await download.response.text(),text.toString());
  const wrongAttachmentId=(attachment.attachmentId[0]==='a'?'b':'a')+attachment.attachmentId.slice(1);
  const absent=await f.request('GET',`/api/v3/chat/attachments/${wrongAttachmentId}`);assert.equal(absent.status,404);
});

test('v3 ChatMessage3 projects bounded owner-only image previews and uses the PDF icon fallback',async t=>{
  const f=await fixture(t);enableFixtureConversationAttachments(f,{history:async()=>({messages:[]})});
  Object.assign(f.runtime.capabilities.chatAttachments,{enabled:true,maxBytes:4*1024*1024,maxImageBytes:4*1024*1024,
    mimeTypes:['image/png','application/pdf','text/plain']});
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const files=[
    {name:'atelier.png',mime:'image/png',bytes:Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8XcAAAAASUVORK5CYII=','base64'),Buffer.alloc(2300*1024-68)])},
    {name:'compte-rendu.pdf',mime:'application/pdf',bytes:Buffer.from('%PDF-1.7\nsynthetic preview fallback fixture')},
    {name:'dimensions-excessives.png',mime:'image/png',bytes:(()=>{const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12,'ascii');bytes.writeUInt32BE(5000,16);bytes.writeUInt32BE(4000,20);return bytes;})()},
  ];
  const attachments=[];
  for(const [n,file] of files.entries()){
    const boundary='ao-preview-'+n,form=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),file.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{
      'Idempotency-Key':key(),'Content-Digest':'sha-256=:'+crypto.createHash('sha256').update(file.bytes).digest('base64')+':',
      'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(form.length),__rawBody:form});
    assert.equal(uploaded.status,201,JSON.stringify(uploaded.json));const uploadedFile=uploaded.json.data.result;
    attachments.push({id:uploadedFile.attachmentId,name:uploadedFile.name,mimeType:uploadedFile.mimeType,size:uploadedFile.size});
  }
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  assert.deepEqual(f.store.chatV3.bindAttachments(scope,sessionId,attachments.map(item=>item.id)).map(row=>row.attachment_id),attachments.map(item=>item.id));
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'user',at:Date.now(),body:{text:'Voici les pièces jointes.',blocks:[{type:'text',text:'Voici les pièces jointes.'}]},attachments});
  f.store.chatV3.finishAttachments(attachments.map(item=>item.id));

  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200,JSON.stringify(detail.json));
  const projected=detail.json.data.messages[0].attachments;
  assert.equal(projected[0].preview.kind,'image');assert.ok(projected[0].size>2*1024*1024,'projection supports previously stored images above the former 2 MiB preview ceiling');assert.match(projected[0].preview.thumbnailUrl,/^\/api\/v3\/chat\/attachments\/att_[A-Za-z0-9_-]+\/preview$/);
  assert.equal(projected[0].preview.openUrl,projected[0].preview.thumbnailUrl);assert.equal(projected[0].preview.icon,'image');
  assert.deepEqual(projected[1].preview,{kind:'pdf',thumbnailUrl:null,openUrl:null,icon:'file-text',label:null,alt:null},'PDFs use a backend-declared icon fallback until first-page rendering is available');
  assert.deepEqual(projected[2].preview,{kind:'file',thumbnailUrl:null,openUrl:null,icon:'file',label:null,alt:null},'an image whose header exceeds the decode ceiling has no preview URL');
  assert.equal(JSON.stringify(detail.json).includes(f.dir),false,'VM never reveals private storage or inbox paths');

  const preview=await f.request('GET',projected[0].preview.thumbnailUrl);assert.equal(preview.status,200);
  assert.equal(preview.response.headers.get('content-type'),'image/png');assert.match(preview.response.headers.get('cache-control'),/private, no-store/);
  assert.equal(preview.response.headers.get('content-disposition'),'inline; filename="attachment"');assert.deepEqual(Buffer.from(await preview.response.arrayBuffer()),files[0].bytes);
  const foreign=await f.request('GET',projected[0].preview.thumbnailUrl,undefined,{},f.member);assert.equal(foreign.status,404,'another principal cannot read an attachment preview');
  const absent=await f.request('GET',projected[0].preview.thumbnailUrl.replace(attachments[0].id,'att_'+crypto.randomBytes(24).toString('base64url')));assert.equal(absent.status,404);
  assert.equal((await f.request('GET',`/api/v3/chat/attachments/${attachments[2].id}/preview`)).status,404,'the serving route independently rejects image dimensions over the shared pixel ceiling');
  const expiredAt=Date.now()-31*86400000;
  f.store.db.prepare('UPDATE chat_v3_attachments SET created_at=?,consumed_at=? WHERE attachment_id=?').run(expiredAt,expiredAt,attachments[0].id);
  const expiredVm=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(expiredVm.status,200);
  const expiredPreview=expiredVm.json.data.messages[0].attachments.find(item=>item.id===attachments[0].id);
  assert.deepEqual(expiredPreview.preview,{kind:'file',thumbnailUrl:null,openUrl:null,icon:'file',label:null,alt:null},'expired consumed images use the compact fallback and expose no stale preview URL');
  assert.equal((await f.request('GET',`/api/v3/chat/attachments/${attachments[0].id}/preview`)).status,404,'expired preview URL is rejected by the same eligibility rule');
});

test('chat image preview headers enforce the decode ceiling and preview reads are concurrency bounded',()=>{
  const oversized=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(oversized);oversized.write('IHDR',12,'ascii');oversized.writeUInt32BE(5000,16);oversized.writeUInt32BE(4000,20);
  assert.equal(5000*4000>MAX_PREVIEW_PIXELS,true);assert.equal(dimensionsFromHeader(oversized,'image/png'),null,'PNG header dimensions above 16 MP are not previewable');
  const limiter=createPreviewReadLimiter({globalLimit:2,ownerLimit:1}),releaseA=limiter.acquire('owner-a');assert.equal(typeof releaseA,'function');
  assert.equal(limiter.acquire('owner-a'),null,'one principal cannot hold concurrent previews above its cap');
  const releaseB=limiter.acquire('owner-b');assert.equal(typeof releaseB,'function');assert.equal(limiter.acquire('owner-c'),null,'all principals share the global preview cap');
  releaseA();releaseA();const releaseAgain=limiter.acquire('owner-a');assert.equal(typeof releaseAgain,'function','released preview slots become available');releaseAgain();releaseB();
});

test('v3 adapter conversation sends staged attachment bytes without exposing host paths',async t=>{
  const f=await fixture(t);enableFixtureConversationAttachments(f);const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.runtime.capabilities.chatAttachments.maxImageBytes=10;
  const caps=(await f.request('GET','/api/v3/chat/agents')).json.data.agents.find(row=>row.id===agent.id).capabilities.attachments;
  assert.equal(caps.allowed,true);assert.equal(caps.maxBytes,1024*1024);assert.equal(caps.maxImageBytes,10);assert.equal(caps.limitsLabel.key,'chat.attachments.limits');
  const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('image payload')]),imageBoundary='ao-image-limit';
  const imageForm=Buffer.concat([Buffer.from(`--${imageBoundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),image,Buffer.from(`\r\n--${imageBoundary}--\r\n`)]);
  const imageDigest='sha-256=:'+crypto.createHash('sha256').update(image).digest('base64')+':';
  const oversizedImage=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':imageDigest,'Content-Type':`multipart/form-data; boundary=${imageBoundary}`,'Content-Length':String(imageForm.length),__rawBody:imageForm});
  assert.equal(oversizedImage.status,400);assert.equal(oversizedImage.json.error.details[0].issue,'too-large');
  f.runtime.capabilities.chatAttachments.maxImageBytes=512*1024;
  const bytes=Buffer.from('private adapter attachment'),boundary='ao-private-adapter-attachment';let sentAttachments=null;
  f.runtime.conversations={async send(args){sentAttachments=args.attachments;return {accepted:true};},async history(){return {messages:[{id:'adapter-reply',role:'assistant',at:Date.now(),text:'Attachment received'}]};},async subscribe(){return ()=>{};}};
  const multipart=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const uploaded=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(multipart.length),__rawBody:multipart});
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.json));
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Please read this',attachmentIds:[uploaded.json.data.result.attachmentId]},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>sentAttachments!==null&&!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'adapter attachment dispatch'});
  assert.equal(sentAttachments.length,1);assert.equal(sentAttachments[0].name,'notes.txt');assert.equal(sentAttachments[0].mimeType,'text/plain');
  assert.deepEqual(sentAttachments[0].content,bytes);assert.equal(sentAttachments[0].size,bytes.length);
  assert.equal(JSON.stringify(sentAttachments).includes(f.dir),false,'adapter contract contains bytes, never a host path');
});

test('file-reference attachment delivery keeps OpenClaw on the fenced agent turn and hides private paths from product surfaces',async t=>{
  const f=await fixture(t,{deferChatDispatch:true}),privateRoot=path.join(f.dir,'chat-attachments'),workspace=path.join(f.dir,'synthetic-agent-workspace'),inboxRoot=path.join(workspace,'agent-office-inbox'),dispatches=[];
  fs.mkdirSync(workspace,{mode:0o700});
  f.runtime.capabilities.attachmentDelivery='file-reference';
  f.runtime.capabilities.chatAttachments={enabled:true,maxBytes:1024*1024,maxImageBytes:512*1024,maxCountPerMessage:3,maxCountPerSession:10,
    mimeTypes:['application/pdf','text/plain','image/png','image/jpeg','image/gif','image/webp']};
  // Deliberately no conversations port: the adapter contract selects the
  // fenced agentTurn path and tells it to read private files by reference.
  delete f.runtime.capabilities.conversations;
  f.runtime.attachmentFiles=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace});
  f.runtime.commands.agentTurn=async args=>{dispatches.push(args);return{text:'I can inspect the attached files.'};};
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  assert.equal(agent.capabilities.attachments.allowed,true,'file-reference is a supported adapter delivery capability without chat.send');
  assert.equal(agent.capabilities.attachments.maxCountPerMessage,3);
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const files=[
    {name:'brief.txt',mime:'text/plain',bytes:Buffer.from('Private text fixture')},
    {name:'scan.png',mime:'image/png',bytes:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic image')])},
    {name:'report.pdf',mime:'application/pdf',bytes:Buffer.from('%PDF-1.7\nSynthetic PDF fixture')},
  ];
  const uploaded=[];
  for(const [index,file] of files.entries()){
    const boundary='ao-file-reference-'+index,form=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),file.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const digest='sha-256=:'+crypto.createHash('sha256').update(file.bytes).digest('base64')+':';
    const response=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,
      'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(form.length),__rawBody:form});
    assert.equal(response.status,201,JSON.stringify(response.json));assert.equal(response.json.data.result.name,file.name);
    assert.equal(JSON.stringify(response.json).includes(privateRoot),false,'upload response never reveals private storage paths');uploaded.push(response.json.data.result);
  }
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Please inspect these files.',attachmentIds:uploaded.map(row=>row.attachmentId)}, {'Idempotency-Key':key()});
  assert.equal(sent.status,202);
  const beforeDispatch=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(beforeDispatch.status,200);
  assert.equal(JSON.stringify(beforeDispatch.json).includes(privateRoot),false,'session JSON exposes display metadata and download URLs, never host paths');
  assert.equal(JSON.stringify(f.logs).includes(privateRoot),false,'application logs never include attachment paths');
  f.flushChatDispatch();
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>dispatches.length===1&&!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'file-reference agent turn completes'});
  const args=dispatches[0];assert.equal(args.sessionRef,`portal-chat:user:${scope}:session:${sessionId}`);
  assert.deepEqual(args.attachments,[],'file-reference mode delivers paths only in the explicitly machine-readable prompt block');
  assert.match(args.text,/Please inspect these files\./);assert.match(args.text,/Ouvre les fichiers joints avec tes outils/);
  const block=args.text.match(/<agent-office-attachments version="1">\n([\s\S]*?)\n<\/agent-office-attachments>/);
  assert.ok(block,'dispatch contains a bounded machine-readable private-file block');
  const refs=JSON.parse(block[1]).files;assert.equal(refs.length,3);
  assert.deepEqual(refs.map(row=>row.displayName).sort(),files.map(row=>row.name).sort());
  for(const ref of refs){
    assert.ok(ref.path.startsWith(path.join(inboxRoot,scope)+path.sep),'the runtime receives a reference inside this principal\'s private workspace inbox');
    assert.match(path.basename(ref.path),/^att_[A-Za-z0-9_-]{32,}$/,'only an opaque file name is used in the workspace inbox');
    const source=files.find(file=>file.name===ref.displayName);assert.ok(source);
    assert.equal(ref.mimeType,source.mime);assert.equal(ref.size,source.bytes.length);
    assert.equal(fs.statSync(ref.path).mode&0o077,0,'attachment remains private on disk');
    assert.deepEqual(fs.readFileSync(ref.path),source.bytes,'workspace copy contains the verified upload bytes');
  }
  assert.equal(fs.statSync(inboxRoot).mode&0o077,0,'workspace inbox is private');assert.equal(fs.statSync(path.join(inboxRoot,scope)).mode&0o077,0,'principal inbox is private');
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
  assert.equal(JSON.stringify(detail.json).includes(privateRoot),false,'persisted chat messages never contain private attachment paths');
  assert.equal(JSON.stringify(f.logs).includes(privateRoot),false,'dispatch logging remains path-free');
  const deleted=await f.request('DELETE',`/api/v3/chat/sessions/${sessionId}`,{}, {'Idempotency-Key':key()});assert.equal(deleted.status,200);
  assert.equal(fs.readdirSync(path.join(inboxRoot,scope)).length,0,'deleting the conversation removes its staged workspace copies');
});

test('mounted multi-runtime chat sends attachments through the owning conversation adapter, never agentTurn',async t=>{
  const {definition,createDemoTeam}=require('../../src/adapters/demo');
  const attachmentPolicy={enabled:true,maxBytes:1024*1024,maxImageBytes:512*1024,maxCountPerMessage:3,maxCountPerSession:10,mimeTypes:['text/plain','application/pdf']};
  const adapterDefinition={...definition,id:'demo',name:'Synthetic Gateway',capabilities:()=>({...definition.capabilities(),chat:true,chatSessionScope:'principal',chatAttachments:attachmentPolicy,conversations:{read:true,send:true,events:true,attachments:true}})};
  let delivered=[],conversationSends=0,agentTurns=0;
  const adapter={definition:adapterDefinition,createRuntime(){return{definition:adapterDefinition,commands:{async agentTurn(){agentTurns++;return{text:'wrong legacy path'};}},conversations:{async send(args){conversationSends++;delivered=args.attachments;return{accepted:true};},async history(){return{messages:[{id:'multi-runtime-reply',role:'assistant',at:Date.now(),text:'Received on webchat'}]};},async subscribe(){return()=>{};}},attach(engine){engine.setGatewayConnected(true);engine.ingestCanonical('agents',createDemoTeam().agents());},start(){},close(){}};}};
  const f=await fixture(t,{multiRuntimeAdapter:adapter});await waitFor(()=>f.engine.agents().length>0,{what:'multi-runtime chat target'});
  const index=await f.request('GET','/api/v3/chat/agents');assert.equal(index.status,200);
  const agent=index.json.data.agents.find(row=>row.kind==='agent');assert.equal(agent.capabilities.attachments.allowed,true);
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()});assert.equal(created.status,201);
  const sessionId=created.json.data.result.sessionId,bytes=Buffer.from('private multi-runtime attachment'),boundary='ao-multi-runtime-attachment';
  const form=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const upload=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(form.length),__rawBody:form});assert.equal(upload.status,201);
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Please read this',attachmentIds:[upload.json.data.result.attachmentId]},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'multi-runtime conversation send'});
  assert.equal(conversationSends,1,'the owning adapter conversation port must receive chat.send');
  assert.equal(agentTurns,0,'an attachment-capable target must never silently fall back to agentTurn');
  assert.equal(delivered[0].name,'notes.txt');assert.deepEqual(delivered[0].content,bytes);
});

test('multi-runtime detail keeps stored messages when chat.history is empty and the session subscription is unavailable',async t=>{
  const {definition,createDemoTeam}=require('../../src/adapters/demo');
  const adapterDefinition={...definition,id:'demo',name:'Synthetic Gateway',sessionKeyFor(_agentId,sessionRef){return `agent:main:explicit:${sessionRef}`;},
    capabilities:()=>({...definition.capabilities(),chat:true,chatSessionScope:'principal',conversations:{read:true,send:true,events:true}})};
  const calls=[];let adapterRuntime;
  const adapter={definition:adapterDefinition,createRuntime(){return adapterRuntime={definition:adapterDefinition,commands:{async agentTurn(){throw new Error('must use conversation protocol');}},
    conversations:{async send(){calls.push('send');return{accepted:true};},async history(args){calls.push('history');calls.push(args.sessionRef);return{messages:[]};},async subscribe(){calls.push('subscribe');throw new Error('session mutation target is unavailable');}},
    attach(engine){engine.setGatewayConnected(true);engine.ingestCanonical('agents',createDemoTeam().agents());},start(){},close(){}};}};
  const f=await fixture(t,{multiRuntimeAdapter:adapter});await waitFor(()=>f.engine.agents().length>0,{what:'multi-runtime chat target'});
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),ref=`portal-chat:user:${scope}:session:${sessionId}`;
  assert.match(scope,/^[a-f0-9]{64}$/);assert.match(`agent:main:explicit:${ref}`,/^agent:main:explicit:portal-chat:user:[a-f0-9]{64}:session:cs_[a-f0-9]{48}$/);
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'user',at:Date.now()-2000,body:{text:'Earlier stored question',blocks:[{type:'text',text:'Earlier stored question'}]},attachments:[]});
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'assistant',at:Date.now()-1000,body:{text:'Earlier stored answer',blocks:[{type:'text',text:'Earlier stored answer'}]},attachments:[]});
  const historyReads=[];
  // The runtime lost its old session key and can no longer resolve it. Its
  // realtime subscription would report the same missing-target condition.
  // Stored v3 history must remain authoritative for a read-only detail open.
  // fixture captures the adapter runtime instance, so record the mounted call
  // while returning the same empty-page condition produced by a missing key.
  const originalHistory=adapterRuntime.conversations.history.bind(adapterRuntime.conversations);
  adapterRuntime.conversations.history=async args=>{historyReads.push(args);return originalHistory(args);};
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200,JSON.stringify({error:detail.json,logs:f.logs}));
  assert.ok(detail.json.data.messages.some(message=>message.text==='Earlier stored question'));
  assert.ok(detail.json.data.messages.some(message=>message.text==='Earlier stored answer'));
  assert.equal(historyReads.length,1);assert.equal(historyReads[0].sessionRef,ref,'runtime history receives the principal-scoped production session ref');
  const stream=openSse(f.base,`/api/v3/stream?topics=${encodeURIComponent('chat-session:'+sessionId)}`,{cookie:f.cookie});t.after(()=>stream.close());
  const frame=await stream.next(item=>item.event==='snapshot'&&item.data.topic==='chat-session:'+sessionId);
  assert.ok(frame.data.data.messages.some(message=>message.text==='Earlier stored answer'),'subscription failure cannot blank the stored topic snapshot');
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Continue this conversation'}, {'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'empty history after rejected subscribe settles the accepted turn'});
  const afterSubscribeError=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(afterSubscribeError.status,200);
  assert.ok(afterSubscribeError.json.data.messages.some(message=>message.text==='Earlier stored answer'),'an unavailable runtime subscription and empty poll cannot replace persisted history');
  assert.ok(calls.includes('subscribe'),'the unavailable subscription was exercised through deferred dispatch');
});

test('chat detail evicts a cached runtime page when the next history read errors',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  f.store.chatV3.addMessage(sessionId,{id:opaque('msg'),role:'assistant',at:Date.now(),body:{text:'Persisted answer',blocks:[{type:'text',text:'Persisted answer'}]},attachments:[]});
  f.runtime.capabilities.conversations={read:true,send:true,events:true};let failHistory=false,historyReads=0;
  f.runtime.conversations={async send(){return{accepted:true};},async subscribe(){return()=>{};},async history(){
    historyReads++;
    if(failHistory)throw new Error('history unavailable');
    return{messages:[{id:'cached-runtime-page',role:'assistant',at:Date.now(),text:'Runtime cache must be evicted',model:null,tokens:null}]};
  }};
  const first=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(first.status,200);
  assert.ok(first.json.data.messages.some(message=>message.text==='Runtime cache must be evicted'),'successful runtime history populates the private cache');
  assert.equal(historyReads,1);
  failHistory=true;
  const second=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(second.status,200);
  assert.equal(historyReads,2,'the second detail request exercises a fresh runtime history failure');
  assert.ok(second.json.data.messages.some(message=>message.text==='Persisted answer'),'history failure falls back to stored v3 messages');
  assert.equal(second.json.data.messages.some(message=>message.text==='Runtime cache must be evicted'),false,'a failed refresh evicts the stale runtime page');
});

test('accepted adapter attachment dispatch rechecks current grants before reading private bytes',async t=>{
  const f=await fixture(t,{deferChatDispatch:true}),viewer=f.member;
  f.runtime.capabilities.chatAttachments.enabled=true;
  f.runtime.capabilities.conversations={read:true,send:true,events:true,attachments:true};
  let sends=0;f.runtime.conversations={async send(){sends++;throw new Error('revoked dispatch must not reach adapter send');},async history(){return {messages:[]};},async subscribe(){return ()=>{};}};
  const index=await f.request('GET','/api/v3/chat/agents',undefined,{},viewer),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()},viewer),sessionId=created.json.data.result.sessionId;
  const bytes=Buffer.from('revoke before read'),boundary='ao-revoked-attachment';
  const form=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const upload=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(form.length),__rawBody:form},viewer);
  assert.equal(upload.status,201);
  const accepted=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'process this private file',attachmentIds:[upload.json.data.result.attachmentId]},{'Idempotency-Key':key()},viewer);
  assert.equal(accepted.status,202);
  f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(viewer.id,'chat','none');
  assert.equal(f.store.policy.can(viewer,'chat','read'),false);assert.equal(f.store.policy.can(viewer,'chat','write'),false);
  const originalOpen=fs.promises.open;let privateReads=0;
  fs.promises.open=function(file,...args){if(String(file).includes('chat-attachments'))privateReads++;return originalOpen.call(this,file,...args);};
  try{await f.flushChatDispatch();}finally{fs.promises.open=originalOpen;}
  const scope=require('../../src/api/chat-identity').scopeForAccount(viewer.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'revoked accepted attachment dispatch settles'});
  assert.equal(privateReads,0,'revoked authority prevents opening private attachment bytes');
  assert.equal(sends,0,'revoked authority prevents adapter dispatch');
  assert.equal(f.runtime.capabilities.conversations.send,true,'the mocked adapter remains send-capable; authorization is the sole reason for refusal');
});

test('concurrent attachment uploads reserve the per-session slot atomically',async t=>{
  const f=await fixture(t);f.runtime.capabilities.chatAttachments.enabled=true;f.runtime.capabilities.conversations={read:true,send:true,events:true,attachments:true};f.runtime.conversations={async send(){return{accepted:true};},async history(){return{messages:[]};},async subscribe(){return()=>{};}};f.runtime.capabilities.chatAttachments.maxCountPerSession=1;
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const bytes=Buffer.from('one synthetic file'),boundary='ao-chat-concurrent-boundary';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="one.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const send=()=>f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(body.length),__rawBody:body});
  const results=await Promise.all([send(),send()]);
  assert.deepEqual(results.map(row=>row.status).sort(),[201,429],'only the request that atomically reserves the sole session slot may upload');
  assert.equal(f.store.chatV3.attachmentCount(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId),1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_upload_reservations').get().n,0);
});

test('startup resumes a durably accepted chat turn queued before deferred dispatch',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),turnId=opaque('turn'),idem={scope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:key(),requestHash:'a'.repeat(64)};
  const msg={id:opaque('msg'),turnId,role:'user',at:Date.now(),body:{text:'Resume after restart'},attachments:[]};
  assert.equal(f.store.chatV3.acceptTurn({...idem,sessionId,turnId,at:msg.at,message:msg,principalId:f.owner.id}).kind,'accepted');
  assert.equal(f.store.chatV3.queuedTurnDispatches().length,1,'acceptance is durable before the HTTP continuation is scheduled');
  await f.reboot();
  await waitFor(()=>f.calls.length===1&&!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'startup dispatch recovery'});
  assert.equal(f.calls[0].text,'Resume after restart');
  assert.equal(f.store.chatV3.queuedTurnDispatches().length,0);assert.equal(f.store.chatV3.dispatchingTurnDispatches().length,0);
});

test('a stale pending turn without a dispatch receipt is resolved on startup',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),turnId=opaque('turn');
  f.store.chatV3.setPending(sessionId,turnId,Date.now()-3*86400000);
  await f.reboot();
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);assert.equal(detail.json.data.turnPending,null);
  assert.equal(detail.json.data.messages.at(-1).status,'unknown');assert.equal(detail.json.data.messages.at(-1).statusLabel.key,'chat.turnUncertain');
  assert.equal(f.calls.length,0,'legacy ambiguous state is resolved without risking a duplicate provider send');
});

test('team chat history and acknowledgements recheck current teams.read grants',async t=>{
  const f=await fixture(t),scope=require('../../src/api/chat-identity').scopeForAccount(f.member.id,f.store),targetId=opaque('ct'),sessionId=opaque('cs'),messageId=opaque('msg');
  f.store.chatV3.createTarget({id:targetId,principalScope:scope,kind:'team',sourceRef:'team:revocable',runtimeId:'synthetic',nativeAgentId:'atlas'});
  f.store.chatV3.createSession({sessionId,principalScope:scope,agentId:targetId,runtimeId:'synthetic',nativeAgentId:'atlas',nativeSessionRef:'private-team-session',title:'Private team'});
  f.store.chatV3.addMessage(sessionId,{id:messageId,role:'assistant',at:Date.now(),body:{text:'Private team content'},attachments:[]},{unread:true});
  f.store.db.prepare("INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level").run(f.member.id,'teams','none');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`,undefined,{},f.member)).status,403);
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/read`,{throughMessageId:messageId},{'Idempotency-Key':key()},f.member)).status,403);
});

test('valid UTF-8 text with a split codepoint at the sniff boundary is accepted',async t=>{
  const f=await fixture(t);enableFixtureConversationAttachments(f);const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const bytes=Buffer.from('a'.repeat(31)+'é'),boundary='ao-chat-utf8-boundary';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utf8.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const uploaded=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(body.length),__rawBody:body});
  assert.equal(uploaded.status,201);assert.equal(uploaded.json.data.result.mimeType,'text/plain');
});

test('v3 private session persists canonical assistant and delegated results despite runtime clock skew',async t=>{
  const f=await fixture(t),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const runtimeKey='synthetic:private-session',childKey='synthetic:delegated:private-child';
  f.runtime.definition.sessionKeyFor=(agentId,ref)=>`${runtimeKey}:${agentId}:${ref}`;
  const previous={id:'ev:prior',kind:'assistant',at:Date.now()-60000,text:'Earlier private reply',senderInfo:{kind:'agent',id:'agent:synthetic-primary',name:'Synthetic agent',runtime:'synthetic',channel:null,avatarHint:null}};
  const reply={id:'ev:turn-reply',kind:'assistant',at:Date.now()-600000,text:'The review is complete.',model:'synthetic-model',outputTokens:17,
    senderInfo:{kind:'agent',id:'agent:synthetic-primary',name:'Synthetic agent',runtime:'synthetic',channel:null,avatarHint:null}};
  const delegated={id:'ev:turn-child',kind:'subagent-result',at:Date.now()-600001,title:'Review the API boundary',status:'completed',body:'The route checks pass.',text:'The route checks pass.',
    senderInfo:{kind:'agent',id:childKey,name:'Boundary reviewer',runtime:'synthetic',channel:null,avatarHint:null,delegation:{sessionKey:childKey,label:'Boundary reviewer'}}};
  let transcript={events:[previous]},nativeKey=null,refreshCalls=[];
  f.engine.transcript=sessionKey=>sessionKey===nativeKey?transcript:null;
  f.engine.request=async(op,sessionKey)=>{refreshCalls.push({op,sessionKey});transcript={events:[previous,delegated,reply]};return {ok:true,value:transcript};};
  f.runtime.commands.agentTurn=async args=>{f.calls.push(args);nativeKey=f.runtime.definition.sessionKeyFor(args.agentId,args.sessionRef);return {text:'The review is complete.',meta:{model:'synthetic-model',tokens:17}};};
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),stored=f.store.chatV3.get(scope,sessionId),target=f.store.chatV3.target(scope,stored.agent_id);
  nativeKey=f.runtime.definition.sessionKeyFor(target.native_agent_id,stored.native_session_ref);
  const prompt='Review the API boundary';
  await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:prompt},{'Idempotency-Key':key()});
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'canonical turn completion in v3 session'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`);assert.equal(detail.status,200);
  assert.deepEqual(refreshCalls,[{op:'transcript',sessionKey:nativeKey}],'v3 refreshes the adapter-declared canonical session transcript after dispatch');
  assert.deepEqual(detail.json.data.messages.map(message=>message.kind),['message','subagent-result','message']);
  const child=detail.json.data.messages[1];assert.equal(child.title,'Review the API boundary');assert.equal(child.status,'completed');
  assert.equal(child.statusLabel.key,'chat.result.status.completed');assert.equal(child.collapsedByDefault,true);
  assert.equal(child.senderInfo.delegation.sessionKey,childKey);assert.equal(child.avatar,null);
  assert.equal(detail.json.data.messages[2].text,'The review is complete.');assert.equal(detail.json.data.messages[2].meta.model,'synthetic-model');
  assert.ok(detail.json.data.messages.every(message=>!JSON.stringify(message).includes(f.calls[0].sessionRef)),'private runtime session refs never enter the public chat VM');
});

test('completed attachment downloads release every opened file handle',async t=>{
  const f=await fixture(t);enableFixtureConversationAttachments(f);const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const bytes=Buffer.from('Download handle regression'),boundary='ao-chat-handle-boundary';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="handles.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const digest='sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';
  const up=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/attachments`,undefined,{'Idempotency-Key':key(),'Content-Digest':digest,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(body.length),__rawBody:body});assert.equal(up.status,201);
  const sent=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'Use attachment',attachmentIds:[up.json.data.result.attachmentId]},{'Idempotency-Key':key()});assert.equal(sent.status,202);
  await waitFor(()=>!f.store.chatV3.get(require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store),sessionId).pending_turn_id,{what:'download attachment turn completion'});
  const savedOpen=fs.promises.open,handles=[];fs.promises.open=async(...args)=>{const handle=await savedOpen(...args);if(String(args[0]).startsWith(path.join(f.dir,'chat-attachments')+path.sep))handles.push(handle);return handle;};
  try{for(let n=0;n<6;n++){const response=await f.request('GET',`/api/v3/chat/attachments/${up.json.data.result.attachmentId}`);assert.equal(response.status,200);await response.response.arrayBuffer();}
    await new Promise(resolve=>setTimeout(resolve,25));assert.equal(handles.length,6);assert.ok(handles.every(handle=>handle.fd===-1));
  }finally{fs.promises.open=savedOpen;for(const handle of handles)if(handle.fd!==-1)await handle.close();}
});

test('v3 keeps a delegated OpenClaw turn pending until its late reply reaches the transcript',async t=>{
  const f=await fixture(t,{lateReply:{timeoutMs:5000,intervalMs:5,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}});
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.runtime.definition.sessionKeyFor=require('../../src/adapters/openclaw').definition.sessionKeyFor;
  // The first run yields to a sub-agent: empty envelope, no assistant text yet.
  f.runtime.commands.agentTurn=async()=>({text:'',files:[],meta:null});
  let reads=0;const late={id:'synthetic-late-reply',kind:'assistant',at:Date.now(),text:'Delegated synthetic answer'};
  f.engine.transcript=()=>({events:[]});f.engine.request=async op=>{assert.equal(op,'transcript');reads++;return {ok:true,value:{events:reads>=4?[late]:[]}};};
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic delegated prompt'}, {'Idempotency-Key':key()})).status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'late delegated reply'});
  const detail=await f.request('GET',`/api/v3/chat/sessions/${sessionId}`),reply=detail.json.data.messages.at(-1);
  assert.equal(reply.text,'Delegated synthetic answer');assert.equal(reply.role,'assistant');assert.ok(reads>=4);
  assert.deepEqual(f.logs.filter(entry=>entry?.event==='chat.turn.dispatch_failed'),[]);
});

test('v3 still fails a turn whose reply never arrives within the late-reply window',async t=>{
  const f=await fixture(t);
  const index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  f.runtime.definition.sessionKeyFor=require('../../src/adapters/openclaw').definition.sessionKeyFor;
  f.runtime.commands.agentTurn=async()=>({text:'',files:[],meta:null});
  f.engine.transcript=()=>({events:[]});f.engine.request=async()=>({ok:true,value:{events:[]}});
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic silent prompt'}, {'Idempotency-Key':key()})).status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'bounded late-reply failure'});
  assert.equal(f.logs.filter(entry=>entry?.event==='chat.turn.dispatch_failed').length,1);
});

test('v3 persists no earlier late-poll transcript content when access is revoked before a later poll',async t=>{
  const f=await fixture(t,{lateReply:{timeoutMs:5000,intervalMs:5,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}});
  const index=await f.request('GET','/api/v3/chat/agents',undefined,{},f.member),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()},f.member),sessionId=created.json.data.result.sessionId;
  f.runtime.definition.sessionKeyFor=require('../../src/adapters/openclaw').definition.sessionKeyFor;
  f.runtime.commands.agentTurn=async()=>({text:'',files:[],meta:null});
  const sub={id:'synthetic-sub-result',kind:'subagent-result',at:Date.now(),text:'must not persist after revocation',status:'completed'};
  let reads=0;
  f.engine.transcript=()=>({events:[]});
  f.engine.request=async()=>{reads++;
    if(reads===2)f.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(f.member.id,'chat','none');
    return {ok:true,value:{events:[sub]}};};
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/messages`,{text:'synthetic revoked prompt'}, {'Idempotency-Key':key()},f.member)).status,202);
  const scope=require('../../src/api/chat-identity').scopeForAccount(f.member.id,f.store);
  await waitFor(()=>!f.store.chatV3.get(scope,sessionId).pending_turn_id,{what:'revoked late poll settles'});
  assert.ok(reads>=2,'the test crosses a later late-reply poll');
  const rows=f.store.db.prepare('SELECT body_json FROM chat_v3_messages WHERE session_id=?').all(sessionId);
  assert.equal(rows.some(row=>row.body_json.includes('must not persist after revocation')),false,'no transcript text is persisted after revocation');
});

test('v3 conversation lifecycle is owner-scoped, idempotent, audited, undoable, and purges only AO data',async t=>{
  const f=await fixture(t,{fullApp:true}),index=await f.request('GET','/api/v3/chat/agents'),agent=index.json.data.agents.find(row=>row.kind==='agent');
  const created=await f.request('POST',`/api/v3/chat/agents/${agent.id}/sessions`,{}, {'Idempotency-Key':key()}),sessionId=created.json.data.result.sessionId;
  const ownerScope=require('../../src/api/chat-identity').scopeForAccount(f.owner.id,f.store);

  const renamedKey=key(),renamed=await f.request('PATCH',`/api/v3/chat/sessions/${sessionId}/title`,{title:'  Préparer la revue  '},{'Idempotency-Key':renamedKey});
  assert.equal(renamed.status,200);assert.equal(renamed.json.data.result.title,'Préparer la revue');
  const renameReplay=await f.request('PATCH',`/api/v3/chat/sessions/${sessionId}/title`,{title:'  Préparer la revue  '},{'Idempotency-Key':renamedKey});
  assert.equal(renameReplay.status,200);assert.equal(renameReplay.json.data.result.title,'Préparer la revue');
  assert.equal((await f.request('PATCH',`/api/v3/chat/sessions/${sessionId}/title`,{title:'Foreign rename'},{'Idempotency-Key':key()},f.member)).status,404);

  const archivedKey=key(),archived=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/archive`,{archived:true},{'Idempotency-Key':archivedKey});
  assert.equal(archived.status,200);assert.equal(archived.json.data.result.archived,true);
  assert.equal((await f.request('POST',`/api/v3/chat/sessions/${sessionId}/archive`,{archived:true},{'Idempotency-Key':archivedKey})).status,200,'archive command replays without a second mutation');
  const active=(await f.request('GET',`/api/v3/chat/agents/${agent.id}/sessions?filter=active`)).json.data;
  const archivedList=(await f.request('GET',`/api/v3/chat/agents/${agent.id}/sessions?filter=archived`)).json.data;
  assert.ok(!active.sessions.some(row=>row.id===sessionId));assert.equal(archivedList.sessions[0].id,sessionId);
  assert.equal(archivedList.sessions[0].actions.restore,true);assert.equal(archivedList.filter,'archived');

  const deletedKey=key(),deleted=await f.request('DELETE',`/api/v3/chat/sessions/${sessionId}`,undefined,{'Idempotency-Key':deletedKey});
  assert.equal(deleted.status,200);assert.equal(deleted.json.data.result.runtimeTranscriptDeleted,false);assert.ok(deleted.json.data.result.undoUntil>Date.now());
  assert.equal(deleted.json.data.result.runtimeTranscriptLabel.key,'chat.session.runtimeTranscriptRetained');
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`)).status,404,'soft-deleted conversations are immediately hidden');
  assert.equal((await f.request('DELETE',`/api/v3/chat/sessions/${sessionId}`,undefined,{'Idempotency-Key':deletedKey})).status,200,'delete retry returns its original idempotent receipt');
  const restored=await f.request('POST',`/api/v3/chat/sessions/${sessionId}/undo-delete`,undefined,{'Idempotency-Key':key()});
  assert.equal(restored.status,200);assert.equal(restored.json.data.result.restored,true);
  assert.equal((await f.request('GET',`/api/v3/chat/sessions/${sessionId}`)).status,200);

  const messageId=opaque('msg');f.store.chatV3.addMessage(sessionId,{id:messageId,role:'assistant',at:Date.now(),body:{text:'AO-only purge fixture'},attachments:[]});
  const storageName='a'.repeat(64),attachmentId=opaque('att'),uploadRoot=require('../../src/api/v3/chat-upload').privateDirectory(f.dir);
  fs.writeFileSync(path.join(uploadRoot,storageName),'expired synthetic attachment',{mode:0o600});
  f.store.chatV3.attachment({attachmentId,principalScope:ownerScope,sessionId,name:'expired.txt',mimeType:'text/plain',size:28,sha256:'b'.repeat(64),storageName});
  f.store.db.prepare('UPDATE chat_v3_sessions SET deleted_at=?,delete_after=? WHERE principal_scope=? AND session_id=?').run(Date.now()-40000,Date.now()-1,ownerScope,sessionId);
  const foreignScope='c'.repeat(64),foreignTarget=f.store.chatV3.createTarget({id:opaque('ca'),principalScope:foreignScope,kind:'agent',sourceRef:'synthetic:foreign-agent',runtimeId:'synthetic',nativeAgentId:'foreign'});
  const foreignSessionId=opaque('cs');f.store.chatV3.createSession({sessionId:foreignSessionId,principalScope:foreignScope,agentId:foreignTarget.target_id,runtimeId:'synthetic',nativeAgentId:'foreign',nativeSessionRef:'synthetic:foreign-session',title:'Expired for inactive owner'});
  f.store.db.prepare('UPDATE chat_v3_sessions SET deleted_at=?,delete_after=? WHERE principal_scope=? AND session_id=?').run(Date.now()-40000,Date.now()-1,foreignScope,foreignSessionId);
  const failedCleanup=f.store.maintenance({unlinkChatStorage:()=>false});
  assert.equal(failedCleanup.pruned.chat.sessions,1,'a transient unlink failure keeps that session reference for retry');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_sessions WHERE session_id=?').get(sessionId).n,1,'failed attachment cleanup retains the session row');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_attachments WHERE attachment_id=?').get(attachmentId).n,1,'failed attachment cleanup retains its metadata reference');
  assert.equal(fs.existsSync(path.join(uploadRoot,storageName)),true,'the failing unlink leaves private bytes available for retry');
  const purged=f.store.maintenance();assert.equal(purged.pruned.chat.sessions,1,'bounded scheduled maintenance retries expired deletes without a list request');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_sessions WHERE session_id=?').get(sessionId).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_sessions WHERE session_id=?').get(foreignSessionId).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_v3_messages WHERE session_id=?').get(sessionId).n,0,'purging cascades only the Agent Office transcript rows');
  assert.equal(fs.existsSync(path.join(uploadRoot,storageName)),false,'maintenance removes the attachment content file with its expired session');
  const audit=f.store.db.prepare("SELECT command,target,outcome FROM audit_log WHERE target=? AND outcome='ok' AND command IN ('chat.renameSession','chat.archiveSession','chat.deleteSession','chat.undoDeleteSession') ORDER BY id").all(sessionId);
  assert.deepEqual(audit.map(row=>row.command),['chat.renameSession','chat.renameSession','chat.archiveSession','chat.archiveSession','chat.deleteSession','chat.deleteSession','chat.undoDeleteSession']);
  assert.equal(audit.at(-1).target,sessionId);
});
