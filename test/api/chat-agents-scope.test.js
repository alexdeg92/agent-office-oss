'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../../src/store');
const {createEngine}=require('../../src/engine');
const {feed}=require('../helpers/feed');
const {loadScenario}=require('../helpers/scenario');
const {createTopics}=require('../../src/api/v2/topics');
const {mountChat}=require('../../src/api/v3/chat');

function fixture(t,{rbacEnabled=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-scope-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',log:()=>{}}),diagnostics=[];
  const topics=createTopics({},{onError:event=>diagnostics.push(event)});
  const runtime={adapterId:'synthetic',connected:true,capabilities:{chat:true,chatSessionScope:'principal'},commands:{agentTurn:async()=>({text:'Synthetic reply'})}};
  const engine=feed(createEngine(),loadScenario('synthetic-basic'));engine.runtime=()=>runtime;engine.runtimeFor=()=>runtime;
  const r=require("express").Router();
  const backend=mountChat({r,engine,store,topics,runtime,dataDir:dir,rbacEnabled,authed:()=>{},guard:()=>()=>{},ok:()=>{}});
  t.after(()=>{backend.close();topics.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const session={email:'owner@example.invalid',exp:Date.now()+60000};
  const build=()=>topics.current('chat-agents-scope?scope='+encodeURIComponent(backend.topicScope(session,'agents')));
  return {store,backend,topics,diagnostics,session,build};
}

test('empty-users env owner builds chat agents and retains authority through scoped rebuilds',t=>{
  const f=fixture(t);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  // Mirrors the topic builder after an authenticated env-only request (no userId).
  f.backend.scopeOf({session:f.session});
  const first=f.build();assert.ok(first.vm.agents.length);assert.equal(first.vm.agents[0].capabilities.startSession,true);
  f.topics.invalidate('chat-agents-scope');assert.deepEqual(f.build().vm,first.vm);
  assert.equal(f.backend.authorizeTopic({name:'chat-agents',params:{}},{session:f.session,apiVersion:3}),true);
  assert.deepEqual(f.diagnostics,[]);
});

test('env-owner topic can be the first chat access, without a preceding HTTP index request',t=>{
  const f=fixture(t);assert.ok(f.build().vm.agents.length);
});

test('legacy chat authority rejects missing sessions and machine principals',t=>{
  const f=fixture(t);
  for(const req of [{},{principal:{kind:'agent',id:'synthetic-machine'}},{session:f.session,principal:{kind:'agent',id:'synthetic-machine'}}]){
    assert.throws(()=>f.backend.targetRowsFor(req),{message:'forbidden'});
  }
  assert.equal(f.backend.authorizeTopic({name:'chat-agents',params:{}},{apiVersion:3}),false);
  const token=f.backend.topicScope(null,'agents');
  assert.throws(()=>f.topics.current('chat-agents-scope?scope='+encodeURIComponent(token)),{message:'forbidden'});
});

test('activating identity or explicitly enabling RBAC disables the env-owner fallback',t=>{
  const f=fixture(t);f.backend.scopeOf({session:f.session});f.build();
  f.store.users.ensureEnv({email:'owner@example.invalid',personId:f.store.owner.id,fingerprint:'a'.repeat(64)});
  f.topics.invalidate('chat-agents-scope');assert.throws(f.build,{message:'forbidden'});
  const enabled=fixture(t,{rbacEnabled:true});enabled.backend.scopeOf({session:enabled.session});assert.throws(enabled.build,{message:'forbidden'});
});

test('real env-only server serves Chat agents over HTTP and SSE without topic build failures',async t=>{
  const {startServer}=require('../helpers/harness'),{openSse}=require('../helpers/sse-client');
  const h=await startServer(loadScenario('synthetic-basic'));t.after(()=>h.stop());
  const index=await h.get('/api/v3/chat/agents');assert.equal(index.status,200,index.text);assert.ok(index.json.data.agents.length);
  const stream=openSse(h.base,'/api/v3/stream?topics=chat-agents',{cookie:h.cookie});t.after(()=>stream.close());
  const frame=await stream.next(item=>item.event==='snapshot'&&item.data.topic==='chat-agents');
  assert.deepEqual(frame.data.data.agents,index.json.data.agents);
  const sessions=await h.get('/api/v3/chat/agents/'+index.json.data.agents[0].id+'/sessions');assert.equal(sessions.status,200,sessions.text);
  assert.equal(sessions.json.data.sessions.length,0);
  assert.equal(h.output.includes('"topic":"chat-agents-scope"'),false);

});
