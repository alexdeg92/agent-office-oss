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
test('office presence timings validate, persist, stay live and are audited as fields only',async t=>{
 const h=await fixture(t);let r=await h.get(BASE);assert.equal(r.status,200,r.text);
 assert.deepEqual(Object.fromEntries(Object.entries(r.json.data.office).filter(([key])=>key!=='help').map(([key,value])=>[key,value.value])),
  {finishedSessionWindowMinutes:15,agentPresenceWindowMinutes:60,idleRelocationMinutes:15,idleTransitionDebounceMs:3000});
 for(const key of ['finishedSessionWindowMinutes','agentPresenceWindowMinutes','idleRelocationMinutes']) {
  assert.equal(r.json.data.office[key].minimum,1);assert.equal(r.json.data.office[key].maximum,1440);
 }
 assert.equal(r.json.data.office.idleTransitionDebounceMs.minimum,0);assert.equal(r.json.data.office.idleTransitionDebounceMs.maximum,15000);
 assert.equal(r.json.data.office.idleTransitionDebounceMs.minimum,0);assert.equal(r.json.data.office.idleTransitionDebounceMs.maximum,15000);
 for(const [key,value] of [['finishedSessionWindowMinutes',0],['agentPresenceWindowMinutes',1441],['idleRelocationMinutes',0],['idleTransitionDebounceMs',-1],['idleTransitionDebounceMs',15001]]) {
  const invalid=await h.put(BASE+'/instance',{expectedRevision:1,office:{[key]:value}});assert.equal(invalid.status,400,invalid.text);assert.equal(invalid.json.error.details[0].field,'office.'+key);
 }
 const saved=await h.put(BASE+'/instance',{expectedRevision:1,office:{finishedSessionWindowMinutes:1,agentPresenceWindowMinutes:1440,idleRelocationMinutes:45,idleTransitionDebounceMs:15000}});
 assert.equal(saved.status,200,saved.text);assert.equal(saved.json.data.result.restartRequired,false);
 assert.deepEqual(Object.fromEntries(Object.entries(saved.json.data.vm.office).filter(([key])=>key!=='help').map(([key,value])=>[key,value.value])),
  {finishedSessionWindowMinutes:1,agentPresenceWindowMinutes:1440,idleRelocationMinutes:45,idleTransitionDebounceMs:15000});
 assert.deepEqual(h.settings.officeTimings(),{finishedSessionWindowMs:60000,agentPresenceWindowMs:1440*60000,idleRelocationMinutes:45,idleTransitionDebounceMs:15000});
 assert.deepEqual(JSON.parse(fs.readFileSync(h.paths.file)).office.presence,{finishedSessionWindowMinutes:1,agentPresenceWindowMinutes:1440,idleRelocationMinutes:45,idleTransitionDebounceMs:15000});
 assert.equal((await h.get(BASE)).json.data.office.finishedSessionWindowMinutes.value,1);
 const audit=h.store.audit.recent().find(row=>row.command==='settings.instance'&&row.outcome==='ok');
 assert.equal(audit.target,'office.finishedSessionWindowMinutes,office.agentPresenceWindowMinutes,office.idleRelocationMinutes,office.idleTransitionDebounceMs');
 assert.equal(audit.detail,null);assert.ok(!Object.hasOwn(audit,'value'));
});
test('office timing environment values are boot overrides and cannot be changed in Settings',async t=>{
 const h=await fixture(t,{env:{AGENT_OFFICE_SESSION_PRESENCE_WINDOW_MS:'1800000',AGENT_OFFICE_AGENT_PRESENCE_WINDOW_MS:'7200000',AGENT_OFFICE_IDLE_RELOCATION_MINUTES:'45',AGENT_OFFICE_IDLE_TRANSITION_DEBOUNCE_MS:'4500'}});
 const vm=(await h.get(BASE)).json.data;
 assert.deepEqual([vm.office.finishedSessionWindowMinutes.value,vm.office.agentPresenceWindowMinutes.value,vm.office.idleRelocationMinutes.value,vm.office.idleTransitionDebounceMs.value],[30,120,45,4500]);
 assert.ok([vm.office.finishedSessionWindowMinutes,vm.office.agentPresenceWindowMinutes,vm.office.idleRelocationMinutes,vm.office.idleTransitionDebounceMs].every(row=>row.source==='env'&&!row.editable&&row.reason.key==='settings.office.managed'&&!row.reason.params));
 const refused=await h.put(BASE+'/instance',{expectedRevision:1,office:{finishedSessionWindowMinutes:40}});assert.equal(refused.status,403);assert.equal(refused.json.error.details[0].issue,'env-override');
 const refusedDebounce=await h.put(BASE+'/instance',{expectedRevision:1,office:{idleTransitionDebounceMs:6000}});assert.equal(refusedDebounce.status,403);assert.equal(refusedDebounce.json.error.details[0].issue,'env-override');
});
test('empty timing environment values are ignored consistently for display and writes',async t=>{
 const h=await fixture(t,{env:{AGENT_OFFICE_IDLE_RELOCATION_MINUTES:''}}),vm=(await h.get(BASE)).json.data;
 assert.equal(vm.office.idleRelocationMinutes.value,15);assert.equal(vm.office.idleRelocationMinutes.source,'default');assert.equal(vm.office.idleRelocationMinutes.editable,true);
 const saved=await h.put(BASE+'/instance',{expectedRevision:1,office:{idleRelocationMinutes:45}});
 assert.equal(saved.status,200,saved.text);assert.equal(saved.json.data.vm.office.idleRelocationMinutes.value,45);
});
test('a pre-Settings layout delay is migrated once into instance configuration',async t=>{
 const h=await fixture(t,{legacyIdleRelocationMinutes:7}),response=await h.get(BASE);
 assert.equal(response.status,200,response.text);assert.equal(response.json.data.office.idleRelocationMinutes.value,7);
 assert.equal(response.json.data.office.idleRelocationMinutes.source,'file');
 const savedConfig=JSON.parse(fs.readFileSync(h.paths.file));assert.equal(savedConfig.office.presence.idleRelocationMinutes,7);
 const layout=(await h.get('/api/v3/office/layout')).json.data;assert.equal(layout.layout.data.idleRelocationMinutes,7);
 const updated=await h.put(BASE+'/instance',{expectedRevision:response.json.data.revision,office:{idleRelocationMinutes:23}});
 assert.equal(updated.status,200,updated.text);assert.equal(updated.json.data.vm.office.idleRelocationMinutes.value,23);
 assert.equal((await h.get('/api/v3/office/layout')).json.data.layout.data.idleRelocationMinutes,23);
});
test('Settings compatibility lookup does not seed a missing office layout',async t=>{
 const h=await fixture(t,{emptyOfficeLayout:true});
 assert.equal(h.officeLayoutAfterSettings,null,'Settings construction must leave layout initialization to the layout owner');
});
test('Settings is the only relocation-delay source for layout GET and live office timing',async t=>{
 const h=await fixture(t),layout=(await h.get('/api/v3/office/layout')).json.data;
 const savedLayout=await h.put('/api/v3/office/layout',{expectedRevision:layout.layout.revision,data:{...layout.layout.data,idleRelocationMinutes:7}});
 assert.equal(savedLayout.status,200,savedLayout.text);
 assert.equal(savedLayout.json.data.vm.layout.data.idleRelocationMinutes,15,'legacy layout write cannot override Settings');
 assert.equal(Object.hasOwn(h.store.office.active(()=>({})).data,'idleRelocationMinutes'),false,'layout writes do not create a second persisted setting');
 const settings=(await h.get(BASE)).json.data;
 assert.equal(settings.office.idleRelocationMinutes.value,15);assert.equal(settings.office.idleRelocationMinutes.source,'default');
 const saved=await h.put(BASE+'/instance',{expectedRevision:1,office:{idleRelocationMinutes:25}});assert.equal(saved.status,200,saved.text);
 assert.equal(h.settings.officeTimings().idleRelocationMinutes,25);
 const currentLayout=(await h.get('/api/v3/office/layout')).json.data;
 assert.equal(currentLayout.layout.data.idleRelocationMinutes,25,'layout projection follows Settings after save');
 const office=(await h.get('/api/v3/views/office')).json.data;
 assert.equal(h.settings.officeTimings().idleRelocationMinutes,currentLayout.layout.data.idleRelocationMinutes,'placement engine and layout projection share the same Settings value');
 assert.ok(office && Array.isArray(office.occupants),'the live OfficeVM remains available after a Settings change');
});
test('saving a longer finished-session window changes the next OfficeVM without restart',async t=>{
 const now=1791740000000,sessionFixture=JSON.parse(fs.readFileSync(require.resolve('../fixtures/gw/rpc/sessions.list/2026.9.8/foreign-instance.json'),'utf8')).body.value;
 const source=sessionFixture.sessions.find(row=>row.key==='agent:atlas:telegram:direct:foreign-user');
 const finished={...source,updatedAt:now-20*60000,status:'done',hasActiveRun:false};
 const h=await fixture(t,{now:()=>now,handlers:{'sessions.list':()=>({...sessionFixture,totalCount:1,count:1,sessions:[finished]})}});
 const key=finished.key;
 let office=await h.get('/api/v3/views/office');assert.equal(office.status,200,office.text);assert.equal(office.json.data.occupants.some(row=>row.role==='direct'),false);
 const saved=await h.put(BASE+'/instance',{expectedRevision:1,office:{finishedSessionWindowMinutes:30}});assert.equal(saved.status,200,saved.text);assert.equal(saved.json.data.result.restartRequired,false);
 office=await h.get('/api/v3/views/office');assert.equal(office.status,200,office.text);assert.equal(office.json.data.occupants.some(row=>row.role==='direct'),true);
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
