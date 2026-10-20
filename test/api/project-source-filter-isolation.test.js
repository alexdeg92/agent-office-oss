// Critic631 regression: canonical source count/privacy and real multi-engine ownership.
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
const FILES={meta:'meta-vm',office:'office-vm','office-scope':'office-vm',officeCharacters:'office-characters-vm',officePalette:'office-palette-vm',officeStore:'office-store-vm',flows:'flow-list-vm',flow:'flow-detail-vm',access:'access-vm',interlocutor:'interlocutor-vm',logs:'logs-page',session:'session-vm',skills:'skill-list-vm',skill:'skill-detail-vm',health:'health-vm',projects:'board-vm',project:'project-vm',history:'history-page',candidates:'candidates-vm',layout:'layout-vm',comments:'comment-thread-vm',orchestrators:'orchestrators-vm',teams:'teams-vm'};
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

const {buildBoardVM}=require('../../src/projects/vm');
const {projectSourceDescriptors}=require('../../src/projects/source-descriptors');
const p=(id,sources,extra={})=>({id,name:id,status:'todo',priority:'P2',revision:1,archivedAt:null,summary:'',summaryMeta:null,
flags:[],people:[],sources,repo:null,repoStatus:null,lastActivityAt:1000,createdAt:1000,...extra});
const s=(id,kind,ref=null)=>({id,kind,ref,addedAt:1000});
const connector={id:'fixture-private-instance',adapter:'neutral-runtime',name:'Hidden Connector',mark:null};
const context={sourceConnectors:()=>[connector]};
for(const version of [2,3]) {
 test(`canonical filters reveal no restricted count or identity v${version}`,t=>{
  const f=fixture(t);for(const resource of ['logs','settings.runtimes','teams'])f.set(f.reader,resource,'none');
  const publicRows=[p('prj_public_a',[s('a-manual','manual'),s('a-gh','github',{owner:'shared-owner',repo:'one'})]),p('prj_public_b',[s('b-manual','manual')])];
  const hiddenLinked=structuredClone(publicRows);hiddenLinked[1].sources.push(s('private-session','sessionGroup',{by:'keys',sessionKeys:['private-key']}));
  const shared=projectSourceDescriptors(publicRows[0],context);
  const hiddenRuntime=p('runtimeprj_hidden',[],{sourceDescriptors:[...shared,{id:'runtime:hidden',kind:'runtime',runtime:'neutral-runtime',label:{key:'project.source.label',params:{label:'hidden-workspace'}},brand:null}]});
  const hiddenTeam=p('teamprj_hidden',[],{origin:'orchestrator-team',teamProject:{teamId:'team_hidden',label:'Hidden Team',readOnly:true,taskCount:0},sourceDescriptors:[...shared,{id:'team-source:hidden',kind:'orchestrator-team',runtime:null,label:{key:'project.source.label',params:{label:'hidden-team'}},brand:null}]});
  const board=rows=>{const b=buildBoardVM(rows,{...context,apiVersion:version});if(version===3)b.agent=null;return b;};
  const baseline=f.projector.project(f.reader,'projects',board(publicRows),{version});
  const changed=f.projector.project(f.reader,'projects',board([...hiddenLinked,hiddenRuntime,hiddenTeam]),{version});
  assert.deepEqual(changed,baseline,'restricted additions must not change any public payload field');
  const all=board([...hiddenLinked,hiddenRuntime,hiddenTeam]);
  const admin=f.projector.project(f.admin,'projects',all,{version});
  assert.equal(admin.sourceFilters.find(row=>row.id==='source:manual').count,4);
  assert.equal(changed.sourceFilters.find(row=>row.id==='source:manual').count,2);
  assert.equal(JSON.stringify(changed).includes('Hidden Connector'),false);
 });
 test(`canonical restricted and absent filter probes are indistinguishable v${version}`,t=>{
  const f=fixture(t);f.set(f.reader,'logs','none');
  const rows=[p('prj_link',[s('manual','manual'),s('private-session','sessionGroup',{by:'keys',sessionKeys:['private-key']})])];
  const board=source=>{const b=buildBoardVM(rows,{...context,apiVersion:version,sourceFilterId:source,allowUnknownSourceFilter:true});if(version===3)b.agent=null;return b;};
  const known=f.projector.project(f.reader,'projects',board('source:sessionGroup:'+connector.id),{version});
  const absent=f.projector.project(f.reader,'projects',board('source:sessionGroup:absent-instance'),{version});
  assert.deepEqual(known,absent);
  assert.equal(known.sourceFilterId,null);assert.deepEqual(known.sourceFilters,[]);
 });
}

const {createEngine}=require('../../src/engine');
const {createMultiEngine}=require('../../src/engine/multi');
const {definition}=require('../../src/adapters/demo');
const {createProjectService}=require('../../src/projects/service');
const {scopedId}=require('../../src/runtime-ids');
for(const firstId of ['one','legacy']) test(`scoped offline group retains its declared multi-runtime connector (${firstId})`,t=>{
 const instances=[firstId,'two'].map(id=>({id,name:'Connector '+id,adapter:'demo',enabled:true,engine:createEngine({adapter:definition})}));
 const engine=createMultiEngine({instances});t.after(()=>engine.close());
 const registry=require('../../src/api/v2/projects').engineRegistry(engine);
 const rows=[p('prj_offline',[s('offline','sessionGroup',{by:'group',groupId:scopedId('two','session','offline-group'),name:'Offline group'})])];
 const service=createProjectService({repository:{listProjects:()=>rows,listPersons:()=>[]},engineRegistry:registry});
 const board=service.views.board({apiVersion:3});
 const descriptor=board.sourceFilters.find(row=>row.source.kind==='sessionGroup').source;
 assert.equal(descriptor.runtime,definition.id,'the scoped group itself declares its registered owner even offline');
 assert.equal(descriptor.id,'source:sessionGroup:two');
});

test('multi-runtime unverified legacy-compatible keys cannot establish connector ownership', t => {
 const instances=['legacy','two'].map(id=>({id,name:'Connector '+id,adapter:'demo',enabled:true,engine:createEngine({adapter:definition})}));
 const engine=createMultiEngine({instances});t.after(()=>engine.close());
 const registry=require('../../src/api/v2/projects').engineRegistry(engine);
 assert.equal(registry.defaultConnector,null);
 assert.equal(registry.connectorOf('not-a-known-session'),null);
 const rows=[p('prj_missing_key',[s('unknown','sessionGroup',{by:'keys',sessionKeys:['not-a-known-session']})])];
 const service=createProjectService({repository:{listProjects:()=>rows,listPersons:()=>[]},engineRegistry:registry});
 assert.equal(service.views.board({apiVersion:3}).sourceFilters[0].source.runtime,null);
});
test('single-runtime ownership remains declared for its offline groups', () => {
 const engine=createEngine({adapter:definition});
 const registry=require('../../src/api/v2/projects').engineRegistry(engine);
 assert.ok(registry.defaultConnector);
 const rows=[p('prj_single_offline',[s('offline','sessionGroup',{by:'group',groupId:'offline-group',name:'Offline group'})])];
 const service=createProjectService({repository:{listProjects:()=>rows,listPersons:()=>[]},engineRegistry:registry});
 const source=service.views.board({apiVersion:3}).sourceFilters[0].source;
 assert.equal(source.runtime,definition.id);assert.equal(source.id,'source:sessionGroup:'+registry.defaultConnector.id);
});
