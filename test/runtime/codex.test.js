'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('../../src/adapters/codex'),{createFiles,MAX_ENTRIES,MAX_READ,MAX_FILTER_BYTES}=require('../../src/adapters/codex/files');
const {adapterById,ADAPTER_IDS}=require('../../src/adapters');
const {createEngine}=require('../../src/engine');const schema=require('../../src/schema');
const {buildOfficeVM,createStateTracker}=require('../../src/api/v2/vm/office');const {project3x}=require('../../src/api/v2/project3x');
const {startServer}=require('../helpers/harness'),{loadScenario}=require('../helpers/scenario');
const {runFromTranscript}=require('../../src/adapters/transcript-execution');
const {executionState}=require('../../src/engine/execution-state');
const NOW=1791600000000;
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-codex-synthetic-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const file=(date='2026/10/10',name='rollout-synthetic-1.jsonl',rows=[])=>{const target=path.join(home,'sessions',date,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return target;};return{home,file};}
const meta=(cwd='/synthetic/private/agent-office',extra={})=>({type:'session_meta',payload:{id:'synthetic-session-id',timestamp:new Date(NOW-60000).toISOString(),cwd,originator:'codex-cli',cli_version:'0.synthetic',source:'cli',model_provider:'openai',...extra}});
const ctx=(model='gpt-synthetic-codex',cwd='/synthetic/private/agent-office')=>({type:'turn_context',payload:{model,cwd,current_date:'2026-10-10',timezone:'UTC',approval_policy:'never',sandbox_policy:'synthetic'}});
const message=(role,text,id)=>({type:'response_item',timestamp:new Date(NOW-10000).toISOString(),payload:{type:'message',id,role,content:[{type:role==='user'?'input_text':'output_text',text}],status:'completed'}});
const usage=total=>({type:'event_msg',timestamp:new Date(NOW-9000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:5,total_tokens:total,cached_input_tokens:0,reasoning_output_tokens:0}}}});
async function startAndWait(runtime,engine){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Codex initial refresh timed out')),5000);runtime.start(engine,{refreshed:()=>{clearTimeout(timer);resolve();}});});}

test('Codex-only synthetic instance reaches AO_READY and loads its first session',async t=>{
 const h=await startServer(loadScenario('synthetic-basic'),{demo:true,prepare:async(tmp,{env})=>{
  delete env.OC_GATEWAY_URL;delete env.OC_GATEWAY_TOKEN;
  const root=path.join(tmp,'.config','agent-office'),home=path.join(tmp,'.codex'),sessions=path.join(home,'sessions','2026','10','10');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(sessions,{recursive:true});
  fs.writeFileSync(path.join(sessions,'rollout-synthetic-boot.jsonl'),[meta(),ctx(),message('user','Synthetic startup prompt','u1'),message('assistant','Synthetic startup reply','a1'),usage(73)].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const config={version:3,instance:{name:'Codex synthetic',locale:'en',timeZone:'UTC'},owner:{displayName:'Synthetic owner',email:'test@example.invalid',authSource:'database'},
   runtimes:[{id:'codex',enabled:true,adapter:'codex',codex:{home,include:[],exclude:[],agentGrouping:'project'}}],
   agents:{primary:null,looks:{},names:{},hidden:{},configured:{}}};
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'secrets.json'),JSON.stringify({version:3,sessionSecret:'s'.repeat(48),runtimes:{codex:{}}}));
 }});t.after(()=>h.stop());
 assert.match(h.output,/AO_READY \{"mode":"app"/);const logs=await h.get('/api/v3/views/logs');assert.equal(logs.status,200);assert.ok(logs.json.data.items.length>0);const log=logs.json.data.items.find(row=>row.kind==='conversation');assert.equal(log?.tokens,73,'Journaux exposes the session-local Codex total');assert.equal(log?.tokensKnown,true);
});

test('Codex runtime start does not wait for its initial filesystem scan',async t=>{
 const h=fixture(t),runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home}}}),engine=createEngine({adapter:runtime.definition});t.after(()=>runtime.close());runtime.attach(engine);
 let release,entered;const scanning=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});runtime.files.scan=async()=>{entered();await blocked;return[];};
 let finish;const refreshed=new Promise(resolve=>{finish=resolve;});const result=runtime.start(engine,{refreshed:finish});assert.equal(result,undefined,'startup is fire-and-return');await scanning;assert.equal(engine.sessions().length,0);release();await refreshed;
});

