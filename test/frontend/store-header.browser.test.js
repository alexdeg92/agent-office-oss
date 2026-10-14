import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');

for(const width of [1440,390])for(const theme of ['light','dark'])test(`Store server controls and fixed frame ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{
   h=await officeSceneFixture({publicUrl,occupantCount:12,namedAgents:true,primaryName:'Atlas'});
   h.viewEngine.runtimes=()=>[{id:'fixture',adapter:'openclaw',name:'OpenClaw',enabled:true,connection:'connected',capabilities:{}}];
   const floor=await h.get('/api/v3/office/layout?floorId=2');assert.equal(floor.status,200,floor.text);
   const saved=await h.put('/api/v3/office/layout?floorId=2',{expectedRevision:floor.json.data.layout.revision,data:floor.json.data.layout.data});assert.equal(saved.status,200,saved.text);
   h.api.topics.invalidate();return h.base;
  }});
  const {page}=b,errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/boutique',{waitUntil:'domcontentloaded'});
  const ready=selected=>page.waitForFunction(selected=>{const input=document.querySelector('#ao-shop-section');return input&&!input.hasAttribute('aria-busy')&&(!selected||input.value===selected);},selected);
  await ready();await page.evaluate(()=>document.fonts.ready);
  const section=page.locator('#ao-shop-section'),category=page.locator('#ao-shop-category'),floor=page.locator('#ao-shop-floor');
  const compare=async({sectionId='mobilier',categoryId='',floorId='1'}={})=>{
   await ready(sectionId);
   const query=new URLSearchParams({section:sectionId,category:categoryId,floorId});
   const response=await h.get('/api/v3/views/office/store?'+query);assert.equal(response.status,200,response.text);
   await page.waitForFunction(({sectionId,categoryId,floorId})=>document.querySelector('#ao-shop-section')?.value===sectionId&&(document.querySelector('#ao-shop-category')?.value ?? null)===categoryId&&document.querySelector('.ao-shop')?.dataset.floorContext===floorId,response.json.data);
   assert.deepEqual(await section.locator('option').evaluateAll(options=>options.map(option=>option.value)),response.json.data.sections.options.map(option=>option.id));
   assert.equal(await section.inputValue(),response.json.data.sectionId);
   assert.deepEqual(await page.locator('[data-store-item]').evaluateAll(items=>items.map(item=>item.dataset.storeItem)),response.json.data.itemIds);
   assert.equal(await floor.count(),response.json.data.floors ? 1 : 0);
   if(response.json.data.floors){assert.equal(await floor.inputValue(),response.json.data.floorId);assert.deepEqual(await floor.locator('option').evaluateAll(options=>options.map(option=>option.value)),response.json.data.floors.options.map(option=>option.id));}
   assert.equal(await category.count(),response.json.data.categories ? 1 : 0);
   if(response.json.data.categories)assert.deepEqual(await category.locator('option').evaluateAll(options=>options.map(option=>option.value)),response.json.data.categories.options.map(option=>option.id));
  };
  await compare();assert.equal(await page.locator('.ao-shop__tabs,[role=tablist]').count(),0);
  if(width===1440&&theme==='light') {
   let release,held=false,holdNext=true;
   const released=new Promise(resolve=>{release=resolve;});
   await page.route(/\/views\/office\/store\?/,async route=>{if(holdNext){holdNext=false;held=true;await released;}await route.continue();});
   try {
    h.advance(1000,Array.from({length:12},(_,i)=>i<2?'idle':'working'));
    for(let i=0;!held&&i<100;i++)await page.waitForTimeout(20);
    assert.ok(held,'Office refresh reaches the Store navigation GET');
    assert.equal(await section.getAttribute('aria-busy'),null,'background refresh cannot block an input change');
    await section.selectOption('decoration');await compare({sectionId:'decoration'});
    release();await page.waitForTimeout(100);
    assert.equal(await section.inputValue(),'decoration','stale background response cannot overwrite the selected section');
   } finally {release();await page.unroute(/\/views\/office\/store\?/);}
   await section.selectOption('mobilier');await compare();
  }

  const frame=async()=>{
   assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,width===390?844:900]);
   const a=await section.boundingBox(),c=await category.boundingBox();
   if(c){assert.ok(Math.abs(a.y-c.y)<1);assert.ok(c.x>=a.x+a.width+7);assert.ok(c.x+c.width<=width);}
   if(await floor.count()) {
    const f=await floor.boundingBox();
    if(width===1440){assert.ok(Math.abs(a.y-f.y)<1,'desktop floor, section and category share one row');assert.ok(a.x>=f.x+f.width+7);}
    else assert.ok(f.y+f.height<=a.y,'phone retains floor row above section/category');
   }
   const end=await page.locator('.ao-shop__savebar').boundingBox();assert.ok(end.y+end.height<=(width===390?844:900));
  };
  await frame();
  await mkdir('design/reports/store-header-142',{recursive:true});
  const capture=async state=>{await page.locator('.ao-shop__grid img').first().waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('.ao-shop__grid img')?.naturalWidth>0);await page.screenshot({path:`design/reports/store-header-142/${width}-${theme}-${state}.png`,animations:'disabled'});};
  await capture('mobilier');
  const catalog=page.locator('.ao-shop__catalog > .ao-frame__body'),fixedBefore=await page.locator('.ao-shop__header,.ao-shop__navigation,.ao-shop__savebar,.bu-topbar,.bu-mtopbar,.bu-bottombar').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
  assert.ok(await catalog.evaluate(el=>el.scrollHeight>el.clientHeight));
  await catalog.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  const last=await page.locator('[data-store-item]').last().boundingBox(),body=await catalog.boundingBox();assert.ok(last.y+last.height<=body.y+body.height+1);
  assert.deepEqual(await page.locator('.ao-shop__header,.ao-shop__navigation,.ao-shop__savebar,.bu-topbar,.bu-mtopbar,.bu-bottombar').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON())),fixedBefore);
  await catalog.evaluate(el=>{el.scrollTop=0;});
  await category.selectOption('rangement');await compare({categoryId:'rangement'});await frame();
  await category.selectOption('');await compare();
  // A floor switch uses the existing dirty guard; declining restores the native Select.
  await section.selectOption('themes');await ready('themes');await page.locator('[data-theme-mode="night"]').click();
  await page.locator('.ao-shop__savebar.is-dirty').waitFor();await section.selectOption('mobilier');await ready('mobilier');
  await floor.selectOption('2');const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'Rester',exact:true}).click();
  assert.equal(await floor.inputValue(),'1');assert.equal(await page.locator('.ao-shop').getAttribute('data-floor-context'),'1');
  await floor.selectOption('2');await dialog.waitFor();await dialog.getByRole('button',{name:'Quitter',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ao-shop')?.dataset.floorContext==='2');await compare({floorId:'2'});await frame();
  await section.selectOption('decoration');await compare({sectionId:'decoration',floorId:'2'});await frame();await capture('decoration-floor-2');
  await section.selectOption('accessoires');await compare({sectionId:'accessoires',floorId:'2'});await frame();
  await category.selectOption('neck');await compare({sectionId:'accessoires',categoryId:'neck',floorId:'2'});await capture('accessoires');
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES || []),[]);
 }finally{await b?.close();await h?.close();}
});
