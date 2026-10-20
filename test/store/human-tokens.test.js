'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store'),{openDatabase,MIGRATIONS_DIR}=require('../../src/store/db');
const {hashPassword}=require('../../src/security/password');
let hash;before(async()=>{hash=await hashPassword('synthetic-token-password');});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-human-tokens-')),clock={now:1700000000000};
  const store=openStore({dir,instance:'test',ownerName:'Synthetic admin',now:()=>clock.now,log:()=>{}});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash}),ctx={userId:admin.id,authGeneration:0,requestId:'req_token',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'editor@example.invalid',name:'Editor',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const editor=store.users.byId(invite.user.id),audience=store.rbac.state().installation_id+'@https://api.example.invalid/backend';
  const issue=(user=editor,options={})=>store.humanTokens.createFamily({userId:user.id,expectedGeneration:user.auth_generation,origin:'https://office.example.invalid',audience,...options});
  const resolve=(token,options={})=>store.humanTokens.resolveAccess(token,{audience,origin:'https://office.example.invalid',...options});
  return {dir,store,clock,admin,editor,ctx,audience,issue,resolve};
}
test('opaque human records persist only digests, bind canonical origin/audience/live identity, and survive reopen',t=>{
  const f=fixture(t),issued=f.issue();assert.equal(issued.ok,true);assert.match(issued.accessToken,/^ao_at_[A-Za-z0-9_-]{43}$/);assert.match(issued.refreshToken,/^ao_rt_[A-Za-z0-9_-]{43}$/);
  const claims=f.resolve(issued.accessToken,{origin:'https://office.example.invalid'});assert.equal(claims.ok,true);assert.equal(claims.session.userId,f.editor.id);assert.equal(claims.session.personId,f.editor.person_id);assert.equal(claims.session.sid,issued.sessionId);
  for(const table of ['auth_families','human_access_tokens','refresh_tokens']) {
    const data=JSON.stringify(f.store.db.prepare('SELECT * FROM '+table).all());assert.ok(!data.includes(issued.accessToken));assert.ok(!data.includes(issued.refreshToken));assert.ok(!data.includes('synthetic-token-password'));
  }
  assert.equal(f.resolve(issued.accessToken,{audience:f.audience+'/wrong'}).issue,'unauthorized');assert.equal(f.resolve(issued.accessToken,{origin:'https://other.example.invalid'}).issue,'unauthorized');
  assert.equal(f.store.humanTokens.resolveAccess(issued.accessToken,{audience:f.audience}).issue,'unauthorized');
  for(const origin of [null,undefined,'null','http://office.example.invalid','https://office.example.invalid/','https://u:p@office.example.invalid','https://other.example.invalid'])assert.equal(f.resolve(issued.accessToken,{origin}).issue,'unauthorized');
  for(const raw of ['ao_at_invalid',issued.refreshToken,'aot_'+'a'.repeat(43),issued.accessToken+'x',null])assert.equal(f.resolve(raw).issue,'unauthorized');
  const other=openStore({dir:f.dir,instance:'test',ownerName:'Synthetic admin',now:()=>f.clock.now,log:()=>{}});t.after(()=>other.close());
  assert.deepEqual(other.humanTokens.resolveAccess(issued.accessToken,{audience:f.audience,origin:'https://office.example.invalid'}),claims);
});
test('recovery-only identities cannot create bearer families through the token repository',t=>{
  const f=fixture(t);
  assert.throws(()=>f.store.humanTokens.createFamily({userId:f.admin.id,expectedGeneration:f.admin.auth_generation,
    origin:'https://office.example.invalid',audience:f.audience,recoveryOnly:true}),/recovery-only/);
  const challenge=f.store.humanTokens.createChallenge({purpose:'login',origin:'https://office.example.invalid',audience:f.audience});
  assert.equal(challenge.ok,true);
  assert.throws(()=>f.store.humanTokens.loginFamily({userId:f.admin.id,expectedGeneration:f.admin.auth_generation,
    origin:'https://office.example.invalid',audience:f.audience,csrfToken:challenge.csrfToken,recoveryOnly:true}),/recovery-only/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM human_access_tokens').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,0);
});
test('live permission/role/registry claims fail stale while generations/status/family/expiry/audience fail unauthorized',t=>{
  for(const change of ['permissions','roleRevision','roleId','registry','generation','disabled','deleted','accessExpiry','idleExpiry','absoluteExpiry','sid']) {
    const f=fixture(t),issued=f.issue();
    if(change==='permissions')f.store.userManagement.overrides(f.editor.id,{expectedRevision:1,permissions:[{resource:'flows',level:'none'}]},f.ctx);
    if(change==='roleRevision')f.store.userManagement.editRole('rol_editor',{expectedRevision:1,name:'Changed',permissions:[]},f.ctx);
    if(change==='roleId')f.store.userManagement.editUser(f.editor.id,{expectedRevision:1,roleId:'rol_reader'},f.ctx);
    if(change==='registry'){f.store.registry.register([{key:'flows.future',parent:'flows',labelKey:'permissions.flows.future',privileged:false}],'core');f.store.rbac.sync(f.store.registry);}
    if(change==='generation')f.store.userManagement.revoke(f.editor.id,{expectedRevision:1},f.ctx);
    if(change==='disabled')f.store.userManagement.editUser(f.editor.id,{expectedRevision:1,status:'disabled'},f.ctx);
    if(change==='deleted')f.store.userManagement.deleteUser(f.editor.id,{expectedRevision:1},f.ctx);
    if(change==='accessExpiry')f.clock.now=issued.accessExpiresAt;
    if(change==='idleExpiry'){f.clock.now++;f.store.db.prepare('UPDATE auth_families SET idle_expires_at=?').run(f.clock.now);}
    if(change==='absoluteExpiry')f.clock.now=issued.refreshExpiresAt;
    if(change==='sid')f.store.sessions.revoke(issued.sessionId,issued.refreshExpiresAt);
    assert.equal(f.resolve(issued.accessToken).issue,['permissions','roleRevision','roleId','registry'].includes(change)?'access-stale':'unauthorized',change);
  }
});
test('new registry children make old tokens stale and remain denied after a new current token',t=>{
  const f=fixture(t),issued=f.issue();
  f.store.registry.register([{key:'flows.future',parent:'flows',labelKey:'permissions.flows.future',privileged:false}],'core');f.store.rbac.sync(f.store.registry);
  assert.equal(f.resolve(issued.accessToken).issue,'access-stale');
  const current=f.issue();assert.equal(f.resolve(current.accessToken).ok,true);
  assert.equal(f.store.policy.can(f.editor,'flows.future','read'),false);assert.equal(f.store.policy.can(f.editor,'flows.future','write'),false);
  const admin=f.issue(f.admin);assert.equal(f.resolve(admin.accessToken).ok,true);assert.equal(f.store.policy.can(f.admin,'flows.future','write'),true);
});
test('family revocation is immediate, idempotent, persisted and isolated from other families/users',t=>{
  const f=fixture(t),a=f.issue(),b=f.issue(),c=f.issue(f.admin),events=[];f.store.authorizationEvents.on('change',e=>events.push(e));
  assert.equal(f.store.humanTokens.revokeFamily(a.familyId,'logout'),true);assert.equal(f.store.humanTokens.revokeFamily(a.familyId,'logout'),false);
  assert.equal(f.resolve(a.accessToken).issue,'unauthorized');assert.equal(f.resolve(b.accessToken).ok,true);assert.equal(f.resolve(c.accessToken).ok,true);
  assert.deepEqual(events,[{familyId:a.familyId,sessionId:a.sessionId}]);
  const other=openStore({dir:f.dir,instance:'test',ownerName:'Synthetic admin',now:()=>f.clock.now,log:()=>{}});t.after(()=>other.close());assert.equal(other.humanTokens.resolveAccess(a.accessToken,{audience:f.audience,origin:'https://office.example.invalid'}).issue,'unauthorized');
  f.store.userManagement.revoke(f.editor.id,{expectedRevision:1},f.ctx);assert.equal(f.resolve(b.accessToken).issue,'unauthorized');assert.equal(f.resolve(c.accessToken).ok,true);
});
test('SSE ticket persistence stores only a digest and consumes once against live family and permission state',t=>{
  const f=fixture(t),issued=f.issue(),session=f.resolve(issued.accessToken).session;
  const make=(value=issued)=>f.store.humanTokens.createStreamTicket({userId:session.userId,familyId:value.familyId,sessionId:value.sessionId,origin:'https://office.example.invalid',audience:f.audience,
    topics:['office'],fingerprint:f.store.rbac.fingerprint(session.userId),sessionExpiresAt:value.accessExpiresAt});
  const ticket=make();assert.equal(ticket.ok,true);assert.match(ticket.ticket,/^ao_st_[A-Za-z0-9_-]{43}$/);
  const row=f.store.db.prepare('SELECT * FROM stream_tickets').get();assert.equal(row.consumed_at,null);assert.equal(row.family_id,issued.familyId);assert.deepEqual(JSON.parse(row.topics_json),['office']);assert.ok(!JSON.stringify(row).includes(ticket.ticket));
  assert.equal(f.store.humanTokens.consumeStreamTicket({ticket:ticket.ticket,origin:'https://other.example.invalid',audience:f.audience}).issue,'unauthorized');
  const consumed=f.store.humanTokens.consumeStreamTicket({ticket:ticket.ticket,origin:'https://office.example.invalid',audience:f.audience});assert.equal(consumed.ok,true);assert.equal(consumed.userId,session.userId);assert.deepEqual(consumed.topics,['office']);
  assert.equal(f.store.humanTokens.consumeStreamTicket({ticket:ticket.ticket,origin:'https://office.example.invalid',audience:f.audience}).issue,'unauthorized');
  const stale=make();f.store.userManagement.overrides(f.editor.id,{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx);
  assert.equal(f.store.humanTokens.consumeStreamTicket({ticket:stale.ticket,origin:'https://office.example.invalid',audience:f.audience}).issue,'unauthorized');
  const revoked=make();f.store.humanTokens.revokeFamily(issued.familyId,'logout');
  assert.equal(f.store.humanTokens.consumeStreamTicket({ticket:revoked.ticket,origin:'https://office.example.invalid',audience:f.audience}).issue,'unauthorized');
  f.clock.now+=30000;assert.equal(f.store.humanTokens.consumeStreamTicket({ticket:ticket.ticket,origin:'https://office.example.invalid',audience:f.audience}).issue,'unauthorized');
});
test('boundary reconciliation persistently revokes removed origins and old audiences, including tickets and linked cookies',t=>{
  const f=fixture(t),origin='https://office.example.invalid',retained='https://other.example.invalid';
  const removed=f.issue(f.editor,{linkedCookieSid:'synthetic-boundary-cookie',linkedCookieExpiresAt:f.clock.now+60000}),kept=f.issue(f.editor,{origin:retained}),oldAudience=f.issue(f.admin,{origin:retained,audience:f.audience+'-old'}),events=[];
  const ticket=(id,{familyId=null,cookieSid=null,origin,audience=f.audience})=>f.store.db.prepare('INSERT INTO stream_tickets(id,digest,user_id,family_id,cookie_sid,origin,audience,topics_json,fingerprint,session_expires_at,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id.padEnd(64,'a'),f.editor.id,familyId,cookieSid,origin,audience,'["office"]',f.store.rbac.fingerprint(f.editor.id),f.clock.now+60000,f.clock.now,f.clock.now+30000);
  ticket('family-ticket',{familyId:removed.familyId,origin});ticket('cookie-ticket',{cookieSid:'synthetic-ticket-cookie',origin});ticket('retained-ticket',{familyId:kept.familyId,origin:retained});ticket('old-cookie-ticket',{cookieSid:'synthetic-old-audience-cookie',origin:retained,audience:f.audience+'-old'});
  f.store.humanTokens.createChallenge({purpose:'login',origin,audience:f.audience});f.store.humanTokens.createChallenge({purpose:'refresh',origin:retained,audience:f.audience,refreshToken:kept.refreshToken});
  f.store.authorizationEvents.on('change',e=>{assert.equal(f.store.db.isTransaction,false);events.push(e);});
  assert.deepEqual(f.store.humanTokens.reconcileBoundary({audience:f.audience,origins:[retained]}),{familiesRevoked:2,ticketsRevoked:3,challengesInvalidated:2});
  assert.equal(f.resolve(removed.accessToken).ok,false);assert.equal(f.resolve(kept.accessToken,{origin:retained}).ok,true);assert.equal(f.resolve(oldAudience.accessToken,{origin:retained,audience:f.audience+'-old'}).ok,false);assert.equal(f.store.sessions.isRevoked('synthetic-boundary-cookie'),true);
  assert.equal(f.store.db.prepare('SELECT revoked_reason FROM auth_families WHERE id=?').get(removed.familyId).revoked_reason,'origin-removed');assert.equal(f.store.db.prepare('SELECT revoked_reason FROM auth_families WHERE id=?').get(oldAudience.familyId).revoked_reason,'audience-changed');
  assert.equal(f.store.db.prepare('SELECT revoked_at FROM stream_tickets WHERE id=?').get('retained-ticket').revoked_at,null);assert.ok(events.some(e=>e.sessionId==='synthetic-ticket-cookie'));
  assert.deepEqual(f.store.humanTokens.reconcileBoundary({audience:f.audience,origins:[origin,retained]}),{familiesRevoked:0,ticketsRevoked:0,challengesInvalidated:0});assert.equal(f.resolve(removed.accessToken).ok,false,'re-adding Origin never restores its family');
  const other=openStore({dir:f.dir,instance:'test',ownerName:'Synthetic admin',now:()=>f.clock.now,log:()=>{}});t.after(()=>other.close());assert.equal(other.humanTokens.resolveAccess(removed.accessToken,{origin,audience:f.audience}).ok,false);
});
test('boundary reconciliation is atomic with audit, emits only after commit and rejects malformed or joined activation',t=>{
  const f=fixture(t),issued=f.issue(f.editor,{linkedCookieSid:'synthetic-rollback-cookie',linkedCookieExpiresAt:f.clock.now+60000}),origin='https://office.example.invalid',nonce=f.store.humanTokens.createChallenge({purpose:'login',origin,audience:f.audience}),events=[];
  f.store.authorizationEvents.on('change',e=>events.push(e));
  assert.throws(()=>f.store.humanTokens.reconcileBoundary({audience:f.audience,origins:[],auditWrite:()=>{throw new Error('synthetic activation audit failure');}}),/activation audit failure/);
  assert.equal(f.resolve(issued.accessToken).ok,true);assert.equal(f.store.sessions.isRevoked('synthetic-rollback-cookie'),false);assert.equal(f.store.humanTokens.loginChallengeCurrent({csrfToken:nonce.csrfToken,origin,audience:f.audience}),true);assert.deepEqual(events,[]);
  for(const origins of [['null'],[origin+'/'],[origin,origin],Array(17).fill(origin)])assert.throws(()=>f.store.humanTokens.reconcileBoundary({audience:f.audience,origins}),/origin/);
  assert.throws(()=>f.store.withTx(()=>f.store.humanTokens.reconcileBoundary({audience:f.audience,origins:[]})),/requires its own transaction/);
  assert.deepEqual(f.store.humanTokens.reconcileBoundary({audience:f.audience,origins:[]}),{familiesRevoked:1,ticketsRevoked:0,challengesInvalidated:1});assert.equal(f.resolve(issued.accessToken).ok,false);assert.ok(events.some(e=>e.sessionId===issued.sessionId));
});
test('family creation rechecks captured generation, rejects invalid bounds and joined transactions, and rolls back failed minting',t=>{
  const f=fixture(t);f.store.userManagement.revoke(f.editor.id,{expectedRevision:1},f.ctx);
  assert.equal(f.issue().issue,'unauthorized');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);
  const current=f.store.users.byId(f.editor.id);
  for(const options of [{origin:'https://office.example.invalid/'},{origin:'http://office.example.invalid'},{origin:'https://u:p@office.example.invalid'},{origin:'null'},{origin:'https://*.example.invalid'},{audience:''},{accessTtlMs:299999},{accessTtlMs:900001},{idleMs:1},{absoluteMs:1},{expectedGeneration:-1}])assert.throws(()=>f.issue(current,options),/invalid token/);
  assert.throws(()=>f.store.withTx(()=>f.issue(current)),/requires its own transaction/);
  f.store.db.exec("CREATE TRIGGER synthetic_mint_failure BEFORE INSERT ON human_access_tokens BEGIN SELECT RAISE(ABORT,'synthetic mint failure'); END");
  assert.throws(()=>f.issue(current),/synthetic mint failure/);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,0);
});
test('historical access claims do not prevent deleting a reassigned custom role',t=>{
  const f=fixture(t),role=f.store.userManagement.createRole({name:'Synthetic custom'},f.ctx);
  f.store.userManagement.editUser(f.editor.id,{expectedRevision:1,roleId:role.id},f.ctx);
  const issued=f.issue(f.store.users.byId(f.editor.id));assert.equal(f.resolve(issued.accessToken).ok,true);
  f.store.userManagement.editUser(f.editor.id,{expectedRevision:2,roleId:'rol_reader'},f.ctx);
  f.store.userManagement.deleteRole(role.id,{expectedRevision:1},f.ctx);assert.equal(f.resolve(issued.accessToken).issue,'access-stale');
});
test('migration 026 upgrades synthetic 025 without changing users/generations/installation/registry and retains legacy cookies and machine tokens',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-token-upgrade-')),mig=path.join(dir,'migrations'),data=path.join(dir,'data');fs.mkdirSync(mig);
  for(const name of fs.readdirSync(MIGRATIONS_DIR))if(Number(name.slice(0,3))<=25)fs.copyFileSync(path.join(MIGRATIONS_DIR,name),path.join(mig,name));
  const clock=Date.now();let h=openDatabase({dir:data,instance:'test',migrationsDir:mig,now:()=>clock,log:()=>{}});t.after(()=>{h.close();fs.rmSync(dir,{recursive:true,force:true});});
  const users=require('../../src/store/repos/users').createUsersRepo(h.db,{now:()=>clock});
  h.db.exec("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES ('per_fixture','human','Fixture',1,1,1)");
  users.createOwner({email:'owner@example.invalid',passwordHash:hash,personId:'per_fixture'});users.prepareLegacy(3600000);
  const machine=require('../../src/store/repos/tokens').createTokensRepo(h.db).create({agentId:'synthetic-agent'});
  const {createAuth}=require('../../src/auth');
  const auth=()=>createAuth({secret:'synthetic-cookie-secret',ttlMs:3600000,passwordHash:hash,identity:{users:require('../../src/store/repos/users').createUsersRepo(h.db),state:()=>h.db.prepare('SELECT * FROM authorization_state').get()}});
  const owner=users.owner(),beforeAuth=auth(),legacy=beforeAuth.signSession({email:owner.email,exp:clock+60000}),modern=beforeAuth.signSession({email:owner.email,userId:owner.id,authGeneration:owner.auth_generation,exp:clock+60000,sid:'synthetic-cookie-sid'});
  const cookieClaims=[beforeAuth.verifySession(legacy),beforeAuth.verifySession(modern)];assert.equal(cookieClaims[0].userId,owner.id);assert.equal(cookieClaims[1].userId,owner.id);
  const beforeUsers=h.db.prepare('SELECT * FROM users').all(),beforeState=h.db.prepare('SELECT * FROM authorization_state').all();h.close();
  fs.copyFileSync(path.join(MIGRATIONS_DIR,'026_human_tokens.sql'),path.join(mig,'026_human_tokens.sql'));h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});
  assert.deepEqual(h.applied,[26]);assert.deepEqual(h.db.prepare('SELECT * FROM users').all(),beforeUsers);assert.deepEqual(h.db.prepare('SELECT * FROM authorization_state').all(),beforeState);
  assert.deepEqual([auth().verifySession(legacy),auth().verifySession(modern)],cookieClaims);
  assert.equal(require('../../src/store/repos/tokens').createTokensRepo(h.db).resolve(machine.token).id,machine.id);assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
  h.close();h=openDatabase({dir:data,instance:'test',migrationsDir:mig,log:()=>{}});assert.deepEqual(h.applied,[]);
});

