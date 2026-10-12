'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {settingsFixture}=require('../helpers/settings-fixture');
const {createConfiguredOrchestrators}=require('../../src/sources/configured-orchestrators');
const {sourceBrand}=require('../../src/adapters');
const BASE='/api/v3/settings';
const at=Date.parse('2026-10-12T00:00:00Z');
const sourceOptions={env:{HOME:'/tmp/fixture',PATH:''},binaryPath:'/fixture/bin/herdr',now:()=>at,
 run:async()=>({stdout:Buffer.from('{"id":"fixture","result":{"type":"ok","agents":[]}}')})};

test('detected Herdr defaults on; saving off persists an explicit opt-out and can be re-enabled',async t=>{
 const source=createConfiguredOrchestrators(sourceOptions);t.after(()=>source.close());
 const h=await settingsFixture({orchestratorTeams:source});t.after(()=>h.close());await source.refresh();
 let response=await h.get(BASE);assert.equal(response.status,200,response.text);
 assert.deepEqual(response.json.data.herdr,{found:true,enabled:true,active:true,status:'available',checkedAt:at,brand:sourceBrand('herdr')});
 const runtimes=[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url}];
 assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes,herdrEnabled:false})).status,403,'source changes require re-auth');
 await h.reauth();response=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes,herdrEnabled:false});assert.equal(response.status,200,response.text);
 assert.equal(response.json.data.vm.herdr.enabled,false);assert.equal(response.json.data.vm.herdr.active,false);
 let config=JSON.parse(fs.readFileSync(h.paths.file,'utf8'));assert.equal(config.sources.herdr,false,'absence is not confused with a saved false');
 const restarted=createConfiguredOrchestrators({...sourceOptions,enabled:config.sources.herdr});
 try{assert.equal(restarted.hasHerdr,false);}finally{restarted.close();}
 response=await h.put(BASE+'/runtimes',{expectedRevision:2,runtimes,herdrEnabled:true});assert.equal(response.status,200,response.text);
 assert.equal(response.json.data.vm.herdr.enabled,true);assert.equal(response.json.data.vm.herdr.active,true);
 config=JSON.parse(fs.readFileSync(h.paths.file,'utf8'));assert.equal(config.sources.herdr,true);
 assert.equal(h.detectCalls,0,'reading and changing this source does not scan runtime homes');
});

test('absent Herdr defaults off and cannot be enabled by a forged runtime save',async t=>{
 const source=createConfiguredOrchestrators({...sourceOptions,binaryPath:false});t.after(()=>source.close());
 const h=await settingsFixture({orchestratorTeams:source});t.after(()=>h.close());
 const before=await h.get(BASE);assert.equal(before.json.data.herdr.enabled,false);assert.equal(before.json.data.herdr.active,false);
 await h.reauth();const response=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url}],herdrEnabled:true});
 assert.equal(response.status,400,response.text);assert.ok(response.json.error.details.some(d=>d.issue==='not-detected'));
 assert.equal((await h.get(BASE)).json.data.revision,before.json.data.revision);
});
