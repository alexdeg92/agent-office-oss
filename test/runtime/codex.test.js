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
 const board=await h.get('/api/v3/views/projects');assert.equal(board.status,200,board.text);const card=board.json.data.columns.flatMap(row=>row.cards).find(row=>row.name==='agent-office');assert.ok(card,'a workspace project is contributed from Codex sessions');assert.equal(card.capabilities.write,false);assert.equal(card.sourceDescriptors[0].runtime,'codex');
 const detail=await h.get('/api/v3/views/projects/'+encodeURIComponent(card.id));assert.equal(detail.status,200,detail.text);assert.equal(detail.json.data.counts.sessions,1);assert.equal(detail.json.data.counts.agents,1);assert.equal(detail.json.data.capabilities.history,'unsupported');assert.equal(JSON.stringify(detail.json.data).includes('/synthetic/private/agent-office'),false);
 const legacyBoard=await h.get('/api/v2/views/projects');assert.equal(legacyBoard.status,200,legacyBoard.text);assert.equal(legacyBoard.json.data.columns.flatMap(row=>row.cards).some(row=>row.id===card.id),false,'legacy v2 does not publish runtime source cards');assert.equal(legacyBoard.json.data.sourceFilters.some(row=>row.source.kind==='runtime'),false);
 const legacyDetail=await h.get('/api/v2/views/projects/'+encodeURIComponent(card.id));assert.equal(legacyDetail.status,404,'legacy v2 detail treats runtime projects as absent');
 const selected3=await h.get('/api/v3/views/projects?source='+encodeURIComponent(card.sourceDescriptors[0].id));assert.equal(selected3.status,200,selected3.text);assert.equal(selected3.json.data.sourceFilterId,card.sourceDescriptors[0].id);assert.equal(selected3.json.data.columns.reduce((n,row)=>n+row.count,0),1);
});

test('legacy environment-owner cookie retains rich Office details before identity migration',async t=>{
 const h=await startServer(loadScenario('synthetic-basic'),{demo:true});t.after(()=>h.stop());
 await h.waitReady();
 const cookieValue=h.cookie.split('=')[1],payload=JSON.parse(Buffer.from(cookieValue.split('.')[0],'base64url').toString('utf8'));
 assert.equal(Object.hasOwn(payload,'userId'),false,'the legacy environment cookie has no account id');
 const logs=await h.get('/api/v3/views/logs');assert.equal(logs.status,200);assert.ok(logs.json.data.items.length>0);
 for(const version of [2,3]) {
  const office=await h.get(`/api/v${version}/views/office`);assert.equal(office.status,200,office.text);
  const primary=office.json.data.occupants.find(row=>row.role===(version===2?'main':'primary'));
  assert.ok(primary?.sessionKey,`v${version} keeps the legacy owner's primary session identity`);
  assert.equal(primary.execution.evidence.level,'verified',`v${version} keeps verified execution for the authenticated owner`);
  assert.ok(office.json.data.occupants.length>1,`v${version} keeps the owner environment's full office projection`);
 }
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
 assert.equal(engine.agents().length,1);assert.equal(engine.agents()[0].name,'agent-office');assert.equal(engine.sessions().length,2);assert.deepEqual(engine.sessions().map(session=>session.usage.total).sort((a,b)=>a-b),[15,29]);assert.ok(engine.sessions().every(session=>session.tokensKnown===true),'session-local Codex totals are known when the rollout includes token_count');assert.ok(engine.sessions().every(session=>session.run.status==='idle'&&session.run.evidenceLevel==='observed'),'completed assistant turns supply observed idle evidence');assert.ok(engine.sessions().every(session=>session.projectRef==='project:'+require('node:crypto').createHash('sha256').update('/synthetic/private/agent-office').digest('hex')&&session.projectLabel==='agent-office'),'canonical sessions carry only opaque workspace identity and safe label');assert.ok(engine.sessions().every(session=>session.cwd===null),'raw working directories remain private');assert.equal(engine.transcript(engine.sessions()[0].key).messageCount,2);
});

