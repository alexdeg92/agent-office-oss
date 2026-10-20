'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {settingsFixture}=require('../helpers/settings-fixture'),{waitFor}=require('../helpers/harness'),{parseId}=require('../../src/runtime-ids');
const SENTINEL='PRIVATE_PROJECT_SENTINEL',RENAMED='PRIVATE_CHOSEN_SENTINEL';
for(const version of [2,3]) test('S36-01 v'+version+' anonymous bootstrap excludes private project names through publication, rename and logout',async t=>{
 const h=await settingsFixture({effectiveV3:true});t.after(()=>h.close());
 const home=path.join(h.tmp,'.claude'),dir=path.join(home,'projects','synthetic-key'),file=path.join(dir,'synthetic-session.jsonl');fs.mkdirSync(dir,{recursive:true});
 const record=(uuid,cwd)=>JSON.stringify({type:'user',uuid,sessionId:'synthetic-session',timestamp:new Date().toISOString(),...(cwd?{cwd}:{}),message:{role:'user',content:'Synthetic private content'}})+'\n';
 fs.writeFileSync(file,record('initial'));
 await h.reauth();const saved=await h.put('/api/v3/settings/runtimes',{expectedRevision:1,runtimes:[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url},{id:'claude',adapter:'claude-code',enabled:true,home}]});assert.equal(saved.status,200,saved.text);
 await waitFor(()=>h.engine.agents().some(a=>a.id.startsWith('rt:claude:')));
 const id=h.engine.agents().find(a=>a.id.startsWith('rt:claude:')).id,local=parseId(id).local;
 await waitFor(()=>h.engine.instances.find(i=>i.id==='claude').runtime.files.rows().every(r=>r.initialized));
 assert.equal(h.engine.agents().find(a=>a.id===id).name,'Claude Code project',
  'anonymous-safe name is the adapter’s fixed fallback, never a discovered project basename');
 const owner=h.cookie, expired='taco_sess='+h.auth.signSession({...h.auth.verifySession(owner.split('=')[1]),exp:Date.now()-1000});
 const meta=async cookie=>h.request('GET','/api/v'+version+'/meta',undefined,{cookie});
 const anonymous=async(strict=true)=>{
  for(const cookie of ['', 'taco_sess=invalid',expired]) {
   const r=await meta(cookie);assert.equal(r.status,200,r.text);assert.ok(!r.text.includes(SENTINEL)&&!r.text.includes(RENAMED)&&!r.text.includes(dir),'anonymous entire response must not contain private names or project paths');
   if(strict){assert.equal(r.json.data.primaryAgent,null);assert.equal(r.json.data.runtime,null);if(version===3){assert.deepEqual(r.json.data.runtimes,[]);assert.equal(r.json.data.instance.name,null);assert.ok(!Object.keys(r.json.data.labels).some(k=>k.startsWith('agent.rt:')));}}
   assert.ok(r.json.data.bootId);assert.equal(r.headers.get('cache-control'),'no-store');if(strict){assert.ok(r.headers.get('vary').includes('Cookie'));assert.deepEqual(r.json.meta.stale,[]);}
  }
 };
 await anonymous(false);
 fs.appendFileSync(file,record('named','/srv/synthetic/'+SENTINEL));await h.engine.instances.find(i=>i.id==='claude').runtime.cycle();await waitFor(()=>h.engine.agents().find(a=>a.id===id)?.name===SENTINEL);
 if(version===2){const vm=(await h.get('/api/v3/settings')).json.data;assert.equal((await h.put('/api/v3/settings/agents',{expectedRevision:vm.revision,runtime:'claude',primary:local,agents:[{id:local,name:null,hidden:false}]})).status,200);}
 else assert.ok(h.engine.primaryAgent().id.startsWith('rt:legacy:'),'non-primary private agents are covered');
 await anonymous();
 const named=await meta(owner);assert.equal(named.status,200);assert.ok(named.text.includes(SENTINEL),'owner gets actual project basename');
 const settings=(await h.get('/api/v3/settings')).json.data;assert.equal((await h.put('/api/v3/settings/agents',{expectedRevision:settings.revision,runtime:'claude',primary:version===2?local:null,agents:[{id:local,name:RENAMED,hidden:false}]})).status,200);
 await anonymous();assert.ok((await meta(owner)).text.includes(RENAMED),'owner sees Settings override');
 const token=h.store.tokens.create({agentId:h.engine.primaryAgent().id});const scoped=await h.request('GET','/api/v'+version+'/meta',undefined,{authorization:'Bearer '+token.token,cookie:owner});assert.equal(scoped.status,403,'bearer cannot inherit owner metadata');
 assert.equal((await meta('')).json.data.instance.configured,true,'bootstrap still supplies the configured/login gate');
 assert.equal((await h.post('/api/logout')).status,200);const revoked=await meta(owner);assert.equal(revoked.status,200);assert.ok(!revoked.text.includes(RENAMED));await anonymous();
 });
