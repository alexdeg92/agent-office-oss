'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {openStore}=require('../../src/store'),{createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed'),{loadScenario}=require('../helpers/scenario');
const {createAuth}=require('../../src/auth'),{hashPassword}=require('../../src/security/password');
const {mountV2}=require('../../src/api/v2/routes'),{requestId}=require('../../src/api/v2/errors');
const {createRouteGuard}=require('../../src/security/route-policy'),{ROUTES}=require('../../src/security/route-declarations');
const {waitFor}=require('../helpers/harness');
let hash;before(async()=>{hash=await hashPassword('synthetic-project-password');});
const {EventEmitter}=require('node:events');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-project-authority-')),clock={value:Date.now()};
  let store=openStore({dir,instance:'test',ownerName:'Historical admin',log:()=>{}}),api,server,auth;
  const admin=store.users.createOwner({email:'admin@example.invalid',personId:store.owner.id,passwordHash:hash});
  const ctx={userId:admin.id,authGeneration:0,requestId:'req_project',authorize:()=>{}};
  const link=store.userManagement.invite({email:'editor@example.invalid',name:'Actual author',roleId:'rol_editor'},ctx);
  store.userManagement.accept({token:link.token,purpose:'invite',passwordHash:hash},{requestId:'req_accept'});
  const user=store.users.byId(link.user.id),engine=feed(createEngine(),loadScenario('synthetic-basic')),reads=[],turns=[],logs=[];
  for(const a of engine.agents())store.persons.ensureAgent(a.id,a.name);
  const original=engine.transcript;
  engine.transcript=key=>key.includes(':ao-projet-')?{messageCount:0,events:[]}:original(key);
  engine.request=async(op,key)=>{reads.push(key);return {ok:true};};
  const runtime={definition:{id:'synthetic'},commands:{agentTurn:async args=>{turns.push(args);return {text:'Project reply'};}}};
  const cfg={instance:'test',dataDir:dir,capture:false,projectsDiscovery:false,timeZone:'UTC'};
  async function open() {
    auth=createAuth({secret:'synthetic-project-secret',revocations:store.sessions,identity:{users:store.users,state:store.rbac.state},allowMultiUser:true});
    const app=express();app.use(requestId,express.json());
    api=mountV2(app,{auth,store,engine,runtime,cfg,enforceAuthorization:true,now:()=>clock.value,log:message=>logs.push(message)});
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  }
  await open();
  const cookie=row=>'taco_sess='+auth.signSession({userId:row.id,authGeneration:row.auth_generation,sid:'project-'+row.id,exp:clock.value+60000});
  const request=async(method,route,body,row=store.users.byId(user.id))=>{
    const res=await fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:{cookie:cookie(row),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json()};
  };
  const p=api.projects.service.commands.create({name:'Authority project',summary:'PRIVATE_DERIVED_SUMMARY',actor:{kind:'human',personId:user.person_id},sources:[{kind:'sessionGroup',ref:{by:'keys',sessionKeys:[engine.sessions()[0].key]}}]}).vm;
  const set=(resource,level)=>store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET level=excluded.level').run(user.id,resource,level);
  set('settings.runtimes','read');
  const guarded=(path,body={},method='POST')=>{
    const req={headers:{cookie:cookie(store.users.byId(user.id))},body,requestId:'req_summary',apiVersion:3};let error;
    createRouteGuard(ROUTES.get(method+' '+path),{auth,store})(req,{},e=>error=e);if(error)throw error;return req;
  };
  async function stop() {api.close();await api.thread.idle();server.closeAllConnections();await new Promise(r=>server.close(r));}
  t.after(async()=>{await stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {p,user,admin,ctx,engine,runtime,reads,turns,logs,clock,set,request,guarded,cookie,
    serverPort:()=>server.address().port, get store(){return store;},get api(){return api;},
    async restart(){await stop();store.close();store=openStore({dir,instance:'test',ownerName:'Historical admin',log:()=>{}});await open();}};
}
const post=(f,body='@main Please review')=>f.request('POST','/api/v3/projects/'+f.p.id+'/comments',{body});
const delivery=(f,id)=>f.store.comments.get(id).delivery[0];
test('lower-read users can save ordinary comments, but mentions never enter a privileged retained session',async t=>{
  const f=await fixture(t);
  const high=await post(f);assert.equal(high.status,201);await f.api.thread.idle();assert.equal(f.turns.length,1);
  for(const resource of ['logs','flows','settings.runtimes']) {
    f.set(resource,'none');const accepted=await post(f);assert.equal(accepted.status,201);
    const row=f.store.comments.get(accepted.json.data.result.comment.id);
    assert.equal(row.author.id,f.user.person_id);assert.equal(row.delivery[0].status,'unavailable');assert.equal(row.delivery[0].reason,'permission-denied');
    assert.equal(row.delivery[0].follow,undefined);await f.api.thread.idle();assert.equal(f.turns.length,1);
    const ordinary=await post(f,'A manual project update');assert.equal(ordinary.status,201);assert.deepEqual(ordinary.json.data.result.comment.delivery,[]);
    assert.equal((await f.request('POST','/api/v3/projects/'+f.p.id+'/summary/regenerate',{expectedRevision:f.api.projects.repository.getProject(f.p.id).revision})).status,403);
    f.set(resource,'read');
  }
  const id=high.json.data.result.comment.id,binding=delivery(f,id).follow.authority;
  assert.deepEqual(Object.keys(binding).sort(),['command','expiresAt','generation','legacy','personId','sessionId','userId']);
  const response=await f.request('GET','/api/v3/views/projects/'+f.p.id+'/comments');assert.doesNotMatch(JSON.stringify(response.json),/"(?:sessionId|expiresAt|generation|authority|provenance)"\s*:/);
});
test('queued project deliveries deny current permission, generation, logout and expiry changes without automatic redispatch',async t=>{
  for(const change of ['permission','generation','logout','expiry','logs','flows','settings.runtimes']) {
    const f=await fixture(t),hold=deferred();f.api.thread.runProjectTurn(f.p.id,()=>hold.promise);
    const accepted=await post(f);assert.equal(accepted.status,201);const id=accepted.json.data.result.comment.id;
    if(change==='permission')f.set('projects.comment','none');
    if(['logs','flows','settings.runtimes'].includes(change))f.set(change,'none');
    if(change==='generation')f.store.db.prepare('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?').run(f.user.id);
    if(change==='logout')f.store.sessions.revoke(delivery(f,id).follow.authority.sessionId,Date.now()+60000);
    if(change==='expiry')f.clock.value+=60001;
    hold.resolve();await f.api.thread.idle();
    assert.equal(delivery(f,id).status,'failed');assert.equal(delivery(f,id).reason,'permission-denied');assert.equal(delivery(f,id).follow.phase,'settled');assert.deepEqual(f.turns,[]);assert.deepEqual(f.reads,[]);
  }
});
test('revocation during linked context stops the next read and agent turn',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();
  f.set('settings.runtimes','read');
  f.engine.request=async(op,key)=>{f.reads.push(key);start.resolve();await finish.promise;return {ok:true};};
  const accepted=await post(f);assert.equal(accepted.status,201);const id=accepted.json.data.result.comment.id;await start.promise;
  f.set('logs','none');finish.resolve();await f.api.thread.idle();
  assert.equal(delivery(f,id).status,'failed');assert.equal(f.reads.length,1);assert.deepEqual(f.turns,[]);
});
test('valid metadata survives real store reopen; revoked or unbound queued records do not dispatch',async t=>{
  for(const kind of ['valid','revoked','unbound']) {
    const f=await fixture(t);f.api.thread.close();const accepted=await post(f);assert.equal(accepted.status,201);const id=accepted.json.data.result.comment.id;
    if(kind==='revoked')f.set('projects.comment','none');
    if(kind==='unbound'){const c=f.store.comments.get(id);delete c.delivery[0].follow.authority;f.store.comments.setDelivery(id,c.delivery);}
    await f.restart();await f.api.thread.idle();
    assert.equal(delivery(f,id).status,kind==='valid'?'replied':'failed');assert.equal(f.turns.length,kind==='valid'?1:0);
  }
});
test('a denied queued summary releases its durable lock; an explicit fresh authorized retry acquires a new bound command',async t=>{
  const f=await fixture(t),hold=deferred();f.api.thread.runProjectTurn(f.p.id,()=>hold.promise);
  const accepted=await f.request('POST','/api/v3/projects/'+f.p.id+'/summary/regenerate',{expectedRevision:f.p.revision});assert.equal(accepted.status,202,JSON.stringify(accepted));
  const c=f.store.comments.active().find(c=>c.kind==='event');assert.ok(c);f.set('projects.regenerate','none');hold.resolve();await f.api.thread.idle();
  assert.equal(delivery(f,c.id).status,'failed');assert.equal(f.api.projects.repository.getSummaryTurn(f.p.id),null);assert.deepEqual(f.turns,[]);
  const denied=await f.request('POST','/api/v3/projects/'+f.p.id+'/comments/'+c.id+'/retry',{agentId:'main'});assert.equal(denied.status,403,'comment write cannot retry a privileged summary');
  f.set('projects.regenerate','write');f.set('settings.runtimes','none');
  assert.equal((await f.request('POST','/api/v3/projects/'+f.p.id+'/comments/'+c.id+'/retry',{agentId:'main'})).status,403);
  f.set('settings.runtimes','read');const retried=await f.request('POST','/api/v3/projects/'+f.p.id+'/comments/'+c.id+'/retry',{agentId:'main'});assert.equal(retried.status,202,JSON.stringify(retried));
  await f.api.thread.idle();assert.equal(delivery(f,c.id).status,'replied',JSON.stringify(f.logs));assert.equal(delivery(f,c.id).follow.authority.command,'projects.retryComment');assert.notEqual(delivery(f,c.id).follow.summary.turnId,accepted.json.data.result.turnId);
});
test('an accepted project agent turn may finish and track its reply after the author loses access',async t=>{
  const f=await fixture(t),start=deferred(),finish=deferred();f.runtime.commands.agentTurn=async args=>{f.turns.push(args);start.resolve();await finish.promise;return {text:'Accepted project result'};};
  const accepted=await post(f);assert.equal(accepted.status,201);const id=accepted.json.data.result.comment.id;await start.promise;
  f.set('projects.comment','none');finish.resolve();await f.api.thread.idle();assert.equal(delivery(f,id).status,'replied');assert.equal(f.turns.length,1);
  assert.ok(f.store.comments.page(f.p.id).some(c=>c.replyTo===id&&c.body==='Accepted project result'));
});