test('Codex reads appended rollout bytes incrementally while retaining exchanges across chunks', async t => {
 const h=fixture(t),file=h.file('2026/10/10','rollout-incremental.jsonl',[meta(),ctx(),message('user','Synthetic first exchange','first-user'),message('assistant','Synthetic first answer','first-assistant')]);
 const files=createFiles({home:h.home,now:()=>NOW,agentGrouping:'project'});t.after(()=>files.close());
 const rows=await files.scan(),key=rows[0].key;let trace=await files.read(key);
 assert.deepEqual(trace.events.map(event=>event.text),['Synthetic first exchange','Synthetic first answer']);
 const appended=[];
 for(let n=0;n<10;n++){
  appended.push(message('user',`Synthetic appended question ${n} `+'x'.repeat(30*1024),`append-user-${n}`));
  appended.push(message('assistant',`Synthetic appended answer ${n}`,`append-assistant-${n}`));
 }
 fs.appendFileSync(file,appended.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const size=fs.statSync(file).size;await files.scan();
 for(let attempt=0;attempt<8 && (files.rows().find(row=>row.key===key)?.loadedSize||0)<size;attempt++) trace=await files.read(key);
 assert.equal(files.rows().find(row=>row.key===key).loadedSize,size,'bounded forward reads eventually consume the appended file');
 assert.equal(trace.events.length,22,'all exchanges remain within the canonical event cap');
 for(let n=0;n<10;n++){
  assert.ok(trace.events.some(event=>event.text===`Synthetic appended answer ${n}`),`appended answer ${n} remains in the accumulated transcript`);
 }
 assert.ok(trace.events.some(event=>event.text==='Synthetic first exchange'),'the original history is retained after incremental reads');
});

test('Codex workspace without a safe basename has no synthetic hash project title', async t => {
 const h=fixture(t);h.file('2026/10/10','rollout-synthetic-root.jsonl',[meta('/'),ctx('gpt-synthetic-codex','/'),message('user','Synthetic root workspace prompt','u-root')]);
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,include:[],exclude:[],agentGrouping:'project'}}},{now:()=>NOW});const engine=createEngine({adapter:runtime.definition});t.after(()=>runtime.close());runtime.attach(engine);
 await startAndWait(runtime,engine);
 assert.equal(engine.sessions().length,1,'the transcript remains available');
 assert.equal(engine.sessions()[0].projectLabel,null,'the adapter does not turn an opaque cwd hash into a project label');
 assert.equal(engine.agents()[0].name,'Codex project','canonical agent display uses a stable neutral fallback');
 assert.equal(runtime.files.rows().length,1,'the session remains available even though it has no safe project label');
 const projects=require('../../src/projects/runtime-sources').collectRuntimeProjects({sessions:engine.sessions(),agents:engine.agents(),
  connectorOf:()=>({id:'codex',adapter:'codex',name:'Codex',projectSource:A.definition.projectSource}),idKey:'synthetic-id-key-with-more-than-32-characters'});
 assert.deepEqual(projects.projects,[],'no synthetic project card is created');
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