test('Codex rollout reader uses synthetic session_meta/turn_context/response_item/event_msg keys and builds transcript agents',async t=>{
 const h=fixture(t),privateRoot='/synthetic/private';h.file('2026/10/09','rollout-synthetic-1.jsonl',[meta(),ctx(),message('user','SYNTHETIC_PRIVATE_PROMPT','u1'),message('assistant','Synthetic response','a1'),usage(15)]);h.file('2026/10/10','rollout-synthetic-2.jsonl',[meta(),ctx(),message('user','Second session','u2'),message('assistant','Second response','a2'),usage(29)]);
 const files=createFiles({home:h.home,now:()=>NOW,agentGrouping:'project'});t.after(()=>files.close());
 const rows=await files.scan();assert.equal(rows.length,2);const traces=await Promise.all(rows.map(row=>files.read(row.key)));const trace=traces.find(item=>item.events.some(e=>e.text==='Synthetic response'));
 assert.ok(rows.some(row=>row.key===trace.sessionKey));assert.equal(trace.messageCount,2);assert.equal(trace.window.to,2);assert.ok(trace.events.some(e=>e.text==='Synthetic response'));
 assert.equal(JSON.stringify(trace).includes(privateRoot),false);assert.equal(JSON.stringify(files.stats).includes('SYNTHETIC_PRIVATE_PROMPT'),false);
 const loaded=files.rows().find(row=>row.key===rows[0].key);assert.equal(loaded.projectName,'agent-office');assert.equal(loaded.cwd,undefined);assert.equal(loaded.model,'gpt-synthetic-codex');assert.equal(files.rows().map(row=>row.usage).sort((a,b)=>a-b).join(','),'15,29');
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,include:[],exclude:[],agentGrouping:'project'}}},{now:()=>NOW});const engine=createEngine({adapter:runtime.definition,now:()=>NOW});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 assert.equal(engine.agents().length,1);assert.equal(engine.agents()[0].name,'agent-office');assert.equal(engine.sessions().length,2);assert.deepEqual(engine.sessions().map(session=>session.usage.total).sort((a,b)=>a-b),[15,29]);assert.ok(engine.sessions().every(session=>session.tokensKnown===true),'session-local Codex totals are known when the rollout includes token_count');assert.ok(engine.sessions().every(session=>session.run.status==='idle'&&session.run.evidenceLevel==='observed'),'completed assistant turns supply observed idle evidence');assert.equal(engine.transcript(engine.sessions()[0].key).messageCount,2);
});

test('Codex project grouping follows the latest turn worktree instead of the session initial cwd',async t=>{
 const h=fixture(t);h.file('2026/10/10','rollout-worktree-switch.jsonl',[
  meta('/synthetic/agent-office-parent'),ctx('gpt-synthetic-codex','/synthetic/agent-office-connect-ux'),
  message('user','Synthetic worktree prompt','u1'),message('assistant','Synthetic response','a1'),
 ]);
 const files=createFiles({home:h.home,now:()=>NOW,agentGrouping:'project'});t.after(()=>files.close());
 const rows=await files.scan();await files.read(rows[0].key);
 assert.equal(files.rows()[0].projectName,'agent-office-connect-ux');
});

