'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../../src/store');
const {createAuth}=require('../../src/auth');
const {hashPassword}=require('../../src/security/password');
const {createStreamHub}=require('../../src/api/v2/stream');
const {createStreamPolicy}=require('../../src/security/stream-policy');
const {createVersionedTopics}=require('../../src/api/v2/topics');
const {TOPICS}=require('../../src/security/route-declarations');
const {createResourceRegistry}=require('../../src/security/resources');
let hash;before(async()=>{hash=await hashPassword('synthetic-stream-password');});
function response() {
  const res=new EventEmitter();res.lines=[];res.block=false;res.ended=false;res.writableLength=0;
  res.writeHead=()=>{};res.write=line=>{res.lines.push(String(line));return !res.block;};
  res.destroy=res.end=()=>{res.ended=true;};return res;
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-stream-policy-'));
  const store=openStore({dir,instance:'test',ownerName:'Admin',log:()=>{}});
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_stream',authorize:()=>{}};
  const readers=[1,2].map(i=>{
    const invite=store.userManagement.invite({name:'Reader '+i,email:'reader'+i+'@example.invalid',roleId:'rol_reader'},ctx);
    store.userManagement.accept({token:invite.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
    return store.users.byId(invite.user.id);
  });
  const auth=createAuth({secret:'synthetic-stream-secret',ttlMs:60000,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
  const topics=new EventEmitter(),builds=[];let value=0,pad='';
  topics.parse=id=>['office','logs'].includes(id)?{id}:null;
  topics.declaration=id=>topics.parse(id)&&{resource:id,level:'read'};
  topics.current=id=>{builds.push(id);return {id,rev:value+1,vm:{summary:value,secret:'synthetic-private-session',pad}};};
  const project=(user,id,vm)=>({summary:vm.summary,pad:vm.pad,actorId:user.id,...(store.policy.can(user,'logs','read')?{secret:vm.secret}:{})});
  const filterFrame=(user,type,data)=>{
    if(type==='cue'&&!store.policy.can(user,'logs','read'))return null;
    if(type==='settings'&&!store.policy.can(user,'settings.instance','read'))return null;
    if(type==='toast')return null;
    if(type==='system')return {type:'system',gateway:data.gateway,closing:data.closing};
    return structuredClone(data);
  };
  const admission=new Map(),hubs=[2,3].map(version=>createStreamHub({topics,engine:{sources:()=>[{id:'synthetic-private-source',state:'down'}]},systemState:()=>({gateway:'up',private:'synthetic-private-system'}),contractVersion:version+'.0',modelVersion:1,heartbeatMs:60000,admission,
    security:createStreamPolicy({store,auth,topics,project,filterFrame}),authorizationEvents:store.authorizationEvents}));
  const request=(user=readers[0],sid='synthetic-'+user.id,last)=>{
    const req=new EventEmitter();req.headers={cookie:'taco_sess='+auth.signSession({userId:user.id,authGeneration:user.auth_generation,sid,exp:Date.now()+60000})};
    if(last)req.headers['last-event-id']=last;req.query={topics:'office,logs'};req.session=auth.sessionOf(req);return req;
  };
  const open=(hub=hubs[0],user=readers[0],sid,last,res=response())=>{
    const req=request(user,sid,last);hub.open(req,res);return {req,res,st:[...hub._streams.values()].find(st=>st.res===res)};
  };
  const grant=(user,resource,level)=>store.userManagement.overrides(user.id,{expectedRevision:store.users.byId(user.id).permission_revision,permissions:[{resource,level}]},ctx);
  t.after(()=>{for(const hub of hubs)hub.closeAll();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,auth,admin,ctx,readers,topics,hubs,builds,request,open,grant,change(nextPad=''){pad=nextPad;value++;topics.emit('change',{id:'office',rev:value+1,baseRev:value,ops:[{op:'replace',path:'/secret',value:'raw-cache-secret'}]});}};
}
test('stream policy requires explicit topic and broadcast projectors',()=>{
  assert.throws(()=>createStreamPolicy({}),/projection callbacks required/);
});
test('both hubs deny topics before building and project each actor independently from shared raw cache',t=>{
  const f=fixture(t);
  for(const hub of f.hubs) {
    const reader=f.open(hub),admin=f.open(hub,f.admin);
    assert.match(reader.res.lines.join(''),/"topic":"logs","issue":"permission-denied"/);
    assert.doesNotMatch(reader.res.lines.join(''),/synthetic-private-session/);
    assert.match(admin.res.lines.join(''),/synthetic-private-session/);
    assert.match(reader.res.lines.join(''),new RegExp(f.readers[0].id));
    const other=f.open(hub,f.readers[1]);assert.match(other.res.lines.join(''),new RegExp(f.readers[1].id));
    f.change();
    assert.doesNotMatch(reader.res.lines.join(''),/raw-cache-secret|event: delta/);
    assert.match(reader.res.lines.at(-1),/"summary":/);
  }
  const fresh=fixture(t);fresh.open();assert.deepEqual(fresh.builds,['office']);
});
test('topic controls use verified identity, reject foreign streams and never build a forbidden topic',t=>{
  const f=fixture(t),a=f.open(),hub=f.hubs[0],before=f.builds.length;
  const control=f.request();control.params={streamId:a.st.id};control.body={add:['logs']};let reply;
  hub.changeTopics(control,{json:value=>{reply=value;}});assert.match(JSON.stringify(reply),/permission-denied/);assert.doesNotMatch(JSON.stringify(reply),/synthetic-private-source/);
  control.body={topic:'office'};hub.resync(control,{json:value=>{reply=value;}});assert.doesNotMatch(JSON.stringify(reply),/synthetic-private-source/);
  assert.deepEqual(f.builds.slice(before),['office']);const afterAllowedResync=f.builds.length;
  control.body={topic:'logs'};assert.throws(()=>hub.resync(control,{json(){}}),{code:'forbidden'});assert.equal(f.builds.length,afterAllowedResync);
  const foreign=f.request(f.readers[1]);foreign.params={streamId:a.st.id};foreign.body={add:[]};foreign.session=a.req.session;
  assert.throws(()=>hub.changeTopics(foreign,{json(){}}),{code:'not_found'});
  foreign.headers.cookie='taco_sess=invalid';assert.throws(()=>hub.changeTopics(foreign,{json(){}}),{code:'unauthorized'});
});
test('committed permission edits close both hubs immediately and release queued/replay data and timers',t=>{
  const f=fixture(t),a=f.open(f.hubs[0]),b=f.open(f.hubs[1]),other=f.open(f.hubs[1],f.readers[1]);
  a.res.block=true;f.change();f.change();assert.ok(a.st.snapshotWaiting.size);
  const before=a.res.lines.length;f.grant(f.readers[0],'office','none');
  for(const stream of [a,b]) {
    assert.equal(stream.res.ended,true);assert.equal(stream.st.closed,true);
    for(const name of ['expiry','heartbeat','gc','drain','inFlight'])assert.equal(stream.st[name],null);
    assert.equal(stream.st.buffer.length,0);assert.equal(stream.st.pending.length,0);assert.equal(stream.st.snapshotWaiting.size,0);
  }
  a.res.block=false;a.res.emit('drain');assert.equal(a.res.lines.length,before);assert.equal(other.res.ended,false);
});
test('live fingerprint rechecks stop a queued flush even without a notification',t=>{
  for(const change of ['permission','generation','role','registry','status']) {
    const f=fixture(t),a=f.open();a.res.block=true;f.change();f.change();const before=a.res.lines.length;
    if(change==='permission')f.store.db.prepare('UPDATE users SET permission_revision=permission_revision+1 WHERE id=?').run(f.readers[0].id);
    if(change==='generation')f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.readers[0].id);
    if(change==='role')f.store.db.prepare("UPDATE roles SET revision=revision+1 WHERE id='rol_reader'").run();
    if(change==='registry')f.store.db.prepare('UPDATE authorization_state SET registry_revision=registry_revision+1').run();
    if(change==='status')f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.readers[0].id);
    a.res.block=false;a.res.emit('drain');assert.equal(a.res.lines.length,before,change);assert.equal(a.st.closed,true,change);
  }
});
test('role edits invalidate every assigned user on both hubs while preserving an admin stream',t=>{
  const f=fixture(t),a=f.open(f.hubs[0]),b=f.open(f.hubs[1],f.readers[1]),admin=f.open(f.hubs[0],f.admin);
  f.store.userManagement.editRole('rol_reader',{expectedRevision:1,permissions:[{resource:'office',level:'none'}]},f.ctx);
  assert.equal(a.st.closed,true);assert.equal(b.st.closed,true);assert.equal(admin.st.closed,false);
});
test('a revoked identity cannot flush remaining slices of a large snapshot',t=>{
  const f=fixture(t);f.topics.current=id=>({id,rev:1,vm:{summary:1,pad:'x'.repeat(2*1024*1024)}});
  const res=response(),write=res.write;res.write=line=>{const ready=write(line);return String(line).includes('"topic":"office"')?false:ready;};
  const a=f.open(f.hubs[0],f.readers[0],undefined,undefined,res);assert.ok(a.st.inFlight);assert.ok(a.st.inFlight.offset<a.st.inFlight.bytes.length);
  const before=res.lines.length;f.store.userManagement.revoke(f.readers[0].id,{expectedRevision:1},f.ctx);
  res.emit('drain');assert.equal(res.lines.length,before);assert.equal(a.st.inFlight,null);assert.equal(a.st.closed,true);
});
test('reconnect after permission change discards the old replay buffer instead of leaking its projected base',t=>{
  const f=fixture(t),a=f.open(),last=a.st.id+':'+a.st.seq;a.req.emit('close');f.change();
  f.grant(f.readers[0],'office','none');
  const next=f.open(f.hubs[0],f.readers[0],undefined,last);
  assert.notEqual(next.st.id,a.st.id);assert.match(next.res.lines.join(''),/"resumed":false/);assert.doesNotMatch(next.res.lines.join(''),/event: snapshot/);
});
test('permission changes during a valid replay stop before the next serialized frame',t=>{
  const f=fixture(t),a=f.open(),last=a.st.id+':'+a.st.seq;a.req.emit('close');f.change();f.change();
  const res=response(),write=res.write;
  res.write=line=>{const ready=write(line);if(String(line).includes('event: hello'))f.store.db.prepare('UPDATE users SET permission_revision=permission_revision+1 WHERE id=?').run(f.readers[0].id);return ready;};
  f.open(f.hubs[0],f.readers[0],undefined,last,res);
  assert.match(res.lines.join(''),/"resumed":true/);assert.doesNotMatch(res.lines.join(''),/event: snapshot/);
  assert.equal(a.st.closed,true);assert.equal(a.st.buffer.length,0);assert.equal(res.ended,true);
});
test('credential replacement closes only other sessions of that user across both API hubs',t=>{
  const f=fixture(t),keep=f.open(f.hubs[0],f.readers[0],'keep'),old=f.open(f.hubs[1],f.readers[0],'old'),other=f.open(f.hubs[1],f.readers[1],'other');
  for(const hub of f.hubs)hub.revokeSession({userId:f.readers[0].id,allExcept:'keep'});
  assert.equal(keep.res.ended,false);assert.equal(old.res.ended,true);assert.equal(other.res.ended,false);
  f.hubs[0].revokeSession(keep.req.session);assert.equal(keep.res.ended,true);assert.equal(other.res.ended,false);
});
test('system/settings/cue/toast broadcasts pass the actor filter rather than global raw payloads',t=>{
  const f=fixture(t),reader=f.open(),admin=f.open(f.hubs[0],f.admin),hub=f.hubs[0];
  const before=reader.res.lines.length;
  hub.broadcastSettings({type:'settings',secret:'synthetic-settings-secret'});
  hub.broadcastOffice({type:'cue',secret:'synthetic-session-cue'});hub.toast('info',{secret:'synthetic-toast-secret'});
  assert.equal(reader.res.lines.length,before);
  hub.broadcastSystem();assert.doesNotMatch(reader.res.lines.join(''),/synthetic-private-system/);
  assert.match(admin.res.lines.join(''),/synthetic-settings-secret|synthetic-session-cue/);
});
test('registry synchronization notifies both hubs after commit, rejects nested transactions and cleans listeners',t=>{
  const f=fixture(t),a=f.open(f.hubs[0]),b=f.open(f.hubs[1]);let revision;
  f.store.authorizationEvents.on('change',event=>{if(event.registry)revision=f.store.rbac.state().registry_revision;});
  f.store.registry.register([{key:'flows.future',parent:'flows',labelKey:'flows.future',privileged:true}],'core');
  assert.throws(()=>f.store.withTx(()=>f.store.rbac.sync(f.store.registry)),/requires its own transaction/);
  assert.equal(a.st.closed,false);const next=f.store.rbac.sync(f.store.registry);
  assert.equal(revision,next);assert.equal(a.st.closed,true);assert.equal(b.st.closed,true);
  for(const hub of f.hubs)hub.closeAll();assert.equal(f.topics.listenerCount('change'),0);assert.equal(f.store.authorizationEvents.listenerCount('change'),1);
});
test('S56-01: real versioned-topic facades close both hubs and remove authorization observers',()=>{
  const topics=createVersionedTopics({2:{P:{}},3:{P:{}}},{policyDeclarations:TOPICS,resourceRegistry:createResourceRegistry()});
  const events=new EventEmitter(),hubs=[];
  try {
    topics.define('office',{build:()=>({})});
    for(const version of [2,3])hubs.push(createStreamHub({topics:topics.of(version),engine:{sources:()=>[]},systemState:()=>({}),contractVersion:version+'.0',modelVersion:1,authorizationEvents:events}));
    assert.equal(events.listenerCount('change'),2);
    for(const hub of hubs)assert.doesNotThrow(()=>hub.closeAll());
    assert.equal(events.listenerCount('change'),0);
    for(const hub of hubs)assert.doesNotThrow(()=>hub.closeAll());
  } finally {topics.close();}
});
test('family/session revocation closes only the linked session immediately in both hubs and purges its queues/history',t=>{
  const f=fixture(t),sid='synthetic-linked-sse',linked=f.hubs.map(h=>f.open(h,f.readers[0],sid)),others=f.hubs.map(h=>f.open(h,f.readers[0],'synthetic-independent-sse')),otherUser=f.open(f.hubs[0],f.readers[1]);
  for(const item of linked)item.res.block=true;f.change();f.change();
  for(const item of linked)assert.ok(item.st.snapshotWaiting.size);
  const issued=f.store.humanTokens.createFamily({userId:f.readers[0].id,expectedGeneration:f.readers[0].auth_generation,origin:'https://office.example.invalid',audience:'synthetic@https://api.example.invalid',linkedCookieSid:sid,linkedCookieExpiresAt:Date.now()+60000});
  f.store.humanTokens.revokeFamily(issued.familyId,'logout');
  for(const item of linked){assert.equal(item.res.ended,true);assert.equal(item.st.pending.length,0);assert.equal(item.st.buffer.length,0);assert.equal(item.st.snapshotWaiting.size,0);assert.equal(item.st.res,null);}
  for(const item of [...others,otherUser])assert.equal(item.res.ended,false);
});
