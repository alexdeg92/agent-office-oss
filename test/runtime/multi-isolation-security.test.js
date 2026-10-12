'use strict';
// S34 regressions: no real CLI/service manager, runtime home or external network.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {bind}=require('../../src/adapters/openclaw/commands');
const {createEngine}=require('../../src/engine'),{createMultiEngine}=require('../../src/engine/multi');
const {definition,createDemoTeam}=require('../../src/adapters/demo'),{scopedId}=require('../../src/runtime-ids');
const {mountV2}=require('../../src/api/v2/routes'),{createApp}=require('../../src/api/http');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('S34-01 scoped local restarts are RPC-only; remote and read-only restarts invoke neither RPC nor host fallback',async()=>{
 const calls=[],cli={run:()=>{throw Error('CLI forbidden');}};
 for(const runtimeId of ['legacy','other',null]) {
  const cmd=bind(cli,{runtimeId,gatewayUrl:'ws://127.0.0.1:18793',gw:{call:async()=>{calls.push('rpc:'+runtimeId);throw Error('synthetic refusal');}},restartService:async()=>{calls.push('HOST DEFAULT');return{ok:true};}});
  assert.equal((await cmd.restartGateway()).failed,'unavailable');
 }
 assert.deepEqual(calls,['rpc:legacy','rpc:other','rpc:null']);
 const refused=bind(cli,{gatewayUrl:'ws://127.0.0.1:18793',gw:{call:async()=>({ok:false})},restartService:async()=>{calls.push('HOST DEFAULT');return{ok:true};}});
 assert.equal((await refused.restartGateway()).failed,'unavailable');
 for(const options of [{gatewayUrl:'wss://remote.example.test',runtimeId:'other'},{gatewayUrl:'ws://127.0.0.1:18793',runtimeId:'other',readonly:true}]) {
  const before=calls.length,cmd=bind(cli,{...options,gw:{call:async()=>calls.push('forbidden RPC')},restartService:async()=>{calls.push('HOST DEFAULT');return{ok:true};}});
  assert.ok((await cmd.restartGateway()).failed);assert.equal(calls.length,before);
 }
 const local=bind(cli,{runtimeId:'other',gatewayUrl:'ws://127.0.0.1:18793',gw:{call:async(method)=>calls.push(method+':other')},restartService:async()=>{calls.push('HOST DEFAULT');return{ok:true};}});
 assert.deepEqual(await local.restartGateway(),{ok:true,via:'rpc'});assert.equal(calls.at(-1),'gateway.restart.request:other');
});

test('S34-01 deferred restart refusal after outer timeout or source disable never triggers a host fallback',async t=>{
 const calls=[],deferred=[];
 const A={definition:{...definition,capabilities:()=>({...definition.capabilities(),restart:true})},createRuntime(cfg){
  const engineCmd=bind({},{runtimeId:cfg.runtimeId,gatewayUrl:'ws://127.0.0.1:18793',gw:{call:()=>new Promise((resolve,reject)=>deferred.push(reject))},restartService:async()=>{calls.push('HOST DEFAULT');return{ok:true};}});
  return{definition:this.definition,attach(){},start(){},close(){},commands:engineCmd};
 }};
 const specs=enabled=>({runtimeInstances:[{id:'other',adapter:'demo',enabled,config:{adapter:'demo'},cfg:{runtimeId:'other'}}],primaryAgent:null});
 const controller=require('../../src/multi-runtime-controller').createMultiRuntimeController({cfg:specs(true),store:{flushQuarantine(){},owner:{},persons:{senderPeople:()=>[]},quarantine:{loadAll:()=>[]}},resolveAdapter:()=>A,timeoutMs:10});t.after(()=>controller.close());
 const result=await controller.runtime.commands.restartGateway({runtimeId:'other'});assert.equal(result.category,'timeout');
 deferred.shift()(Error('late synthetic refusal'));await sleep(5);assert.deepEqual(calls,[]);
 const replacement=specs(true);controller.apply(replacement,controller.prepare(replacement));
 const retry=controller.runtime.commands.restartGateway({runtimeId:'other'});await sleep(1);
 const next=specs(false),prepared=controller.prepare(next);controller.apply(next,prepared);
 deferred.shift()(Error('disabled synthetic refusal'));await retry;await sleep(5);assert.deepEqual(calls,[]);
});

