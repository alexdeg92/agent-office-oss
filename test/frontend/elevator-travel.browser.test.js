import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const count=11;
const active=Array.from({length:count},(_,i)=>i<2?'idle':'working');
const current=async(h,v)=>{const r=await h.get(`/api/v${v}/views/office`);assert.equal(r.status,200,r.text);return r.json.data;};
const scene=()=>document.querySelector('.ao-bureau__stage')?.aoScene;
async function ready(p,floor){
  await p.waitForFunction(id=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?._floorId===id;},floor);
  try {await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&s.chars.size>0&&[...s.chars.values()].every(c=>!c.leaving&&!c.walking&&c.displayed?.classList.contains('is-in'));});}catch(error){console.log('elevator-wait-diagnostic',await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return JSON.stringify({hidden:s?.hidden,floor:s?._floorId,last:s?._last,raf:s?._raf,chars:[...s.chars.values()].map(c=>({id:c.id,state:c.occ?.state,floorId:c.occ?.floorId,stationUid:c.occ?.stationUid,walking:c.walking,leaving:c.leaving,phase:c.el?.dataset.travelPhase,pose:c.renderedPose,displayed:!!c.displayed,classes:c.displayed?.className,pos:c.pos,target:c.target,next:c.path?.[0],pathLength:c.path?.length}))});}));throw error;}
  await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&[...s.stage.querySelectorAll('img[src]')].every(i=>i.complete&&i.naturalWidth);});
}
async function select(p,width,id){
  if(width===390){await p.locator('.ao-floor-mobile-trigger').click();await p.locator(`.ao-floor-picker--mobile [data-floor="${id}"]`).click();}
  else await p.locator(`.ao-floor-picker:not(.ao-floor-picker--mobile) [data-floor="${id}"]`).click();
  await p.waitForFunction(floor=>document.querySelector('.ao-bureau__stage')?.aoScene?._floorId===floor,id);
}
async function refresh(p,h){
  await p.clock.setFixedTime(new Date(h.clock.value));
  await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});
}
async function capture(p,path){
  await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
  await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  await p.screenshot({path,animations:'disabled'});
}
async function matches(p,vm,id){
  const expected=vm.rosterFloors.find(f=>f.id===id).occupantIds;
  const actual=await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].filter(c=>!c.leaving).map(c=>c.id));
  assert.deepEqual(actual.slice().sort(),expected.slice().sort());
}

