'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../../src/store/db');
const {createProjectsRepository}=require('../../src/store/repos/projects');
const {createProjectService}=require('../../src/projects/service');
const {createEngine}=require('../../src/engine');
const {createMultiEngine}=require('../../src/engine/multi');
const {engineRegistry}=require('../../src/api/v2/projects');
const {scopedId}=require('../../src/runtime-ids');
const {Owner,AT}=require('../projects/helpers');
function fixture(t,{firstAdapter="openclaw",secondAdapter="demo"}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-source-provenance-'));let db;
 t.after(()=>{db?.close();fs.rmSync(dir,{recursive:true,force:true});});
 const options={persons:[Owner()],ownerPersonId:Owner().id,now:()=>AT};
 function open(max,now=()=>AT+3000,migrationsDirOverride){
  db?.close();let migrationsDir=migrationsDirOverride;
  if(max){migrationsDir=path.join(dir,'migrations-'+max);fs.mkdirSync(migrationsDir,{recursive:true});for(const file of fs.readdirSync('src/store/migrations'))if(Number(file.slice(0,3))<=max)fs.copyFileSync('src/store/migrations/'+file,path.join(migrationsDir,file));}
  db=openDatabase({dir:path.join(dir,'db'),instance:'test',...(migrationsDir?{migrationsDir}:{}),now});return createProjectsRepository(db.db,options);
 }
 const instances=[['legacy',firstAdapter,'OpenClaw'],['other',secondAdapter,'Other connector']].map(([id,adapter,name])=>({id,adapter,name,enabled:true,engine:createEngine({adapter:require('../../src/adapters').adapterById(adapter).definition})}));
 const engine=createMultiEngine({instances});t.after(()=>engine.close());
 return {dir,open,options,engine,instances,get db(){return db.db;},service:repo=>createProjectService({repository:repo,engineRegistry:engineRegistry(engine)})};
}
const source=ref=>({kind:'sessionGroup',ref});
const native={by:'keys',sessionKeys:['purged-native-session']};
const tag={by:'group',groupId:'projet:atelier',name:'atelier'};
test('migration 030 durably identifies pre-multi-runtime links even with purged sessions; newer unknown links stay unknown',t=>{
 const f=fixture(t);let repo=f.open(18,()=>AT-500);
 const projects=[native,tag].map((ref,n)=>repo.createProject({name:'Legacy '+n,actor:'owner',sources:[source(ref)]}));
 const immutable=f.db.prepare('SELECT data_json FROM history_events ORDER BY rowid').all().map(row=>row.data_json);
 repo=f.open(29,()=>AT+1000);repo.clock=()=>AT+2000;
 const unknown=repo.createProject({name:'New unowned link',actor:'owner',sources:[source({by:'group',groupId:'unavailable-new-group',name:'OpenClaw-like name'})]});
 repo=f.open();const service=f.service(repo);
 for(const project of projects){
  assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['legacy']);
  const descriptor=service.views.project({id:project.id}).sourceDescriptors[0];assert.equal(descriptor.id,'source:sessionGroup:legacy');assert.equal(descriptor.runtime,'openclaw');assert.equal(descriptor.label.params.label,'OpenClaw');
 }
 assert.equal(service.views.project({id:unknown.id}).sourceDescriptors[0].id,'source:sessionGroup','new unresolved links are never blanket stamped');
 assert.deepEqual(f.db.prepare('SELECT data_json FROM history_events WHERE project_id IN (?,?) ORDER BY rowid').all(...projects.map(p=>p.id)).map(row=>row.data_json),immutable,'append-only event bytes remain unchanged');
 assert.ok(f.db.prepare('SELECT 1 FROM schema_migrations WHERE version=30').get(),'migration 030 is applied');
 repo=f.open();for(const project of projects)assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['legacy'],'idempotent reopen');
});
test('new scoped links retain canonical ownership after session purge and repository reopen',t=>{
 const f=fixture(t);let repo=f.open(),service=f.service(repo);
 const project=repo.createProject({name:'Second instance',actor:'owner',sources:[source({by:'keys',sessionKeys:[scopedId('other','session','already-purged')]})]});
 assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['other']);
 repo=f.open();service=f.service(repo);assert.equal(service.views.project({id:project.id}).sourceDescriptors[0].id,'source:sessionGroup:other');
 const raw=service.views.project({id:project.id});assert.equal(JSON.stringify(raw).includes('connectorIds'),false,'private provenance is not an additional VM field');
});
test('source provenance cannot be submitted by a project caller',t=>{
 const f=fixture(t),repo=f.open(),service=f.service(repo);
 const result=service.commands.create({name:'Forged ownership',actor:'owner',sources:[{...source(native),connectorIds:['other']}]});
 assert.equal(repo.getProject(result.vm.id).sources[0].connectorIds,undefined,'caller metadata is discarded');
 assert.equal(result.vm.sourceDescriptors[0].id,'source:sessionGroup');
});
test('mixed connector group counts once per connector, preserving ownership on later edits',t=>{
 const f=fixture(t),repo=f.open(),service=f.service(repo);
 const project=repo.createProject({name:'Mixed',actor:'owner',sources:[source({by:'keys',sessionKeys:[scopedId('legacy','session','purged-one'),scopedId('other','session','purged-two')]})]});
 assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['legacy','other']);
 const renamed=repo.rename({id:project.id,expectedRevision:project.revision,name:'Renamed',actor:'owner'});assert.deepEqual(renamed.sources[0].connectorIds,['legacy','other']);
 assert.deepEqual(service.views.board().sourceFilters.map(row=>[row.id,row.count]).sort(),[['source:sessionGroup:legacy',1],['source:sessionGroup:other',1]]);
});