test('Codex private cross-source ref prefers session_meta id then rollout UUID without changing the public key',async t=>{
 const h=fixture(t),metaId='123e4567-e89b-42d3-a456-426614174000',fileId='123e4567-e89b-42d3-a456-426614174001';
 const name=`rollout-20261010T120000-${fileId}.jsonl`;
 h.file('2026/10/10',name,[meta('/synthetic/member',{id:metaId}),ctx()]);
 h.file('2026/10/10',`rollout-20261010T120001-${fileId}.jsonl`,[{type:'session_meta',payload:{cwd:'/synthetic/fallback'}},ctx()]);
 const files=createFiles({home:h.home,now:()=>NOW});t.after(()=>files.close());
 const rows=await files.scan();assert.equal(rows.length,2);
 const key='codex:'+require('node:crypto').createHash('sha256').update(rows.find(r=>r.filename.endsWith(name)).filename).digest('hex');
 assert.equal(rows.find(r=>r.filename.endsWith(name)).key,key,'the existing public hashed key is stable');
 await Promise.all(rows.map(row=>files.read(row.key)));
 const [preferred,fallback]=files.rows().sort((a,b)=>a.filename.localeCompare(b.filename));
 assert.equal(preferred.identitySessionRef,metaId,'session_meta.payload.id wins');
 assert.equal(fallback.identitySessionRef,fileId,'rollout filename UUID is the fallback');
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home}}},{now:()=>NOW}),engine=createEngine({adapter:runtime.definition,now:()=>NOW});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const identities=engine.identitySessions('herdr');const refs=identities.map(row=>row.sessionRef).sort();assert.deepEqual(refs,[metaId,fileId].sort());
 assert.equal(new Set(identities.map(row=>row.agentId)).size,1,'different initial cwd values do not split threads that now share the same worktree');
 assert.ok(engine.sessions().every(row=>!Object.hasOwn(row,'sessionRef')),'the private reference is absent from canonical sessions');
 assert.ok(!JSON.stringify(engine.sessions()).includes(metaId),'metadata UUID is not copied into canonical session fields');
});

test('Codex active task events yield bounded observed Working, completed messages yield Idle, and metadata alone stays Unknown',async t=>{
 const h=fixture(t),at=new Date(NOW-2000).toISOString();
 h.file('2026/10/10','rollout-active.jsonl',[meta(),ctx(),{type:'event_msg',timestamp:at,payload:{type:'task_started'}}]);
 h.file('2026/10/10','rollout-idle.jsonl',[meta(),ctx(),message('user','Synthetic prompt','u'),message('assistant','Synthetic answer','a')]);
 h.file('2026/10/10','rollout-empty.jsonl',[meta(),ctx()]);
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,include:[],exclude:[],agentGrouping:'project'}}},{now:()=>NOW}),engine=createEngine({adapter:runtime.definition,now:()=>NOW});
 t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const byFile=suffix=>engine.session(runtime.files.rows().find(r=>r.filename.endsWith(suffix)).key);
 const active=byFile('rollout-active.jsonl'),idle=byFile('rollout-idle.jsonl'),empty=byFile('rollout-empty.jsonl');
 assert.deepEqual([active.run.status,active.run.evidenceLevel],[ 'running','observed' ]);assert.equal(active.run.expiresAt,NOW-2000+30000);
 assert.deepEqual([idle.run.status,idle.run.evidenceLevel],[ 'idle','observed' ]);
 assert.deepEqual([empty.run.status,empty.run.evidenceLevel],[ 'unknown','unknown' ]);
 const office=buildOfficeVM({engine,canReadSessions:true,now:NOW,tracker:createStateTracker(),actorOf:x=>x,P:project3x});
 assert.ok(office.occupants.some(o=>o.state==='working'&&o.execution.evidence.level==='observed'),'Office presents a live Codex task as Working and keeps its observed evidence');
});

