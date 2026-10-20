'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {startServer,TEST_EMAIL,TEST_PASSWORD}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario'),{openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {prepareAuthIdentity}=require('../../src/security/auth-identity'),IC=require('../../src/instance-config');
const confirmed=(action,target,name,body)=>({...body,confirmation:{action,target,name,revision:body.expectedRevision,changes:Object.fromEntries(Object.entries(body).filter(([key])=>key!=='expectedRevision'))}});
const sc=loadScenario('foreign-instance');
async function publishDatabase(home) {
  const store=openStore({dir:path.join(home,'data'),instance:'test',ownerName:'Synthetic historical owner',now:()=>sc.now,log:()=>{}});
  let account;
  try {account=store.users.createOwner({email:TEST_EMAIL,personId:store.owner.id,passwordHash:await hashPassword(TEST_PASSWORD)});}
  finally {store.close();}
  const config={version:2,auth:{rbacEnabled:true},instance:{name:'Synthetic RBAC',locale:'fr',timeZone:'UTC'},owner:{displayName:'Synthetic historical owner',email:TEST_EMAIL,authSource:'database'},runtime:{adapter:'demo',demo:{seed:7}},agents:{primary:null,looks:{}}};
  IC.writeInstanceConfig(IC.configPaths({HOME:home}),config,{version:2,sessionSecret:'synthetic-cookie-secret-for-db-boot',runtimeToken:null});
  return account;
}
test('operator-enabled server binds env/database identities and exposes guarded management, credential links, HTTP and SSE',async t=>{
  for(const database of [false,true]) {
    let historical;
    const h=await startServer(sc,{loginEnv:!database,demo:database,env:{...(database?{}:{AO_RBAC_ENABLED:'1',AO_ENV:'production'}),AO_API_ONLY:'1'},prepare:database?async home=>{historical=await publishDatabase(home);}:undefined});
    t.after(()=>h.stop());
    const adminCookie=h.cookie;
    const row=h.withStore(db=>db.prepare('SELECT * FROM users WHERE id=(SELECT owner_user_id FROM authorization_state)').get());
    assert.equal(row.credential_source,'database');assert.equal(row.role_id,'rol_admin');
    if(database){assert.equal(row.id,historical.id);assert.equal(row.person_id,historical.person_id);assert.equal(row.auth_generation,historical.auth_generation);}
    else {assert.match(row.password_hash,/^scrypt:/);assert.equal(h.withStore(db=>db.prepare('SELECT env_fingerprint FROM authorization_state').get()).env_fingerprint,null);}
    const list=await h.get('/api/v3/users');assert.equal(list.status,200);assert.equal(list.json.data.items[0].id,row.id);
    assert.equal((await h.get('/api/v2/users')).status,404);
    assert.equal((await h.post('/api/v3/settings/reauth',{password:TEST_PASSWORD})).status,200);
    const body={expectedRevision:0,email:'reader@example.invalid',name:'Synthetic reader',roleId:'rol_reader'};
    const issued=await h.post('/api/v3/users/invitations',confirmed('users.invite',body.email,body.name,body));assert.equal(issued.status,200,issued.text);
    const reader=issued.json.data.result.user;
    h.cookie='';
    const accept=await h.post('/api/auth/invitations/accept',{token:issued.json.data.result.token,password:'synthetic-reader-password'});assert.equal(accept.status,200,accept.text);
    const login=await h.post('/api/login',{email:body.email,password:'synthetic-reader-password'});assert.equal(login.status,200);h.cookie=login.headers.get('set-cookie').split(';')[0];
    const readerCookie=h.cookie;
    for(const version of [2,3]) {
      assert.equal((await h.get('/api/v'+version+'/views/projects')).status,200);
      assert.equal((await h.get('/api/v'+version+'/views/logs')).status,403);
      assert.equal((await h.post('/api/v'+version+'/gateway/restart')).status,403);
    }
    assert.equal((await h.get('/api/v3/users')).status,403);
    const streamAbort=new AbortController(),deadline=setTimeout(()=>streamAbort.abort(),10000);t.after(()=>{clearTimeout(deadline);streamAbort.abort();});
    const stream=await fetch(h.base+'/api/v3/stream?topics=projects',{headers:{cookie:readerCookie},signal:streamAbort.signal});assert.equal(stream.status,200);
    const read=stream.body.getReader(),first=await read.read();assert.match(Buffer.from(first.value).toString(),/event: hello/);
    h.cookie=adminCookie;
    const revokeBody={expectedRevision:reader.revision};
    assert.equal((await h.post('/api/v3/users/'+reader.id+'/revoke-sessions',confirmed('users.revokeSessions',reader.id,reader.name,revokeBody))).status,200);
    let closed=false;
    try {for(let i=0;i<10;i++){const chunk=await read.read();if(chunk.done){closed=true;break;}}}
    catch(error){assert.equal(error.cause?.code,'UND_ERR_SOCKET','revocation destroys the socket without sending another frame');closed=true;}
    assert.equal(closed,true);clearTimeout(deadline);streamAbort.abort();
    h.cookie=readerCookie;assert.equal((await h.get('/api/v3/views/logs')).status,401);
    h.cookie=adminCookie;assert.equal((await h.get('/api/v3/users')).status,200);
    const audit=h.withStore(db=>db.prepare("SELECT actor_json FROM audit_log WHERE command='users.revokeSessions' AND outcome='ok'").get());assert.equal(JSON.parse(audit.actor_json).personId,row.person_id);
    assert.equal(h.gw.callsTo('gateway.restart.request').length,0);
  }
});
test('boot identity preserves stable ids across restart and changed env credentials cannot replace migrated database identity',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rbac-identity-boot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg={sessionSecret:'synthetic-env-secret',sessionTtlMs:60000,loginEmail:'ENV@example.invalid',loginPassword:'synthetic-env-password',authDatabase:false};
  let store=openStore({dir,instance:'test',ownerName:'Historical',log:()=>{}});
  let identity=prepareAuthIdentity({cfg,store}),user=store.users.owner(),state=store.rbac.state();
  const makeAuth=()=>createAuth({secret:cfg.sessionSecret,ttlMs:cfg.sessionTtlMs,password:cfg.loginPassword,identity,revocations:store.sessions,allowMultiUser:true});
  const oldAuth=makeAuth(),legacy=oldAuth.signSession({email:'untrusted-signed@example.invalid',exp:Date.now()+30000});
  assert.equal(oldAuth.verifySession(legacy),null,'migration generation bump revokes pre-migration legacy cookies');
  const rows=JSON.stringify(store.db.prepare('SELECT * FROM users').all());assert.ok(!rows.includes(cfg.loginPassword));
  store.close();store=openStore({dir,instance:'test',ownerName:'Historical',log:()=>{}});t.after(()=>store.close());
  identity=prepareAuthIdentity({cfg:{...cfg,sessionTtlMs:120000},store});
  assert.equal(store.users.owner().id,user.id);assert.equal(store.users.owner().person_id,user.person_id);assert.equal(store.users.owner().auth_generation,user.auth_generation);
  assert.equal(store.rbac.state().legacy_cookie_deadline,state.legacy_cookie_deadline);assert.equal(makeAuth().verifySession(legacy),null,'conversion invalidates pre-migration legacy cookies');
  const ctx={userId:user.id,authGeneration:user.auth_generation,requestId:'req_identity',authorize:()=>{}};
  const link=store.userManagement.invite({name:'Reader',email:'reader@example.invalid',roleId:'rol_reader'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:await hashPassword('synthetic-reader-password')},{requestId:'req_accept'});
  const reader=store.users.byId(link.user.id),readerCookie=makeAuth().signSession({userId:reader.id,authGeneration:reader.auth_generation,sid:'reader-session',exp:Date.now()+30000});
  identity=prepareAuthIdentity({cfg:{...cfg,loginPassword:'changed-synthetic-password'},store});
  assert.equal(store.users.owner().id,user.id);assert.equal(store.users.owner().auth_generation,user.auth_generation);
  assert.equal(store.users.owner().credential_source,'database');assert.equal(store.users.owner().password_hash!==null,true,'changed env credentials cannot replace DB credentials');
  assert.equal(makeAuth().verifySession(legacy),null);assert.equal(makeAuth().verifySession(readerCookie).userId,reader.id);
});
test('actual setup boot validates both API aliases with operator-enabled coverage in static and API-only modes',async t=>{
  for(const apiOnly of [false,true]) {
    const h=await startServer(sc,{setupMode:true,env:{AO_RBAC_ENABLED:'1',AO_API_ONLY:apiOnly?'1':'0'}});t.after(()=>h.stop());
    for(const version of [2,3]){assert.equal((await h.get('/api/v'+version+'/meta')).status,200);assert.equal((await h.get('/api/v'+version+'/views/logs')).status,503);assert.equal((await h.post('/api/v'+version+'/setup/detect',{setupCode:'invalid'})).status,403);}
  }
});


