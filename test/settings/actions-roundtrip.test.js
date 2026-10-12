const { scopedId, parseId } = require('../../src/runtime-ids');
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {realisticSettings}=require('../helpers/settings-roundtrip-fixture');
const {PASSWORD,EMAIL}=require('../helpers/settings-fixture');
const {TOKEN}=require('../helpers/onboarding-fixture');
const {waitFor}=require('../helpers/harness');
const BASE='/api/v3/settings';
async function fixture(t){const h=await realisticSettings();t.after(()=>h.close());return h;}
async function get(h){const r=await h.get(BASE);assert.equal(r.status,200,r.text);return r.json.data;}
async function put(h,action,body){const r=await h.put(BASE+'/'+action,{expectedRevision:(await get(h)).revision,...body});assert.equal(r.status,200,r.text);return r.json.data.vm;}
const saved=h=>JSON.parse(fs.readFileSync(h.paths.file));
for(const [field,value] of [['name','Round trip'],['locale','en'],['timeZone','UTC']])test('real config '+field+' save, GET and reverse',async t=>{
 const h=await fixture(t),original=(await get(h)).instance[field].value;
 await put(h,'instance',{[field]:value});assert.equal((await get(h)).instance[field].value,value);assert.equal(saved(h).instance[field],value);assert.equal((await h.get('/api/v3/meta')).json.data.instance[field==='timeZone'?'timeZone':field],value);
 await put(h,'instance',{[field]:original});assert.equal((await get(h)).instance[field].value,original);assert.equal(saved(h).instance[field],original);
});
test('real detector reads scratch identity/config, reflects edits on repeated detect and restores',async t=>{
 const h=await fixture(t),configFile=h.env.OC_CONFIG,original=fs.readFileSync(configFile,'utf8'),config=JSON.parse(original);delete config.agents.list[0].name;fs.writeFileSync(configFile,JSON.stringify(config));
 const identity=path.join(h.tmp,'.openclaw/workspace/IDENTITY.md'),text=fs.readFileSync(identity,'utf8');
 const detect=async()=>{const r=await h.post(BASE+'/detect');assert.equal(r.status,200,r.text);return r.json.data.vm;};
 const row=vm=>vm.agents.find(a=>a.agentId==='atlas');let vm=await detect();assert.equal(row(vm).detectedName,'Atlas');assert.equal(row(vm).nameSource,'IDENTITY.md');
 fs.writeFileSync(identity,'- **Name:** Real scratch change\n');vm=await detect();assert.equal(row(vm).detectedName,'Real scratch change');assert.equal(row(await get(h)).detectedName,'Real scratch change');assert.equal(row(vm).name,'Atlas');
 const runtime=vm.runtimes.find(r=>r.id==='openclaw');assert.equal(runtime.found,true);assert.equal(runtime.values.token.tokenSet,true);
 fs.writeFileSync(identity,text);fs.writeFileSync(configFile,original);vm=await detect();assert.equal(row(vm).detectedName,'Atlas');assert.equal(row(await get(h)).detectedName,'Atlas');
});
const initial=[{id:'atlas',name:'Atlas',hidden:false},{id:'scribe',name:'Scribe',hidden:false}];
for(const [action,agents,primary,verify] of [
 ['rename',[{...initial[0],name:'Chosen'},initial[1]],'atlas',vm=>assert.equal(vm.agents.find(a=>a.agentId==='atlas').name,'Chosen')],
 ['clear name',[{...initial[0],name:null},initial[1]],'atlas',vm=>assert.equal(vm.agents.find(a=>a.agentId==='atlas').name,null)],
 ['change primary',initial,'scribe',vm=>assert.equal(vm.agents.find(a=>a.isPrimary).agentId,'scribe')],
 ['hide',[initial[0],{...initial[1],hidden:true}],'atlas',vm=>assert.equal(vm.agents.find(a=>a.agentId==='scribe').hidden,true)],
 ['remove from configuration',[initial[0]],'atlas',vm=>assert.equal(vm.agents.find(a=>a.agentId==='scribe').configured,false)],
])test('real agents '+action+', GET and reverse',async t=>{
 const h=await fixture(t);await h.post(BASE+'/detect');await put(h,'agents',{runtime:'openclaw',primary,agents});verify(await get(h));assert.deepEqual(saved(h).agents.configured.legacy,agents.map(a=>a.id));
 await put(h,'agents',{runtime:'openclaw',primary:'atlas',agents:initial});const vm=await get(h);for(const a of initial){const row=vm.agents.find(x=>x.agentId===a.id);assert.equal(row.configured,true);assert.equal(row.name,a.name);assert.equal(row.hidden,false);}assert.equal(vm.agents.find(a=>a.isPrimary).agentId,'atlas');
});
test('real network desired state save, GET and reverse preserves active listener until reboot',async t=>{
 const h=await fixture(t);await h.reauth();const old=(await get(h)).network;
 await put(h,'network',{mode:'tailnet',port:18801,publicUrl:'https://scratch.example.test'});let vm=await get(h);assert.equal(vm.network.mode.value,'tailnet');assert.equal(vm.network.port.value,18801);assert.equal(vm.network.restartRequired,true);assert.deepEqual(vm.network.active,old.active);assert.equal(saved(h).network.port,18801);
 await put(h,'network',{mode:old.mode.value,port:old.port.value,publicUrl:old.publicUrl.value});vm=await get(h);assert.equal(vm.network.restartRequired,false);assert.equal(saved(h).network.port,old.port.value);
});
for(const [field,value] of [['displayName','Scratch Owner'],['email','changed@example.test']])test('real owner '+field+' save, GET, DB and reverse',async t=>{
 const h=await fixture(t);await h.reauth();const original=(await get(h)).owner[field].value;
 await put(h,'owner',{[field]:value});assert.equal((await get(h)).owner[field].value,value);assert.equal(saved(h).owner[field],value);assert.equal(field==='email'?h.store.users.owner().email:h.store.owner.name,value);
 await put(h,'owner',{[field]:original});assert.equal((await get(h)).owner[field].value,original);assert.equal(saved(h).owner[field],original);if(field==='email')assert.equal((await h.login(PASSWORD,EMAIL)).status,200);
});
test('real password rotation, GET, new login, reverse and former password rejection',async t=>{
 const h=await fixture(t);await h.reauth();const oldHash=h.store.users.owner().password_hash,password='round-trip-replacement-password';let r=await h.post(BASE+'/password',{password});assert.equal(r.status,200,r.text);assert.notEqual(h.store.users.owner().password_hash,oldHash);await get(h);
 assert.equal((await h.login(PASSWORD)).status,401);assert.equal((await h.login(password)).status,200);assert.equal((await h.post(BASE+'/reauth',{password})).status,200);r=await h.post(BASE+'/password',{password:PASSWORD});assert.equal(r.status,200,r.text);await get(h);assert.equal((await h.login(password)).status,401);assert.equal((await h.login(PASSWORD)).status,200);
});
test('real gateway token check/replace, reconnect, GET and reverse',async t=>{
 const h=await fixture(t);await h.reauth();const token='scratch-replacement-token';h.fake.token=token;
 const runtime={adapter:'openclaw',gatewayUrl:h.gw.url,token};let r=await h.post(BASE+'/check',{runtime});assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.ok,true);assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimeToken,TOKEN);
 await put(h,'runtime',{runtime});await waitFor(()=>h.engine.gateway().connected);let vm=await get(h);assert.equal(vm.runtimes.find(r=>r.selected).connection.status,'connected');assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimes.legacy.runtimeToken,token);assert.ok(!JSON.stringify(vm).includes(token));
 h.fake.token=TOKEN;await put(h,'runtime',{runtime:{...runtime,token:TOKEN}});await waitFor(()=>h.engine.gateway().connected);vm=await get(h);assert.equal(vm.runtimes.find(r=>r.selected).connection.status,'connected');assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimes.legacy.runtimeToken,TOKEN);
});
test('real gateway URL and token pair check/save, GET, reconnect and reverse',async t=>{
 const h=await fixture(t),{makeFakeGateway,loadScenario}=require('../helpers/scenario');const remote=makeFakeGateway(loadScenario('foreign-instance'));remote.token='second-scratch-gateway-token';const gw=await remote.start();t.after(()=>remote.stop());await h.reauth();
 assert.equal((await h.post(BASE+'/check',{runtime:{adapter:'openclaw',gatewayUrl:gw.url}})).status,400);
 const runtime={adapter:'openclaw',gatewayUrl:gw.url,token:remote.token};let r=await h.post(BASE+'/check',{runtime});assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.ok,true);assert.equal(saved(h).runtime.openclaw.gatewayUrl,h.gw.url);
 await put(h,'runtime',{runtime});await waitFor(()=>h.engine.gateway().connected);let vm=await get(h);assert.equal(vm.runtimes.find(r=>r.selected).values.gatewayUrl.value,gw.url);assert.equal(saved(h).runtimes[0].openclaw.gatewayUrl,gw.url);assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimes.legacy.runtimeToken,remote.token);
 await put(h,'runtime',{runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:TOKEN}});await waitFor(()=>h.engine.gateway().connected);vm=await get(h);assert.equal(vm.runtimes.find(r=>r.selected).values.gatewayUrl.value,h.gw.url);assert.equal(saved(h).runtimes[0].openclaw.gatewayUrl,h.gw.url);assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimes.legacy.runtimeToken,TOKEN);
});
test('real agent re-add, GET and removal reverse',async t=>{
 const h=await fixture(t);await h.post(BASE+'/detect');await put(h,'agents',{runtime:'openclaw',primary:'atlas',agents:[initial[0]]});assert.equal((await get(h)).agents.find(a=>a.agentId==='scribe').configured,false);
 await put(h,'agents',{runtime:'openclaw',primary:'atlas',agents:initial});assert.equal((await get(h)).agents.find(a=>a.agentId==='scribe').configured,true);assert.ok(saved(h).agents.configured.legacy.includes('scribe'));
 await put(h,'agents',{runtime:'openclaw',primary:'atlas',agents:[initial[0]]});assert.equal((await get(h)).agents.find(a=>a.agentId==='scribe').configured,false);assert.ok(!saved(h).agents.configured.legacy.includes('scribe'));
});