function bootstrap(f,issued,purpose='refresh',options={}) {
  return f.store.humanTokens.createChallenge({purpose,origin:'https://office.example.invalid',audience:f.audience,refreshToken:issued?.refreshToken,...options});
}
function operation(f,issued,challenge,options={}) {
  return {origin:'https://office.example.invalid',audience:f.audience,refreshToken:issued.refreshToken,csrfToken:challenge.csrfToken,...options};
}
test('refresh rotation consumes a bound challenge/digest atomically, advances idle only, and returns fresh live claims',t=>{
  const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued);
  assert.deepEqual(Object.keys(challenge).sort(),['csrfToken','expiresAt','ok','purpose']);assert.match(challenge.csrfToken,/^ao_cs_[A-Za-z0-9_-]{43}$/);
  const original=f.store.db.prepare('SELECT * FROM auth_families WHERE id=?').get(issued.familyId);
  assert.equal(f.store.db.prepare('SELECT consumed_at FROM refresh_tokens').get().consumed_at,null);
  f.store.userManagement.overrides(f.editor.id,{expectedRevision:1,permissions:[{resource:'flows',level:'none'}]},f.ctx);
  assert.equal(f.resolve(issued.accessToken).issue,'access-stale');f.clock.now+=1000;
  const rotated=f.store.humanTokens.rotate(operation(f,issued,challenge));assert.equal(rotated.ok,true);assert.equal(rotated.familyId,issued.familyId);assert.equal(rotated.sessionId,issued.sessionId);
  assert.notEqual(rotated.accessToken,issued.accessToken);assert.notEqual(rotated.refreshToken,issued.refreshToken);assert.equal(rotated.refreshExpiresAt,issued.refreshExpiresAt);
  assert.equal(f.resolve(rotated.accessToken).ok,true);assert.equal(f.store.policy.can(f.editor,'flows','read'),false);
  const current=f.store.db.prepare('SELECT * FROM auth_families WHERE id=?').get(issued.familyId);assert.equal(current.idle_expires_at,original.idle_expires_at+1000);assert.equal(current.absolute_expires_at,original.absolute_expires_at);assert.equal(current.authenticated_at,original.authenticated_at);
  const rows=f.store.db.prepare('SELECT * FROM refresh_tokens ORDER BY created_at').all();assert.equal(rows.length,2);assert.equal(rows[0].successor_id,rows[1].id);assert.equal(rows[1].parent_id,rows[0].id);assert.equal(rows[0].consumed_at,f.clock.now);assert.equal(rows[1].consumed_at,null);
  assert.equal(f.store.db.prepare('SELECT consumed_at FROM auth_bootstrap_challenges').get().consumed_at,f.clock.now);
  for(const table of ['refresh_tokens','human_access_tokens','auth_bootstrap_challenges']){const data=JSON.stringify(f.store.db.prepare('SELECT * FROM '+table).all());for(const raw of [issued.refreshToken,rotated.refreshToken,rotated.accessToken,challenge.csrfToken])assert.ok(!data.includes(raw));}
});
test('exact lost-response replay revokes the whole successor family and tickets, independently of other users/families',t=>{
  const f=fixture(t),issued=f.issue(),other=f.issue(),admin=f.issue(f.admin),challenge=bootstrap(f,issued),events=[];f.store.authorizationEvents.on('change',e=>events.push(e));
  const args=operation(f,issued,challenge),rotated=f.store.humanTokens.rotate(args);assert.equal(rotated.ok,true);
  f.store.db.prepare("INSERT INTO stream_tickets(id,digest,user_id,family_id,origin,audience,topics_json,fingerprint,session_expires_at,created_at,expires_at) VALUES ('st_fixture',?,?,?,?,?,'[]','synthetic',?,?,?)").run('a'.repeat(64),f.editor.id,issued.familyId,'https://office.example.invalid',f.audience,rotated.accessExpiresAt,f.clock.now,f.clock.now+30000);
  assert.equal(f.store.humanTokens.rotate(args).issue,'unauthorized');assert.equal(f.resolve(rotated.accessToken).issue,'unauthorized');assert.equal(f.resolve(issued.accessToken).issue,'unauthorized');assert.equal(f.resolve(other.accessToken).ok,true);assert.equal(f.resolve(admin.accessToken).ok,true);
  assert.deepEqual(events,[{familyId:issued.familyId,sessionId:issued.sessionId}]);assert.equal(f.store.db.prepare('SELECT revoked_reason FROM auth_families WHERE id=?').get(issued.familyId).revoked_reason,'reuse');assert.equal(f.store.db.prepare('SELECT revoked_at FROM stream_tickets').get().revoked_at,f.clock.now);
  assert.equal(bootstrap(f,rotated).issue,'unauthorized');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id=?').get(issued.familyId).n,2);
  const again=openStore({dir:f.dir,instance:'test',now:()=>f.clock.now,log:()=>{}});t.after(()=>again.close());assert.equal(again.humanTokens.resolveAccess(rotated.accessToken,{audience:f.audience,origin:'https://office.example.invalid'}).issue,'unauthorized');
});
test('a fresh bound challenge for a consumed refresh still detects reuse; invalid replay boundaries cannot revoke',t=>{
  for(const variant of ['fresh','wrongOrigin','wrongAudience','wrongFamily','wrongPurpose','missing','expired']) {
    const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),rotated=f.store.humanTokens.rotate(operation(f,issued,challenge));let options={};
    if(variant==='fresh')options.csrfToken=bootstrap(f,issued).csrfToken;
    if(variant==='wrongOrigin')options.origin='https://other.example.invalid';
    if(variant==='wrongAudience')options.audience=f.audience+'/wrong';
    if(variant==='wrongFamily')options.csrfToken=bootstrap(f,f.issue()).csrfToken;
    if(variant==='wrongPurpose')options.csrfToken=bootstrap(f,issued,'logout').csrfToken;
    if(variant==='missing')options.csrfToken=undefined;
    if(variant==='expired')f.clock.now=challenge.expiresAt;
    assert.equal(f.store.humanTokens.rotate(operation(f,issued,challenge,options)).issue,'unauthorized',variant);
    assert.equal(f.resolve(rotated.accessToken).ok,variant!=='fresh',variant);
  }
});
test('refresh denies missing or reused CSRF, purpose/token swapping and expired/revoked/generation-changed families',t=>{
  for(const variant of ['missing','malformed','wrongOrigin','wrongFamily','wrongPurpose','wrongRefresh','future','challengeExpiry','accessToken','familyIdle','familyAbsolute','revoked','generation','disabled']) {
    const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),options={};
    if(variant==='missing')options.csrfToken=undefined;
    if(variant==='malformed')options.csrfToken='ao_cs_invalid';
    if(variant==='wrongOrigin')options.origin='https://other.example.invalid';
    if(variant==='wrongFamily')options.csrfToken=bootstrap(f,f.issue()).csrfToken;
    if(variant==='wrongPurpose')options.csrfToken=bootstrap(f,issued,'login').csrfToken;
    if(variant==='wrongRefresh')options.refreshToken=f.issue().refreshToken;
    if(variant==='future')f.clock.now--;
    if(variant==='challengeExpiry')f.clock.now=challenge.expiresAt;
    if(variant==='accessToken')options.refreshToken=issued.accessToken;
    if(variant==='familyIdle'){f.clock.now++;f.store.db.prepare('UPDATE auth_families SET idle_expires_at=? WHERE id=?').run(f.clock.now,issued.familyId);}
    if(variant==='familyAbsolute')f.clock.now=issued.refreshExpiresAt;
    if(variant==='revoked')f.store.humanTokens.revokeFamily(issued.familyId);
    if(variant==='generation')f.store.userManagement.revoke(f.editor.id,{expectedRevision:1},f.ctx);
    if(variant==='disabled')f.store.userManagement.editUser(f.editor.id,{expectedRevision:1,status:'disabled'},f.ctx);
    const n=f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n;
    assert.equal(f.store.humanTokens.rotate(operation(f,issued,challenge,options)).issue,'unauthorized',variant);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,n,variant);
    assert.equal(f.store.db.prepare('SELECT consumed_at FROM auth_bootstrap_challenges WHERE digest=?').get(require('node:crypto').createHash('sha256').update(challenge.csrfToken).digest('hex')).consumed_at,null,variant);
  }
});
test('rotation failure rolls back challenge, predecessor, successor, idle extension and notifications; own transaction required',t=>{
  const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),events=[];f.store.authorizationEvents.on('change',e=>events.push(e));
  const before=JSON.stringify(f.store.db.prepare('SELECT * FROM auth_families').all());f.clock.now+=1000;
  f.store.db.exec("CREATE TRIGGER synthetic_rotation_failure BEFORE INSERT ON human_access_tokens BEGIN SELECT RAISE(ABORT,'synthetic rotation failure'); END");
  assert.throws(()=>f.store.humanTokens.rotate(operation(f,issued,challenge)),/synthetic rotation failure/);assert.equal(f.store.db.prepare('SELECT consumed_at FROM refresh_tokens').get().consumed_at,null);assert.equal(f.store.db.prepare('SELECT consumed_at FROM auth_bootstrap_challenges').get().consumed_at,null);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,1);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM auth_families').all()),before);assert.deepEqual(events,[]);
  f.store.db.exec('DROP TRIGGER synthetic_rotation_failure');
  for(const fn of [()=>f.store.humanTokens.rotate(operation(f,issued,challenge)),()=>bootstrap(f,issued),()=>f.store.humanTokens.logout(operation(f,issued,bootstrap(f,issued,'logout'))),()=>f.store.humanTokens.revokeFamily(issued.familyId)])assert.throws(()=>f.store.withTx(fn),/requires its own transaction/);
  assert.equal(f.store.humanTokens.rotate(operation(f,issued,challenge)).ok,true);
});
test('family logout requires its one-use purpose binding, revokes linked cookie after commit, and is family isolated',t=>{
  const f=fixture(t),issued=f.issue(f.editor,{linkedCookieSid:'synthetic-linked-cookie'}),other=f.issue(),challenge=bootstrap(f,issued,'logout'),events=[];f.store.authorizationEvents.on('change',e=>events.push(e));
  assert.equal(f.store.humanTokens.logout(operation(f,issued,bootstrap(f,issued,'refresh'))).issue,'unauthorized');assert.equal(f.resolve(issued.accessToken).ok,true);
  f.store.db.exec("CREATE TRIGGER synthetic_logout_failure BEFORE UPDATE OF revoked_at ON human_access_tokens BEGIN SELECT RAISE(ABORT,'synthetic logout failure'); END");
  assert.throws(()=>f.store.humanTokens.logout(operation(f,issued,challenge)),/synthetic logout failure/);assert.equal(f.store.sessions.isRevoked('synthetic-linked-cookie'),false);assert.deepEqual(events,[]);
  f.store.db.exec('DROP TRIGGER synthetic_logout_failure');
  assert.deepEqual(f.store.humanTokens.logout(operation(f,issued,challenge)),{ok:true});assert.equal(f.resolve(issued.accessToken).issue,'unauthorized');assert.equal(f.resolve(other.accessToken).ok,true);assert.equal(f.store.sessions.isRevoked('synthetic-linked-cookie'),true);
  assert.deepEqual(events,[{familyId:issued.familyId,sessionId:issued.sessionId},{sessionId:'synthetic-linked-cookie'}]);assert.equal(f.store.humanTokens.logout(operation(f,issued,challenge)).issue,'unauthorized');
  f.clock.now=issued.refreshExpiresAt+1;f.store.maintenance();assert.equal(f.store.sessions.isRevoked('synthetic-linked-cookie'),true,'pruning the family cannot revive its linked cookie');
});
test('challenge records are digested, expire in two minutes and are bounded without consuming refresh tokens',t=>{
  const f=fixture(t),issued=f.issue(),first=bootstrap(f,issued);
  assert.equal(first.expiresAt,f.clock.now+120000);assert.equal(bootstrap(f,null).issue,'unauthorized');assert.equal(bootstrap(f,null,'logout').issue,'unauthorized');assert.equal(bootstrap(f,null,'login').ok,true);
  for(const purpose of ['unknown','ticket',null])assert.throws(()=>bootstrap(f,issued,purpose),/invalid challenge/);
  assert.equal(bootstrap(f,issued,'refresh',{origin:'https://other.example.invalid'}).issue,'unauthorized');
  for(let i=1;i<32;i++)assert.equal(bootstrap(f,issued).ok,true);assert.equal(bootstrap(f,issued).issue,'limited');
  assert.equal(f.store.db.prepare('SELECT consumed_at FROM refresh_tokens').get().consumed_at,null);assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM auth_bootstrap_challenges').all()).includes(first.csrfToken));
  f.clock.now=first.expiresAt;assert.equal(bootstrap(f,issued).ok,true);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_bootstrap_challenges').get().n,1);
});
test('separate database workers serialize simultaneous refresh, revoke the winner on reuse and never persist a second successor',async t=>{
  const {Worker}=require('node:worker_threads'),f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),signal=new SharedArrayBuffer(4),workers=[];
  const source="const {parentPort,workerData}=require('node:worker_threads');const store=require(workerData.module).openStore({dir:workerData.dir,instance:'test',now:()=>workerData.now,log:()=>{}});parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.signal),0,0);try{parentPort.postMessage({result:store.humanTokens.rotate(workerData.args)});}finally{store.close();}";
  const resultPromises=[],readyPromises=[];
  for(let i=0;i<2;i++) {
    const worker=new Worker(source,{eval:true,workerData:{module:require.resolve('../../src/store'),dir:f.dir,now:f.clock.now,signal,args:operation(f,issued,challenge)}});workers.push(worker);t.after(()=>worker.terminate());
    readyPromises.push(new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.ready)resolve();});worker.once('error',reject);}));
    resultPromises.push(new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.result)resolve(m.result);});worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('synthetic rotation worker failed'));});}));
  }
  await Promise.all(readyPromises);Atomics.store(new Int32Array(signal),0,1);Atomics.notify(new Int32Array(signal),0,2);
  const results=await Promise.all(resultPromises),winner=results.find(r=>r.ok);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).issue,'unauthorized');assert.equal(f.resolve(winner.accessToken).issue,'unauthorized');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,2);assert.equal(f.store.db.prepare('SELECT revoked_reason FROM auth_families').get().revoked_reason,'reuse');
});
test('rotation cannot extend absolute expiry; maintenance retains consumed digests until that deadline',t=>{
  const f=fixture(t),issued=f.issue(f.editor,{absoluteMs:300000,idleMs:300000}),challenge=bootstrap(f,issued);f.clock.now+=100000;
  const rotated=f.store.humanTokens.rotate(operation(f,issued,challenge));assert.equal(rotated.ok,true);assert.equal(rotated.accessExpiresAt,issued.refreshExpiresAt);assert.equal(f.store.db.prepare('SELECT idle_expires_at FROM auth_families').get().idle_expires_at,issued.refreshExpiresAt);
  f.store.humanTokens.revokeFamily(issued.familyId,'logout');f.clock.now=issued.refreshExpiresAt-1;
  assert.equal(f.store.maintenance().pruned.humanTokens.families,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get().n,2);
  f.clock.now++;assert.equal(f.store.maintenance().pruned.humanTokens.families,1);for(const table of ['auth_families','human_access_tokens','refresh_tokens','auth_bootstrap_challenges'])assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.throws(()=>f.store.humanTokens.pruneExpired(f.clock.now),/requires a transaction/);
});
test('the predecessor challenge cannot rotate or revoke the successor when presented with a different refresh digest',t=>{
  const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),rotated=f.store.humanTokens.rotate(operation(f,issued,challenge));
  assert.equal(f.store.humanTokens.rotate(operation(f,rotated,challenge)).issue,'unauthorized');assert.equal(f.resolve(rotated.accessToken).ok,true);
  assert.equal(f.store.humanTokens.rotate(operation(f,rotated,bootstrap(f,rotated))).ok,true);
});
function login(f,challenge,{user=f.editor,issued=null,...options}={}) {
  return f.store.humanTokens.loginFamily({userId:user.id,expectedGeneration:user.auth_generation,origin:'https://office.example.invalid',audience:f.audience,csrfToken:challenge.csrfToken,refreshToken:issued?.refreshToken,...options});
}
test('token login consumes its challenge once, creates current identity, replaces only presented family and revokes same-user cookie',t=>{
  const f=fixture(t),previous=f.issue(f.admin),unrelated=f.issue(f.admin),editorOther=f.issue(),challenge=bootstrap(f,previous,'login'),events=[];f.store.authorizationEvents.on('change',e=>events.push(e));
  const cookieSession={userId:f.editor.id,authGeneration:f.editor.auth_generation,sid:'synthetic-login-cookie',exp:f.clock.now+60000};
  const issued=login(f,challenge,{issued:previous,cookieSession});assert.equal(issued.ok,true);assert.equal(f.resolve(issued.accessToken).session.userId,f.editor.id);assert.equal(f.resolve(previous.accessToken).issue,'unauthorized');assert.equal(f.resolve(unrelated.accessToken).ok,true);assert.equal(f.resolve(editorOther.accessToken).ok,true);assert.equal(f.store.sessions.isRevoked(cookieSession.sid),true);
  const family=f.store.db.prepare('SELECT * FROM auth_families WHERE id=?').get(issued.familyId);assert.equal(family.linked_cookie_sid,cookieSession.sid);assert.equal(family.linked_cookie_expires_at,cookieSession.exp);
  assert.deepEqual(events,[{familyId:previous.familyId,sessionId:previous.sessionId},{sessionId:cookieSession.sid}]);assert.equal(login(f,challenge,{issued:previous,cookieSession}).issue,'unauthorized');assert.equal(f.resolve(issued.accessToken).ok,true,'login nonce replay never revokes the newly issued family');
  f.clock.now=cookieSession.exp+1;f.store.maintenance();assert.equal(f.store.sessions.isRevoked(cookieSession.sid),false,'verified cookie expiry bounds the tombstone retention');
});
test('login cookie replacement binds any recognized presented family even if its origin/audience/user changed or it is revoked',t=>{
  for(const variant of ['otherOrigin','otherAudience','revoked','generation','consumed','expired']) {
    const f=fixture(t),old=f.issue(f.admin,{...(variant==='otherOrigin'?{origin:'https://other.example.invalid'}:{}),...(variant==='otherAudience'?{audience:f.audience+'/old'}:{})});
    if(variant==='revoked')f.store.humanTokens.revokeFamily(old.familyId);
    if(variant==='generation')f.store.userManagement.revoke(f.admin.id,{expectedRevision:1},f.ctx);
    if(variant==='consumed')f.store.humanTokens.rotate(operation(f,old,bootstrap(f,old)));
    if(variant==='expired')f.clock.now=old.refreshExpiresAt;
    const challenge=bootstrap(f,old,'login'),issued=login(f,challenge,{issued:old});assert.equal(issued.ok,true,variant);assert.equal(f.resolve(issued.accessToken).ok,true,variant);assert.equal(f.resolve(old.accessToken).issue,'unauthorized',variant);
    assert.notEqual(f.store.db.prepare('SELECT revoked_at FROM auth_families WHERE id=?').get(old.familyId).revoked_at,null,variant);
  }
});
test('login refuses changed/missing refresh cookies, wrong/expired/consumed challenges and a stale password-verification generation',t=>{
  for(const variant of ['missingCookie','differentCookie','newCookie','wrongOrigin','wrongPurpose','expired','consumed','staleGeneration','disabled']) {
    const f=fixture(t),old=f.issue(f.admin),unbound=variant==='newCookie',challenge=bootstrap(f,unbound?null:old,'login');let options={issued:old};
    if(variant==='missingCookie')options.issued=null;
    if(variant==='differentCookie')options.issued=f.issue(f.admin);
    if(variant==='wrongOrigin')options.origin='https://other.example.invalid';
    if(variant==='wrongPurpose')options.csrfToken=bootstrap(f,old,'refresh').csrfToken;
    if(variant==='expired')f.clock.now=challenge.expiresAt;
    if(variant==='consumed')f.store.db.prepare('UPDATE auth_bootstrap_challenges SET consumed_at=?').run(f.clock.now);
    if(variant==='staleGeneration')f.store.userManagement.revoke(f.editor.id,{expectedRevision:1},f.ctx);
    if(variant==='disabled')f.store.userManagement.editUser(f.editor.id,{expectedRevision:1,status:'disabled'},f.ctx);
    const n=f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n;assert.equal(login(f,challenge,options).issue,'unauthorized',variant);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,n,variant);assert.equal(f.resolve(old.accessToken).ok,true,variant);
  }
});
test('login rollback restores replaced family, cookie revocation and nonce; unrelated/stale cookies do not link or revoke',t=>{
  const f=fixture(t),old=f.issue(f.admin),challenge=bootstrap(f,old,'login'),events=[],cookieSession={userId:f.editor.id,authGeneration:f.editor.auth_generation,legacyId:'synthetic-legacy-linked',exp:f.clock.now+60000};f.store.authorizationEvents.on('change',e=>events.push(e));
  f.store.db.exec("CREATE TRIGGER synthetic_login_failure BEFORE INSERT ON human_access_tokens BEGIN SELECT RAISE(ABORT,'synthetic login failure'); END");
  assert.throws(()=>login(f,challenge,{issued:old,cookieSession}),/synthetic login failure/);assert.equal(f.resolve(old.accessToken).ok,true);assert.equal(f.store.sessions.isRevoked(cookieSession.legacyId),false);assert.deepEqual(events,[]);assert.equal(f.store.db.prepare('SELECT consumed_at FROM auth_bootstrap_challenges').get().consumed_at,null);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM auth_families').get().n,1);
  f.store.db.exec('DROP TRIGGER synthetic_login_failure');assert.equal(login(f,challenge,{issued:old,cookieSession}).ok,true);assert.equal(f.store.sessions.isRevoked(cookieSession.legacyId),true);
  for(const cookie of [{userId:f.admin.id,authGeneration:0,sid:'synthetic-other-user',exp:f.clock.now+60000},{userId:f.editor.id,authGeneration:99,sid:'synthetic-stale-gen',exp:f.clock.now+60000},{userId:f.editor.id,authGeneration:f.editor.auth_generation,sid:'synthetic-expired',exp:f.clock.now}]) {
    const issued=login(f,bootstrap(f,null,'login'),{cookieSession:cookie});assert.equal(issued.ok,true);assert.equal(f.store.sessions.isRevoked(cookie.sid),false);assert.equal(f.store.db.prepare('SELECT linked_cookie_sid FROM auth_families WHERE id=?').get(issued.familyId).linked_cookie_sid,null);
  }
  assert.throws(()=>f.store.withTx(()=>login(f,bootstrap(f,null,'login'))),/requires its own transaction/);
});
test('migration027 adds optional verified cookie expiry without changing 026 credentials, digests, deadlines or revision claims',t=>{
  const f=fixture(t),issued=f.issue(),challenge=bootstrap(f,issued),db=f.store.db;
  // Reopen through a synthetic migration directory ending at 027. Later migration
  // rows must not make the runner skip a deliberately missing 027 in this fixture.
  const mig=path.join(f.dir,'migrations');fs.mkdirSync(mig);
  for(const name of fs.readdirSync(MIGRATIONS_DIR))if(Number(name.slice(0,3))<=27)fs.copyFileSync(path.join(MIGRATIONS_DIR,name),path.join(mig,name));
  db.exec('ALTER TABLE auth_families DROP COLUMN linked_cookie_expires_at');db.prepare('DELETE FROM schema_migrations WHERE version>=27').run();
  const before=JSON.stringify(db.prepare('SELECT * FROM auth_families').all()),accessBefore=JSON.stringify(db.prepare('SELECT * FROM human_access_tokens').all()),refreshBefore=JSON.stringify(db.prepare('SELECT * FROM refresh_tokens').all());f.store.close();
  const reopened=openDatabase({dir:f.dir,instance:'test',migrationsDir:mig,now:()=>f.clock.now,log:()=>{}});t.after(()=>reopened.close());
  const registry=require('../../src/security/resources').createResourceRegistry(),rbac=require('../../src/store/repos/rbac').createRbacRepo(reopened.db);rbac.sync(registry);
  const sessions=require('../../src/store/repos/sessions').createSessionsRepo(reopened.db),humanTokens=require('../../src/store/repos/human-tokens').createHumanTokensRepo(reopened.db,{rbac,sessions,now:()=>f.clock.now});
  const row={...reopened.db.prepare('SELECT * FROM auth_families').get()};assert.equal(row.linked_cookie_expires_at,null);delete row.linked_cookie_expires_at;assert.equal(JSON.stringify([row]),before);assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM human_access_tokens').all()),accessBefore);assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM refresh_tokens').all()),refreshBefore);
  assert.equal(humanTokens.resolveAccess(issued.accessToken,{audience:f.audience,origin:'https://office.example.invalid'}).ok,true);assert.equal(humanTokens.rotate(operation(f,issued,challenge)).ok,true);assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
