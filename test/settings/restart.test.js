'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settingsFixture}=require('../helpers/settings-fixture');
const {createHostSupervisor}=require('../../src/ops/host-supervisor');
const BASE='/api/v3/settings';
test('supervisor detection is environment-only and the fallback command is display-only',()=>{
 let stopped=0;const shutdown=()=>stopped++;
 for(const env of [{AO_SUPERVISED:'1'},{AO_RESTART_POLICY:'always'},{AO_RESTART_POLICY:'on-failure'},{AO_RESTART_POLICY:'unless-stopped'}]){const s=createHostSupervisor({env,shutdown});assert.equal(s.supported,true);assert.equal(s.command,null);s.restart();}
 assert.equal(stopped,4);
 for(const env of [{},{INVOCATION_ID:'fixture'},{NOTIFY_SOCKET:'fixture'},{AO_RESTART_POLICY:'no'},{AO_ENV:'test'}]){const s=createHostSupervisor({env,shutdown,argv:['node',"/scratch/app's server.js"],execPath:'/scratch/node'});assert.equal(s.supported,false);assert.match(s.command,/scratch/);assert.throws(()=>s.restart(),{code:'EUNSUPERVISED'});}
 assert.equal(stopped,4);assert.equal(createHostSupervisor({env:{INVOCATION_ID:'fixture'}}).supported,false);
});
async function fixture(t,options={}){let exits=0;const h=await settingsFixture({bootId:'fixture-boot',supervisor:{supported:true,command:null,reason:null,restart(){exits++;}},...options});t.after(()=>h.close());Object.defineProperty(h,'exits',{get:()=>exits});return h;}
const request={expectedRevision:1,bootId:'fixture-boot',confirmed:true};
test('restart flushes accepted identity then invokes only its supervisor once; cooldown survives a new service',async t=>{
 const h=await fixture(t);assert.equal((await h.get('/api/v2/meta')).json.data.bootId,'fixture-boot');assert.equal((await h.get('/api/v3/meta')).json.data.bootId,'fixture-boot');assert.equal((await h.get(BASE)).json.data.restart.supported,true);
 assert.equal((await h.post(BASE+'/restart',request)).status,403);await h.reauth();
 for(const [body,status] of [[{...request,confirmed:false},400],[{...request,bootId:'stale'},409],[{...request,expectedRevision:0},409]])assert.equal((await h.post(BASE+'/restart',body)).status,status);
 assert.equal(h.exits,0);assert.equal(h.store.db.prepare('SELECT * FROM settings_restart').all().length,0);
 const r=await h.post(BASE+'/restart',request);assert.equal(r.status,200,r.text);assert.deepEqual(r.json.data.result,{accepted:true,bootId:'fixture-boot'});assert.equal(r.json.data.vm,null);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.exits,1);assert.equal((await h.get(BASE)).json.data.reauth.expiresAt,null);
 await h.reauth();const repeated=await h.post(BASE+'/restart',request);assert.equal(repeated.status,429);assert.ok(Number(repeated.headers.get('retry-after'))>0);assert.equal(h.exits,1);
 const audit=h.store.audit.recent().filter(x=>x.command==='settings.restart');assert.ok(audit.some(x=>x.outcome==='ok'));assert.ok(!JSON.stringify(audit).includes('fixture-boot'));
 // A replacement service sees the same DB cooldown, independently of the old
 // in-memory accepted flag. This is the exact state a new process will read.
 const {createSettings}=require('../../src/settings/service');const IC=require('../../src/instance-config');const second=createSettings({env:h.env,files:IC.readInstanceConfig(h.env),cfg:h.controller.cfg,engine:h.controller.engine,store:h.store,auth:h.auth,controller:h.controller,paths:require('../../src/config').openclawPaths(h.env),detect:()=>[],supervisor:{supported:true,command:null,reason:null,restart(){throw Error('must not exit')}},bootId:'next-boot',now:()=>h.clock.now,elapsed:()=>h.clock.elapsed});
 const req={headers:{cookie:h.cookie},body:{password:require('../helpers/settings-fixture').PASSWORD}},res={setHeader(){}};
 await second.run('reauth',req,res);req.body={...request,bootId:'next-boot'};await assert.rejects(second.run('restart',req,res),e=>e.code==='rate_limited');
});
test('unsupported and readonly restart never call a supervisor',async t=>{
 const h=await fixture(t,{supervisor:{supported:false,command:'fixture-command',reason:{key:'settings.restart.unsupervised'},restart(){throw Error('must not exit')}}});await h.reauth();assert.equal((await h.post(BASE+'/restart',request)).status,403);assert.equal((await h.get(BASE)).json.data.restart.command,'fixture-command');
 const ro=await fixture(t,{env:{PORTAL_READONLY_STORE:'1'}});assert.equal((await ro.get(BASE)).json.data.restart.supported,false);assert.equal((await ro.post(BASE+'/restart',request)).status,403);
});

test('aborted or failed responses cannot exit; confirmation expiry and CSRF prevent acceptance',async t=>{
 const h=await fixture(t);await h.reauth();
 const foreign=await h.request('POST',BASE+'/restart',request,{origin:'https://foreign.example.test'});assert.equal(foreign.status,403);assert.equal(h.exits,0);
 h.clock.elapsed+=300000;assert.equal((await h.post(BASE+'/restart',request)).status,403);await h.reauth();
 const req={headers:{cookie:h.cookie},body:request},res=new (require('node:events').EventEmitter)();res.statusCode=200;res.setHeader=()=>{};
 await h.settings.run('restart',req,res);res.emit('close');await new Promise(r=>setImmediate(r));assert.equal(h.exits,0);
 res.statusCode=500;res.emit('finish');await new Promise(r=>setImmediate(r));assert.equal(h.exits,0);
});
test('boot identity is stable in one process and differs in a real next process',()=>{
 const {execFileSync}=require('node:child_process'),file=require.resolve('../../src/ops/boot-identity');const source='const x=require(process.argv[1]);process.stdout.write(JSON.stringify([x.BOOT_ID,require(process.argv[1]).BOOT_ID]));';
 const read=()=>JSON.parse(execFileSync(process.execPath,['-e',source,file],{env:{PATH:'',HOME:require('node:os').tmpdir()},encoding:'utf8'}));const a=read(),b=read();assert.equal(a[0],a[1]);assert.equal(b[0],b[1]);assert.notEqual(a[0],b[0]);
});
