'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {openStore}=require('../../src/store');
const {createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed');
const {loadScenario}=require('../helpers/scenario');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
const {mountV2}=require('../../src/api/v2/routes');
const {trackMounts}=require('../../src/security/route-policy');
const {requestId}=require('../../src/api/v2/errors');
let hash;before(async()=>{hash=await hashPassword('synthetic-integration-password');});
async function fixture(t,{settings=null,readonly=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-router-integration-')),store=openStore({dir,instance:'test',ownerName:'Historical admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_integration',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'editor@example.invalid',name:'Éditeur actuel',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const user=store.users.byId(invite.user.id),engine=feed(createEngine(),loadScenario('synthetic-basic'));
  const auth=createAuth({secret:'synthetic-integration-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
  const cfg={instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,projectsOwners:['synthetic'],timeZone:'UTC',readonlyStore:readonly};
  const app=trackMounts(express());app.use(requestId,express.json());
  const api=mountV2(app,{auth,store,engine,cfg,runtime:null,settings,enforceAuthorization:true});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const cookie=row=>'taco_sess='+auth.signSession({email:row.email,userId:row.id,authGeneration:row.auth_generation,sid:'synthetic-'+row.id,exp:Date.now()+60000});
  const request=async(method,route,body,row=user)=>{
    const res=await fetch(base+route,{method,headers:{'content-type':'application/json',...(row?{cookie:cookie(row)}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();return {status:res.status,json:text?JSON.parse(text):null};
  };
  const set=(resource,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,resource,level);
  const cleanup=[];
  t.after(async()=>{for(const close of cleanup)close();api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,api,auth,store,engine,user,admin,ctx,request,set,cookie,base,cleanup};
}
test('switch-on logs readers and admins edit agent rules; withheld users preserve rules and cannot edit them',async t=>{
  const f=await fixture(t),{asVersion}=require('../../src/api/v2/office-layout');
  for(const version of [2,3]) {
    for(const row of [f.user,f.admin]) {
      const layout=(await f.request('GET','/api/v'+version+'/office/layout',undefined,row)).json.data.layout;
      assert.ok(layout.data.agents.length>0);
      const next=structuredClone(layout.data),name='Robot '+version+' '+(row===f.admin?'admin':'lecteur');
      next.agents[0].name=name;
      const saved=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:layout.revision,data:next},row);
      assert.equal(saved.status,200,JSON.stringify(saved));
      assert.equal(asVersion(f.api.office.active().data,3).agents[0].name,name);
    }
    f.set('logs','none');
    const layout=(await f.request('GET','/api/v'+version+'/office/layout')).json.data.layout;
    const baseline=structuredClone(asVersion(f.api.office.active().data,3).agents);
    assert.deepEqual(layout.data.agents,[]);
    const saved=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:layout.revision,data:layout.data});
    assert.equal(saved.status,200,JSON.stringify(saved));
    assert.deepEqual(asVersion(f.api.office.active().data,3).agents,baseline);
    const attempted={...layout.data,agents:asVersion({agents:baseline},version).agents};
    attempted.agents[0].name='Modification interdite';
    const denied=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:saved.json.data.revision,data:attempted});
    assert.equal(denied.status,403);assert.deepEqual(asVersion(f.api.office.active().data,3).agents,baseline);
    f.set('logs','read');
  }
});
test('switch-on flow history and candidate scans require explicit read authority and remain available to authorized users',async t=>{
  const f=await fixture(t),job=f.engine.cronJobs()[0];assert.ok(job);
  const pulls=[];let scans=0;
  f.engine.request=async(op,key)=>{pulls.push({op,key});return {ok:true};};
  f.api.projects.service.views.candidates=async()=>{scans++;return {scannedAt:Date.now(),candidates:[]};};
  for(const version of [2,3]) {
    f.set('logs','read');f.set('settings.runtimes','read');
    for(const row of [f.user,f.admin]) {
      const before=pulls.length,flow=await f.request('GET','/api/v'+version+'/views/flows/'+encodeURIComponent(job.id),undefined,row);
      assert.equal(flow.status,200,JSON.stringify(flow));assert.equal(pulls.length,before+1);assert.deepEqual(pulls.at(-1),{op:'flowRuns',key:job.id});
      assert.ok(flow.json.data.runs.length>0,'authorized users retain actual run history');
      const scansBefore=scans,candidates=await f.request('GET','/api/v'+version+'/views/project-candidates',undefined,row);
      assert.equal(candidates.status,200);assert.equal(scans,scansBefore+1);
    }
    f.set('logs','none');
    const before=pulls.length,flow=await f.request('GET','/api/v'+version+'/views/flows/'+encodeURIComponent(job.id));
    assert.equal(flow.status,200);assert.deepEqual(flow.json.data.runs,[]);assert.equal(pulls.length,before);
    const scansBefore=scans,hidden=await f.request('GET','/api/v'+version+'/views/project-candidates');
    assert.equal(hidden.status,200);assert.deepEqual(hidden.json.data.candidates,[]);assert.equal(scans,scansBefore);
    f.set('logs','read');f.set('settings.runtimes','none');
    const noRuntime=await f.request('GET','/api/v'+version+'/views/project-candidates');
    assert.equal(noRuntime.status,200);assert.equal(scans,scansBefore,'runtime withholding also prevents scanning');
  }
});

test('real discovery scan rechecks before each owner/folder dispatch and before publishing import candidates on both aliases',async t=>{
  const {createProjectService}=require('../../src/projects');
  const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  for(const version of [2,3])for(const boundary of ['owner','remote','sessionGroups']) {
    const f=await fixture(t);f.set('settings.runtimes','read');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-discovery-authority-'));f.cleanup.push(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'synthetic-repo','.git'),{recursive:true});
    const started=defer(),finish=defer(),calls=[];
    let pause=false;
    const sources={owners:['synthetic','other'],root,
      exec:async argv=>{
        calls.push(argv);
        if(pause&&(boundary==='owner'&&argv[0]==='gh'||boundary==='remote'&&argv.includes('remote'))) {started.resolve();await finish.promise;}
        return {code:0,stdout:argv[0]==='gh'?JSON.stringify([{name:pause?'revoked-only':'synthetic-repo',url:'https://github.com/'+argv[3]+'/'+(pause?'revoked-only':'synthetic-repo')}]):argv.includes('remote')?'https://github.com/synthetic/synthetic-repo':'2026-10-10T00:00:00Z'};
      },
      sessionGroups:async()=>{if(pause&&boundary==='sessionGroups'){started.resolve();await finish.promise;}return [];}};
    const service=createProjectService({repository:f.api.projects.repository,sources});
    f.api.projects.service.views.candidates=service.views.candidates;
    f.api.projects.service.commands.importCandidates=service.commands.importCandidates;
    const positive=await f.request('GET','/api/v'+version+'/views/project-candidates');assert.equal(positive.status,200,JSON.stringify(positive));
    assert.equal(calls.filter(a=>a[0]==='gh').length,2);assert.equal(calls.filter(a=>a[0]==='git').length,2);assert.ok(positive.json.data.candidates.length);
    const retained=positive.json.data.candidates[0].key;
    calls.length=0;pause=true;
    const pending=f.request('GET','/api/v'+version+'/views/project-candidates');await started.promise;f.set('logs','none');finish.resolve();
    const denied=await pending;assert.equal(denied.status,403,JSON.stringify(denied));assert.equal((await f.request('POST','/api/v'+version+'/projects/import',{keys:[retained]})).status,403,'lower reader cannot consume a privileged cached candidate');
    f.set('logs','read');
    const imported=await f.request('POST','/api/v'+version+'/projects/import',{keys:[retained]});assert.equal(imported.status,200,JSON.stringify(imported));assert.ok(imported.json.data.result.created.length,'revoked result cannot replace latest import candidates');
    if(boundary==='owner')assert.equal(calls.length,1,'no subsequent owner or workspace scan');
    if(boundary==='remote')assert.equal(calls.filter(a=>a[0]==='git').length,1,'no subsequent git log');
    pause=false;
    for(const resource of ['logs','flows','settings.runtimes']) {
      f.set('logs','read');f.set('flows','read');f.set('settings.runtimes','read');f.set(resource,'none');
      const count=calls.length,hidden=await f.request('GET','/api/v'+version+'/views/project-candidates');assert.equal(hidden.status,200);assert.deepEqual(hidden.json.data.candidates,[]);assert.equal(calls.length,count);
    }
  }
});