test('Codex transcript activity maps safe event classes and keeps evidence private and fresh',async t=>{
 const {parse}=require('../../src/adapters/codex/profile');
 const event=(type,payload={})=>({type:'event_msg',timestamp:new Date(NOW-1000).toISOString(),payload:{type,...payload}});
 const call=(name,type='function_call')=>({type:'response_item',timestamp:new Date(NOW-1000).toISOString(),payload:{type,call_id:'synthetic-call',name,arguments:{path:'/private/synthetic-secret'},output:'/private/synthetic-secret'}});
 const cases=[
  [event('agent_reasoning'),'thinking'],[call('web_search'),'researching'],[call('apply_patch','custom_tool_call'),'writing'],
  [call('exec_command'),'executing'],[event('request_user_input'),'waiting'],[event('exec_approval_request'),'blocked'],
 ];
 for(const [line,kind] of cases){
   const parsed=parse([meta(),ctx(),line],{sessionKey:'codex:synthetic',agentId:'synthetic',now:()=>NOW});
   assert.equal(parsed.activity?.kind,kind);
   assert.deepEqual(Object.keys(parsed.activity).sort(),['expiresAt','kind','since']);
   assert.equal(JSON.stringify(parsed.activity).includes('/private'),false);
 }
 const stale=parse([meta(),ctx(),event('task_started'),event('agent_reasoning')],{sessionKey:'codex:stale',agentId:'synthetic',now:()=>NOW+20_000});
 assert.equal(stale.activity,null,'rich detail expires independently from the 30s running evidence');
 assert.equal(runFromTranscript(stale.execution,NOW+20_000).status,'running','stale rich detail degrades to generic Working');

 let clock=NOW;const h=fixture(t),at=new Date(NOW-1000).toISOString();
 h.file('2026/10/10','rollout-live.jsonl',[meta(),ctx(),{type:'event_msg',timestamp:at,payload:{type:'agent_reasoning'}}]);
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,agentGrouping:'project'}}},{now:()=>clock}),engine=createEngine({adapter:runtime.definition,now:()=>clock});
 t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const session=engine.sessions()[0];assert.equal(engine.activity(session.key)?.kind,'thinking');
 for(const version of [2,3]){
  const vm=buildOfficeVM({engine,canReadSessions:true,now:clock,tracker:createStateTracker(),actorOf:()=>({kind:'system',name:'System'}),P:version===3?project3x:undefined});
  assert.ok(vm.occupants.some(row=>row.state==='thinking'),`v${version} projects adapter-derived thinking`);
  const {VM_SCHEMAS,VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas');
  assert.equal(require('../../src/schema').validate((version===3?VM_SCHEMAS_V3:VM_SCHEMAS).office,vm).ok,true,`v${version} schema-valid`);
 }
 clock+=11_000;engine.expireObservedActivity();assert.equal(engine.activity(session.key)?.kind,'working','stale detail degrades to the still-live run state');
 clock+=20_000;engine.expireObservedActivity();assert.equal(engine.activity(session.key),null,'the separate running evidence lease eventually expires too');
});