test('Codex archived task events keep their own timestamps and cannot mint fresh Working evidence',()=>{
 const old=NOW-86400000;
 const parsed=require('../../src/adapters/codex/profile').parse([
  {type:'session_meta',payload:{id:'archived',timestamp:new Date(old).toISOString(),cwd:'/synthetic/archive'}},
  {type:'event_msg',payload:{type:'task_started',timestamp:new Date(old).toISOString()}},
 ],{sessionKey:'codex:archived',agentId:'archived',now:()=>NOW});
 assert.equal(parsed.execution.status,'running');assert.equal(parsed.execution.at,old);
 assert.equal(executionState(runFromTranscript(parsed.execution,NOW),NOW).status,'unknown');
 const closed=require('../../src/adapters/codex/profile').parse([
  {type:'session_meta',payload:{id:'closed-archived',timestamp:new Date(old).toISOString(),cwd:'/synthetic/archive'}},
  {type:'response_item',payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic closed response'}]}},
 ],{sessionKey:'codex:closed-archived',agentId:'archived'});
 assert.equal(closed.execution.status,'idle');
 assert.equal(executionState(runFromTranscript(closed.execution,NOW),NOW).status,'idle','a closed transcript remains idle regardless of age');
});

test('Codex project grouping separates projects and runtime grouping combines agents without path disclosure',async t=>{
 const h=fixture(t);h.file('2026/10/09','rollout-synthetic-a.jsonl',[meta('/srv/one/workspace-a'),ctx('gpt-synthetic-codex','/srv/one/workspace-a')]);h.file('2026/10/10','rollout-synthetic-b.jsonl',[meta('/srv/two/workspace-b'),ctx('gpt-synthetic-codex','/srv/two/workspace-b')]);
 for(const [grouping,want] of [['project',2],['runtime',1]]){const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,include:[],exclude:[],agentGrouping:grouping}}},{now:()=>NOW});const engine=createEngine({adapter:runtime.definition,now:()=>NOW});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);assert.equal(engine.agents().length,want);assert.ok(!JSON.stringify(engine.agents()).includes('/srv/'));}
});

test('Codex include and exclude filters keep nonmatching projects out of Office',async t=>{
 const h=fixture(t);h.file('2026/10/09','rollout-synthetic-a.jsonl',[meta('/srv/one/keep-me'),ctx('gpt-synthetic-codex','/srv/one/keep-me')]);h.file('2026/10/10','rollout-synthetic-b.jsonl',[meta('/srv/two/drop-me'),ctx('gpt-synthetic-codex','/srv/two/drop-me')]);
 for(const [filters,want] of [[{include:['keep-me']},1],[{exclude:['drop-me']},1],[{include:['missing']},0]]){const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,agentGrouping:'project',...filters}}},{now:()=>NOW});const engine=createEngine({adapter:runtime.definition,now:()=>NOW});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);assert.equal(engine.agents().length,want);assert.equal(engine.sessions().length,want);assert.ok(!engine.sessions().some(row=>row.cwd));}
});

test('Codex project prefilter and full reader agree on a resumed thread current cwd',async t=>{
 const h=fixture(t),prompt='synthetic prompt '.repeat(400),p=h.file('2026/10/10','rollout-synthetic-resumed.jsonl',[meta('/srv/old/old-project'),ctx('gpt-synthetic-codex','/srv/old/old-project'),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}},ctx('gpt-synthetic-codex','/srv/current/new-project')]);
 assert.ok(fs.statSync(p).size>5*1024,'fixture puts current cwd after a prompt larger than the old 4 KB hint');
 for(const filters of [{include:['new-project']},{exclude:['old-project']}]){
  const files=createFiles({home:h.home,...filters});t.after(()=>files.close());
  const rows=await files.filterRows(await files.scan());assert.equal(rows.length,1,`current project passes ${JSON.stringify(filters)}`);
  await files.read(rows[0].key);assert.equal(rows[0].projectName,'new-project','filter and full reader use the same latest bounded turn_context');
 }
});

test('Codex filter makes bounded progress across a 1 MiB rollout over three rotated cycles',async t=>{
 const h=fixture(t),base=Date.now()-100000;const paths=[];
 for(let i=0;i<9;i++){
  const project=i===8?'keep-me':`large-drop-${i}`;
  const rows=[meta(`/synthetic/old-${i}`),ctx('gpt-synthetic-codex',`/synthetic/old-${i}`),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(1024*1024)}]}},ctx('gpt-synthetic-codex',`/synthetic/${project}`)];
  const file=h.file('2026/10/10',`rollout-synthetic-large-${i}.jsonl`,rows);assert.ok(fs.statSync(file).size>1024*1024);fs.utimesSync(file,new Date(base+1000+(8-i)*1000),new Date(base+1000+(8-i)*1000));paths.push(file);
 }
 const files=createFiles({home:h.home,include:['keep-me']});t.after(()=>files.close());
 for(let cycle=0;cycle<3;cycle++){
  const filtered=await files.filterRows(await files.scan());
  assert.ok(files.stats.filterBytes<=MAX_FILTER_BYTES,`cycle ${cycle+1} reservations stay under the aggregate cap`);
  if(cycle<2)assert.equal(filtered.capacityLimited,true,`cycle ${cycle+1} truthfully reports pending metadata`);
  else {assert.equal(filtered.capacityLimited,false);assert.equal(filtered.length,1);await files.read(filtered[0].key);assert.equal(files.rows()[0].projectName,'keep-me');}
 }
});

