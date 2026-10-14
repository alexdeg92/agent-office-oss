import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {startServer}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');

// The existing frontend + real mounted API against synthetic fixtures. Browser
// interception forwards only same-origin backend requests with the harness's
// test session. There is no custom server or client-side room projection.
for(const floor of ['rdc','gym'])for(const width of [1440,390])
test(`authoritative ${floor} editor open/save/reload preserves furniture at ${width}`,{skip:browserSkipReason(),timeout:60000},async()=>{
  const api=await startServer(loadScenario('synthetic-basic'));
  let h;
  try{
    h=await openLayoutBrowser({touch:width===390});const p=h.page;
    await p.setViewportSize({width,height:width===390?844:900});
    const writes=[];
    await p.route('**/backend/**',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname.replace(/^\/backend/,'')+url.search;
      if(url.pathname==='/backend/api/v2/stream')return route.abort();
      const body=request.postData()?JSON.parse(request.postData()):undefined;
      if(request.method()==='PUT'&&url.pathname==='/backend/api/v2/office/layout')writes.push({path,body});
      const response=await api.request(request.method(),path,body);
      return route.fulfill({status:response.status,contentType:'application/json',body:response.text});
    });
    const read=async id=>{const r=await api.get('/api/v2/office/layout'+(id?'?floorId='+id:''));assert.equal(r.status,200);return r.json.data;};
    const before=await read(floor),root=await read(),other=await read(floor==='rdc'?'gym':'rdc');
    assert.equal(before.allowNoDesk,true);
    // The UI disables an unchanged Save. Exercise an accepted unchanged draft
    // at its actual endpoint, then exercise a normal theme edit through the UI.
    const noop=await api.request('PUT','/api/v2/office/layout?floorId='+floor,{expectedRevision:before.layout.revision,data:before.layout.data});
    assert.equal(noop.status,200);
    assert.deepEqual((await read(floor)).layout.data,before.layout.data);
    await p.goto(`${h.origin}/bureau?etage=${floor}`,{waitUntil:'domcontentloaded'});
    await p.locator('.ao-bureau__stage').waitFor();
    const scene=()=>p.evaluate(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s&&{room:s.layout.room,items:s.layout.items};});
    await p.waitForFunction(()=>!!document.querySelector('.ao-bureau__stage')?.aoScene);
    assert.deepEqual(await scene(),{room:before.layout.data.room,items:before.layout.data.items});
    if(width===390)await p.locator('.ao-mobile-options').click();
    await p.getByRole('button',{name:'Personnaliser',exact:true}).click();
    await mkdir('design/reports/rooms-102',{recursive:true});
    if(width===1440){
      const bar=p.locator('.ao-editbar');await bar.waitFor();
      assert.deepEqual(await scene(),{room:before.layout.data.room,items:before.layout.data.items},'opening the editor preserves the server room');
      await p.screenshot({path:`design/reports/rooms-102/editor-open-${floor}-${width}.png`,animations:'disabled'});
      await bar.getByRole('button',{name:'Thème',exact:true}).click();
      await p.locator('.ao-editpanel section[aria-labelledby="ao-theme-title"] .bu-segmented__opt').nth(2).click();
      const save=bar.getByRole('button',{name:'Enregistrer',exact:true});assert.equal(await save.isEnabled(),true);
      await save.click();await bar.waitFor({state:'detached'});
    }else{
      await p.locator('.ao-shop__savebar').waitFor();
      assert.equal(new URL(p.url()).searchParams.get('etage'),floor);
      await p.locator('#ao-shop-section').selectOption('themes');
      await p.locator('[data-theme-mode="night"]').click();
      await p.screenshot({path:`design/reports/rooms-102/editor-open-${floor}-${width}.png`,animations:'disabled'});
      const save=p.locator('.ao-shop__savebar').getByRole('button',{name:/Enregistrer/});assert.equal(await save.isEnabled(),true);
      await save.click();await p.waitForFunction(()=>!document.querySelector('.ao-shop__savebar')?.classList.contains('is-dirty'));
    }
    assert.equal(writes.length,1,'a real scoped UI write was accepted');
    assert.equal(new URL(writes[0].path,'http://fixture.invalid').searchParams.get('floorId'),floor);
    assert.deepEqual(writes[0].body.data.items,before.layout.data.items,'only the requested theme changes');
    const saved=await read(floor);
    assert.deepEqual(saved.layout.data.items,before.layout.data.items);
    assert.equal(saved.layout.data.room,before.layout.data.room);
    assert.equal(saved.layout.data.theme.fixed,'night');
    assert.deepEqual((await read(floor==='rdc'?'gym':'rdc')).layout.data,other.layout.data);
    const afterRoot=await read();assert.deepEqual(afterRoot.layout.data.items,root.layout.data.items);assert.deepEqual(afterRoot.layout.data.agents,root.layout.data.agents);
    await p.goto(`${h.origin}/bureau?etage=${floor}`,{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>!!document.querySelector('.ao-bureau__stage')?.aoScene);
    assert.deepEqual(await scene(),{room:before.layout.data.room,items:before.layout.data.items},'fresh navigation reads the persisted full room');
    await p.waitForFunction(()=>{const s=document.querySelector('.ao-bureau__stage')?.aoScene;return s?.theme.id==='night'&&[...s.stage.querySelectorAll('img[src]')].filter(i=>i.getAttribute('src')).every(i=>i.complete&&i.naturalWidth);});
    await mkdir('design/reports/rooms-102',{recursive:true});
    await p.screenshot({path:`design/reports/rooms-102/editor-saved-${floor}-${width}.png`,animations:'disabled'});
  }finally{await h?.close();await api.stop();}
});