async function isolationFixture(t) {
 const calls=[],now=Date.now(),caps=()=>({...definition.capabilities(),flows:{read:true,write:true,schedules:['cron'],multiAgent:true},skills:{read:true,detail:true,toggle:true}});
 const make=id=>{const team=createDemoTeam({now:()=>now}),engine=createEngine({adapter:{...definition,capabilities:caps},now:()=>now});engine.ingestCanonical('agents',team.agents());engine.ingestCanonical('sessions.snapshot',team.sessionList());engine.ingestCanonical('flows',team.flows());engine.ingestCanonical('skills',team.skills());engine.setGatewayConnected(true);return{id,adapter:'demo',enabled:id==='legacy',engine,team};};
 const legacy=make('legacy'),other=make('other'),engine=createMultiEngine({instances:[legacy,other],primary:scopedId('legacy','agent','sage')});
 const commands={};for(const method of ['flowRun','flowSetEnabled','flowDelete','flowEdit','skillSetEnabled']) commands[method]=async(key)=>{const owned=engine.owner(key,method==='skillSetEnabled'?'skill':'flow');calls.push([method,owned.instance?.id,owned.local]);return{ok:true};};
 for(const i of [legacy,other])i.engine.setReads({flowRuns:async key=>{calls.push(['read-flow',i.id,key]);i.engine.ingestCanonical('flowRuns',[],{key});return{ok:true};},transcript:async key=>{calls.push(['read-session',i.id,key]);return{ok:true};},skillInfo:async()=>({ok:false,category:'capability-unavailable'})});
 let api;const app=createApp({apiOnly:true,mountRoutes:app=>{api=mountV2(app,{engine,runtime:{commands,refreshFlows:async()=>{},refreshSkills:async()=>{}},auth:{onRevoke(){},sessionOf:()=>({sid:'synthetic-owner',email:'owner@example.test'})},cfg:{instance:'test',capture:false,readonly:false,readonlyStore:false,agentNames:{}}});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{api.close();server.closeAllConnections();await new Promise(r=>server.close(r));engine.close();});
 const request=async(method,url,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 return{legacy,other,engine,calls,request,topics:api.topics};
}

test('S34-02 old v2 aliases never dispatch a colliding flow, session or skill to another instance; v3 remains scoped',async t=>{
 const h=await isolationFixture(t),flowAlias=scopedId('other','flow','daily'),sessionAlias=scopedId('other','session','shared-session'),skillAlias=scopedId('other','skill','shared-skill');
 const flow={...h.legacy.team.flows()[0],id:flowAlias},normal={...flow,id:'safe-flow'};
 h.legacy.engine.ingestCanonical('flows',[flow,normal]);
 // This is the alias issued by the old release before the second source existed.
 const oldAlias=flowAlias;assert.equal(h.other.enabled,false);
 const {legacyId}=require('../../src/api/v2/runtime-projection');
 h.other.engine.ingestCanonical('flows',[{...flow,id:'daily'}]);
 const session=h.legacy.engine.sessions()[0];h.legacy.engine.ingestCanonical('sessions.snapshot',[{...session,key:sessionAlias}]);h.other.engine.ingestCanonical('sessions.snapshot',[{...session,key:'shared-session'}]);
 const skill=h.legacy.team.skills()[0];h.legacy.engine.ingestCanonical('skills',[{...skill,name:skillAlias}]);h.other.engine.ingestCanonical('skills',[{...skill,name:'shared-skill'}]);h.other.enabled=true;
 for(const [method,url,body] of [['GET','/views/flows/'+encodeURIComponent(oldAlias)],['POST','/flows/'+encodeURIComponent(oldAlias)+'/runs',{}],['PUT','/flows/'+encodeURIComponent(oldAlias)+'/enabled',{enabled:false}],['DELETE','/flows/'+encodeURIComponent(oldAlias),{}],['PATCH','/flows/'+encodeURIComponent(oldAlias),{name:'Synthetic renamed'}],['GET','/views/sessions/'+encodeURIComponent(sessionAlias)],['GET','/views/skills/'+encodeURIComponent(skillAlias)],['PUT','/skills/'+encodeURIComponent(skillAlias)+'/enabled',{enabled:false}]]) {
  const r=await h.request(method,'/api/v2'+url,body);assert.equal(r.status,409,JSON.stringify({method,url,response:r}));assert.ok(r.body.error.details.some(d=>d.issue==='ambiguous-runtime-id'));
 }
 assert.deepEqual(h.calls,[],'ambiguity is refused before any adapter read/write');
 assert.equal(legacyId(scopedId('legacy','flow',oldAlias)),scopedId('legacy','flow',oldAlias),'new references preserve the unambiguous legacy namespace');
 for(const [kind,wire] of [['flow',oldAlias],['session',sessionAlias],['skill',skillAlias]])assert.throws(()=>h.topics.current(kind+':'+encodeURIComponent(wire),2),{code:'conflict'},'SSE detail builders enforce the same version-aware boundary');
 const list=await h.request('GET','/api/v2/views/flows');assert.equal(list.status,200);
 const vmSchema=require('../../src/api/v2/vm/schemas').VM_SCHEMAS.flows,schema=require('../../src/schema');
 const duplicate={...list.body.data,flows:[list.body.data.flows[0],list.body.data.flows[0]]};assert.equal(schema.validate(vmSchema,duplicate).ok,false,'duplicate collections still fail validation');
 const ids=list.body.data.flows.map(i=>i.id);assert.equal(new Set(ids).size,ids.length,'fresh projection does not issue a colliding alias');
 assert.ok(ids.includes(scopedId('legacy','flow',flowAlias)));assert.ok(ids.includes(flowAlias));
 assert.equal((await h.request('POST','/api/v2/flows/safe-flow/runs',{})).status,200);
 assert.deepEqual(h.calls[0],['flowRun','legacy','safe-flow']);h.calls.length=0;
 assert.equal((await h.request('POST','/api/v3/flows/'+encodeURIComponent(flowAlias)+'/runs',{})).status,200);
 assert.deepEqual(h.calls[0],['flowRun','other','daily']);h.calls.length=0;
 assert.equal((await h.request('POST','/api/v2/flows/'+encodeURIComponent(scopedId('legacy','flow',oldAlias))+'/runs',{})).status,200);
 assert.deepEqual(h.calls[0],['flowRun','legacy',oldAlias]);h.calls.length=0;
 // A retained old alias stays refused even after its legacy row is removed.
 h.legacy.engine.ingestCanonical('flows',[]);
 assert.equal((await h.request('POST','/api/v2/flows/'+encodeURIComponent(oldAlias)+'/runs',{})).status,409);assert.deepEqual(h.calls,[]);
 h.legacy.enabled=false;
 assert.equal((await h.request('GET','/api/v2/views/sessions/'+encodeURIComponent(sessionAlias))).status,409);assert.deepEqual(h.calls,[]);
 const shared={rows:[],sequence:0};
 const first=createMultiEngine({instances:[h.legacy,h.other],liveState:shared});first.legacyAliasConflict('session',sessionAlias);first.close();
 const replacement=createMultiEngine({instances:[h.other],liveState:shared});t.after(()=>replacement.close());
 const {resolveWireId}=require('../../src/api/v2/runtime-projection');
 assert.throws(()=>resolveWireId(replacement,sessionAlias,'session',2),{code:'conflict'},'removing legacy and replacing the live facade cannot reinterpret a retained alias');
 assert.equal(resolveWireId(replacement,oldAlias,'flow',3),oldAlias);
});

test('S34-01 real runtime binding advertises local RPC restart and refuses a remote endpoint',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),A=require('../../src/adapters/openclaw');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'restart-source-synthetic-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 for(const [url,allowed] of [['wss://remote.example.test',false],['ws://127.0.0.1:18793',true]]) {
  const runtime=A.createRuntime({runtimeId:'other',gatewayUrl:url,gatewayToken:'synthetic',identityPath:path.join(home,'missing-identity.json'),stateDbPath:path.join(home,'missing.sqlite'),openclawHome:home,openclawConfigPath:path.join(home,'config.json'),openclawBin:path.join(home,'nonexistent-cli')},{cliEnv:{HOME:home,PATH:home}});
  t.after(()=>runtime.close());assert.equal(runtime.definition.capabilities().restart,allowed);
  const calls=[];runtime.gw.call=async(method)=>{calls.push(method);return{ok:true};};
  const result=await runtime.commands.restartGateway();
  assert.deepEqual(calls,allowed?['gateway.restart.request']:[]);
  assert.deepEqual(result,allowed?{ok:true,via:'rpc'}:{failed:'unavailable'});
 }
});