test('Codex filter reserves against the opened size after a file grows beyond its scan snapshot',async t=>{
 const h=fixture(t),file=h.file('2026/10/10','rollout-synthetic-growth.jsonl',[meta('/synthetic/old')]);
 const files=createFiles({home:h.home,include:['grown-project']});t.after(()=>files.close());const scanned=await files.scan();
 fs.appendFileSync(file,[ctx('gpt-synthetic-codex','/synthetic/old'),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(1024*1024)}]}},ctx('gpt-synthetic-codex','/synthetic/grown-project')].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const filtered=await files.filterRows(scanned);assert.ok(files.stats.filterBytes<=MAX_FILTER_BYTES);assert.equal(filtered.length,1);await files.read(filtered[0].key);assert.equal(files.rows()[0].projectName,'grown-project');
});

test('Codex filter charges a reserved sample when a bounded metadata read fails',async t=>{
 const h=fixture(t),file=h.file('2026/10/10','rollout-synthetic-read-failure.jsonl',[meta('/synthetic/old'),ctx('gpt-synthetic-codex','/synthetic/old'),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(1024*1024)}]}},ctx('gpt-synthetic-codex','/synthetic/new')]);
 const files=createFiles({home:h.home,include:['new']});t.after(()=>files.close());const rows=await files.scan(),originalOpen=fs.promises.open;let calls=0;
 fs.promises.open=async function(target,...args){const handle=await originalOpen.call(this,target,...args);if(String(target).endsWith('rollout-synthetic-read-failure.jsonl'))return {stat:(...a)=>handle.stat(...a),close:(...a)=>handle.close(...a),read:(...a)=>{calls++;return calls===1?handle.read(...a):Promise.reject(Error('synthetic read race'));}};return handle;};
 try{const filtered=await files.filterRows(rows);assert.equal(filtered.length,0);assert.equal(filtered.capacityLimited,true);assert.ok(files.stats.filterBytes>0,'the failed sample consumes its reservation');assert.ok(files.stats.filterBytes<=MAX_FILTER_BYTES);}finally{fs.promises.open=originalOpen;}
});

test('Codex Settings probe and discovery compare filter entries exactly',async t=>{
 const h=fixture(t);h.file('2026/10/09','rollout-synthetic-a.jsonl',[meta('/srv/one/keep-me'),ctx('gpt-synthetic-codex','/srv/one/keep-me')]);h.file('2026/10/10','rollout-synthetic-b.jsonl',[meta('/srv/two/drop-me'),ctx('gpt-synthetic-codex','/srv/two/drop-me')]);
 const probeInclude=await A.setup.settings.probe({runtime:{home:h.home,include:['keep'],exclude:[],agentGrouping:'project'}});
 assert.equal(probeInclude.projectCount,0,'an include prefix is not an exact project name');
 const probeIncludedByPrefix=await A.setup.settings.probe({runtime:{home:h.home,include:['keep-me-extra'],exclude:[],agentGrouping:'project'}});
 assert.equal(probeIncludedByPrefix.projectCount,0,'a project name contained in an include entry is not an exact match');
 const probeExclude=await A.setup.settings.probe({runtime:{home:h.home,include:[],exclude:['drop'],agentGrouping:'project'}});
 assert.equal(probeExclude.projectCount,2,'an exclude prefix does not remove a different project name');
 const probeExcludedByPrefix=await A.setup.settings.probe({runtime:{home:h.home,include:[],exclude:['drop-me-extra'],agentGrouping:'project'}});
 assert.equal(probeExcludedByPrefix.projectCount,2,'a project name contained in an exclude entry remains included');
 assert.deepEqual((await A.setup.discover({runtime:{home:h.home,include:['keep'],exclude:[],agentGrouping:'project'}})),[]);
 assert.deepEqual((await A.setup.discover({runtime:{home:h.home,include:['keep-me-extra'],exclude:[],agentGrouping:'project'}})),[]);
 assert.equal((await A.setup.discover({runtime:{home:h.home,include:['keep-me'],exclude:[],agentGrouping:'project'}})).length,1);
 assert.equal((await A.setup.discover({runtime:{home:h.home,include:[],exclude:['drop-me-extra'],agentGrouping:'project'}})).length,1);
});

