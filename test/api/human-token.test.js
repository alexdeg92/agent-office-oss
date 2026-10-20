'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store'),{createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {createEngine}=require('../../src/engine'),{feed}=require('../helpers/feed'),{loadScenario}=require('../helpers/scenario');
const {createApp}=require('../../src/api/http'),{mountV2}=require('../../src/api/v2/routes'),{createCsrfGuard}=require('../../src/api/csrf');
const {createAgentTokenGate}=require('../../src/api/agent-token'),{createHumanTokenGate}=require('../../src/api/human-token'),{createHumanAuthTransport}=require('../../src/api/human-auth');
const {createAccessBoundary}=require('../../src/security/access-boundary'),{createRefreshLimits}=require('../../src/security/refresh-limits');
const {auditMiddleware}=require('../../src/api/audit'),{createRouteGuard}=require('../../src/security/route-policy'),{ROUTES}=require('../../src/security/route-declarations');
const {waitFor}=require('../helpers/harness');
const ORIGIN='https://office.example.invalid',API='https://api.example.invalid';let hash;before(async()=>{hash=await hashPassword('synthetic-token-password');});
async function fixture(t,{limits}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-human-token-')),store=openStore({dir,instance:'test',ownerName:'Admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash}),ctx={userId:admin.id,authGeneration:0,requestId:'req_token',authorize:()=>{}};
  const invite=store.userManagement.invite({email:'reader@example.invalid',name:'Reader',roleId:'rol_reader'},ctx);store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});const reader=store.users.byId(invite.user.id);
  const engine=feed(createEngine(),loadScenario('synthetic-basic'));for(const a of engine.agents())store.persons.ensureAgent(a.id,a.name);
  const auth=createAuth({secret:'synthetic-token-secret',identity:{users:store.users,state:store.rbac.state},revocations:store.sessions,allowMultiUser:true});
  let policy=createAccessBoundary({installationId:store.rbac.state().installation_id,apiPublicUrl:API+'/backend',origins:[ORIGIN,API]});
  const agentGate=createAgentTokenGate({tokens:store.tokens,personOf:id=>store.persons.ensureAgent(id,id).person.id,allowedAgent:()=>engine.agents()[0].id,audit:row=>store.audit.append(row)});
  const tokenGate=createHumanTokenGate({store,auth,boundary:()=>policy,agentGate,limits});
  const transport=createHumanAuthTransport({store,auth,boundary:()=>policy,me:()=>({})}),runtime={definition:{id:'synthetic',sessionKeyFor:(agentId,ref)=>'agent:'+agentId+':explicit:'+ref},commands:{}};let api;
  const app=createApp({readonly:false,apiOnly:true,publicDir:path.resolve('public'),trustProxy:'loopback',routeSecurity:{store,auth},humanTransport:transport,tokenGate,csrf:createCsrfGuard(),audit:auditMiddleware({store,sessionOf:req=>auth.sessionOf(req)}),mountRoutes:app=>{auth.mountRoutes(app,{isGwConnected:()=>false});api=mountV2(app,{store,auth,engine,enforceAuthorization:true,cfg:{instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,timeZone:'UTC',splitAuthEnabled:true,apiPublicUrl:API+'/backend'},runtime});}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{api.close();await api.thread.idle();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const mint=(user=reader,origin=ORIGIN)=>store.humanTokens.createFamily({userId:user.id,expectedGeneration:user.auth_generation,origin,audience:policy.audience});
  const cookie=(user=admin)=>'taco_sess='+auth.signSession({userId:user.id,authGeneration:user.auth_generation,sid:'cookie-'+user.id,exp:Date.now()+60000});
  const request=async(route,{token,headers={},method='GET',body,origin=ORIGIN}={})=>{const res=await fetch(base+route,{method,headers:{...(origin===null?{}:{origin}),'x-forwarded-proto':'https',...(token===undefined?{}:{authorization:'Bearer '+token}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json(),headers:res.headers};};
  return {store,auth,admin,reader,ctx,api,engine,runtime,base,mint,cookie,request,policy:()=>policy,setPolicy:({origins=[ORIGIN,API],apiPublicUrl=API+'/backend'}={})=>{policy=createAccessBoundary({installationId:store.rbac.state().installation_id,apiPublicUrl,origins});}};
}
test('human bearer uses the real current-user projections and permissions on both guarded API aliases',async t=>{
  const f=await fixture(t),reader=f.mint(),admin=f.mint(f.admin);
  for(const version of [2,3]) {
    const me=await f.request('/api/v'+version+'/me',{token:reader.accessToken,headers:{cookie:f.cookie()}});assert.equal(me.status,200);assert.equal(me.body.data.user.id,f.reader.id);assert.equal(me.body.data.permissions.logs,'none');assert.equal(me.headers.get('cache-control'),'no-store');assert.equal(me.headers.get('set-cookie'),null);assert.equal(me.headers.get('access-control-allow-credentials'),null);
    assert.equal((await f.request('/api/v'+version+'/views/logs',{token:reader.accessToken,headers:{cookie:f.cookie()}})).status,403);
    assert.equal((await f.request('/api/v'+version+'/views/logs',{token:admin.accessToken})).status,200);
    const denied=await f.request('/api/v'+version+'/projects',{method:'POST',token:reader.accessToken,body:{name:'Denied'}});assert.equal(denied.status,403);
  }
  assert.ok(f.store.audit.recent().filter(e=>e.command==='projects.create').every(e=>e.actor.personId===f.reader.person_id&&e.origin===ORIGIN));
});
test('split-origin SSE tickets pin topics, consume once and bind the live RBAC family',async t=>{
  const f=await fixture(t),admin=f.mint(f.admin),reader=f.mint();
  const denied=await f.request('/api/v3/stream/ticket',{method:'POST',token:reader.accessToken,body:{topics:['logs']}});assert.equal(denied.status,403);
  const minted=await f.request('/api/v3/stream/ticket',{method:'POST',token:admin.accessToken,body:{topics:['office']}});assert.equal(minted.status,200,JSON.stringify(minted.body));
  const {ticket,streamUrl,expiresAt}=minted.body.data;assert.match(ticket,/^ao_st_[A-Za-z0-9_-]{43}$/);assert.ok(expiresAt>Date.now()&&expiresAt<=Date.now()+30000);
  const target=new URL(streamUrl),stored=f.store.db.prepare('SELECT * FROM stream_tickets WHERE digest=?').get(require('node:crypto').createHash('sha256').update(ticket).digest('hex'));
  assert.deepEqual([...target.searchParams.keys()],['ticket']);assert.deepEqual(JSON.parse(stored.topics_json),['office']);assert.equal(stored.consumed_at,null);
  const localPath=target.pathname.replace(/^\/backend(?=\/)/,''),controller=new AbortController(),stream=await fetch(f.base+localPath+target.search,{headers:{origin:ORIGIN,'x-forwarded-proto':'https'},signal:controller.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const chunk=await stream.body.getReader().read();assert.match(Buffer.from(chunk.value).toString('utf8'),/event: hello/);controller.abort();
  assert.ok(f.store.db.prepare('SELECT consumed_at FROM stream_tickets WHERE id=?').get(stored.id).consumed_at);
  assert.equal((await fetch(f.base+localPath+target.search,{headers:{origin:ORIGIN,'x-forwarded-proto':'https'}})).status,401,'ticket cannot reconnect or replay');
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM stream_tickets').all()).includes(ticket),'only ticket digest is persisted');
});
test('Authorization presence never falls back to cookie; credential purposes and actual origins are mandatory',async t=>{
  const f=await fixture(t),family=f.mint();
  const values=['','Basic synthetic','Bearer invalid','Bearer '+family.refreshToken,'Bearer ao_st_'+'x'.repeat(43),'Bearer ao_cs_'+'x'.repeat(43),'Bearer ao_inv_'+'x'.repeat(43),'Bearer ao_rst_'+'x'.repeat(43),'Bearer '+family.accessToken+' extra'];
  for(const authorization of values){const result=await f.request('/api/v3/me',{headers:{authorization,cookie:f.cookie()}});assert.equal(result.status,401);assert.equal(result.headers.get('set-cookie'),null);}
  assert.equal((await f.request('/api/v3/me',{token:family.accessToken,origin:null,headers:{cookie:f.cookie(),'x-ao-request':'1',referer:ORIGIN+'/'}})).status,401);
  assert.equal((await f.request('/api/v3/me',{token:family.accessToken,origin:API})).status,401,'another allowed origin cannot use the family');
  const unlisted=await f.request('/api/v3/me',{token:family.accessToken,origin:'https://evil.example.invalid'});assert.equal(unlisted.status,403);assert.equal(unlisted.headers.get('access-control-allow-origin'),null);
  assert.equal((await f.request('/api/v3/me',{headers:{cookie:f.cookie()}})).status,401,'cross-origin cookie is never human token authority');
  assert.equal((await f.request('/api/v3/me',{origin:null,headers:{cookie:f.cookie()}})).status,200);
  assert.equal((await f.request('/api/v3/me',{origin:API,headers:{cookie:f.cookie()}})).status,200);
});
test('machine tokens retain their original write scopes and actor without cookie or human grants',async t=>{
  const f=await fixture(t),machine=f.store.tokens.create({agentId:f.engine.agents()[0].id}),human=f.mint(f.admin);
  const created=await f.request('/api/v3/projects',{method:'POST',token:human.accessToken,body:{name:'Scoped project'}});assert.equal(created.status,200);const p=created.body.data.vm;
  assert.equal((await f.request('/api/v3/me',{token:machine.token,headers:{cookie:f.cookie()}})).status,403);
  const changed=await f.request('/api/v3/projects/'+p.id+'/status',{method:'PUT',token:machine.token,headers:{cookie:f.cookie()},body:{expectedRevision:p.revision,status:'in-progress'}});assert.equal(changed.status,200,JSON.stringify(changed.body));
  const row=f.store.audit.recent().find(e=>e.command==='projects.setStatus'&&e.outcome==='ok');assert.equal(row.actor.kind,'agent');assert.notEqual(row.actor.personId,f.admin.person_id);
});
test('fingerprint staleness, generation, origin and audience are live on every bearer resolution',async t=>{
  const f=await fixture(t),family=f.mint();
  f.store.userManagement.editRole('rol_reader',{expectedRevision:1,permissions:[{resource:'office',level:'read'}]},f.ctx);
  const stale=await f.request('/api/v3/me',{token:family.accessToken});assert.equal(stale.status,401);assert.deepEqual(stale.body.error.details,[{issue:'access-stale'}]);
  const challenge=f.store.humanTokens.createChallenge({purpose:'refresh',origin:ORIGIN,audience:f.policy().audience,refreshToken:family.refreshToken});
  const rotated=f.store.humanTokens.rotate({origin:ORIGIN,audience:f.policy().audience,refreshToken:family.refreshToken,csrfToken:challenge.csrfToken});assert.equal((await f.request('/api/v3/me',{token:rotated.accessToken})).status,200);
  f.setPolicy({origins:[API]});assert.equal((await f.request('/api/v3/me',{token:rotated.accessToken})).status,403);
  f.setPolicy({apiPublicUrl:API+'/changed'});assert.equal((await f.request('/api/v3/me',{token:rotated.accessToken})).status,401);
  f.setPolicy();f.store.userManagement.revoke(f.reader.id,{expectedRevision:1},f.ctx);assert.equal((await f.request('/api/v3/me',{token:rotated.accessToken})).status,401);
});
test('per-user API admission survives family changes, includes RBAC refusals and uses the trusted proxy IP',async t=>{
  const f=await fixture(t,{limits:createRefreshLimits({ipLimit:100,familyLimit:2})}),one=f.mint(),two=f.mint();
  assert.equal((await f.request('/api/v3/views/logs',{token:one.accessToken})).status,403);
  assert.equal((await f.request('/api/v3/me',{token:two.accessToken})).status,200);
  const denied=await f.request('/api/v3/me',{token:one.accessToken,headers:{'x-forwarded-for':'203.0.113.99'}});assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);
  assert.equal((await f.request('/api/v3/me',{token:f.mint(f.admin).accessToken})).status,200);
  const g=await fixture(t,{limits:createRefreshLimits({ipLimit:2,familyLimit:100})});
  assert.equal((await g.request('/api/v3/me',{token:'invalid'})).status,401);assert.equal((await g.request('/api/v3/me',{token:'invalid',origin:'https://evil.example.invalid'})).status,403);
  assert.equal((await g.request('/api/v3/me',{token:g.mint().accessToken})).status,429);
});
test('bearer confirmation binds its family, and account cookie refresh never upgrades bearer authority',async t=>{
  const f=await fixture(t),one=f.mint(),two=f.mint(),req=token=>({headers:{origin:ORIGIN,authorization:'Bearer '+token,cookie:f.cookie()},ip:'synthetic-confirm'});
  const r=req(one.accessToken);await f.api.reauthentication.confirm(r,'synthetic-token-password');assert.equal(f.api.reauthentication.requireRecent(r).userId,f.reader.id);assert.equal(f.api.reauthentication.expiresAt(req(two.accessToken)),null);
  r.session=f.auth.sessionOf(r);const headers={};f.auth.refreshSession(r,{setHeader:(k,v)=>headers[k]=v},{revokeOthers:true});assert.deepEqual(headers,{});
  f.store.humanTokens.revokeFamily(one.familyId);assert.equal(f.api.reauthentication.expiresAt(r),null);assert.equal(f.auth.sessionOf(req(two.accessToken)).userId,f.reader.id);
  assert.equal((await f.request('/api/logout',{method:'POST',token:two.accessToken,body:{}})).status,403);
});
test('durable command bindings contain no credential and recheck live family expiry/revocation',async t=>{
  const f=await fixture(t),family=f.mint(f.admin),req={headers:{origin:ORIGIN,authorization:'Bearer '+family.accessToken},requestId:'req_durable'};
  let error;createRouteGuard(ROUTES.get('POST /projects'),{store:f.store,auth:f.auth})(req,{},e=>error=e);assert.equal(error,undefined);
  const authority=require('../../src/security/dispatch-authority').createDispatchAuthority({store:f.store}),binding=authority.capture(req);
  assert.equal(binding.familyId,family.familyId);assert.ok(!JSON.stringify(binding).includes(family.accessToken));assert.equal(authority.authorize(binding,{commands:['projects.create']}).id,f.admin.id);
  assert.throws(()=>authority.authorize({...binding,origin:API},{commands:['projects.create']}),{code:'unauthorized'});
  assert.throws(()=>authority.authorize({...binding,expiresAt:Date.now()-1},{commands:['projects.create']}),{code:'unauthorized'});
  f.store.humanTokens.revokeFamily(family.familyId);assert.throws(()=>authority.authorize(binding,{commands:['projects.create']}),{code:'unauthorized'});
});
test('stream live verification retains the actual bearer origin and rejects revoked family before any send',async t=>{
  const f=await fixture(t),family=f.mint(),topics={declaration:id=>id==='office'?{resource:'office',level:'read'}:null};
  const security=require('../../src/security/stream-policy').createStreamPolicy({store:f.store,auth:f.auth,topics,project:(_,__,vm)=>vm,filterFrame:(_,__,data)=>data});
  const binding=security.capture({headers:{origin:ORIGIN,authorization:'Bearer '+family.accessToken}});assert.equal(binding.request.headers.origin,ORIGIN);assert.equal(security.can(binding,'office'),true);
  f.store.humanTokens.revokeFamily(family.familyId);assert.equal(security.valid(binding),false);assert.equal(security.can(binding,'office'),false);
});
test('the actual chat queue rechecks family authority after acknowledging a bearer command',async t=>{
  const f=await fixture(t),family=f.mint(f.admin);let turns=0;
  f.runtime.commands.agentTurn=async()=>{turns++;return {text:'Synthetic reply'};};
  const route=f.api.router.stack.find(l=>l.route?.path==='/chat/messages').route;
  const req={method:'POST',apiVersion:3,headers:{origin:ORIGIN,authorization:'Bearer '+family.accessToken},body:{text:'Revoked queued bearer command'},params:{},requestId:'req_bearer_queue'};let response;
  const res={req,status(n){this.statusCode=n;return this;},json(value){response=value;f.store.humanTokens.revokeFamily(family.familyId);}};
  route.dispatch(req,res,error=>{if(error)throw error;});assert.equal(res.statusCode,202);assert.ok(response.data.result.turnId);
  await waitFor(()=>f.api.commands.chatState().pending===null,{what:'revoked bearer queue'});assert.equal(turns,0);assert.equal(f.api.commands.chatState().errors.length,1);
});
