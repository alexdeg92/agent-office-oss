'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');

test('mounted v2/v3 idle travel retains home desks, supplies elevator endpoints, and returns on work',async()=>{
  const h=await officeSceneFixture();
  try{
    for(const version of [2,3]){
      const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
      assert.equal(r.json.data.occupants.length,7);
      assert.equal(r.json.data.occupants.find(o=>o.role===(version===2?'main':'primary')).state,'idle');
    }
    h.advance(18*60000,['idle','idle','working','working','working','working','working']);
    const spatialByVersion=[];
    for(const version of [2,3]){
      const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
      spatialByVersion.push(r.json.data.occupants.map(o=>({id:o.id==='main'?'primary':o.id,target:o.sceneTarget,home:o.homeTarget,travel:o.sceneTravel,activity:o.activity})));
      const moved=r.json.data.occupants.filter(o=>o.activity);
      assert.equal(moved.length,2);
      for(const row of moved){
        assert.notEqual(row.floorId,'1');assert.equal(row.sceneTarget.floorId,row.floorId);assert.equal(row.homeTarget.floorId,'1');
        assert.equal(row.sceneTravel.fromFloorId,'1');assert.equal(row.sceneTravel.toFloorId,row.floorId);
        assert.equal(row.sceneTravel.departure.floorId,'1');assert.equal(row.sceneTravel.arrival.floorId,row.floorId);
      }
      assert.equal(r.json.data.rosterFloors.filter(f=>f.id!=='1').reduce((n,f)=>n+f.count,0),2);
      const working=r.json.data.occupants.filter(o=>o.state==='working');
      assert.ok(working.every(o=>!o.activity&&o.sceneTarget.floorId===o.homeTarget.floorId));
      for(const uid of ['st-3','st-4'])assert.equal(working.find(o=>o.stationUid===uid)?.sceneTarget.mode,'desk');
    }
    assert.deepEqual(spatialByVersion[0],spatialByVersion[1],'wire aliases cannot change canonical placement or journeys');
    h.advance(1000,Array(7).fill('working'));
    for(const version of [2,3]){
      const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
      assert.equal(r.json.data.rosterFloors.find(f=>f.id==='rdc').count,0);
      assert.ok(r.json.data.occupants.every(o=>!o.activity&&o.floorId==='1'&&o.sceneTarget.floorId==='1'));
      assert.ok(r.json.data.occupants.some(o=>o.sceneTravel&&o.sceneTravel.fromFloorId!=='1'&&o.sceneTravel.toFloorId==='1'));
    }
  }finally{await h.close();}
});