function stream(f,version=3,topic='comments:'+f.p.id) {
  const req=Object.assign(new EventEmitter(),{headers:{cookie:f.cookie(f.store.users.byId(f.user.id))},query:{topics:topic}});
  const res=new EventEmitter();res.lines=[];res.writeHead=()=>{};res.write=line=>{res.lines.push(String(line));return true;};res.end=res.destroy=()=>{};
  f.api.hubs[version].open(req,res);return {req,res};
}
test('generated immediate summary is hidden in real HTTP and SSE for every missing source read, including after reopen',async t=>{
  const f=await fixture(t),marker='SYNTHETIC_PRIVATE_GENERATED_CONTEXT';
  f.runtime.commands.agentTurn=async args=>{f.turns.push(args);return {text:marker};};
  const accepted=await f.request('POST','/api/v3/projects/'+f.p.id+'/summary/regenerate',{expectedRevision:f.p.revision});assert.equal(accepted.status,202,JSON.stringify(accepted));
  await f.api.thread.idle();assert.ok(f.store.comments.page(f.p.id).some(c=>c.body===marker));
  for(const reopening of [false,true]) {
    if(reopening)await f.restart();
    for(const version of [2,3])for(const resource of ['logs','flows','settings.runtimes']) {
      const high=await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id+'/comments');assert.match(JSON.stringify(high.json),new RegExp(marker));
      const highStream=stream(f,version);assert.match(highStream.res.lines.join(''),new RegExp(marker));highStream.req.emit('close');
      f.set(resource,'none');
      const low=await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id+'/comments');assert.equal(low.status,200);assert.doesNotMatch(JSON.stringify(low.json),new RegExp(marker));assert.equal(low.json.data.canMention,false);
      const lowStream=stream(f,version);assert.doesNotMatch(lowStream.res.lines.join(''),new RegExp(marker));lowStream.req.emit('close');
      const project=await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id);assert.equal(project.json.data.summary,null);
      f.set(resource,'read');
    }
  }
});
test('unknown persisted generated provenance is excluded from future prompts; accepted completion stays private after downgrade',async t=>{
  const f=await fixture(t),marker='SYNTHETIC_UNKNOWN_SOURCE',start=deferred(),finish=deferred();
  f.store.comments.create({projectId:f.p.id,author:{kind:'agent',id:'main',name:'Main'},body:marker,provenance:[{resource:'adapter.absent.secret',level:'read'}]});
  f.runtime.commands.agentTurn=async args=>{f.turns.push(args);start.resolve();await finish.promise;return {text:'SYNTHETIC_ACCEPTED_PRIVATE_REPLY'};};
  const accepted=await post(f);assert.equal(accepted.status,201);await start.promise;assert.doesNotMatch(f.turns[0].text,new RegExp(marker));
  f.set('logs','none');finish.resolve();await f.api.thread.idle();
  assert.equal(delivery(f,accepted.json.data.result.comment.id).status,'replied');
  assert.doesNotMatch(JSON.stringify((await f.request('GET','/api/v3/views/projects/'+f.p.id+'/comments')).json),/SYNTHETIC_.*(?:SOURCE|REPLY)/);
  await f.restart();assert.doesNotMatch(JSON.stringify((await f.request('GET','/api/v3/views/projects/'+f.p.id+'/comments')).json),/SYNTHETIC_.*(?:SOURCE|REPLY)/);
  const lowStream=stream(f);assert.doesNotMatch(lowStream.res.lines.join(''),/SYNTHETIC_.*(?:SOURCE|REPLY)/);lowStream.req.emit('close');
});

