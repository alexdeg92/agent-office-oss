 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Claude=require('../../src/adapters/claude-code'),{createEngine}=require('../../src/engine');
const {waitFor}=require('../helpers/harness');
const NOW=1791600000000;
function setup(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'critic591-claude-'));const project=path.join(home,'projects','synthetic');fs.mkdirSync(project,{recursive:true});let clock=NOW;const started=Date.now(),now=()=>clock+Date.now()-started;
 const engine=createEngine({now}),runtime=Claude.createRuntime({runtimeConfig:{claudeCode:{home,agentGrouping:'project'}}},{now});runtime.attach(engine);
 t.after(()=>{runtime.close();fs.rmSync(home,{recursive:true,force:true});});
 const write=(id,rows,at)=>{const file=path.join(project,id+'.jsonl');fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');fs.utimesSync(file,new Date(at),new Date(at));return file;};
 return {home,project,runtime,engine,write,tick:()=>clock+=2000,now};}
const user=(id,at)=>({type:'user',sessionId:id,uuid:'first-'+id,timestamp:new Date(at).toISOString(),message:{role:'user',content:'Synthetic first turn'}});
test('critic591 an already complete cold transcript continues after a multi-window append',async t=>{
 const h=setup(t),id='cold-append',file=h.write(id,[user(id,NOW-65000)],NOW-60000);
 await h.runtime.cycle();assert.equal(h.runtime.files.rows()[0].coverageComplete,true);
 const rows=[];for(let n=0;n<80;n++)rows.push({type:'attachment',uuid:'meta-'+n,parentUuid:n?'meta-'+(n-1):'first-'+id,attachment:{synthetic:'x'.repeat(32768)}});
 rows.push({type:'assistant',sessionId:id,uuid:'final',parentUuid:'meta-79',timestamp:new Date(NOW-60000).toISOString(),message:{role:'assistant',content:[{type:'text',text:'SYNTHETIC_FINAL_APPEND'}]}});
 fs.appendFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');fs.utimesSync(file,new Date(NOW-60000),new Date(NOW-60000));
 await h.runtime.cycle();
 await waitFor(()=>h.runtime.files.rows()[0]?.coverageComplete,{timeoutMs:15000,intervalMs:50,what:'appended Claude transcript continuation'});
 const row=h.runtime.files.rows()[0];console.log('append continuation',JSON.stringify({offset:row.offset,size:row.size,complete:row.coverageComplete,bytes:h.runtime.files.stats.bytes}));
 assert.ok(row.offset>=row.size,'coverage must become incomplete on growth and schedule the remaining append');
 assert.ok(h.engine.transcript(h.engine.sessions()[0].key).events.some(event=>event.text==='SYNTHETIC_FINAL_APPEND'));
});
test('critic591 a new recent session is admitted while existing bounded-cache sessions append',async t=>{
 const h=setup(t),files=[];for(let n=0;n<16;n++){const id='warm-'+String(n).padStart(2,'0');files.push(h.write(id,[user(id,NOW-1000)],NOW-1000));}
 await h.runtime.cycle();assert.equal(h.runtime.files.rows().filter(row=>row.initialized).length,16);
 h.tick();h.write('newest',[user('newest',h.now())],h.now());
 for(let n=0;n<6;n++){
  h.tick();for(let i=0;i<files.length;i++){fs.appendFileSync(files[i],JSON.stringify({type:'attachment',uuid:'fresh-'+i+'-'+n,attachment:{synthetic:true}})+'\n');fs.utimesSync(files[i],new Date(h.now()),new Date(h.now()));}
  await h.runtime.cycle();
 }
 const row=h.runtime.files.rows().find(row=>row.sessionId==='newest');console.log('recent admission',JSON.stringify({initialized:!!row.initialized,total:h.runtime.files.rows().length,cache:h.runtime.files.cached().length}));
 assert.equal(row.initialized,true,'new session must receive one read; simultaneous retention of all 17 is not required');
});
