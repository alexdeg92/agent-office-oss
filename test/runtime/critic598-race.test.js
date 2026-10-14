 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFiles}=require('../../src/adapters/codex/files');
test('critic598 a project hint cannot authorize excluded appended data after the prefilter snapshot changes',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'critic598-codex-')),dir=path.join(home,'sessions','2026','10','10');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'rollout-synthetic.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'synthetic-session',cwd:'/synthetic/workspace'}})+'\n');
 const files=createFiles({home,include:['workspace']});t.after(()=>{files.close();fs.rmSync(home,{recursive:true,force:true});});
 let rows=await files.filterRows(await files.scan());assert.equal(rows.length,1);await files.read(rows[0].key);
 fs.appendFileSync(file,JSON.stringify({type:'synthetic_padding',data:'before-prefilter-update'})+'\n');
 rows=await files.filterRows(await files.scan());assert.equal(rows.length,1,'prefilter snapshot still permits the original workspace');
 // Append only after preflight, before opening the bounded reader. The new
 // root context and message are wholly visible in the first appended chunk.
 fs.appendFileSync(file,[
  {type:'turn_context',payload:{cwd:'/',model:'synthetic-model'}},
  {type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',id:'root-message',role:'user',status:'completed',content:[{type:'input_text',text:'SYNTHETIC_EXCLUDED_ROOT_TEXT'}]}},
  {type:'synthetic_padding',data:'x'.repeat(350*1024)}
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const trace=await files.read(rows[0].key);
 console.log('prefilter/read drift',JSON.stringify({hintSize:rows[0].hintSize,scanSize:rows[0].size,openedSize:fs.statSync(file).size,label:rows[0].projectName,excludedTextAdmitted:!!trace?.events.some(event=>event.text==='SYNTHETIC_EXCLUDED_ROOT_TEXT')}));
 assert.equal(trace,null,'opened file no longer matches the hint signature; explicit excluded root must not inherit the permitted workspace label');
});
