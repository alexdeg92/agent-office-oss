import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {rosterFloorFixture}=require('../helpers/roster-floor-fixture.cjs');
const current=async(h,version)=>{const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);return r.json.data;};
const expected=vm=>vm.rosterFloors.map(f=>({id:f.id,count:f.count,items:f.items.map(i=>i.kind==='team-header'?{kind:i.kind,id:i.id}:{kind:i.kind,id:i.occupantId})}));
async function matches(page,vm){
 const want=expected(vm);
 await page.waitForFunction(want=>{
  const groups=[...document.querySelectorAll('.ao-bureau__side > .ao-floor-roster > [data-roster-floor]')].map(g=>({id:g.dataset.rosterFloor,count:Number(g.querySelector('.ao-floor-roster__jump span:nth-child(2)').textContent),items:[...g.querySelector(':scope > ul').children].map(li=>li.hasAttribute('data-roster-team-header')?{kind:'team-header',id:li.dataset.rosterTeamHeader}:{kind:'occupant',id:li.querySelector('[data-occupant]')?.dataset.occupant})}));
  return JSON.stringify(groups)===JSON.stringify(want);
 },want);
 const actual=await page.evaluate(()=>[...document.querySelectorAll('.ao-bureau__side > .ao-floor-roster > [data-roster-floor]')].map(g=>({id:g.dataset.rosterFloor,count:Number(g.querySelector('.ao-floor-roster__jump span:nth-child(2)').textContent),items:[...g.querySelector(':scope > ul').children].map(li=>li.hasAttribute('data-roster-team-header')?{kind:'team-header',id:li.dataset.rosterTeamHeader}:{kind:'occupant',id:li.querySelector('[data-occupant]')?.dataset.occupant})})));
 assert.deepEqual(actual,want,'each floor renders exactly the backend item sequence and count');
 const descendants=actual.flatMap(f=>f.items.filter(i=>i.kind==='occupant').map(i=>i.id));
 assert.equal(new Set(descendants).size,vm.occupants.length);assert.equal(descendants.length,vm.occupants.length,'no duplicate or leftover rows');
}
async function refresh(p,h){
 await p.clock.setFixedTime(new Date(h.clock.value));
 await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});
}
async function select(p,id){
 await p.locator('.ao-floor-mobile-trigger').click();await p.locator(`.ao-floor-picker--mobile [data-floor="${id}"]`).click();
 await p.waitForFunction(id=>document.querySelector('.ao-bureau__stage')?.aoScene?._floorId===id,id);
}
async function capture(p,path){
 await mkdir('design/reports/roster-floor-125',{recursive:true});
 await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
 await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('.ao-bureau__side img,.ao-bureau__stage img')].filter(i=>i.src).map(i=>i.decode()));});
 await p.locator('.ao-bureau__side').screenshot({path,animations:'disabled'});
 console.log('T-0125 capture '+path);
}

for(const version of [2,3])test(`v${version} mobile floor roster remains VM-exact across primary Gym relocation, lead return, floor switches and late GET`,{skip:browserSkipReason(),timeout:120000},async()=>{
 let b,h,releaseGet;
 try{
  b=await openLayoutBrowser({touch:true,theme:'dark',apiVersion:version,apiProxy:async origin=>{h=await rosterFloorFixture({publicUrl:origin});return h.base;}});
  const p=b.page,errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width:390,height:844});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const hosts=await h.get('/api/v3/orchestrators');assert.equal(hosts.status,200,hosts.text);
  await p.clock.setFixedTime(new Date(h.clock.value));const initial=await current(h,version);
  let held=false;const heldGet=new Promise(resolve=>{held=resolve;});const gate=new Promise(resolve=>{releaseGet=resolve;});
  await p.route(`**/api/v${version}/views/office*`,async route=>{
   if(!held)return route.continue();
   const response=await route.fetch();const resolve=held;held=false;resolve();await gate;await route.fulfill({response});
  });
  await p.goto(b.origin+'/bureau?etage=1',{waitUntil:'domcontentloaded'});
  let gateTimer;try{await Promise.race([heldGet,new Promise((_,reject)=>{gateTimer=setTimeout(()=>reject(new Error('real initial Office GET was not observed')),15000);})]);}finally{clearTimeout(gateTimer);}
  // SSE may initialize the scene while the earlier real HTTP snapshot is held.
  await matches(p,initial);
  h.advance(16*60000,['idle','idle','working','working']);const away=await current(h,version);await refresh(p,h);await matches(p,away);
  assert.equal(away.rosterFloors.find(f=>f.id==='gym').count,2);
  assert.equal(away.rosterFloors.find(f=>f.id==='1').items.filter(i=>i.kind==='team-header').length,1);
  releaseGet();await p.waitForTimeout(100);await matches(p,away);
  for(const floor of ['gym','1','rdc','gym']){await select(p,floor);await matches(p,away);}
  await capture(p,`design/reports/roster-floor-125/v${version}-lead-and-primary-gym.png`);

  h.advance(1,['idle','working','working','working']);const leadBack=await current(h,version);await refresh(p,h);await matches(p,leadBack);
  assert.equal(leadBack.rosterFloors.find(f=>f.id==='gym').count,1);
  assert.deepEqual(leadBack.rosterFloors.find(f=>f.id==='gym').items.map(i=>i.occupantId),[version===2?'main':'primary']);
  assert.deepEqual(leadBack.rosterFloors.find(f=>f.id==='1').items.map(i=>i.occupantId),['agent:worker-1','agent:worker-2','agent:worker-3']);
  assert.equal(await p.locator('.ao-bureau__side [data-roster-team-header]').count(),0,'old cross-floor team headers are removed');
  for(const floor of ['1','gym']){await select(p,floor);await matches(p,leadBack);}
  await capture(p,`design/reports/roster-floor-125/v${version}-primary-gym-team-floor1.png`);

  h.advance(1,['working','working','working','working']);const returned=await current(h,version);await refresh(p,h);await matches(p,returned);
  assert.equal(returned.rosterFloors.find(f=>f.id==='gym').count,0);
  await select(p,'1');await matches(p,returned);
  assert.equal(await p.locator('.ao-bureau__side [data-roster-floor="gym"] [data-occupant]').count(),0,'Gym has no carried-over occupants after the final return');
  assert.deepEqual(errors,[]);
 }finally{releaseGet?.();await b?.close();await h?.close();}
});
