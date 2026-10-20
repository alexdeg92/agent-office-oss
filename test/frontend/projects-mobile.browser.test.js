import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
for(const width of [390,375])for(const theme of ['light','dark'])test(`Mobile Projects touch and server-owned moves ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:true,apiProxy:async publicUrl=>{h=await projectTeamFixture({publicUrl});return h.base;}});
  const p=b.page,height=844;await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const ids=[];for(let n=0;n<16;n++){const r=await h.post('/api/v3/projects',{name:`Projet mobile ${n+1}`,status:'todo',priority:'P2'});assert.equal(r.status,200,r.text);ids.push(r.json.data.vm.id);}
  await p.goto(b.origin+'/projets?etape=todo',{waitUntil:'domcontentloaded'});const body=p.locator('.ao-projects-server__board');await p.locator(`[data-card="${ids[0]}"]`).waitFor();
  const frame=()=>p.evaluate(()=>({doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY],head:document.querySelector('.ao-projects > .ao-frame__head').getBoundingClientRect().toJSON(),bar:document.querySelector('.ao-projects > .ao-frame__bar').getBoundingClientRect().toJSON(),nav:document.querySelector('.bu-bottombar').getBoundingClientRect().toJSON()}));
  const before=await frame();assert.deepEqual(before.doc,[width,height,0]);
  const box=await body.boundingBox(),cdp=await p.context().newCDPSession(p),x=box.x+box.width/2,y=box.y+box.height-30;
  assert.equal(await p.evaluate(({x,y})=>document.querySelector('.ao-projects-server__board').contains(document.elementFromPoint(x,y)),{x,y}),true,'swipe begins in the visible list region');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=10;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*18}]});await p.waitForTimeout(25);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  await p.waitForFunction(()=>document.querySelector('.ao-projects-server__board').scrollTop>40);assert.deepEqual(await frame(),before);assert.equal(await p.locator('[role=dialog]').count(),0,'scroll cancels long press');
  await body.evaluate(el=>el.scrollTop=el.scrollHeight);const last=await p.locator('[data-column="todo"] li').last().boundingBox(),end=await body.boundingBox();assert.ok(last.y+last.height<=end.y+end.height+1,'last card clears anchored navigation');
  const card=p.locator(`[data-card="${ids[0]}"]`);await card.scrollIntoViewIfNeeded();const response=p.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/projects/'+ids[0]+'/status'));
  await card.getByTestId('project-move:'+ids[0]).getByRole('button').click();await p.getByRole('menuitem',{name:'En cours',exact:true}).click();const result=await response;assert.equal(result.status(),200);assert.ok(result.url().includes('/api/v3/'));
  await p.waitForFunction(id=>!document.querySelector(`[data-card="${id}"]`),ids[0]);
  const server=await h.get('/api/v3/views/projects?stage=todo');assert.equal(server.status,200,server.text);
  assert.deepEqual(await p.locator('[data-column="todo"] [data-card]').evaluateAll(cards=>cards.map(card=>card.dataset.card)),server.json.data.columns.find(column=>column.id==='todo').cards.map(card=>card.id));
  assert.deepEqual(await frame(),before);
 }finally{await b?.close();await h?.close();}
});
