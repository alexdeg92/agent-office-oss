import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs');
const result='**Vérifications terminées**\n\n| Contrôle | Résultat détaillé |\n| --- | --- |\n'+Array.from({length:24},(_,i)=>`| Étape ${i+1} | Contrôle complet du parcours sur téléphone et ordinateur, sans publication ni donnée privée |`).join('\n');
for(const theme of ['light','dark'])test(`touch swipe from a Chat table scrolls the conversation 390 ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h,cdp;
 try {
  b=await openLayoutBrowser({theme,touch:true,apiVersion:3,apiProxy:async publicUrl=>{h=await chatV3UiFixture({publicUrl,historyCount:0,resultText:result});return h.base;}});
  const {page}=b,errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:390,height:844});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(b.origin+'/discuter',{waitUntil:'domcontentloaded'});
  await page.locator(`[data-chat-agent="${h.targetId}"]`).click();await page.locator(`[data-chat-session="${h.sessionId}"]`).click();
  const card=page.locator('.ao-chat__result-card').first();await card.waitFor();await card.locator('summary').click();
  const table=card.locator('.ao-md__table-scroll'),thread=page.locator('.bu-chat__thread');await table.waitFor();await table.scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await table.locator('tbody tr').count(),24);assert.ok(await table.evaluate(el=>el.scrollWidth>el.clientWidth));
  await mkdir('design/reports/chat-workspace-173',{recursive:true});
  const capture=async state=>page.screenshot({path:`design/reports/chat-workspace-173/390-${theme}-touch-${state}.png`,animations:'disabled'});
  await capture('before');
  const point=async()=>{
   const a=await table.boundingBox(),c=await thread.boundingBox();
   const x=Math.max(c.x+30,Math.min(a.x+100,c.x+c.width-30)),y=Math.min(a.y+a.height-30,c.y+c.height-30);
   assert.ok(y>c.y+170,'visible table cell has room for the native swipe');
   assert.equal(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('.ao-md__table'),{x,y}),true,'gesture starts on a table cell');return {x,y};
  };
  cdp=await page.context().newCDPSession(page);
  const swipe=async(dx,dy)=>{
   const {x,y}=await point();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1,radiusX:2,radiusY:2,force:1}]});
   for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/12,y:y+dy*i/12,id:1,radiusX:2,radiusY:2,force:1}]});await page.waitForTimeout(20);}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const before=await thread.evaluate(el=>el.scrollTop);await swipe(0,-140);
  await page.waitForFunction(before=>document.querySelector('.bu-chat__thread').scrollTop>before+60,before,{timeout:3000});
  const after=await thread.evaluate(el=>el.scrollTop);
  assert.equal(await table.evaluate(el=>el.scrollTop),0,'table has no vertical scroll of its own');
  assert.equal(await table.evaluate(el=>el.scrollHeight-el.clientHeight),0,'no nested vertical overflow');
  assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[390,844,0]);
  const fixed=await page.locator('.bu-mtopbar,.bu-bottombar,.ao-chat__composer').evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().toJSON()));
  await capture('vertical');
  await table.evaluate(el=>{el.scrollLeft=0;});await swipe(-90,0);
  await page.waitForFunction(()=>document.querySelector('.ao-md__table-scroll').scrollLeft>20,null,{timeout:3000});
  assert.deepEqual(await page.locator('.bu-mtopbar,.bu-bottombar,.ao-chat__composer').evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().toJSON())),fixed,'horizontal table touch keeps the shell/composer fixed');
  const style=await table.evaluate(el=>({touchAction:getComputedStyle(el).touchAction,overscrollY:getComputedStyle(el).overscrollBehaviorY,overscrollX:getComputedStyle(el).overscrollBehaviorX,scrollLeft:el.scrollLeft}));
  assert.equal(style.overscrollY,'auto');assert.equal(style.overscrollX,'contain');
  assert.ok(style.touchAction.includes('pan-y'));await capture('horizontal');
  await writeFile(`design/reports/chat-workspace-173/390-${theme}-touch-gesture.json`,JSON.stringify({before,after,delta:after-before,style},null,2)+'\n');
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
 }finally{await cdp?.detach();await b?.close();await h?.close();}
});