test('Codex yields with a pending execution as bounded waiting, then clears it on completion', () => {
 const {parse}=require('../../src/adapters/codex/profile');
 const event=(type,payload={})=>({type:'event_msg',timestamp:new Date(NOW-1000).toISOString(),payload:{type,...payload}});
 const answer={type:'response_item',timestamp:new Date(NOW-900).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic yielded response PRIVATE_AWAIT_CANARY'}]}};
 const lines=[meta(),ctx(),event('exec_command_begin',{command_id:'single-exec'}),answer];
 const pending=parse(lines,{sessionKey:'codex:pending',agentId:'synthetic',now:()=>NOW});
 assert.equal(pending.activity?.kind,'waiting','an assistant turn yielded while an exec is still open');
 assert.equal(pending.execution.status,'idle','the model turn ended even though its background execution remains pending');
 assert.equal(JSON.stringify(pending.activity).includes('PRIVATE_AWAIT_CANARY'),false);
 const finished=parse([...lines,event('exec_command_end',{command_id:'single-exec'})],{sessionKey:'codex:pending',agentId:'synthetic',now:()=>NOW});
 assert.equal(finished.activity,null,'the matching execution completion clears pending wait');
 assert.equal(finished.execution.status,'idle');
});

test('Codex preserves reply waits through task completion and tracks concurrent exec ids independently', () => {
 const {parse}=require('../../src/adapters/codex/profile');
 const event=(type,payload={})=>({type:'event_msg',timestamp:new Date(NOW-1000).toISOString(),payload:{type,...payload}});
 const message=(role,text)=>({type:'response_item',timestamp:new Date(NOW-900).toISOString(),payload:{type:'message',role,status:'completed',content:[{type:role==='user'?'input_text':'output_text',text}]}});
 const asked=parse([meta(),ctx(),message('assistant','Could you confirm?'),event('task_complete')],{sessionKey:'codex:asked',agentId:'synthetic',now:()=>NOW});
 assert.equal(asked.activity?.kind,'waiting','task completion does not erase an unanswered question');
 const answered=parse([meta(),ctx(),message('assistant','Could you confirm?'),event('task_complete'),message('user','Yes')],{sessionKey:'codex:asked',agentId:'synthetic',now:()=>NOW});
 assert.equal(answered.activity?.kind,'working','a subsequent user turn clears the waiting question');
 const commandEnded=parse([meta(),ctx(),event('exec_command_begin',{command_id:'question-followup'}),message('assistant','Could you confirm?'),event('task_complete'),event('exec_command_end',{command_id:'question-followup'})],{sessionKey:'codex:asked',agentId:'synthetic',now:()=>NOW});
 assert.equal(commandEnded.activity?.kind,'waiting','command completion cannot erase the final unanswered reply wait');
 const both=[meta(),ctx(),event('exec_command_begin',{command_id:'exec-a'}),event('exec_command_begin',{command_id:'exec-b'}),message('assistant','Background work continues')];
 const oneDone=parse([...both,event('exec_command_end',{command_id:'exec-a'})],{sessionKey:'codex:parallel',agentId:'synthetic',now:()=>NOW});
 assert.equal(oneDone.activity?.kind,'waiting','one completed command cannot clear another pending command');
 const allDone=parse([...both,event('exec_command_end',{command_id:'exec-a'}),event('exec_command_end',{command_id:'exec-b'})],{sessionKey:'codex:parallel',agentId:'synthetic',now:()=>NOW});
 assert.equal(allDone.activity,null,'all command completions clear the pending wait');
 const duplicateAndUnknown=parse([...both,event('exec_command_end',{command_id:'exec-a'}),event('exec_command_end',{command_id:'exec-a'}),event('exec_command_end',{command_id:'exec-x'})],{sessionKey:'codex:parallel',agentId:'synthetic',now:()=>NOW});
 assert.equal(duplicateAndUnknown.activity?.kind,'waiting','duplicate and unknown completion ids cannot retire sibling B');
 const foreground=[event('task_started'),event('exec_command_begin',{command_id:'foreground'}),event('exec_command_end',{command_id:'foreground'})];
 const commandOnly=parse(foreground,{sessionKey:'codex:foreground',agentId:'synthetic',now:()=>NOW});
 assert.equal(commandOnly.execution.status,'running','a command end does not end its enclosing model turn');
 assert.ok(commandOnly.activity,'the still-open turn keeps current activity');
 const turnEnded=parse([...foreground,event('task_complete')],{sessionKey:'codex:foreground',agentId:'synthetic',now:()=>NOW});
 assert.equal(turnEnded.execution.status,'idle','the actual task completion ends the turn');
 assert.equal(turnEnded.activity,null);
});

test('Codex late unrelated completions cannot renew an expired reply wait',()=>{
 const {parse}=require('../../src/adapters/codex/profile'),t0=NOW-1000,tLate=t0+20*60_000;
 const line=(type,payload={},at=t0)=>({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type,...payload}});
 const question={type:'response_item',timestamp:new Date(t0).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Can you confirm?'}]}};
 const expired=parse([meta(),ctx(),question,line('task_complete',{},tLate),line('task_complete',{},tLate+1000)],{sessionKey:'codex:old-question',agentId:'synthetic',now:()=>tLate+1000});
 assert.equal(expired.activity,null,'unrelated completions do not restart the 15-minute question lease');
 const freshQuestion={...question,timestamp:new Date(tLate+2000).toISOString()};
 const fresh=parse([meta(),ctx(),freshQuestion,line('task_complete',{},tLate+3000)],{sessionKey:'codex:new-question',agentId:'synthetic',now:()=>tLate+3000});
 assert.equal(fresh.activity?.kind,'waiting','a new final question starts its own bounded lease');
 const answered=parse([meta(),ctx(),freshQuestion,{type:'response_item',timestamp:new Date(tLate+4000).toISOString(),payload:{type:'message',role:'user',status:'completed',content:[{type:'input_text',text:'Yes'}]}}],{sessionKey:'codex:answered-question',agentId:'synthetic',now:()=>tLate+4000});
 assert.equal(answered.activity?.kind,'working','an actual user reply clears the prior question wait');
});

test('Codex lifecycle state survives long completed histories and display-event truncation',()=>{
 const {parse}=require('../../src/adapters/codex/profile');
 const completed=Array.from({length:300},(_,i)=>({type:'response_item',timestamp:new Date(NOW-1000+i).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:`Completed ${i}`} ]}}));
 const oldHistory=parse([meta(),ctx(),...completed],{sessionKey:'codex:long-completed',agentId:'synthetic',now:()=>NOW});
 assert.equal(oldHistory.activity,null,'a long completed history alone is not a pending execution');
 const handoff={type:'response_item',timestamp:new Date(NOW-1).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'I will continue after the command.'}]}};
 const pending=parse([meta(),ctx(),{type:'event_msg',timestamp:new Date(NOW-2).toISOString(),payload:{type:'exec_command_begin',command_id:'still-open'}},handoff,...completed],
   {sessionKey:'codex:long-pending',agentId:'synthetic',now:()=>NOW});
 assert.equal(pending.activity?.kind,'waiting','the retained unresolved command remains represented');
 assert.equal(pending.execution.status,'idle','the model handoff is complete while the command remains pending');
 const ids=Array.from({length:65},(_,i)=>`background-${i}`);
 const manyBegins=ids.map((command_id,i)=>({type:'event_msg',timestamp:new Date(NOW-2000+i).toISOString(),payload:{type:'exec_command_begin',command_id}}));
 const later=Array.from({length:300},(_,i)=>({type:'response_item',timestamp:new Date(NOW-1000+i).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:`Later ${i}`} ]}}));
 const completions=ids.slice(0,64).map((command_id,i)=>({type:'event_msg',timestamp:new Date(NOW+i).toISOString(),payload:{type:'exec_command_end',command_id}}));
 const overflow=parse([meta(),ctx(),...manyBegins,handoff,...later,...completions],{sessionKey:'codex:overflow-after-history-window',agentId:'synthetic',now:()=>NOW+1000});
 assert.equal(overflow.activity?.kind,'waiting','the 65th live command survives both the event-history window and completion of the 64 tracked ids');
});

