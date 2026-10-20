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
const FILES={meta:'meta-vm',office:'office-vm','office-scope':'office-vm',officeCharacters:'office-characters-vm',officePalette:'office-palette-vm',officeStore:'office-store-vm',flows:'flow-list-vm',flow:'flow-detail-vm',access:'access-vm',interlocutor:'interlocutor-vm',logs:'logs-page',session:'session-vm',skills:'skill-list-vm',skill:'skill-detail-vm',health:'health-vm',projects:'board-vm',project:'project-vm',projectCreate:'project-create-vm',projectKickoff:'project-kickoff-vm',history:'history-page',candidates:'candidates-vm',layout:'layout-vm',comments:'comment-thread-vm',orchestrators:'orchestrators-vm',teams:'teams-vm',chatAgents:'chat-agents-vm',chatAgentSessions:'chat-agent-sessions-vm',chatSession:'chat-session-vm'};
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
function boardWithPrivateSourceProjects(version, selectedKind=null) {
  const board=example('projects',version),column=board.columns.find(row=>row.cards.length);
  const sources=[
    {id:'runtime:runtime-codex',kind:'runtime',runtime:'codex',label:{key:'project.source.label',params:{label:'project-from-private-workspace'}},brand:null,
      cardId:'runtimeprj_private_workspace',name:'project-from-private-workspace'},
    {id:'team-source:team:private-canary',kind:'orchestrator-team',runtime:null,label:{key:'project.source.label',params:{label:'private-team-name'}},brand:null,
      cardId:'teamprj_private_team',name:'private-team-name',origin:'orchestrator-team'},
    ...['workspace','sessionGroup'].map(kind=>({id:'legacy:'+kind,kind,runtime:null,
      label:{key:'project.source.label',params:{label:'private-'+kind}},brand:null,cardId:'legacyprj_'+kind,name:'private-'+kind})),
  ];
  for(const source of sources){
    const card=structuredClone(column.cards[0]);
    const sharedSource=structuredClone(board.sourceFilters.find(row=>row.source?.kind==='github')?.source);
    card.id=source.cardId;card.name=source.name;card.sourceDescriptors=[{id:source.id,kind:source.kind,runtime:source.runtime,label:source.label,brand:source.brand},sharedSource];
    if(source.origin)card.origin=source.origin;
    column.cards.push(card);column.count++;
    const sharedFilter=board.sourceFilters.find(row=>row.id===sharedSource.id);if(sharedFilter)sharedFilter.count++;
    board.sourceFilters.push({id:source.id,label:source.label,count:1,selected:source.kind===selectedKind,source:{id:source.id,kind:source.kind,runtime:source.runtime,label:source.label,brand:source.brand}});
  }
  if(selectedKind){
    const selected= sources.find(row=>row.kind===selectedKind);
    board.sourceFilterId=selected.id;
    for(const filter of board.sourceFilters)filter.selected=filter.id===selected.id;
    for(const row of board.columns){row.cards=row.cards.filter(item=>item.id===selected.cardId);row.count=row.cards.length;}
  }
  return board;
}
function boardForSourceProbe(version, sourceId) {
  const known=new Map([['runtime:runtime-codex','runtime'],['team-source:team:private-canary','orchestrator-team'],
    ['legacy:workspace','workspace'],['legacy:sessionGroup','sessionGroup']]);
  const board=boardWithPrivateSourceProjects(version,known.get(sourceId)||null);
  if(!known.has(sourceId)){
    board.sourceFilterId=sourceId;
    for(const filter of board.sourceFilters)filter.selected=false;
    for(const column of board.columns){column.cards=[];column.count=0;}
  }
  return board;
}
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
test('projects projection preserves cross-stage counts while subtracting restricted source cards',t=>{
  const f=fixture(t),board=boardWithPrivateSourceProjects(3);
  const allCards=board.columns.flatMap(column=>column.cards);
  const access=allCards.map(card=>({status:card.status,runtime:(card.sourceDescriptors||[]).some(source=>source.kind==='runtime'),
    team:card.origin==='orchestrator-team',sourceIds:(card.sourceDescriptors||[]).map(source=>source.id)}));
  const counts=[{id:'all',count:access.length},...board.columns.map(column=>({id:column.id,count:access.filter(row=>row.status===column.id).length}))];
  board.controls.stage.counts=structuredClone(counts);
  board.controls.search.counts=[{id:'matches',count:access.length}];
  Object.defineProperty(board,Symbol.for('agent-office.projects.boardAccess'),{value:{stageRows:access,sourceRows:access}});
  // The selected-stage response contains only in-progress cards, while its
  // control counts still describe every stage available for this query.
  board.controls.stage.selected='in-progress';
  board.columns=board.columns.map(column=>({...column,cards:column.id==='in-progress'?column.cards:[],count:column.id==='in-progress'?column.count:0,taskCount:column.id==='in-progress'?column.taskCount:0}));
  for(const column of board.columns)if(column.id==='in-progress')column.cards=column.cards.filter(card=>card.status==='in-progress');
  const unrestricted=f.projector.project(f.admin,'projects',board,{version:3});
  assert.deepEqual(unrestricted.controls.stage.counts,counts,'authorized projection preserves all server counts');

  // The reader has projects access only: runtime cards and registered team
  // cards are withheld from both rows and counts.
  f.set(f.reader,'projects','read');f.set(f.reader,'logs','none');f.set(f.reader,'settings.runtimes','none');f.set(f.reader,'teams','none');
  const projected=f.projector.project(f.reader,'projects',board,{version:3});
  const hidden=access.filter(row=>row.runtime||row.team);
  const expected=[{id:'all',count:access.length-hidden.length},...board.controls.stage.options.filter(row=>row.id!=='all').map(option=>({
    id:option.id,count:access.filter(row=>row.status===option.id&&!row.runtime&&!row.team).length,
  }))];
  assert.deepEqual(projected.controls.stage.counts,expected);
  assert.deepEqual(projected.controls.search.counts,[{id:'matches',count:access.filter(row=>!row.runtime&&!row.team).length}],
    'search count preserves the pre-stage matching population while withholding restricted matches');
  assert.ok(projected.controls.stage.counts.find(row=>row.id==='todo').count>0,'other-stage counts survive selecting in-progress');
  const framed=f.projector.frame(f.reader,'snapshot',{type:'snapshot',topic:'projects',data:projected},{version:3});
  assert.deepEqual(framed.data,projected,'the stream frame writer accepts a VM already projected for the same principal without subtracting private rows twice');
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
    assert.equal(Object.hasOwn(projected,'occupantOverflowCount'),false);
    assert.deepEqual(projected.conversationIds,[]);assert.equal(projected.conversationCount,0);
    assert.equal(projected.conversationLabel.params.n,0);
    assert.ok(projected.rosterFloors.every(floor=>floor.count===floor.occupantIds.length), 'floor totals are rebuilt from visible occupants');
    assert.equal(f.projector.frame(f.reader,'cue',{type:'cue',signal:{kind:'activity'}}),null);
  }
});
test('Office hides ambiguous legacy chat and every other account private-chat occupant and their counts',t=>{
  const f=fixture(t),{scopeForAccount,sessionRefForScope}=require('../../src/api/chat-identity');
  f.set(f.reader,'logs','read');
  const adminScope=scopeForAccount(f.admin.id,f.store),readerScope=scopeForAccount(f.reader.id,f.store);
  const identities=new Map([
    ['private-admin',{class:{kind:'explicit',explicitKey:sessionRefForScope(adminScope)},usage:{total:19},run:{status:'running'}}],
    ['private-reader',{class:{kind:'explicit',explicitKey:sessionRefForScope(readerScope)},usage:{total:23},run:{status:'running'}}],
    ['legacy-private',{class:{kind:'explicit',explicitKey:'portal-chat'},usage:{total:29},run:{status:'running'}}],
  ]);
  const projector=createViewProjection({store:f.store,chatSessionForKey:key=>identities.get(key)||null});
  for(const version of [2,3]) {
    const raw=example('office',version);
    raw.occupants[0].sessionKey='private-admin';raw.occupants[1].sessionKey='private-reader';raw.occupants[2].sessionKey='legacy-private';
    raw.kpis.find(row=>row.id==='tokens').value=100;
    if(!raw.kpis.some(row=>row.id==='runs'))raw.kpis.push({id:'runs',label:{key:'kpi.runs'},value:3,unit:'count',sub:null});
    else raw.kpis.find(row=>row.id==='runs').value=3;
    const admin=projector.project(f.admin,'office',raw,{version}),reader=projector.project(f.reader,'office',raw,{version});
    const sessionKeys=vm=>vm.occupants.map(row=>row.sessionKey);
    assert.ok(sessionKeys(admin).includes('private-admin'));assert.ok(!sessionKeys(admin).includes('private-reader')&&!sessionKeys(admin).includes('legacy-private'));
    assert.ok(sessionKeys(reader).includes('private-reader'));assert.ok(!sessionKeys(reader).includes('private-admin')&&!sessionKeys(reader).includes('legacy-private'));
    assert.equal(admin.kpis.find(row=>row.id==='tokens').value,48);assert.equal(reader.kpis.find(row=>row.id==='tokens').value,52);
    assert.equal(admin.kpis.find(row=>row.id==='runs').value,1);assert.equal(reader.kpis.find(row=>row.id==='runs').value,1);
    assert.ok(validate(schemasFor(version).office,admin).ok);assert.ok(validate(schemasFor(version).office,reader).ok);
  }
});
test('restricted signed-cookie Office keeps physical floors, recomputes visible counts, and withholds visit state in v2 and v3',async t=>{
  const f=fixture(t),auth=createAuth({secret:'synthetic-floor-projection-secret',ttlMs:60000,identity:{users:f.store.users,state:f.store.rbac.state},allowMultiUser:true});
  const officeByVersion={2:example('office',2),3:example('office',3)};
  for(const office of Object.values(officeByVersion)){
    const root=office.occupants[0],member={...office.occupants[1],id:'agent:visible-team-member',parentId:root.id,teamId:'team:visible',stationUid:null};
    root.teamId='team:visible';office.occupants.push(member);office.unseatedTeams=[{parentId:root.id,floorId:'1',count:99,capacity:3}];
    office.visitIntent={hostId:'conversation:private-visitor',desk:['primary'],meeting:['primary','conversation:private-visitor'],talking:true,speaker:'conversation:private-visitor',until:Date.now()+60000,
      visitors:[{id:'conversation:private-visitor',phase:'person',stateLabel:{key:'agentState.waiting'},onStage:true}]};
    office.occupants[0].visitPhase='person';office.occupants[0].visitOnStage=true;office.occupants[0].visitStateLabel={key:'agentState.waiting'};
    const floor=office.rosterFloors[0];floor.layout={theme:{resolved:'day'}};floor.capacity=9;
    for(const [id,order,kind,label] of [['rdc',0,'lobby',{key:'office.floor.rdc'}],['gym',10002,'gym',{key:'office.floor.gym'}]])office.rosterFloors.push({id,order,label,countLabel:{key:'office.floor.count',params:{n:0}},statusLabel:{key:'office.floor.status',params:{active:0,idle:0}},kind,occupantIds:[],mobileLabelIds:[],items:[],count:0,activeCount:0,idleCount:0,layout:{theme:{resolved:'night'}},capacity:4});
  }
  const topics=createVersionedTopics({2:{P:{version:2}},3:{P:{version:3}}},{policyDeclarations:TOPICS,resourceRegistry:f.store.registry});
  topics.define('office',{build:(params,P)=>officeByVersion[P.version]});
  const app=trackMounts(express()),r=express.Router();
  declareRoute(r,'get','/views/office',ROUTES.get('GET /views/office'),{store:f.store,auth},(req,res)=>{const version=req.baseUrl==='/api/v3'?3:2;res.json({data:f.projector.project(req.user,'office',topics.current('office',version).vm,{version})});});
  app.use(['/api/v2','/api/v3'],r);app.use(errorMiddleware());assertRouteCoverage(app,f.store.registry);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  f.cleanup.push(async()=>{topics.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const cookieFor=user=>'taco_sess='+auth.signSession({userId:user.id,authGeneration:user.auth_generation,sid:'synthetic-office-'+user.id,exp:Date.now()+60000});
  for(const version of [2,3]){
    const base='http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/office';
    const readerResponse=await fetch(base,{headers:{cookie:cookieFor(f.reader)}}),readerText=await readerResponse.text();assert.equal(readerResponse.status,200,readerText);
    const reader=JSON.parse(readerText).data;
    assert.equal(Object.hasOwn(reader,'visitIntent'),false,`v${version}: no visitor ids, speaker, meeting membership, or live visit state`);
    assert.equal(reader.occupants.some(o=>['visitPhase','visitOnStage','visitStateLabel'].some(key=>Object.hasOwn(o,key))),false,`v${version}: no per-occupant visit state`);
    assert.deepEqual(reader.rosterFloors.map(floor=>floor.id),['1','rdc','gym'],`v${version}: retain every physical floor`);
    assert.deepEqual(reader.rosterFloors[0].layout,{theme:{resolved:'day'}});assert.equal(reader.rosterFloors[0].capacity,9);
    assert.deepEqual(reader.rosterFloors.slice(1).map(floor=>[floor.layout,floor.capacity,floor.count,floor.activeCount,floor.occupantIds]),[
      [{theme:{resolved:'night'}},4,0,0,[]],[{theme:{resolved:'night'}},4,0,0,[]]],`v${version}: empty physical floors remain renderable without stale occupants`);
    for(const floor of reader.rosterFloors)assert.equal(floor.count,floor.occupantIds.length,`v${version}/${floor.id}: count reflects visible members`);
    assert.deepEqual(reader.unseatedTeams,[{parentId:reader.occupants[0].id,floorId:'1',count:1,capacity:3}],`v${version}: unseated counts are rebuilt from visible team members`);
    const adminResponse=await fetch(base,{headers:{cookie:cookieFor(f.admin)}}),adminText=await adminResponse.text();assert.equal(adminResponse.status,200,adminText);
    assert.equal(JSON.parse(adminText).data.visitIntent.speaker,'conversation:private-visitor',`v${version}: Logs readers retain visit data`);
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
test('projects-only HTTP and SSE projections withhold restricted source identities and filters on both contracts',async t=>{
  const f=fixture(t),auth=createAuth({secret:'synthetic-projection-secret',ttlMs:60000,identity:{users:f.store.users,state:f.store.rbac.state},allowMultiUser:true});
  f.set(f.reader,'projects','read');f.set(f.reader,'logs','none');f.set(f.reader,'settings.runtimes','none');f.set(f.reader,'teams','none');
  assert.equal(f.store.policy.can(f.reader,'projects','read'),true);
  assert.equal(f.store.policy.can(f.reader,'logs','read'),false);
  assert.equal(f.store.policy.can(f.reader,'settings.runtimes','read'),false);
  assert.equal(f.store.policy.can(f.reader,'teams','read'),false);
  const topics=createVersionedTopics({2:{P:{version:2}},3:{P:{version:3}}},{policyDeclarations:TOPICS,resourceRegistry:f.store.registry});
  topics.define('office',{build:(params,P)=>example('office',P.version)});let logBuilds=0;
  topics.define('logs',{build:()=>{logBuilds++;return example('logs',3);}});
  topics.define('projects',{params:['filter','agent','source'],build:(params,P)=>params.source
    ?boardForSourceProbe(P.version,params.source):boardWithPrivateSourceProjects(P.version)});
  const app=trackMounts(express()),r=express.Router(),streams=[];
  declareRoute(r,'get','/views/office',ROUTES.get('GET /views/office'),{store:f.store,auth},(req,res)=>{
    const version=req.baseUrl==='/api/v3'?3:2;
    res.json({data:f.projector.project(req.user,'office',topics.current('office',version).vm,{version})});
  });
  declareRoute(r,'get','/views/projects',ROUTES.get('GET /views/projects'),{store:f.store,auth},(req,res)=>{
    const version=req.baseUrl==='/api/v3'?3:2;
    const topicId=typeof req.query.source==='string'?'projects?source='+encodeURIComponent(req.query.source):'projects';
    res.json({data:f.projector.project(req.user,'projects',topics.current(topicId,version).vm,{version})});
  });
  app.use(['/api/v2','/api/v3'],r);app.use(errorMiddleware());assertRouteCoverage(app,f.store.registry);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  f.cleanup.push(async()=>{for(const {hub} of streams)hub.closeAll();topics.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const cookie='taco_sess='+auth.signSession({userId:f.reader.id,authGeneration:f.reader.auth_generation,sid:'synthetic-projection-session',exp:Date.now()+60000});
  for(const version of [2,3]) {
    const legacyBoard=example('projects',version),legacyCard=legacyBoard.columns.flatMap(column=>column.cards)[0];
    const legacySources=['workspace','sessionGroup'].map(kind=>({id:'legacy:'+kind,kind,runtime:null,
      label:{key:'project.source.label',params:{label:'private-'+kind}},brand:null}));
    legacyCard.sourceDescriptors=[...(legacyCard.sourceDescriptors||[]),...legacySources];
    legacyCard.counts={sessions:17,agents:1,activity:8};
    legacyBoard.sourceFilters.push(...legacySources.map(source=>({id:source.id,label:source.label,count:1,selected:false,source})));
    const legacyProjected=f.projector.project(f.reader,'projects',legacyBoard,{version});
    const visibleLegacyCard=legacyProjected.columns.flatMap(column=>column.cards).find(card=>card.id===legacyCard.id);
    assert.ok(visibleLegacyCard,'a normal project card stays readable');
    assert.ok(visibleLegacyCard.sourceDescriptors.every(source=>!['workspace','sessionGroup'].includes(source.kind)));
    assert.deepEqual(visibleLegacyCard.counts,{sessions:null,agents:null,activity:null},'source-derived counts are withheld');
    assert.ok(legacyProjected.sourceFilters.every(source=>!['workspace','sessionGroup'].includes(source.source.kind)));
    const legacyDetail=example('project',version);
    const legacyDetails=legacyDetail.sourceDescriptors.filter(source=>['workspace','sessionGroup'].includes(source.kind));
    assert.ok(legacyDetails.length,'fixture includes legacy source descriptors');
    const legacyDetailProjected=f.projector.project(f.reader,'project',legacyDetail,{version});
    assert.ok(legacyDetailProjected.sourceDescriptors.every(source=>!['workspace','sessionGroup'].includes(source.kind)));
    assert.ok(legacyDetailProjected.sources.every(source=>!['workspace','sessionGroup'].includes(source.kind)));
    assert.deepEqual(legacyDetailProjected.counts,{sessions:null,agents:null,activity:null});
    assert.ok(legacyDetailProjected.people.every(person=>person.origin==='manual'||person.kind==='git'));

    f.projector.project(f.reader,'projects',boardWithPrivateSourceProjects(version),{version});
    const hub=createStreamHub({topics:topics.of(version),engine:{sources:()=>[]},systemState:()=>({gateway:'up'}),contractVersion:version+'.0',modelVersion:1,authorizationEvents:f.store.authorizationEvents,
      security:createStreamPolicy({store:f.store,auth,topics:topics.of(version),project:(user,id,vm)=>f.projector.project(user,id,vm,{version}),filterFrame:(user,type,data)=>f.projector.frame(user,type,data,{version})})});
    const req=Object.assign(new EventEmitter(),{headers:{cookie},query:{topics:'office,logs,projects,projects?source=runtime%3Aruntime-codex,projects?source=runtime%3Aabsent,projects?source=team-source%3Ateam%3Aprivate-canary,projects?source=team-source%3Ateam%3Aabsent,projects?source=legacy%3Aworkspace,projects?source=legacy%3Aworkspace-absent,projects?source=legacy%3AsessionGroup,projects?source=legacy%3AsessionGroup-absent'}});req.session=auth.sessionOf(req);
    const res=new EventEmitter();res.lines=[];res.writeHead=()=>{};res.write=line=>{res.lines.push(String(line));return true;};res.destroy=res.end=()=>{res.ended=true;};
    streams.push({hub,res});hub.open(req,res);
    const wire=res.lines.join(''),frame=wire.split('\n\n').find(line=>line.includes('event: snapshot'));
    const snapshot=JSON.parse(frame.split('\ndata: ')[1]);
    const http=await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/office',{headers:{cookie}});
    assert.equal(http.status,200);assert.deepEqual((await http.json()).data,snapshot.data);assert.match(wire,/permission-denied/);
    const projectFrame=wire.split('\n\n').find(line=>line.includes('event: snapshot')&&line.includes('"topic":"projects"'));
    assert.ok(projectFrame,wire);
    const projectSnapshot=JSON.parse(projectFrame.split('\ndata: ')[1]);
    const projectsHttp=await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/projects',{headers:{cookie}});
    assert.equal(projectsHttp.status,200);const projectsBody=(await projectsHttp.json()).data;
    assert.deepEqual(projectsBody,projectSnapshot.data,`v${version} HTTP and stream share the principal projection`);
    if(version===3)assert.equal(projectSnapshot.data.controls.search.counts[0].count,projectsBody.columns.flatMap(column=>column.cards).length,
      'v3 SSE search facet is calculated once, without a hidden-row count oracle');
    const projectsJson=JSON.stringify(projectsBody);
    for(const privateValue of ['project-from-private-workspace','runtime:runtime-codex','private-team-name','team-source:team:private-canary'])assert.equal(projectsJson.includes(privateValue),false);
    assert.equal(projectsBody.sourceFilters.some(row=>['runtime','orchestrator-team'].includes(row.source?.kind)),false);
    for(const [sourceId,kind,encoded,absentId,privateLabel] of [
      ['runtime:runtime-codex','runtime','runtime%3Aruntime-codex','runtime:absent','project-from-private-workspace'],
      ['team-source:team:private-canary','orchestrator-team','team-source%3Ateam%3Aprivate-canary','team-source:team:absent','private-team-name'],
      ['legacy:workspace','workspace','legacy%3Aworkspace','legacy:workspace-absent','private-workspace'],
      ['legacy:sessionGroup','sessionGroup','legacy%3AsessionGroup','legacy:sessionGroup-absent','private-sessionGroup'],
    ]){
      const filteredTopic='projects?source='+encoded;
      const filteredFrame=wire.split('\n\n').find(line=>line.includes('event: snapshot')&&line.includes('"topic":"'+filteredTopic+'"'));
      assert.ok(filteredFrame,wire);
      const filteredSnapshot=JSON.parse(filteredFrame.split('\ndata: ')[1]);
      const filteredHttp=await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/projects?source='+encoded,{headers:{cookie}});
      assert.equal(filteredHttp.status,200);const filteredBody=(await filteredHttp.json()).data;
      assert.deepEqual(filteredBody,filteredSnapshot.data);
      assert.equal(filteredBody.sourceFilterId,null,`revoked ${kind} filter is not echoed`);
      assert.equal(filteredBody.sourceFilters.some(row=>row.id===sourceId),false);
      assert.equal(JSON.stringify(filteredBody).includes(privateLabel),false);
      const absentEncoded=encodeURIComponent(absentId);
      const absentFrame=wire.split('\n\n').find(line=>line.includes('event: snapshot')&&line.includes('"topic":"projects?source='+absentEncoded+'"'));
      assert.ok(absentFrame,wire);
      const absentSnapshot=JSON.parse(absentFrame.split('\ndata: ')[1]);
      const absentHttp=await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/projects?source='+absentEncoded,{headers:{cookie}});
      assert.equal(absentHttp.status,filteredHttp.status,`${kind} restricted and absent probes have the same HTTP status`);
      const absentBody=(await absentHttp.json()).data;
      assert.deepEqual(filteredBody,absentBody,`${kind} restricted and absent probes are indistinguishable over HTTP`);
      assert.deepEqual(filteredSnapshot.data,absentSnapshot.data,`${kind} restricted and absent probes are indistinguishable over SSE`);
    }
    for(const kind of ['runtime','orchestrator-team']){
      const selected=f.projector.project(f.reader,'projects',boardWithPrivateSourceProjects(version,kind),{version});
      assert.equal(selected.sourceFilterId,null,'revoked source filter is not echoed');
    }
    const mixedRaw=boardWithPrivateSourceProjects(version),sharedFilter=mixedRaw.sourceFilters.find(row=>row.source?.kind==='github');
    const mixedProjected=f.projector.project(f.reader,'projects',mixedRaw,{version});
    assert.equal(mixedProjected.sourceFilters.find(row=>row.id===sharedFilter.id).count,sharedFilter.count-2,
      'counts on a still-visible source exclude projects hidden through another source');
    const emptyPrivate=boardWithPrivateSourceProjects(version);
    for(const column of emptyPrivate.columns){column.cards=column.cards.filter(card=>card.id.startsWith('runtimeprj_')||card.id==='teamprj_private_team');column.count=column.cards.length;}
    emptyPrivate.sourceFilters=emptyPrivate.sourceFilters.filter(row=>['runtime','orchestrator-team'].includes(row.source?.kind));
    emptyPrivate.emptyStateLabel=null;
    const emptyProjected=f.projector.project(f.reader,'projects',emptyPrivate,{version});
    assert.deepEqual(emptyProjected.sourceFilters,[]);
    assert.deepEqual(emptyProjected.emptyStateLabel,{key:'project.empty.board'},'hidden cards do not suppress the authorized empty state');
    const privateDetail=example('project',version);
    privateDetail.name='project-from-private-workspace';
    privateDetail.sourceDescriptors=[{id:'runtime:runtime-codex',kind:'runtime',runtime:'codex',
      label:{key:'project.source.label',params:{label:'project-from-private-workspace'}},brand:null}];
    assert.throws(()=>f.projector.project(f.reader,'project',privateDetail,{version}),{code:'not_found'});
    const visibleSources=user=>f.projector.project(user,'projects',boardWithPrivateSourceProjects(version),{version}).sourceFilters
      .map(row=>row.source?.kind).filter(kind=>['runtime','orchestrator-team'].includes(kind)).sort();
    assert.deepEqual(visibleSources(f.admin),['orchestrator-team','runtime'],'fully authorized user retains source filters');
    f.set(f.reader,'logs','read');f.set(f.reader,'settings.runtimes','none');f.set(f.reader,'teams','read');
    assert.deepEqual(visibleSources(f.reader),['orchestrator-team'],'runtime metadata still needs runtime visibility');
    f.set(f.reader,'logs','none');f.set(f.reader,'settings.runtimes','read');
    assert.deepEqual(visibleSources(f.reader),['orchestrator-team'],'runtime metadata still needs Logs');
    f.set(f.reader,'logs','read');f.set(f.reader,'settings.runtimes','read');f.set(f.reader,'teams','none');
    assert.deepEqual(visibleSources(f.reader),['runtime'],'team metadata independently needs Teams read');
    f.set(f.reader,'logs','none');f.set(f.reader,'settings.runtimes','none');
  }
  assert.equal(logBuilds,0);
  f.store.userManagement.overrides(f.reader.id,{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx);
  for(const {hub,res} of streams){assert.equal(res.ended,true);assert.equal(hub._streams.size,0);}
  for(const version of [2,3])assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/v'+version+'/views/office',{headers:{cookie}})).status,403);
});
test('projected topic versions are payload-derived and stable after topic churn',t=>{
  const f=fixture(t);f.set(f.reader,'projects','read');
  const raw=boardWithPrivateSourceProjects(3),changed=structuredClone(raw);
  const hidden=changed.columns.flatMap(row=>row.cards).find(row=>row.origin==='orchestrator-team');
  hidden.name='changed private task source';hidden.lastActivityAt=Date.now();hidden.counts={sessions:500,agents:20,activity:900};
  const before=f.projector.project(f.reader,'projects',raw,{version:3});
  const after=f.projector.project(f.reader,'projects',changed,{version:3});
  assert.deepEqual(after,before,'private runtime source changes do not alter the projects-only payload');
  const rev=f.projector.revision(f.reader,'projects',before,3);
  const hash=f.projector.fingerprint(f.reader,'projects',before,3);
  assert.equal(f.projector.revision(f.reader,'projects',after,3),rev,'hidden-source churn retains its revision');
  assert.equal(f.projector.fingerprint(f.reader,'projects',after,3),hash,'hidden-source churn retains its full SSE fingerprint');
  for(let i=0;i<4096;i++)f.projector.revision(f.reader,'projects?source=synthetic-'+i,before,3);
  assert.equal(f.projector.revision(f.reader,'projects',after,3),rev,'4,096 distinct topics cannot evict/reset a revision');
  const visible={...after,emptyStateLabel:{key:'project.empty.board'}};
  assert.notEqual(f.projector.revision(f.reader,'projects',visible,3),rev,'a visible payload change receives a different wire revision');
  assert.notEqual(f.projector.fingerprint(f.reader,'projects',visible,3),hash,'SSE distinguishes visible changes with the full digest');
  assert.equal(f.projector.revision(f.reader,'projects',after,3),rev,'returning to the same visible payload restores its deterministic revision');
});

// Status actions must agree with the same caller/store/source policy as writes.
test('project status choices are supplied only to writers in both versions', t => {
  const f = fixture(t);
  for (const version of [2, 3]) {
    const vm = example('project', version), original = structuredClone(vm.statusTransitions);
    f.set(f.reader, 'projects', 'read'); f.set(f.reader, 'logs', 'read'); f.set(f.reader, 'settings.runtimes', 'read');
    assert.deepEqual(f.projector.project(f.reader, 'project', vm, { version }).statusTransitions, []);
    f.set(f.reader, 'projects', 'write');
    // These example sources require runtime and journal visibility too.
    f.set(f.reader, 'logs', 'read'); f.set(f.reader, 'settings.runtimes', 'read');
    assert.deepEqual(f.projector.project(f.reader, 'project', vm, { version }).statusTransitions, original);
    assert.deepEqual(createViewProjection({ store: f.store, cfg: { readonlyStore: true } })
      .project(f.admin, 'project', vm, { version }).statusTransitions, []);
    assert.deepEqual(f.projector.project(f.admin, 'project', { ...vm, capabilities: { ...vm.capabilities, write: false } }, { version }).statusTransitions, []);
    assert.deepEqual(vm.statusTransitions, original, 'projection does not mutate shared producer options');
    assert.equal(validate(schemasFor(version).project, vm).ok, true);
    assert.equal(validate(schemasFor(version).project, { ...vm, statusTransitions: [{ id: 'invented', label: { key: 'projectStatus.idea' } }] }).ok, false);
  }
});

test('candidate status choices obey writer and read-only store authority', t => {
  const f = fixture(t);
  for (const version of [2,3]) {
    const vm = example('candidates', version);
    f.set(f.reader, 'projects', 'read');
    assert.deepEqual(f.projector.project(f.reader,'candidates',vm,{version}).statusOptions,[]);
    f.set(f.reader, 'projects', 'write');
    assert.deepEqual(f.projector.project(f.reader,'candidates',vm,{version}).statusOptions,vm.statusOptions);
    assert.deepEqual(createViewProjection({store:f.store,cfg:{readonlyStore:true}}).project(f.admin,'candidates',vm,{version}).statusOptions,[]);
    assert.equal(validate(schemasFor(version).candidates,vm).ok,true);
  }
});

test('source access rows describe effective permissions in backend order in both contracts',t=>{
 const f=fixture(t);
 for(const version of [2,3]){
  const raw=example('project',version);
  const keys=['read','write','comments','history','repository'];
  const assertRows=vm=>{
   assert.deepEqual(vm.capabilityRows.map(row=>row.id),keys);
   assert.deepEqual(vm.capabilityRows,keys.map(id=>({id,label:{key:'project.team.capability.'+id},valueLabel:{key:'project.team.availability.'+String(vm.capabilities[id])}})));
   for(const locale of ['fr','en'])for(const row of vm.capabilityRows){const labels=require('../../src/i18n').labelsFor(locale,version);assert.ok(labels[row.label.key]);assert.ok(labels[row.valueLabel.key]);}
   assert.equal(validate(schemasFor(version).project,vm).ok,true);
  };
  const admin=f.projector.project(f.admin,'project',raw,{version});assertRows(admin);assert.equal(admin.capabilities.write,true);
  f.set(f.reader,'projects','read');f.set(f.reader,'projects.comment','read');
  const reader=f.projector.project(f.reader,'project',raw,{version});assertRows(reader);
  assert.equal(reader.capabilities.write,false);assert.equal(reader.capabilities.comments,'read-only');assert.equal(reader.capabilities.history,'read-only');
  f.set(f.reader,'projects.comment','none');assert.equal(f.projector.project(f.reader,'project',raw,{version}).capabilities.comments,'unsupported');
  const readonly=createViewProjection({store:f.store,cfg:{readonlyStore:true}}).project(f.admin,'project',raw,{version});assertRows(readonly);assert.equal(readonly.capabilities.write,false);assert.equal(readonly.capabilities.comments,'read-only');
  const unsupported=f.projector.project(f.admin,'project',{...raw,capabilities:{...raw.capabilities,write:false,comments:'unsupported',history:'unsupported',repository:'unsupported'}},{version});assertRows(unsupported);assert.equal(unsupported.capabilities.history,'unsupported');
  assert.equal(raw.capabilities.write,true,'per-viewer policy never mutates producer');
 }
});
