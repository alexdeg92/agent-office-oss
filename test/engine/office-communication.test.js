'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {communicationPairs,projectCommunication,WINDOW_MS}=require('../../src/engine/office/communication');
const {officeDefaults,createStateTracker}=require('../../src/api/v2/vm/office');
const {projectOfficePlacement}=require('../../src/api/v2/vm/office-roster');
const defaults=officeDefaults(),now=1800000000000;
const rows=[{id:'primary',role:'primary',sessionKey:'main'},...['a','b','c','d'].map(id=>({id:'agent:'+id,role:'agent',sessionKey:'session:'+id}))].map((o,i)=>({...o,name:o.id,state:'working',stateSince:now,parentId:null,teamId:null,rosterOrder:i}));
const sender=id=>({kind:'agent',id:'agent:'+id,name:null,runtime:'synthetic',channel:null,avatarHint:null});
const event=(at=now,senderInfo=sender('a'))=>({id:'ev:0:0',kind:'user',at,senderInfo,text:'NEVER expose this secret-ish transcript payload',truncated:false});
function engine(events=[event()],key='session:b') {return {agents:()=>['root','a','b','c','d'].map(id=>({id})),primaryAgent:()=>({id:'root'}),session:key=>({class:{agentId:key==='main'?'root':key.split(':')[1]}}),transcript:sessionKey=>sessionKey===key?{sessionKey:key,events}:null};}
function build(e=engine(),options={}){const layout={...defaults.layout,...options};return projectOfficePlacement({occupants:rows}, {layout,index:defaults.index,now,tracker:createStateTracker(),engine:e,canReadSessions:true});}

test('canonical exact-session incoming agent and reply produce paired text-free sender/receiver indicators',()=>{
 const e=engine();let vm=build(e,{communicationMeetingPercent:0});
 const a=vm.occupants.find(o=>o.id==='agent:a'),b=vm.occupants.find(o=>o.id==='agent:b');
 assert.equal(a.communication.screen,'message-sent');assert.equal(b.communication.screen,'message-received');
 assert.deepEqual(a.communication.peerIds,[b.id]);assert.deepEqual(b.communication.peerIds,[a.id]);
 assert.equal(a.communication.id,b.communication.id);assert.equal(a.communication.expiresAt,now+WINDOW_MS);
 assert.deepEqual(a.sceneTarget,a.homeTarget);assert.deepEqual(b.sceneTarget,b.homeTarget);
 assert.equal(a.screenIntent.surface,'monitor');assert.equal(b.screenIntent.surface,'monitor');
 assert.ok(!JSON.stringify(vm).includes('NEVER expose'));
 const reply={...event(now+1,sender('b')),id:'ev:1:1',kind:'assistant'};
 const pairs=communicationPairs(rows,engine([event(now-1),reply]),now+1);
 assert.equal(pairs[0].senderId,'agent:b');assert.equal(pairs[0].receiverId,'agent:a');
});
test('no guesses from message text, team/parent relationship, generic assistant or other session',()=>{
 for(const info of [null,{...sender('a'),id:'agent:agent'},{...sender('a'),kind:'human'}])assert.deepEqual(communicationPairs(rows,engine([event(now,info)]),now),[]);
 assert.deepEqual(communicationPairs(rows,{...engine(),transcript:()=>({sessionKey:'another-session',events:[event()]})},now),[]);
 const delegated={...sender('a'),delegation:{sessionKey:'session:missing',label:null}};
 assert.deepEqual(communicationPairs(rows,engine([event(now,delegated)]),now),[],'an absent exact delegation never folds into its lead');
 assert.equal(communicationPairs(rows,engine([event(now,{...sender('irrelevant'),delegation:{sessionKey:'session:a',label:null}})]),now)[0].senderId,'agent:a');
 const ambiguous=[...rows,{...rows[1],id:'agent:duplicate'}];assert.deepEqual(communicationPairs(ambiguous,engine([event(now,{...sender('irrelevant'),delegation:{sessionKey:'session:a',label:null}})]),now),[]);
});
test('expired/future evidence clears, transcript unavailable fails closed, and denied readers never read it',()=>{
 for(const at of [now-WINDOW_MS-1,now+1])assert.deepEqual(communicationPairs(rows,engine([event(at)]),now),[]);
 const vm=projectCommunication(build(),{engine:{...engine(),transcript:()=>{throw Error('private read');}},index:defaults.index,layout:defaults.layout,now,canReadSessions:false});
 assert.ok(vm.occupants.every(o=>o.communication===null));
 assert.equal(vm.occupants.find(o=>o.id==='agent:a').screenIntent.screen,'coding');
});
test('physical meetings are deterministic, use only authored reachable seats and keep home stations reserved',()=>{
 const first=build(engine(),{communicationMeetingPercent:100}),second=build(engine(),{communicationMeetingPercent:100});
 const pair=first.occupants.filter(o=>o.communication);assert.equal(pair.length,2);
 assert.ok(pair.every(o=>o.communication.mode==='meeting'&&o.communication.surface==='bubble'&&o.sceneTarget.kind==='visit'));
 assert.ok(pair.every(o=>o.stationUid===o.homeTarget.stationUid));
 assert.equal(pair[0].sceneTarget.stationUid,pair[1].sceneTarget.stationUid);assert.notDeepEqual(pair[0].sceneTarget.point,pair[1].sceneTarget.point);
 assert.deepEqual(first.occupants.map(o=>o.sceneTarget),second.occupants.map(o=>o.sceneTarget));
 const noTable={...defaults.layout,items:defaults.layout.items.filter(i=>defaults.index.furniture.get(i.asset)?.station?.kind!=='meeting'),communicationMeetingPercent:100};
 const no=build(engine(),noTable);assert.ok(no.occupants.filter(o=>o.communication).every(o=>o.communication.mode==='desk'&&o.sceneTarget.mode==='desk'));
});
test('default sampling stays around ten percent and agrees across wire aliases',()=>{
 let physical=0;
 for(let i=0;i<400;i++){
  const alternate=rows.map(o=>o.id==='agent:b'?{...o,sessionKey:'pair:'+i}:o);
  const pairs=communicationPairs(alternate,engine([event()],'pair:'+i),now);
  if(parseInt(pairs[0].id.slice(-8),16)%100<10)physical++;
 }
 assert.ok(physical>=25&&physical<=55,String(physical));
 const v3=communicationPairs(rows,engine([event(now,{...sender('root'),delegation:{sessionKey:'main',label:null}})]),now);
 const v2=communicationPairs(rows.map(o=>o.id==='primary'?{...o,id:'main',role:'main'}:o),engine([event(now,{...sender('root'),delegation:{sessionKey:'main',label:null}})]),now);
 assert.equal(v2[0].id,v3[0].id);
});
test('each participant has one current conversation and one table never hosts multiple pairs',()=>{
 const e=engine();e.transcript=key=>['session:b','session:d'].includes(key)?{sessionKey:key,events:[event(now,sender(key==='session:b'?'a':'c'))]}:null;
 const vm=build(e,{communicationMeetingPercent:100});assert.equal(vm.occupants.filter(o=>o.communication?.mode==='meeting').length,2);
 assert.equal(vm.occupants.filter(o=>o.communication?.mode==='desk').length,2);
});

