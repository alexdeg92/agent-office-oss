'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
const {openDatabase,MIGRATIONS_DIR}=require('../../src/store/db');
const {hashPassword}=require('../../src/security/password');
const {createAuth}=require('../../src/auth');
const {CORE,createResourceRegistry}=require('../../src/security/resources');
let hash;
before(async()=>{hash=await hashPassword('synthetic-rbac-password');});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rbac-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic admin',log:()=>{}});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const add=(id,role,status='active')=>{
    store.db.prepare("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES (?,'human',?,0,1,1)").run('per_'+id,id);
    store.db.prepare("INSERT INTO users(id,person_id,email,password_hash,role_id,status,credential_source,created_at,updated_at) VALUES (?,?,?,?,?,?,'database',1,1)")
      .run('usr_'+id,'per_'+id,id+'@example.invalid',hash,role,status);
    return store.users.byId('usr_'+id);
  };
  return {store,admin,add};
}
test('registry/policy: core matrix, immutable admin, active status and unknown keys fail closed',t=>{
  const {store,admin,add}=fixture(t), editor=add('editor','rol_editor'),reader=add('reader','rol_reader');
  assert.deepEqual(store.db.prepare('SELECT key FROM permission_resources ORDER BY key').all().map(r=>r.key),CORE.map(r=>r.key).sort());
  for (const d of CORE) {
    assert.equal(store.policy.can(admin,d.key,'write'),true,d.key);
    const editorWrites=new Set(['chat','flows','projects','skills','store']),editorReads=new Set(['office','access','logs','health']);
    const key=d.parent || d.key,expected=editorWrites.has(key)?'write':editorReads.has(key)?'read':'none';
    for (const level of ['read','write']) assert.equal(store.policy.can(editor,d.key,level),expected==='write'||expected===level,d.key);
  }
  assert.equal(store.policy.can(reader,'logs','read'),false);
  assert.equal(store.policy.can(editor,'users','write'),false);
  assert.equal(store.policy.can(admin,'unknown','read'),false);
  assert.equal(store.policy.can(admin,'flows','none'),false);
  store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(editor.id);
  assert.equal(store.policy.can(editor,'flows','write'),false,'a stale object is not authority');
  assert.throws(()=>store.db.prepare("INSERT INTO user_overrides VALUES (?,'flows','none')").run(admin.id),/admin-immutable/);
  assert.throws(()=>store.db.prepare("UPDATE roles SET name='Changed' WHERE id='rol_admin'").run(),/admin-immutable/);
});
test('critic-57: new exact child denies parent role/user overrides until an explicit child grant',t=>{
  const {store,admin,add}=fixture(t),editor=add('editor','rol_editor');
  const before=store.rbac.state().registry_revision,roleBefore=store.rbac.role('rol_editor').revision;
  store.registry.register([{key:'flows.purge',parent:'flows',labelKey:'permissions.flows.purge',privileged:true}],'core');
  store.rbac.sync(store.registry);
  assert.equal(store.rbac.state().registry_revision,before+1);
  assert.equal(store.rbac.role('rol_editor').revision,roleBefore);
  store.db.prepare("INSERT INTO user_overrides VALUES (?,'flows','write')").run(editor.id);
  assert.equal(store.policy.can(editor,'flows.purge','read'),false);
  assert.equal(store.policy.can(editor,'flows.purge','write'),false);
  assert.equal(store.policy.can(admin,'flows.purge','write'),true);
  store.db.prepare("INSERT INTO role_permissions VALUES ('rol_editor','flows.purge','explicit','write')").run();
  assert.equal(store.policy.can(editor,'flows.purge','write'),true);
  store.db.prepare("UPDATE role_permissions SET level='none' WHERE resource='flows.purge'").run();
  assert.equal(store.policy.can(editor,'flows.purge','write'),false,'parent override cannot beat child none');
  store.db.prepare("INSERT INTO user_overrides VALUES (?,'flows.purge','write')").run(editor.id);
  assert.equal(store.policy.can(editor,'flows.purge','write'),true);
  store.db.prepare("UPDATE user_overrides SET level='none' WHERE user_id=? AND resource='flows'").run(editor.id);
  assert.equal(store.policy.can(editor,'flows.purge','write'),false,'parent none blocks explicit child');
  assert.throws(()=>store.db.prepare("INSERT INTO role_permissions VALUES ('rol_reader','users','inherit-parent',NULL)").run(),/root-inheritance/);
});
test('adapter namespaces/graphs are bounded, inactive adapter grants cannot authorize',t=>{
  const {store,add}=fixture(t),editor=add('editor','rol_editor');
  const rows=[{key:'adapter.demo.tools',parent:null,labelKey:'demo.tools',privileged:false},
    {key:'adapter.demo.tools.run',parent:'adapter.demo.tools',labelKey:'demo.run',privileged:false}];
  store.registry.register(rows,'demo');store.rbac.sync(store.registry);
  assert.equal(store.policy.can(editor,rows[1].key,'write'),false);
  store.db.prepare("INSERT INTO role_permissions VALUES ('rol_editor','adapter.demo.tools','explicit','write')").run();
  store.db.prepare("INSERT INTO role_permissions VALUES ('rol_editor','adapter.demo.tools.run','inherit-parent',NULL)").run();
  assert.equal(store.policy.can(editor,rows[1].key,'write'),true);
  store.rbac.sync(createResourceRegistry());
  assert.equal(store.policy.can(editor,rows[1].key,'write'),false,'inactive stored grants never authorize');
  assert.throws(()=>store.registry.register(rows,'demo'),/invalid resource declaration/);
  assert.throws(()=>createResourceRegistry([{namespace:'demo',resources:[{...rows[0],parent:rows[0].key}]}]),/invalid resource parent/);
  assert.throws(()=>createResourceRegistry([{namespace:'demo',resources:[{...rows[0],key:'users'}]}]),/invalid resource declaration/);
  assert.throws(()=>store.registry.register([{key:'flows.cross',parent:'adapter.demo.tools',labelKey:'cross',privileged:false}],'core'),/invalid resource parent/);
});
test('permission audit details follow the existing audit retention policy',t=>{
  const {store,admin}=fixture(t);
  store.audit.append({at:1,requestId:'synthetic-retention',actor:{kind:'human',personId:admin.person_id},command:'roles.edit',target:'rol_editor',outcome:'ok',detail:null});
  const id=store.audit.recent(1)[0].id;
  store.db.prepare("INSERT INTO permission_audit_changes VALUES (?,?)").run(id,JSON.stringify({before:[],after:[]}));
  assert.equal(store.audit.prune(2),1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM permission_audit_changes').get().n,0);
});
test('last-admin triggers cover direct demotion/disable/deletion, invited admins do not count',t=>{
  const {store,admin,add}=fixture(t);add('invited','rol_admin','invited');
  for (const sql of ["UPDATE users SET status='disabled' WHERE id=?","UPDATE users SET role_id='rol_reader' WHERE id=?","DELETE FROM users WHERE id=?"])
    assert.throws(()=>store.db.prepare(sql).run(admin.id),/last-active-admin/);
  const other=add('second','rol_admin');
  store.db.prepare("UPDATE users SET role_id='rol_reader' WHERE id=?").run(admin.id);
  assert.throws(()=>store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(other.id),/last-active-admin/);
  assert.equal(store.users.byId(other.id).status,'active');
});
test('migration 024 upgrades a synthetic v23 single-owner copy, retaining cookie/person/generation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rbac-upgrade-')),mig=path.join(dir,'migrations'),data=path.join(dir,'data');
  fs.mkdirSync(mig);for(const name of fs.readdirSync(MIGRATIONS_DIR))if(Number(name.slice(0,3))<=23)fs.copyFileSync(path.join(MIGRATIONS_DIR,name),path.join(mig,name));
  let h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  t.after(()=>{h.close();fs.rmSync(dir,{recursive:true,force:true});});
  h.db.prepare("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES ('per_stable','human','Stable',1,1,1)").run();
  h.db.prepare("INSERT INTO users VALUES ('usr_stable','per_stable','stable@example.invalid',?,'owner',1,1)").run(hash);
  h.db.prepare("UPDATE settings_state SET value=3 WHERE key='auth_generation'").run();
  const secret='synthetic-session-secret',cookie=createAuth({secret,ttlMs:60000}).signSession({userId:'usr_stable',authGeneration:3,sid:'synthetic_sid',email:'stable@example.invalid',exp:Date.now()+60000});
  h.close();
  fs.copyFileSync(path.join(MIGRATIONS_DIR,'024_rbac.sql'),path.join(mig,'024_rbac.sql'));
  h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  const row=h.db.prepare('SELECT * FROM users').get();
  assert.deepEqual(h.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version),Array.from({length:24},(_,i)=>i+1),'v23 upgrade applies RBAC 024 after runtime auto-add 023 without a gap');
  const detection=JSON.stringify({synthetic:'retained-discovery'});
  h.db.prepare('INSERT INTO runtime_detection(id,value) VALUES (1,?)').run(detection);
  assert.equal(row.id,'usr_stable');assert.equal(row.person_id,'per_stable');assert.equal(row.auth_generation,3);assert.equal(row.role_id,'rol_admin');assert.equal(row.password_hash,hash);
  const users=require('../../src/store/repos/users').createUsersRepo(h.db), auth=createAuth({secret,ttlMs:60000,credential:e=>e==null?users.owner():users.credential(e),credentialGeneration:()=>users.authGeneration()});
  assert.ok(auth.verifySession(cookie));users.rotatePassword(await hashPassword('changed-synthetic-password'));assert.equal(auth.verifySession(cookie),null);
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.ok(fs.readdirSync(path.join(data,'backups')).some(n=>n.startsWith('agent-office-premigrate-v023')));
  h.close();h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  assert.deepEqual(h.applied,[],'reopening does not rerun either migration');
  assert.equal(h.db.prepare('SELECT value FROM runtime_detection WHERE id=1').get().value,detection);
  assert.equal(h.db.prepare('SELECT role_id FROM users WHERE id=?').get(row.id).role_id,'rol_admin');
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('fresh installation has contiguous migrations through 028 after deleted-email reuse and survives reopen',t=>{
  const {store,admin}=fixture(t),dir=store.dir;
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version),Array.from({length:28},(_,i)=>i+1));
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_detection'").get().name,'runtime_detection');
  const installationId=store.rbac.state().installation_id;
  store.db.prepare("INSERT INTO runtime_detection VALUES (1,'{}')").run();store.close();
  const again=openStore({dir,instance:'test',ownerName:'Synthetic admin',log:()=>{}});t.after(()=>again.close());
  assert.deepEqual(again.applied,[]);assert.equal(again.rbac.state().installation_id,installationId);
  assert.equal(again.users.owner().id,admin.id);assert.equal(again.db.prepare('SELECT value FROM runtime_detection').get().value,'{}');
  again.close();
});