test('tracked parent and child fallback outputs receive private provenance before publication',async t=>{
  const {normaliseTranscript}=require('../../src/adapters/openclaw/normalise/transcript');
  const fixtureData=require('../projects/fixtures/comments/deferred.json');
  for(const mode of ['parent','child']) {
    const f=await fixture(t),marker='SYNTHETIC_PRIVATE_'+mode.toUpperCase(),child='agent:main:subagent:child-1',transcripts=new Map();
    const original=f.engine.transcript;f.engine.transcript=key=>transcripts.get(key)||original(key);
    const messages=name=>structuredClone(fixtureData[name]).map(m=>({...m,timestamp:f.clock.value+m.timestamp}));
    f.runtime.commands.agentTurn=async args=>{
      f.turns.push(args);
      const parent=mode==='parent'?[{role:'assistant',timestamp:f.clock.value+10,stopReason:'stop',content:marker}]:messages('initial');
      transcripts.set(args.sessionRef,normaliseTranscript(args.sessionRef,{messages:parent},f.clock.value,Infinity));
      if(mode==='child')transcripts.set(child,normaliseTranscript(child,{messages:[{role:'assistant',timestamp:f.clock.value+10,stopReason:'stop',content:marker}]},f.clock.value,Infinity));
      f.clock.value+=31000;return {text:''};
    };
    const accepted=await post(f);assert.equal(accepted.status,201);
    if(mode==='child') {
      await waitFor(()=>Object.values(delivery(f,accepted.json.data.result.comment.id).follow.children).some(c=>c.done),{what:'tracked child completion'});
      f.clock.value+=31000;
    }
    await waitFor(()=>f.store.comments.page(f.p.id).some(c=>c.body===marker),{what:'protected '+mode+' result'});
    f.api.thread.close();await f.api.thread.idle();
    const row=f.store.comments.page(f.p.id).find(c=>c.body===marker);assert.deepEqual(f.store.comments.provenance(row.id),require('../../src/security/comment-provenance').PROJECT_CONTEXT_READS);
    assert.ok(f.reads.some(k=>k.includes(':ao-projet-')));if(mode==='child')assert.ok(f.reads.includes(child));
    for(const version of [2,3]) {
      assert.match(JSON.stringify((await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id+'/comments')).json),new RegExp(marker));
      f.set('logs','none');assert.doesNotMatch(JSON.stringify((await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id+'/comments')).json),new RegExp(marker));
      const low=stream(f,version);assert.doesNotMatch(low.res.lines.join(''),new RegExp(marker));low.req.emit('close');f.set('logs','read');
    }
  }
});