test('Codex prefilters project basenames before the newest-session load window',async t=>{
 const h=fixture(t);const base=Date.now()-100000,rollouts=[];const keep=h.file('2026/10/09','rollout-synthetic-keep.jsonl',[meta('/srv/one/keep-me'),ctx('gpt-synthetic-codex','/srv/one/keep-me')]);fs.utimesSync(keep,new Date(base),new Date(base));
 for(let i=0;i<34;i++){const project=`/srv/drop/project-${i}`,p=h.file('2026/10/10',`rollout-synthetic-drop-${i}.jsonl`,[meta(project),ctx('gpt-synthetic-codex',project)]);fs.utimesSync(p,new Date(base+1000+(69-i)*1000),new Date(base+1000+(69-i)*1000));rollouts.push(p);}
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,include:['keep-me'],agentGrouping:'project'}}});const engine=createEngine({adapter:runtime.definition});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);assert.equal(engine.agents().length,1);assert.equal(engine.sessions().length,1);
});

test('Codex hint preflight has an aggregate byte budget and fails closed until later cycles',async t=>{
 const h=fixture(t),base=Date.now()-100000;
 const rollouts=[];for(let i=0;i<70;i++){const project=i===69?'keep-me':`drop-${i}`;const row={...meta(`/synthetic/${project}`,{padding:'x'.repeat(3700)}),payload:{...meta(`/synthetic/${project}`).payload,padding:'x'.repeat(3700)}};const p=h.file('2026/10/10',`rollout-synthetic-budget-${i}.jsonl`,[row,ctx('gpt-synthetic-codex',`/synthetic/${project}`)]);fs.utimesSync(p,new Date(base+1000+(69-i)*1000),new Date(base+1000+(69-i)*1000));rollouts.push(p);}
 const files=createFiles({home:h.home,include:['keep-me']});t.after(()=>files.close());const scanned=await files.scan();const first=await files.filterRows(scanned);assert.equal(first.capacityLimited,true);assert.ok(files.stats.filterBytes<=MAX_FILTER_BYTES);assert.equal(first.some(r=>r.hintedProject==='keep-me'),false);
 const later=await files.filterRows(await files.scan());assert.equal(later.capacityLimited,false);assert.equal(later.some(r=>r.hintedProject==='keep-me'),true);for(const p of rollouts.slice(0,69))fs.appendFileSync(p,'\n');const changed=await files.filterRows(await files.scan());assert.equal(changed.capacityLimited,true);assert.ok(files.stats.filterBytes<=MAX_FILTER_BYTES);assert.equal(changed.some(r=>r.hintedProject==='keep-me'),true,'stable matching hints survive a later-file budget refresh');
 const probe=await A.setup.settings.probe({runtime:{home:h.home,include:['keep-me']}});assert.equal(probe.status,'capacity-limited','probe reports incomplete filtering within its aggregate hint budget');
});

