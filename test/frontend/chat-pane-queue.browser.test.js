import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {openLayoutBrowser,browserSkipReason} from './helpers/layout-browser.js';

const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs');
const OUT='design/reports/t0238-mounted';

for(const width of [1440,390])for(const theme of ['light','dark'])test(`T-0238 pane queue mounted flow ${width}px ${theme}`,{skip:browserSkipReason(),timeout:90000},async()=>{
 let browser,fixture;
 try{
  browser=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{fixture=await chatV3UiFixture({publicUrl,historyCount:0,paneQueueCapture:true});return fixture.base;}});
  const page=browser.page,height=width===390?844:900,errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width,height});
  const split=fixture.cookie.indexOf('=');await page.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:browser.origin,httpOnly:true,sameSite:'Lax'}]);
  const capture=async state=>{assert.deepEqual(await page.evaluate(()=>[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight,scrollY]),[width,height,0]);await mkdir(OUT,{recursive:true});await page.screenshot({path:`${OUT}/${width}-${theme}-${state}.png`,animations:'disabled'});};
  await page.goto(browser.origin+'/discuter',{waitUntil:'domcontentloaded'});
  const target=page.locator(`[data-chat-agent="${fixture.targetId}"]`);await target.waitFor();await target.click();
  await page.getByRole('button',{name:'Nouvelle discussion'}).waitFor();await page.getByRole('button',{name:'Nouvelle discussion'}).click();
  const compose=page.locator('#chat-texte');await compose.waitFor();await compose.fill('Peux-tu vérifier la dernière version ?');await page.locator('.ao-chat__send').click();
  const queued=page.locator('[data-queue-state="queued"]');await queued.waitFor();
  assert.match(await queued.innerText(),/En attente/);assert.equal(await queued.locator('[data-queue-send-now]').innerText(),'Envoyer maintenant');assert.equal(await queued.locator('[data-queue-cancel]').innerText(),'Annuler');await capture('queued');
  await queued.locator('[data-queue-send-now]').click();const dialog=page.locator('.ao-chat__send-now-modal');await dialog.waitFor();
  await dialog.evaluate(element=>Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));
  assert.ok((await dialog.innerText()).includes('Envoyer maintenant')&&(await dialog.innerText()).includes('Garder en attente'));
  if(width===390){
   const geometry=await page.evaluate(()=>{
    const scrim=document.querySelector('.bu-scrim:has(.ao-chat__send-now-modal)'),sheet=document.querySelector('.ao-chat__send-now-modal'),composer=document.querySelector('.ao-messenger__compose');
    const rect=element=>{const value=element.getBoundingClientRect();return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};};
    const buttons=[...sheet.querySelectorAll('.bu-modal__footer > .bu-button')].map(rect),backdrop=rect(scrim),dialogRect=rect(sheet),composerRect=rect(composer);
    return {viewport:[innerWidth,innerHeight],backdrop,dialogRect,composerRect,buttons,backdropCoversComposer:backdrop.left<=composerRect.left&&backdrop.right>=composerRect.right&&backdrop.top<=composerRect.top&&backdrop.bottom>=composerRect.bottom,
      scrimPosition:getComputedStyle(scrim).position,scrimZ:Number.parseInt(getComputedStyle(scrim).zIndex,10),composerZ:Number.parseInt(getComputedStyle(composer).zIndex,10)};
   });
   assert.deepEqual([geometry.backdrop.left,geometry.backdrop.top,geometry.backdrop.right,geometry.backdrop.bottom],[0,0,390,geometry.viewport[1]],'phone scrim covers the complete viewport');
   assert.deepEqual([geometry.dialogRect.left,geometry.dialogRect.right,geometry.dialogRect.bottom],[0,390,geometry.viewport[1]],'warning sheet reaches both phone edges and the bottom');
   assert.equal(geometry.backdropCoversComposer,true,'the modal scrim covers the composer region');
   assert.ok(geometry.scrimZ>geometry.composerZ,'the scrim layers above the composer');
   assert.equal(geometry.buttons.length,2);assert.ok(Math.abs(geometry.buttons[0].width-geometry.buttons[1].width)<=1,'phone actions have equal widths');
   assert.ok(Math.abs(geometry.buttons[0].height-geometry.buttons[1].height)<=1,'phone actions have equal heights');
   assert.ok(Math.abs(geometry.buttons[0].left-geometry.dialogRect.left-(geometry.dialogRect.right-geometry.buttons[0].right))<=1,'phone actions fill the sheet content with symmetric insets');
   assert.ok(geometry.buttons.every(button=>Math.abs(button.left-geometry.buttons[0].left)<=1&&Math.abs(button.right-geometry.buttons[0].right)<=1),'phone actions share aligned content edges');
  }
  await capture('send-now-warning');
  await dialog.getByRole('button',{name:'Garder en attente'}).click();await dialog.waitFor({state:'hidden'});assert.equal(await queued.getAttribute('data-queue-state'),'queued');
  await queued.locator('[data-queue-send-now]').click();await dialog.waitFor();await dialog.getByRole('button',{name:'Envoyer maintenant'}).click();
  const delivered=page.locator('[data-queue-state="sent"]');await delivered.waitFor();assert.equal(await delivered.innerText(),'Envoyé à Atlas');assert.equal(await delivered.locator('[data-queue-send-now]').count(),0);await capture('delivered');
  assert.equal(fixture.paneCalls.length,1,'confirmation dispatches the original queued turn exactly once');assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
 }finally{await browser?.close();await fixture?.close();}
});
