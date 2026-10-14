'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');
test('canonical alarm fixtures supply a seated lead and a distinct away overflow population',async()=>{
 for(const count of [4,11]){
  const h=await officeSceneFixture({occupantCount:count,namedAgents:count===4,primaryName:'Atlas',...emptyTeamOptions});h.publish(Array(count).fill('working'));
  try{for(const version of [2,3]){
   const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
   const rows=r.json.data.occupants,lead=rows.find(o=>o.role===(version===3?'primary':'main'));
   assert.equal(rows.length,count);assert.ok(rows.some(o=>o.sceneTarget.mode==='desk'));
   if(count===4)assert.equal(lead.sceneTarget.mode,'desk');
   else {
    const away=rows.find(o=>o.floorId===lead.floorId&&o.sceneTarget.mode!=='desk');assert.ok(away);
    const failed=rows.find(o=>o.floorId===away.floorId&&o.role==='subagent'&&o.sceneTarget.mode==='desk');assert.ok(failed);
    assert.equal(rows.filter(o=>o.floorId===away.floorId).length,11);
    const session=structuredClone(h.viewEngine.session(failed.sessionKey));session.run={...session.run,status:'failed',endedAt:h.clock.value,endReason:'error',lastError:'synthetic failure'};
    assert.equal(h.viewEngine.ingestCanonical('sessions.upsert',session).ok,true);
    assert.equal(h.viewEngine.setObservedActivity(away.sessionKey,{kind:'blocked',source:'transcript',since:h.clock.value,expiresAt:h.clock.value+30000}),true);h.api.topics.invalidate();
    const alarms=(await h.get(`/api/v${version}/views/office`)).json.data.occupants;
    assert.equal(alarms.find(o=>o.id===failed.id).state,'error');assert.equal(alarms.find(o=>o.id===failed.id).sceneTarget.mode,'desk');
    assert.equal(alarms.find(o=>o.id===away.id).state,'blocked');assert.notEqual(alarms.find(o=>o.id===away.id).sceneTarget.mode,'desk');
   }
  }}finally{await h.close();}
 }
});
