import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
for(const {width,theme,version} of [{width:1440,theme:'day',version:3},{width:390,theme:'night',version:2}])
test(`real v${version} monitor action view ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,apiProxy:async origin=>{h=await officeSceneFixture({publicUrl:origin,theme,occupantCount:11,namedAgents:true});h.clock.value=Math.floor(h.clock.value/1400)*1400;h.publish(Array(11).fill('working'));return h.base;}});
  const p=b.page;const errors=[];p.on('pageerror',error=>errors.push(error.message));await p.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await p.clock.setFixedTime(new Date(h.clock.value));
  const initial=(await h.get(`/api/v${version}/views/office`)).json.data;
  const floorId=initial.occupants.find(o=>o.role===(version===3?'primary':'main')).floorId;
  const deskCount=initial.occupants.filter(o=>o.floorId===floorId&&o.sceneTarget?.mode==='desk').length;assert.ok(deskCount>=2);
  await p.goto(b.origin+'/bureau?etage='+floorId,{waitUntil:'domcontentloaded'});
  try {await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&s.chars.size===11&&[...s.chars.values()].every(c=>!c.walking&&!c.leaving&&c.displayed?.classList.contains('is-in'));});}catch(error){console.log({errors,api:(await h.get(`/api/v${version}/views/office`)).json.data.occupants.map(o=>({id:o.id,floor:o.floorId,state:o.state,target:o.sceneTarget})),dom:await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return {text:document.body.innerText.slice(0,500),scene:!!s,hidden:s?.hidden,chars:s&&[...s.chars.values()].map(c=>({id:c.id,walking:c.walking,leaving:c.leaving,displayed:c.displayed?.className,target:c.target,pos:c.pos}))};})});throw error;}
  await p.waitForFunction(count=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return [...s.itemNodes.values()].filter(n=>n.parts?.monitor?.dataset.screen).length===count&&[...s.stage.querySelectorAll('img[src]')].every(i=>i.complete&&i.naturalWidth);},deskCount);
  const state=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return {people:[...s.chars.values()].map(c=>({id:c.id,uid:c.target.uid,pos:c.pos,mode:c.seatMode,marker:c.marker.hidden})),monitors:[...s.itemNodes.values()].filter(n=>n.parts?.monitor).map(n=>({uid:n.it.uid,screen:n.parts.monitor.dataset.screen,src:n.parts.monitor.src}))};});
  assert.equal(state.people.length,11);
  for(const person of state.people){const row=initial.occupants.find(o=>o.id===person.id);assert.deepEqual(person.pos,row.sceneTarget.point);if(row.sceneTarget?.mode==='desk'){assert.equal(person.marker,true);assert.equal(state.monitors.find(m=>m.uid===row.stationUid).screen,'coding-1.png');}}
  await mkdir('design/reports/monitor-actions',{recursive:true});
  await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
  await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));});
  await p.screenshot({path:`design/reports/monitor-actions/${width}-${theme}.png`,animations:'disabled'});
  await p.clock.setFixedTime(new Date(h.clock.value+700));
  await p.waitForFunction(()=>[...document.querySelector('.ao-bureau__stage').aoScene.itemNodes.values()].some(n=>n.parts?.monitor?.dataset.screen==='coding-2.png'));
  await p.emulateMedia({reducedMotion:'reduce'});
  await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return s.reducedMotion&&[...s.itemNodes.values()].filter(n=>n.parts?.monitor?.dataset.screen).every(n=>n.parts.monitor.dataset.screen==='coding-1.png');});
  await p.clock.setFixedTime(new Date(h.clock.value+2100));await p.waitForTimeout(120);
  assert.equal(await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.itemNodes.values()].filter(n=>n.parts?.monitor?.dataset.screen).every(n=>n.parts.monitor.dataset.screen==='coding-1.png')),true);
  h.advance(1000,Array(11).fill('idle'));
  await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});
  await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].every(c=>c.occ.state==='idle')&&[...s.itemNodes.values()].filter(n=>n.parts?.monitor).every(n=>!n.parts.monitor.dataset.screen);});
  assert.equal(await p.evaluate(()=>[...document.querySelector('.ao-bureau__stage').aoScene.itemNodes.values()].some(n=>n.parts?.monitor?.src.includes('monitor-screens'))),false);
 }finally{await b?.close();await h?.close();}
});

// Owner-requested mixed states: canonical engine activity and verified failure,
// projected through the real Office endpoint, never changing a browser VM.
for(const {width,theme,version} of [{width:1440,theme:'day',version:3},{width:390,theme:'night',version:2}])
test(`mixed canonical action screens ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 const desired=['working','thinking','waiting','blocked','error','executing','researching','writing'];
 const screenFor={working:'coding',thinking:'thinking',waiting:'waiting',blocked:'blocked',error:'blocked',executing:'terminal',researching:'browsing',writing:'writing'};
 try{
 b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,apiProxy:async origin=>{
  h=await officeSceneFixture({publicUrl:origin,theme,occupantCount:desired.length});h.clock.value=Math.floor(h.clock.value/1400)*1400;h.publish(Array(desired.length).fill('working'));
  for(let i=1;i<desired.length;i++){
   const key=`worker-${i}`,kind=desired[i];
   if(kind==='error'){
    const session=structuredClone(h.viewEngine.session(key));session.run={...session.run,status:'failed',endedAt:h.clock.value,endReason:'error',lastError:'synthetic failure'};
    const result=h.viewEngine.ingestCanonical('sessions.upsert',session);assert.equal(result.ok,true,JSON.stringify(result.issues));
   }else assert.equal(h.viewEngine.setObservedActivity(key,{kind,source:'transcript',since:h.clock.value,expiresAt:h.clock.value+30000}),true);
  }
  h.api.topics.invalidate();return h.base;
 }});
 const p=b.page;await p.setViewportSize({width,height:width===390?844:900});
 const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
 await p.clock.setFixedTime(new Date(h.clock.value));
 const result=await h.get(`/api/v${version}/views/office`);assert.equal(result.status,200,result.text);const vm=result.json.data;
 assert.deepEqual([...new Set(vm.occupants.map(o=>o.state))].sort(),desired.slice().sort());
 const floor=vm.occupants.find(o=>o.role===(version===3?'primary':'main')).floorId;
 await p.goto(b.origin+'/bureau?etage='+floor,{waitUntil:'domcontentloaded'});
 await p.waitForFunction(count=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&s.chars.size===count&&[...s.chars.values()].every(c=>!c.walking&&c.displayed?.classList.contains('is-in'))&&[...s.stage.querySelectorAll('img[src]')].every(i=>i.complete&&i.naturalWidth);},desired.length);
 assert.equal(await p.evaluate(()=>document.querySelector('.ao-bureau__stage').dataset.officeTheme),theme);
 const actual=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].map(c=>({id:c.id,state:c.occ.state,mode:c.seatMode,point:c.pos,marker:c.marker.hidden,bubble:!!c.plate.querySelector('.ao-life-bubble'),screen:s.itemNodes.get(c.occ.stationUid)?.parts?.monitor?.dataset.screen}));});
 for(const row of actual){const expected=vm.occupants.find(o=>o.id===row.id);assert.equal(row.state,expected.state);assert.deepEqual(row.point,expected.sceneTarget.point);if(expected.sceneTarget?.mode==='desk'){assert.equal(row.marker,true);assert.equal(row.bubble,false);assert.equal(row.screen,screenFor[row.state]+'-1.png');}}
 for(const required of ['thinking','waiting','blocked','error'])assert.ok(actual.some(o=>o.state===required&&o.mode==='desk'),'visible desk for '+required);
 await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
 await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));});
 await p.screenshot({path:`design/reports/monitor-actions/${width}-${theme}-mixed.png`,animations:'disabled'});
 }finally{await b?.close();await h?.close();}
});