test('guarded generated cover media and VMs obey current source reads; explicit uploads stay project content',async t=>{
  const f=await fixture(t),{generateCode}=require('../../src/projects/covers/code'),{fingerprint}=require('../../src/projects/covers/classify');
  const coverStore=f.api.projects.covers.store;
  const result=generateCode({...f.api.projects.repository.getProject(f.p.id),name:'SYNTHETIC_PRIVATE_COVER'});
  coverStore.save(f.p.id,result,{source:'agent',fingerprint:fingerprint(f.api.projects.repository.getProject(f.p.id)),generatedAt:Date.now()});
  const media=await f.request('GET','/api/v3/views/projects/'+f.p.id),urls=[media.json.data.cover.url,media.json.data.cover.thumbUrl];
  async function image(url,method='GET',etag=null) {
    const res=await fetch('http://127.0.0.1:'+f.serverPort()+url,{method,headers:{cookie:f.cookie(f.store.users.byId(f.user.id)),...(etag?{'if-none-match':etag}:{})}});
    return {status:res.status,text:await res.text(),headers:res.headers};
  }
  for(const version of [2,3])for(const resource of ['logs','flows','settings.runtimes']) {
    for(const url of urls) {
      const high=await image(url);assert.equal(high.status,200);assert.equal(high.headers.get('cache-control'),'private, no-store');assert.match(high.text,/SYNTHETIC_PRIVATE_COVER/);
      f.set(resource,'none');
      for(const method of ['GET','HEAD'])assert.equal((await image(url,method,high.headers.get('etag'))).status,403,'conditional/media paths cannot bypass current reads');
      f.set(resource,'read');
    }
    f.set(resource,'none');
    const low=await f.request('GET','/api/v'+version+'/views/projects/'+f.p.id);assert.equal(low.json.data.cover,null);assert.equal(low.json.data.thumb.url,null);
    const board=await f.request('GET','/api/v'+version+'/views/projects');assert.equal(board.json.data.columns.flatMap(c=>c.cards).find(c=>c.id===f.p.id).cover,null);
    const lowStream=stream(f,version,'project:'+f.p.id);assert.doesNotMatch(lowStream.res.lines.join(''),/project-covers\//);lowStream.req.emit('close');
    assert.equal((await f.request('POST','/api/v'+version+'/projects/'+f.p.id+'/cover/regenerate',{expectedRevision:f.p.revision})).status,403);
    f.set(resource,'read');
  }
  const orphan=coverStore.save('prj_orphan',generateCode({...f.p,name:'SYNTHETIC_ORPHAN'}),{source:'code',fingerprint:fingerprint(f.p),generatedAt:Date.now()});
  fs.rmSync(path.join(coverStore.dir,'records','prj_orphan.json'));f.set('logs','none');assert.equal((await image('/api/v2/project-covers/'+orphan.file)).status,403);
  await f.restart();assert.equal((await image(urls[0])).status,403);
  if(require('../../src/projects/covers/raster').createRasterizer()) {
    const uploaded=await f.request('PUT','/api/v3/projects/'+f.p.id+'/cover',{expectedRevision:f.api.projects.repository.getProject(f.p.id).revision,image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEVbW/bKAi89AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg=='});
    assert.equal(uploaded.status,200,JSON.stringify(uploaded));assert.equal(uploaded.json.data.vm.cover.source,'upload');
    assert.equal((await image(uploaded.json.data.vm.cover.url)).status,200,'intentional upload can be read without source grants');
  }
});
test('real guarded code-cover jobs recheck queued, capability, generation and upload boundaries without fallback on denial',async t=>{
  const {createCoverEngine}=require('../../src/projects/covers/engine'),{generateCode}=require('../../src/projects/covers/code');
  for(const boundary of ['queued','capability','publication','upload']) {
    const f=await fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-cover-authority-')),start=deferred(),finish=deferred(),calls=[],logs=[];
    const p=f.api.projects.repository.getProject(f.p.id);
    const req=f.guarded(boundary==='upload'?'/projects/:id/cover':'/projects/:id/cover/regenerate',{},boundary==='upload'?'PUT':'POST');
    const opts={dataDir:root,getProject:()=>p,debounceMs:0,timeoutMs:2000,log:s=>logs.push(s)};
    if(boundary==='upload')opts.rasterize=async()=>{calls.push('raster');start.resolve();await finish.promise;return generateCode(p);};
    else opts.generators=[{id:'code',supports:async()=>{calls.push('supports');if(boundary==='capability'){start.resolve();await finish.promise;}return true;},generate:async()=>{calls.push('generate');if(boundary==='publication'){start.resolve();await finish.promise;}return generateCode(p);}}];
    const engine=createCoverEngine(opts);t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true});});
    const scope={write:req.authorize,generate:req.authorize};
    const pending=engine.withAuthority(scope,()=>boundary==='upload'?engine.upload(p.id,Buffer.from('synthetic-raster')):engine.regenerate(p.id));
    let refused;if(boundary==='upload')refused=assert.rejects(pending,{code:'forbidden'});
    if(boundary!=='queued')await start.promise;
    f.set(boundary==='upload'?'projects':'logs','none');finish.resolve();
    if(refused)await refused;await waitFor(()=>engine.pending===0,{what:'cover authorization refusal'});
    assert.equal(engine.vm(p.id),null);assert.equal(logs.some(s=>s.includes('code fallback')),false);assert.equal(engine.pending,0);
    if(boundary==='queued')assert.deepEqual(calls,[]);if(boundary==='capability')assert.deepEqual(calls,['supports']);if(boundary==='publication')assert.deepEqual(calls,['supports','generate']);
    assert.deepEqual(fs.readdirSync(path.join(root,'project-covers','media')),[],'no file publication or unbound fallback');
    f.set(boundary==='upload'?'projects':'logs',boundary==='upload'?'write':'read');
    const allowed=engine.withAuthority(scope,()=>boundary==='upload'?engine.upload(p.id,Buffer.from('synthetic-raster')):engine.regenerate(p.id));
    if(boundary==='upload')await allowed;await waitFor(()=>engine.pending===0);assert.equal(engine.vm(p.id).source,boundary==='upload'?'upload':'code','restored live authority retains the full positive path');
  }
});

