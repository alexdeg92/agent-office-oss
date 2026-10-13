'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');

test('idle desk capture fixture supplies healthy empty team and host APIs without changing runtime occupants',async()=>{
 const h=await officeSceneFixture({occupantCount:4,namedAgents:true,...emptyTeamOptions});
 try{
  for(const path of ['/api/v3/teams','/api/v3/orchestrators']){
   const r=await h.get(path);assert.equal(r.status,200,r.text);
   assert.deepEqual(path.endsWith('teams')?r.json.data.members:r.json.data.agents,[]);
  }
  h.publish(Array(4).fill('working'));
  for(const version of [2,3]){
   const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
   assert.equal(r.json.data.occupants.length,4);
   assert.ok(r.json.data.occupants.every(o=>o.state==='working'&&o.sceneTarget?.mode==='desk'));
  }
 }finally{await h.close();}
});
