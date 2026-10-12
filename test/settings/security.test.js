const { scopedId, parseId } = require('../../src/runtime-ids');
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {settingsFixture}=require('../helpers/settings-fixture');
const {openSse}=require('../helpers/sse-client');
const {SettingsVM}=require('../../src/api/v2/vm/schemas'),s=require('../../src/schema');
const BASE='/api/v3/settings';
async function fixture(t,options){const h=await settingsFixture(options);t.after(()=>h.close());return h;}
const network={expectedRevision:1,mode:'local',port:18800,publicUrl:null};
test('a forgotten Settings detector fixture fails before probing any host state',async t=>{
 const h=await fixture(t,{detect:null});assert.equal((await h.get(BASE)).status,200);assert.equal((await h.post(BASE+'/detect')).status,500);assert.equal(h.detectCalls,0);
});
test('every owner Settings route rejects missing, tampered, foreign-owner and expired cookies before work',async t=>{
 const h=await fixture(t),saved=h.cookie,owner=h.store.users.owner();
 const routes=[['GET',''],['POST','/restart'],['POST','/fix-all'],['POST','/reauth'],['POST','/check'],['POST','/detect'],['PUT','/agents'],['PUT','/runtime'],['PUT','/runtimes'],['PUT','/instance'],['PUT','/network'],['PUT','/owner'],['POST','/password'],['POST','/integrations/plan'],['POST','/integrations/apply']];
 const cookies=['','taco_sess=bad.cookie','taco_sess='+h.auth.signSession({userId:'other-owner',sid:'fixture',exp:Date.now()+60000}), 'taco_sess='+h.auth.signSession({userId:owner.id,sid:'fixture',exp:Date.now()-1})];
 for(const cookie of cookies){h.cookie=cookie;for(const [method,p] of routes)assert.equal((await h.request(method,BASE+p,method==='GET'?undefined:{})).status,401,method+p);}
 h.cookie=saved;assert.equal(h.detectCalls,0);assert.equal(h.settings.revision(),1);
});
test('Settings mutations enforce CSRF and configured proxy origin; audit contains only categories',async t=>{
 const origin='http://127.0.0.1:19101',h=await fixture(t,{publicUrl:origin});
 let r=await h.request('PUT',BASE+'/instance',{expectedRevision:1,name:'Sensitive name'},{origin:'https://foreign.example.test'});assert.equal(r.status,403);assert.equal(r.json.error.details[0].issue,'csrf');
 r=await h.request('PUT',BASE+'/instance',{expectedRevision:1,name:'Allowed'},{origin});assert.equal(r.status,200,r.text);
 const audit=JSON.stringify(h.store.audit.recent());assert.ok(!audit.includes('Sensitive name'));assert.ok(!audit.includes('Allowed'));assert.ok(audit.includes('csrf'));
});
test('reauth expires by elapsed time even if the wall clock goes backwards; logout consumes it',async t=>{
 const h=await fixture(t);await h.reauth();h.clock.now-=86400000;h.clock.elapsed=300000;assert.equal((await h.get(BASE)).json.data.reauth.expiresAt,null);assert.equal((await h.put(BASE+'/network',network)).status,403);
 await h.reauth();const cookie=h.cookie;await h.post('/api/logout');h.cookie=cookie;assert.equal((await h.get(BASE)).status,401);
});
test('sensitive commands check expiry again after the asynchronous probe or password derivation',async t=>{
 let h;h=await fixture(t,{probe:async()=>{h.clock.elapsed+=300000;return{status:'connected',protocol:3,latencyMs:1}},derivePassword:async p=>{h.clock.elapsed+=300000;return require('../../src/security/password').hashPassword(p)}});
 await h.reauth();let r=await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:'new-fixture-token'}});assert.equal(r.status,403,r.text);assert.equal(h.settings.revision(),1);
 await h.reauth();r=await h.post(BASE+'/password',{password:'replacement-fixture-password'});assert.equal(r.status,403,r.text);assert.equal(h.store.users.authGeneration(),0);
});
test('current connection checks succeed, failed edited checks do not mutate saved status/config, probes close',async t=>{
 let calls=0,closed=0;const h=await fixture(t,{probe:async()=>{calls++;return{status:calls===1?'connected':'unauthorized',protocol:3,latencyMs:1,gw:{close(){closed++}}}}});
 let r=await h.post(BASE+'/check',{runtime:{adapter:'openclaw',gatewayUrl:h.gw.url}});assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.ok,true);
 await h.reauth();r=await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:'bad-fixture-token'}});assert.equal(r.status,502,r.text);assert.equal(closed,2);assert.equal((await h.get(BASE)).json.data.runtimes.find(r=>r.selected).connection.status,'connected');assert.equal(h.settings.revision(),1);
});
test('env-imposed primary permits changing a name; env-imposed port permits changing other network fields',async t=>{
 const h=await fixture(t,{env:{AO_PRIMARY_AGENT:'atlas',PORT:'18789'}});
 let r=await h.put(BASE+'/agents',{expectedRevision:1,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Orion',hidden:false}]});assert.equal(r.status,200,r.text);
 await h.reauth();r=await h.put(BASE+'/network',{expectedRevision:2,mode:'tailnet',port:18789,publicUrl:'https://office.example.test'});assert.equal(r.status,200,r.text);assert.equal(r.json.data.vm.network.port.editable,false);
 r=await h.put(BASE+'/network',{expectedRevision:3,mode:'tailnet',port:18800,publicUrl:'https://office.example.test'});assert.equal(r.status,403);
});
test('an env-imposed saved URL permits a token rotation without changing the URL',async t=>{
 let token;const h=await fixture(t,{env:gw=>({OC_GATEWAY_URL:gw.url}),probe:async p=>{token=p.token;return{status:'connected',protocol:3,latencyMs:1}}});
 await h.reauth();const r=await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:'replacement-fixture-token'}});assert.equal(r.status,200,r.text);assert.equal(token,'replacement-fixture-token');assert.equal(r.json.data.vm.runtimes.find(r=>r.selected).values.gatewayUrl.editable,false);
});
test('Store read-only disables all settings writes while keeping the owner VM readable',async t=>{
 const h=await fixture(t,{env:{PORTAL_READONLY_STORE:'1'}});assert.equal((await h.get(BASE)).json.data.readonly,true);assert.equal((await h.reauth()).status,403);assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'No'})).status,403);
});
test('database commit failure restores both files and owner rows; external config edits cause conflict',async t=>{
 const h=await fixture(t);await h.reauth();const before=[h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8'));
 h.store.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 const r=await h.put(BASE+'/owner',{expectedRevision:1,displayName:'Changed',email:'changed@example.test'});assert.equal(r.status,503,r.text);assert.equal(h.store.owner.name,'Camille');assert.equal(h.store.users.owner().email,h.email);assert.deepEqual([h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8')),before);assert.equal(h.settings.revision(),1);
 h.store.db.exec('DROP TRIGGER fail_settings');const c=JSON.parse(before[0]);c.instance.name='External';fs.writeFileSync(h.paths.file,JSON.stringify(c));assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'Stale'})).status,409);
});
test('new manual agents appear live, null labels are preserved, removal leaves discovery for restore',async t=>{
 const h=await fixture(t);let r=await h.put(BASE+'/agents',{expectedRevision:1,runtime:'openclaw',primary:'nova',agents:[{id:'nova',name:'Vega',hidden:false},{id:'unlabelled',name:null,hidden:false}]});assert.equal(r.status,200,r.text);assert.equal(h.engine.primaryAgent().name,'Vega');assert.ok(h.engine.agents().some(a=>a.id===scopedId('legacy','agent','unlabelled')));assert.ok(!h.engine.agents().some(a=>a.id===scopedId('legacy','agent','atlas')));assert.equal(r.json.data.vm.agents.find(a=>a.agentId==='unlabelled').name,null);assert.equal(s.validate(SettingsVM,r.json.data.vm).ok,true);
 r=await h.put(BASE+'/agents',{expectedRevision:2,runtime:'openclaw',primary:'atlas',agents:[{id:'atlas',name:'Atlas',hidden:false}]});assert.equal(r.status,200,r.text);assert.equal(h.engine.primaryAgent().id,scopedId('legacy','agent','atlas'));assert.ok(!h.engine.agents().some(a=>a.id===scopedId('legacy','agent','nova')));
});
test('Settings SSE refresh is identical on v2/v3 and password changes close other sessions only',async t=>{
 const h=await fixture(t),cookie=h.cookie;
 const a=openSse(h.base,'/api/v2/stream',{cookie}),b=openSse(h.base,'/api/v3/stream',{cookie});t.after(()=>{a.close();b.close()});await Promise.all([a.opened,b.opened]);
 const r=await h.put(BASE+'/instance',{expectedRevision:1,name:'Fresh'});assert.equal(r.status,200,r.text);const frames=await Promise.all([a.next(f=>f.event==='settings'),b.next(f=>f.event==='settings')]);assert.deepEqual(frames[0].data,frames[1].data);assert.deepEqual(Object.keys(frames[0].data).sort(),['changed','restartRequired','revision']);
 await h.login();const other=openSse(h.base,'/api/v3/stream',{cookie:h.cookie});t.after(()=>other.close());await other.opened;h.cookie=cookie;await h.reauth();const p=await h.post(BASE+'/password',{password:'replacement-fixture-password'});assert.equal(p.status,200,p.text);await other.ended$();assert.equal(a.ended,false);assert.equal(b.ended,false);
});
test('cold DB reopen retains revision and password generation, rejecting pre-rotation cookies',async t=>{
 const h=await fixture(t),old=h.cookie;await h.reauth();await h.post(BASE+'/password',{password:'replacement-fixture-password'});const current=h.cookie;
 const backup=h.store.backup(),{openStore}=require('../../src/store'),IC=require('../../src/instance-config'),{createAuth}=require('../../src/auth');
 const dir=path.join(h.tmp,'cold-store');fs.mkdirSync(dir,{mode:0o700});fs.copyFileSync(backup,path.join(dir,'agent-office.sqlite'));
 const cold=openStore({dir,instance:'test',ownerName:'Camille',log:()=>{}});try{const files=IC.readInstanceConfig(h.env),auth=createAuth({secret:files.secrets.sessionSecret,credential:email=>email==null?cold.users.owner():cold.users.credential(email),credentialGeneration:()=>cold.users.authGeneration()});assert.equal(auth.verifySession(old.split('=')[1]),null);assert.ok(auth.verifySession(current.split('=')[1]));assert.equal(cold.db.prepare("SELECT value FROM settings_state WHERE key='revision'").get().value,2);}finally{cold.close()}
});
test('a login using the old hash cannot mint a new-generation cookie while a password rotation is in flight',async t=>{
 const h=await fixture(t),{hashPassword}=require('../../src/security/password');const next=await hashPassword('replacement-fixture-password');
 const original=h.store.users.credential;let acquired;const seen=new Promise(resolve=>{acquired=resolve});h.store.users.credential=email=>{const row=original(email);acquired();return row};
 const pending=h.login();await seen;h.store.withTx(()=>h.store.users.rotatePassword(next));const r=await pending;assert.equal(r.status,401,r.text);assert.equal(r.headers.get('set-cookie'),null);
});
test('agent bearer tokens cannot use owner Settings routes, even with an owner cookie',async t=>{
 const h=await fixture(t),token=h.store.tokens.create({agentId:'atlas'}).token;
 for(const [method,route] of [['GET',''],['POST','/restart'],['POST','/fix-all'],['POST','/reauth'],['POST','/detect'],['PUT','/runtime'],['PUT','/runtimes'],['PUT','/instance'],['POST','/password']]){
  const r=await h.request(method,BASE+route,method==='GET'?undefined:{},{authorization:'Bearer '+token});assert.equal(r.status,403,r.text);assert.equal(r.json.error.details[0].issue,'token-scope');
 }
 assert.equal(h.detectCalls,0);assert.equal(h.settings.revision(),1);assert.ok(!JSON.stringify(h.store.audit.recent()).includes(token));
});
test('external env owner credentials stay immutable while instance settings remain editable',async t=>{
 const {EMAIL,PASSWORD}=require('../helpers/settings-fixture');const h=await fixture(t,{env:{PORTAL_EMAIL:EMAIL,PORTAL_PASSWORD:PASSWORD,PORTAL_SECRET:'synthetic-external-secret'}});
 const vm=(await h.get(BASE)).json.data;assert.equal(vm.owner.passwordChangeEnabled,false);assert.equal(vm.owner.email.source,'env');await h.reauth();assert.equal((await h.post(BASE+'/password',{password:'replacement-fixture-password'})).status,403);assert.equal((await h.put(BASE+'/owner',{expectedRevision:1,displayName:'Forbidden'})).status,403);assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'Allowed'})).status,200);
});
test('post-commit backup cleanup failure cannot restore files behind an already committed database hash',async t=>{
 const h=await fixture(t),IC=require('../../src/instance-config'),{digest}=require('../../src/ops/config-publisher'),original=IC.writeInstanceConfig;
 IC.writeInstanceConfig=(paths,config,secrets,options)=>original(paths,config,secrets,{...options,hook:phase=>{if(phase==='config'){const dir=path.join(path.dirname(paths.file),'.publish-backups'),file=path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('plan-')));fs.unlinkSync(file);fs.writeFileSync(file,'synthetic concurrent private replacement',{mode:0o600});}}});
 let r;try{r=await h.put(BASE+'/instance',{expectedRevision:1,name:'Committed'});}finally{IC.writeInstanceConfig=original;}
 assert.equal(r.status,200,r.text);const config=JSON.parse(fs.readFileSync(h.paths.file));assert.equal(config.instance.name,'Committed');assert.equal(h.settings.revision(),2);assert.equal(h.store.db.prepare("SELECT value FROM store_meta WHERE key='setup_config_hash'").get().value,digest(config));
});
test('stale runtime revisions and invalid connection/plan bodies fail before an edited gateway is probed',async t=>{
 let probes=0;const h=await fixture(t,{probe:async()=>{probes++;return{status:'connected',protocol:3,latencyMs:1}}});await h.reauth();
 const runtime={adapter:'openclaw',gatewayUrl:h.gw.url,token:'replacement-fixture-token'};
 assert.equal((await h.put(BASE+'/runtime',{runtime})).status,400);assert.equal((await h.put(BASE+'/runtime',{expectedRevision:0,runtime})).status,409);assert.equal(probes,0);
 assert.equal((await h.post(BASE+'/check',{runtime:{...runtime,extra:'synthetic'}})).status,400);assert.equal((await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'invalid'})).status,400);
});
test('an integration revision commit failure restores every reviewed target',async t=>{
 const h=await fixture(t);await h.post(BASE+'/detect');const p=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});assert.equal(p.status,200,p.text);await h.reauth();
 const files=p.json.data.result.agents.flatMap(a=>a.uninstallFiles),image=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8'):null,before=files.map(image);
 h.store.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 const r=await h.post(BASE+'/integrations/apply',{planId:p.json.data.result.planId,agentIds:['atlas','scribe'],action:'install',confirmed:true});assert.equal(r.status,400,r.text);assert.deepEqual(files.map(image),before);assert.equal(h.settings.revision(),1);
});