test('invalid operator flag refuses setup startup before opening the store or printing a code',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rbac-invalid-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const result=require('node:child_process').spawnSync(process.execPath,['server.js'],{
    cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:10000,
    env:{HOME:home,PATH:require('../helpers/harness').testServerPath(),AO_ENV:'test',AO_DATA_DIR:path.join(home,'data'),AO_RBAC_ENABLED:'synthetic-invalid-private-value'}
  });
  assert.equal(result.status,1);assert.match(result.stderr,/AO_RBAC_ENABLED.*must be 0 or 1/);
  assert.ok(!result.stderr.includes('synthetic-invalid-private-value'));assert.ok(!result.stdout.includes('One-time setup code:'));
  assert.equal(fs.existsSync(path.join(home,'data','agent-office.sqlite')),false);
});

test('operator rollback to owner-only mode refuses previously issued reader cookies in env and database installs',async t=>{
  const snapshots=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rbac-rollback-'));t.after(()=>fs.rmSync(snapshots,{recursive:true,force:true}));
  for(const database of [false,true]) {
    const secret='synthetic-stable-cookie-rollback-secret';
    const enabled=await startServer(sc,{loginEnv:!database,demo:database,env:{AO_RBAC_ENABLED:'1',...(database?{}:{PORTAL_SECRET:secret})},prepare:database?publishDatabase:undefined});
    let snapshot,adminCookie,readerCookie;
    try {
      adminCookie=enabled.cookie;
      assert.equal((await enabled.post('/api/v3/settings/reauth',{password:TEST_PASSWORD})).status,200);
      const body={expectedRevision:0,email:'rollback-reader@example.invalid',name:'Rollback reader',roleId:'rol_reader'};
      const issued=await enabled.post('/api/v3/users/invitations',confirmed('users.invite',body.email,body.name,body));assert.equal(issued.status,200,issued.text);
      enabled.cookie='';assert.equal((await enabled.post('/api/auth/invitations/accept',{token:issued.json.data.result.token,password:'synthetic-rollback-reader-password'})).status,200);
      const login=await enabled.post('/api/login',{email:body.email,password:'synthetic-rollback-reader-password'});assert.equal(login.status,200);readerCookie=login.headers.get('set-cookie').split(';')[0];
      snapshot=path.join(snapshots,database?'database.sqlite':'env.sqlite');enabled.withStore(db=>db.prepare('VACUUM INTO ?').run(snapshot));
    }finally{await enabled.stop();}
    const disabled=await startServer(sc,{loginEnv:!database,demo:database,env:{AO_RBAC_ENABLED:'0',...(database?{}:{PORTAL_SECRET:secret})},prepare:async home=>{
      if(database) {
        await publishDatabase(home);
      }else fs.mkdirSync(path.join(home,'data'),{recursive:true});
      fs.copyFileSync(snapshot,path.join(home,'data','agent-office.sqlite'));
    }});t.after(()=>disabled.stop());
    disabled.cookie=readerCookie;
    for(const route of ['/api/me','/api/v2/me','/api/v3/me','/api/v3/settings','/api/v3/views/projects'])assert.equal((await disabled.get(route)).status,401,route+' refuses reader cookie after rollback');
    assert.equal((await disabled.post('/api/login',{email:'rollback-reader@example.invalid',password:'synthetic-rollback-reader-password'})).status,401);
    disabled.cookie=adminCookie;assert.equal((await disabled.get('/api/v3/settings')).status,200,'existing owner session remains bound to its identity');
    assert.equal((await disabled.get('/api/v3/users')).status,404,'management stays unmounted when disabled');
    assert.equal((await disabled.post('/api/login',{email:TEST_EMAIL,password:TEST_PASSWORD})).status,200);
  }
});
