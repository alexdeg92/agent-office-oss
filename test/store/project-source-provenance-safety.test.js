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
 function open(max,now=()=>AT+3000){
  db?.close();let migrationsDir;
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

test('030 backup preserves pre-upgrade state and can restore it without data loss',t=>{
 const f=fixture(t);let repo=f.open(29,()=>AT+1000);
 const refs=[native,tag,{by:'group',groupId:'unresolved',name:'Unresolved'}];
 const rows=refs.map((ref,i)=>{repo.clock=()=>AT+i*1000;return repo.createProject({name:'Boundary '+i,actor:'owner',sources:[source(ref)]});});
 const raw=f.db.prepare('SELECT id,data_json FROM project_sources ORDER BY id').all();
 const events=f.db.prepare('SELECT data_json FROM history_events ORDER BY rowid').all();
 repo=f.open();assert.deepEqual(f.db.prepare('SELECT id,data_json FROM project_sources ORDER BY id').all(),raw);
 assert.deepEqual(f.db.prepare('SELECT data_json FROM history_events ORDER BY rowid').all(),events);
 assert.deepEqual(repo.getProject(rows[0].id).sources[0].connectorIds,['legacy']);
 assert.deepEqual(repo.getProject(rows[1].id).sources[0].connectorIds,['legacy'],'inclusive numeric boundary');
 assert.equal(repo.getProject(rows[2].id).sources[0].connectorIds,undefined,'post-boundary is not migration-stamped');
 const backups=fs.readdirSync(path.join(f.dir,'db','backups')).filter(name=>name.startsWith('agent-office-premigrate-v029-'));
 assert.equal(backups.length,1);const backup=path.join(f.dir,'db','backups',backups[0]);
 assert.equal(fs.statSync(backup).mode&0o777,0o600);
 const restoreDir=path.join(f.dir,'restored');fs.mkdirSync(restoreDir,{mode:0o700});fs.copyFileSync(backup,path.join(restoreDir,'agent-office.sqlite'));
 const restored=openDatabase({dir:restoreDir,instance:'test',migrationsDir:path.join(f.dir,'migrations-29')});
 try{assert.equal(restored.version,29);assert.deepEqual(restored.db.prepare('SELECT id,data_json FROM project_sources ORDER BY id').all(),raw);assert.deepEqual(restored.db.prepare('SELECT data_json FROM history_events ORDER BY rowid').all(),events);}finally{restored.close();}
});
test('automatic provenance capture preserves a quarantined raw source row',t=>{
 const f=fixture(t);let repo=f.open(29,()=>AT-1000);repo.clock=()=>AT;
 const project=repo.createProject({name:'Valid plus quarantined',actor:'owner',sources:[source(tag)]});
 const invalid='{ "future-or-invalid-source": true }';
 f.db.prepare('INSERT INTO project_sources(id,project_id,kind,ref_key,data_json) VALUES (?,?,?,?,?)').run('src_quarantined',project.id,'workspace','synthetic-invalid',invalid);
 repo=f.open();assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_sources WHERE project_id=?').get(project.id).n,2);
 f.service(repo);
 assert.equal(f.db.prepare('SELECT data_json FROM project_sources WHERE id=?').get('src_quarantined')?.data_json,invalid,'background capture may annotate valid sources but must not delete an unreadable sibling');
});
test('failed capture transaction retains every source row',t=>{
 const f=fixture(t);let repo=f.open(29,()=>AT-1000);repo.clock=()=>AT;
 const project=repo.createProject({name:'Capture failure',actor:'owner',sources:[source(tag)]});
 repo=f.open();const before=f.db.prepare('SELECT * FROM project_sources ORDER BY id').all();
 f.db.exec("CREATE TRIGGER critic639_abort_capture BEFORE UPDATE OF connector_ids_json ON project_sources WHEN NEW.connector_ids_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic capture failure'); END;");
 assert.throws(()=>f.service(repo),/synthetic capture failure/);
 assert.deepEqual(f.db.prepare('SELECT * FROM project_sources ORDER BY id').all(),before);
});
