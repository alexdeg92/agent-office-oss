'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {settingsFixture}=require('../helpers/settings-fixture');
const {TOKEN}=require('../helpers/onboarding-fixture');
const {detectRuntimes}=require('../../src/adapters/detection');
const I=require('../../src/adapters/openclaw/integration');
const BASE='/api/v3/settings';
function seed(home,{gateway}) {
 const workspace=path.join(home,'.openclaw/workspace'),nested=path.join(workspace,'claude-code');
 for(const dir of [workspace,nested]) { fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'AGENTS.md'),'# Synthetic owner instructions\n\nKeep owner text.\n',{mode:0o640}); }
 fs.writeFileSync(path.join(home,'.openclaw/openclaw.json'),JSON.stringify({gateway:{port:Number(new URL(gateway.url).port),auth:{token:TOKEN}},agents:{defaults:{workspace},entries:{main:{name:'Atlas',workspace},'claude-code':{name:'Claude Code'}}}}));
 // Files installed by the preceding release, with the same owned content and locale.
 for(const target of [{id:'main',workspace},{id:'claude-code',workspace:nested}]) I.install(target,{locale:'fr',backupDir:path.join(home,'prior-backups')});
 return [{id:'main',workspace},{id:'claude-code',workspace:nested}];
}
async function fixture(t,options={}) {
 const h=await settingsFixture({effectiveV3:true,seed,detect:({env})=>detectRuntimes({env:{...env,PATH:''}}),...options,
  config:(config,ctx)=>{delete config.network;config.agents.primary='main';config.agents.names={openclaw:{main:'Atlas','claude-code':'Claude Code'}};options.config?.(config,ctx);}});
 t.after(()=>h.close());return h;
}
test('prod-shaped env listener has no pending network change on either cold boot',async t=>{
 for(const bootId of ['scratch-first-boot','scratch-after-restart']) {
  const h=await fixture(t,{bootId,env:{PORT:'18807',HOST:'127.0.0.1',AO_PUBLIC_URL:'https://scratch.example.test',AO_TRUST_PROXY:'loopback',PORTAL_COOKIE_SECURE:'0'}});
  const r=await h.get(BASE);assert.equal(r.status,200,r.text);const vm=r.json.data;
  assert.equal(vm.network.restartRequired,false);assert.equal(vm.network.mode.value,vm.network.active.mode);
  for(const key of ['mode','host','port','publicUrl','cookieSecure']) {assert.equal(vm.network[key].source,'env');assert.equal(vm.network[key].editable,false);assert.equal(vm.network[key].value,vm.network.active[key]);}
  assert.equal(vm.diagnostics.find(d=>d.id==='restart').level,'ok');assert.equal(h.detectCalls,0);
 }
});
test('effective env wins over stale file mode without suppressing a genuine file-managed change',async t=>{
 const h=await fixture(t,{env:{HOST:'127.0.0.1',PORT:'18789',AO_PUBLIC_URL:'https://scratch.example.test',PORTAL_COOKIE_SECURE:'0'},config:config=>{config.network={mode:'local',host:'0.0.0.0',port:18800,publicUrl:null,cookieSecure:true};}});
 const vm=(await h.get(BASE)).json.data;assert.equal(vm.network.restartRequired,false);assert.equal(vm.network.mode.value,vm.network.active.mode);
 const local=await settingsFixture();t.after(()=>local.close());await local.reauth();
 const changed=await local.put(BASE+'/network',{expectedRevision:1,mode:'tailnet',port:18800,publicUrl:'https://scratch.example.test'});
 assert.equal(changed.status,200,changed.text);assert.equal(changed.json.data.vm.network.restartRequired,true);
});
test('keyed OpenClaw agents share one real target resolver across cold GET, detect, plan, apply, uninstall and fresh service',async t=>{
 const h=await fixture(t),workspace=path.join(h.tmp,'.openclaw/workspace'),nested=path.join(workspace,'claude-code');
 const rows=vm=>vm.agents.filter(a=>['main','claude-code'].includes(a.agentId));
 let vm=(await h.get(BASE)).json.data;
 assert.deepEqual(rows(vm).map(a=>[a.agentId,a.integrations[0].status]).sort(),[['claude-code','installed'],['main','installed']]);
 const detection=await h.post(BASE+'/detect');assert.equal(detection.status,200,detection.text);
 assert.ok(rows(detection.json.data.vm).every(a=>a.integrations[0].status==='installed'));
 await h.reauth();
 const plan=await h.post(BASE+'/integrations/plan',{runtime:'legacy'});assert.equal(plan.status,200,plan.text);
 assert.deepEqual(plan.json.data.result.agents.map(a=>[a.id,a.status]).sort(),[['claude-code','installed'],['main','installed']]);
 const apply=await h.post(BASE+'/integrations/apply',{planId:plan.json.data.result.planId,agentIds:['main','claude-code'],confirmed:true});assert.equal(apply.status,200,apply.text);
 assert.ok(rows(apply.json.data.vm).every(a=>a.integrations[0].status==='installed'));
 assert.equal(fs.existsSync(path.join(h.tmp,'.openclaw/workspace-claude-code')),false);
 const {createSetupIntegrations}=require('../../src/ops/setup-integrations');
 const helper=()=>createSetupIntegrations({env:h.env,paths:require('../../src/adapters/openclaw/paths').paths(h.env),dataDir:path.join(h.tmp,'data')});
 assert.equal(helper().descriptor({runtime:'openclaw',agentId:'claude-code'}).target.workspace,nested);
 // A genuine previous owned version differs in content: not a release-number heuristic.
 const agentsMd=path.join(workspace,'AGENTS.md');fs.writeFileSync(agentsMd,fs.readFileSync(agentsMd,'utf8').replace('agent-office:projet v2','agent-office:projet v1'));
 vm=(await h.get(BASE)).json.data;assert.equal(rows(vm).find(a=>a.agentId==='main').integrations[0].status,'outdated');
 assert.equal(rows(vm).find(a=>a.agentId==='claude-code').integrations[0].status,'installed');
 const repairPlan=await h.post(BASE+'/integrations/plan',{runtime:'legacy'});
 const repaired=await h.post(BASE+'/integrations/apply',{planId:repairPlan.json.data.result.planId,agentIds:['main'],confirmed:true});assert.equal(repaired.status,200,repaired.text);
 assert.ok(rows(repaired.json.data.vm).every(a=>a.integrations[0].status==='installed'));
 const uninstallPlan=await h.post(BASE+'/integrations/plan',{runtime:'legacy'});
 const removed=await h.post(BASE+'/integrations/apply',{planId:uninstallPlan.json.data.result.planId,agentIds:['claude-code'],confirmed:true,action:'uninstall'});assert.equal(removed.status,200,removed.text);
 assert.equal(helper().descriptor({runtime:'openclaw',agentId:'claude-code'}).status,'absent');assert.equal(helper().descriptor({runtime:'openclaw',agentId:'main'}).status,'installed');
 assert.equal(fs.readFileSync(path.join(nested,'AGENTS.md'),'utf8'),'# Synthetic owner instructions\n\nKeep owner text.\n');
});
