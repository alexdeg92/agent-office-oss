 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFiles}=require('../../src/adapters/claude-code/files');
test('critic591 unrecognized UUID ancestry obeys the recognized-record identifier bound',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'critic591-uuid-')),dir=path.join(home,'projects','synthetic');fs.mkdirSync(dir,{recursive:true});
 const rows=[{type:'user',sessionId:'synthetic',uuid:'valid-uuid',timestamp:new Date().toISOString(),message:{role:'user',content:'Synthetic ordinary prompt'}}];
 for(let n=0;n<32;n++)rows.push({type:'attachment',uuid:'x'.repeat(8192)+'-'+n,attachment:{synthetic:true}});
 fs.writeFileSync(path.join(dir,'synthetic.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const files=createFiles({home});t.after(()=>{files.close();fs.rmSync(home,{recursive:true,force:true});});
 const [row]=await files.scan();await files.read(row.key);
 const keys=row.ancestry.map(([id])=>id);
 console.log('ancestry bounds',JSON.stringify({keys:keys.length,maxLength:Math.max(...keys.map(id=>typeof id==='string'?id.length:Infinity)),retainedKeyBytes:keys.reduce((sum,id)=>sum+Buffer.byteLength(JSON.stringify(id)),0),accountedCacheBytes:files.cacheBytes()}));
 assert.ok(keys.every(id=>typeof id==='string'&&id.length<=256),'unknown source rows must not bypass bounded UUID validation');
});