test('Codex incremental reads consume lifecycle records beyond the first bounded chunk',async t=>{
 const h=fixture(t);
 const filler=Array.from({length:700},(_,i)=>({type:'response_item',timestamp:new Date(NOW-10000+i).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:`Completed sample ${i} ${'x'.repeat(320)}`} ]}}));
 const event=(type,command_id)=>({type:'event_msg',timestamp:new Date(NOW).toISOString(),payload:{type,...(command_id===undefined?{}:{command_id})}});
 const handoff={type:'response_item',timestamp:new Date(NOW-1).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic handoff'}]}};
 const question={type:'response_item',timestamp:new Date(NOW-2).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Can you confirm?'}]}};
 const toolStart={type:'response_item',timestamp:new Date(NOW-3).toISOString(),payload:{type:'function_call',call_id:'tool-head',name:'exec_command'}};
 const toolEnd={type:'response_item',timestamp:new Date(NOW).toISOString(),payload:{type:'function_call_output',call_id:'tool-head',output:'ok'}};
 // Put any `item.middle` record after 150 full-length rows (beyond the 64 KiB
 // head) but leave more than the 192 KiB tail after it. This keeps the record
 // inside the omitted byte interval rather than accidentally sampling it.
 const gapPrefix=filler.slice(0,150),gapSuffix=filler.slice(150);
 const cases=[
  {name:'observed command start followed by handoff',head:[],middle:[event('exec_command_begin','hidden-in-gap')],tail:[handoff],activityKind:'waiting',execution:'idle'},
  {name:'command starts after an earlier task boundary',head:[event('task_complete')],middle:[event('exec_command_begin','hidden-after-head')],tail:[handoff],activityKind:'waiting',execution:'idle'},
  {name:'observed background exec remains pending across a task boundary',head:[],middle:[event('exec_command_begin','unseen-background')],tail:[event('task_complete')],activityKind:'waiting',execution:'idle'},
  {name:'head question answered in order',head:[question],middle:[{type:'response_item',timestamp:new Date(NOW-1).toISOString(),payload:{type:'message',role:'user',status:'completed',content:[{type:'input_text',text:'Yes'}]}}],tail:[handoff],activity:null,execution:'idle'},
  {name:'tail execution replaces head reply wait',head:[question],middle:[{type:'response_item',timestamp:new Date(NOW-1).toISOString(),payload:{type:'message',role:'user',status:'completed',content:[{type:'input_text',text:'Yes'}]}}],tail:[event('exec_command_begin','tail-command')],activityKind:'executing',activitySince:NOW,execution:'running'},
  {name:'head foreground turn reset',head:[event('task_started')],middle:[event('task_complete')],tail:[handoff],activity:null,execution:'idle'},
  {name:'unresolved exact command',head:[event('exec_command_begin','head-open'),handoff],middle:[],tail:[event('exec_command_end','different-id')],activityKind:'waiting',execution:'idle'},
  {name:'exact command completed in tail',head:[event('exec_command_begin','head-closed'),handoff],middle:[],tail:[event('exec_command_end','head-closed'),handoff],activity:null,execution:'idle'},
  {name:'closed head ID reused by a tail command',head:[event('exec_command_begin','reused-id')],middle:[],tail:[event('exec_command_end','reused-id'),event('exec_command_begin','reused-id')],activityKind:'executing',activitySince:NOW,execution:'running'},
  {name:'unresolved exact tool',head:[toolStart],middle:[],tail:[handoff],activityKind:'waiting',execution:'idle'},
  {name:'exact tool completed in tail',head:[toolStart],middle:[],tail:[toolEnd,handoff],activity:null,execution:'idle'},
  {name:'tail task completion closes sequential head tools',head:[toolStart],middle:[],tail:[event('task_complete')],activity:null,execution:'idle'},
  {name:'bounded command tracking overflow remains conservatively waiting',head:Array.from({length:65},(_,i)=>event('exec_command_begin',`head-${i}`)),middle:[],tail:[handoff],activityKind:'waiting',execution:'idle'},
  {name:'anonymous command obligation stays pending through handoff',head:[event('exec_command_begin')],middle:[],tail:[handoff],activityKind:'waiting',execution:'idle'},
 ];
 const filesToRead=[];
 for(const [index,item] of cases.entries()) {
  const filename=h.file('2026/10/10',`rollout-gap-case-${index}.jsonl`,[meta(),ctx(),...item.head,...gapPrefix,...item.middle,...gapSuffix,...item.tail]);
  assert.ok(fs.statSync(filename).size>require('../../src/adapters/codex/files').MAX_READ,`${item.name} fixture crosses the adapter byte-sampling boundary`);
  if(item.middle.length) {
   const prefixBytes=Buffer.byteLength([meta(),ctx(),...item.head,...gapPrefix].map(row=>JSON.stringify(row)).join('\n')+'\n');
   const gapEnd=fs.statSync(filename).size-(MAX_READ-64*1024);
   assert.ok(prefixBytes>64*1024&&prefixBytes<gapEnd,`${item.name} fixture event is inside the omitted byte interval`);
  }
  filesToRead.push({item,filename});
 }
 const files=createFiles({home:h.home,now:()=>NOW}),rows=await files.scan();t.after(()=>files.close());
 const read=async filename=>{const row=rows.find(item=>item.filename===filename);assert.ok(row);for(let n=0;n<8&&(row.loadedSize||0)<row.size;n++)await files.read(row.key);assert.equal(row.loadedSize,row.size,`bounded reads consume ${path.basename(filename)}`);return row;};
 for(const {item,filename} of filesToRead) {
  const row=await read(filename);
  if(item.activityKind) {assert.equal(row.activity?.kind,item.activityKind,`${item.name}: current lifecycle records determine activity`);if(item.activitySince!==undefined)assert.equal(row.activity?.since,item.activitySince,`${item.name}: activity time comes from the record`);}
  else assert.equal(row.activity,item.activity,`${item.name}: current lifecycle records determine activity`);
  assert.equal(row.execution?.status,item.execution,`${item.name}: execution follows the complete ordered stream`);
 }
});

