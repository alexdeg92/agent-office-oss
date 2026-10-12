'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settingsFixture}=require('../helpers/settings-fixture'),{adapterById}=require('../../src/adapters');
const {labelsFor}=require('../../src/i18n');
const BASE='/api/v3/settings';
test('runtime diagnostics omit absent inactive catalog entries and retain selected/detected runtimes',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());
 for(const vm of [(await h.get(BASE)).json.data,(await h.post(BASE+'/detect')).json.data.vm]) {
  for(const r of vm.runtimes) assert.equal(vm.diagnostics.some(d=>d.id==='runtime:'+r.id),r.selected||r.found,r.id);
 }
});
test('detected agents are one informational connector row and contribute no items to fix',()=>{
 const rows=require('../../src/settings/diagnostics').diagnostics({
  runtimes:[{id:'claude-instance',adapter:'claude-code',name:'Claude Code',candidate:true,found:true,supported:true,selected:false,connection:{status:'not-configured',protocol:null,latencyMs:null}}],
  agents:[{id:'claude-instance:project-atlas',runtime:'claude-instance',agentId:'project-atlas',name:'Atlas',configured:false,hidden:false,integrations:[]},
    {id:'claude-instance:workspace',runtime:'claude-instance',agentId:'workspace',name:'Workspace',configured:false,hidden:false,integrations:[]}],
  permissionOk:true,stale:false,restartRequired:false,readonly:false,
 });
 const detected=rows.filter(row=>row.id==='detected-agents:claude-instance');
 assert.equal(detected.length,1);assert.equal(detected[0].level,'info');assert.equal(detected[0].fix,null);
 assert.equal(detected[0].label.key,'settings.diagnostic.detectedAgents');assert.deepEqual(detected[0].label.params,{n:2,runtime:'Claude Code'});
 assert.equal(rows.some(row=>row.id.startsWith('agent:')),false);
 assert.equal(rows.filter(row=>['warning','error'].includes(row.level)&&row.fix).length,0);
});
test('detected summaries scope counts to the runtime instance used by navigation',()=>{
 const rows=require('../../src/settings/diagnostics').diagnostics({
  runtimes:[{id:'claude-one',adapter:'claude-code',name:'Claude Code',candidate:true,found:true,supported:true,selected:false,connection:{status:'not-configured',protocol:null,latencyMs:null}},
    {id:'claude-two',adapter:'claude-code',name:'Claude Code · équipe',candidate:true,found:true,supported:true,selected:false,connection:{status:'not-configured',protocol:null,latencyMs:null}}],
  agents:[{id:'claude-one:atlas',runtime:'claude-one',agentId:'atlas',configured:false,hidden:false,integrations:[]},
    {id:'claude-two:workspace',runtime:'claude-two',agentId:'workspace',configured:false,hidden:false,integrations:[]}],
  permissionOk:true,stale:false,restartRequired:false,readonly:false,
 });
 assert.deepEqual(rows.filter(row=>row.id.startsWith('detected-agents:')).map(row=>[row.id,row.label.params.n]),[
  ['detected-agents:claude-one',1],['detected-agents:claude-two',1],
 ]);
});
test('a detected but disabled orchestrator is one informational action row only',()=>{
 const build=orchestrator=>require('../../src/settings/diagnostics').diagnostics({runtimes:[],agents:[],orchestrator,
  permissionOk:true,stale:false,restartRequired:false,readonly:false});
 const detected=build({detected:true,enabled:false,label:'herdr'}).filter(row=>row.id==='orchestrator:detected');
 assert.equal(detected.length,1);assert.equal(detected[0].level,'info');assert.equal(detected[0].section,'connection');assert.equal(detected[0].fix,null);
 assert.deepEqual(detected[0].label,{key:'settings.diagnostic.orchestratorDetected',params:{source:'herdr'}});
 assert.equal(build({detected:true,enabled:true,label:'herdr'}).some(row=>row.id==='orchestrator:detected'),false);
 assert.equal(build({detected:false,enabled:false,label:'herdr'}).some(row=>row.id==='orchestrator:detected'),false);
});
test('configured agents explain missing integration action, then become healthy after installation',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());await h.post(BASE+'/detect');
 const diagnostic=vm=>vm.diagnostics.find(d=>d.id==='agent:openclaw:atlas');
 let d=diagnostic((await h.get(BASE)).json.data);assert.equal(d.level,'warning');assert.equal(d.section,'integrations');assert.equal(d.label.key,'settings.diagnostic.integration.missing');assert.equal(d.detail.key,'settings.diagnostic.integrationDetail.missing');assert.equal(d.label.params.agent,'Atlas');assert.equal(d.detail.params.integration,'projet');
 await h.reauth();const p=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});const r=await h.post(BASE+'/integrations/apply',{planId:p.json.data.result.planId,agentIds:['atlas'],action:'install',confirmed:true});assert.equal(r.status,200,r.text);
 d=diagnostic(r.json.data.vm);assert.equal(d.level,'ok');assert.equal(d.label.key,'settings.diagnostic.agentConfigured');assert.equal(d.detail,null);
});
for(const status of ['outdated','modified','unsupported'])test('configured integration '+status+' diagnostics supply action labels and translated detail',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());await h.post(BASE+'/detect');const adapter=adapterById('openclaw'),original=adapter.projectTag;
 adapter.projectTag=()=>({...original(),inspect:()=>({status})});t.after(()=>{adapter.projectTag=original;});
 const r=await h.get(BASE);assert.equal(r.status,200,r.text);const d=r.json.data.diagnostics.find(d=>d.id==='agent:openclaw:atlas');
 assert.equal(d.level,status==='unsupported'?'info':'warning');assert.equal(d.section,'integrations');assert.equal(d.label.key,'settings.diagnostic.integration.'+status);assert.equal(d.detail.key,'settings.diagnostic.integrationDetail.'+status);
 for(const locale of ['fr','en'])for(const ref of [d.label,d.detail])assert.equal(typeof labelsFor(locale,3)[ref.key],'string');
});
