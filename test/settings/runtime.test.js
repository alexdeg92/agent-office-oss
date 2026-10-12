const { scopedId, parseId } = require('../../src/runtime-ids');
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {settingsFixture}=require('../helpers/settings-fixture'),{waitFor}=require('../helpers/harness');
const BASE='/api/v3/settings';
test('runtime credential save retains configured primary in the immediate VM before ingestion',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());await h.post(BASE+'/detect');await h.reauth();
 const r=await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:h.fake.token}});assert.equal(r.status,200,r.text);
 const primary=r.json.data.vm.agents.filter(a=>a.isPrimary);assert.equal(primary.length,1);assert.equal(primary[0].agentId,'atlas');assert.equal(primary[0].configured,true);assert.equal(primary[0].lookRoute,'/boutique?onglet=personnages&agent=primary');
 const saved=await h.put(BASE+'/agents',{expectedRevision:2,runtime:'openclaw',primary:primary[0].agentId,agents:[{id:'atlas',name:null,hidden:false}]});assert.equal(saved.status,200,saved.text);assert.equal(saved.json.data.vm.agents.find(a=>a.agentId==='atlas').name,null);
});
test('live reload isolates late ingestion, closes old reads, and rebinds commands when returning to another adapter',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());const ingestOld=h.engine.ingestCanonical,refreshOld=h.runtime.refreshSkills,oldGateway=h.runtime.gw;
 await h.reauth();assert.equal((await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'demo'}})).status,400,'switching adapter requires a new identity');
 let r=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:[{id:'demo',adapter:'demo',enabled:true}]});assert.equal(r.status,200,r.text);assert.ok(h.engine.primaryAgent());
 const before=h.engine.agents().map(a=>a.id);ingestOld('agents',[{id:'obsolete',name:'Old agent',workspace:null,model:null,fallbackModels:[],isPrimary:true,mainSessionKey:null}]);assert.deepEqual(h.engine.agents().map(a=>a.id),before);assert.equal(oldGateway.retry,false);assert.equal((await refreshOld()).refused,'agent-unknown');
 assert.equal((await h.post('/api/v3/gateway/restart')).status,404);
 r=await h.put(BASE+'/runtimes',{expectedRevision:2,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url,token:h.fake.token}]});assert.equal(r.status,200,r.text);await waitFor(()=>h.engine.gateway().connected&&h.engine.agents().some(a=>a.id===scopedId('legacy','agent','atlas'))&&h.engine.cronJobs().length>0);
 assert.equal(h.engine.primaryAgent().id,scopedId('legacy','agent','atlas'));assert.equal((await h.get('/api/v3/meta')).json.data.runtime.id,'openclaw');
 const runs=()=>fs.readFileSync(h.env.FAKE_OC_LOG,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l).argv).filter(a=>a[0]==='cron'&&a[1]==='run');
 const count=runs().length,id=h.engine.cronJobs()[0].id;r=await h.post('/api/v3/flows/'+id+'/runs');assert.equal(r.status,200,r.text);assert.equal(runs().length,count+1);assert.equal(runs().at(-1).at(-1),parseId(id,'flow').local);
});
