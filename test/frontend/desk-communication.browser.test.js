import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');
const sourceSender={kind:'agent',id:'agent:worker-2',name:null,runtime:'synthetic-office',channel:null,avatarHint:null};
const body='synthetic private exchange body';
function exchange(h,reply=false){
 const at=h.clock.value;
 const events=[{id:'ev:0:0',kind:'user',at,senderInfo:sourceSender,text:body,sender:null,truncated:false}];
 if(reply)events.push({id:'ev:1:0',kind:'assistant',at:at+1,senderInfo:null,text:body,truncated:false,model:null,provider:null,outputTokens:null,stopReason:null,error:null});
 if(reply)h.clock.value++;
 const transcript={sessionKey:'worker-3',fetchedAt:h.clock.value,messageCount:events.length,window:{from:0,to:events.length},events};
 const r=h.viewEngine.ingestCanonical('transcript',transcript,{key:transcript.sessionKey});assert.equal(r.ok,true,JSON.stringify(r.issues));h.api.topics.invalidate();
}
async function policy(h,percent){const r=await h.get('/api/v3/office/layout');const save=await h.put('/api/v3/office/layout',{expectedRevision:r.json.data.layout.revision,data:{...r.json.data.layout.data,communicationMeetingPercent:percent}});assert.equal(save.status,200,save.text);}
async function vm(h,version){const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);assert.ok(!r.text.includes(body));return r.json.data;}
async function refresh(page){await page.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});}
async function settled(page,rows){
 await page.waitForFunction(rows=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?.chars.size===rows.length&&rows.every(o=>{const c=s.chars.get(o.id);return c&&!c.walking&&Math.abs(c.pos.x-o.sceneTarget.point.x)<.001&&Math.abs(c.pos.y-o.sceneTarget.point.y)<.001&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1&&c.occ.communication?.id===o.communication?.id&&c.occ.communication?.screen===o.communication?.screen;});},rows);
}
async function capture(page,name){
 await page.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));});
 const path=`design/reports/desk-communication/${name}.png`;await page.screenshot({path,animations:'disabled'});console.log('desk communication capture '+path);
}
for(const width of [1440,390])for(const theme of ['day','night'])test(`canonical message screens and backend meeting/return ${width} ${theme}`,
 {skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  const version=width===390?2:3;
  b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,apiProxy:async origin=>{
   h=await officeSceneFixture({publicUrl:origin,theme,occupantCount:4,namedAgents:true,primaryName:'Atlas',...emptyTeamOptions});h.publish(Array(4).fill('working'));await policy(h,0);return h.base;
  }});
  const p=b.page,errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width,height:width===390?844:900});
  await p.emulateMedia({reducedMotion:theme==='night'?'reduce':'no-preference'});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const initial=await vm(h,version),floor=initial.occupants[0].floorId;
  assert.ok(initial.occupants.every(o=>o.floorId===floor&&o.sceneTarget.mode==='desk'));
  await p.goto(b.origin+'/bureau?etage='+floor,{waitUntil:'domcontentloaded'});await settled(p,initial.occupants);
  if(version===3)await p.waitForFunction(()=>document.querySelector('.ao-team-office .ao-team-empty'));
  await mkdir('design/reports/desk-communication',{recursive:true});
  for(const reply of [false,true]){
   h.clock.value+=1000;exchange(h,reply);const data=await vm(h,version),pair=data.occupants.filter(o=>o.communication);assert.equal(pair.length,2);
   assert.equal(pair.find(o=>o.id==='agent:worker-2').communication.screen,reply?'message-received':'message-sent');
   assert.equal(pair.find(o=>o.id==='agent:worker-3').communication.screen,reply?'message-sent':'message-received');
   for(const o of pair){assert.equal(o.communication.mode,'desk');assert.deepEqual(o.sceneTarget,o.homeTarget);}
   await refresh(p);await settled(p,data.occupants);
   await p.waitForFunction(pair=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return pair.every(o=>s.itemNodes.get(o.stationUid)?.parts.monitor.dataset.screen?.startsWith(o.communication.screen+'-'));},pair);
   const actual=await p.evaluate(ids=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return ids.map(id=>{const c=s.chars.get(id),n=s.itemNodes.get(c.occ.stationUid);return {id,point:c.pos,stationUid:c.occ.stationUid,marker:c.marker.hidden,bubble:!!c.plate.querySelector('.ao-life-bubble'),screen:n.parts.monitor.dataset.screen};});},pair.map(o=>o.id));
   for(const row of actual){const o=pair.find(o=>o.id===row.id);assert.deepEqual(row.point,o.homeTarget.point);assert.equal(row.stationUid,o.homeTarget.stationUid);assert.equal(row.marker,true);assert.equal(row.bubble,false);assert.match(row.screen,new RegExp('^'+o.communication.screen+'-[12]\\.png$'));if(theme==='night')assert.ok(row.screen.endsWith('-1.png'));}
   await capture(p,`${width}-${theme}-${reply?'reply':'desk-message'}`);
  }
  // Force the configurable backend policy for coverage. Default remains 10%.
  await policy(h,100);const meeting=await vm(h,version),pair=meeting.occupants.filter(o=>o.communication);
  assert.equal(pair.length,2);assert.ok(pair.every(o=>o.communication.mode==='meeting'&&o.communication.surface==='bubble'&&o.sceneTarget.kind==='visit'));
  assert.notDeepEqual(pair[0].sceneTarget.point,pair[1].sceneTarget.point);assert.equal(pair[0].sceneTarget.stationUid,pair[1].sceneTarget.stationUid);
  await refresh(p);await settled(p,meeting.occupants);
  assert.equal(await p.evaluate(ids=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return ids.every(id=>{const c=s.chars.get(id);return !c.marker.hidden&&c.marker.dataset.kind==='thought';});},pair.map(o=>o.id)),true,'away meeting renders supplied messaging intent overhead');
  await capture(p,`${width}-${theme}-backend-meeting`);
  h.advance(121000,Array(4).fill('working'));const returned=await vm(h,version);assert.ok(returned.occupants.every(o=>o.communication===null&&o.sceneTarget.mode==='desk'&&o.screenIntent.screen==='coding'));
  await refresh(p);await settled(p,returned.occupants);
  await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].every(c=>c.marker.hidden&&!c.plate.querySelector('.ao-life-bubble')&&s.itemNodes.get(c.occ.stationUid).parts.monitor.dataset.screen?.startsWith('coding-'));});
  for(const o of returned.occupants)assert.deepEqual(o.sceneTarget.point,initial.occupants.find(r=>r.id===o.id).homeTarget.point);
  await capture(p,`${width}-${theme}-returned-home`);assert.deepEqual(errors,[]);
 }finally{await b?.close();await h?.close();}
});
