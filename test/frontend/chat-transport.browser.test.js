import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs');
const OUT='design/reports/chat-workspace-173';
for(const width of [1440,390])for(const theme of ['light','dark'])test(`Chat isolated transport ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h,releaseGet=()=>{},releasePost=()=>{},releaseStale=()=>{},releaseStalePost=()=>{};
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:width===390?2:3,apiProxy:async publicUrl=>{h=await chatV3UiFixture({publicUrl,historyCount:2});return h.base;}});
  const p=b.page,height=width===390?844:900,shots=[],errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width,height});
  const split=h.cookie.indexOf('=');await p.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const capture=async state=>{assert.deepEqual(await p.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);await mkdir(OUT,{recursive:true});const path=`${OUT}/${width}-${theme}-${state}.png`;await p.screenshot({path,animations:'disabled'});shots.push(path);};
  const choose=async id=>{if(width===390&&await p.getByRole('button',{name:'Discussions',exact:true}).isVisible())await p.getByRole('button',{name:'Discussions',exact:true}).click();await p.locator(`[data-chat-session="${id}"]`).click();};
  await p.goto(b.origin+'/discuter',{waitUntil:'domcontentloaded'});await p.locator(`[data-chat-agent="${h.targetId}"]`).click();await choose(h.defaultSessionId);await p.locator('[data-chat-thread]').getByText('La note de version est prête à être relue.',{exact:true}).waitFor();
  let phase='hold';const getGate=new Promise(resolve=>releaseGet=resolve),postGate=new Promise(resolve=>releasePost=resolve);
  const sessionPattern='**/api/v3/chat/sessions/'+h.sessionId;
  await p.route('**/api/v3/stream/*/topics',async route=>{const body=route.request().postDataJSON();if(body?.add?.includes('chat-session:'+h.sessionId))await postGate;await route.continue();});
  await p.route(sessionPattern,async route=>{if(phase==='hold')await getGate;if(phase==='failed')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'upstream_unavailable',message:'Le chargement de cette discussion a échoué.',requestId:'synthetic_history'}})});await route.continue();});
  await choose(h.sessionId);await p.locator('.ao-messenger__conversation .ao-messenger__loading').waitFor();assert.equal(await p.locator('[data-chat-message]').count(),0);await capture('history-loading');
  phase='failed';releaseGet();await p.locator('.ao-messenger__conversation [role=alert]').waitFor();assert.equal(await p.locator('[data-chat-message]').count(),0,'previous thread is not presented as current');await capture('history-error');
  phase='healthy';await p.locator('.ao-messenger__conversation').getByRole('button',{name:'Réessayer',exact:true}).click();await p.locator('[data-chat-message]').first().waitFor();releasePost();await capture('history-recovered');
  await p.unroute(sessionPattern);await p.unroute('**/api/v3/stream/*/topics');await choose(h.defaultSessionId);await p.locator('[data-chat-thread]').getByText('La note de version est prête à être relue.',{exact:true}).waitFor();
  const staleGate=new Promise(resolve=>releaseStale=resolve),stalePostGate=new Promise(resolve=>releaseStalePost=resolve);await p.route('**/api/v3/stream/*/topics',async route=>{if(route.request().postDataJSON()?.add?.includes('chat-session:'+h.sessionId))await stalePostGate;await route.continue();});await p.route(sessionPattern,async route=>{await staleGate;await route.continue();});
  await choose(h.sessionId);await p.locator('.ao-messenger__conversation .ao-messenger__loading').waitFor();await choose(h.defaultSessionId);const staleResponse=p.waitForResponse(response=>response.url().endsWith('/api/v3/chat/sessions/'+h.sessionId));releaseStale();releaseStalePost();await p.locator('[data-chat-thread]').getByText('La note de version est prête à être relue.',{exact:true}).waitFor();
  await staleResponse;
  assert.equal(await p.locator('[data-chat-message]').count(),1,'late response cannot replace the selected thread');await capture('stale-isolated');
  await p.locator('#chat-texte').fill('Brouillon privé avant réinitialisation');await p.evaluate(()=>window.dispatchEvent(new CustomEvent('agent-office:me')));await p.waitForFunction(()=>document.querySelector('#chat-texte')?.value==='');assert.equal(await p.locator('#chat-texte').inputValue(),'','identity reset drops the old viewer draft');
  assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);await writeFile(`${OUT}/${width}-${theme}-transport.json`,JSON.stringify({source:process.env.AO_SOURCE_SHA,shots},null,2)+'\n');
 }finally{releaseGet();releasePost();releaseStale();releaseStalePost();await b?.close();await h?.close();}
});