const cases=[...Array.from([2,3],version=>[1440,390].flatMap(width=>['day','night'].map(theme=>({version,width,theme,reduced:false})))).flat(),{version:3,width:390,theme:'day',reduced:true}];
for(const {version,width,theme,reduced} of cases)
test(`v${version} elevator travel renders backend floors and keeps working desks: ${theme} ${width}${reduced?' reduced motion':''}`,{skip:browserSkipReason(),timeout:120000},async()=>{
  let h,b;
  try{
    b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,apiProxy:async origin=>{h=await officeSceneFixture({publicUrl:origin,theme,occupantCount:count,namedAgents:true});return h.base;}});
    const p=b.page;await p.setViewportSize({width,height:width===390?844:900});
    const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
    await p.clock.setFixedTime(new Date(h.clock.value));await p.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
    // The shared fixture starts idle occupants at activity spots immediately;
    // this scenario needs a real desk baseline before advancing into a break.
    h.advance(0,Array(count).fill('working'));
    const initial=await current(h,version);assert.equal(initial.occupants.length,count);
    const primary=initial.occupants.find(o=>o.role===(version===2?'main':'primary')),home=primary.floorId;
    await p.goto(b.origin+'/bureau?etage='+home,{waitUntil:'domcontentloaded'});await ready(p,home);
    const workers=initial.occupants.filter(o=>/^(st-[34]|floor-[0-9]+-desk-[34])$/.test(o.stationUid));assert.equal(workers.length,2);
    await p.evaluate(({ids,parentId})=>{const s=document.querySelector('.ao-bureau__stage').aoScene;s.setVisits({hostId:parentId,meeting:ids,desk:[],talking:true,speaker:parentId});s.cue(ids[0],'delegating',{partnerId:ids[1],interactionId:'synthetic-seat-probe'});},{ids:workers.map(o=>o.id),parentId:primary.id});
    const seated=await p.evaluate(ids=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return ids.map(id=>{const c=s.chars.get(id);return {id,uid:c.target.uid,mode:c.seatMode,pos:c.pos,visit:c.visit,meet:!!c.meet};});},workers.map(o=>o.id));
    for(const row of seated){const expected=workers.find(o=>o.id===row.id);assert.equal(row.uid,expected.stationUid);assert.equal(row.mode,'desk');assert.deepEqual(row.pos,expected.sceneTarget.point);assert.equal(row.visit,null);assert.equal(row.meet,false);}
    await mkdir('design/reports/elevator-runtime',{recursive:true});
    const prefix=`design/reports/elevator-runtime/v${version}-${theme}-${width}${reduced?'-reduced':''}`;
    await capture(p,prefix+'-working-desks.png');

    h.advance(0,active);await current(h,version); // start the idle interval after the working-desk baseline
    h.advance(18*60000,active);const away=await current(h,version);await refresh(p,h);
    const primaryAway=away.occupants.find(o=>o.id===primary.id);assert.notEqual(primaryAway.floorId,home);
    const destination=primaryAway.floorId;
    if(reduced)await p.waitForFunction(id=>!document.querySelector('.ao-bureau__stage')?.aoScene?.chars.has(id),primary.id);
    else {
    await p.waitForFunction(id=>{const c=document.querySelector('.ao-bureau__stage')?.aoScene?.chars.get(id);return c?.leaving&&c.el.dataset.travelPhase==='departure';},primary.id);
    const leaving=await p.evaluate(id=>{const c=document.querySelector('.ao-bureau__stage').aoScene.chars.get(id);return {target:c.target,walking:c.walking};},primary.id);
    assert.equal(leaving.walking,true);assert.equal(leaving.target.x,primaryAway.sceneTravel.departure.point.x);assert.equal(leaving.target.y,primaryAway.sceneTravel.departure.point.y);
    }
    await matches(p,away,home);
    const stillWorking=await p.evaluate(ids=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return ids.map(id=>({id,target:s.chars.get(id).target.uid,mode:s.chars.get(id).seatMode}));},workers.map(o=>o.id));
    for(const row of stillWorking){assert.equal(row.target,workers.find(o=>o.id===row.id).stationUid);assert.equal(row.mode,'desk');}
    await select(p,width,destination);
    if(!reduced)await p.waitForFunction(id=>{const c=document.querySelector('.ao-bureau__stage')?.aoScene?.chars.get(id);return c?.walking&&c.el.dataset.travelPhase==='arrival';},primary.id);
    await ready(p,destination);await matches(p,away,destination);
    const arrived=await p.evaluate(id=>{const c=document.querySelector('.ao-bureau__stage').aoScene.chars.get(id);return {pos:c.pos,target:c.target};},primary.id);
    assert.deepEqual(arrived.pos,primaryAway.sceneTarget.point);assert.equal(arrived.target.mode,primaryAway.sceneTarget.mode);
    await capture(p,prefix+'-initial-break.png');

    h.advance(1000,Array(count).fill('idle'));await current(h,version);await refresh(p,h);
    h.advance(18*60000,Array(count).fill('idle'));const breaks=await current(h,version);assert.equal(breaks.occupants.length,count);await refresh(p,h);
    assert.ok(breaks.occupants.some(o=>o.floorId==='gym'));await select(p,width,'gym');await ready(p,'gym');await matches(p,breaks,'gym');
    await capture(p,prefix+'-gym.png');
    const gymPoses=await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].map(c=>({mode:c.target.mode,pose:c.renderedPose})));
    for(const row of gymPoses)assert.match(row.pose,row.mode==='sofa'?/sofa-sit-sw/:/egg-curl-(low|high)-sw/);
    await select(p,width,'rdc');await ready(p,'rdc');await matches(p,breaks,'rdc');
    const lobby=breaks.occupants.filter(o=>o.floorId==='rdc');
    const smokers=lobby.filter(o=>o.activity?.kind==='smoke');assert.equal(smokers.length,2);assert.notDeepEqual(smokers[0].sceneTarget.point,smokers[1].sceneTarget.point);
    assert.ok(smokers.every(o=>o.sceneTarget.point.x>=8));
    assert.equal(lobby.filter(o=>o.activity?.kind==='coffee').length,1);
    assert.equal(lobby.filter(o=>o.sceneTarget.mode==='sofa').length,4);
    const lobbyPoses=await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].map(c=>({id:c.id,pose:c.renderedPose,fx:c.lifeFxKind,pos:c.pos})));
    for(const row of lobbyPoses){const supplied=lobby.find(o=>o.id===row.id);assert.deepEqual(row.pos,supplied.sceneTarget.point);if(supplied.activity.kind==='smoke'){assert.match(row.pose,/egg-smoke-sw/);assert.equal(row.fx,'smoke');}else if(supplied.activity.kind==='coffee')assert.match(row.pose,/life-(drink|cupwalk)-sw/);else assert.match(row.pose,/sofa-sit-sw/);}
    await capture(p,prefix+'-lobby-all-breaks.png');

    h.advance(1000,Array(count).fill('working'));const returned=await current(h,version);await refresh(p,h);
    await select(p,width,home);
    await p.waitForFunction(count=>document.querySelector('.ao-bureau__stage')?.aoScene?.chars.size===count,returned.occupants.filter(o=>o.floorId===home).length);
    await matches(p,returned,home);
    assert.ok(returned.occupants.every(o=>o.activity===null&&o.sceneTarget.floorId===home));
    const homeTargets=returned.occupants.filter(o=>o.floorId===home).map(o=>({id:o.id,point:o.sceneTarget.point,stationUid:o.stationUid??`intent:${o.id}`,mode:o.sceneTarget.mode}));
    const settled=rows=>{
      const s=document.querySelector('.ao-bureau__stage')?.aoScene;if(!s)return false;
      return rows.every(row=>{const c=s.chars.get(row.id);return c&&!c.leaving&&!c.walking&&c.path.length===0
        &&Math.hypot(c.pos.x-row.point.x,c.pos.y-row.point.y)<.01
        &&c.target.uid===row.stationUid&&c.target.mode===row.mode;});
    };
    // The fixed-time browser fixture can stall scheduled rAF callbacks after repeated
    // VM refreshes. Bound the wait from the actual longest backend-return path length.
    const frameBudget=await p.evaluate(()=>{
      const s=document.querySelector('.ao-bureau__stage')?.aoScene,speed=s?.opts.walkTilesPerS??1.5;
      const distance=c=>{let from=c.pos;return c.path.reduce((sum,to)=>{const d=Math.hypot(to.x-from.x,to.y-from.y);from=to;return sum+d;},0);};
      const maxDistance=Math.max(0,...[...s.chars.values()].filter(c=>c.walking).map(distance));
      return Math.min(600,Math.ceil((maxDistance/speed+3)*10));
    });
    await p.evaluate(async(maxFrames)=>{
      const s=document.querySelector('.ao-bureau__stage')?.aoScene;let t=performance.now();
      for(let i=0;i<maxFrames&&[...s.chars.values()].some(c=>c.walking&&c.path.length);i++){
        if(s._raf)cancelAnimationFrame(s._raf);s._raf=0;t+=100;s._frame(t);await Promise.resolve();
      }
    },frameBudget);
    await p.waitForFunction(settled,homeTargets,{timeout:1000});
    const final=await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.chars.values()].map(c=>({id:c.id,pos:c.pos,target:c.target,walking:c.walking,pathLength:c.path.length})));
    for(const row of final){const expected=returned.occupants.find(o=>o.id===row.id),point=expected.sceneTarget.point;assert.equal(row.target.x,point.x);assert.equal(row.target.y,point.y);assert.equal(row.target.uid,expected.stationUid??`intent:${row.id}`);assert.equal(row.target.mode,expected.sceneTarget.mode);if(row.walking)assert.ok(row.pathLength>0);else assert.deepEqual(row.pos,point);}
  }finally{await b?.close();await h?.close();}
});
