 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('../../src/adapters/codex'),{createEngine}=require('../../src/engine');
const {collectRuntimeProjects}=require('../../src/projects/runtime-sources');
function fixture(t,cwd){const home=fs.mkdtempSync(path.join(os.tmpdir(),'critic596-codex-')),dir=path.join(home,'sessions','2026','10','10');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'rollout-synthetic.jsonl');
 const meta={type:'session_meta',payload:{id:'synthetic-session',cwd,timestamp:new Date().toISOString()}};
 fs.writeFileSync(file,JSON.stringify(meta)+'\n');
 const runtime=A.createRuntime({runtimeConfig:{codex:{home,include:[],exclude:[],agentGrouping:'project'}}}),engine=createEngine({adapter:runtime.definition});runtime.attach(engine);
 t.after(()=>{runtime.close();fs.rmSync(home,{recursive:true,force:true});});
 return{runtime,engine,file};}
const append=(file,cwd)=>fs.appendFileSync(file,JSON.stringify({type:'turn_context',payload:{cwd,model:'synthetic-model'}})+'\n');
test('critic596 resumed workspace without a basename clears prior label and contributes no stale project card',async t=>{
 const h=fixture(t,'/synthetic/workspace');await h.runtime.cycle();assert.equal(h.engine.sessions()[0].projectLabel,'workspace');
 append(h.file,'/');await h.runtime.cycle();
 const projects=collectRuntimeProjects({sessions:h.engine.sessions(),agents:h.engine.agents(),connectorOf:()=>({id:'codex',adapter:'codex',name:'Codex',projectSource:A.definition.projectSource}),idKey:'synthetic-more-than-thirty-two-character-key'});
 console.log('root resumption',JSON.stringify({sessions:h.engine.sessions().length,label:h.engine.sessions()[0].projectLabel,agentName:h.engine.agents()[0].name,cards:projects.projects.length}));
 assert.equal(h.engine.sessions()[0].projectLabel,null,'new cwd with no basename must not reuse the former workspace title');
 assert.equal(h.engine.agents()[0].name,'Codex project');assert.equal(projects.projects.length,0);assert.equal(h.runtime.files.rows().length,1);
});
test('critic596 previously unlabeled workspace acquires the current safe name after resume',async t=>{
 const h=fixture(t,'/');await h.runtime.cycle();assert.equal(h.engine.sessions()[0].projectLabel,null);
 append(h.file,'/synthetic/current-workspace');await h.runtime.cycle();
 assert.equal(h.engine.sessions()[0].projectLabel,'current-workspace');assert.equal(h.engine.agents()[0].name,'current-workspace');assert.equal(h.engine.sessions().length,1);
});
