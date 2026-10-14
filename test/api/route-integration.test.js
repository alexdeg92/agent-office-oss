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
const {trackMounts,assertRouteCoverage}=require('../../src/security/route-policy');
const {requestId}=require('../../src/api/v2/errors');
const {auditMiddleware}=require('../../src/api/audit');
const {openSse}=require('../helpers/sse-client');
let hash;before(async()=>{hash=await hashPassword('synthetic-integration-password');});
async function fixture(t,{settings=null,externalAccess=null,orchestratorTeams=null,readonly=false,fullApp=false,apiOnly=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-router-integration-')),store=openStore({dir,instance:'test',ownerName:'Historical admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_integration',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'editor@example.invalid',name:'Éditeur actuel',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const user=store.users.byId(invite.user.id),engine=feed(createEngine(),loadScenario('synthetic-basic'));
  const auth=createAuth({secret:'synthetic-integration-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
  const cfg={instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,projectsOwners:['synthetic'],timeZone:'UTC',readonlyStore:readonly};
  const audit=auditMiddleware({store,sessionOf:req=>auth.sessionOf(req)});
  let app,api,setup;
  if(fullApp) {
    const {createApp}=require('../../src/api/http'),{createCsrfGuard}=require('../../src/api/csrf'),{createAgentTokenGate}=require('../../src/api/agent-token'),{createCredentialLinks}=require('../../src/api/credential-links');
    setup=require('../../src/api/v2/setup').createSetup({env:{PORTAL_EMAIL:'configured@example.invalid'},files:{config:null,secrets:null,paths:{dir,file:path.join(dir,'config.json'),secrets:path.join(dir,'secrets.json')}},paths:{},dataDir:dir,engine,log:()=>{}});
    const links=createCredentialLinks({store,auth});
    app=createApp({readonly:false,apiOnly,publicDir:dir,routeSecurity:{store,auth},audit,csrf:createCsrfGuard(),credentialLinks:links,
      tokenGate:createAgentTokenGate({tokens:store.tokens,audit:row=>store.audit.append(row),allowedAgent:()=>engine.primaryAgent()?.id,personOf:id=>store.persons.list().find(p=>p.links.agentId===id)?.id}),
      mountRoutes:a=>{
        require('../../src/ops/health').mountHealth(a,()=>({mode:'app',store,engine}));auth.mountRoutes(a,{isGwConnected:()=>true});links.mount(a);
        api=mountV2(a,{auth,store,engine,cfg,runtime:null,settings,setup,externalAccess,orchestratorTeams,enforceAuthorization:true});
      }});
  } else {
    app=trackMounts(express());app.use(requestId,express.json());
    // Exercise real audit behavior; this legacy fixture checks core route registrations only.
    app.use((req,res,next)=>audit(req,res,next));
    api=mountV2(app,{auth,store,engine,cfg,runtime:null,settings,externalAccess,orchestratorTeams,enforceAuthorization:true});
  }
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const cookie=row=>'taco_sess='+auth.signSession({email:row.email,userId:row.id,authGeneration:row.auth_generation,sid:'synthetic-'+row.id,exp:Date.now()+60000});
  const request=async(method,route,body,row=user)=>{
    const res=await fetch(base+route,{method,headers:{'content-type':'application/json',...(row?{cookie:cookie(row)}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();return {status:res.status,json:text?JSON.parse(text):null,requestId:res.headers.get('x-request-id')};
  };
  const set=(resource,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,resource,level);
  const cleanup=[];
  t.after(async()=>{for(const close of cleanup)close();setup?.close();api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,api,auth,store,engine,user,admin,ctx,request,set,cookie,base,cleanup};
}
test('real core router has a first guard on every registration in both aliases and implicit HEAD',async t=>{
  const f=await fixture(t),rows=assertRouteCoverage(f.app,f.store.registry);
  assert.ok(rows.length>100);assert.ok(rows.every(r=>r.policyFirst&&r.declarations.length===1));
  for(const version of [2,3]) {
    assert.ok(rows.some(r=>r.method==='HEAD'&&r.path==='/api/v'+version+'/views/office'));
    f.set('office','none');assert.equal((await f.request('HEAD','/api/v'+version+'/views/office')).status,403);
    assert.equal((await f.request('GET','/api/v'+version+'/views/office',undefined,null)).status,401);
  }
  assert.throws(()=>f.api.router.get('/undeclared',(req,res)=>res.json({secret:true})),/undeclared route/);
});
test('real routes reject denied reads and exact child commands before entity/adapter access',async t=>{
  const f=await fixture(t);let reads=0;
  const session=f.engine.session;f.engine.session=(...args)=>{reads++;return session(...args);};
  f.set('logs','none');f.set('flows','write');f.set('flows.run','none');
  for(const version of [2,3]) {
    for(const [method,p] of [['GET','/views/sessions/private'],['GET','/views/interlocutors/private'],['POST','/flows/private/runs']]) {
      const result=await f.request(method,'/api/v'+version+p,method==='POST'?{}:undefined);
      assert.equal(result.status,403);assert.equal(result.json.error.details[0].issue,'permission-denied');
    }
  }
  assert.equal(reads,0);assert.equal((await f.request('GET','/api/v3/views/project-candidates')).status,200);
});
test('actual HTTP topics, actor-specific me, command VMs, conflicts and revision reads share privacy rules',async t=>{
  const f=await fixture(t);f.set('logs','none');f.set('settings.runtimes','none');
  for(const version of [2,3]) {
    const me=await f.request('GET','/api/v'+version+'/me');assert.equal(me.status,200);assert.equal(me.json.data.user.personId,f.user.person_id);assert.equal(me.json.data.displayName,'Éditeur actuel');
    const office=await f.request('GET','/api/v'+version+'/views/office');assert.equal(office.status,200);assert.ok(office.json.data.occupants.every(o=>o.sessionKey===null));assert.deepEqual(office.json.meta.stale,[]);
    const created=await f.request('POST','/api/v'+version+'/projects',{name:'Projet privé',summary:'synthetic hidden summary'});assert.equal(created.status,200,JSON.stringify(created));
    const vm=created.json.data.vm;assert.equal(vm.summary,null);assert.equal(vm.summaryMeta,null);
    const actor=f.store.db.prepare("SELECT actor_json FROM audit_log WHERE command='projects.create' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(actor.actor_json).personId,f.user.person_id);
    const conflict=await f.request('PATCH','/api/v'+version+'/projects/'+vm.id,{expectedRevision:vm.revision+5,name:'Rejected'});assert.equal(conflict.status,409);assert.equal(conflict.json.error.current.vm.summary,null);
    const layout=await f.request('GET','/api/v'+version+'/office/layout');assert.equal(layout.status,200);assert.deepEqual(layout.json.data.layout.data.agents,[]);
    const revision=await f.request('GET','/api/v'+version+'/office/layout/revisions/'+layout.json.data.layout.revision);assert.equal(revision.status,200);assert.deepEqual(revision.json.data.data.agents,[]);
    const comment=await f.request('POST','/api/v'+version+'/projects/'+vm.id+'/comments',{body:'Un commentaire'});assert.equal(comment.status,201);assert.equal(comment.json.data.result.comment.author.id,f.user.person_id);assert.equal(comment.json.data.result.comment.editable,true);
    const adminThread=await f.request('GET','/api/v'+version+'/views/projects/'+vm.id+'/comments',undefined,f.admin);assert.equal(adminThread.status,200);assert.equal(adminThread.json.data.items[0].deletable,false);
    const deniedDelete=await f.request('DELETE','/api/v'+version+'/projects/'+vm.id+'/comments/'+comment.json.data.result.comment.id,{},f.admin);assert.equal(deniedDelete.status,403);
  }
});
test('session projection collapses repeated canonical event ids before v2 and v3 collection validation',async t=>{
  const f=await fixture(t),session=f.engine.sessions()[0],at=Date.now();
  const senderInfo={kind:'agent',id:'agent:main:main',name:null,runtime:'openclaw',channel:null,avatarHint:null};
  const trace={sessionKey:session.key,fetchedAt:at,messageCount:2,window:{from:0,to:2},events:[
    {id:'ev:0:0',kind:'user',at,senderInfo,text:'First child completion',sender:null,truncated:false},
    {id:'ev:0:0',kind:'user',at:at+1,senderInfo,text:'Redelivered child completion',sender:null,truncated:false},
  ]};
  const ingested=f.engine.ingestCanonical('transcript',trace,{key:session.key});
  assert.equal(ingested.ok,true,JSON.stringify(ingested.issues));
  f.engine.setReads({transcript:async()=>({ok:true})});
  const {VM_SCHEMAS,VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas'),validate=require('../../src/schema').validate;
  for(const version of [2,3]){
    const response=await f.request('GET',`/api/v${version}/views/sessions/${encodeURIComponent(session.key)}`);
    assert.equal(response.status,200,JSON.stringify(response.json));
    const vm=response.json.data;
    assert.deepEqual(vm.events.map(event=>event.id),['ev:0:0']);
    assert.equal(vm.events[0].text,'First child completion');
    assert.equal(validate((version===3?VM_SCHEMAS_V3:VM_SCHEMAS).session,vm).ok,true);
  }
});
test('actual RBAC Office responses withhold session overflow from readers without logs in v2 and v3',async t=>{
  const f=await fixture(t),primary=f.engine.primaryAgent();
  assert.ok(primary);
  assert.equal(f.store.policy.can(f.admin,'logs','read'),true,'owner principal has the logs grant');
  const base=f.engine.sessions()[0];assert.ok(base,'scenario supplies a canonical session template');
  const rows=Array.from({length:80},(_,i)=>{
    const row=structuredClone(base);
    row.key='private-conversation-'+i;row.sessionId=null;row.class={...row.class,kind:'conversation-direct',agentId:primary.id,subagentId:null,heartbeatOf:null};
    row.usage={total:1,input:null,output:null};row.updatedAt=Date.now();
    row.interactive=true;
    row.run={...row.run,status:'running',evidence:'status-field',evidenceLevel:'verified',observedAt:Date.now(),expiresAt:Date.now()+3600000,startedAt:Date.now(),endedAt:null};
    return row;
  });
  const ingested=f.engine.ingestCanonical('sessions.snapshot',rows);
  assert.equal(ingested.ok,true,JSON.stringify(ingested.issues));
  assert.equal(f.engine.sessions().length,80);
  f.set('logs','none');
  for(const version of [2,3]) {
    const restricted=await f.request('GET','/api/v'+version+'/views/office');
    assert.equal(restricted.status,200,JSON.stringify(restricted));
    assert.equal(Object.hasOwn(restricted.json.data,'occupantOverflowCount'),false);
    assert.equal(restricted.json.data.conversationCount,0);
    assert.deepEqual(restricted.json.data.conversationIds,[]);
    const authorized=await f.request('GET','/api/v'+version+'/views/office',undefined,f.admin);
    assert.equal(authorized.status,200,JSON.stringify(authorized));
    assert.ok(authorized.json.data.occupantOverflowCount>0,`logs reader receives the full-population overflow: ${JSON.stringify({count:authorized.json.data.conversationCount,occupants:authorized.json.data.occupants.length,overflow:authorized.json.data.occupantOverflowCount})}`);
    assert.equal(authorized.json.data.conversationCount,authorized.json.data.conversationIds.length);
    assert.ok(authorized.json.data.conversationCount>0);
  }
});
test('real async response boundary discards output after identity or permission revocation',async t=>{
  const f=await fixture(t);f.set('logs','read');
  for(const kind of ['permission','generation']) {
    const key=f.engine.sessions()[0].key;
    let started,finish;
    const entered=new Promise(resolve=>{started=resolve;}),deferred=new Promise(resolve=>{finish=resolve;});
    f.engine.request=async()=>{started();await deferred;return {ok:true};};
    const pending=f.request('GET','/api/v2/views/sessions/'+encodeURIComponent(key));
    await entered;
    if(kind==='permission')f.set('logs','none');else f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id);
    finish();const result=await pending;
    assert.equal(result.status,kind==='permission'?403:401);assert.equal(result.json.data,undefined);
    if(kind==='permission')f.set('logs','read');
  }
});
test('saving or restoring a redacted layout preserves withheld matching rules; attempted rule edits are denied',async t=>{
  const f=await fixture(t);f.set('logs','none');
  const {asVersion}=require('../../src/api/v2/office-layout');
  for(const version of [2,3]) {
    const response=await f.request('GET','/api/v'+version+'/office/layout'),layout=response.json.data.layout;
    const baseline=structuredClone(asVersion(f.api.office.active().data,3).agents);assert.ok(baseline.length>0);
    assert.deepEqual(layout.data.agents,[]);
    const saved=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:layout.revision,data:layout.data});
    assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(saved.json.data.vm.layout.data.agents,[]);
    assert.deepEqual(asVersion(f.api.office.active().data,3).agents,baseline);
    const restore=await f.request('GET','/api/v'+version+'/office/layout/revisions/'+layout.revision);
    const restored=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:saved.json.data.revision,data:restore.json.data.data});
    assert.equal(restored.status,200);assert.deepEqual(asVersion(f.api.office.active().data,3).agents,baseline);
    const attempt={...layout.data,agents:[asVersion({agents:baseline},version).agents[0]]};
    const denied=await f.request('PUT','/api/v'+version+'/office/layout',{expectedRevision:restored.json.data.revision,data:attempt});
    assert.equal(denied.status,403);assert.deepEqual(denied.json.error.details,[{field:'agents',issue:'permission-denied'}]);
    assert.deepEqual(asVersion(f.api.office.active().data,3).agents,baseline);
  }
});
test('mounted Settings detection projects duplicate result inventories and actual self-account fields',async t=>{
  const raw=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/architecture/examples/settings/settings-vm.json'),'utf8')).data;
  const settings={vm:()=>structuredClone(raw),run:async()=>({ok:true,result:{runtimes:raw.runtimes,agents:raw.agents},revision:raw.revision,vm:structuredClone(raw)}),close:()=>{}};
  const f=await fixture(t,{settings});f.set('settings.runtimes','write');f.set('store','none');
  const response=await f.request('POST','/api/v3/settings/detect',{});assert.equal(response.status,200);
  const value=response.json.data;
  assert.deepEqual(value.result.agents,value.vm.agents);assert.deepEqual(value.result.runtimes,value.vm.runtimes);
  assert.equal(value.vm.owner.email.value,f.user.email);assert.equal(value.vm.instance,null);assert.equal(value.vm.network,null);
  assert.ok(value.result.agents.every(a=>a.lookRoute===null&&a.integrations.length===0));
});
test('external access routes enforce cookie/RBAC policy and plan/apply the reviewed digest over real HTTP',async t=>{
  let revision=4,stored=null,accessRevision=0,appliedBody=null;
  const raw=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/architecture/examples/settings/settings-vm.json'),'utf8')).data;
  const settings={vm:()=>structuredClone(raw),revision:()=>revision,accessConfig:()=>stored,accessRevision:()=>accessRevision,
    run:async(name,req)=>{assert.equal(name,'access');appliedBody=structuredClone(req.body);stored=structuredClone(req.body.draft);accessRevision++;revision++;return {ok:true,result:{changed:['access'],restartRequired:true},revision,vm:null};},close:()=>{}};
  const externalAccess=require('../../src/access/service').createExternalAccessService({settings,cfg:{},files:{},env:{}});
  const f=await fixture(t,{settings,externalAccess});
  assert.equal((await f.request('GET','/api/v3/settings/access',undefined,null)).status,401);
  f.set('settings.network','read');
  const rows=assertRouteCoverage(f.app,f.store.registry);
  assert.ok(rows.some(row=>row.method==='GET'&&row.path==='/api/v3/settings/access'));
  for(const route of ['/settings/access/plan','/settings/access/checks','/settings/access/checks/status','/settings/access/checks/cancel','/settings/access/apply']) {
    assert.ok(rows.some(row=>row.method==='POST'&&row.path==='/api/v3'+route),route);
  }
  const state=await f.request('GET','/api/v3/settings/access');assert.equal(state.status,200,JSON.stringify(state));
  assert.deepEqual(require('../helpers/contract-shape').compareExample('external-access-vm',state.json.data,{version:3}),[]);
  assert.equal(state.json.data.choices.modes.find(mode=>mode.id==='public-same-origin').labelKey,'access.mode.public-same-origin');
  assert.equal(state.json.data.choices.modes.find(mode=>mode.id==='public-split-origin').labelKey,'access.mode.public-split-origin');
  const local=require('../../docs/architecture/examples/v3/external-access-setup-vm.json').data.draft;
  const denied=await f.request('POST','/api/v3/settings/access/plan',{settingsRevision:revision,draft:local});assert.equal(denied.status,403);
  f.set('settings.network','write');
  const planned=await f.request('POST','/api/v3/settings/access/plan',{settingsRevision:revision,draft:local});
  assert.equal(planned.status,200,JSON.stringify(planned));
  assert.deepEqual(require('../helpers/contract-shape').compareExample('external-access-plan',planned.json.data,{version:3}),[]);
  const result=planned.json.data.result;
  const mismatch=await f.request('POST','/api/v3/settings/access/apply',{planId:result.planId,settingsRevision:revision,confirmation:{configDigest:'0'.repeat(64)}});
  assert.equal(mismatch.status,409,JSON.stringify(mismatch));
  const applied=await f.request('POST','/api/v3/settings/access/apply',{planId:result.planId,settingsRevision:revision,confirmation:{configDigest:result.configDigest}});
  assert.equal(applied.status,200,JSON.stringify(applied));assert.equal(appliedBody.configDigest,result.configDigest);
  assert.equal(appliedBody.expectedRevision,4);assert.equal(stored.mode,'local');
  const committed=applied.json.data.result;
  assert.equal(committed.vm.settingsRevision,5,'apply returns the committed global Settings revision');
  assert.equal(committed.vm.savedRevision,1,'apply returns the saved access revision');
  assert.equal(committed.vm.activeRevision,0,'apply does not claim that an unapplied runtime policy is active');
  assert.equal(committed.vm.pendingActivation,true);
  assert.equal(committed.restartRequired,true);
  assert.deepEqual(committed.changed,['access']);
  assert.equal(committed.vm.draft.mode,'local');
});
const fakeSettings=()=>({vm:()=>{throw new Error('not requested');},run:()=>{throw new Error('owner-only reauth path entered');},close:()=>{}});
function confirmed(action,target,name,body) {
  const {expectedRevision,...changes}=body;return {...body,confirmation:{action,target,name,revision:expectedRevision,changes}};
}
async function reauth(f,row=f.admin) {
  const response=await f.request('POST','/api/v3/settings/reauth',{password:'synthetic-integration-password'},row);assert.equal(response.status,200,JSON.stringify(response));return response;
}
test('management HTTP separates read/write, actual-user password proof, named changes, strict bodies and v3 scope',async t=>{
  const f=await fixture(t,{settings:fakeSettings()});
  assert.equal((await f.request('GET','/api/v3/users')).status,403);
  const list=await f.request('GET','/api/v3/users?limit=1',undefined,f.admin);assert.equal(list.status,200);assert.equal(list.json.data.items.length,1);assert.equal(list.json.data.nextOffset,1);
  assert.doesNotMatch(JSON.stringify(list.json),/password_hash|token_hash|auth_generation/);
  assert.equal((await f.request('GET','/api/v3/users?limit=101',undefined,f.admin)).status,400);
  assert.equal((await f.request('GET','/api/v2/users',undefined,f.admin)).status,404);
  const roles=await f.request('GET','/api/v3/roles',undefined,f.admin);assert.equal(roles.status,200);
  const registry=await f.request('GET','/api/v3/permissions/resources',undefined,f.admin);assert.equal(registry.status,200);assert.ok(registry.json.data.items.every(r=>typeof r.available==='boolean'));
  const body={expectedRevision:0,name:'Équipe',permissions:[{resource:'office',level:'read'}]},candidate=confirmed('roles.create','new-role','Équipe',body);
  const unconfirmed=await f.request('POST','/api/v3/roles',candidate,f.admin);assert.equal(unconfirmed.status,403);assert.equal(unconfirmed.json.error.details[0].issue,'reauth-required');
  await reauth(f);
  assert.equal((await f.request('POST','/api/v3/roles',body,f.admin)).status,403);
  assert.equal((await f.request('POST','/api/v3/roles',{...candidate,permissions:[{resource:'users',level:'write'}]},f.admin)).status,403,'unconfirmed privilege changes are denied');
  assert.equal((await f.request('POST','/api/v3/roles',{...candidate,actor:'spoof'},f.admin)).status,400);
  const created=await f.request('POST','/api/v3/roles',candidate,f.admin);assert.equal(created.status,200);assert.equal(created.json.data.result.name,'Équipe');
  const audits=f.store.audit.recent().filter(row=>row.command==='roles.create');assert.equal(audits.filter(row=>row.outcome==='ok').length,1);assert.ok(audits.some(row=>row.outcome==='rejected'));assert.ok(audits.every(row=>row.actor.personId===f.admin.person_id));
  f.set('users','read');assert.equal((await f.request('GET','/api/v3/users')).status,200);
  assert.equal((await f.request('POST','/api/v3/roles',candidate)).status,403,'users read never grants management writes');
  const listed=await f.request('GET','/api/v3/roles',undefined,f.admin);assert.deepEqual(listed.json.data.items.find(r=>r.id===created.json.data.result.id).permissions,[{resource:'office',mode:'explicit',level:'read'}]);
  const role=created.json.data.result,stale={expectedRevision:role.revision+1,name:'Stale',permissions:[]};
  const refused=await f.request('PUT','/api/v3/roles/'+role.id,confirmed('roles.edit',role.id,role.name,stale),f.admin);assert.equal(refused.status,409);
});
test('HTTP invitations, role assignment/overrides and targeted resets preserve revisions, last-admin and audit invariants',async t=>{
  const f=await fixture(t,{settings:fakeSettings()});await reauth(f);
  const body={expectedRevision:0,email:'invite@example.invalid',name:'Invitée',roleId:'rol_reader'};
  const issued=await f.request('POST','/api/v3/users/invitations',confirmed('users.invite',body.email,body.name,body),f.admin);assert.equal(issued.status,200);assert.match(issued.json.data.result.token,/^ao_inv_/);
  const duplicate={...body,email:'INVITE@example.invalid'};
  await reauth(f);
  const duplicateResponse=await f.request('POST','/api/v3/users/invitations',confirmed('users.invite',body.email,duplicate.name,duplicate),f.admin);
  assert.equal(duplicateResponse.status,409,JSON.stringify(duplicateResponse));assert.equal(duplicateResponse.json.error.details[0].issue,'email-in-use');
  const target=issued.json.data.result.user;
  const resendBody={expectedRevision:target.revision};
  const resend=await f.request('POST','/api/v3/users/'+target.id+'/invitation',confirmed('users.resendInvitation',target.id,target.name,resendBody),f.admin);assert.equal(resend.status,200);assert.notEqual(resend.json.data.result.token,issued.json.data.result.token);
  const input={expectedRevision:1,roleId:'rol_admin'};
  const promoted=await f.request('PATCH','/api/v3/users/'+f.user.id,confirmed('users.edit',f.user.id,'Éditeur actuel',input),f.admin);assert.equal(promoted.status,200);
  const self={expectedRevision:1,roleId:'rol_editor'};
  const demoted=await f.request('PATCH','/api/v3/users/'+f.admin.id,confirmed('users.edit',f.admin.id,'Historical admin',self),f.admin);assert.equal(demoted.status,200);
  assert.equal((await f.request('GET','/api/v3/users',undefined,f.admin)).status,403);
  const newAdmin=f.store.users.byId(f.user.id);await reauth(f,newAdmin);
  const last={expectedRevision:2,status:'disabled'};
  const blocked=await f.request('PATCH','/api/v3/users/'+newAdmin.id,confirmed('users.edit',newAdmin.id,'Éditeur actuel',last),newAdmin);assert.equal(blocked.status,409);assert.equal(blocked.json.error.details[0].issue,'last-active-admin');
  const reset={expectedRevision:2};
  const resetResult=await f.request('POST','/api/v3/users/'+f.admin.id+'/password-reset',confirmed('users.passwordReset',f.admin.id,'Historical admin',reset),newAdmin);assert.equal(resetResult.status,200);assert.match(resetResult.json.data.result.token,/^ao_rst_/);
  assert.ok(f.store.users.byId(f.admin.id).auth_generation>f.admin.auth_generation);
  assert.equal((await f.request('GET','/api/v3/users',undefined,f.admin)).status,401);
  assert.doesNotMatch(JSON.stringify(f.store.audit.recent()),/ao_inv_|ao_rst_/);
});
test('management readonly denials make no mutation and are audited',async t=>{
  const f=await fixture(t,{settings:fakeSettings(),readonly:true});await reauth(f);
  const body={expectedRevision:0,name:'Read only',permissions:[]};
  const response=await f.request('POST','/api/v3/roles',confirmed('roles.create','new-role',body.name,body),f.admin);assert.equal(response.status,403);assert.equal(response.json.error.code,'readonly');
  assert.equal(f.store.rbac.roles().length,3);assert.equal(f.store.audit.recent().find(row=>row.command==='roles.create').outcome,'rejected');
});
test('team project comments require teams.read and mask inaccessible ids as not found',async t=>{
  const {projectId}=require('../../src/projects/orchestrator-teams');
  const teamId='team:comment-permission-fixture', id=projectId(teamId), now=Date.now();
  const orchestratorTeams={hasTeamStore:true,teamCapabilities:{teamTasks:{read:true,write:false}},
    getSnapshot:()=>({revision:1,observedAt:now,team:{id:teamId,label:'Private fixture team',status:'active',observedAt:now},
      hosts:[],orchestrators:[],agents:[],identityLinks:[],members:[],tasks:[],reviews:[]})};
  const f=await fixture(t,{orchestratorTeams});
  for(const version of [2,3]) {
    const visible=await f.request('GET',`/api/v${version}/views/projects/${encodeURIComponent(id)}/comments`,undefined,f.admin);
    assert.equal(visible.status,200,JSON.stringify(visible));assert.deepEqual(visible.json.data.items,[]);
    const hidden=await f.request('GET',`/api/v${version}/views/projects/${encodeURIComponent(id)}/comments`,undefined,f.user);
    const unknown=await f.request('GET',`/api/v${version}/views/projects/${encodeURIComponent(projectId('team:unknown'))}/comments`,undefined,f.user);
    assert.equal(hidden.status,404,JSON.stringify(hidden));assert.equal(hidden.status,unknown.status);
    const stream=openSse(f.base,`/api/v${version}/stream?topics=${encodeURIComponent('comments:'+id)}`,{cookie:f.cookie(f.user)});
    f.cleanup.push(()=>stream.close());
    const hello=await stream.next(frame=>frame.event==='hello');
    assert.ok(hello.data.rejected.some(row=>row.topic==='comments:'+encodeURIComponent(id)),JSON.stringify(hello.data));
  }
});
test('management HTTP audit failure rolls back the mutation, and Settings exposes only the current session proof',async t=>{
  const raw=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/architecture/examples/settings/settings-vm.json'),'utf8')).data;
  const settings={...fakeSettings(),vm:()=>structuredClone(raw)};
  const f=await fixture(t,{settings});const proof=await reauth(f);
  const mine=await f.request('GET','/api/v3/settings',undefined,f.admin),other=await f.request('GET','/api/v3/settings');
  assert.equal(mine.json.data.reauth.expiresAt,proof.json.data.result.expiresAt);assert.equal(other.json.data.reauth.expiresAt,null);
  const original=f.store.audit.append;let failed=false;
  f.store.audit.append=row=>{if(row.command==='roles.create'&&row.outcome==='ok'&&!failed){failed=true;throw new Error('synthetic audit failure');}return original(row);};
  const body={expectedRevision:0,name:'Rollback',permissions:[{resource:'users',level:'write'}]};
  const response=await f.request('POST','/api/v3/roles',confirmed('roles.create','new-role',body.name,body),f.admin);assert.equal(response.status,500);assert.equal(f.store.rbac.roles().length,3);
  assert.equal(f.store.audit.recent().find(row=>row.command==='roles.create').outcome,'failed');
});
test('real mount SSE sends the same projection as HTTP and immediately closes on role invalidation',async t=>{
  const f=await fixture(t);f.set('logs','none');
  for(const version of [2,3]) {
    const stream=openSse(f.base,'/api/v'+version+'/stream?topics=office,logs',{cookie:f.cookie(f.user)});f.cleanup.push(()=>stream.close());
    const hello=await stream.next(frame=>frame.event==='hello');assert.equal(hello.data.rejected.some(item=>item.topic==='logs'&&item.issue==='permission-denied'),true);
    const snapshot=await stream.next(frame=>frame.event==='snapshot'&&frame.data.topic==='office');
    const http=await f.request('GET','/api/v'+version+'/views/office');assert.deepEqual(snapshot.data.data,http.json.data);
  }
  f.store.userManagement.editRole('rol_editor',{expectedRevision:1,name:'Éditeurs',permissions:[{resource:'office',level:'none'}]},f.ctx);
  assert.equal(f.api.hubs[2]._streams.size,0);assert.equal(f.api.hubs[3]._streams.size,0);
});

test('mounted role reset audits its declared action once, with typed changes, and rolls back on audit failure',async t=>{
  const f=await fixture(t,{settings:fakeSettings()});
  f.store.userManagement.editRole('rol_reader',{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx);
  assert.equal(f.store.audit.recent().filter(row=>row.command==='roles.edit'&&row.target==='rol_reader'&&row.outcome==='ok').length,1);
  await reauth(f);const role=f.store.rbac.role('rol_reader');
  const reset=await f.request('POST','/api/v3/roles/rol_reader/reset',confirmed('roles.reset',role.id,role.name,{expectedRevision:role.revision}),f.admin);
  assert.equal(reset.status,200,JSON.stringify(reset));
  const audits=f.store.audit.recent().filter(row=>row.requestId===reset.requestId&&row.outcome==='ok');
  assert.equal(audits.length,1);assert.equal(audits[0].command,'roles.reset');assert.equal(audits[0].actor.personId,f.admin.person_id);assert.equal(audits[0].target,role.id);
  const changes=JSON.parse(f.store.db.prepare('SELECT changes_json FROM permission_audit_changes WHERE audit_id=?').get(audits[0].id).changes_json);
  assert.equal(changes.roleId,role.id);assert.ok(changes.before.some(g=>g.resource==='office'&&g.mode==='explicit'&&g.level==='none'));assert.ok(changes.after.some(g=>g.resource==='office'&&g.level==='read'));
  const before=JSON.stringify(f.store.userManagement.roles().find(row=>row.id===role.id)),append=f.store.audit.append;
  f.store.audit.append=row=>{if(row.command==='roles.reset'&&row.outcome==='ok')throw new Error('synthetic reset audit failure');return append(row);};
  const rejected=await f.request('POST','/api/v3/roles/rol_reader/reset',confirmed('roles.reset',role.id,role.name,{expectedRevision:reset.json.data.result.revision}),f.admin);
  assert.equal(rejected.status,500);assert.equal(JSON.stringify(f.store.userManagement.roles().find(row=>row.id===role.id)),before);
  assert.equal(f.store.audit.recent().filter(row=>row.requestId===rejected.requestId&&row.command==='roles.reset'&&row.outcome==='failed').length,1);
  assert.equal(f.store.audit.recent().filter(row=>row.requestId===rejected.requestId&&row.outcome==='ok').length,0);
});

test('complete configured createApp covers middleware, public/self/credential routes, setup, static/API-only and implicit OPTIONS',async t=>{
  const {assertCompleteCoverage}=require('../../src/security/route-policy');
  for(const apiOnly of [false,true]) {
    const f=await fixture(t,{fullApp:true,apiOnly}),rows=assertCompleteCoverage(f.app,f.store.registry);
    for(const kind of ['public','self','setup','permissions','audit','fallback'])assert.ok(rows.some(r=>r.declarations[0].kind===kind),kind);
    assert.ok(rows.some(r=>r.method==='USE'&&r.id==='http.json'));assert.ok(rows.some(r=>r.method==='USE'&&r.id==='api.projectionError'));
    assert.ok(rows.some(r=>r.method==='OPTIONS'&&r.path==='/api/v3/views/logs'));assert.ok(rows.some(r=>r.method==='HEAD'&&r.path==='/api/v2/views/logs'));
    for(const version of [2,3]) {
      assert.ok(rows.some(r=>r.path==='/api/v'+version+'/setup/owner'));assert.equal((await f.request('GET','/api/v'+version+'/setup',undefined,null)).status,200);
      f.set('logs','none');assert.equal((await f.request('GET','/api/v'+version+'/views/logs')).status,403);
      assert.equal((await f.request('OPTIONS','/api/v'+version+'/views/logs')).status,404,'typed router fallback precedes automatic discovery');
    }
    assert.equal((await f.request('GET','/healthz',undefined,null)).status,200);assert.equal((await f.request('GET','/api/me')).json.email,f.user.email);
    assert.throws(()=>f.app.get('/api/undeclared',(req,res)=>res.json({secret:true})),/undeclared route/);
    f.app.use('/api/canary',(req,res)=>res.json({secret:true}));
    assert.throws(()=>assertCompleteCoverage(f.app,f.store.registry),/undeclared middleware \/api\/canary/);
  }
});
test('independent complete-app coverage rejects nested terminating use handlers and unguarded explicit OPTIONS',async t=>{
  const {assertCompleteCoverage,trackMounts,exceptionMiddleware}=require('../../src/security/route-policy');
  const f=await fixture(t,{fullApp:true});
  const nested=trackMounts(express.Router());nested.use('/leak',(req,res)=>res.json({secret:true}));f.app.use(['/api/v2','/api/v3'],nested);
  assert.throws(()=>assertCompleteCoverage(f.app,f.store.registry),/undeclared middleware \/api\/v2\/leak/);
  assert.throws(()=>f.app.use(/^\/api/,express.Router()),/nonliteral middleware mount/);
  assert.throws(()=>exceptionMiddleware('guessed-exception',(req,res)=>res.json({secret:true})),/unknown middleware exception/);
  const g=await fixture(t,{fullApp:true});
  g.app.route('/api/options-canary').options((req,res)=>res.json({secret:true}));
  assert.throws(()=>assertCompleteCoverage(g.app,g.store.registry),/missing or duplicate route policy OPTIONS/);
});
