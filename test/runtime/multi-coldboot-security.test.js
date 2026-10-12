'use strict';
// S35: synthetic adapters and temporary stores only; no service manager, CLI or real runtime home.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMultiRuntimeController}=require('../../src/multi-runtime-controller');
const {openStore}=require('../../src/store'),{createEngine}=require('../../src/engine'),{createMultiEngine}=require('../../src/engine/multi');
const {definition,createDemoTeam}=require('../../src/adapters/demo'),{scopedId,validNativeId}=require('../../src/runtime-ids');
const {createApp}=require('../../src/api/http'),{mountV2}=require('../../src/api/v2/routes');
const {resolveWireId}=require('../../src/api/v2/runtime-projection');
function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-coldboot-synthetic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
const caps=()=>({...definition.capabilities(),flows:{read:true,write:true,schedules:['cron'],multiAgent:true},skills:{list:true,detail:true,toggle:true}});
function syntheticAdapter(calls) {
 return {definition:{...definition,capabilities:caps},createRuntime(cfg){let engine;const commands={};
  for(const method of ['flowRun','flowSetEnabled','flowDelete','flowEdit','skillSetEnabled'])commands[method]=async key=>{calls.push([method,cfg.runtimeId,key]);return{ok:true};};
  return {definition:this.definition,commands,attach(e){engine=e;e.setReads({flowRuns:async key=>{calls.push(['read-flow',cfg.runtimeId,key]);e.ingestCanonical('flowRuns',[],{key});return{ok:true};},transcript:async key=>{calls.push(['read-session',cfg.runtimeId,key]);return{ok:true};},skillInfo:async key=>{calls.push(['read-skill',cfg.runtimeId,key]);return{ok:false,category:'unavailable'};}});},start(){if(cfg.unavailable)throw Error('synthetic outage');engine.setGatewayConnected(true);},close(){}};
 }};
}
function config(mode='enabled') {
 return {instance:'test',readonly:false,readonlyStore:false,agentNames:{},primaryAgent:null,runtimeInstances:[
  ...(mode==='removed'?[]:[{id:'legacy',adapter:'demo',enabled:mode!=='disabled',config:{adapter:'demo'},cfg:{runtimeId:'legacy',unavailable:mode==='unavailable'}}]),
  {id:'other',adapter:'demo',enabled:true,config:{adapter:'demo'},cfg:{runtimeId:'other'}}]};
}
async function boot(dir,mode='enabled') {
 const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',log:()=>{}}),calls=[];
 const controller=createMultiRuntimeController({cfg:config(mode),store,resolveAdapter:()=>syntheticAdapter(calls)});
 let api;const app=createApp({apiOnly:true,mountRoutes:app=>{api=mountV2(app,{engine:controller.engine,runtime:controller.runtime,cfg:controller.cfg,
  auth:{onRevoke(){},sessionOf:()=>({sid:'synthetic-owner',email:'owner@example.test'})}});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 controller.runtime.start();
 const request=async(method,url,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 return {store,controller,calls,request,topics:api.topics,async close(){api.close();server.closeAllConnections();await new Promise(r=>server.close(r));controller.close();store.close();}};
}
function aliasRows(engine,scope) {
 const team=createDemoTeam(),flow={...team.flows()[0],id:scopedId(scope,'flow','daily')},session={...team.sessionList()[0],key:scopedId(scope,'session','shared-session')},skill={...team.skills()[0],name:scopedId(scope,'skill','shared-skill')};
 engine.ingestCanonical('flows',[flow]);engine.ingestCanonical('sessions.snapshot',[session]);engine.ingestCanonical('skills',[skill]);
 return {flow,session,skill};
}
function nativeTargets(engine) {
 const team=createDemoTeam();engine.ingestCanonical('agents',team.agents());engine.ingestCanonical('flows',[{...team.flows()[0],id:'daily'}]);
 engine.ingestCanonical('sessions.snapshot',[{...team.sessionList()[0],key:'shared-session'}]);engine.ingestCanonical('skills',[{...team.skills()[0],name:'shared-skill'}]);engine.setGatewayConnected(true);
}
test('S35-01 old v2 aliases survive three fresh controller/API/store lifetimes with legacy disabled, unavailable or removed',async t=>{
 const dir=temp(t),first=await boot(dir);
 const historical=aliasRows(first.controller.engine.instances.find(i=>i.id==='legacy').engine,'other');
 const legacy=first.controller.engine.instances.find(i=>i.id==='legacy').engine;
 legacy.ingestCanonical('flows',[]);legacy.ingestCanonical('sessions.snapshot',[]);legacy.ingestCanonical('skills',[]);
 await first.close();
 for(const mode of ['disabled','unavailable','removed']) {
  const h=await boot(dir,mode);try {
   nativeTargets(h.controller.engine.instances.find(i=>i.id==='other').engine);
   for(const [method,url,body] of [['GET','/views/flows/'+encodeURIComponent(historical.flow.id)],['POST','/flows/'+encodeURIComponent(historical.flow.id)+'/runs',{}],['PUT','/flows/'+encodeURIComponent(historical.flow.id)+'/enabled',{enabled:false}],['PATCH','/flows/'+encodeURIComponent(historical.flow.id),{name:'Synthetic edit'}],['DELETE','/flows/'+encodeURIComponent(historical.flow.id),{}],['GET','/views/sessions/'+encodeURIComponent(historical.session.key)],['GET','/views/skills/'+encodeURIComponent(historical.skill.name)],['PUT','/skills/'+encodeURIComponent(historical.skill.name)+'/enabled',{enabled:false}]]) {
    const response=await h.request(method,'/api/v2'+url,body);assert.equal(response.status,409,JSON.stringify({mode,method,url,response}));
   }
   for(const [kind,wire] of [['flow',historical.flow.id],['session',historical.session.key],['skill',historical.skill.name]])assert.throws(()=>h.topics.current(kind+':'+encodeURIComponent(wire),2),{code:'conflict'});
   assert.deepEqual(h.calls,[],'cold boot cannot assign an old alias to either source');
   assert.equal((await h.request('POST','/api/v3/flows/'+encodeURIComponent(historical.flow.id)+'/runs',{})).status,200);
   assert.deepEqual(h.calls,[['flowRun','other','daily'],['read-flow','other','daily']],'authorized v3 mutation and refresh both stay on other');
   assert.ok(h.store.runtimeAliases.load().seen.size>=3);
   assert.ok(!h.store.db.prepare('SELECT hashes FROM runtime_alias_policy WHERE id = 1').get().hashes.includes('shared-session'),'stored policy contains hashes, never native identifiers');
  } finally {await h.close();}
 }
});
test('S35-01 saturation refusal remains durable after restart even when the legacy inventory is empty',async t=>{
 const dir=temp(t),first=await boot(dir),legacy=first.controller.engine.instances.find(i=>i.id==='legacy').engine,base=createDemoTeam().flows()[0];
 legacy.ingestCanonical('flows',Array.from({length:4097},(_,n)=>({...base,id:scopedId('other','flow','historical-'+n)})));
 legacy.ingestCanonical('flows',[]);await first.close();
 const h=await boot(dir,'removed');try {
  nativeTargets(h.controller.engine.instances.find(i=>i.id==='other').engine);
  const unknown=scopedId('other','flow','not-in-history');
  const response=await h.request('POST','/api/v2/flows/'+encodeURIComponent(unknown)+'/runs',{});assert.equal(response.status,409,JSON.stringify(response));assert.deepEqual(h.calls,[]);
  const state=h.store.runtimeAliases.load();assert.equal(state.seen.size,4096);assert.equal(state.overflow,true);
  assert.equal(resolveWireId(h.controller.engine,unknown,'flow',3),unknown);
 } finally {await h.close();}
});
test('S35-01 corrupted durable refusal history fails closed without revealing data',t=>{
 const dir=temp(t),store=openStore({dir,instance:'test',ownerName:'Synthetic',log:()=>{}});t.after(()=>store.close());
 store.db.prepare('INSERT INTO runtime_alias_policy (id,hashes,overflow) VALUES (1,?,0)').run('["PRIVATE_INVALID_HISTORY"]');
 const controller=createMultiRuntimeController({cfg:config('removed'),store,resolveAdapter:()=>syntheticAdapter([])});t.after(()=>controller.close());
 assert.throws(()=>resolveWireId(controller.engine,scopedId('other','flow','daily'),'flow',2),{code:'conflict'});
 assert.ok(!JSON.stringify(controller.engine.quarantine.list()).includes('PRIVATE_INVALID_HISTORY'));
});

test('S35-02 malformed canonical/raw source IDs never break shared agent/meta/office/Settings HTTP views; corrected snapshots recover',async t=>{
 const {settingsFixture}=require('../helpers/settings-fixture'),{waitFor}=require('../helpers/harness');
 const h=await settingsFixture({effectiveV3:true});t.after(()=>h.close());
 await h.reauth();const saved=await h.put('/api/v3/settings/runtimes',{expectedRevision:1,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url},{id:'healthy',adapter:'demo',enabled:true}]});assert.equal(saved.status,200,saved.text);
 await waitFor(()=>h.engine.agents().some(a=>a.id.startsWith('rt:healthy:')));
 const bad=h.engine.instances.find(i=>i.id==='legacy').engine,good=h.engine.instances.find(i=>i.id==='healthy').engine,team=createDemoTeam();
 bad.updateAgents({configured:null,names:{},hidden:[],primary:null});
 for(const invalid of ['PRIVATE_NATIVE_SENTINEL\nID','x'.repeat(4097),'é'.repeat(2049),'\ud800']) {
  for(const source of ['canonical','raw']) {
   const baseline={...team.agents()[0],id:'valid-agent'};bad.ingestCanonical('agents',[baseline]);
   if(source==='canonical')assert.equal(bad.ingestCanonical('agents',[{...baseline,id:invalid}]).ok,false);
   else {
    const result=bad.ingest({source:'gateway',channel:'gw.rpc.agents.list',body:{kind:'json',value:{agents:[{id:invalid,name:'Synthetic invalid',workspace:''}],defaultId:invalid,mainKey:'synthetic-session'}}});
    assert.equal(result.ok,true,'native envelope has a valid raw shape');
    assert.ok(result.issues.some(i=>i.code==='shape.invalid' && i.path.startsWith('$.canonical.agent')),'identity is rejected at canonical adapter admission');
    assert.ok(bad.sources().some(s=>s.channels.some(c=>c.channel==='gw.rpc.agents.list' && c.state==='stale')),'last-good data is explicitly stale');
   }
   let updateError;
   try { good.ingestCanonical('agents',[{...team.agents()[0],name:'Healthy keeps updating '+source}]); } catch(error) { updateError=error; }
   for(const url of ['/api/v3/meta','/api/v3/views/office','/api/v3/settings']) {const response=await h.get(url);assert.equal(response.status,200,url+': '+response.text);assert.ok(!response.text.includes('PRIVATE_NATIVE_SENTINEL'));}
   assert.equal(updateError,undefined,'an invalid source cannot interrupt healthy-source updates');
   assert.doesNotThrow(()=>h.engine.agents(),source);assert.ok(h.engine.agents().some(a=>a.id.startsWith('rt:healthy:')));
   assert.ok(bad.agents().some(a=>a.id==='valid-agent'),'invalid roster retains last good admitted source snapshot');
   assert.ok(!h.engine.detectedAgents().some(a=>require('../../src/runtime-ids').parseId(a.id)?.local===invalid));
   const issues=h.engine.quarantine.list();assert.ok(issues.some(i=>i.code==='shape.invalid' && i.channel.startsWith('legacy:')));assert.ok(!JSON.stringify(issues).includes('PRIVATE_NATIVE_SENTINEL'));
   assert.equal(bad.ingestCanonical('agents',[{...baseline,id:'recovered-agent'}]).ok,true);assert.ok(h.engine.agents().some(a=>a.id===scopedId('legacy','agent','recovered-agent')));
  }
 }
 // A UTF-8 byte boundary is legal without truncation; one extra code point is not.
 assert.equal(validNativeId('é'.repeat(2048)),true);assert.equal(validNativeId('é'.repeat(2049)),false);
 bad.ingestCanonical('agents',[{...team.agents()[0],id:'é'.repeat(2048)}]);assert.ok(h.engine.agents().some(a=>a.id===scopedId('legacy','agent','é'.repeat(2048))));
});
test('S35-02 relationship and composed tuple identities are validated before publication; raw rejected snapshots cannot delete last good sessions',t=>{
 const bad=createEngine({adapter:definition,runtimeId:'bad'}),good=createEngine({adapter:definition,runtimeId:'good'}),team=createDemoTeam();
 const engine=createMultiEngine({instances:[{id:'bad',adapter:'demo',enabled:true,engine:bad},{id:'good',adapter:'demo',enabled:true,engine:good}]});t.after(()=>{engine.close();bad.close();good.close();});
 bad.ingestCanonical('agents',team.agents());good.ingestCanonical('agents',team.agents());bad.ingestCanonical('sessions.snapshot',team.sessionList());
 const initial=bad.sessions()[0],count=bad.sessions().length;
 for(const changes of [{class:{...initial.class,agentId:'broken\nagent'}},{childKeys:['x'.repeat(4097)]},{run:{...initial.run,lastRunId:'bad\u0000run'}}]) {
  assert.equal(bad.ingestCanonical('sessions.snapshot',[{...initial,...changes}]).ok,false);assert.equal(bad.sessions().length,count);assert.doesNotThrow(()=>engine.sessions());
 }
 assert.equal(bad.ingestCanonical('agents',[{...team.agents()[0],mainSessionKey:'bad\nrelationship'}]).ok,false);
 const key='k'.repeat(4090),event={id:'ev:0:0',kind:'tool',at:Date.now(),callId:'c'.repeat(4090),name:'Read',toolKind:'other',input:'{}',output:'',isError:false,durationMs:null,truncated:false};
 const trace={sessionKey:key,fetchedAt:Date.now(),messageCount:1,window:{from:0,to:1},events:[event]};
 assert.equal(bad.ingestCanonical('transcript',trace,{key}).ok,false,'individually valid IDs can exceed the composed namespace budget');assert.equal(bad.transcript(key),null);
 assert.equal(bad.ingestCanonical('transcript',{...trace,sessionKey:initial.key},{key:initial.key}).ok,false,'tool-call tuples have their own composed bound');
 assert.equal(bad.ingestCanonical('flows',[{...team.flows()[0],agentId:'invalid\nowner'}]).ok,false);
 assert.equal(bad.ingestCanonical('skills',[{...team.skills()[0],name:'invalid\nskill'}]).ok,false);
 assert.equal(bad.ingestCanonical('flowRuns',[],{key:'invalid\ncontext'}).ok,false);
 const normal={...trace,sessionKey:initial.key,events:[{...event,callId:'ok'}]};assert.equal(bad.ingestCanonical('transcript',normal,{key:initial.key}).ok,true);
 assert.equal(bad.ingestCanonical('transcript',{...normal,participants:[{kind:'agent',id:'agent:bad\nparticipant',name:null,runtime:'demo',channel:null,avatarHint:null}]},{key:initial.key}).ok,false);
 assert.ok(engine.transcript(scopedId('bad','session',initial.key)));
 const raw=createEngine({adapter:require('../../src/adapters/openclaw').definition,runtimeId:'raw'});t.after(()=>raw.close());raw.ingestCanonical('sessions.snapshot',team.sessionList());
 const before=raw.sessions().map(s=>s.key),result=raw.ingest({source:'gateway',channel:'gw.rpc.sessions.list',body:{kind:'json',value:{sessions:[{key:'PRIVATE_BAD\nSESSION',updatedAt:Date.now()}],hasMore:false,totalCount:1}}});
 assert.equal(result.ok,true);assert.ok(result.issues.some(i=>i.code==='shape.invalid' && i.path.startsWith('$.canonical.session')));
 assert.deepEqual(raw.sessions().map(s=>s.key),before);
});
test('S35-02 shared projection contains an unexpected pre-admitted malformed row without hiding a healthy partition',t=>{
 const team=createDemoTeam(),bad=createEngine({adapter:definition}),good=createEngine({adapter:definition});
 bad.ingestCanonical('agents',[{...team.agents()[0],id:'PRIVATE_PRE_ADMITTED\nID'}]);good.ingestCanonical('agents',team.agents());
 const engine=createMultiEngine({instances:[{id:'bad',adapter:'demo',enabled:true,engine:bad},{id:'good',adapter:'demo',enabled:true,engine:good}]});t.after(()=>{engine.close();bad.close();good.close();});
 assert.doesNotThrow(()=>engine.agents());assert.equal(engine.agents().length,team.agents().length);assert.ok(engine.primaryAgent().id.startsWith('rt:good:'));
 assert.ok(!JSON.stringify(engine.quarantine.list()).includes('PRIVATE_PRE_ADMITTED'));
 const {agentRows}=require('../../src/settings/runtime-rows');const rows=agentRows({config:{runtimes:[{id:'bad',adapter:'demo'},{id:'good',adapter:'demo'}],agents:{}},cfg:{},engine,detections:[{runtime:'demo',agents:[{id:'PRIVATE_DETECTOR\nID'}]}]});assert.equal(rows.length,team.agents().length);
});
test('S35-01 a failed policy write refuses aliases, survives facade replacement and persists overflow when storage recovers',t=>{
 const dir=temp(t),store=openStore({dir,instance:'test',ownerName:'Synthetic',log:()=>{}});t.after(()=>store.close());
 const repo=store.runtimeAliases,remember=repo.remember;repo.remember=()=>{throw Error('PRIVATE_STORAGE_FAILURE');};
 const controller=createMultiRuntimeController({cfg:config(),store,resolveAdapter:()=>syntheticAdapter([])});t.after(()=>controller.close());
 const alias=aliasRows(controller.engine.instances.find(i=>i.id==='legacy').engine,'other').flow.id;
 assert.throws(()=>resolveWireId(controller.engine,alias,'flow',2),{code:'conflict'});
 const next=config('removed');controller.apply(next,controller.prepare(next));
 repo.remember=remember;
 assert.throws(()=>resolveWireId(controller.engine,scopedId('other','flow','unseen'),'flow',2),{code:'conflict'});
 assert.equal(repo.load().overflow,true);assert.ok(repo.load().seen.size>=3);
 assert.ok(!JSON.stringify(controller.engine.quarantine.list()).includes('PRIVATE_STORAGE_FAILURE'));
});
test('S35-02 malformed command reply identities stay categorical and cannot throw through the facade',t=>{
 const dir=temp(t),store=openStore({dir,instance:'test',ownerName:'Synthetic',log:()=>{}});t.after(()=>store.close());
 const A=syntheticAdapter([]),factory=A.createRuntime;
 A.createRuntime=function(cfg){const runtime=factory.call(this,cfg);runtime.commands.flowRun=async()=>({ok:true,jobId:'PRIVATE_REPLY\nID'});return runtime;};
 const controller=createMultiRuntimeController({cfg:config('removed'),store,resolveAdapter:()=>A});t.after(()=>controller.close());
 return controller.runtime.commands.flowRun(scopedId('other','flow','daily')).then(result=>{
  assert.deepEqual(result,{ok:false,failed:'unavailable',category:'invalid-identity'});
  assert.ok(!JSON.stringify(controller.engine.quarantine.list()).includes('PRIVATE_REPLY'));
 });
});
