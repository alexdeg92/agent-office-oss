'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rosterFloorFixture}=require('../helpers/roster-floor-fixture.cjs');

test('real roster projection keeps working team onFloor1 as independent primary and lead visit Gym, clears returned-lead header',async()=>{
 const h=await rosterFloorFixture();
 try{
  const hosts=await h.get('/api/v3/orchestrators');assert.equal(hosts.status,200,hosts.text);
  for(const version of [2,3])assert.equal((await h.get(`/api/v${version}/views/office`)).status,200);
  h.advance(16*60000,['idle','idle','working','working']);
  for(const version of [2,3]){
   const response=await h.get(`/api/v${version}/views/office`);assert.equal(response.status,200,response.text);const vm=response.json.data;
   const primary=vm.occupants.find(o=>o.role===(version===2?'main':'primary')),pm=vm.occupants.find(o=>o.id==='agent:worker-1');
   assert.equal(primary.floorId,'gym');assert.equal(pm.floorId,'gym');
   assert.equal(vm.rosterFloors.find(f=>f.id==='gym').items.filter(i=>i.kind==='team-header').length,0);
   const floor1=vm.rosterFloors.find(f=>f.id==='1');assert.deepEqual(floor1.items.filter(i=>i.kind==='occupant').map(i=>i.occupantId),['agent:worker-2','agent:worker-3']);
   assert.equal(floor1.items.filter(i=>i.kind==='team-header').length,1);
  }
  h.advance(1,['idle','working','working','working']);
  for(const version of [2,3]){
   const vm=(await h.get(`/api/v${version}/views/office`)).json.data;
   assert.deepEqual(vm.rosterFloors.find(f=>f.id==='gym').items.map(i=>i.occupantId),[version===2?'main':'primary']);
   assert.deepEqual(vm.rosterFloors.find(f=>f.id==='1').items.map(i=>i.occupantId),['agent:worker-1','agent:worker-2','agent:worker-3']);
   assert.ok(vm.rosterFloors.every(f=>f.items.every(i=>i.kind!=='team-header')));
  }
 }finally{await h.close();}
});