test('canonical session ownership resolves registered occupant IDs without agent-id-shaped UI identities',()=>{
 const registered=rows.map(row=>row.id==='agent:a'?{...row,id:'member:registered-a'}:row);
 const pair=communicationPairs(registered,engine(),now)[0];
 assert.equal(pair.senderId,'member:registered-a');assert.equal(pair.receiverId,'agent:b');
 assert.deepEqual(communicationPairs([...registered,{...registered[1],id:'member:other-a',sessionKey:'another:a'}],engine(),now),[],'multiple exact sessions for one agent require explicit delegation');
 const e=engine();e.session=()=>({class:{agentId:'absent-agent'}});
 assert.deepEqual(communicationPairs(rows,e,now),[],'unregistered canonical ownership fails closed');
});
test('fresh exchanges preserve alarms, ongoing travel and activity destinations',()=>{
 const base=build(engine(),{communicationMeetingPercent:0});
 for(const state of ['blocked','error']){
  const office={...base,occupants:base.occupants.map(row=>row.id==='agent:a'?{...row,state}:row)};
  const vm=projectCommunication(office,{engine:engine(),index:defaults.index,layout:{...defaults.layout,communicationMeetingPercent:100},now,canReadSessions:true});
  assert.ok(vm.occupants.every(row=>row.communication===null));
  const alarm=vm.occupants.find(row=>row.id==='agent:a');assert.equal(alarm.screenIntent.screen,'blocked');
  assert.deepEqual(alarm.sceneTarget,office.occupants.find(row=>row.id===alarm.id).sceneTarget);
 }
 for(const intent of [{activity:{id:'activity:a',kind:'coffee'}},{sceneTravel:{id:'journey:a'}},{sceneTarget:{...base.occupants.find(row=>row.id==='agent:a').sceneTarget,mode:'sofa'}}]){
  const office={...base,occupants:base.occupants.map(row=>row.id==='agent:a'?{...row,...intent}:row)};
  const vm=projectCommunication(office,{engine:engine(),index:defaults.index,layout:{...defaults.layout,communicationMeetingPercent:100},now,canReadSessions:true});
  const actor=vm.occupants.find(row=>row.id==='agent:a');assert.equal(actor.communication.mode,'desk');
  assert.deepEqual(actor.sceneTarget,office.occupants.find(row=>row.id===actor.id).sceneTarget);
  assert.deepEqual(actor.sceneTravel,office.occupants.find(row=>row.id===actor.id).sceneTravel);
 }
});
