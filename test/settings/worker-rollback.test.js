'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {settingsFixture}=require('../helpers/settings-fixture'),safe=require('../../src/ops/safe-fs');
const BASE='/api/v3/settings';
const image=file=>fs.existsSync(file)?{bytes:fs.readFileSync(file).toString('base64'),mode:fs.statSync(file).mode&0o777}:null;
const dbImage=h=>({revision:h.settings.revision(),hash:h.store.db.prepare("SELECT value FROM store_meta WHERE key='setup_config_hash'").get(),owner:h.store.users.owner(),person:h.store.owner});
for(const phase of ['secrets','config'])test('S22-01: directory fsync failure inside '+phase+' worker restores files and DB before any success event',async t=>{
 const h=await settingsFixture({probe:async()=>({status:'connected',protocol:3,latencyMs:1})});t.after(()=>h.close());t.after(()=>safe.setWorkerFault(null));await h.reauth();
 fs.chmodSync(h.paths.file,0o640);const files=[h.paths.file,h.paths.secrets],before=files.map(image),db=dbImage(h);
 safe.setWorkerFault({file:phase==='secrets'?h.paths.secrets:h.paths.file});
 const r=await h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:'replacement-fixture-token'}});
 assert.equal(r.status,503,r.text);assert.deepEqual(files.map(image),before);assert.deepEqual(dbImage(h),db);assert.deepEqual(h.events,[]);
});
test('S22-01: directory fsync failure inside integration worker restores all selected targets and leaves revision unchanged',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());t.after(()=>safe.setWorkerFault(null));await h.post(BASE+'/detect');await h.reauth();
 const p=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});assert.equal(p.status,200,p.text);
 const files=p.json.data.result.agents.flatMap(a=>a.uninstallFiles),target=files.find(f=>f.endsWith('AGENTS.md'));assert.ok(target);
 const before=files.map(image),db=dbImage(h);h.events.length=0;safe.setWorkerFault({file:target});
 const r=await h.post(BASE+'/integrations/apply',{planId:p.json.data.result.planId,agentIds:['atlas','scribe'],action:'install',confirmed:true});
 assert.equal(r.status,400,r.text);assert.deepEqual(files.map(image),before);assert.deepEqual(dbImage(h),db);assert.deepEqual(h.events,[]);
});
test('S22-01: worker receipt refuses rollback over a concurrent published-target replacement and retains private preimages',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());t.after(()=>safe.setWorkerFault(null));await h.reauth();
 const beforeConfig=image(h.paths.file),db=dbImage(h),replacement='synthetic concurrent replacement';safe.setWorkerFault({file:h.paths.secrets,replacement});
 let error;try{safe.transaction([h.paths.file,h.paths.secrets],path.join(h.tmp,'rollback-backups'),()=>safe.mutate(h.paths.secrets,{type:'write',text:'new uncommitted contents'}));}catch(e){error=e;}
 assert.equal(error?.code,'EROLLBACK');assert.equal(fs.readFileSync(h.paths.secrets,'utf8'),replacement);assert.deepEqual(image(h.paths.file),beforeConfig);assert.deepEqual(dbImage(h),db);assert.deepEqual(h.events,[]);
 assert.equal(fs.statSync(error.backup).mode&0o777,0o600);
});
test('S22-01: an unacknowledged worker exit reports recovery failure without guessing the changed inode',async t=>{
 const h=await settingsFixture();t.after(()=>h.close());t.after(()=>safe.setWorkerFault(null));const db=dbImage(h);
 safe.setWorkerFault({file:h.paths.secrets,terminate:true});let error;
 try{safe.transaction([h.paths.secrets],path.join(h.tmp,'rollback-backups'),()=>safe.mutate(h.paths.secrets,{type:'write',text:'published before worker exit'}));}catch(e){error=e;}
 assert.equal(error?.code,'EROLLBACK');assert.equal(fs.readFileSync(h.paths.secrets,'utf8'),'published before worker exit');assert.equal(fs.statSync(error.backup).mode&0o777,0o600);assert.deepEqual(dbImage(h),db);assert.deepEqual(h.events,[]);
});
