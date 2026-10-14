import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{officeSceneFixture}=require('../helpers/office-scene-fixture.cjs'),{emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');
for(const width of [1440,390])for(const theme of ['day','night'])test(`thinking state stays on a seated monitor ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try {
  const version=width===390?2:3;
  b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,apiProxy:async publicUrl=>{
   h=await officeSceneFixture({publicUrl,theme,occupantCount:11,namedAgents:false,primaryName:'Atlas',...emptyTeamOptions});
   h.viewEngine.runtimes=()=>[{id:'fixture',adapter:'openclaw',name:'OpenClaw',enabled:true,connection:'connected',capabilities:{}}];
   h.publish(Array(11).fill('working'));
   const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);
   const rows=r.json.data.occupants,lead=rows.find(o=>o.role===(version===3?'primary':'main'));
   const desk=rows.find(o=>o.floorId===lead.floorId&&o.sceneTarget.mode==='desk'&&o.id!==lead.id),away=rows.find(o=>o.floorId===lead.floorId&&o.sceneTarget.mode!=='desk');assert.ok(desk&&away);
   for(const row of [desk,away])assert.equal(h.viewEngine.setObservedActivity(row.sessionKey,{kind:'thinking',source:'transcript',since:h.clock.value,expiresAt:h.clock.value+30000}),true);
   h.api.topics.invalidate();return h.base;
  }});
  const p=b.page,errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width,height:width===390?844:900});await p.emulateMedia({reducedMotion:'reduce'});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);const vm=r.json.data,lead=vm.occupants.find(o=>o.role===(version===3?'primary':'main')),rows=vm.occupants.filter(o=>o.floorId===lead.floorId);
  await p.goto(b.origin+'/bureau?etage='+lead.floorId,{waitUntil:'domcontentloaded'});
  await p.waitForFunction(rows=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&rows.every(o=>{const c=s.chars.get(o.id);return c&&!c.walking&&c.displayed?.classList.contains('is-in')&&c.occ.state===o.state;})&&[...s.stage.querySelectorAll('img[src]')].every(i=>i.complete&&i.naturalWidth);},rows);
  const actual=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].map(c=>({id:c.id,state:c.occ.state,mode:c.seatMode,point:c.pos,marker:c.marker.hidden,markerKind:c.marker.dataset.kind,thinkingDots:c.marker.querySelectorAll('.ao-mk--thought i').length,bubble:c.plate.querySelector('.ao-life-bubble')?.textContent??null,screen:s.itemNodes.get(c.occ.stationUid)?.parts?.monitor?.dataset.screen}));});
  let seated=0,away=0;
  for(const a of actual){const row=rows.find(o=>o.id===a.id);assert.ok(row);assert.deepEqual(a.point,row.sceneTarget.point);if(a.state!=='thinking')continue;
   if(row.sceneTarget.mode==='desk'){seated++;assert.equal(a.marker,true);assert.equal(a.bubble,null);assert.equal(a.screen,'thinking-1.png');assert.equal(row.screenIntent.surface,'monitor');}
   else{away++;assert.equal(a.marker,false);assert.equal(a.markerKind,'thought');assert.equal(a.thinkingDots,3);assert.equal(a.bubble,null);}
  }
  assert.ok(seated>=1&&away>=1,'canonical fixture includes both seated and away thinkers');
  assert.equal(await p.locator('.ao-bureau__stage .ao-marker,.ao-bureau__stage .ao-life-bubble').evaluateAll(nodes=>nodes.some(node=>node.textContent.includes('?'))),false,'no question glyph remains anywhere in the scene');
  await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
  await mkdir('design/reports/thinking-monitor-141',{recursive:true});await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:`design/reports/thinking-monitor-141/${width}-${theme}.png`,animations:'disabled'});
  assert.deepEqual(await p.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,width===390?844:900]);assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
 } finally {await b?.close();await h?.close();}
});
