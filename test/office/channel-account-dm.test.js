'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {channelOffice}=require('../helpers/channel-dm-office.cjs');
const {buildAccessVM}=require('../../src/api/v2/vm/access');
const {project3x}=require('../../src/api/v2/project3x');
const {validate}=require('../../src/schema');
const {schemasFor}=require('../../src/api/v2/vm/schemas');

test('account-scoped human DMs annotate their owner without a separate occupant or teammate',()=>{
  for(const version of [2,3])for(const [channel,family,peer] of [['wechat-native-isolated','wechat','synthetic-peer'],['whatsapp','whatsapp','synthetic-peer'],['discord','discord','100000000000000001']]){
    const {vm,engine}=channelOffice({channel,peer,version});
    const owner=vm.occupants.find(row=>row.role===(version===3?'primary':'main'));
    assert.ok(owner,channel);assert.equal(vm.occupants.length,1);assert.equal(vm.conversationCount,0);
    assert.equal(owner.name,'Synthetic agent');assert.notEqual(owner.visitLabel.params.name,owner.name,'a card never names itself as counterpart');
    assert.equal(vm.occupants.filter(row=>['main','primary','agent','subagent'].includes(row.role)).length,1);
    assert.equal(vm.occupants.some(row=>row.name==='Synthetic agent · 2'),false);
    assert.deepEqual(owner.visitLabel,{key:'office.visitingWithChannel',params:{name:'Synthetic person',channel:{key:'channel.'+family}}});
    assert.equal(vm.visitIntent,undefined,'no physical human visitor or seating intent');
    const access=buildAccessVM({agents:engine.agents(),sessions:engine.sessions(),config:null,peek:()=>({resolution:'unresolvable',profile:null}),P:project3x});
    assert.equal(access.interlocutors[0].kind,'user');assert.equal(access.interlocutors[0].channel,family);
    const checked=validate(schemasFor(version).office,vm);assert.equal(checked.ok,true,JSON.stringify(checked.issues));
  }
});

test('unknown peers stay anonymous and limited Office does not disclose person names or channels',()=>{
  const anonymous=channelOffice({person:null});
  const owner=anonymous.vm.occupants.find(row=>row.role==='primary');
  assert.deepEqual(owner.visitLabel.params.name,{key:'occupantRole.direct'});
  const {vm}=channelOffice({canReadSessions:false,person:'Private synthetic person'});
  const text=JSON.stringify(vm);assert.equal(text.includes('Private synthetic person'),false);assert.equal(text.includes('channel.wechat'),false);
  assert.equal(vm.occupants.some(row=>row.role==='direct'),false);
});

test('Office uses the same resolved human sender fallback as Logs without exposing unresolved peer ids',()=>{
  const {vm}=channelOffice({person:null,sender:'Synthetic owner'});
  const owner=vm.occupants.find(row=>row.role==='primary');assert.equal(owner.name,'Synthetic agent');assert.equal(owner.visitLabel.params.name,'Synthetic owner');
  const limited=channelOffice({canReadSessions:false,person:null,sender:'Private synthetic owner'}).vm;
  assert.equal(JSON.stringify(limited).includes('Private synthetic owner'),false);
});

test('limited actor projection strips conversation metadata from the cached full agent card',()=>{
  const {vm}=channelOffice({person:'Private synthetic contact'}),user={id:'synthetic-reader',status:'active'};
  const store={users:{byId:()=>user},policy:{can:(_user,key)=>key==='office'},rbac:{fingerprint:()=> 'synthetic-permissions'}};
  assert.equal(vm.occupants[0].visitLabel.params.name,'Private synthetic contact','test starts from a full cached card');
  const projector=require('../../src/security/view-projection').createViewProjection({store});
  const limited=projector.project(user,'office',vm,{version:3});
  assert.equal(limited.occupants.length,1);assert.equal(limited.occupants[0].visitLabel,undefined);
  assert.equal(JSON.stringify(limited).includes('Private synthetic contact'),false);
});

test('canonical engine Office builder also presents channel DMs only on the agent card',()=>{
  const {options}=channelOffice(),{officeDefaults,createStateTracker}=require('../../src/api/v2/vm/office');
  const vm=require('../../src/engine/office/base-view').buildOfficeVM({...options,tracker:createStateTracker(),layout:officeDefaults(),P2:require('../../src/api/v2/project2x').project2x,scheduleVM:require('../../src/api/v2/vm/flows').scheduleVM});
  assert.equal(vm.occupants.length,1);assert.equal(vm.occupants[0].name,'Synthetic agent');assert.equal(vm.occupants[0].visitLabel.params.name,'Synthetic person');
});
