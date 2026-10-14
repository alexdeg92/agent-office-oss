import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');
const captureDir='design/reports/monitor-alarm';
const vmNow=async(h,version)=>{const r=await h.get(`/api/v${version}/views/office`);assert.equal(r.status,200,r.text);return r.json.data;};
async function refresh(page){await page.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});}
function observed(h,key,kind){h.clock.value+=1000;assert.equal(h.viewEngine.setObservedActivity(key,{kind,source:'transcript',since:h.clock.value,expiresAt:h.clock.value+30000}),true);h.api.topics.invalidate();}
async function capture(page,name){
 await page.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));});
 const path=`${captureDir}/${name}.png`;await page.screenshot({path,animations:'disabled'});console.log('monitor alarm capture '+path);
}

for(const theme of ['light','dark'])for(const [view,width,height,touch,version] of [
 ['desktop',1440,900,false,3],['mobile',390,844,true,2],['mobile-small',375,667,true,3],
])test(`blocked/executing monitor, roster and drawer; away alarm v${version} ${width} ${theme}`,
 {skip:browserSkipReason(),timeout:90000},async()=>{
  let b,h;
  try{
   await mkdir(captureDir,{recursive:true});
   b=await openLayoutBrowser({theme,touch,apiVersion:version,apiProxy:async origin=>{
    h=await officeSceneFixture({publicUrl:origin,theme:theme==='light'?'day':'night',occupantCount:4,namedAgents:true,primaryName:'Atlas',...emptyTeamOptions});h.publish(Array(4).fill('working'));
    return h.base;
   }});
   const page=b.page,errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:'reduce'});
   const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
   const initial=await vmNow(h,version),primary=initial.occupants.find(o=>o.role===(version===3?'primary':'main'));
   assert.equal(primary.sceneTarget.mode,'desk');
   await page.goto(b.origin+'/bureau?etage='+primary.floorId,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(count=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?.chars.size===count&&[...s.chars.values()].every(c=>!c.walking&&c.displayed?.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1);},initial.occupants.length);
   if(theme==='dark')assert.equal(await page.evaluate(()=>document.querySelector('.ao-bureau__stage').aoScene.theme.monitors),'on','registered night theme explicitly forces monitors on');
   if(version===3)await page.waitForFunction(()=>{const p=document.querySelector('.ao-team-office');return p?.querySelector('.ao-team-empty')&&!p.querySelector('.ao-team-state,.ao-team-cached');});
   for(const state of ['blocked','executing']){
    observed(h,primary.sessionKey,state);const vm=await vmNow(h,version);assert.equal(vm.occupants.find(o=>o.id===primary.id).state,state);await refresh(page);
    await page.waitForFunction(({id,state})=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene,c=s?.chars.get(id),n=c&&s.itemNodes.get(c.occ.stationUid);
     return c?.occ.state===state&&!c.walking&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1&&
      n?.parts.monitor.dataset.screen?.startsWith(state==='blocked'?'blocked-':'terminal-')&&n.glow?.dataset.mode===(state==='blocked'?'error':'on');
    },{id:primary.id,state});
    const actual=await page.evaluate(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,c=s.chars.get(id),n=s.itemNodes.get(c.occ.stationUid);return {point:c.pos,marker:c.marker.hidden,bubble:!!c.plate.querySelector('.ao-life-bubble'),tint:n.tint.hidden,glow:n.glow.dataset.mode};},primary.id);
    assert.deepEqual(actual.point,vm.occupants.find(o=>o.id===primary.id).sceneTarget.point);assert.equal(actual.marker,true);assert.equal(actual.bubble,false);
    assert.equal(actual.tint,state!=='blocked','native blocked screen retains its red desk tint');
    const button=width<=480?page.locator(`.ao-mobile-roster [data-mobile-agent="${primary.id}"]`):page.locator(`.ao-floor-roster [data-occupant="${primary.id}"]`);
    const row=width<=480?page.locator(`.ao-mobile-group:has([data-mobile-agent="${primary.id}"])`):button;
    await row.waitFor({state:'visible'});const label=state==='blocked'?'Bloqué':'Exécute';
    assert.equal((await row.locator('.ao-roster__state').innerText()).trim(),label);
    assert.equal(await row.locator('.ao-roster__state svg use').getAttribute('href'),state==='blocked'?'#i-state-error':'#i-tool-exec');
    if(state==='blocked'){
     const colors=await row.locator('.ao-roster__state').evaluate(element=>{const probe=document.createElement('span');probe.style.color='var(--bu-state-error)';element.append(probe);const values=[getComputedStyle(element).color,getComputedStyle(probe).color];probe.remove();return values;});
     assert.equal(colors[0],colors[1],'roster retains the established alert color');
    }
    await capture(page,`${view}-${width}-${theme}-${state}`);
    await button.click();const drawer=page.locator(`.ao-drawer__state[data-agent-state="${state}"]`);await drawer.waitFor({state:'visible'});assert.equal((await drawer.innerText()).trim(),label);
    await capture(page,`${view}-${width}-${theme}-${state}-drawer`);
    await page.keyboard.press('Escape');await page.locator('.ao-bureau__stage').scrollIntoViewIfNeeded();
   }
   h.clock.value+=1000;h.viewEngine.clearObservedActivity(primary.sessionKey);
   const idleSession=structuredClone(h.viewEngine.session(primary.sessionKey));idleSession.updatedAt=h.clock.value;
   idleSession.run={...idleSession.run,status:'idle',endReason:null,observedAt:h.clock.value,expiresAt:null,startedAt:null,endedAt:null};
   assert.equal(h.viewEngine.ingestCanonical('sessions.upsert',idleSession).ok,true);h.api.topics.invalidate();
   const idle=await vmNow(h,version);assert.equal(idle.occupants.find(o=>o.id===primary.id).state,'idle');await refresh(page);
   await page.waitForFunction(id=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene,c=s?.chars.get(id),n=c&&s.itemNodes.get(c.occ.stationUid);return c?.occ.state==='idle'&&c.renderedPose==='life-sleep-ne'&&c.displayed?.dataset.pose===c.renderedPose&&Number(getComputedStyle(c.displayed).opacity)===1&&!n.parts.monitor.dataset.screen&&n.glow.dataset.mode==='off'&&n.tint.hidden;},primary.id);
   if(theme==='dark')assert.equal(await page.evaluate(()=>document.querySelector('.ao-bureau__stage').aoScene.theme.monitors),'on');
   await capture(page,`${view}-${width}-${theme}-forced-on-idle-off`);
   // A separate canonical eleven-agent population supplies a genuine away
   // overflow target alongside occupied desks. Never allocate a browser spot.
   assert.deepEqual(errors,[]);await b.close();await h.close();
   b=await openLayoutBrowser({theme,touch,apiVersion:version,apiProxy:async origin=>{
    h=await officeSceneFixture({publicUrl:origin,theme:theme==='light'?'day':'night',occupantCount:11,namedAgents:false,primaryName:'Atlas',...emptyTeamOptions});h.publish(Array(11).fill('working'));
    return h.base;
   }});
   const alarmPage=b.page;alarmPage.on('pageerror',e=>errors.push(e.message));await alarmPage.setViewportSize({width,height});await alarmPage.emulateMedia({reducedMotion:'reduce'});
   const cookie=h.cookie.indexOf('=');await alarmPage.context().addCookies([{name:h.cookie.slice(0,cookie),value:h.cookie.slice(cookie+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
   const overflow=await vmNow(h,version);
   const away=overflow.occupants.find(o=>o.sceneTarget&&o.sceneTarget.mode!=='desk');assert.ok(away);
   const failed=overflow.occupants.find(o=>o.floorId===away.floorId&&o.role==='subagent'&&o.sceneTarget?.mode==='desk');assert.ok(failed);
   assert.equal(overflow.occupants.filter(o=>o.floorId===away.floorId).length,11,'the overflow fixture has one authoritative eleven-agent floor');
   const session=structuredClone(h.viewEngine.session(failed.sessionKey));
   session.run={...session.run,status:'failed',endedAt:h.clock.value,endReason:'error',lastError:'synthetic failure'};
   const admitted=h.viewEngine.ingestCanonical('sessions.upsert',session);assert.equal(admitted.ok,true,JSON.stringify(admitted.issues));
   observed(h,away.sessionKey,'blocked');const alarms=await vmNow(h,version);assert.equal(alarms.occupants.find(o=>o.id===failed.id).state,'error');await alarmPage.goto(b.origin+'/bureau?etage='+away.floorId,{waitUntil:'domcontentloaded'});
   await alarmPage.waitForFunction(({away,failed})=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene,a=s?.chars.get(away),f=s?.chars.get(failed),n=f&&s.itemNodes.get(f.occ.stationUid);
    return s?.chars.size===11&&[...s.chars.values()].every(c=>!c.walking&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1)&&a?.occ.state==='blocked'&&!a.walking&&!a.marker.hidden&&a.marker.dataset.kind==='alert'&&a.marker.querySelector('.ao-mk--solid')&&
     f?.occ.state==='error'&&f.displayed?.dataset.pose===f.renderedPose&&f.displayed.classList.contains('is-in')&&Number(getComputedStyle(f.displayed).opacity)===1&&f.marker.hidden&&!f.plate.querySelector('.ao-life-bubble')&&n?.glow.dataset.mode==='error'&&!n.tint.hidden&&n.parts.monitor.dataset.screen?.startsWith('blocked-');
   },{away:away.id,failed:failed.id});
   await capture(alarmPage,`${view}-${width}-${theme}-desk-error-away-blocked`);
   assert.deepEqual(errors,[]);
  }finally{await b?.close();await h?.close();}
});
