import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
const tabs=['agents','connexion','instance','apparence','compte'];
test('Settings shared controls preserve tab keyboard navigation, labels and the frame in both themes and all sizes',{skip,timeout:90000},async()=>{
 for(const width of [1440,390,375])for(const theme of ['light','dark']){
  const h=await openLayoutBrowser({theme,touch:width<600}),p=h.page,errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.setViewportSize({width,height:width===1440?900:width===390?844:667});
   const layout=JSON.parse(await readFile('public/v2/bureau/office/layout.example.json','utf8'));layout.agents[0]={...layout.agents[0],character:'fen',variant:'moss',accessories:[]};
   await p.route('**/layout.example.json',route=>route.fulfill({json:layout}));
   await visit(p,h.origin,'/parametres?mock=1','#settings-section-form');
   await p.locator('#settings-tab-diagnostic').focus();await p.keyboard.press('ArrowRight');await p.locator('#settings-tab-agents[aria-selected=true]').waitFor();
   assert.equal(await p.locator('#settings-tab-agents').getAttribute('aria-selected'),'true');
   assert.equal(await p.locator('#settings-tab-agents').evaluate(e=>e===document.activeElement),true);
   for(const tab of tabs){
    await p.locator('#settings-tab-'+tab).click();
    await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
    assert.equal(await p.locator('.ao-settings__footer').count(),0,tab+' has no idle save footer');
    if(tab==='agents'){
     assert.equal(await p.locator('#settings-agent-runtime').inputValue(),'all','the default agent view shows every connector');
     await p.waitForFunction(()=>document.querySelector('[data-testid="settings-agent-all-openclaw-atlas"] img[src*="fen/moss/t.webp"]')?.naturalWidth>0);
    }
    const geometry=await p.evaluate(()=>{
     const frame=document.querySelector('.ao-settings'),body=frame.querySelector('.ao-frame__body');
     const invalid=[...frame.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')].filter(e=>!e.labels?.length&&!e.getAttribute('aria-labelledby'));
     return {doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight],overflow:getComputedStyle(body).overflowY,invalid:invalid.map(e=>e.id)};
    });
    assert.ok(geometry.doc.every((n,i)=>n<=geometry.view[i]),tab+' stays inside viewport');
    assert.equal(geometry.overflow,'auto');assert.deepEqual(geometry.invalid,[],tab+' controls have names');
    if(process.env.SETTINGS_VISUAL_SCREENSHOTS==='1'){
     await mkdir('design/reports/settings-visual-1/tabs',{recursive:true});
     await p.evaluate(()=>document.fonts.ready);
     await p.screenshot({path:`design/reports/settings-visual-1/tabs/${tab}-${theme}-${width}.png`,animations:'disabled'});
    }
   }
   await p.locator('#settings-tab-compte').focus();await p.keyboard.press('Home');await p.locator('#settings-tab-diagnostic[aria-selected=true]').waitFor();
   assert.equal(await p.locator('#settings-tab-diagnostic').getAttribute('aria-selected'),'true');
   await p.keyboard.press('End');await p.locator('#settings-tab-compte[aria-selected=true]').waitFor();assert.equal(await p.locator('#settings-tab-compte').getAttribute('aria-selected'),'true');
   assert.deepEqual(errors,[]);
  }finally{await h.close();}
 }
});
