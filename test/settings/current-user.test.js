'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {settingsFixture}=require('../helpers/settings-fixture');
const {hashPassword,verifyPassword}=require('../../src/security/password');
const BASE='/api/v3/settings',PASSWORD='second-user-password';
async function fixture(t,options={}) {
  const h=await settingsFixture({enforceAuthorization:true,...options});t.after(()=>h.close());
  const admin=h.store.users.owner(),ctx={userId:admin.id,authGeneration:admin.auth_generation,requestId:'req_self_admin',authorize:()=>{}};
  const link=h.store.userManagement.invite({name:'Autre personne',email:'other@example.test',roleId:'rol_editor'},ctx);
  h.store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:await hashPassword(PASSWORD)},{requestId:'req_self_accept'});
  const login=await h.login(PASSWORD,link.user.email);assert.equal(login.status,200,login.text);
  const user=()=>h.store.users.byId(link.user.id),confirm=()=>h.post(BASE+'/reauth',{password:PASSWORD});
  const grants=permissions=>h.store.userManagement.overrides(user().id,{expectedRevision:user().permission_revision,permissions},ctx);
  return {h,user,admin,ctx,confirm,grants};
}
test('real guarded Settings edits and rotates the actual user without changing historical owner or instance files',async t=>{
  const {h,user,admin,confirm}=await fixture(t),before=[h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8'));
  const old=h.cookie,session=h.auth.sessionOf({headers:{cookie:old}});
  let vm=(await h.get(BASE)).json.data;assert.equal(vm.owner.email.value,user().email);assert.equal(vm.owner.revision,user().permission_revision);assert.equal(vm.instance,null);
  assert.equal((await h.put(BASE+'/owner',{expectedRevision:user().permission_revision,displayName:'Nouveau nom'})).status,403);
  assert.equal((await h.post(BASE+'/reauth',{password:h.password})).status,401,'historical owner password cannot confirm this user');
  assert.equal((await confirm()).status,200);
  const changed=await h.put(BASE+'/owner',{expectedRevision:user().permission_revision,displayName:'Nouvelle identité',email:'new-other@example.test'});assert.equal(changed.status,200,changed.text);assert.equal(changed.json.data.vm,null);
  assert.equal(h.auth.verifySession(old.split('=')[1]),null);const fresh=h.auth.sessionOf({headers:{cookie:h.cookie}});assert.equal(fresh.sid,session.sid);assert.equal(fresh.exp,session.exp);
  assert.equal(h.store.users.owner().email,admin.email);assert.equal(h.store.users.owner().password_hash,admin.password_hash);assert.equal(h.store.owner.name,'Camille');
  assert.deepEqual([h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8')),before);assert.equal(h.settings.revision(),1);
  vm=(await h.get(BASE)).json.data;assert.equal(vm.owner.displayName.value,'Nouvelle identité');assert.equal(vm.owner.email.value,'new-other@example.test');assert.equal(vm.reauth.expiresAt,null);
  assert.equal((await confirm()).status,200);const previous=h.cookie,nextPassword='replacement-second-password';
  const rotated=await h.post(BASE+'/password',{expectedRevision:user().permission_revision,password:nextPassword});assert.equal(rotated.status,200,rotated.text);assert.equal(h.auth.verifySession(previous.split('=')[1]),null);
  assert.ok(await verifyPassword(nextPassword,user().password_hash));assert.equal(h.store.users.owner().password_hash,admin.password_hash);
  assert.equal((await h.login(nextPassword,user().email)).status,200);
  const audits=h.store.audit.recent().filter(row=>row.outcome==='ok'&&['settings.owner','settings.password'].includes(row.command));assert.equal(audits.length,2);assert.ok(audits.every(row=>row.actor.personId===user().person_id&&row.target===user().id));assert.doesNotMatch(JSON.stringify(audits),/replacement-second-password|scrypt:/);
});
test('real Settings config writes use explicit grants and shared monotonic confirmation, not historical owner status',async t=>{
  const {h,grants,confirm}=await fixture(t);
  assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'Refusé'})).status,403);
  grants([{resource:'settings.instance',level:'write'},{resource:'settings.network',level:'write'}]);
  const saved=await h.put(BASE+'/instance',{expectedRevision:1,name:'Nouvel atelier'});assert.equal(saved.status,200,saved.text);
  const body={expectedRevision:2,mode:'local',port:18800,publicUrl:null};assert.equal((await h.put(BASE+'/network',body)).status,403);
  assert.equal((await confirm()).status,200);h.clock.elapsed=300000;assert.equal((await h.put(BASE+'/network',body)).status,403);
  assert.equal((await confirm()).status,200);const network=await h.put(BASE+'/network',body);assert.equal(network.status,200,network.text);assert.equal(network.json.data.vm.network.restartRequired,true);
  assert.equal(h.store.owner.name,'Camille');assert.equal(h.settings.revision(),3);
});
test('self stale revisions, strict bodies, reserved emails and audit failures cannot mutate the current account',async t=>{
  const {h,user,confirm,admin}=await fixture(t);await confirm();const original=user(),person=h.store.persons.list().find(p=>p.id===original.person_id);
  for(const [input,status] of [[{expectedRevision:original.permission_revision+1,displayName:'Stale'},409],[{expectedRevision:original.permission_revision,displayName:'Spoof',userId:admin.id},400],[{expectedRevision:original.permission_revision,email:admin.email},409]]) {
    const refused=await h.put(BASE+'/owner',input);assert.equal(refused.status,status,refused.text);
  }
  const append=h.store.audit.append;h.store.audit.append=row=>{if(row.command==='settings.owner'&&row.outcome==='ok')throw new Error('synthetic account audit failure');return append(row);};
  const failed=await h.put(BASE+'/owner',{expectedRevision:original.permission_revision,displayName:'Rollback'});assert.equal(failed.status,500,failed.text);
  assert.deepEqual(user(),original);assert.equal(h.store.persons.list().find(p=>p.id===original.person_id).name,person.name);
  assert.equal(h.store.audit.recent().filter(row=>row.command==='settings.owner'&&row.outcome==='ok').length,0);
});
test('permission changes during a real Settings probe or self hash discard output and prevent mutation',async t=>{
  let release,enter;const wait=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
  const {h,grants,confirm}=await fixture(t,{probe:async()=>{enter();await wait;return {status:'connected',protocol:3,latencyMs:1};}});
  grants([{resource:'settings.runtimes',level:'write'}]);await confirm();
  const pending=h.put(BASE+'/runtime',{expectedRevision:1,runtime:{adapter:'openclaw',gatewayUrl:h.gw.url,token:'changed-synthetic-token'}});await entered;grants([]);release();
  const rejected=await pending;assert.equal(rejected.status,403,rejected.text);assert.equal(h.settings.revision(),1);
  let hashEnter,hashRelease;const hashStarted=new Promise(resolve=>hashEnter=resolve),hashWait=new Promise(resolve=>hashRelease=resolve);
  const g=await fixture(t,{derivePassword:async()=>{hashEnter();await hashWait;return hashPassword('replacement-second-password');}});await g.confirm();const before=g.user();
  const hashing=g.h.post(BASE+'/password',{expectedRevision:before.permission_revision,password:'replacement-second-password'});await hashStarted;g.h.store.userManagement.revoke(before.id,{expectedRevision:before.permission_revision},g.ctx);hashRelease();
  assert.equal((await hashing).status,401);assert.equal(g.user().password_hash,before.password_hash);
});
test('externally managed current accounts stay immutable while authorized instance writes still work',async t=>{
  const {EMAIL,PASSWORD:OWNER_PASSWORD}=require('../helpers/settings-fixture');
  const h=await settingsFixture({enforceAuthorization:true,env:{PORTAL_EMAIL:EMAIL,PORTAL_PASSWORD:OWNER_PASSWORD,PORTAL_SECRET:'synthetic-env-secret'}});t.after(()=>h.close());
  const vm=(await h.get(BASE)).json.data;assert.equal(vm.owner.passwordChangeEnabled,false);assert.equal(vm.owner.email.source,'env');
  assert.equal((await h.reauth()).status,200);
  assert.equal((await h.put(BASE+'/owner',{expectedRevision:vm.owner.revision,displayName:'Imposé'})).status,403);
  assert.equal((await h.post(BASE+'/password',{expectedRevision:vm.owner.revision,password:'replacement-env-password'})).status,403);
  assert.equal((await h.put(BASE+'/instance',{expectedRevision:1,name:'Atelier modifié'})).status,200);
});
test('manual Settings detection rechecks authority before its deferred detector starts',async t=>{
  let calls=0;const {h,grants}=await fixture(t,{detect:async()=>{calls++;return [];}});
  grants([{resource:'settings.runtimes',level:'write'}]);
  const req={headers:{cookie:h.cookie},body:{},requestId:'req_deferred_detect',apiVersion:3};
  const {createRouteGuard}=require('../../src/security/route-policy'),{ROUTES}=require('../../src/security/route-declarations');
  let error;createRouteGuard(ROUTES.get('POST /settings/detect'),{store:h.store,auth:h.auth})(req,{},e=>{error=e;});assert.equal(error,undefined);
  const pending=h.settings.run('detect',req,{});grants([]);
  await assert.rejects(pending,e=>e.code==='forbidden');assert.equal(calls,0);
});
test('Settings integration plans belong to the issuing current user/session and cannot be applied by another session',async t=>{
  const {h,user,grants,confirm}=await fixture(t);
  grants([{resource:'settings.runtimes',level:'write'},{resource:'settings.integrations',level:'write'}]);await confirm();
  assert.equal((await h.post(BASE+'/detect')).status,200);
  const issued=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});assert.equal(issued.status,200,issued.text);
  const body={planId:issued.json.data.result.planId,agentIds:['atlas'],confirmed:true,action:'install'},originalCookie=h.cookie;
  assert.equal((await h.login(PASSWORD,user().email)).status,200);await confirm();
  const denied=await h.post(BASE+'/integrations/apply',body);assert.equal(denied.status,403,denied.text);assert.equal(denied.json.error.details[0].issue,'plan-owner');assert.equal(h.settings.revision(),1);
  h.cookie=originalCookie;const applied=await h.post(BASE+'/integrations/apply',body);assert.equal(applied.status,200,applied.text);assert.equal(h.settings.revision(),2);
});
