 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Claude=require('../../src/adapters/claude-code'),{createEngine}=require('../../src/engine');
const {createFiles,MAX_READ}=require('../../src/adapters/codex/files');
const NOW=1791600000000;
const meta={type:'session_meta',payload:{id:'synthetic-session',cwd:'/synthetic/workspace',timestamp:new Date(NOW-10000).toISOString()}};
const codexMessage=text=>({type:'response_item',timestamp:new Date(NOW-1000).toISOString(),payload:{type:'message',id:'synthetic-answer',role:'assistant',status:'completed',content:[{type:'output_text',text}]}});
function dir(t,prefix){const d=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function codexFile(home,lines){const file=path.join(home,'sessions','2026','10','10','rollout-synthetic.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,lines.join('\n')+'\n');return file;}
test('critic590 Claude unchanged cold history continues after the first bounded window',async t=>{
 const home=dir(t,'critic590-claude-'),project=path.join(home,'projects','synthetic');fs.mkdirSync(project,{recursive:true});
 const file=path.join(project,'synthetic-session.jsonl');
 const user={type:'user',sessionId:'synthetic-session',uuid:'first',timestamp:new Date(NOW-65000).toISOString(),message:{role:'user',content:'Synthetic initial prompt'}};
 const rows=[user];for(let n=0;n<80;n++)rows.push({type:'attachment',uuid:'meta-'+n,parentUuid:n?'meta-'+(n-1):'first',attachment:{synthetic:'x'.repeat(32768)}});
 rows.push({type:'assistant',sessionId:'synthetic-session',uuid:'last',parentUuid:'meta-79',timestamp:new Date(NOW-60000).toISOString(),message:{role:'assistant',content:[{type:'text',text:'SYNTHETIC_FINAL_ANSWER'}]}});
 fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');fs.utimesSync(file,new Date(NOW-60000),new Date(NOW-60000));
 const engine=createEngine({now:()=>NOW}),runtime=Claude.createRuntime({runtimeConfig:{claudeCode:{home,agentGrouping:'project'}}},{now:()=>NOW});runtime.attach(engine);t.after(()=>runtime.close());
 for(let n=0;n<5;n++)await runtime.cycle();
 const row=runtime.files.rows()[0];console.log('Claude continuation',JSON.stringify({offset:row.offset,size:row.size,bytes:runtime.files.stats.bytes,complete:row.coverageComplete}));
 assert.ok(row.offset>=row.size,'routine cycles must eventually continue a cold unchanged transcript');
 assert.ok(engine.transcript(engine.sessions()[0].key).events.some(e=>e.text==='SYNTHETIC_FINAL_ANSWER'));
});
test('critic590 Codex preserves UTF-8 bytes across a bounded read boundary',async t=>{
 const home=dir(t,'critic590-codex-utf8-'),first=JSON.stringify(meta)+'\n';
 const message=codexMessage('éZ');message.padding='';
 // Place padding before the payload so the multibyte message stays short and visible.
 const render=n=>JSON.stringify({type:message.type,padding:'x'.repeat(n),timestamp:message.timestamp,payload:message.payload});
 const base=render(0),before=first+base.slice(0,base.indexOf('é'));
 const line=render(MAX_READ-1-Buffer.byteLength(before));
 assert.equal(Buffer.byteLength(first+line.slice(0,line.indexOf('é'))),MAX_READ-1);
 codexFile(home,[JSON.stringify(meta),line]);const files=createFiles({home,now:()=>NOW});t.after(()=>files.close());
 const [row]=await files.scan();await files.read(row.key);const trace=await files.read(row.key);
 console.log('Codex UTF8',JSON.stringify(trace.events.map(e=>e.text)));assert.deepEqual(trace.events.map(e=>e.text),['éZ']);
});
test('critic590 Codex stable project filters preserve forward progress while the file appends',async t=>{
 const home=dir(t,'critic590-codex-filter-');const lines=[JSON.stringify(meta)];
 for(let n=0;n<30;n++)lines.push(JSON.stringify({type:'synthetic_padding',data:'x'.repeat(20000)}));
 lines.push(JSON.stringify(codexMessage('SYNTHETIC_FINAL_ANSWER')));const file=codexFile(home,lines);
 const files=createFiles({home,include:['workspace'],now:()=>NOW});t.after(()=>files.close());
 let row;
 for(let n=0;n<5;n++){
  if(n)fs.appendFileSync(file,JSON.stringify({type:'synthetic_padding',data:'append-'+n})+'\n');
  const rows=await files.filterRows(await files.scan());assert.equal(rows.length,1);row=rows[0];await files.read(row.key);
 }
 console.log('Codex filtered continuation',JSON.stringify({offset:row.loadedSize,size:row.size,reads:files.stats.reads}));
 assert.ok(row.loadedSize>MAX_READ,'same-project append must not reset the incremental reader to byte zero every cycle');
});

test('critic590 Claude scheduler rotates bounded slots across continuations, changed files and new files',()=>{
 const row=(kind,n)=>({key:`${kind}-${String(n).padStart(2,'0')}`,agentId:`agent-${n}`,mtime:NOW});
 const continuationRows=Array.from({length:20},(_,n)=>row('continuation',n));
 const changedRows=Array.from({length:3},(_,n)=>row('changed',n));
 const newRows=Array.from({length:3},(_,n)=>row('new',n));
 const lastScheduled=new Map(),sortDue=(a,b)=>b.mtime-a.mtime||a.key.localeCompare(b.key),seen=new Set();
 let sequence=0;
 for(let cycle=0;cycle<6;cycle++){
  const due=Claude.selectDueRows({continuationRows,changedRows,newRows,limit:16,lastScheduled,sortDue,now:()=>NOW});
  assert.ok(due.length<=16,'each poll remains within the configured read bound');
  assert.ok(due.some(item=>item.key.startsWith('continuation-')),'each poll advances an incomplete transcript');
  assert.ok(due.some(item=>item.key.startsWith('changed-')),'changed transcripts retain a reserved progress slot');
  assert.ok(due.some(item=>item.key.startsWith('new-')),'never-read transcripts retain a reserved progress slot');
  for(const item of due){seen.add(item.key);lastScheduled.set(item.key,++sequence);}
 }
 for(const item of [...continuationRows,...changedRows,...newRows])assert.ok(seen.has(item.key),`${item.key} eventually receives a bounded read`);
});

test('Claude partial continuations make finite progress while every transcript grows with distinct mtimes',()=>{
 const continuationRows=Array.from({length:20},(_,n)=>({key:`growing-${String(n).padStart(2,'0')}`,agentId:`agent-${n}`,mtime:NOW-n,size:0}));
 const changedRows=[{key:'changed',agentId:'changed',mtime:NOW}],newRows=[{key:'new',agentId:'new',mtime:NOW}];
 const lastScheduled=new Map(),sortDue=(a,b)=>b.mtime-a.mtime||a.key.localeCompare(b.key),seen=new Set();
 let sequence=0,cycleNow=NOW;
 // Model each transcript remaining partial while appending at least 256 KiB
 // and receiving a distinct, advancing mtime on every poll.
 for(let cycle=0;cycle<2;cycle++){
  for(const [n,row] of continuationRows.entries()){
   row.size+=256*1024;
   row.mtime=cycleNow-n;
  }
  const due=Claude.selectDueRows({continuationRows,changedRows,newRows,limit:16,lastScheduled,sortDue,now:()=>cycleNow});
  assert.equal(due.length,16,'the bounded read limit is filled each poll');
  assert.equal(due.filter(item=>item.key.startsWith('growing-')).length,14,'changed/new reservations leave fourteen continuation slots');
  for(const item of due){seen.add(item.key);lastScheduled.set(item.key,++sequence);}
  cycleNow+=1000;
 }
 for(const item of continuationRows)assert.equal(seen.has(item.key),true,`${item.key} advances within two polls despite newer partial files`);
 assert.ok(continuationRows.every(row=>row.size===512*1024),'all transcripts stay partial and continue growing across polls');
});

test('Claude reserves an aging slot so recent partial continuations cannot starve older growing histories',()=>{
 let cycleNow=NOW;
 const recent=Array.from({length:17},(_,n)=>({key:`recent-${n}`,agentId:`recent-agent-${n}`,mtime:cycleNow-n,size:0}));
 const aging=Array.from({length:3},(_,n)=>({key:`aging-${n}`,agentId:`aging-agent-${n}`,mtime:cycleNow-60000-n,size:0}));
 const continuationRows=[...recent,...aging],lastScheduled=new Map(),sortDue=(a,b)=>b.mtime-a.mtime||a.key.localeCompare(b.key),advanced=new Set();
 let sequence=100;
 for(const [n,row] of recent.entries())lastScheduled.set(row.key,sequence+n);
 for(const [n,row] of aging.entries())lastScheduled.set(row.key,n+1);
 for(let cycle=0;cycle<3;cycle++){
  for(const [n,row] of recent.entries()){row.size+=256*1024;row.mtime=cycleNow-n;}
  for(const row of aging)row.size+=256*1024;
  const due=Claude.selectDueRows({continuationRows,changedRows:[],newRows:[],limit:16,lastScheduled,sortDue,now:()=>cycleNow});
  assert.equal(due.length,16,'the scheduler keeps the bounded poll full');
  assert.equal(due.filter(item=>item.key.startsWith('aging-')).length,1,'one poll slot is reserved across the recency classes');
  for(const item of due){lastScheduled.set(item.key,++sequence);if(item.key.startsWith('aging-'))advanced.add(item.key);}
  cycleNow+=1000;
 }
 assert.deepEqual([...advanced].sort(),aging.map(row=>row.key).sort(),'every older partial receives a read within three polls');
 assert.ok(aging.every(row=>row.size===3*256*1024),'older transcripts remain partial while waiting for their reserved read');
});

