import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const {emptyTeamOptions}=require('../helpers/office-empty-team-source.cjs');

for(const {width,theme,version} of [{width:1440,theme:'day',version:3},{width:1440,theme:'night',version:3},{width:390,theme:'day',version:2},{width:390,theme:'night',version:2}])
test(`idle desk doze and monitor off, then immediate active presentation v${version} ${width} ${theme}`,
 {skip:browserSkipReason(),timeout:90000},async()=>{
  let b,h;
  try{
    b=await openLayoutBrowser({theme:theme==='day'?'light':'dark',touch:width===390,apiVersion:version,
      apiProxy:async origin=>{h=await officeSceneFixture({publicUrl:origin,theme,occupantCount:4,namedAgents:true,...emptyTeamOptions});h.publish(Array(4).fill('working'));return h.base;}});
    const p=b.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.setViewportSize({width,height:width===390?844:900});await p.emulateMedia({reducedMotion:'reduce'});
    const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
    for(const path of ['/api/v3/teams','/api/v3/orchestrators']){const r=await h.get(path);assert.equal(r.status,200,r.text);}
    const vm=(await h.get(`/api/v${version}/views/office`)).json.data;
    const floor=vm.occupants.find(o=>o.role===(version===3?'primary':'main')).floorId;
    assert.equal(vm.occupants.filter(o=>o.floorId===floor&&o.sceneTarget?.mode==='desk').length,4);
    await p.goto(b.origin+'/bureau?etage='+floor,{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?.chars.size===4&&[...s.chars.values()].every(c=>!c.walking&&c.renderedPose==='working-ne'&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1);});
    h.advance(1000,['idle','idle','working','working']);
    await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;if(!s||s.chars.size!==4||[...s.chars.values()].filter(c=>c.occ.state==='idle').length!==2)return false;return [...s.chars.values()].every(c=>{
      const n=s.itemNodes.get(c.occ.stationUid);return !c.walking&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1&&(c.occ.state==='idle'?
        c.renderedPose==='life-sleep-ne'&&!n.parts.monitor.dataset.screen&&n.glow?.dataset.mode==='off'&&c.sleepLetters?.textContent==='zZz'&&!c.sleepLetters.hidden:
        c.renderedPose==='working-ne'&&n.parts.monitor.dataset.screen?.startsWith('coding-'));
    });});
    const idleVM=(await h.get(`/api/v${version}/views/office`)).json.data;
    const rendered=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].map(c=>{
      const n=s.itemNodes.get(c.occ.stationUid);return {id:c.id,state:c.occ.state,point:c.pos,pose:c.renderedPose,mode:c.seatMode,
        monitor:n.parts.monitor.src,screen:n.parts.monitor.dataset.screen,glow:n.glow?.dataset.mode,marker:c.marker.hidden,bubble:c.plate.querySelector('.ao-life-bubble')?.textContent??null,letters:c.sleepLetters?.textContent??null,animation:c.sleepLetters&&getComputedStyle(c.sleepLetters.firstElementChild).animationName};
    });});
    assert.equal(rendered.filter(c=>c.state==='idle').length,2);
    for(const c of rendered){const o=idleVM.occupants.find(o=>o.id===c.id);assert.deepEqual(c.point,o.sceneTarget.point);assert.equal(c.mode,'desk');assert.equal(c.marker,true);assert.equal(c.bubble,null);assert.equal(c.letters,c.state==='idle'?'zZz':null);if(c.state==='idle')assert.equal(c.animation,'none','reduced motion uses static sleep letters');
      if(c.state==='idle'){assert.equal(c.pose,'life-sleep-ne');assert.equal(c.screen,'');assert.equal(c.glow,'off');assert.doesNotMatch(c.monitor,/monitor(?:@|%40)on|monitor-screens/);}}
    await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
    if(version===3)await p.waitForFunction(()=>{const panel=document.querySelector('.ao-team-office');return panel?.querySelector('.ao-team-empty')&&!panel.querySelector('.ao-team-state,.ao-team-cached');});
    else assert.equal(await p.locator('.ao-team-office').count(),0,'legacy v2 does not render the v3 Members panel');
    await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].map(i=>i.decode()));});
    assert.equal(await p.locator('.ao-sleep-letters:visible').count(),2,'both unselected idle effects are visible independently of nameplates');
    const bounds=await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene,v=s.viewport.getBoundingClientRect();return [...s.labelsLayer.querySelectorAll('.ao-sleep-letters i')].map(i=>{const r=i.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom&&getComputedStyle(i).opacity==='1';});});
    assert.ok(bounds.every(Boolean),'all static letters stay visibly inside the viewport');
    assert.deepEqual(await p.locator('.ao-sleep-letters').first().locator('i').evaluateAll(nodes=>nodes.map(el=>parseFloat(getComputedStyle(el).fontSize))),width===390?[8.4,11.2,14]:[14.7,19.6,24.5],'owner-requested 30% reduction also applies to reduced motion');
    assert.equal(await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene,v=s.viewport.getBoundingClientRect();return [...s.chars.values()].filter(c=>c.sleepLetters).every(c=>{const r=c.sleepLetters.firstElementChild.getBoundingClientRect(),x=(c.head.sx+s.origin.x)*s.cam.zoom+s.cam.x+v.left,y=(c.head.sy+s.origin.y)*s.cam.zoom+s.cam.y+v.top;return Math.abs((r.left+r.right)/2-x)<35&&Math.abs(r.bottom-y)<30;});}),true,'each cascade starts near its own rendered head');
    const clear=()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;
      const labels=[...s.labelsLayer.querySelectorAll('.ao-plate:not([hidden])')].map(el=>el.getBoundingClientRect());
      return [...s.labelsLayer.querySelectorAll('.ao-sleep-letters i')].every(el=>{const r=el.getBoundingClientRect();return labels.every(p=>r.right<=p.left||r.left>=p.right||r.bottom<=p.top||r.top>=p.bottom);});};
    assert.equal(await p.evaluate(clear),true,'static letters clear every visible nameplate');
    if(width===390){
      const visibleIds=await p.locator('.ao-plate:visible').evaluateAll(nodes=>nodes.map(n=>n.dataset.occupant));
      assert.ok(visibleIds.length<=idleVM.rosterFloors.find(f=>f.id===floor).mobileLabelIds.length,'sleep does not expand the backend label shortlist');
    }
    await mkdir('design/reports/idle-desk-126',{recursive:true});
    const capture=`design/reports/idle-desk-126/${width}-${theme}.png`;await p.screenshot({path:capture,animations:'disabled'});console.log('T-0126 capture '+capture);
    await p.emulateMedia({reducedMotion:'no-preference'});
    try{await p.waitForFunction(()=>[...document.querySelectorAll('.ao-sleep-letters i')].length===6&&[...document.querySelectorAll('.ao-sleep-letters i')].every(el=>getComputedStyle(el).animationName==='ao-sleep-letter'));}
    catch(error){console.log('sleep media diagnostic',await p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return {reduced:s.reducedMotion,forced:s.forcedReduced,media:matchMedia('(prefers-reduced-motion: reduce)').matches,flag:s.stage.hasAttribute('data-reduced-motion'),chars:[...s.chars.values()].map(c=>({id:c.id,state:c.occ.state,pose:c.renderedPose,wave:!!c.wave,cue:c.cue,egg:!!c.egg,activity:c.activity?.kind,letters:!!c.sleepLetters})),letters:[...document.querySelectorAll('.ao-sleep-letters i')].map(el=>getComputedStyle(el).animationName)};}));throw error;}
    const idleId=idleVM.occupants.find(o=>o.role===(version===3?'primary':'main')).id;
    const clip=await p.evaluate(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,r=s.chars.get(id).sleepLetters.getBoundingClientRect(),v=s.viewport.getBoundingClientRect();return {x:Math.max(v.left,r.left-32),y:Math.max(v.top,r.top-4),width:Math.min(160,v.right-Math.max(v.left,r.left-32)),height:Math.min(140,v.bottom-Math.max(v.top,r.top-4))};},idleId);
    const images=[];
    for(const at of [0,933,1866]){
      await p.evaluate(at=>{for(const el of document.querySelectorAll('.ao-sleep-letters i'))for(const animation of el.getAnimations()){animation.pause();animation.currentTime=at;}},at);
      assert.equal(await p.evaluate(clear),true,'animated letters clear every visible nameplate at '+at+'ms');
      const path=`design/reports/idle-desk-126/${width}-${theme}-motion-${at}.png`;await p.screenshot({path,clip});images.push('data:image/png;base64,'+(await readFile(path)).toString('base64'));
    }
    const gallery=await p.context().newPage();await gallery.setViewportSize({width:540,height:200});
    await gallery.setContent('<body style="margin:0;background:#151922;color:#eee;font:14px sans-serif"><div style="display:flex;gap:12px;padding:12px">'+images.map((src,i)=>'<div><img width="160" height="140" src="'+src+'"><p style="margin:6px 0">'+[0,933,1866][i]+' ms</p></div>').join('')+'</div></body>');
    await gallery.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode())));await gallery.screenshot({path:`design/reports/idle-desk-126/${width}-${theme}-motion-strip.png`});await gallery.close();
    await p.emulateMedia({reducedMotion:'reduce'});
    await p.waitForFunction(()=>[...document.querySelectorAll('.ao-sleep-letters i')].every(el=>getComputedStyle(el).animationName==='none'));
    if(width===390){
      const point=await p.evaluate(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,c=s.chars.get(id),r=(c.poseEl??c.el).getBoundingClientRect();
        for(const fy of [.3,.5,.7])for(const fx of [.5,.3,.7]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if(s._occupantAt(x,y)===id&&s.viewport.contains(document.elementFromPoint(x,y)))return {x,y};}return null;},idleId);
      assert.ok(point,'the idle body has a real unobscured tap target');await p.touchscreen.tap(point.x,point.y);
    }else await p.locator(`.ao-plate[data-role="${version===3?'primary':'main'}"]`).click();
    await p.waitForFunction(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,c=s.chars.get(id);return c.wave&&s._currentPose(c)==='seated-wave-sw'&&!c.sleepLetters;},idleId);
    await p.keyboard.press('Escape');
    await p.waitForFunction(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,c=s.chars.get(id);return !c.wave&&c.occ.state==='idle'&&c.renderedPose==='life-sleep-ne'&&c.displayed?.dataset.pose==='life-sleep-ne'&&Number(getComputedStyle(c.displayed).opacity)===1&&c.sleepLetters?.textContent==='zZz';},idleId);
    assert.deepEqual(await p.evaluate(id=>document.querySelector('.ao-bureau__stage').aoScene.chars.get(id).pos,idleId),idleVM.occupants.find(o=>o.id===idleId).sceneTarget.point);
    h.advance(1000,Array(4).fill('working'));
    await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.stream.resync('office');});
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage').aoScene;return [...s.chars.values()].every(c=>c.occ.state==='working'&&!c.sleepLetters&&!c.plate.querySelector('.ao-life-bubble')&&c.renderedPose==='working-ne'&&c.displayed?.dataset.pose===c.renderedPose&&c.displayed.classList.contains('is-in')&&Number(getComputedStyle(c.displayed).opacity)===1&&s.itemNodes.get(c.occ.stationUid).parts.monitor.dataset.screen?.startsWith('coding-'));});
    assert.deepEqual(errors,[]);
  }finally{await b?.close();await h?.close();}
});
