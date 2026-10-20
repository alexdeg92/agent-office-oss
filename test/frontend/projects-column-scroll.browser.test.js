import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
for(const width of [1440,768,390,360])for(const theme of ['light','dark'])test(`Projects bounded card scrolling ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width<600,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  const p=b.page,height=width<600?844:900;await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  for(const status of ['idea','in-review'])for(let n=0;n<12;n++){const r=await h.post('/api/v3/projects',{name:`Vérification ${status} ${n+1}`,status,priority:'P2'});assert.equal(r.status,200,r.text);}
  await p.goto(b.origin+'/projets'+(width<600?'?etape=in-review':''),{waitUntil:'domcontentloaded'});
  const list=p.locator(width<600?'.ao-projects-server__board':'[data-column="in-review"] .bu-column__list');await list.waitFor();
  await p.locator('[data-column="in-review"] [data-card]').last().waitFor({state:'attached'});
  await p.evaluate(()=>document.fonts.ready);
  const selectors='.bu-topbar,.bu-mtopbar,.bu-bottombar,.ao-projects > .ao-frame__head,.ao-projects > .ao-frame__bar';
  const state=()=>p.evaluate(selectors=>({document:[scrollX,scrollY,document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],fixed:[...document.querySelectorAll(selectors)].map(el=>el.getBoundingClientRect().toJSON()).filter(r=>r.height)}),selectors);
  const before=await state();assert.deepEqual(before.document,[0,0,width,height]);
  assert.equal(await p.locator('[data-column="in-review"] [data-card]').count(),12);
  assert.ok(await list.evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.clientHeight>0&&el.scrollHeight>el.clientHeight));
  await list.evaluate(el=>el.scrollTop=300);await p.waitForFunction(selector=>document.querySelector(selector).scrollTop>100,width<600?'.ao-projects-server__board':'[data-column="in-review"] .bu-column__list');
  assert.deepEqual(await state(),before,'navigation and toolbar stay anchored');
  if(width>=600)assert.ok(await p.locator('[data-column="idea"] .bu-column__list').evaluate(el=>el.scrollTop===0),'peer columns stay still');
  await list.focus();await p.keyboard.press('End');
  await p.waitForFunction(selector=>{const el=document.querySelector(selector),last=document.querySelector('[data-column="in-review"] > ul > li:last-child');return el.scrollTop+el.clientHeight>=el.scrollHeight-1&&last.getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom+1;},width<600?'.ao-projects-server__board':'[data-column="in-review"] .bu-column__list');
  const last=await p.locator('[data-column="in-review"] li').last().boundingBox(),bounds=await list.boundingBox();assert.ok(last.y+last.height<=bounds.y+bounds.height+1,'complete last card is reachable');
  const box=await list.boundingBox();await p.mouse.move(box.x+Math.min(box.width/2,100),box.y+80);await p.mouse.wheel(0,500);await p.waitForTimeout(150);assert.deepEqual(await state(),before,'wheel at end never scrolls document');
  if(width===768)assert.ok(await p.locator('.ao-board').evaluate(el=>el.scrollWidth>el.clientWidth),'tablet columns remain horizontally reachable');
 }finally{await b?.close();await h?.close();}
});
