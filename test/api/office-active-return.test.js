'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const kinds=['working','thinking','executing','researching','writing','calling','waiting','blocked'];
for(const kind of kinds)test(`idle16m relocation returns immediately to own desk on ${kind}, v2/v3`,async()=>{
 const h=await officeSceneFixture();
 try{
  for(const version of [2,3])assert.equal((await h.get(`/api/v${version}/views/office`)).status,200);
  h.advance(16*60000,['idle','idle','working','working','working','working','working']);
  const before=(await h.get('/api/v3/views/office')).json.data;
  const away=before.occupants.find(o=>o.role==='primary');assert.ok(away.activity);assert.notEqual(away.floorId,away.homeTarget.floorId);
  const beforeTime=h.clock.value;
  assert.equal(h.viewEngine.setObservedActivity('main',{kind,source:'transcript',since:beforeTime,expiresAt:beforeTime+30000}),true);h.api.topics.invalidate();
  const targets=[];
  for(const version of [2,3]){
   const result=await h.get(`/api/v${version}/views/office`);assert.equal(result.status,200,result.text);
   const active=result.json.data.occupants.find(o=>o.role===(version===2?'main':'primary'));
   assert.equal(active.state,kind);assert.equal(h.clock.value,beforeTime,'no threshold or elapsed-time gate');
   assert.equal(active.activity,null);assert.deepEqual(active.sceneTarget,active.homeTarget);assert.equal(active.sceneTarget.mode,'desk');
   assert.equal(active.stationUid,away.homeTarget.stationUid);assert.equal(active.floorId,away.homeTarget.floorId);
   assert.equal(active.sceneTravel.fromFloorId,away.floorId);assert.equal(active.sceneTravel.toFloorId,away.homeTarget.floorId);
   assert.equal(active.sceneTravel.departure.floorId,away.floorId);assert.equal(active.sceneTravel.arrival.floorId,away.homeTarget.floorId);
   assert.notDeepEqual(active.sceneTravel.departure.point,away.sceneTarget.point,'return departure is the registered exit, not the activity prop');
   targets.push({target:active.sceneTarget,travel:active.sceneTravel});
  }
  assert.deepEqual(targets[0],targets[1]);
 }finally{await h.close();}
});
