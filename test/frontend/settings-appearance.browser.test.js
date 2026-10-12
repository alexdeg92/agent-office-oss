import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
const preference=p=>p.evaluate(()=>localStorage.getItem('office.animations-surprises'));
async function capture(p,name){if(process.env.BUREAU_SCREENSHOTS!=='1')return;await mkdir('design/reports/bureau-mobile-1/product',{recursive:true});await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await p.screenshot({path:'design/reports/bureau-mobile-1/product/'+name+'.png',animations:'disabled'});}

test('Appearance commits the default-on surprise preference immediately and restores saved-off after reload', {skip,timeout:60000},async()=>{
 for(const width of [1440,390,375])for(const theme of ['light','dark']) {
  const h=await openLayoutBrowser({theme,touch:width<600}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
  try {
   await p.setViewportSize({width,height:width===1440?900:width===390?844:667});
   await visit(p,h.origin,'/parametres?onglet=apparence','#settings-surprise-animations');
   const control=p.getByRole('switch',{name:'Animations surprises',exact:true});
   assert.equal(await control.isChecked(),true);assert.equal(await preference(p),null);
   assert.equal(await p.getByRole('button',{name:'Enregistrer',exact:true}).count(),0);
   await p.evaluate(()=>{window.preferenceEvents=[];window.addEventListener('office-surprises-setting',event=>window.preferenceEvents.push(event.detail));});
   await capture(p,`appearance-on-${theme}-${width}`);
   await control.click();assert.equal(await control.isChecked(),false);assert.equal(await preference(p),'off');
   assert.deepEqual(await p.evaluate(()=>window.preferenceEvents),[false]);
   assert.equal(await p.evaluate(async()=>{const m=await import('/office/surprises.js');return m.surprisesEnabled();}),false);
   await capture(p,`appearance-off-${theme}-${width}`);
   await p.reload({waitUntil:'networkidle'});await control.waitFor();assert.equal(await control.isChecked(),false);
   await p.getByRole('link',{name:'Bureau',exact:true}).first().click();await p.locator('.ao-bureau__stage').waitFor();
   assert.equal(await p.getByText('Animations surprises',{exact:true}).count(),0);
   if(width<600){await p.getByRole('button',{name:'Options du bureau',exact:true}).click();assert.equal(await p.locator('[role=dialog]').getByText('Animations surprises',{exact:true}).count(),0);}
   await visit(p,h.origin,'/parametres?onglet=apparence','#settings-surprise-animations');
   await control.waitFor();assert.equal(await control.isChecked(),false);await control.focus();await p.keyboard.press('Space');assert.equal(await control.isChecked(),true);assert.equal(await preference(p),'on');
   assert.deepEqual(errors,[]);
   const bounds=await p.evaluate(()=>({doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight]}));assert.ok(bounds.doc.every((n,i)=>n<=bounds.view[i]));
  }finally{await h.close();}
 }
});

test('read-only server Settings leave the independent device preference available', {skip,timeout:60000},async()=>{
 for(const width of [1440,390,375])for(const theme of ['light','dark']) {
 const h=await openLayoutBrowser({theme,touch:width<600}),p=h.page;
 try {
  await p.setViewportSize({width,height:width===1440?900:width===390?844:667});await visit(p,h.origin,'/parametres?mock=settings-readonly&onglet=apparence','#settings-surprise-animations');
  const snapshot=()=>p.evaluate(async()=>{const {readSettings}=await import('/settings-api.js');return readSettings();});
  const before=await snapshot();assert.equal(before.readonly,true);
  const control=p.getByRole('switch',{name:'Animations surprises',exact:true});assert.equal(await control.isEnabled(),true);
  assert.equal(await p.locator('.ao-settings__banner').count(),0);
  await control.click();assert.equal(await preference(p),'off');assert.equal((await snapshot()).revision,before.revision);
  await capture(p,`appearance-local-readonly-${theme}-${width}`);
  if(width===375&&theme==='light') {
  await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
  const english=p.getByRole('switch',{name:'Surprise animations',exact:true});await english.waitFor();assert.equal(await english.isChecked(),false);
  assert.ok((await p.locator('.ao-settings__device-status').innerText()).includes('immediately on this device'));
  await capture(p,'appearance-local-readonly-en-light-375');
  }
 }finally {await h.close();}
 }
});
