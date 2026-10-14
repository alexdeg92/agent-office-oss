'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {VM_SCHEMAS,VM_SCHEMAS_V3}=require('../../src/api/v2/vm/schemas');
const {hashPassword}=require('../../src/security/password');
const {emptyTeamSource}=require('../helpers/office-empty-team-source.cjs');
const sender={kind:'agent',id:'agent:worker-2',name:null,runtime:'synthetic-office',channel:null,avatarHint:null};
function message(h,reply=false){const at=h.clock.value;const events=[{id:'ev:0:0',kind:'user',at,senderInfo:sender,text:'private transcript body',sender:null,truncated:false}];if(reply){h.clock.value++;events.push({id:'ev:1:0',kind:'assistant',at:h.clock.value,senderInfo:null,text:'private transcript body',truncated:false,model:null,provider:null,outputTokens:null,stopReason:null,error:null});}const transcript={sessionKey:'worker-3',fetchedAt:h.clock.value,messageCount:events.length,window:{from:0,to:events.length},events};const result=h.viewEngine.ingestCanonical('transcript',transcript,{key:transcript.sessionKey});assert.equal(result.ok,true,JSON.stringify(result.issues));h.api.topics.invalidate();}
async function config(h,percent){const current=await h.get('/api/v3/office/layout');const result=await h.put('/api/v3/office/layout',{expectedRevision:current.json.data.layout.revision,data:{...current.json.data.layout.data,communicationMeetingPercent:percent}});return result;}
async function readerCookie(h){
 const owner=h.store.users.owner(),authorization={userId:owner.id,authGeneration:owner.auth_generation,requestId:'req_communication_reader',authorize:()=>{}};
 const invitation=h.store.userManagement.invite({name:'Lecteur synthétique',email:'communication-reader@example.invalid',roleId:'rol_reader'},authorization);
 h.store.userManagement.accept({token:invitation.token,purpose:'invite',passwordHash:await hashPassword('synthetic-communication-password')},authorization);
 const reader=h.store.users.byId(invitation.user.id);
 return 'taco_sess='+h.auth.signSession({email:reader.email,userId:reader.id,authGeneration:reader.auth_generation,sid:'synthetic-communication-reader',exp:Date.now()+60000});
}

test('mounted canonical v2/v3 communication stays at desks, expires, and keeps source text private',async()=>{
 const h=await officeSceneFixture({occupantCount:11,namedAgents:true,enforceAuthorization:true});
 try{
 const limitedCookie=await readerCookie(h);
 h.publish(Array(11).fill('working'));assert.equal((await config(h,0)).status,200);message(h);
 for(const version of [2,3]){
  const result=await h.get(`/api/v${version}/views/office`);assert.equal(result.status,200,result.text);
  const vm=result.json.data,pair=vm.occupants.filter(o=>o.communication);
  assert.equal(pair.length,2);assert.equal(vm.occupants.length,11);
  for(const row of pair){assert.equal(row.communication.mode,'desk');assert.equal(row.communication.surface,'monitor');assert.deepEqual(row.sceneTarget,row.homeTarget);assert.ok(row.communication.peerIds.every(id=>vm.occupants.some(o=>o.id===id)));}
  assert.equal(pair.find(o=>o.id==='agent:worker-2').communication.screen,'message-sent');assert.equal(pair.find(o=>o.id==='agent:worker-3').communication.screen,'message-received');
  assert.ok(!result.text.includes('private transcript body'));
  const denied=structuredClone(vm);denied.occupants[0].communication={...pair[0].communication,text:'leak'};
  assert.equal(require('../../src/schema').validate((version===3?VM_SCHEMAS_V3:VM_SCHEMAS).office,denied).ok,false,'closed DTO rejects raw text');
  const limited=await h.request('GET',`/api/v${version}/views/office`,undefined,{cookie:limitedCookie});assert.equal(limited.status,200,limited.text);assert.ok(limited.json.data.occupants.every(o=>o.communication===null));
  assert.equal(limited.json.data.occupants.length,11,'reader sees the same public agent population');
  assert.ok(limited.json.data.occupants.every(o=>o.sessionKey===null),'real reader lacks transcript access');
 }
 message(h,true);
 for(const version of [2,3]){const vm=(await h.get(`/api/v${version}/views/office`)).json.data;assert.equal(vm.occupants.find(o=>o.id==='agent:worker-2').communication.screen,'message-received');assert.equal(vm.occupants.find(o=>o.id==='agent:worker-3').communication.screen,'message-sent');}
 h.advance(121000,Array(11).fill('working'));
 const expired=await h.get('/api/v3/views/office');assert.ok(expired.json.data.occupants.every(o=>o.communication===null));
 assert.equal(expired.json.data.occupants.find(o=>o.id==='agent:worker-3').screenIntent.screen,'coding');
 }finally{await h.close();}
});
test('meeting policy round-trips 0–100, preserves omission, rejects invalid inputs, and uses backend table targets',async()=>{
 const h=await officeSceneFixture({occupantCount:4,namedAgents:true,enforceAuthorization:true,orchestratorTeams:emptyTeamSource});
 try{
 h.publish(Array(4).fill('working'));
 for(const bad of [-1,101,1.5,'10',null]){const result=await config(h,bad);assert.equal(result.status,400,String(bad));}
 assert.equal((await config(h,0)).status,200);message(h);
 const deskPair=(await h.get('/api/v3/views/office')).json.data.occupants.filter(o=>o.communication);assert.equal(deskPair.length,2);assert.ok(deskPair.every(o=>o.communication.mode==='desk'));
 assert.equal((await config(h,100)).status,200);
 const vm=(await h.get('/api/v3/views/office')).json.data;
 const pair=vm.occupants.filter(o=>o.communication);assert.equal(pair.length,2);assert.ok(pair.every(o=>o.communication.mode==='meeting'&&o.sceneTarget.kind==='visit'&&o.communication.surface==='bubble'));
 const limited=await h.request('GET','/api/v3/views/office',undefined,{cookie:await readerCookie(h)});assert.equal(limited.status,200,limited.text);
 assert.equal(limited.json.data.occupants.length,4,'reader sees both meeting participants');
 for(const row of limited.json.data.occupants){
  const shared=vm.occupants.find(o=>o.id===row.id);assert.equal(row.communication,null);
  assert.deepEqual([row.floorId,row.stationUid,row.sceneTarget],[shared.floorId,shared.stationUid,shared.sceneTarget],'grants redact metadata without moving visible people');
 }
 const old=await h.get('/api/v2/office/layout'),data={...old.json.data.layout.data};delete data.communicationMeetingPercent;
 const save=await h.put('/api/v2/office/layout',{expectedRevision:old.json.data.layout.revision,data});assert.equal(save.status,200,save.text);
 assert.equal((await h.get('/api/v3/office/layout')).json.data.layout.data.communicationMeetingPercent,100);
 }finally{await h.close();}
});
