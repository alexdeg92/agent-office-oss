'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createSetupIntegrations}=require('../../src/ops/setup-integrations');
const {paths}=require('../../src/adapters/openclaw/paths');
test('default single-agent local workspace is authoritative before any plan or detect; plan and status share it',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'settings-target-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const env={HOME:home,AO_ENV:'test',PATH:'',OC_BIN:path.join(__dirname,'../bin/openclaw')};
 const state=path.join(home,'.openclaw'),workspace=path.join(home,'projects');fs.mkdirSync(state);fs.mkdirSync(workspace);fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({agents:{defaults:{workspace:'~/projects'}}}));
 const I=require('../../src/adapters/openclaw/integration');I.install({id:'main',workspace},{locale:'fr',backupDir:path.join(home,'backups')});
 const service=createSetupIntegrations({env,paths:paths(env),dataDir:path.join(home,'data')});assert.equal(service.descriptor({runtime:'openclaw',agentId:'main'}).status,'installed');
 const plan=await service.plan({runtime:'openclaw'});assert.deepEqual(plan.agents.map(a=>[a.id,a.status]),[['main','installed']]);
 const fresh=createSetupIntegrations({env,paths:paths(env),dataDir:path.join(home,'data')});assert.equal(fresh.descriptor({runtime:'openclaw',agentId:'main'}).target.workspace,workspace);
});
test('declared local targets override caller workspaces and unsafe symlink targets fail closed',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'settings-target-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const env={HOME:home,AO_ENV:'test',PATH:''},p=paths(env);fs.mkdirSync(path.dirname(p.openclawConfigPath));const workspace=path.join(home,'actual');fs.mkdirSync(workspace);
 fs.writeFileSync(p.openclawConfigPath,JSON.stringify({agents:{list:[{id:'atlas',workspace:'actual'}]}}));const service=createSetupIntegrations({env,paths:p,dataDir:path.join(home,'data')});
 const plan=await service.plan({runtime:'openclaw',agents:[{id:'atlas',workspace:'/untrusted-gateway-path'}]});assert.equal(plan.agents[0].status,'absent');assert.ok(plan.agents[0].files.every(file=>file.startsWith(workspace+path.sep)));
 fs.renameSync(workspace,workspace+'-original');fs.symlinkSync(workspace+'-original',workspace);assert.throws(()=>service.descriptor({runtime:'openclaw',agentId:'atlas'}),{code:'EUNSAFEPATH'});
});
