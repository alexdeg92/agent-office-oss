import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{officeSceneFixture}=require('../helpers/office-scene-fixture.cjs');

const frames=[{width:1440,height:900,theme:'light'},{width:1440,height:900,theme:'dark'},{width:390,height:844,theme:'light'},{width:390,height:844,theme:'dark'},{width:1280,height:720,theme:'light'}];
for(const {width,height,theme} of frames)test(`Characters inspector owns its frame ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{
   h=await officeSceneFixture({publicUrl,occupantCount:12,namedAgents:true,primaryName:'Atlas'});
   // Test runtime metadata declares a registered adapter mark; the mounted
   // CharactersVM route performs the brand/row projection, never the browser.
   h.viewEngine.runtimes=()=>[{id:'fixture',adapter:'openclaw',name:'OpenClaw',enabled:true,connection:'connected',capabilities:{}}];
   h.api.topics.invalidate();return h.base;
  }});
  const {page}=b,errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const chars=await h.get('/api/v3/views/office/characters');assert.equal(chars.status,200,chars.text);assert.equal(chars.json.data.count,12);
  await page.goto(b.origin+'/bureau',{waitUntil:'domcontentloaded'});
  await page.locator('.ao-controls [data-page-control]').waitFor({state:'attached'});
  if(width===390){await page.locator('.ao-mobile-options').click();await page.getByRole('dialog').getByRole('button',{name:'Personnaliser',exact:true}).click();}
  else await page.locator('.ao-controls [data-page-control]').click();
  await page.locator('.ao-editbar').waitFor();if(width===390)await page.locator('.ao-editbar__modepick select').selectOption('characters');else await page.getByRole('button',{name:'Personnages',exact:true}).click();
  const panel=page.locator('.ao-editpanel[data-mode="characters"]'),list=panel.locator('.ao-characters__list'),fixed=panel.locator('.ao-characters__fixed'),footer=panel.locator('.ao-characters__actions');
  await page.waitForFunction(()=>document.querySelectorAll('.ao-editpanel .ao-character-row').length===12);
  await page.waitForFunction(()=>document.querySelectorAll('.ao-character-row__portrait [data-avatar-ready="true"]').length===12);
  await page.evaluate(()=>document.fonts.ready);
  await panel.evaluate(el=>{
   for(const animation of el.getAnimations({subtree:true}))
    if(Number.isFinite(animation.effect.getComputedTiming().endTime))animation.finish();
  });
  assert.deepEqual(await panel.locator('.ao-character-row').evaluateAll(rows=>rows.map(row=>row.getAttribute('aria-label').split(' · ')[0])),chars.json.data.groups.flatMap(group=>group.rows.map(row=>row.name)),'backend row order rendered unchanged');
  assert.equal(await panel.getByRole('switch').count(),0,'Characters uses the backend default in-office roster without a scope toggle');
  if(width===390){const search=await panel.getByRole('searchbox').boundingBox();assert.ok(search.width>=300,'phone search occupies a full row');}
  assert.ok((await page.locator('.bu-topbar,.bu-mtopbar').allTextContents()).join(' ').includes('Atlas'));
  assert.equal(await page.locator('.ao-bureau__stage .ao-plate,.ao-bureau__stage .ao-marker,.ao-bureau__stage .ao-life-bubble').evaluateAll(els=>els.some(el=>getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'&&!el.hidden)),false,'Characters preview hides scene labels, state markers and communication bubbles');
  const marks=panel.locator('.ao-character-row .ao-brand-mark');assert.ok(await marks.count()>0,'adapter-declared connector marks are present');
  await page.waitForFunction(()=>[...document.querySelectorAll('.ao-character-row .ao-brand-mark')].every(mark=>mark.classList.contains('ao-brand-mark--ready')));
  assert.equal(await marks.locator('.ao-brand-mark__fallback').evaluateAll(els=>els.every(el=>getComputedStyle(el).display==='none')),true,'loaded marks have no duplicate monogram');
  assert.equal(await panel.locator('.ao-characters > .ao-ok,.ao-characters > .ao-problems').count(),0,'status is inside footer');
  assert.equal(await footer.locator('[role="status"]').count(),1);
  const checkFrame=async()=>{
   assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const bounds=await panel.boundingBox(),end=await footer.boundingBox(),top=await fixed.boundingBox();
   assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,JSON.stringify(bounds));
   assert.ok(end.y+end.height<=bounds.y+bounds.height+1&&end.y>=bounds.y,JSON.stringify({bounds,end}));
   assert.ok(top.y>=bounds.y&&top.y+top.height<end.y);
  };
  await checkFrame();
  assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight),'long roster scrolls inside its own region');
  assert.equal(await list.evaluate(el=>{
   const bounds=el.getBoundingClientRect();
   return [...el.querySelectorAll('.ao-character-row')].some(row=>{
    const box=row.getBoundingClientRect();return box.top<bounds.bottom-1&&box.bottom>bounds.bottom+1;
   });
  }),false,'the initial region edge does not cut through a row');
  assert.equal(await list.evaluate(el=>{
   const edge=el.getBoundingClientRect().bottom;
   return [...el.querySelectorAll('.ao-character-row')].some(row=>{
    const bounds=row.getBoundingClientRect(),avatar=row.querySelector('.ao-character-avatar').getBoundingClientRect();
    return bounds.top<edge&&bounds.bottom<=edge+1&&avatar.bottom>edge+1;
   });
  }),false,'each initially visible portrait fits inside the whole row');
  const initial={head:(await fixed.boundingBox()).y,foot:(await footer.boundingBox()).y};
  await mkdir('design/reports/characters-frame-105',{recursive:true});
  const capture=async state=>page.screenshot({path:`design/reports/characters-frame-105/${width}-${theme}-${state}.png`,animations:'disabled'});
  await capture('roster');
  await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  assert.ok(await list.evaluate(el=>el.scrollTop>0));
  assert.equal((await fixed.boundingBox()).y,initial.head);assert.equal((await footer.boundingBox()).y,initial.foot);
  const last=panel.locator('.ao-character-row').last(),lastBounds=await last.boundingBox(),listBounds=await list.boundingBox();
  assert.ok(lastBounds.y+lastBounds.height<=listBounds.y+listBounds.height+1,'last row is fully reachable above the region edge');
  await capture('roster-scrolled');
  await last.click();await panel.locator('.ao-agentcard .ao-sc--external').waitFor();
  const detail=panel.locator('.ao-characters__detail');assert.ok(await detail.evaluate(el=>el.scrollHeight>el.clientHeight));
  {
   const cards=panel.locator('.ao-sc__cards'),first=cards.locator('.ao-sc__card').first();
   assert.ok((await first.boundingBox()).y+(await first.boundingBox()).height<=(await detail.boundingBox()).y+(await detail.boundingBox()).height+1,'first complete choice card is above the footer');
   if(width>390)assert.ok(await cards.evaluate(el=>el.scrollHeight>el.clientHeight),'choices have a dedicated internal scroller');
  }
  await capture('detail');
  assert.ok(Math.abs((await footer.boundingBox()).y-initial.foot)<1,'footer stays anchored within one CSS pixel');
  if(width===390){await panel.getByRole('button',{name:'Retour à la liste',exact:true}).click();await list.waitFor();}
  await footer.getByRole('button',{name:'Annuler',exact:true}).click();await panel.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
 }finally{await b?.close();await h?.close();}
});
