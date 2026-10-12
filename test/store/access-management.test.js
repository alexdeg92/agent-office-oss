'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
const {hashPassword}=require('../../src/security/password');
const {createAccessManagement}=require('../../src/store/repos/access-management');
let hash;
before(async()=>{hash=await hashPassword('synthetic-invite-password');});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-user-management-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic admin',log:()=>{}});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  let at=Date.now(),count=0;const changes=[];
  const ctx=user=>({userId:user.id,authGeneration:user.auth_generation,requestId:'req_synthetic_'+(++count),authorize:()=>{}});
  const api=createAccessManagement(store.db,{...store,now:()=>at,changed:event=>changes.push(event)});
  const invite=(roleId='rol_reader',email='reader@example.invalid')=>api.invite({name:'Synthetic reader',email,roleId},ctx(admin));
  const accept=link=>api.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  return {store,admin,api,ctx,invite,accept,changes,advance:ms=>{at+=ms;}};
}
test('invitations are hashed, expire, are single use and never issue a session',t=>{
  const f=fixture(t),link=f.invite();
  assert.match(link.token,/^ao_inv_[A-Za-z0-9_-]{43}$/);
  const saved=f.store.db.prepare('SELECT * FROM invitations').get();
  assert.equal(saved.token_hash.length,64);assert.notEqual(saved.token_hash,link.token);
  assert.equal(link.user.status,'invited');assert.equal('password_hash' in link.user,false);
  assert.deepEqual(f.accept(link),{accepted:true});
  assert.throws(()=>f.accept(link),/invalid-link/);
  assert.equal(f.store.users.byId(link.user.id).status,'active');
  const audit=JSON.stringify(f.store.audit.recent(50));
  assert.equal(audit.includes(link.token),false);assert.equal(audit.includes(hash),false);
  const second=f.invite('rol_reader','expires@example.invalid');f.advance(48*3600000);
  assert.throws(()=>f.accept(second),/invalid-link/);
  assert.equal(f.store.users.byId(second.user.id).status,'invited');
});
test('resend and administrative changes invalidate a pending link, including a hash-in-flight race',t=>{
  const f=fixture(t),link=f.invite();
  const newLink=f.api.resendInvitation(link.user.id,{expectedRevision:1},f.ctx(f.admin));
  assert.throws(()=>f.accept(link),/invalid-link/);
  f.api.editUser(link.user.id,{expectedRevision:1,roleId:'rol_editor'},f.ctx(f.admin));
  assert.throws(()=>f.accept(newLink),/invalid-link/,'acceptance rechecks status/generation/revision inside its transaction');
  assert.equal(f.store.users.byId(link.user.id).password_hash,null);
  const third=f.api.resendInvitation(link.user.id,{expectedRevision:2},f.ctx(f.admin));f.accept(third);
  assert.equal(f.store.users.byId(link.user.id).role_id,'rol_editor');
});
test('role permission edits revoke pending invitations of assigned users',t=>{
  const f=fixture(t),link=f.invite();
  f.api.editRole('rol_reader',{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx(f.admin));
  assert.throws(()=>f.accept(link),/invalid-link/);
});
test('sparse role edits merge changed grants and preserve omitted inherit-parent links',t=>{
  const f=fixture(t);
  const initial=f.api.editRole('rol_editor',{expectedRevision:1,permissions:[
    {resource:'office',level:'write'},
    {resource:'flows',level:'write'},
    {resource:'flows.edit',mode:'inherit-parent',level:null},
  ]},f.ctx(f.admin));
  const edited=f.api.editRole('rol_editor',{expectedRevision:initial.revision,permissions:[{resource:'chat',level:'read'}]},f.ctx(f.admin));
  const grants=new Map(edited.permissions.map(g=>[g.resource,g]));
  assert.equal(grants.get('office').level,'write');
  assert.equal(grants.get('flows').level,'write');
  assert.deepEqual(grants.get('flows.edit'),{resource:'flows.edit',mode:'inherit-parent',level:null});
  assert.equal(grants.get('chat').level,'read');
});
test('a name-only role edit preserves the existing grant set',t=>{
  const f=fixture(t);
  const initial=f.api.createRole({name:'Before',permissions:[
    {resource:'flows',level:'write'},
    {resource:'flows.edit',mode:'inherit-parent',level:null},
  ]},f.ctx(f.admin));
  const renamed=f.api.editRole(initial.id,{expectedRevision:initial.revision,name:'After'},f.ctx(f.admin));
  assert.equal(renamed.name,'After');
  assert.deepEqual(renamed.permissions,initial.permissions);
});
test('audit failure rolls back role writes and invitation consumption; notifications follow commit',t=>{
  const f=fixture(t);
  assert.throws(()=>f.api.createRole({name:'Rollback'},{...f.ctx(f.admin),requestId:''}),/audit entry rejected/);
  assert.equal(f.api.roles().length,3);assert.equal(f.changes.length,0);
  const link=f.invite(),before=f.changes.length;
  assert.throws(()=>f.api.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:''}),/audit entry rejected/);
  assert.equal(f.store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at,null);
  assert.equal(f.store.users.byId(link.user.id).status,'invited');assert.equal(f.changes.length,before);
  f.accept(link);assert.equal(f.changes.length,before+1);
});
test('outer transaction commit/rollback never writes management state or emits premature notifications',t=>{
  const f=fixture(t),link=f.invite(),before=f.changes.length,rows=f.store.audit.recent().length;
  const revision=()=>f.store.db.prepare("SELECT value FROM settings_state WHERE key='revision'").get().value,initial=revision();
  f.store.withTx(()=>{
    assert.throws(()=>f.api.createRole({name:'Nested'},f.ctx(f.admin)),/management-in-transaction/);
    assert.throws(()=>f.accept(link),/management-in-transaction/);
    f.store.db.prepare("UPDATE settings_state SET value=value+1 WHERE key='revision'").run();
  });
  assert.equal(revision(),initial+1);
  assert.throws(()=>f.store.withTx(()=>{
    assert.throws(()=>f.api.createRole({name:'Nested rollback'},f.ctx(f.admin)),/management-in-transaction/);
    assert.throws(()=>f.accept(link),/management-in-transaction/);
    f.store.db.prepare("UPDATE settings_state SET value=value+1 WHERE key='revision'").run();
    throw new Error('synthetic-outer-failure');
  }),/synthetic-outer-failure/);
  assert.equal(revision(),initial+1);
  assert.equal(f.api.roles().length,3);assert.equal(f.store.audit.recent().length,rows);
  assert.equal(f.changes.length,before);assert.equal(f.store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at,null);
  f.accept(link);assert.equal(f.changes.length,before+1);
});
test('the last active admin is protected, self-demotion with a second admin is audited as the actual actor',t=>{
  const f=fixture(t);
  for(const change of [{status:'disabled'},{roleId:'rol_reader'}])
    assert.throws(()=>f.api.editUser(f.admin.id,{expectedRevision:1,...change},f.ctx(f.admin)),/last-active-admin/);
  assert.throws(()=>f.api.deleteUser(f.admin.id,{expectedRevision:1},f.ctx(f.admin)),/last-active-admin/);
  assert.equal(f.store.audit.recent().length,0,'rolled-back mutations have no successful audit');
  const second=f.invite('rol_admin','second@example.invalid');
  assert.throws(()=>f.api.editUser(f.admin.id,{expectedRevision:1,status:'disabled'},f.ctx(f.admin)),/last-active-admin/,'invited admin is not active');
  f.accept(second);
  f.api.editUser(f.admin.id,{expectedRevision:1,roleId:'rol_reader'},f.ctx(f.admin));
  const entry=f.store.audit.recent().find(e=>e.command==='users.edit');
  assert.equal(entry.actor.personId,f.admin.person_id);
  assert.equal(f.store.users.byId(f.admin.id).role_id,'rol_reader');
  assert.throws(()=>f.api.createRole({name:'Forbidden'},f.ctx(f.admin)),/permission-denied/);
});
test('all management writes require current users:write and a server reauth closure; revision conflicts roll back',t=>{
  const f=fixture(t),link=f.invite();f.accept(link);const reader=f.store.users.byId(link.user.id);
  assert.throws(()=>f.api.createRole({name:'No authority'},{...f.ctx(f.admin),authorize:undefined}),/unauthorized/);
  assert.throws(()=>f.api.createRole({name:'Expired reauth'},{...f.ctx(f.admin),authorize:()=>{throw new Error('reauth-required');}}),/reauth-required/);
  assert.throws(()=>f.api.createRole({name:'Reader'},f.ctx(reader)),/permission-denied/);
  const before=f.store.audit.recent().length;
  assert.throws(()=>f.api.editUser(reader.id,{roleId:'rol_editor'},f.ctx(f.admin)),/revision-required/);
  assert.throws(()=>f.api.editUser(reader.id,{expectedRevision:7,roleId:'rol_editor'},f.ctx(f.admin)),/user-revision/);
  assert.equal(f.store.audit.recent().length,before);
  const old=f.ctx(f.admin);f.api.revoke(f.admin.id,{expectedRevision:1},old);
  assert.throws(()=>f.api.createRole({name:'Stale session'},old),/permission-denied/);
  assert.equal(f.store.audit.recent().find(e=>e.command==='users.revokeSessions').actor.personId,f.admin.person_id);
});
test('custom grants/default reset never backfill a new child; parent-none and concrete child-none still deny',t=>{
  const f=fixture(t),link=f.invite('rol_editor');f.accept(link);const user=f.store.users.byId(link.user.id);
  f.store.registry.register([{key:'flows.purge',parent:'flows',labelKey:'flows.purge',privileged:true}],'core');f.store.rbac.sync(f.store.registry);
  assert.equal(f.store.policy.can(user,'flows.purge','write'),false);
  const edited=f.api.editRole('rol_editor',{expectedRevision:1,permissions:[{resource:'flows',level:'write'},{resource:'flows.purge',mode:'inherit-parent',level:null}]},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'flows.purge','write'),true);
  f.api.resetRole('rol_editor',{expectedRevision:edited.revision},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'flows.purge','write'),false);
  f.api.overrides(user.id,{expectedRevision:1,permissions:[{resource:'flows',level:'write'}]},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'flows.purge','write'),false);
  f.api.overrides(user.id,{expectedRevision:2,permissions:[{resource:'flows',level:'none'},{resource:'flows.purge',level:'write'}]},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'flows.purge','write'),false);
  const custom=f.api.createRole({name:'Custom',permissions:[{resource:'projects',level:'read'}]},f.ctx(f.admin));
  assert.equal(custom.revision,1);
  assert.throws(()=>f.api.editRole('rol_admin',{expectedRevision:1,permissions:[]},f.ctx(f.admin)),/admin-immutable/);
  assert.throws(()=>f.api.editRole(custom.id,{expectedRevision:1,permissions:[{resource:'projects',mode:'inherit-parent',level:null}]},f.ctx(f.admin)),/invalid-permissions/);
  f.api.deleteRole(custom.id,{expectedRevision:1},f.ctx(f.admin));assert.equal(f.store.rbac.role(custom.id),null);
});
test('password reset revokes the target generation; disable/re-enable and tombstones preserve actor identity',t=>{
  const f=fixture(t),link=f.invite();f.accept(link);const user=f.store.users.byId(link.user.id);
  const reset=f.api.resetPassword(user.id,{expectedRevision:1},f.ctx(f.admin));
  assert.match(reset.token,/^ao_rst_/);assert.equal(f.store.users.byId(user.id).auth_generation,user.auth_generation+1);
  assert.throws(()=>f.api.accept({token:reset.token,purpose:'invite',passwordHash:hash},{requestId:'req_wrong'}),/invalid-link/);
  f.api.accept({token:reset.token,purpose:'password-reset',passwordHash:hash},{requestId:'req_reset'});
  assert.throws(()=>f.api.accept({token:reset.token,purpose:'password-reset',passwordHash:hash},{requestId:'req_reset_replay'}),/invalid-link/);
  const disabled=f.api.editUser(user.id,{expectedRevision:1,status:'disabled'},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'office','read'),false);
  const active=f.api.editUser(user.id,{expectedRevision:disabled.revision,status:'active'},f.ctx(f.admin));
  assert.equal(f.store.policy.can(user,'office','read'),true);
  f.api.deleteUser(user.id,{expectedRevision:active.revision},f.ctx(f.admin));
  const dead=f.store.users.byId(user.id);assert.equal(dead.status,'deleted');assert.equal(dead.password_hash,null);assert.ok(dead.deleted_at);
  assert.equal(f.store.db.prepare('SELECT name FROM persons WHERE id=?').get(user.person_id).name,'Synthetic reader');
  assert.equal(f.api.list().some(u=>u.id===user.id),false);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const details=JSON.stringify(f.store.db.prepare('SELECT changes_json FROM permission_audit_changes').all());
  assert.equal(details.includes(reset.token),false);assert.equal(details.includes(hash),false);
});
test('a deleted address can be re-invited without reviving its old identity or credentials',async t=>{
  const f=fixture(t),first=f.invite('rol_reader','Reuse@example.invalid');
  f.accept(first);
  const old=f.store.users.byId(first.user.id);
  const auth=require('../../src/auth').createAuth({secret:'synthetic-reinvite-secret',ttlMs:60000,identity:{users:f.store.users,state:f.store.rbac.state},allowMultiUser:true});
  const login=async email=>{
    const req={ip:'127.0.0.1'},gate=auth.reserveCredentialAttempt(req);
    assert.equal(gate.ok,true);
    let verified;
    try {verified=await auth.verifyAdmittedCredentials(req,{email,password:'synthetic-invite-password'},gate);}
    finally {gate.release(verified?.ok===true);}
    return verified;
  };
  assert.equal((await login('reuse@EXAMPLE.invalid')).ok,true);
  f.api.deleteUser(old.id,{expectedRevision:old.permission_revision},f.ctx(f.admin));
  assert.equal(f.store.users.byId(old.id).status,'deleted');
  assert.equal((await login('reuse@example.invalid')).ok,false,'deleted credentials cannot authenticate');
  const replacement=f.invite('rol_reader','rEuSe@example.invalid');
  assert.notEqual(replacement.user.id,old.id,'a tombstoned ID is never revived');
  assert.equal(replacement.user.status,'invited');
  assert.equal(f.store.users.credential('REUSE@example.invalid').id,replacement.user.id);
  assert.throws(()=>f.accept(first),/invalid-link/,'the old invitation/session cannot be reused');
  assert.equal(f.store.users.byId(old.id).auth_generation,old.auth_generation+1);
  const pending=f.invite('rol_reader','pending-delete@example.invalid'),pendingRow=f.store.users.byId(pending.user.id);
  f.api.deleteUser(pendingRow.id,{expectedRevision:pendingRow.permission_revision},f.ctx(f.admin));
  assert.throws(()=>f.accept(pending),/invalid-link/,'a deleted invite target cannot accept its former link');
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