for(const width of [1440,390])
test(`Boutique floor switch isolates draft/history/save and guards pending edits at ${width}`,{skip:browserSkipReason(),timeout:60000},async()=>{
  const api=await startServer(loadScenario('synthetic-basic'));
  let h,releaseWrite;
  try{
    h=await openLayoutBrowser({touch:width===390});const p=h.page;
    await p.setViewportSize({width,height:width===390?844:900});
    const writes=[];
    await p.route('**/backend/**',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname.replace(/^\/backend/,'')+url.search;
      if(url.pathname==='/backend/api/v2/stream')return route.abort();
      const body=request.postData()?JSON.parse(request.postData()):undefined;
      if(request.method()==='PUT'&&url.pathname==='/backend/api/v2/office/layout'){
        writes.push({path,body});
        await new Promise(resolve=>{releaseWrite=resolve;});
      }
      const response=await api.request(request.method(),path,body);
      return route.fulfill({status:response.status,contentType:'application/json',body:response.text});
    });
    const read=async id=>(await api.get('/api/v2/office/layout'+(id?'?floorId='+id:''))).json.data;
    const lobby=await read('rdc'),gym=await read('gym'),root=await read();
    assert.equal(lobby.layout.revision,gym.layout.revision,'same revision must not hide a scope change');
    const navigate=async floor=>p.evaluate(async id=>{
      const app=new URL(document.querySelector('script[type="module"][src]').src);
      const {services}=await import(new URL('./services.js'+app.search,app).href);
      void services.router.navigate(services.router.href('boutique')+'?onglet=themes&etage='+id);
    },floor);
    const waitFloor=async floor=>{
      await p.locator(`[data-floor-context="${floor}"]`).waitFor();
      await p.locator('[data-theme-mode="night"]').waitFor();
    };
    const save=p.locator('.ao-shop__savebar').getByRole('button',{name:/Enregistrer/});
    const clean=()=>p.waitForFunction(()=>!!document.querySelector('.ao-shop__savebar')&&!document.querySelector('.ao-shop__savebar').classList.contains('is-dirty'));
    await p.goto(`${h.origin}/boutique?onglet=themes&etage=rdc`,{waitUntil:'domcontentloaded'});
    await waitFloor('rdc');await clean();
    await navigate('gym');await waitFloor('gym');await clean();
    assert.equal(await save.isEnabled(),false);
    await navigate('rdc');await waitFloor('rdc');
    await p.locator('[data-theme-mode="night"]').click();assert.equal(await save.isEnabled(),true);
    await navigate('gym');const dialog=p.getByRole('dialog');await dialog.waitFor();
    await dialog.getByRole('button',{name:'Rester',exact:true}).click();
    assert.equal(new URL(p.url()).searchParams.get('etage'),'rdc');
    assert.equal(await save.isEnabled(),true,'staying retains the unsaved lobby draft');
    assert.equal(writes.length,0);
    await navigate('gym');await dialog.waitFor();
    await mkdir('design/reports/rooms-102',{recursive:true});
    await p.screenshot({path:`design/reports/rooms-102/editor-switch-confirm-${width}.png`,animations:'disabled'});
    await dialog.getByRole('button',{name:'Quitter',exact:true}).click();
    await waitFloor('gym');await clean();
    assert.equal(await save.isEnabled(),false,'discarded history cannot dirty the new floor');
    assert.equal(await p.locator('.ao-shop__savebar button').first().isEnabled(),false,'new floor has no undo history');
    await p.locator('[data-theme-mode="night"]').click();await save.click();
    await p.waitForFunction(()=>!!document.querySelector('.ao-shop__savebar button[aria-busy="true"]'));
    assert.equal(writes.length,1);
    await navigate('rdc');
    assert.equal(new URL(p.url()).searchParams.get('etage'),'gym','an in-flight save blocks scope changes');
    assert.equal(await dialog.count(),0);
    releaseWrite();releaseWrite=null;await clean();
    assert.equal(new URL(writes[0].path,'http://fixture.invalid').searchParams.get('floorId'),'gym');
    assert.deepEqual(writes[0].body.data.items,gym.layout.data.items);
    assert.deepEqual((await read('rdc')).layout.data,lobby.layout.data,'lobby was never written');
    const saved=await read('gym');assert.equal(saved.layout.data.theme.fixed,'night');
    assert.deepEqual(saved.layout.data.items,gym.layout.data.items);
    const afterRoot=await read();assert.deepEqual(afterRoot.layout.data.items,root.layout.data.items);assert.deepEqual(afterRoot.layout.data.agents,root.layout.data.agents);
    await p.screenshot({path:`design/reports/rooms-102/editor-switch-saved-${width}.png`,animations:'disabled'});
  }finally{releaseWrite?.();await h?.close();await api.stop();}
});
