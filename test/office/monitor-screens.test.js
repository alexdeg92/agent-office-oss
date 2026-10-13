'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const screens=require('../../public/v2/office/monitor-screens.js');
const manifest=require('../../design/assets/Office/monitor-screens/manifest.json');

test('every action uses the registered T-0123 screen and both 700ms frames retain their source hashes',()=>{
 const mapping={working:'coding',observed:'coding',thinking:'thinking',researching:'browsing',writing:'writing',executing:'terminal',calling:'terminal',waiting:'waiting',blocked:'blocked',error:'blocked'};
 for(const [state,id] of Object.entries(mapping)){
  const entry=manifest.states.find(s=>s.id===id);
  for(const [index,now] of [0,700].entries()){
   const source=screens.screen({reducedMotion:false},{state},now);
   assert.equal(source,'assets/Office/monitor-screens/'+entry.frames[index].file);
   assert.equal(crypto.createHash('sha256').update(fs.readFileSync('design/'+source)).digest('hex'),entry.frames[index].sha256);
  }
 }
 for(const state of ['idle','offline','unknown'])assert.equal(screens.screen({}, {state},0),null);
 assert.equal(screens.screen({},null,0),null,'a vacant or away station keeps its existing neutral/off monitor');
});
test('reduced motion stays on frame one and screen refresh uses existing scene clock, once per frame',()=>{
 let renders=0;const scene={reducedMotion:false,itemNodes:new Map([['desk',{parts:{monitor:{}}}],['plant',{parts:{}}]]),_updateStation:()=>renders++};
 screens.tickScreens(scene,0);screens.tickScreens(scene,50);screens.tickScreens(scene,699);assert.equal(renders,1);
 screens.tickScreens(scene,700);assert.equal(renders,2);
 scene.reducedMotion=true;screens.tickScreens(scene,700);screens.tickScreens(scene,1400);assert.equal(renders,3);
 assert.match(screens.screen(scene,{state:'thinking'},700),/thinking-1.png$/);
 assert.match(screens.screen(scene,{state:'thinking'},1400),/thinking-1.png$/);
});
test('overhead state markers move to computers, remaining only on away/walking occupants',()=>{
 assert.equal(screens.marker({seatMode:'desk',walking:false},'thought'),null);
 assert.equal(screens.marker({seatMode:'stand',target:{mode:'desk'},walking:false},'thought'),null,'fallback standing art at a supplied computer target still uses the monitor');
 assert.equal(screens.marker({seatMode:'desk',target:{mode:'stand'},walking:false},'thought'),'thought');
 assert.equal(screens.marker({seatMode:'stand',walking:false},'thought'),'thought');
 assert.equal(screens.marker({seatMode:'desk',walking:true},'question'),'question');
 assert.equal(screens.marker({seatMode:'stand',walking:false,cue:'talking'},'thought'),null);
 assert.equal(screens.bubble({target:{mode:'desk'},walking:false},'?'),null);
 assert.equal(screens.bubble({target:{mode:'stand'},walking:false},'?'),'?');
});
