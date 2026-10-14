import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{settingsFixture}=require('../helpers/settings-fixture');
async function geometry(page){return page.locator('.ao-settings__tabs').evaluate(list=>{
 const active=list.querySelector('[aria-selected=true]'),row=list.getBoundingClientRect(),item=active.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(active);const text=range.getBoundingClientRect();
 return {active:active.id,mask:getComputedStyle(list).maskImage,start:list.dataset.overflowStart,end:list.dataset.overflowEnd,
  leftFragments:[...list.querySelectorAll('[role=tab]')].map(button=>{const r=document.createRange();r.selectNodeContents(button);const box=r.getBoundingClientRect();return {left:box.left-row.left,right:box.right-row.left};}).filter(box=>box.left<32-1&&box.right>24+1),
  left:item.left-row.left,right:item.right-row.left,textLeft:text.left-row.left,textRight:text.right-row.left,width:row.width,
  focused:document.activeElement.id,bodyHeight:document.scrollingElement.scrollHeight,height:innerHeight,bodyWidth:document.scrollingElement.scrollWidth,viewport:innerWidth};
 });}
async function check(page,width){
 await page.waitForTimeout(100);const g=await geometry(page);
 assert.equal(g.bodyHeight,g.height,'document never scrolls');assert.ok(g.bodyWidth<=g.viewport);assert.ok(g.left>=-1&&g.right<=g.width+1,'selected tab is whole');
 if(width===390){assert.notEqual(g.mask,'none');if(g.start==='true'){assert.ok(g.textLeft>=32-1,'selected label stays clear of left fade');assert.deepEqual(g.leftFragments,[],'no preceding partial word beyond the edge mask');}if(g.end==='true')assert.ok(g.textRight<=g.width-32+1,'selected label stays clear of right fade');}
 return g;
}
for(const width of [1440,390])for(const theme of ['light','dark'])test(`Settings whole selected tabs and edge fades ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{h=await settingsFixture({publicUrl,env:{AGENT_OFFICE_AGENT_PRESENCE_WINDOW_MS:String(45*60000)}});return h.base;}});
  const page=b.page,errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/parametres?onglet=instance',{waitUntil:'domcontentloaded'});await page.locator('#settings-office-title').waitFor();await page.evaluate(()=>document.fonts.ready);await check(page,width);
  await mkdir('design/reports/settings-tab-edges',{recursive:true});
  await page.locator('#settings-office-title').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:`design/reports/settings-tab-edges/${width}-${theme}-instance.png`,animations:'disabled'});
  const active=page.locator('[role=tab][aria-selected=true]');await active.focus();await page.keyboard.press('End');await page.waitForFunction(()=>{const tabs=[...document.querySelectorAll('.ao-settings__tabs [role=tab]')];return tabs.at(-1).getAttribute('aria-selected')==='true';});
  const last=await check(page,width);assert.equal(last.focused,last.active);await page.screenshot({path:`design/reports/settings-tab-edges/${width}-${theme}-last.png`,animations:'disabled'});
  await page.keyboard.press('Home');await page.locator('#settings-tab-diagnostic[aria-selected=true]').waitFor();const first=await check(page,width);assert.equal(first.focused,first.active);
  const count=await page.locator('.ao-settings__tabs [role=tab]').count();for(let i=1;i<count;i++){await page.keyboard.press('ArrowRight');await check(page,width);}
  for(let i=1;i<count;i++){await page.keyboard.press('ArrowLeft');await check(page,width);}
  await page.locator('#settings-tab-instance').click();await page.locator('#settings-tab-instance[aria-selected=true]').waitFor();await check(page,width);
  await page.evaluate(async()=>{const {buildQuery}=await import('/config.js');const {setLang}=await import('/i18n.js'+buildQuery);setLang('en');});await page.waitForTimeout(100);await check(page,width);
  if(width===390){await page.setViewportSize({width:1440,height:900});await check(page,1440);await page.setViewportSize({width:390,height:844});await check(page,390);
   // An intermediate pointer scroll retains the fade instead of exposing an abrupt one-letter edge.
   await page.locator('.ao-settings__tabs').evaluate(e=>{e.scrollLeft+=7;});await page.waitForTimeout(150);const g=await geometry(page);assert.equal(g.start,'true');assert.ok(g.mask.includes('24px')&&g.mask.includes('32px'));
  }
  assert.deepEqual(errors,[]);
 }finally{await b?.close();await h?.close();}
});
