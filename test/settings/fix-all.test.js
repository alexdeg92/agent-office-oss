'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {realisticSettings}=require('../helpers/settings-roundtrip-fixture');
const {adapterById}=require('../../src/adapters'),{scopedId}=require('../../src/runtime-ids');
const {SettingsFixAllResult}=require('../../src/api/v2/vm/schemas'),s=require('../../src/schema');
const I=require('../../src/adapters/openclaw/integration');
const BASE='/api/v3/settings';
const install=id=>'integration.install:'+scopedId('legacy','agent',id)+':projet';
async function fixture(t,options={}){const h=await realisticSettings({effectiveV3:true,...options});t.after(()=>h.close());return h;}
const request=(revision=1,items=[{id:install('atlas')},{id:install('scribe')}])=>({expectedRevision:revision,confirmed:true,items});
const target=(h,id)=>({id,workspace:path.join(h.tmp,'.openclaw/workspace',id==='atlas'?'':'claude-code')});
async function vm(h){const r=await h.get(BASE);assert.equal(r.status,200,r.text);return r.json.data;}
test('detected connector candidates are informational without a fix, and a matching detected gateway has one diagnostic',async t=>{
 const h=await fixture(t);fs.mkdirSync(path.join(h.tmp,'.cursor'),{recursive:true});const r=await h.post(BASE+'/detect');
 const model=h.settings.vm({headers:{cookie:h.cookie}}),d=model.diagnostics.find(d=>d.id==='runtime:codex');assert.ok(d);assert.equal(d.level,'info');assert.equal(d.fix,null);assert.equal(d.label.key,'settings.diagnostic.detected');assert.equal(d.detail.key,'settings.diagnostic.detectedDetail');const cursor=model.diagnostics.find(d=>d.id==='runtime:cursor-cli');assert.ok(cursor);assert.equal(cursor.level,'info');assert.equal(cursor.fix,null);assert.equal(cursor.label.key,'settings.diagnostic.unsupported');assert.equal(cursor.detail.key,'settings.diagnostic.unsupportedDetail');
 assert.equal(r.status,200,r.text);assert.equal(model.diagnostics.filter(d=>d.id.startsWith('runtime:')&&d.label.params?.runtime==='OpenClaw').length,1);
});
test('fix-all uses real reviewed installers and fresh GET for both automatic targets',async t=>{
 const h=await fixture(t);await h.reauth();const r=await h.post(BASE+'/fix-all',request());assert.equal(r.status,200,r.text);
 assert.equal(s.validate(SettingsFixAllResult,r.json.data.result).ok,true);assert.deepEqual(r.json.data.result.items.map(i=>i.status),['applied','applied']);assert.equal(r.json.data.revision,3);assert.equal(r.json.data.result.restartRequired,false);
 for(const id of ['atlas','scribe'])assert.equal(I.inspect(target(h,id),{locale:'fr'}).status,'installed');
 assert.ok((await vm(h)).agents.filter(a=>a.configured).every(a=>a.integrations[0].status==='installed'));
 const logs=h.store.audit.recent().filter(a=>a.command==='settings.fixAll.item');assert.equal(logs.length,2);assert.ok(logs.every(a=>a.outcome==='ok'));
 assert.ok(!JSON.stringify(logs).includes(h.tmp));assert.ok(!JSON.stringify(logs).includes(h.fake.token));
});
test('partial failure retains a successful target, restores the failed one and reports every item without private errors',async t=>{
 const h=await fixture(t),A=adapterById('openclaw'),original=A.projectTag;await h.reauth();
 A.projectTag=()=>({...original(),install:(a,o)=>{if(a.id==='scribe'&&!o.dryRun)throw new Error('PRIVATE_FILE_CONTENT:'+h.tmp);return original().install(a,o);}});t.after(()=>{A.projectTag=original;});
 const r=await h.post(BASE+'/fix-all',request());assert.equal(r.status,200,r.text);assert.deepEqual(r.json.data.result.items.map(i=>i.status),['applied','failed']);assert.equal(r.json.data.revision,2);
 assert.equal(I.inspect(target(h,'atlas'),{locale:'fr'}).status,'installed');assert.equal(I.inspect(target(h,'scribe'),{locale:'fr'}).status,'absent');assert.ok(!r.text.includes('PRIVATE_FILE_CONTENT'));
 const logs=h.store.audit.recent().filter(a=>a.command==='settings.fixAll.item');assert.equal(logs.length,2);assert.deepEqual(logs.map(a=>a.outcome).sort(),['failed','ok']);
});
test('whole-request selection validation occurs before any first item is installed',async t=>{
 const h=await fixture(t);await h.reauth();
 for(const mutate of [b=>b.items.push({id:'integration.install:unknown'}),b=>b.items.push(b.items[0]),b=>b.items[1].path=h.tmp,b=>b.items[1].kind='integration.install',b=>b.confirmed=false,b=>b.items=[],b=>b.items=Array.from({length:101},(_,i)=>({id:'x'+i}))]) {
  const b=request();mutate(b);const r=await h.post(BASE+'/fix-all',b);assert.equal(r.status,400,r.text);assert.equal(h.settings.revision(),1);assert.equal(I.inspect(target(h,'atlas'),{locale:'fr'}).status,'absent');
 }
 assert.equal((await h.post(BASE+'/fix-all',request(0))).status,409);
});
test('fix-all honors owner authentication, token scope, CSRF, readonly and one recent per-session confirmation',async t=>{
 const h=await fixture(t,{publicUrl:'http://127.0.0.1:19101'}),saved=h.cookie;
 h.cookie='';assert.equal((await h.post(BASE+'/fix-all',request())).status,401);h.cookie=saved;
 const token=h.store.tokens.create({agentId:scopedId('legacy','agent','atlas')}).token;
 assert.equal((await h.request('POST',BASE+'/fix-all',request(),{authorization:'Bearer '+token})).status,403);
 assert.equal((await h.request('POST',BASE+'/fix-all',request(),{origin:'https://foreign.example.test'})).status,403);
 assert.equal((await h.post(BASE+'/fix-all',request())).status,403);await h.reauth();h.clock.elapsed=300000;assert.equal((await h.post(BASE+'/fix-all',request())).status,403);
 const ro=await fixture(t,{env:{PORTAL_READONLY_STORE:'1'}});assert.equal((await ro.post(BASE+'/fix-all',request())).status,403);assert.ok((await vm(ro)).diagnostics.every(d=>d.fix===null));
});
test('reauth expiry between items preserves the completed item and refuses subsequent writes',async t=>{
 const h=await fixture(t);await h.reauth();const push=h.events.push.bind(h.events);h.events.push=frame=>{const r=push(frame);if(frame.changed.includes('integrations'))h.clock.elapsed=300000;return r;};
 const r=await h.post(BASE+'/fix-all',request());assert.equal(r.status,200,r.text);assert.deepEqual(r.json.data.result.items.map(i=>i.status),['applied','failed']);assert.equal(r.json.data.result.items[1].error.issue,'reauth-required');
 assert.equal(I.inspect(target(h,'atlas'),{locale:'fr'}).status,'installed');assert.equal(I.inspect(target(h,'scribe'),{locale:'fr'}).status,'absent');
});
test('foreign files are manual review only; tampered automatic IDs cannot force overwrite',async t=>{
 const h=await fixture(t);await h.reauth();const dir=path.join(target(h,'atlas').workspace,'skills/projet');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),'PRIVATE_FOREIGN_CONTENT');
 const model=await vm(h),fix=model.diagnostics.find(d=>d.id==='agent:'+scopedId('legacy','agent','atlas')).fix;assert.equal(fix.kind,'integration.review');assert.equal(fix.automatic,false);
 assert.equal((await h.post(BASE+'/fix-all',request(1,[{id:install('atlas')}]))).status,400);
 const r=await h.post(BASE+'/fix-all',request(1,[{id:fix.id}]));assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.items[0].status,'input-required');assert.equal(fs.readFileSync(path.join(dir,'SKILL.md'),'utf8'),'PRIVATE_FOREIGN_CONTENT');assert.equal(h.settings.revision(),1);
});
test('symlink replacement after diagnosis cannot widen the approved integration write scope',async t=>{
 const h=await fixture(t);await h.reauth();await vm(h);const original=target(h,'atlas').workspace,nested=target(h,'scribe').workspace;
 fs.renameSync(nested,nested+'-original');const outside=path.join(h.tmp,'unreviewed');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'AGENTS.md'),'PRIVATE_SENTINEL');fs.symlinkSync(outside,nested);
 const r=await h.post(BASE+'/fix-all',request());assert.equal(r.status,400,r.text);assert.equal(fs.readFileSync(path.join(outside,'AGENTS.md'),'utf8'),'PRIVATE_SENTINEL');assert.equal(fs.existsSync(path.join(original,'skills')),false);
});
test('existing pending network is offered after fix-all without exiting any process',async t=>{
 let exits=0;const h=await fixture(t,{supervisor:{supported:true,command:null,reason:null,restart:()=>{exits++;}}});await h.reauth();
 let r=await h.put(BASE+'/network',{expectedRevision:1,mode:'tailnet',port:18809,publicUrl:'https://scratch.example.test'});assert.equal(r.status,200,r.text);assert.equal(r.json.data.vm.network.restartRequired,true);
 r=await h.post(BASE+'/fix-all',request(2));assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.restartRequired,true);assert.equal(r.json.data.vm.network.restartRequired,true);assert.equal(exits,0);
});
test('runtime enabling is opt-in, checks the real scratch source and retains all other private configuration',async t=>{
 const h=await fixture(t);await h.reauth();const home=path.join(h.tmp,'.claude'),project=path.join(home,'projects','scratch-project');fs.mkdirSync(project,{recursive:true});
 fs.writeFileSync(path.join(project,'scratch-session.jsonl'),JSON.stringify({type:'user',uuid:'scratch-event',sessionId:'scratch-session',timestamp:new Date().toISOString(),message:{role:'user',content:'PRIVATE_SCRATCH_TRANSCRIPT'}})+'\n');
 const saved=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url},{id:'claude-local',adapter:'claude-code',enabled:false,home,include:'',exclude:'',agentGrouping:'project'}]});assert.equal(saved.status,200,saved.text);
 const current=await vm(h),fix=current.diagnostics.find(d=>d.id==='runtime:claude-local').fix;
 assert.equal(fix.kind,'runtime.enable');assert.equal(fix.automatic,false);assert.equal(fix.requiresConsent,true);
 const privateBefore=JSON.parse(fs.readFileSync(h.paths.secrets)),A=adapterById('claude-code'),probe=A.setup.settings.probe;let reads=0;
 A.setup.settings.probe=async value=>{reads++;return probe(value);};t.after(()=>{A.setup.settings.probe=probe;});
 let r=await h.post(BASE+'/fix-all',request(2,[{id:install('atlas')},{id:fix.id}]));assert.equal(r.status,403,r.text);assert.equal(reads,0);assert.equal(h.settings.revision(),2);assert.equal(I.inspect(target(h,'atlas'),{locale:'fr'}).status,'absent');
 r=await h.post(BASE+'/fix-all',request(2,[{id:fix.id,consent:true}]));assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.items[0].status,'applied',JSON.stringify(r.json.data.result));assert.equal(reads,1);assert.equal(r.json.data.result.restartRequired,false);
 assert.equal((await vm(h)).runtimes.find(r=>r.id==='claude-local').enabled,true);assert.equal(JSON.parse(fs.readFileSync(h.paths.secrets)).runtimes.legacy.runtimeToken,privateBefore.runtimes.legacy.runtimeToken);
 assert.equal(JSON.parse(fs.readFileSync(h.paths.file)).runtimes.find(r=>r.id==='legacy').enabled,true);assert.ok(!r.text.includes('PRIVATE_SCRATCH_TRANSCRIPT'));assert.ok(!JSON.stringify(h.store.audit.recent()).includes(h.fake.token));
});
test('external revision during an asynchronous plan refuses all remaining batch writes',async t=>{
 const h=await fixture(t);await h.reauth();const A=adapterById('openclaw'),original=A.setup.integrationAgents;let changed=false;
 A.setup.integrationAgents=async value=>{if(!changed){changed=true;const edit=await h.put(BASE+'/instance',{expectedRevision:1,name:'Other tab changed this'});assert.equal(edit.status,200,edit.text);}return original(value);};t.after(()=>{A.setup.integrationAgents=original;});
 const r=await h.post(BASE+'/fix-all',request());assert.equal(r.status,200,r.text);assert.ok(r.json.data.result.items.every(i=>i.status==='failed'&&i.error.issue==='settings-revision'));assert.equal(h.settings.revision(),2);
 for(const id of ['atlas','scribe'])assert.equal(I.inspect(target(h,id),{locale:'fr'}).status,'absent');assert.equal(JSON.parse(fs.readFileSync(h.paths.file)).instance.name,'Other tab changed this');
});
test('file changes between integration plan and apply are reported without overwriting the concurrent file',async t=>{
 const h=await fixture(t);await h.reauth();const A=adapterById('openclaw'),original=A.projectTag;let scheduled=false;
 A.projectTag=()=>({...original(),install:(a,o)=>{const r=original().install(a,o);if(o.dryRun&&!scheduled){scheduled=true;queueMicrotask(()=>fs.appendFileSync(path.join(target(h,'atlas').workspace,'AGENTS.md'),'\nPRIVATE_CONCURRENT_EDIT\n'));}return r;}});t.after(()=>{A.projectTag=original;});
 const r=await h.post(BASE+'/fix-all',request(1,[{id:install('atlas')}]));assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.items[0].status,'failed');assert.equal(r.json.data.result.items[0].error.issue,'ESTALEPLAN');assert.equal(h.settings.revision(),1);
 assert.ok(fs.readFileSync(path.join(target(h,'atlas').workspace,'AGENTS.md'),'utf8').includes('PRIVATE_CONCURRENT_EDIT'));assert.equal(I.inspect(target(h,'atlas'),{locale:'fr'}).status,'absent');assert.ok(!r.text.includes('PRIVATE_CONCURRENT_EDIT'));
});
test('prod keyed roster fixes only the genuinely outdated main while preserving the previously installed nested agent',async t=>{
 const {settingsFixture}=require('../helpers/settings-fixture'),{TOKEN}=require('../helpers/onboarding-fixture'),{detectRuntimes}=require('../../src/adapters/detection');
 const h=await settingsFixture({effectiveV3:true,handlers:{'agents.list':()=>({defaultId:'main',agents:[{id:'main',name:'Atlas'},{id:'claude-code',name:'Claude Code'}]})},detect:({env})=>detectRuntimes({env:{...env,PATH:''}}),seed:(home,{gateway})=>{
  const workspace=path.join(home,'.openclaw/workspace'),nested=path.join(workspace,'claude-code');
  const targets=[{id:'main',workspace},{id:'claude-code',workspace:nested}];
  for(const a of targets){fs.mkdirSync(a.workspace,{recursive:true});fs.writeFileSync(path.join(a.workspace,'AGENTS.md'),'# Scratch instructions\n\nOwner text.\n');I.install(a,{locale:'fr',backupDir:path.join(home,'backups')});}
  const file=path.join(workspace,'AGENTS.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('agent-office:projet v2','agent-office:projet v1'));
  fs.writeFileSync(path.join(home,'.openclaw/openclaw.json'),JSON.stringify({gateway:{port:Number(new URL(gateway.url).port),auth:{token:TOKEN}},agents:{defaults:{workspace},entries:{main:{name:'Atlas',workspace},'claude-code':{name:'Claude Code'}}}}));return targets;
 },config:config=>{delete config.network;config.agents.primary='main';config.agents.names={openclaw:{main:'Atlas','claude-code':'Claude Code'}};},env:{HOST:'127.0.0.1',PORT:'18807',AO_PUBLIC_URL:'https://scratch.example.test',AO_TRUST_PROXY:'loopback',PORTAL_COOKIE_SECURE:'0'}});t.after(()=>h.close());
 const before=await vm(h),fixes=before.diagnostics.flatMap(d=>d.fix?.automatic?[d.fix]:[]);assert.equal(fixes.length,1);assert.equal(fixes[0].kind,'integration.update');assert.equal(fixes[0].target.agentId,'main');assert.equal(before.network.restartRequired,false);
 const nested=path.join(h.tmp,'.openclaw/workspace/claude-code'),files=['AGENTS.md','skills/projet/SKILL.md','skills/projet/projet.js'].map(f=>path.join(nested,f)),bytes=files.map(f=>fs.readFileSync(f,'utf8'));
 await h.reauth();const r=await h.post(BASE+'/fix-all',request(before.revision,fixes.map(f=>({id:f.id}))));assert.equal(r.status,200,r.text);assert.equal(r.json.data.result.items[0].status,'applied');assert.equal(r.json.data.result.restartRequired,false);
 assert.deepEqual(files.map(f=>fs.readFileSync(f,'utf8')),bytes);assert.ok((await vm(h)).agents.filter(a=>a.configured).every(a=>a.integrations[0].status==='installed'));assert.equal(fs.existsSync(path.join(h.tmp,'.openclaw/workspace-claude-code')),false);
});