test('Codex scan/read bounds, unknown-line tolerance and symlink refusal',async t=>{
 const h=fixture(t),p=h.file('2026/10/10','rollout-synthetic-1.jsonl',[meta(),ctx(),{type:'future_synthetic_event',payload:{privateValue:'SYNTHETIC_SENTINEL'}}]);const files=createFiles({home:h.home,agentGrouping:'project'});t.after(()=>files.close());const rows=await files.scan();await files.read(rows[0].key);assert.ok(files.stats.unknownLineTypes>0);assert.equal(JSON.stringify(files.stats).includes('SYNTHETIC_SENTINEL'),false);assert.equal(MAX_READ,256*1024);
 const linked=path.join(h.home,'sessions','2026','10','11');fs.symlinkSync(path.dirname(p),linked);const after=await files.scan();assert.equal(after.length,1,'a symlink date directory is ignored, never followed');
});

test('Codex scan bounds ignored entries at root and intermediate levels',async t=>{
 for(const level of ['root','year']){
  const h=fixture(t),dir=level==='root'?path.join(h.home,'sessions'):path.join(h.home,'sessions','2026');fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<5000;i++)fs.writeFileSync(path.join(dir,`ignored-${i}.txt`),'');
  const files=createFiles({home:h.home});t.after(()=>files.close());
  await files.scan();assert.equal(files.stats.entries,MAX_ENTRIES,`${level} traversal stops at the shared entry budget`);assert.equal(files.stats.truncated,true,`${level} overflow is reported as capacity limited`);
 }
});

test('truncated Codex traversal reports live and Settings capacity as limited',async t=>{
 const h=fixture(t),root=path.join(h.home,'sessions');fs.mkdirSync(root,{recursive:true});
 for(let i=0;i<MAX_ENTRIES+20;i++)fs.writeFileSync(path.join(root,`ignored-${String(i).padStart(5,'0')}.txt`),'');
 const probe=await A.setup.settings.probe({runtime:{home:h.home}});assert.equal(probe.status,'capacity-limited');
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home}}}),engine=createEngine({adapter:runtime.definition});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const capacity=engine.sources().find(source=>source.id==='capacity');assert.deepEqual({state:capacity.state,reason:capacity.lastError},{state:'down',reason:'capacity-limited'});
 assert.equal(runtime.files.stats.truncated,true);assert.equal(engine.health().sources.find(source=>source.id==='capacity').state,'down');
});

test('Codex Settings probe and registry expose a real configurable connector with private reason codes',async t=>{
 assert.equal(A.definition.mark.logo,'assets/connectors/codex.svg');assert.equal(A.definition.mark.providerName,'Codex');assert.equal(A.setup.capabilities.brand.logoDark,'assets/connectors/codex-dark.svg');
 const h=fixture(t),home=path.join(h.home,'.codex');const rollout=path.join(home,'sessions','2026','10','10','rollout-synthetic-probe.jsonl');fs.mkdirSync(path.dirname(rollout),{recursive:true});fs.writeFileSync(rollout,[meta(),ctx(),message('user','Synthetic probe','p1')].map(x=>JSON.stringify(x)).join('\n')+'\n');
 assert.ok(ADAPTER_IDS.includes('codex'));assert.equal(adapterById('codex').setup.fields.includes('home'),true);const resolved=A.setup.settings.resolve({home,include:'workspace-a',exclude:'workspace-b',agentGrouping:'project'});assert.deepEqual(A.setup.config(resolved),{adapter:'codex',codex:{home,include:['workspace-a'],exclude:['workspace-b'],agentGrouping:'project'}});assert.equal(schema.validate(A.setup.configSchema,A.setup.config(resolved)).ok,true);const found=await A.setup.settings.probe({runtime:{home}});assert.equal(found.status,'connected');assert.equal(found.projectCount,1);assert.equal(found.fileCount,1);
 const empty=await A.setup.settings.probe({runtime:{home:path.join(h.home,'missing')}});assert.equal(empty.status,'not-configured');assert.equal(JSON.stringify(empty).includes(h.home),false);
});

test('engine runtime mark keeps the Codex dark logo for Journaux and every consumer',()=>{
 const mark=createEngine({adapter:A.definition}).runtime().mark;
 assert.deepEqual({logo:mark.logo,logoDark:mark.logoDark},{logo:'assets/connectors/codex.svg',logoDark:'assets/connectors/codex-dark.svg'});
});