test('migration 025 backfills unknown historical agent provenance while retaining ordinary comments across reopen',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-provenance-upgrade-')),mig=path.join(dir,'migrations'),data=path.join(dir,'data');
  fs.mkdirSync(mig);for(const name of fs.readdirSync(MIGRATIONS_DIR))if(Number(name.slice(0,3))<=24)fs.copyFileSync(path.join(MIGRATIONS_DIR,name),path.join(mig,name));
  let h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  t.after(()=>{h.close();fs.rmSync(dir,{recursive:true,force:true});});
  h.db.prepare("INSERT INTO projects(id,name,status,priority,last_activity_at,revision,created_at) VALUES ('prj_old','Historical','todo','P2',1,1,1)").run();
  const insert=h.db.prepare("INSERT INTO project_comments(id,project_id,author_kind,author_name,body,created_at) VALUES (?,'prj_old',?,'Synthetic',?,1)");
  insert.run('cmt_agent','agent','PRIVATE_HISTORICAL');insert.run('cmt_person','person','MANUAL_HISTORICAL');
  h.close();fs.copyFileSync(path.join(MIGRATIONS_DIR,'025_comment_provenance.sql'),path.join(mig,'025_comment_provenance.sql'));
  h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  assert.deepEqual(h.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version),Array.from({length:25},(_,i)=>i+1));
  const {createCommentsRepo}=require('../../src/store/repos/comments'),{PROJECT_CONTEXT_READS}=require('../../src/security/comment-provenance');
  let comments=createCommentsRepo(h.db);assert.deepEqual(comments.provenance('cmt_agent'),PROJECT_CONTEXT_READS);assert.equal(comments.provenance('cmt_person'),null);
  h.db.prepare("UPDATE project_comments SET provenance_json='[]' WHERE id='cmt_agent'").run();assert.equal(comments.provenance('cmt_agent'),false,'invalid metadata fails closed');
  h.close();h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});comments=createCommentsRepo(h.db);
  assert.deepEqual(h.applied,[]);assert.equal(comments.provenance('cmt_agent'),false);assert.equal(comments.get('cmt_person').body,'MANUAL_HISTORICAL');assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
