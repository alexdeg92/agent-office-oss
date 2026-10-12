'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
const {hashPassword}=require('../../src/security/password');
const {createViewProjection,REQUIREMENTS}=require('../../src/security/view-projection');
const {schemasFor}=require('../../src/api/v2/vm/schemas');
const {validate}=require('../../src/schema');
const {EventEmitter}=require('node:events');
const express=require('express');
const {createAuth}=require('../../src/auth');
const {createVersionedTopics}=require('../../src/api/v2/topics');
const {createStreamHub}=require('../../src/api/v2/stream');
const {createStreamPolicy}=require('../../src/security/stream-policy');
const {TOPICS,ROUTES}=require('../../src/security/route-declarations');
const {declareRoute,trackMounts,assertRouteCoverage}=require('../../src/security/route-policy');
const {errorMiddleware}=require('../../src/api/v2/errors');
const EX=path.resolve(__dirname,'../../docs/architecture/examples');
const FILES={meta:'meta-vm',office:'office-vm',flows:'flow-list-vm',flow:'flow-detail-vm',access:'access-vm',interlocutor:'interlocutor-vm',logs:'logs-page',session:'session-vm',skills:'skill-list-vm',skill:'skill-detail-vm',health:'health-vm',projects:'board-vm',project:'project-vm',history:'history-page',candidates:'candidates-vm',layout:'layout-vm',comments:'comment-thread-vm',orchestrators:'orchestrators-vm',teams:'teams-vm'};
const me=()=>({email:'historical@example.invalid',displayName:'Historical owner',gateway:'up',capabilities:{openclawWrites:true,storeWrites:true},sessionExpiresAt:Date.now()+60000});
const example=(name,version)=>{
  if(name==='layoutRevision'){const layout=example('layout',version).layout;return {revision:layout.revision,updatedAt:layout.updatedAt,updatedBy:layout.updatedBy,data:layout.data};}
  if(name==='me')return me();if(name==='prefs')return {uiTheme:'system',locale:'fr'};
  if(name==='chat')return {sessionKey:'synthetic-chat',turnPending:null,messages:[]};
  if(name==='meta'&&version===2)return require('../../src/api/v2/vm/meta').buildMetaVM({}, {authenticated:true});
  const v3=path.join(EX,'v3',FILES[name]+'.json');
  const file=name==='settings'?path.join(EX,'settings','settings-vm.json'):version===3&&fs.existsSync(v3)?v3:path.join(EX,FILES[name]+'.json');
  return JSON.parse(fs.readFileSync(file,'utf8')).data;
};
let hash;before(async()=>{hash=await hashPassword('synthetic-projection-password');});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-view-projection-')),store=openStore({dir,instance:'test',ownerName:'Admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_projection',authorize:()=>{}};
  const users=['reader','editor'].map(role=>{
    const invite=store.userManagement.invite({name:role==='reader'?'Lectrice':'Éditeur',email:role+'@example.invalid',roleId:'rol_'+role},ctx);
    store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});return store.users.byId(invite.user.id);
  });
  const set=(user,key,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,key,level);
  const cleanup=[];
  t.after(async()=>{for(const closer of cleanup)await closer();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,admin,reader:users[0],editor:users[1],set,ctx,cleanup,projector:createViewProjection({store})};
}
test('both contract versions explicitly deny each protected root before a builder, and reject undeclared views',t=>{
  const f=fixture(t);
  for(const version of [2,3])for(const [name,resource] of REQUIREMENTS) {
    if(!schemasFor(version)[name])continue; // Orchestrator/team roots are v3-only.
    let builds=0;f.set(f.reader,resource,'none');
    assert.throws(()=>f.projector.build(f.reader,name,()=>{builds++;return example(name,version);},{version}),{code:'forbidden'});
    assert.equal(builds,0,name);f.set(f.reader,resource,'read');
    const result=f.projector.build(f.reader,name,()=>{builds++;return example(name,version);},{version});
    assert.equal(builds,1,name);assert.equal(validate(schemasFor(version)[name],result).ok,true,name);
  }
  assert.throws(()=>f.projector.build(f.admin,'future-secret',()=>{throw new Error('builder entered');}),/undeclared view projection/);
});
test('admin projections preserve all domain data; every known VM projects to a valid schema with no shared mutation',t=>{
  const f=fixture(t);
  for(const version of [2,3])for(const name of [...REQUIREMENTS.keys(),'meta','me',...(version===3?['settings']:[])]) {
    if(!schemasFor(version)[name])continue; // Do not invent v2 projections for v3-only roots.
    const raw=example(name,version),before=structuredClone(raw),projected=f.projector.project(f.admin,name,raw,{version});
    assert.deepEqual(raw,before,'raw cache unchanged '+name);assert.equal(validate(schemasFor(version)[name],projected).ok,true,name);
    if(!['meta','me','settings','comments'].includes(name))assert.deepEqual(projected,raw,name);
  }
});
test('Office without logs has only agent summaries, no session navigation, cues, counts or journal in either version',t=>{
  const f=fixture(t);f.set(f.reader,'flows','none');f.set(f.reader,'health','none');
  for(const version of [2,3]) {
    const raw=example('office',version),projected=f.projector.project(f.reader,'office',raw,{version});
    assert.equal(projected.occupants.every(o=>['main','primary','agent'].includes(o.role)),true);
    for(const o of projected.occupants){assert.equal(o.sessionKey,null);assert.equal(o.tokens,null);assert.equal(o.lastSeenAt,null);assert.equal(o.exchanges,undefined);}
    assert.ok(projected.occupants.every(o=>o.execution.status==='unknown'&&o.execution.evidence.level==='unknown'
      &&o.execution.evidence.observedAt===null&&o.execution.evidence.expiresAt===null));
    assert.deepEqual(projected.journal,[]);assert.deepEqual(projected.queue,[]);assert.equal(projected.kpis.every(k=>k.id==='active'&&k.sub===null),true);
    assert.equal(f.projector.frame(f.reader,'cue',{type:'cue',signal:{kind:'activity'}}),null);
  }
});
test('Office actor projection strips execution evidence and outcomes, and unknown state does not claim zero activity',t=>{
  const f=fixture(t);f.set(f.reader,'flows','none');f.set(f.reader,'health','none');
  const raw=example('office',3),person=raw.occupants[0];
  person.state='unknown';person.execution={status:'succeeded',evidence:{level:'verified',observedAt:123456,expiresAt:456789}};
  const projected=f.projector.project(f.reader,'office',raw);
  assert.deepEqual(projected.occupants[0].execution,{status:'unknown',evidence:{level:'unknown',observedAt:null,expiresAt:null}});
  const active=projected.kpis.find(k=>k.id==='active');assert.equal(active.value,null);assert.deepEqual(active.sub,{key:'kpi.stateUnknown'});
  assert.doesNotMatch(JSON.stringify(projected),/123456|456789|succeeded/);
});
test('project views omit logs-derived sources/history/people/counts and conservatively hide summaries without provenance',t=>{
  const f=fixture(t),raw=example('project',3),projected=f.projector.project(f.reader,'project',raw);
  assert.equal(projected.sources.every(s=>!['sessionGroup','workspace'].includes(s.kind)),true);
  assert.equal(projected.recentHistory.some(h=>h.session||['session','flow-run','cron-run','source-linked','source-unlinked'].includes(h.kind)),false);
  assert.equal(projected.people.every(p=>p.origin==='manual'||p.kind==='git'),true);
  assert.equal(projected.summary,null);assert.equal(projected.summaryMeta,null);assert.equal(projected.lastActivityAt,null);assert.equal(projected.historyNextCursor,null);
  const board=f.projector.project(f.reader,'projects',example('projects',3));
  for(const column of board.columns)for(const card of column.cards){assert.deepEqual(card.people.visible,[]);assert.equal(card.people.hiddenCount,null);assert.equal(card.flags.hiddenCount,null);assert.equal(card.lastActivityAt,null);}
  assert.deepEqual(f.projector.project(f.reader,'candidates',example('candidates',3)).candidates,[]);
});
test('comment affordances follow the actual Person and child permission, including immutable admin actor projection',t=>{
  const f=fixture(t),raw=example('comments',3),item=raw.items.find(i=>i.kind==='comment'&&!i.deleted);
  item.author={id:f.editor.person_id,kind:'human',name:'Éditeur',avatarUrl:null,state:null};item.editable=false;item.deletable=true;
  const mine=f.projector.project(f.editor,'comments',raw),other=f.projector.project(f.admin,'comments',raw),reader=f.projector.project(f.reader,'comments',raw);
  assert.equal(mine.items.find(i=>i.id===item.id).editable,true);assert.equal(other.items.find(i=>i.id===item.id).editable,false);assert.equal(other.items.find(i=>i.id===item.id).deletable,false);
  assert.equal(reader.canComment,false);assert.equal(reader.items.some(i=>i.editable||i.deletable),false);assert.equal(reader.session,null);
  f.set(f.editor,'projects.comment','none');assert.equal(f.projector.project(f.editor,'comments',raw).canComment,false);
  assert.equal(raw.items.find(i=>i.id===item.id).editable,false,'raw cached owner affordance unchanged');
});
test('Settings has per-group nulls and current-user account data, independent read/write edit controls',t=>{
  const f=fixture(t),raw=example('settings',3),vm=f.projector.project(f.reader,'settings',raw);
  assert.equal(vm.instance,null);assert.equal(vm.network,null);assert.equal(vm.restart,null);assert.deepEqual(vm.runtimes,[]);assert.deepEqual(vm.agents,[]);
  assert.equal(vm.owner.email.value,f.reader.email);assert.equal(vm.owner.displayName.value,'Lectrice');assert.equal(vm.owner.passwordChangeEnabled,true);
  f.set(f.reader,'settings.instance','read');const readable=f.projector.project(f.reader,'settings',raw);assert.ok(readable.instance);assert.equal(readable.instance.name.editable,false);
  f.set(f.reader,'settings.instance','write');assert.equal(f.projector.project(f.reader,'settings',raw).instance.name.editable,raw.instance.name.editable);
});
test('me exposes exact current permissions/revisions and unavailable resources; metadata hides unauthorized inventories',t=>{
  const f=fixture(t),current=f.projector.project(f.reader,'me',me());
  assert.equal(current.user.personId,f.reader.person_id);assert.equal(current.email,f.reader.email);assert.equal(current.displayName,'Lectrice');assert.equal(current.permissions.logs,'none');assert.equal(current.resourceStatus.logs,'available');
  assert.deepEqual(current.capabilities,{openclawWrites:false,storeWrites:false});
  f.store.db.prepare("UPDATE permission_resources SET active=0 WHERE key='access'").run();
  assert.equal(f.projector.project(f.reader,'me',me()).resourceStatus.access,'unavailable');
  const raw=example('meta',3);raw.labels['model.synthetic-private']='synthetic-private-model';raw.labels['channel.synthetic-private']='synthetic-private-channel';
  const meta=f.projector.project(f.reader,'meta',raw);assert.equal(meta.runtime,null);assert.deepEqual(meta.runtimes,[]);assert.equal(meta.instance.name,null);
  assert.doesNotMatch(JSON.stringify(meta.labels),/synthetic-private/);assert.equal(f.projector.mayExposeSources(f.reader),false);
  assert.equal(f.projector.mayExposeSources(f.admin),true);
});
test('health/access/layout related inventories are filtered independently and never synthesize a zero issue count',t=>{
  const f=fixture(t),health=f.projector.project(f.reader,'health',example('health',3));
  assert.equal(health.dataQuality,null);assert.deepEqual(health.sources,[]);assert.deepEqual(health.channels,[]);
  f.set(f.reader,'access','read');const access=f.projector.project(f.reader,'access',example('access',3));assert.deepEqual(access.interlocutors,[]);assert.equal(access.agents.every(a=>a.runtime===null),true);
  const raw=example('layout',3);raw.layout.data.agents.push({match:{id:'synthetic-private-session-rule'}});
  const layout=f.projector.project(f.reader,'layout',raw);assert.equal(layout.agentsSeen.every(a=>['primary','agent'].includes(a.role)&&a.lastSeenAt===null),true);
  assert.doesNotMatch(JSON.stringify(layout),/synthetic-private-session-rule/);assert.deepEqual(layout.default.data.agents,[]);
});
test('frame policy blocks raw deltas/unknown broadcasts and projects Settings notifications per readable group',t=>{
  const f=fixture(t);
  assert.throws(()=>f.projector.frame(f.reader,'delta',{ops:[]}),/raw deltas/);
  assert.equal(f.projector.frame(f.reader,'toast',{message:{params:{private:'secret'}}}),null);
  assert.equal(f.projector.frame(f.reader,'future-secret',{secret:'secret'}),null);
  assert.equal(f.projector.frame(f.reader,'settings',{changed:['network','runtime'],revision:2,restartRequired:true}),null);
  f.set(f.reader,'settings.runtimes','read');
  assert.deepEqual(f.projector.frame(f.reader,'settings',{changed:['network','runtime'],revision:2,restartRequired:true}),{type:'settings',changed:['runtime'],revision:2});
  const system=f.projector.frame(f.reader,'system',{gateway:'up',private:'secret',capabilities:{storeWrites:true,openclawWrites:true}});
  assert.equal(system.private,undefined);assert.deepEqual(system.capabilities,{storeWrites:false,openclawWrites:false});
});
test('a permission mutation inside a builder invalidates its result before projection',t=>{
  const f=fixture(t);
  assert.throws(()=>f.projector.build(f.reader,'office',()=>{f.store.db.prepare('UPDATE users SET permission_revision=permission_revision+1 WHERE id=?').run(f.reader.id);return example('office',3);}),{code:'forbidden'});
});
test('the explicit permission-state example validates and unknown raw fields fail closed without a cached fallback',t=>{
  const f=fixture(t),sample=JSON.parse(fs.readFileSync(path.join(EX,'auth/me-vm.json'),'utf8')).data;
  for(const version of [2,3])assert.equal(validate(schemasFor(version).me,sample).ok,true);
  const raw=example('office',3);f.projector.project(f.admin,'office',raw);
  raw.futureSecret='synthetic-private-field';
  assert.throws(()=>f.projector.project(f.reader,'office',raw),/invalid raw view projection/);
  assert.throws(()=>f.projector.project(f.admin,'office',example('office',3),{version:4}),/unsupported projection contract/);
});
test('real HTTP aliases and protected versioned SSE hubs use identical shared projections and clear on revocation',async t=>{
  const f=fixture(t),auth=createAuth({secret:'synthetic-projection-secret',ttlMs:60000,identity:{users:f.store.users,state:f.store.rbac.state},allowMultiUser:true});
  const topics=createVersionedTopics({2:{P:{version:2}},3:{P:{version:3}}},{policyDeclarations:TOPICS,resourceRegistry:f.store.registry});
  topics.define('office',{build:(params,P)=>example('office',P.version)});let logBuilds=0;
  topics.define('logs',{build:()=>{logBuilds++;return example('logs',3);}});
  const app=trackMounts(express()),r=express.Router(),streams=[];
  declareRoute(r,'get','/views/office',ROUTES.get('GET /views/office'),{store:f.store,auth},(req,res)=>{
    const version=req.baseUrl==='/api/v3'?3:2;
    res.json({data:f.projector.project(req.user,'office',topics.current('office',version).vm,{version})});
  });
  app.use(['/api/v2','/api/v3'],r);app.use(errorMiddleware());assertRouteCoverage(app,f.store.registry);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  f.cleanup.push(async()=>{for(const {hub} of streams)hub.closeAll();topics.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const cookie='taco_sess='+auth.signSession({userId:f.reader.id,authGeneration:f.reader.auth_generation,sid:'synthetic-projection-session',exp:Date.now()+60000});
  for(const version of [2,3]) {
    const hub=createStreamHub({topics:topics.of(version),engine:{sources:()=>[]},systemState:()=>({gateway:'up'}),contractVersion:version+'.0',modelVersion:1,authorizationEvents:f.store.authorizationEvents,
      security:createStreamPolicy({store:f.store,auth,topics:topics.of(version),project:(user,id,vm)=>f.projector.project(user,id,vm,{version}),filterFrame:(user,type,data)=>f.projector.frame(user,type,data,{version})})});
    const req=Object.assign(new EventEmitter(),{headers:{cookie},query:{topics:'office,logs'}});req.session=auth.sessionOf(req);
    const res=new EventEmitter();res.lines=[];res.writeHead=()=>{};res.write=line=>{res.lines.push(String(line));return true;};res.destroy=res.end=()=>{res.ended=true;};
    streams.push({hub,res});hub.open(req,res);
    const wire=res.lines.join(''),frame=wire.split('\n\n').find(line=>line.includes('event: snapshot'));
    const snapshot=JSON.parse(frame.split('\ndata: ')[1]);
    const http=await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/office',{headers:{cookie}});
    assert.equal(http.status,200);assert.deepEqual((await http.json()).data,snapshot.data);assert.match(wire,/permission-denied/);
  }
  assert.equal(logBuilds,0);
  f.store.userManagement.overrides(f.reader.id,{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx);
  for(const {hub,res} of streams){assert.equal(res.ended,true);assert.equal(hub._streams.size,0);}
  for(const version of [2,3])assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/office',{headers:{cookie}})).status,403);
});