test('raster child retains the real guard across awaits',async t=>{
  const f=await fixture(t),req=f.guarded('/projects/:id/cover/regenerate'),{runAuthorized}=require('../../src/security/dispatch-context');
  const {createRasterizer}=require('../../src/projects/covers/raster');let finishRaster,children=0;const rasterStart=deferred();
  const webp=Buffer.alloc(20);webp.write('RIFF',0);webp.write('WEBP',8);
  const raster=createRasterizer({bin:'synthetic-converter',exec:(bin,args,options,callback)=>{children++;finishRaster=()=>callback(null,webp);rasterStart.resolve();return {stdin:{on(){},end(){}}};}});
  const rasterPending=runAuthorized(req.authorize,()=>raster(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0])));const denied=assert.rejects(rasterPending,{code:'forbidden'});
  await rasterStart.promise;f.set('logs','none');finishRaster();await denied;assert.equal(children,1,'no thumbnail process after first conversion lost authority');
});
test('automatic covers from real project mutations keep human authority; guarded background jobs render locally',async t=>{
  const f=await fixture(t);f.set('logs','none');
  const low=await f.request('POST','/api/v3/projects',{name:'Manual low-read project',summary:'Manual content'});assert.equal(low.status,200,JSON.stringify(low));
  await waitFor(()=>f.api.projects.covers.pending===0);assert.equal(f.api.projects.covers.vm(low.json.data.vm.id),null,'plain mutation does not grant automatic generation authority');
  f.set('logs','read');const changed=await f.request('PATCH','/api/v3/projects/'+low.json.data.vm.id,{expectedRevision:low.json.data.vm.revision,summary:'Manual authorized change'});assert.equal(changed.status,200);
  await waitFor(()=>f.api.projects.covers.pending===0);assert.equal(f.api.projects.covers.vm(low.json.data.vm.id).source,'code','current authorized mutation generates normally');
  const {createCoverEngine}=require('../../src/projects/covers/engine'),root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-cover-background-')),a={...f.p,id:'prj_a'},b={...f.p,id:'prj_b'},calls=[];
  const req=f.guarded('/projects/:id/cover/regenerate');
  const engine=createCoverEngine({dataDir:root,getProject:id=>id===a.id?a:b,debounceMs:5,rasterize:async()=>null});
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true});});
  engine.withAuthority({write:req.authorize,generate:req.authorize},()=>engine.observe(a));engine.observe(b);f.set('logs','none');
  await waitFor(()=>engine.pending===0);assert.equal(engine.vm(a.id),null);assert.equal(engine.vm(b.id).source,'code');assert.deepEqual(calls,[],'background timer never inherits another human scope or starts an unbound agent turn');
});