test('Codex incremental append observes lifecycle records rather than treating them as an omitted gap',async t=>{
 let clock=Date.now();const h=fixture(t),filename=h.file('2026/10/10','rollout-append-gap.jsonl',[
  meta(),ctx(),{type:'event_msg',timestamp:new Date(clock-1000).toISOString(),payload:{type:'task_started'}},
 ]);
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,agentGrouping:'project'}}},{now:()=>clock});
 const engine=createEngine({adapter:runtime.definition,now:()=>clock});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const session=engine.sessions()[0];assert.equal(engine.activity(session.key)?.kind,'working','the baseline starts with observed activity');
 const filler=Array.from({length:700},(_,i)=>({type:'response_item',timestamp:new Date(clock+i).toISOString(),payload:{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:`Synthetic completed record ${i} ${'x'.repeat(320)}`} ]}}));
 const hiddenStart={type:'event_msg',timestamp:new Date(clock+200).toISOString(),payload:{type:'exec_command_begin',command_id:'hidden-after-append'}};
 const prefix=filler.slice(0,150),suffix=filler.slice(150);
 fs.appendFileSync(filename,[...prefix,hiddenStart,...suffix].map(row=>JSON.stringify(row)).join('\n')+'\n');
 await runtime.files.scan();
 const fileRow=runtime.files.rows().find(row=>row.filename===filename);
 assert.ok(fileRow.size>MAX_READ);
 const eventOffset=Buffer.byteLength([meta(),ctx(),{type:'event_msg',timestamp:new Date(clock-1000).toISOString(),payload:{type:'task_started'}},...prefix].map(row=>JSON.stringify(row)).join('\n')+'\n');
 assert.ok(eventOffset>64*1024&&eventOffset<fileRow.size-(MAX_READ-64*1024),'the appended command start is truly inside the omitted bytes');
 clock+=1;await runtime.cycle();
 assert.equal(engine.activity(session.key),null,'uncertain parser output clears the old observed activity lease');
 assert.equal(engine.session(session.key).run.status,'idle','all appended lifecycle records are consumed in order');
 for(const version of [2,3]) {
  const vm=buildOfficeVM({engine,canReadSessions:true,now:clock,tracker:createStateTracker(),actorOf:()=>({kind:'system',name:'System'}),P:version===3?project3x:undefined});
  const row=vm.occupants.find(occupant=>occupant.sessionKey===session.key);
  assert.ok(!row||row.state!=='working',`v${version} never promotes this unknown sample to Working`);
  if(row)assert.equal(row.execution.evidence.level,'observed');
 }
});

