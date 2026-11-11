import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
import {cleanupAfterTest} from './helpers/test-cleanup.js';
const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs');

test('creating a discussion locks the old composer, times out safely, and carries its draft on retry',{skip:browserSkipReason(),timeout:60000},async()=>{
 let browser,fixture,releaseLate,failFirstCreate,testError;
 try{
  browser=await openLayoutBrowser({theme:'light',apiVersion:3,apiProxy:async publicUrl=>{fixture=await chatV3UiFixture({publicUrl,historyCount:0});return fixture.base;},testTimeoutMs:60000});
  const page=browser.page;await page.setViewportSize({width:1440,height:900});
  const split=fixture.cookie.indexOf('=');await page.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:browser.origin,httpOnly:true,sameSite:'Lax'}]);
  let createCount=0,firstSeenResolve,secondSeenResolve,messageRequests=0,lateResponseStatus=null;const createKeys=[];
  let firstSeen=new Promise(resolve=>firstSeenResolve=resolve),secondSeen=new Promise(resolve=>secondSeenResolve=resolve);
  const createPath='/api/v3/chat/agents/'+encodeURIComponent(fixture.targetId)+'/sessions';
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith(`/api/v3/chat/sessions/${encodeURIComponent(fixture.defaultSessionId)}/messages`))messageRequests++;});
  await page.route('**/api/v3/chat/agents/*/sessions*',async route=>{
   if(route.request().method()!=='POST'||!new URL(route.request().url()).pathname.endsWith(createPath)){await route.continue();return;}
   createCount++;createKeys.push(await route.request().headerValue('idempotency-key'));
   if(createCount===1){firstSeenResolve();await new Promise(resolve=>failFirstCreate=resolve);await route.abort();return;}
   if(createCount===2){const response=await route.fetch();lateResponseStatus=response.status();secondSeenResolve();await new Promise(resolve=>releaseLate=resolve);try{await route.fulfill({response});}catch{}return;}
   await route.continue();
  });
  await page.goto(browser.origin+'/discuter',{waitUntil:'domcontentloaded'});
  await page.locator(`[data-chat-agent="${fixture.targetId}"]`).click();
  await page.locator(`[data-chat-session="${fixture.defaultSessionId}"]`).click();
  const composer=page.locator('#chat-texte'),send=page.locator('.ao-chat__send');await composer.waitFor();
  const draft='Ce brouillon doit suivre la nouvelle discussion.';await composer.fill(draft);

  await page.getByRole('button',{name:'Nouvelle discussion',exact:true}).click();await firstSeen;
  await page.waitForFunction(()=>document.querySelector('#chat-texte')?.disabled===true,'',{timeout:5000});
  assert.equal(await send.isDisabled(),true,'the old session cannot submit while creation is pending');
  await page.evaluate(()=>document.querySelector('.ao-chat__send')?.click());
  assert.equal(messageRequests,0,'no request is sent to the old session during creation');
  failFirstCreate();failFirstCreate=null;
  await page.locator('.ao-messenger__new [role="alert"]').waitFor();
  assert.equal(await composer.isDisabled(),false,'the composer is restored after creation fails');
  assert.equal(await composer.inputValue(),draft,'the failed creation preserves the typed draft');

  await page.getByRole('button',{name:'Nouvelle discussion',exact:true}).click();await secondSeen;
  await page.waitForFunction(()=>document.querySelector('#chat-texte')?.disabled===true,'',{timeout:5000});
  assert.equal(await send.isDisabled(),true);
  await page.evaluate(()=>document.querySelector('.ao-chat__send')?.click());
  assert.equal(messageRequests,0,'programmatic clicks cannot dispatch the old composer either');
  assert.equal(lateResponseStatus,201,'the timed-out request reached the backend before its response was held');
  await page.waitForFunction(()=>document.querySelector('#chat-texte')?.disabled===false,'',{timeout:20000});
  assert.equal(await composer.inputValue(),draft,'timeout restores the old session draft');
  releaseLate();releaseLate=null;
  await page.getByRole('button',{name:'Nouvelle discussion',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('discussion')!==fixture.defaultSessionId&&url.searchParams.get('vue')==='conversation');
  assert.equal(createCount,3,'the retry is sent after the first response timed out');assert.equal(createKeys[1],createKeys[2],'an uncertain create retries with the same idempotency key');
  const newSessionId=new URL(page.url()).searchParams.get('discussion');assert.ok(newSessionId);
  await page.waitForFunction(expected=>document.querySelector('#chat-texte')?.value===expected,draft);
  assert.equal(await composer.inputValue(),draft,'the new conversation receives the draft');
  await page.locator(`[data-chat-session="${fixture.defaultSessionId}"]`).click();await page.waitForFunction(()=>document.querySelector('#chat-texte')?.value==='');
  await page.locator(`[data-chat-session="${newSessionId}"]`).click();await page.waitForFunction(expected=>document.querySelector('#chat-texte')?.value===expected,draft);
  const response=page.waitForResponse(row=>row.request().method()==='POST'&&new URL(row.url()).pathname.endsWith(`/api/v3/chat/sessions/${encodeURIComponent(newSessionId)}/messages`));
  await send.click();assert.equal((await response).status(),202);
  await page.locator('[data-chat-thread]').getByText(draft,{exact:true}).waitFor();
  const [newVm,oldVm]=await Promise.all([fixture.get('/api/v3/chat/sessions/'+newSessionId),fixture.get('/api/v3/chat/sessions/'+fixture.defaultSessionId)]);
  assert.equal(newVm.status,200,newVm.text);assert.ok(newVm.json.data.messages.some(row=>row.role==='user'&&row.body.text===draft),'the message is persisted only in the new conversation');
  assert.equal(oldVm.status,200,oldVm.text);assert.equal(oldVm.json.data.messages.some(row=>row.role==='user'&&row.body.text===draft),false,'the old conversation never receives the draft');
  const sessions=await fixture.get('/api/v3/chat/agents/'+fixture.targetId+'/sessions');assert.equal(sessions.status,200,sessions.text);assert.equal(sessions.json.data.sessions.filter(row=>row.id===newSessionId).length,1,'retry does not create a duplicate session');
 }catch(error){testError=error;throw error;}finally{failFirstCreate?.();releaseLate?.();await cleanupAfterTest(testError,[()=>browser?.close(),()=>fixture?.close()],'chat create-session browser test');}
});
