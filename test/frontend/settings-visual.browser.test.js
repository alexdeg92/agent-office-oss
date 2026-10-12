import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
const skip=browserSkipReason();
const out='design/reports/settings-visual-1/';
async function shot(p,name){if(process.env.SETTINGS_VISUAL_SCREENSHOTS!=='1')return;await mkdir(out,{recursive:true});await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:out+name+'.png',animations:'disabled'});}
async function bounds(p){const g=await p.evaluate(()=>{const f=document.querySelector('.ao-settings'),b=f.querySelector('.ao-frame__body');return{doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight],overflow:getComputedStyle(b).overflowY,titles:[...document.querySelectorAll('h1')].filter(e=>e.getBoundingClientRect().height).length};});assert.ok(g.doc.every((n,i)=>n<=g.view[i]));assert.equal(g.overflow,'auto');assert.equal(g.titles,1);}
test('Diagnostics shared list and healthy/details disclosures preserve compact actions and frame at every size/theme',{skip,timeout:90000},async()=>{
 for(const width of [1440,390,375])for(const theme of ['light','dark']){
  const h=await openLayoutBrowser({theme,touch:width<600}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.setViewportSize({width,height:width===1440?900:width===390?844:667});await visit(p,h.origin,'/parametres?mock=settings-fixall','[data-diagnostics]');
   assert.equal(await p.locator('.ao-settings__footer').count(),0);assert.equal(await p.locator('[data-diagnostics] .bu-card,[data-diagnostics] .bu-chip').count(),0);
   assert.equal(await p.locator('[data-diagnostics] > .ao-settings__list > .bu-list-row').count(),8);
   assert.equal(await p.locator('[data-testid="diagnostic-runtime:codex"] button').count(),0);
   const configure=p.locator('[data-testid="diagnostic-runtime:claude-code"] button');
   assert.equal(await configure.innerText(),'Configurer');assert.equal(await configure.getAttribute('aria-label'),'Configurer : Claude Code · Other installation');
   assert.ok((await configure.boundingBox()).height>=(width<821?44:40),'shared text action retains its native touch target');
   assert.equal(await p.locator('.ao-settings__healthy').getAttribute('open'),null);await bounds(p);await shot(p,`diagnostic-${theme}-${width}`);
   await p.locator('[data-testid="diagnostic-runtime:codex"] summary').click();assert.ok((await p.locator('[data-testid="diagnostic-runtime:codex"]').innerText()).includes('Configurez ce moteur depuis Connecteurs'));await shot(p,`details-${theme}-${width}`);
   await p.locator('.ao-settings__healthy > summary').click();assert.equal(await p.locator('.ao-settings__healthy .bu-list-row').count(),4);await p.locator('.ao-settings__healthy').evaluate(el=>{const b=el.closest('.ao-frame__body');b.scrollTop+=el.getBoundingClientRect().top-b.getBoundingClientRect().top-16;});await shot(p,`healthy-expanded-${theme}-${width}`);
   await p.getByRole('button',{name:'Options du diagnostic',exact:true}).click();await p.getByRole('menuitem',{name:'Actualiser le diagnostic',exact:true}).click();await p.locator('[data-diagnostics]').waitFor();assert.equal(await p.locator('[role=menu]').count(),0);await bounds(p);assert.deepEqual(errors,[]);
  }finally{await h.close();}
 }
});
test('Diagnostics healthy, empty, readonly and long fixtures remain truthful without idle Save controls',{skip,timeout:90000},async()=>{
 const fixture=JSON.parse(await readFile('public/v2/mock/examples/settings/settings-vm.json','utf8'));
 for(const kind of ['healthy','empty','readonly','long']){
  const h=await openLayoutBrowser({touch:true}),p=h.page;
  try{
   const envelope=structuredClone(fixture),vm=envelope.data;
   if(kind==='healthy')vm.diagnostics=vm.diagnostics.filter(d=>d.level==='ok');
   if(kind==='empty')vm.diagnostics=[];
   if(kind==='readonly'){vm.readonly=true;vm.diagnostics=vm.diagnostics.map(d=>({...d,fix:null}));}
   if(kind==='long'){const r=vm.runtimes.find(r=>r.id==='codex');r.name='OpenClaw · Documentation et vérifications du bureau';}
   await p.route('**/mock/examples/settings/settings-vm.json',route=>route.fulfill({json:envelope}));
   await visit(p,h.origin,'/parametres','[data-diagnostics]');
   for(const width of [1440,390,375])for(const theme of ['light','dark']){
    await p.setViewportSize({width,height:width===1440?900:width===390?844:667});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    assert.equal(await p.locator('.ao-settings__footer').count(),0);await bounds(p);await shot(p,`${kind}-${theme}-${width}`);
   }
   if(kind==='empty')assert.equal(await p.locator('[data-diagnostics] .bu-list-row').count(),0);
   if(kind==='healthy')assert.equal(await p.locator('.ao-settings__healthy').getAttribute('open'),null);
   if(kind==='readonly')assert.equal(await p.locator('[data-diagnostics] .bu-list-row button').count(),0);
  }finally{await h.close();}
 }
});
test('Diagnostics loading and failed reads keep the body frame and expose retry without a save footer',{skip,timeout:45000},async()=>{
 for(const state of ['loading','error']){
  const h=await openLayoutBrowser(),p=h.page;let held,failed=state==='error';
  try{
   await p.route('**/mock/examples/settings/settings-vm.json',async route=>{if(failed)return route.abort();if(state==='error')return route.fulfill({json:JSON.parse(await readFile('public/v2/mock/examples/settings/settings-vm.json','utf8'))});held=route;});
   await p.goto(h.origin+'/parametres?mock=1',{waitUntil:'domcontentloaded'});
   if(state==='loading')await p.getByText('Chargement des paramètres…',{exact:true}).waitFor();else await p.locator('.ao-settings [role=alert]').waitFor();
   await p.waitForFunction(()=>[...document.querySelectorAll('link[rel=stylesheet]')].every(link=>link.sheet));
   for(const width of [1440,390,375])for(const theme of ['light','dark']){
    await p.setViewportSize({width,height:width===1440?900:width===390?844:667});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    assert.equal(await p.locator('.ao-settings__footer').count(),0);await bounds(p);await shot(p,`${state}-${theme}-${width}`);
   }
   if(state==='error'){
    assert.ok((await p.locator('.ao-settings [role=alert]').innerText()).includes('La connexion a été interrompue. Réessayez.'));
    assert.ok(!(await p.locator('.ao-settings [role=alert]').innerText()).includes('Failed to fetch'));
    assert.equal(await p.getByRole('button',{name:'Réessayer',exact:true}).count(),1);
    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
    assert.ok((await p.locator('.ao-settings [role=alert]').innerText()).includes('The connection was interrupted. Try again.'));
    for(const width of [1440,390,375])for(const theme of ['light','dark']){
     await p.setViewportSize({width,height:width===1440?900:width===390?844:667});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await bounds(p);await shot(p,`error-english-${theme}-${width}`);
    }
    failed=false;await p.getByRole('button',{name:'Try again',exact:true}).click();await p.locator('[data-diagnostics]').waitFor();assert.equal(await p.locator('.ao-settings [role=alert]').count(),0);
   }
   else{await held.fulfill({json:JSON.parse(await readFile('public/v2/mock/examples/settings/settings-vm.json','utf8'))});await p.locator('[data-diagnostics]').waitFor();}
  }finally{await h.close();}
 }
});