test('Codex runtime and v2/v3 Office preserve correlated siblings, foreground turns, and reply expiry',async t=>{
 let clock=NOW;const h=fixture(t),at=new Date(NOW-1000).toISOString(),late=NOW+20*60_000;
 const event=(type,payload={},when=NOW-1000)=>({type:'event_msg',timestamp:new Date(when).toISOString(),payload:{type,...payload}});
 const msg=(role,text,when=NOW-1000)=>({type:'response_item',timestamp:new Date(when).toISOString(),payload:{type:'message',role,status:'completed',content:[{type:role==='user'?'input_text':'output_text',text}]}});
 const shared=[meta(),ctx(),event('exec_command_begin',{command_id:'runtime-a'}),event('exec_command_begin',{command_id:'runtime-b'}),msg('assistant','Two jobs continue'),
  event('exec_command_end',{command_id:'runtime-a'}),event('exec_command_end',{command_id:'runtime-a'}),event('exec_command_end',{command_id:'runtime-unknown'})];
 // Keep each synthetic conversation in its own project so project aggregation
 // cannot collapse rows and make a session-key assertion select a sibling.
 const project=name=>`/synthetic/private/${name}`;
 h.file('2026/10/10','rollout-parallel.jsonl',[meta(project('parallel')),ctx('gpt-synthetic-codex',project('parallel')),...shared.slice(2)]);
 h.file('2026/10/10','rollout-foreground.jsonl',[meta(project('foreground')),ctx('gpt-synthetic-codex',project('foreground')),event('task_started'),event('exec_command_begin',{command_id:'foreground'}),event('exec_command_end',{command_id:'foreground'})]);
 h.file('2026/10/10','rollout-expired-question.jsonl',[meta(project('expired-question')),ctx('gpt-synthetic-codex',project('expired-question')),msg('assistant','Can you confirm?',NOW-20*60_000),event('task_complete',{},late)]);
 const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,agentGrouping:'project'}}},{now:()=>clock});
 const engine=createEngine({adapter:runtime.definition,now:()=>clock});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const sessionOf=name=>engine.sessions().find(row=>runtime.files.rows().find(item=>item.key===row.key)?.filename.endsWith(name));
 const parallel=sessionOf('rollout-parallel.jsonl'),foreground=sessionOf('rollout-foreground.jsonl'),expired=sessionOf('rollout-expired-question.jsonl');
 assert.equal(engine.activity(parallel.key)?.kind,'waiting','duplicate/unknown completions leave B pending through the actual file reader');
 assert.equal(engine.session(foreground.key).run.status,'running','exec end does not end the live foreground model turn');
 assert.equal(engine.activity(expired.key),null,'an unrelated late completion does not revive the old question');
 for(const version of [2,3]){
  const vm=buildOfficeVM({engine,canReadSessions:true,now:clock,tracker:createStateTracker(),actorOf:()=>({kind:'system',name:'System'}),...(version===3?{P:project3x}:{})});
  assert.equal(vm.occupants.find(row=>row.sessionKey===parallel.key)?.state,'waiting',`v${version} retains the correlated sibling wait`);
  assert.notEqual(vm.occupants.find(row=>row.sessionKey===foreground.key)?.state,'idle',`v${version} keeps an unfinished foreground turn active`);
  assert.notEqual(vm.occupants.find(row=>row.sessionKey===expired.key)?.state,'waiting',`v${version} does not present expired reply evidence`);
 }
 fs.appendFileSync(runtime.files.rows().find(row=>row.filename.endsWith('rollout-parallel.jsonl')).filename,
  JSON.stringify(event('exec_command_end',{command_id:'runtime-b'}))+'\n');
 clock+=1;await runtime.cycle();assert.equal(engine.activity(parallel.key),null,'the exact final sibling completion clears waiting');
 fs.appendFileSync(runtime.files.rows().find(row=>row.filename.endsWith('rollout-foreground.jsonl')).filename,JSON.stringify(event('task_complete'))+'\n');
 await runtime.cycle();assert.equal(engine.session(foreground.key).run.status,'idle','the actual model completion closes the foreground turn');
});

