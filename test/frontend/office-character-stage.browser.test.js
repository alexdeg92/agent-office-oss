import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');
const baseline=process.env.AO_CHARACTER_PREVIEW_BASELINE==='1';
for(const width of [1440,390])for(const theme of ['light','dark'])test(`Character stage follows the selected draft ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try {
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{
   h=await officeSceneFixture({publicUrl,occupantCount:12,namedAgents:true,primaryName:'Atlas'});
   h.viewEngine.runtimes=()=>[{id:'fixture',adapter:'openclaw',name:'OpenClaw',enabled:true,connection:'connected',capabilities:{}}];
   h.api.topics.invalidate();return h.base;
  }});
  const {page}=b,errors=[];page.on('pageerror',error=>errors.push(error.message));
  const height=width===390?844:900;await page.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/bureau',{waitUntil:'domcontentloaded'});
  await page.locator('.ao-controls [data-page-control]').waitFor({state:'attached'});
  if(width===390){await page.locator('.ao-mobile-options').click();await page.getByRole('dialog').getByRole('button',{name:'Personnaliser',exact:true}).click();}
  else await page.locator('.ao-controls [data-page-control]').click();
  await page.locator('.ao-editbar').waitFor();if(width===390&&!baseline)await page.locator('.ao-editbar__modepick select').selectOption('characters');else await page.getByRole('button',{name:'Personnages',exact:true}).click();
  const stage=page.locator('.ao-bureau__stage'),panel=page.locator('.ao-editpanel[data-mode="characters"]'),preview=stage.locator('.ao-stage-character'),footer=panel.locator('.ao-characters__actions');
  await page.waitForFunction(()=>document.querySelectorAll('.ao-character-row').length===12);
  await page.evaluate(()=>document.fonts.ready);
  const mapBounds=await stage.boundingBox();await stage.evaluate(el=>{window.__characterScene=el.aoScene;});
  await mkdir('design/reports/character-stage-143',{recursive:true});
  const capture=async state=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`design/reports/character-stage-143/${width}-${theme}-${state}.png`,animations:'disabled'});};
  const frame=async()=>{assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,height]);assert.deepEqual(await stage.boundingBox(),mapBounds);assert.ok((await footer.boundingBox()).y+(await footer.boundingBox()).height<=height);assert.equal(await stage.evaluate(el=>el.aoScene===window.__characterScene),true,'the map scene is retained');};
  if(!baseline){assert.equal(await preview.count(),0);await capture('list');}
  await panel.locator('.ao-character-row').first().click();await panel.locator('.ao-agentcard .ao-sc--external').waitFor();
  const painted=async()=>page.waitForFunction(()=>[...document.querySelectorAll('.ao-stage-character img')].length>0&&[...document.querySelectorAll('.ao-stage-character img')].every(image=>image.complete&&image.naturalWidth>0));
  // Every visible choice has a decoded, non-zero framed image, including lazy families.
  await page.waitForFunction(()=>{const region=document.querySelector('.ao-characters__detail').getBoundingClientRect();const cards=[...document.querySelectorAll('.ao-sc__card')].filter(card=>{const box=card.getBoundingClientRect();return box.top>=region.top&&box.bottom<=region.bottom;});return cards.length>=2&&cards.every(card=>{const image=card.querySelector('img'),box=image?.getBoundingClientRect();return image?.complete&&image.naturalWidth>0&&box.width>=28&&box.height>=40;});});
  if(baseline){await capture('before');const button=page.getByRole('button',{name:'Disposition',exact:true});console.log('main mode baseline '+JSON.stringify({width,theme,layoutEnabled:await button.isEnabled(),modeSelect:await page.locator('.ao-editbar__modepick select').count()}));if(width===390){assert.equal(await button.isEnabled(),false,'main blocks Layout on the phone');await capture('before-layout-blocked');}else{await button.click();await page.locator('.ao-editpanel[data-mode=layout]').waitFor();assert.equal(await page.locator('.ao-editpanel .ao-characters').count(),0);await capture('before-layout');}return;}
  await preview.waitFor();await painted();await frame();
  await page.waitForFunction(()=>{const thumbs=[...document.querySelectorAll('.ao-sc-gear')];return thumbs.length===15&&thumbs.every(thumb=>thumb.dataset.thumbnailReady==='true');});
  assert.equal(await panel.locator('.ao-sc__acc--visual').evaluateAll(buttons=>buttons.every(button=>button.getAttribute('aria-label')&&button.title===button.getAttribute('aria-label')&&!button.textContent.trim()&&button.querySelector('img')?.naturalWidth>0)),true,'accessory controls render only registered item images and retain accessible names');
  assert.equal(await panel.locator('.ao-sc__swatch .ao-sc__dot').evaluateAll(dots=>dots.every(dot=>getComputedStyle(dot).backgroundColor!=='rgba(0, 0, 0, 0)')),true,'colours retain painted swatches');
  assert.equal(await stage.locator('.ao-viewport').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  assert.equal(await stage.locator('.ao-controls').evaluate(el=>el.inert),true,'hidden map controls leave keyboard navigation');
  const figure=preview.locator('[role=img]');assert.ok((await figure.boundingBox()).height>=mapBounds.height*.75,'selected figure uses the stage height');
  await capture('selected');
  const change=async(field,value)=>{await page.waitForFunction(({field,value})=>document.querySelector('.ao-stage-character')?.dataset[field]===value,{field,value});await painted();};
  const choices=panel.locator('.ao-sc__cards'),cosmo=choices.locator('input[value="cosmo"]');await cosmo.check({force:true});await change('character','cosmo');
  const idleSources=await preview.locator('img').evaluateAll(images=>images.map(image=>image.src));
  await panel.locator('.ao-sc__swatches input[value="sage"]').check({force:true});await change('variant','sage');assert.notDeepEqual(await preview.locator('img').evaluateAll(images=>images.map(image=>image.src)),idleSources,'colour changes the registered source');
  await panel.getByRole('button',{name:'Bonnet',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ao-stage-character')?.dataset.accessories.split(',').includes('beanie'));await page.waitForFunction(()=>{const images=[...document.querySelectorAll('.ao-stage-character img')];return images.length>1&&images.every(image=>image.complete&&image.naturalWidth>0);});assert.ok(await preview.locator('img').count()>1,'accessory layers appear on the full-size figure');
  await panel.locator('.ao-sc__pose select').selectOption('celebrating');await change('pose','celebrating');await frame();await capture('changed');
  await panel.locator('.ao-sc__acc--visual').first().scrollIntoViewIfNeeded();await capture('accessories');
  const selectedSources=await preview.locator('img').evaluateAll(images=>images.map(image=>image.src));
  await panel.getByRole('button',{name:'Retour à la liste',exact:true}).click();await preview.waitFor({state:'hidden'});assert.equal(await stage.locator('.ao-viewport').evaluate(el=>getComputedStyle(el).visibility),'visible');assert.equal(await stage.locator('.ao-controls').evaluate(el=>el.inert),false);await frame();
  await panel.locator('.ao-character-row').first().click();await painted();assert.deepEqual(await preview.locator('img').evaluateAll(images=>images.map(image=>image.src)),selectedSources,'returning to detail retains the same draft and pose');
  if(width===390)await page.locator('.ao-editbar__modepick select').selectOption('theme');else await page.getByRole('button',{name:'Thème',exact:true}).click();await preview.waitFor({state:'hidden'});assert.equal(await stage.locator('.ao-viewport').evaluate(el=>getComputedStyle(el).visibility),'visible');
  {if(width===390)await page.locator('.ao-editbar__modepick select').selectOption('layout');else await page.getByRole('button',{name:'Disposition',exact:true}).click();await page.locator('.ao-editpanel[data-mode=layout]').waitFor();assert.equal(await preview.count(),0,'Layout restores the map instead of the selected character');assert.equal(await page.locator('.ao-editpanel .ao-characters').count(),0,'Layout renders furniture controls only');assert.equal(await stage.locator('.ao-viewport').evaluate(el=>getComputedStyle(el).visibility),'visible');assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,height]);await capture('layout');}
  if(width===390&&!baseline)await page.locator('.ao-editbar__modepick select').selectOption('characters');else await page.getByRole('button',{name:'Personnages',exact:true}).click();await painted();
  await footer.getByRole('button',{name:'Enregistrer',exact:true}).click();await panel.waitFor({state:'hidden'});
  assert.equal(await stage.locator('.ao-viewport').evaluate(el=>getComputedStyle(el).visibility),'visible');assert.equal(await stage.locator('.ao-controls').evaluate(el=>el.inert),false);
  const saved=await h.get('/api/v3/office/layout');assert.equal(saved.status,200,saved.text);assert.ok(saved.json.data.layout.data.agents.some(agent=>agent.character==='cosmo'&&agent.variant==='sage'&&agent.accessories?.includes('beanie')),'existing layout API persists the edited look');
  if(width===390&&theme==='dark') {
    await page.route('**/beanie-thumb.webp', route=>route.fulfill({status:404,contentType:'image/webp',body:''}));
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('.ao-mobile-options').click();await page.getByRole('dialog').getByRole('button',{name:'Personnaliser',exact:true}).click();
    await page.locator('.ao-editbar__modepick select').selectOption('characters');await page.locator('.ao-character-row').first().click();
    const tile=page.getByRole('button',{name:'Bonnet',exact:true}),failed=tile.locator('[data-thumbnail-error=true]');
    await failed.waitFor();assert.equal(await failed.textContent(),'Bonnet');assert.equal(await tile.locator('.bu-compact-progress,img').count(),0,'completed404 leaves a named terminal fallback and no spinner');
    await tile.click();assert.equal(await tile.getAttribute('aria-pressed'),'false');await tile.click();assert.equal(await tile.getAttribute('aria-pressed'),'true','failed thumbnail choice remains selectable');
    assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight]),[width,height]);await capture('thumbnail-fallback');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
 } finally {await b?.close();await h?.close();}
});
