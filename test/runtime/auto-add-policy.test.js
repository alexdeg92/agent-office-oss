'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store'),{createMultiRuntimeController}=require('../../src/multi-runtime-controller');
const {definition,createDemoTeam}=require('../../src/adapters/demo');const {buildOfficeVM,createStateTracker,officeDefaults}=require('../../src/api/v2/vm/office');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-runtime-auto-add-'));const store=openStore({dir,instance:'test',ownerName:'Synthetic',log:()=>{}});let local;const adapter={definition:{...definition,id:'codex'},createRuntime(){return{definition:this.definition,attach(e){local=e;},close(){}};}};const cfg={runtimeInstances:[{id:'codex',adapter:'codex',enabled:true,cfg:{agentNames:{},hiddenAgents:[],configuredAgents:null},config:{adapter:'codex'}}]};const controller=createMultiRuntimeController({cfg,store,resolveAdapter:()=>adapter});t.after(()=>{controller.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return{store,controller,local:()=>local};}

test('transcript runtime auto-add persists discoveries, respects opt-out and exclusions',t=>{
 const f=fixture(t),e=f.local(),team=createDemoTeam(),first=team.agents()[0];
 assert.equal(e.ingestCanonical('agents',[first]).ok,true);assert.equal(e.agents().length,1);assert.deepEqual(f.store.runtimeAutoAdd.get('codex').added.map(x=>x.id),[first.id]);e.ingestCanonical('sessions.snapshot',team.sessionList().filter(row=>row.class.agentId===first.id));const policy=f.store.runtimeAutoAdd.get('codex');const office=buildOfficeVM({engine:e,now:Date.now(),tracker:createStateTracker(),layout:officeDefaults(),actorOf:()=>({kind:'system',name:'Système'}),isNewAgent:id=>f.store.runtimeAutoAdd.isNew(policy,id)});assert.ok(office.occupants.some(row=>row.isNew===true),'the newly discovered agent is marked in the Office projection');
 f.store.runtimeAutoAdd.setEnabled('codex',false,true);f.controller.refreshAutoAdd('codex');const second={...team.agents()[1],id:'new-project'};e.ingestCanonical('agents',[first,second]);assert.equal(e.detectedAgents().length,2);assert.equal(e.agents().length,1,'new discoveries stay out of the managed roster after opt-out');
 f.store.runtimeAutoAdd.exclude('codex',first.id);f.controller.refreshAutoAdd('codex');e.ingestCanonical('agents',[first,second]);assert.equal(e.agents().length,0);assert.deepEqual(f.store.runtimeAutoAdd.get('codex').excluded,[first.id]);
});
