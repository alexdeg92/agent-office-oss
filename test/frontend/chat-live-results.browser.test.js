import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{chatResultsFixture,readChat}=require('../helpers/chat-results-fixture');
for(const completedChildren of [false,true])for(const width of [1440,390])for(const theme of ['light','dark'])test(`mounted Chat results and portraits ${width} ${theme} v${width===1440?3:2}${completedChildren?' completed children':''}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  const version=width===1440?3:2;
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:version,apiProxy:async publicUrl=>{h=await chatResultsFixture(publicUrl,{completedChildren});return h.base;}});
  const {page}=b,errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const vm=await readChat(h,version),results=vm.messages.filter(m=>m.kind==='subagent-result');assert.equal(results.length,2);
  await page.goto(b.origin+'/discuter',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelectorAll('.ao-chat__result-card').length===2);
  await page.waitForFunction(()=>document.querySelectorAll('.ao-chat__messages [data-avatar-ready="true"]').length===3);
  await page.evaluate(()=>document.fonts.ready);
  const cards=page.locator('.ao-chat__result-card');assert.equal(await cards.evaluateAll(els=>els.every(el=>!el.open)),true);
  assert.equal(await page.locator('.ao-chat__messages .bu-msg--user').count(),1,'only the genuine operator request is a human bubble');
  assert.equal(await page.locator('.ao-chat__messages .bu-msg--agent').count(),3,'lead and both child results remain on the agent side');
  const names=await page.locator('.ao-chat__messages .bu-msg--agent .bu-msg__who').allTextContents();assert.deepEqual(names.slice(1),h.authors);
  for(let i=0;i<results.length;i++){const summary=await cards.nth(i).locator('summary').innerText();assert.ok(summary.includes(results[i].title));assert.ok(summary.includes(i===0?'Terminé':'Échec'));}
  assert.ok(!(await page.locator('.ao-chat__messages').innerText()).includes('[Subagent Context]'));
  const office=await h.get(`/api/v${version}/views/office`);assert.equal(office.status,200,office.text);
  for(let i=0;i<results.length;i++){
   const result=results[i],occupant=office.json.data.occupants.find(o=>o.sessionKey===result.senderInfo.delegation.sessionKey);
   if(completedChildren){assert.equal(occupant,undefined,'completed child is outside Office presence');assert.deepEqual(result.avatar,h.expectedLooks[i],'stored child portrait wins even outside Office');}
   else {assert.ok(occupant);assert.deepEqual(result.avatar,occupant.look);}
  }
  const visible=await page.locator('.ao-chat__messages [data-avatar-ready="true"] img').evaluateAll(els=>els.every(el=>el.naturalWidth>0&&getComputedStyle(el).visibility==='visible'));assert.equal(visible,true);
  assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('design/reports/chat-live-results',{recursive:true});
  await page.locator('.ao-chat__messages > li').first().scrollIntoViewIfNeeded();
  await page.screenshot({path:`design/reports/chat-live-results/${width}-${theme}${completedChildren?'-completed':''}-collapsed.png`,animations:'disabled'});
  await cards.nth(0).locator('summary').click();assert.equal(await cards.nth(0).evaluate(el=>el.open),true);assert.equal(await cards.nth(1).evaluate(el=>el.open),false);
  const table=cards.nth(0).locator('.ao-md__table-scroll');await table.scrollIntoViewIfNeeded();assert.equal(await table.locator('th').count(),2);assert.equal(await table.locator('tbody tr').count(),2);
  assert.equal(await cards.nth(0).locator('strong').innerText(),'Vérifications terminées');
  if(width===390){
   assert.ok(await table.evaluate(el=>el.scrollWidth>el.clientWidth));
   const rail=cards.nth(0).locator('.ao-md__table-rail'),thumb=rail.locator('.ao-md__table-thumb');
   await rail.waitFor();assert.ok((await rail.boundingBox()).height>=4,'persistent thin overflow rail');
   assert.equal(await table.evaluate(el=>getComputedStyle(el).scrollbarWidth),'thin');
   assert.ok(await table.evaluate(el=>getComputedStyle(el).maskImage!=='none'),'unseen right edge fades');
   await table.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(120);assert.ok(await table.evaluate(el=>el.scrollLeft>0));
   await table.evaluate(el=>{el.scrollLeft=0;});await page.locator('#chat-texte').focus();
   await page.waitForFunction(()=>document.querySelector('.ao-md__table-thumb')?.style.left==='0%');
   assert.equal(await thumb.evaluate(el=>el.style.left),'0%');
  }
  assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`design/reports/chat-live-results/${width}-${theme}${completedChildren?'-completed':''}-expanded.png`,animations:'disabled'});
  if(width===390){
   await table.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
   await page.waitForFunction(()=>Number.parseFloat(document.querySelector('.ao-md__table-thumb')?.style.left)>0);
   const mask=await table.evaluate(el=>getComputedStyle(el).maskImage);assert.notEqual(mask,'none','unseen left edge fades');
   assert.equal(await table.evaluate(el=>el.scrollWidth-el.clientWidth-el.scrollLeft<=1),true);
   await page.screenshot({path:`design/reports/chat-live-results/${width}-${theme}${completedChildren?'-completed':''}-scrolled.png`,animations:'disabled'});
  }
  // The real mounted stream must remain healthy; no interception aborts or synthetic VM patches.
  const status=await page.locator(width===390?'.bu-mtopbar':'.bu-topbar').innerText();assert.ok(status.includes('En direct'),status);assert.ok(!status.includes('Reconnexion'),status);
  assert.deepEqual(errors,[]);
 }finally{await b?.close();await h?.stop();}
});
