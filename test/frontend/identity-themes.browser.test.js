import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
const dimensions={1440:{width:1440,height:900},390:{width:390,height:844},360:{width:360,height:780}};
async function capture(page,name){
 if(process.env.IDENTITY_THEME_SCREENSHOTS!=='1')return;
 await mkdir('design/reports/identity-themes-1',{recursive:true});
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 await page.screenshot({path:`design/reports/identity-themes-1/${name}.png`,animations:'disabled'});
}

test('identity picker previews and persists per user independently of color mode; save bar actions stay on one row', {skip,timeout:90000},async()=>{
 const browser=await openLayoutBrowser({theme:'light'}),page=browser.page,errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.setViewportSize(dimensions[1440]);
  await visit(page,browser.origin,'/parametres?onglet=apparence','#settings-identity-title');
  assert.equal(await page.locator('html').getAttribute('data-identity'),'bureau','Bureau is the default identity');
  const identities=await page.evaluate(()=>import('/identity-theme.js').then(module=>module.identityRegistry.themes.map(theme=>({id:theme.id,label:theme.label.fr}))));
  assert.deepEqual(identities.map(theme=>theme.id),['bureau','observatoire','atelier']);
  for(const mode of ['light','dark']){
   await page.evaluate(mode=>import('/theme.js').then(({setTheme})=>setTheme(mode)),mode);
   assert.deepEqual(await page.locator('.ao-settings__identity-preview').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-theme'))),[mode,mode,mode],`${mode} shell preference updates every identity preview`);
    const previewAccents=await page.locator('.ao-settings__identity-preview').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).getPropertyValue('--bu-accent').trim()));
    assert.equal(new Set(previewAccents).size,3,`${mode} picker previews each use their own identity tokens`);
   for(const {id,label} of identities){
    await page.evaluate(id=>import('/identity-theme.js').then(module=>module.setIdentityTheme(id)),id);
    assert.equal(await page.locator('html').getAttribute('data-identity'),id);
    assert.equal(await page.locator('html').getAttribute('data-theme'),mode,`identity ${id} leaves color mode ${mode} unchanged`);
    assert.ok((await page.locator('.ao-settings__identity-status').innerText()).includes(label),`active identity status names ${label}`);
    const accent=await page.locator('html').evaluate(node=>getComputedStyle(node).getPropertyValue('--bu-accent').trim());
    assert.ok(accent.startsWith('#'),`${id}/${mode} token applied`);
    assert.equal(await page.getByRole('radio',{name:new RegExp(id==='observatoire'?'Observatoire':id==='atelier'?'Atelier':'Bureau')}).isChecked(),true);
    await capture(page,`${id}-${mode}-desktop`);
    await page.setViewportSize(dimensions[390]);await capture(page,`${id}-${mode}-mobile`);await page.setViewportSize(dimensions[1440]);
   }
  }
  await page.evaluate(()=>import('/theme.js').then(({setTheme})=>setTheme('system')));
  assert.deepEqual(await page.locator('.ao-settings__identity-preview').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-theme'))),[null,null,null],'system shell preference clears explicit preview modes');
  await page.evaluate(()=>import('/theme.js').then(({setTheme})=>setTheme('dark')));
  await page.evaluate(()=>import('/identity-theme.js').then(({syncIdentityTheme,setIdentityTheme})=>{
   syncIdentityTheme({id:'second-user'});const second=document.documentElement.getAttribute('data-identity');
   setIdentityTheme('observatoire');syncIdentityTheme({email:'owner@example.invalid'});
   window.identityIsolation={second,owner:document.documentElement.getAttribute('data-identity')};
  }));
  assert.deepEqual(await page.evaluate(()=>window.identityIsolation),{second:'bureau',owner:'atelier'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.reload({waitUntil:'networkidle'});await page.locator('.ao-settings__identity-options').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-identity'),'atelier');
  for(const width of [1440,390,360]){
   await page.setViewportSize(dimensions[width]);
   await visit(page,browser.origin,'/parametres?onglet=instance','#settings-instance-name');
   await page.locator('#settings-instance-name').fill(`Theme layout ${width}`);
   const bar=page.locator('.ao-settings__footer'),buttons=bar.locator('.bu-button');
   assert.equal(await buttons.count(),3);
   assert.deepEqual(await buttons.allTextContents(),['Détails','Annuler','Enregistrer'],`save actions stay ordered at ${width}`);
   const geometry=await bar.evaluate(node=>{const row=node.getBoundingClientRect(),items=[...node.querySelectorAll('.bu-button')].map(el=>el.getBoundingClientRect());return {row:[row.left,row.right,row.top,row.bottom],items:items.map(r=>[r.left,r.right,r.top,r.bottom]),status:node.querySelector('.ao-settings__dirty').getBoundingClientRect().toJSON()};});
   assert.ok(geometry.items.every(box=>box[0]>=geometry.row[0]&&box[1]<=geometry.row[1]),`buttons fit at ${width}`);
   assert.ok(Math.max(...geometry.items.map(box=>box[2]))-Math.min(...geometry.items.map(box=>box[2]))<2,`buttons share a row at ${width}`);
   assert.ok(geometry.status.right<=geometry.items[0][0],`status remains left of Details at ${width}`);
   const truncation=await bar.locator('.ao-settings__dirty-text').evaluate(node=>({whiteSpace:getComputedStyle(node).whiteSpace,overflow:getComputedStyle(node).overflow,textOverflow:getComputedStyle(node).textOverflow}));
   assert.deepEqual(truncation,{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
   assert.ok(await page.getByRole('button',{name:'Détails',exact:true}).isVisible());
   if(width===1440)await page.getByRole('button',{name:'Détails',exact:true}).click();
   await page.getByRole('button',{name:'Annuler',exact:true}).click();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