test('post-019 project-tag links with expired hints use one declared hint producer; ambiguous producers stay generic',t=>{
 for(const secondAdapter of ['demo','openclaw']){
  const f=fixture(t,{secondAdapter});let repo=f.open(29,()=>AT-500);
  const project=repo.createProject({name:'After namespaces',actor:'owner',sources:[source(tag)]});
  repo=f.open();const logs=[],service=createProjectService({repository:repo,engineRegistry:engineRegistry(f.engine),log:message=>logs.push(message)}),descriptor=service.views.project({id:project.id}).sourceDescriptors[0];
  assert.deepEqual(logs,[secondAdapter==='demo'?'projects: tag connector provenance assigned=1 unresolved=0':'projects: tag connector provenance assigned=0 unresolved=1'],'decision logs contain counts only');
  if(secondAdapter==='demo'){
   assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['legacy']);assert.equal(descriptor.id,'source:sessionGroup:legacy');
   repo=f.open();assert.deepEqual(repo.getProject(project.id).sources[0].connectorIds,['legacy'],'fallback is persisted, not re-guessed on reload');
  }else{
   assert.equal(repo.getProject(project.id).sources[0].connectorIds,undefined);assert.equal(descriptor.id,'source:sessionGroup');
  }
 }
});
test('exact project hint namespace wins over another sole hint-capable connector and remains after hint purge',t=>{
 const f=fixture(t),repo=f.open();let hints=[{slug:'atelier',sessionKey:scopedId('other','session','expired-hint-session')}];
 const registry=engineRegistry(f.engine);Object.defineProperty(registry,'projectHints',{get:()=>hints});
 const service=createProjectService({repository:repo,engineRegistry:registry});
 const project=repo.createProject({name:'Exact tag',actor:'owner',sources:[source(tag)]});
 assert.deepEqual(project.sources[0].connectorIds,['other'],'exact canonical hint evidence takes priority');
 hints=[];assert.equal(service.views.project({id:project.id}).sourceDescriptors[0].id,'source:sessionGroup:other');
});

test('030 does not prevent the next deployed migration and repeat boot is idempotent',t=>{
 const f=fixture(t);f.open(30);
 const migrationsDir=path.join(f.dir,'next-migrations');fs.mkdirSync(migrationsDir);
 fs.writeFileSync(path.join(migrationsDir,'031_next_test.sql'),'CREATE TABLE next_source_marker (id INTEGER PRIMARY KEY);');
 f.open(undefined,undefined,migrationsDir);
 assert.equal(f.db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v,31);
 assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='next_source_marker'").get());
 const versions=f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version);
 f.open(undefined,undefined,migrationsDir);
 assert.deepEqual(f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version),versions,'repeat boot does not rerun the next migration');
});

test('a project tag is never assigned to a sole registered connector that cannot emit hints',t=>{
 const f=fixture(t,{firstAdapter:'demo',secondAdapter:'demo'}),repo=f.open();
 const single=f.instances[0].engine,registry=engineRegistry(single);
 const service=createProjectService({repository:repo,engineRegistry:registry});
 const project=repo.createProject({name:'Unsupported tag',actor:'owner',sources:[source(tag)]});
 assert.equal(project.sources[0].connectorIds,undefined);assert.equal(service.views.project({id:project.id}).sourceDescriptors[0].id,'source:sessionGroup');
});