test('Codex pending exec waiting reaches schema-valid v2/v3 OfficeVMs and expires',async t=>{
 const h=fixture(t),at=new Date(NOW-1000).toISOString();
 const answer={type:'response_item',timestamp:at,payload:{type:'message',id:'pending-answer',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic handoff'}]}};
 h.file('2026/10/10','rollout-pending-exec.jsonl',[meta(),ctx(),{type:'event_msg',timestamp:at,payload:{type:'exec_command_begin'}},answer]);
 let clock=NOW;const runtime=A.createRuntime({runtimeConfig:{codex:{home:h.home,agentGrouping:'project'}}},{now:()=>clock});
 const engine=createEngine({adapter:runtime.definition,now:()=>clock});t.after(()=>runtime.close());runtime.attach(engine);await startAndWait(runtime,engine);
 const session=engine.sessions()[0];assert.equal(engine.activity(session.key)?.kind,'waiting');
 for(const version of [2,3]){
  const vm=buildOfficeVM({engine,canReadSessions:true,configuredAgents:{[engine.agents()[0].id]:'Codex agent'},now:clock,tracker:createStateTracker(),actorOf:()=>({kind:'system',name:'System'}),P:version===3?project3x:undefined});
  assert.equal(vm.occupants.find(row=>row.name==='Codex agent')?.state,'waiting',`v${version} waiting projection`);
  const {VM_SCHEMAS,VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas');
  assert.equal(schema.validate((version===3?VM_SCHEMAS_V3:VM_SCHEMAS).office,vm).ok,true,`v${version} schema validation`);
 }
 clock+=15*60_000;engine.expireObservedActivity();assert.equal(engine.activity(session.key),null,'pending activity expires at the bounded freshness limit');
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
