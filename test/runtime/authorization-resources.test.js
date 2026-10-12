'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {openStore}=require('../../src/store'),{hashPassword}=require('../../src/security/password');
const {createRuntimeController}=require('../../src/runtime-controller'),{definition}=require('../../src/adapters/demo');
const {createAdapterResourceBinding}=require('../../src/security/adapter-resources');
const descriptor=(key,parent=null)=>({key,parent,labelKey:'permissions.'+key,privileged:false});
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-adapter-permissions-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic admin',deferRegistrySync:true,log:()=>{}});
  const hash=await hashPassword('synthetic-adapter-password'),admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:admin.auth_generation,requestId:'req_resources',authorize:()=>{}};
  const link=store.userManagement.invite({email:'editor@example.invalid',name:'Editor',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const editor=store.users.byId(link.user.id);let created=0;
  const adapters={alpha:{permissionResources:[descriptor('adapter.alpha.tools'),descriptor('adapter.alpha.tools.run','adapter.alpha.tools')]},beta:{permissionResources:[descriptor('adapter.beta.tools')]}};
  for(const a of Object.values(adapters))Object.assign(a,{definition,createRuntime(){created++;return{definition,attach(){},close(){}};}});
  const resolveAdapter=id=>{if(!adapters[id])throw new Error('unknown synthetic adapter');return adapters[id];};
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,dir,admin,editor,ctx,adapters,resolveAdapter,created:()=>created};
}
const single=id=>({runtimeAdapter:id,agentNames:{},primaryAgent:null});
const multi=(ids=['alpha','beta'])=>({agentNames:{},primaryAgent:null,runtimeInstances:ids.map((adapter,index)=>({id:adapter+'-'+index,adapter,enabled:true,config:{adapter},cfg:{}}))});
test('actual single/multi controller boot and Settings prepare/apply bind adapter keys without new non-admin grants',async t=>{
  for(const start of [single('alpha'),multi(['alpha','alpha'])]) {
    const f=await fixture(t),controller=createRuntimeController({cfg:start,store:f.store,resolveAdapter:f.resolveAdapter,authorization:true});t.after(()=>controller.close());
    assert.equal(f.store.policy.can(f.admin,'adapter.alpha.tools','write'),true);
    assert.equal(f.store.policy.can(f.editor,'adapter.alpha.tools','read'),false);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM permission_resources WHERE key='adapter.alpha.tools'").get().n,1,'adapter contributions deduplicate across instances');
    const roleRevision=f.store.rbac.role('rol_editor').revision;
    f.store.userManagement.editRole('rol_editor',{expectedRevision:roleRevision,permissions:[{resource:'adapter.alpha.tools',mode:'explicit',level:'write'},{resource:'adapter.alpha.tools.run',mode:'inherit-parent'}]},f.ctx);
    const grants=f.store.db.prepare("SELECT * FROM role_permissions WHERE role_id='rol_editor' ORDER BY resource").all();
    const fingerprint=f.store.rbac.fingerprint(f.editor.id),revision=f.store.rbac.state().registry_revision;let changes=0;f.store.authorizationEvents.on('change',()=>changes++);
    const next=multi(['beta']),prepared=controller.prepare(next);
    assert.equal(f.store.registry.has('adapter.beta.tools'),false);assert.equal(f.store.rbac.state().registry_revision,revision);assert.equal(changes,0,'prepare does not change live permissions');
    controller.apply(next,prepared);
    assert.equal(f.store.rbac.state().registry_revision,revision+1);assert.equal(changes,1);assert.notEqual(f.store.rbac.fingerprint(f.editor.id),fingerprint);
    assert.equal(f.store.policy.can(f.editor,'adapter.alpha.tools.run','write'),false);assert.equal(f.store.policy.can(f.admin,'adapter.alpha.tools','write'),false);
    assert.equal(f.store.db.prepare("SELECT active FROM permission_resources WHERE key='adapter.alpha.tools'").get().active,0);
    assert.equal(f.store.policy.can(f.editor,'adapter.beta.tools','read'),false);assert.equal(f.store.policy.can(f.admin,'adapter.beta.tools','write'),true);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM role_permissions WHERE role_id='rol_editor' ORDER BY resource").all(),grants,'removed adapter grants preserved byte for byte');
    const restored=multi(['alpha','beta']);controller.apply(restored,controller.prepare(restored));
    assert.equal(f.store.policy.can(f.editor,'adapter.alpha.tools.run','write'),true,'only the old explicit child grant returns');
    f.adapters.alpha.permissionResources.push(descriptor('adapter.alpha.tools.future','adapter.alpha.tools'));
    const expanded=multi(['alpha','beta']);controller.apply(expanded,controller.prepare(expanded));
    assert.equal(f.store.policy.can(f.editor,'adapter.alpha.tools.future','read'),false);assert.equal(f.store.policy.can(f.editor,'adapter.alpha.tools.future','write'),false);
    assert.equal(f.store.policy.can(f.admin,'adapter.alpha.tools.future','write'),true);
    assert.equal(f.store.rbac.role('rol_editor').revision,roleRevision+1);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM role_permissions WHERE role_id='rol_editor' ORDER BY resource").all(),grants);
    const revisionNow=f.store.rbac.state().registry_revision;controller.apply(expanded);assert.equal(f.store.rbac.state().registry_revision,revisionNow,'unchanged config does not churn registry revision');
  }
});
test('invalid adapter declarations fail before runtime creation or config publication; canceled preparation stays inert',async t=>{
  const f=await fixture(t),controller=createRuntimeController({cfg:single('alpha'),store:f.store,resolveAdapter:f.resolveAdapter,authorization:true});t.after(()=>controller.close());
  const fingerprint=f.store.rbac.fingerprint(f.editor.id),before=f.created(),revision=f.store.rbac.state().registry_revision;
  for(const rows of [[descriptor('logs')],[descriptor('adapter.beta.orphan','adapter.beta.absent')],[descriptor('adapter.beta.one'),descriptor('adapter.beta.one')],[descriptor('adapter.beta.one','adapter.beta.two'),descriptor('adapter.beta.two','adapter.beta.one')]]) {
    f.adapters.beta.permissionResources=rows;assert.throws(()=>controller.prepare(multi(['beta'])),/invalid resource/);assert.equal(f.created(),before);
  }
  assert.equal(f.store.rbac.state().registry_revision,revision);assert.equal(f.store.rbac.fingerprint(f.editor.id),fingerprint);
  f.adapters.beta.permissionResources=[descriptor('adapter.beta.tools')];const canceled=controller.prepare(multi(['beta']));controller.dispose(canceled);
  assert.equal(f.store.rbac.state().registry_revision,revision);assert.equal(f.store.registry.has('adapter.beta.tools'),false);
  f.adapters.alpha.permissionResources=[descriptor('adapter.alpha.tools','adapter.alpha.other'),descriptor('adapter.alpha.other')];
  assert.throws(()=>controller.prepare(single('alpha')),/resource identity changed/);
});
test('cold boot preserves adapter registry revision and grants; disabled adapters become inert and prior resources restore on failed sync',async t=>{
  const f=await fixture(t),cfg=multi(),binding=createAdapterResourceBinding({store:f.store,resolveAdapter:f.resolveAdapter});
  binding.apply(binding.prepare(cfg),cfg);
  f.store.userManagement.editRole('rol_editor',{expectedRevision:1,permissions:[{resource:'adapter.alpha.tools',mode:'explicit',level:'read'}]},f.ctx);
  const fingerprint=f.store.rbac.fingerprint(f.editor.id),grants=f.store.db.prepare("SELECT * FROM role_permissions WHERE role_id='rol_editor' ORDER BY resource").all();
  const revision=f.store.rbac.state().registry_revision;f.store.close();
  const reopened=openStore({dir:f.dir,instance:'test',ownerName:'Synthetic admin',deferRegistrySync:true,log:()=>{}});t.after(()=>reopened.close());
  const restored=createAdapterResourceBinding({store:reopened,resolveAdapter:f.resolveAdapter});restored.apply(restored.prepare(cfg),cfg);
  assert.equal(reopened.rbac.state().registry_revision,revision);assert.equal(reopened.policy.can(f.admin,'adapter.alpha.tools','write'),true);
  assert.equal(reopened.rbac.fingerprint(f.editor.id),fingerprint);assert.equal(reopened.policy.can(f.editor,'adapter.alpha.tools','read'),true);
  assert.deepEqual(reopened.db.prepare("SELECT * FROM role_permissions WHERE role_id='rol_editor' ORDER BY resource").all(),grants);
  const disabled=multi();disabled.runtimeInstances.forEach(r=>{r.enabled=false;});
  const stage=restored.prepare(disabled),sync=reopened.rbac.sync;reopened.rbac.sync=()=>{throw new Error('synthetic sync failure');};
  assert.throws(()=>restored.apply(stage,disabled),/synthetic sync failure/);assert.equal(reopened.registry.has('adapter.alpha.tools'),true);assert.equal(reopened.rbac.state().registry_revision,revision);
  reopened.rbac.sync=sync;assert.throws(()=>restored.apply({},disabled),/unprepared resource binding/);
  assert.throws(()=>reopened.withTx(()=>restored.apply(stage,disabled)),/requires its own transaction/);
  restored.apply(stage,disabled);assert.equal(reopened.policy.can(f.admin,'adapter.alpha.tools','read'),false);assert.equal(reopened.registry.has('adapter.alpha.tools'),false);
});
