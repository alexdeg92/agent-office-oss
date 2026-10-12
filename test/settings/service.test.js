const { scopedId, parseId } = require('../../src/runtime-ids');
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {settingsFixture}=require('../helpers/settings-fixture');
const {SettingsVM}=require('../../src/api/v2/vm/schemas'),s=require('../../src/schema');
const {sourceBrand}=require('../../src/adapters');
const BASE='/api/v3/settings';
async function fixture(t,options){const h=await settingsFixture(options);t.after(()=>h.close());return h;}
test('owner SettingsVM is strict, no secret, adapter-owned fields; GET never runs detector',async t=>{
 const h=await fixture(t);const r=await h.get(BASE);assert.equal(r.status,200,r.text);assert.equal(s.validate(SettingsVM,r.json.data).ok,true);assert.equal(h.detectCalls,0);
 assert.equal(r.json.data.runtimes[0].values.token.value,null);assert.equal(r.json.data.runtimes[0].values.token.tokenSet,true);assert.ok(!r.text.includes(h.fake.token));
 const unauth=h.cookie;h.cookie='';assert.equal((await h.get(BASE)).status,401);h.cookie=unauth;
 assert.equal((await h.get('/api/v2/settings')).status,404);
 const detect=await h.post(BASE+'/detect');assert.equal(detect.status,200,detect.text);assert.equal(h.detectCalls,1);assert.ok(detect.json.data.vm.runtimes.some(r=>r.id==='codex'&&r.supported));assert.ok(!detect.text.includes(h.fake.token));
});
test('Herdr Settings card reads discovery and test status from the configured source adapter',async t=>{
 let result={status:'not-checked',checkedAt:null};
 const source={detected:true,hasHerdr:false,get herdrCheck(){return result},async checkHerdr(){result={status:'available',checkedAt:1234};return {found:true,status:'available',agentCount:2}}};
 const h=await fixture(t,{orchestratorTeams:()=>source});
 let vm=(await h.get(BASE)).json.data;assert.deepEqual(vm.herdr,{found:true,enabled:false,active:false,status:'not-checked',checkedAt:null,brand:sourceBrand('herdr')});assert.equal(h.detectCalls,0);
 const checked=await h.post(BASE+'/herdr/check');assert.equal(checked.status,200,checked.text);assert.deepEqual(checked.json.data.result,{found:true,status:'available',agentCount:2});
 vm=(await h.get(BASE)).json.data;assert.deepEqual(vm.herdr,{found:true,enabled:false,active:false,status:'available',checkedAt:1234,brand:sourceBrand('herdr')});
});
test('auto-add is a revisioned runtime policy and detected Codex is an enabled-default candidate',async t=>{
 const h=await fixture(t),initial=await h.get(BASE);assert.equal(initial.status,200,initial.text);
 let codex=initial.json.data.runtimes.find(r=>r.id==='codex');
 if(!codex){const detected=await h.post(BASE+'/detect');assert.equal(detected.status,200,detected.text);codex=detected.json.data.vm.runtimes.find(r=>r.id==='codex');}
 assert.ok(codex,'detected optional connector is visible before selection');assert.deepEqual(codex.autoAdd,{enabled:true,defaultEnabled:true,managed:false});
 const saved=await h.put(BASE+'/auto-add',{expectedRevision:1,runtime:'legacy',enabled:true});assert.equal(saved.status,200,saved.text);assert.deepEqual(saved.json.data.result,{runtime:'legacy',enabled:true});assert.equal(saved.json.data.revision,2);
 assert.equal(h.store.runtimeAutoAdd.get('legacy').enabled,true);
 assert.equal((await h.put(BASE+'/auto-add',{expectedRevision:1,runtime:'legacy',enabled:false})).status,409);
});
test('manual roster additions and restores record a first-added time while excludes persist',async t=>{
 const h=await fixture(t),r=h.store.runtimeAutoAdd;r.setEnabled('legacy',true);
 let response=await h.put(BASE+'/agents',{expectedRevision:1,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Atlas',hidden:false},{id:'scribe',name:'Scribe',hidden:false}]});
 assert.equal(response.status,200,response.text);let first=r.get('legacy').added.find(row=>row.id==='scribe');assert.ok(Number.isSafeInteger(first?.at));assert.equal(response.json.data.vm.agents.find(row=>row.agentId==='scribe').autoAddedAt,first.at);
 response=await h.put(BASE+'/agents',{expectedRevision:2,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Atlas',hidden:false}]});
 assert.equal(response.status,200,response.text);assert.ok(r.get('legacy').excluded.includes('scribe'));
 assert.equal(r.autoAdd('legacy','scribe').status,'excluded');
 response=await h.put(BASE+'/agents',{expectedRevision:3,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Atlas',hidden:false},{id:'scribe',name:'Scribe',hidden:false}]});
 assert.equal(response.status,200,response.text);const restored=r.get('legacy').added.find(row=>row.id==='scribe');assert.ok(Number.isSafeInteger(restored?.at));assert.equal(response.json.data.vm.agents.find(row=>row.agentId==='scribe').autoAddedAt,restored.at);assert.ok(!r.get('legacy').excluded.includes('scribe'));
});
test('removing a discovered auto-added agent writes a durable exclusion',async t=>{
 const h=await fixture(t,{effectiveV3:true}),policy=h.store.runtimeAutoAdd;policy.setEnabled('legacy',true);h.controller.refreshAutoAdd('legacy');
 assert.equal(policy.autoAdd('legacy','scribe').status,'added');h.controller.refreshAutoAdd('legacy');
 assert.ok(h.engine.agents().some(a=>a.id===scopedId('legacy','agent','scribe')),'the discovered auto-added agent is visible before removal');
 const response=await h.put(BASE+'/agents',{expectedRevision:1,runtime:'legacy',primary:'atlas',agents:[{id:'atlas',name:'Atlas',hidden:false}]});
 assert.equal(response.status,200,response.text);assert.deepEqual(policy.get('legacy').added,[]);assert.ok(policy.get('legacy').excluded.includes('scribe'));
 h.controller.refreshAutoAdd('legacy');assert.ok(!h.engine.agents().some(a=>a.id===scopedId('legacy','agent','scribe')),'refresh keeps the removed agent out of Office');
 assert.equal(policy.autoAdd('legacy','scribe').status,'excluded','later discovery cannot auto-add it again');
});
test('auto-add enabled discovery is already configured and not diagnosed as a fix',async t=>{
 const h=await fixture(t,{effectiveV3:true}),policy=h.store.runtimeAutoAdd;
 policy.setEnabled('legacy',true);h.controller.refreshAutoAdd('legacy');
 const response=await h.get(BASE);assert.equal(response.status,200,response.text);
 const discovered=response.json.data.agents.find(row=>row.agentId==='scribe'&&row.runtime==='legacy');
 assert.ok(discovered,'the detector supplies the synthetic agent');assert.equal(discovered.configured,true);
 const item=response.json.data.diagnostics.find(row=>row.id.includes('scribe'));
 assert.ok(!item || !['warning','error'].includes(item.level),'auto-added discovery is not a problem row');
 assert.ok(!item?.fix,'auto-added discovery has no corrective action');
 assert.equal(response.json.data.diagnostics.some(row=>row.id==='detected-agents:openclaw'),false);
});
test('instance and agents apply live, revisions persist, fields-only audit; hidden agents restore',async t=>{
 const h=await fixture(t);let r=await h.put(BASE+'/instance',{expectedRevision:1,name:'Nouveau',locale:'en',timeZone:'UTC'});assert.equal(r.status,200,r.text);assert.equal((await h.get('/api/v3/meta')).json.data.instance.name,'Nouveau');
 assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'stale'})).status,409);
 r=await h.put(BASE+'/agents',{expectedRevision:2,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Orion',hidden:false},{id:'scribe',name:'Scribe',hidden:true}]});assert.equal(r.status,200,r.text);assert.equal(h.engine.primaryAgent().name,'Orion');assert.ok(!h.engine.agents().some(a=>a.id===scopedId('legacy','agent','scribe')));
 r=await h.put(BASE+'/agents',{expectedRevision:3,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Orion',hidden:false},{id:'scribe',name:'Lyra',hidden:false}]});assert.equal(r.status,200,r.text);assert.equal(h.engine.agents().find(a=>a.id===scopedId('legacy','agent','scribe')).name,'Lyra');
 const log=JSON.stringify(h.store.audit.recent());assert.ok(log.includes('instance.name'));assert.ok(!log.includes('Nouveau'));assert.ok(!log.includes(h.fake.token));assert.equal(JSON.parse(fs.readFileSync(h.paths.file)).agents.names.legacy.scribe,'Lyra');
});
test('cleared chosen names persist as null while detected names survive save and GET',async t=>{
 const h=await fixture(t);
 const row=vm=>vm.agents.find(a=>a.agentId==='atlas'&&['openclaw','legacy'].includes(a.runtime));
 const original=row((await h.get(BASE)).json.data);assert.equal(original.detectedName,'Atlas');
 let r=await h.put(BASE+'/agents',{expectedRevision:1,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Orion',hidden:false}]});assert.equal(r.status,200,r.text);assert.equal(row(r.json.data.vm).name,'Orion');
 r=await h.put(BASE+'/agents',{expectedRevision:2,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:null,hidden:false}]});assert.equal(r.status,200,r.text);
 assert.equal(row(r.json.data.vm).name,null);assert.equal(row(r.json.data.vm).detectedName,original.detectedName);
 const saved=JSON.parse(fs.readFileSync(h.paths.file));assert.equal(saved.agents.names.legacy.atlas,null);
 const IC=require('../../src/instance-config');assert.equal(IC.readInstanceConfig(h.env).config.agents.names.legacy.atlas,null);
 r=await h.get(BASE);assert.equal(r.status,200,r.text);assert.equal(row(r.json.data).name,null);assert.equal(row(r.json.data).detectedName,original.detectedName);
 assert.equal(h.engine.primaryAgent().name,original.detectedName);
});
test('sensitive changes require a recent per-session confirmation; network stays pending restart',async t=>{
 const h=await fixture(t);const network={expectedRevision:1,mode:'tailnet',port:18800,publicUrl:'https://office.example.test'};
 assert.equal((await h.put(BASE+'/network',network)).status,403);assert.equal((await h.post(BASE+'/reauth',{password:'wrong'})).json.error.details[0].issue,'current-password');assert.equal((await h.get(BASE)).status,200);
 assert.equal((await h.reauth()).status,200);const old=h.cookie;await h.login();assert.equal((await h.put(BASE+'/network',network)).status,403);h.cookie=old;
 const r=await h.put(BASE+'/network',network);assert.equal(r.status,200,r.text);assert.equal(r.json.data.vm.network.restartRequired,true);assert.equal(r.json.data.vm.network.active.port,18789);assert.equal(r.json.data.vm.network.port.value,18800);
 h.clock.elapsed+=300000;assert.equal((await h.put(BASE+'/network',{...network,expectedRevision:2})).status,403);
});
test('shared login throttle counts bad reauth; correct confirmation cannot bypass it',async t=>{
 const h=await fixture(t);for(let n=0;n<6;n++)assert.equal((await h.post(BASE+'/reauth',{password:'wrong'})).status,401);
 assert.equal((await h.reauth()).status,429);assert.equal((await h.login()).status,429);
});
test('runtime checks do not relay the saved token to an edited URL, safe live adapter replacement',async t=>{
 const h=await fixture(t);const old=h.runtime.gw;
 assert.equal((await h.post(BASE+'/check',{runtime:{adapter:'openclaw',gatewayUrl:'wss://remote.example.test'}})).status,400);
 assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:[{id:'demo',adapter:'demo',enabled:true}]})).status,403);
 await h.reauth();const r=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:[{id:'demo',adapter:'demo',enabled:true}]});assert.equal(r.status,200,r.text);assert.equal(h.engine.runtime().adapterId,'demo');assert.equal(old.retry,false);assert.equal(old.connected,false);
 assert.equal((await h.get('/api/v3/meta')).json.data.runtime.id,'demo');
});
test('owner edits consistent with DB and Person; password rotation invalidates other cookies, persists generation',async t=>{
 const h=await fixture(t);const original=h.cookie;await h.reauth();let r=await h.put(BASE+'/owner',{expectedRevision:1,displayName:'Robin',email:'robin@example.test'});assert.equal(r.status,200,r.text);assert.equal(h.store.owner.name,'Robin');assert.equal(h.store.users.owner().email,'robin@example.test');
 const generation=h.store.users.authGeneration();r=await h.post(BASE+'/password',{password:'replacement-fixture-password'});assert.equal(r.status,200,r.text);assert.ok(h.store.users.authGeneration()>generation);assert.equal((await h.get(BASE)).status,200);
 const current=h.cookie;h.cookie=original;assert.equal((await h.get(BASE)).status,401);h.cookie=current;assert.equal((await h.post(BASE+'/password',{password:'another-fixture-password'})).status,403);
 assert.equal((await h.login('replacement-fixture-password','robin@example.test')).status,200);
});
test('env imposed fields cannot be silently overwritten; readonly disables everything',async t=>{
 const h=await fixture(t,{env:{AO_INSTANCE_NAME:'Env name',AO_PRIMARY_AGENT:'atlas'}});assert.equal((await h.get(BASE)).json.data.instance.name.source,'env');
 const r=await h.put(BASE+'/instance',{expectedRevision:1,name:'ignored'});assert.equal(r.status,403,r.text);assert.equal(r.json.error.details[0].issue,'env-override');
 const read=await fixture(t,{env:{PORTAL_READONLY:'1'}});const vm=(await read.get(BASE)).json.data;assert.equal(vm.readonly,true);assert.equal(vm.instance.name.editable,false);assert.equal((await read.reauth()).status,403);
});
test('integration plan/apply use adapter-owned temp targets and require reauth + confirmed plan',async t=>{
 const h=await fixture(t);await h.post(BASE+'/detect');const plan=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});assert.equal(plan.status,200,plan.text);
 const b={planId:plan.json.data.result.planId,agentIds:['atlas','scribe'],confirmed:true,action:'install'};
 assert.equal((await h.post(BASE+'/integrations/apply',b)).status,403);await h.reauth();const r=await h.post(BASE+'/integrations/apply',b);assert.equal(r.status,200,r.text);assert.ok(r.json.data.result.agents.every(a=>a.status==='installed'));
});
