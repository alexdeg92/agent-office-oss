import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');

// Delay delivery of real OfficeVM notifications to the page, without changing
// their contents or disconnecting SSE. This makes the saved-layout/next-VM gap
// observable, including the case where its new rule would choose another seat.
for(const version of [2,3])test(`v${version} editor save retains backend placement until the next OfficeVM`,{skip:browserSkipReason(),timeout:90000},async()=>{
  let h,b;
  try{
    b=await openLayoutBrowser({root:process.env.AO_EDITOR_PUBLIC_ROOT,apiVersion:version,apiProxy:async origin=>{h=await officeSceneFixture({publicUrl:origin});return h.base;}});
    const p=b.page;await p.setViewportSize({width:1440,height:900});
    const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
    await p.clock.setFixedTime(new Date(h.clock.value));await p.emulateMedia({reducedMotion:'reduce'});
    await p.goto(b.origin+'/bureau?etage=1',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>document.querySelector('.ao-bureau__stage')?.aoScene?.chars.size===7);
    await p.evaluate(async()=>{
      const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);
      const stream=services.stream,subscribe=stream.subscribe.bind(stream);
      window.saveProjectionProbe={hold:false,pending:null,deliver:null,resyncs:0};
      stream.subscribe=(topic,url,listener)=>subscribe(topic,url,value=>{
        const probe=window.saveProjectionProbe;
        if(topic==='office'&&probe.hold){probe.pending=value;probe.deliver=()=>listener(probe.pending);}
        else listener(value);
      });
      const resync=stream.resync.bind(stream);
      stream.resync=topic=>{if(topic==='office')window.saveProjectionProbe.resyncs++;return resync(topic);};
      services.router.navigate('/a-propos');
    });
    await p.locator('.ao-about').waitFor();
    await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.router.navigate('/bureau?etage=1');});
    await p.waitForFunction(()=>document.querySelector('.ao-bureau__stage')?.aoScene?.chars.size===7);
    const beforeResponse=await h.get(`/api/v${version}/views/office`);assert.equal(beforeResponse.status,200);
    const before=beforeResponse.json.data.occupants.find(o=>o.id==='subagent:worker-1');assert.equal(before.stationUid,'st-2');
    await p.evaluate(()=>{window.saveProjectionProbe.hold=true;});
    await p.locator('.ao-controls [data-page-control]').click();
    await p.locator('.ao-editbar').getByRole('button',{name:'Personnages',exact:true}).click();
    await p.locator('.ao-sc__pick select').selectOption(before.id);
    await p.locator('.ao-agentcard select').selectOption('st-3');
    const saved=p.waitForResponse(r=>r.request().method()==='PUT'&&/\/api\/v[23]\/office\/layout\?floorId=1/.test(r.url()));
    await p.locator('.ao-editbar').getByRole('button',{name:'Enregistrer',exact:true}).click();
    assert.equal((await saved).status(),200);
    await p.waitForFunction(()=>!document.querySelector('.ao-editbar')&&!document.querySelector('.ao-bureau__stage').aoScene.editing);
    const observed=await p.evaluate(id=>{const s=document.querySelector('.ao-bureau__stage').aoScene,c=s.chars.get(id);return {stationUid:c.occ.stationUid,ruleId:c.occ.ruleId,sceneTarget:c.occ.sceneTarget,pos:c.pos,resyncs:window.saveProjectionProbe.resyncs};},before.id);
    assert.equal(observed.stationUid,before.stationUid);assert.equal(observed.ruleId,before.ruleId);
    assert.deepEqual(observed.sceneTarget,before.sceneTarget);assert.deepEqual(observed.pos,before.sceneTarget.point);
    assert.ok(observed.resyncs>=1,'saved exit requests a fresh server OfficeVM');
    const afterResponse=await h.get(`/api/v${version}/views/office`);assert.equal(afterResponse.status,200);
    const after=afterResponse.json.data.occupants.find(o=>o.id===before.id);assert.equal(after.stationUid,'st-3');assert.notEqual(after.ruleId,before.ruleId);
    await p.waitForFunction(id=>window.saveProjectionProbe.pending?.data?.occupants.find(o=>o.id===id)?.stationUid==='st-3',before.id);
    await p.evaluate(()=>{const probe=window.saveProjectionProbe;probe.hold=false;probe.deliver();});
    await p.waitForFunction(id=>document.querySelector('.ao-bureau__stage').aoScene.chars.get(id)?.occ.stationUid==='st-3',before.id);
    const rendered=await p.evaluate(id=>{const c=document.querySelector('.ao-bureau__stage').aoScene.chars.get(id);return {stationUid:c.occ.stationUid,ruleId:c.occ.ruleId,sceneTarget:c.occ.sceneTarget,pos:c.pos};},before.id);
    assert.equal(rendered.stationUid,after.stationUid);assert.equal(rendered.ruleId,after.ruleId);
    assert.deepEqual(rendered.sceneTarget,after.sceneTarget);assert.deepEqual(rendered.pos,after.sceneTarget.point);
    await p.waitForFunction(()=>document.querySelector('.bu-live')?.textContent==='En direct'&&!document.querySelector('.ao-bureau__stagecap'));
    await p.waitForFunction(()=>[...document.querySelector('.ao-bureau__stage').querySelectorAll('img[src]')].every(i=>i.complete&&i.naturalWidth));
    await mkdir('design/reports/elevator-runtime',{recursive:true});
    await p.screenshot({path:`design/reports/elevator-runtime/v${version}-editor-saved-backend.png`,animations:'disabled'});
  }finally{await b?.close();await h?.close();}
});
