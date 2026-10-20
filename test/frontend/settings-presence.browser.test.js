import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';
const require=createRequire(import.meta.url);
const {settingsFixture}=require('../helpers/settings-fixture');
const ids=['finishedSessionWindowMinutes','agentPresenceWindowMinutes','idleRelocationMinutes','idleTransitionDebounceMs'];
const getVM=async h=>{const r=await h.get('/api/v3/settings');assert.equal(r.status,200,r.text);return r.json.data;};
async function capture(page,width,theme,phase){
 await page.locator('#settings-office-title').evaluate(el=>el.scrollIntoView({block:'start'}));
 await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight),'page never scrolls');
 const path=`design/reports/settings-presence/${width}-${theme}-${phase}.png`;
 await page.screenshot({path,animations:'disabled'});console.log('presence capture '+path);
}
for(const width of [1440,390])for(const theme of ['light','dark'])test(`backend presence fields and instance save ${width} ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let b,h;
 try{
  await mkdir('design/reports/settings-presence',{recursive:true});
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{h=await settingsFixture({publicUrl,env:{AGENT_OFFICE_AGENT_PRESENCE_WINDOW_MS:String(45*60000)}});return h.base;}});
  const page=b.page,errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='PUT'&&new URL(r.url()).pathname.endsWith('/settings/instance'))writes.push(r.postDataJSON());});
  await page.setViewportSize({width,height:width===390?844:900});
  const split=h.cookie.indexOf('=');await page.context().addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
  const before=await getVM(h);
  await page.goto(b.origin+'/parametres?onglet=instance',{waitUntil:'domcontentloaded'});
  await page.locator('#settings-office-title').waitFor({state:'visible'});
  for(const id of ids){
   const input=page.locator('#settings-office-'+id),field=before.office[id];
   assert.equal(await input.inputValue(),String(field.value));assert.equal(await input.getAttribute('min'),String(field.minimum));assert.equal(await input.getAttribute('max'),String(field.maximum));
   assert.equal(await input.isDisabled(),!field.editable);
   const label=await input.getAttribute('aria-labelledby'),description=await input.getAttribute('aria-describedby');assert.ok(label&&description);
   assert.ok((await page.locator('#'+label).innerText()).trim().length>0);assert.ok((await page.locator('#'+description).innerText()).trim().length>0);
  }
  assert.equal(before.office.agentPresenceWindowMinutes.reason.key,'settings.office.managed');
  const officeCopy=await page.locator('#settings-office-title').locator('..').innerText();
  assert.ok(officeCopy.includes('Cette durée est définie par la configuration du serveur.'));assert.ok(!officeCopy.includes('AGENT_OFFICE_'));
  assert.equal(before.office.agentPresenceWindowMinutes.source,'env');assert.equal(before.office.agentPresenceWindowMinutes.editable,false);
  await capture(page,width,theme,'managed');
  await page.locator('#settings-office-finishedSessionWindowMinutes').fill('12');await page.locator('#settings-office-idleRelocationMinutes').fill('20');await page.locator('#settings-office-idleTransitionDebounceMs').fill('3200');
  await page.locator('.ao-settings__footer button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.ao-settings__dirty--active'));
  assert.equal(writes.length,1);assert.deepEqual(writes[0].office,{finishedSessionWindowMinutes:12,idleRelocationMinutes:20,idleTransitionDebounceMs:3200});
  const after=await getVM(h);assert.equal(after.office.finishedSessionWindowMinutes.value,12);assert.equal(after.office.idleRelocationMinutes.value,20);assert.equal(after.office.idleTransitionDebounceMs.value,3200);assert.equal(after.office.agentPresenceWindowMinutes.value,45);
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#settings-office-title').waitFor({state:'visible'});
  assert.equal(await page.locator('#settings-office-finishedSessionWindowMinutes').inputValue(),'12');assert.equal(await page.locator('#settings-office-idleRelocationMinutes').inputValue(),'20');assert.equal(await page.locator('#settings-office-idleTransitionDebounceMs').inputValue(),'3200');
  assert.equal(await page.locator('#settings-office-agentPresenceWindowMinutes').isDisabled(),true);
  await capture(page,width,theme,'saved');assert.deepEqual(errors,[]);
 }finally{await b?.close();await h?.close();}
});
