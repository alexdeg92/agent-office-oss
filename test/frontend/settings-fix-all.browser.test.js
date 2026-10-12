import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';
const skip=browserSkipReason();
const password='fixture password only';
const read=p => p.evaluate(async()=> (await (await import('/settings-api.js')).readSettings()));
const open=async (scenario,{width,theme='light'}={}) => {
  const h=await openLayoutBrowser(process.env.SETTINGS_BEFORE_ROOT ? {root:process.env.SETTINGS_BEFORE_ROOT,theme} : {theme});
  if(width)await h.page.setViewportSize({width,height:width===375?667:width===1440?900:844});
  const errors=[];h.page.on('pageerror',e=>errors.push(e.message));h.page.on('console',e=>{if(e.type()==='error'&&e.text().startsWith('[vm]'))errors.push(e.text());});
  await visit(h.page,h.origin,'/parametres?mock='+scenario,'#settings-section-form');
  return {...h,close:async()=>{await h.close();assert.deepEqual(errors,[]);}};
};
async function capture(p,name) {
  if(process.env.SETTINGS_SCREENSHOTS==='1') {const dir=process.env.SETTINGS_FIXALL_SCREENSHOT_DIR||'design/reports/diagnostics-fixall-1';await mkdir(dir,{recursive:true});await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await p.screenshot({path:dir+'/'+name+'.png',animations:'disabled'});}
}
async function matrix(p,state) {
  if(process.env.SETTINGS_SCREENSHOTS!=='1')return;
  for(const width of [1440,390,375])for(const theme of ['light','dark']){
    await p.setViewportSize({width,height:width===375?667:width===1440?900:844});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    await capture(p,`${state}-${theme}-${width}`);
  }
}
async function targetVisible(p) {
  await p.waitForFunction(()=>{
    const h=document.querySelector('[data-fix-target=true] h2'),body=document.querySelector('.ao-settings > .ao-frame__body');if(!h||!body)return false;
    const r=h.getBoundingClientRect(),b=body.getBoundingClientRect();return document.activeElement===h&&r.top>=b.top-1&&r.bottom<=b.bottom;
  },{},{timeout:3000}).catch(async error=>{console.log(await p.evaluate(()=>({active:document.activeElement?.id,frames:[...document.querySelectorAll('.ao-frame__body')].map(e=>({parent:e.parentElement.className,scroll:e.scrollTop,bounds:e.getBoundingClientRect().toJSON()})),target:document.querySelector('[data-fix-target=true] h2')?.getBoundingClientRect().toJSON()})));throw error;});
}

async function apply(p) {
  await p.getByRole('button',{name:/^Corriger \d+ éléments$/}).click();
  await p.locator('#settings-current-password').fill(password);
  await p.locator('button[form=settings-reauth-form]').click();
  await p.locator('[data-fix-all=results]').waitFor();
}

test('Fix all defaults to automatic actions; one re-auth, consent, result per item and fresh diagnostics', {skip,timeout:60000},async()=>{
  const h=await open('settings-fixall'),p=h.page;
  try {
    const info=p.locator('[data-testid="diagnostic-runtime:codex"]');
    assert.equal(await info.getByRole('button').count(),0);assert.equal(await info.getByRole('img',{name:'Information'}).count(),1);
    await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
    const checks=p.locator('[data-fix-all] input[type=checkbox]');
    assert.equal(await checks.count(),3);assert.equal(await checks.nth(0).isChecked(),true);assert.equal(await checks.nth(1).isChecked(),true);assert.equal(await checks.nth(2).isChecked(),false);
    assert.ok((await p.locator('[data-fix-all]').innerText()).includes('données locales privées'));
    for(const width of [1440,390,375])for(const theme of ['light','dark']) {
      await p.setViewportSize({width,height:width===375?667:width===1440?900:844});
      await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      const geometry=await p.locator('[role=dialog]').evaluate(el=>{
        const body=el.querySelector('.ao-frame__body'),head=el.querySelector('.ao-frame__head'),foot=el.querySelector('.ao-frame__foot');
        const before=[head.getBoundingClientRect().y,foot.getBoundingClientRect().y];body.scrollTop=body.scrollHeight;
        return {before,after:[head.getBoundingClientRect().y,foot.getBoundingClientRect().y],overflow:getComputedStyle(body).overflowY,foot:foot.getBoundingClientRect().bottom,frame:el.getBoundingClientRect().bottom,doc:[document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],view:[innerWidth,innerHeight]};
      });
      assert.deepEqual(geometry.before,geometry.after);assert.equal(geometry.overflow,'auto');assert.ok(Math.abs(geometry.foot-geometry.frame)<2);assert.ok(geometry.doc.every((n,i)=>n<=geometry.view[i]));
      await p.locator('[role=dialog] .ao-frame__body').evaluate(el=>{el.scrollTop=0;});
      await capture(p,`selection-${theme}-${width}`);
    }
    await apply(p);
    assert.equal(await p.locator('[data-testid^="fix-result-applied-"]').count(),2);
    assert.equal(await p.locator('#settings-current-password').count(),0);
    const fresh=await read(p);assert.ok(fresh.agents.filter(a=>['runner','editor'].includes(a.agentId)).every(a=>a.integrations[0].status==='installed'));
    assert.equal(fresh.runtimes.find(r=>r.id==='claude-local').enabled,false,'unchecked runtime stays disabled');
    await matrix(p,'results');
    await p.locator('[role=dialog]').getByRole('button',{name:'Fermer',exact:true}).last().click();
    assert.equal(await p.locator('.ao-settings__healthy').getAttribute('open'),null);
    await p.locator('.ao-settings__healthy > summary').click();
    assert.equal(await p.locator('[data-testid="diagnostic-agent:openclaw:runner"]').getByRole('img',{name:'En ordre'}).count(),1);
    const configure=p.locator('[data-testid="diagnostic-runtime:claude-code"]');await configure.getByRole('button',{name:/^Configurer.*Claude/}).click();
    await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();
    assert.equal(await p.locator('#settings-tab-connexion').getAttribute('aria-selected'),'true');
    await p.locator('[data-runtime-connection=claude-code][data-fix-target=true] h2').waitFor();
    await targetVisible(p);
    assert.equal(await p.locator('#settings-enabled-claude-code').isChecked(),false,'manual configure does not enable a runtime');
    assert.equal(await p.locator('.ao-settings__footer').count(),0,'manual navigation never stages a write');
    await capture(p,'manual-runtime-target-dark-375');
  }finally{await h.close();}
});

test('Fix all retains successful items and reports a partial failure; explicit runtime opt-in is applied', {skip,timeout:30000},async()=>{
  const h=await open('settings-fixall-partial'),p=h.page;
  try {
    await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
    await p.locator('[data-testid="fix-runtime.enable:claude-local"] input').check();
    await apply(p);
    assert.equal(await p.locator('[data-testid^="fix-result-applied-"]').count(),2);assert.equal(await p.locator('[data-testid^="fix-result-failed-"]').count(),1);
    const fresh=await read(p);assert.equal(fresh.agents.find(a=>a.agentId==='runner').integrations[0].status,'installed');assert.equal(fresh.agents.find(a=>a.agentId==='editor').integrations[0].status,'outdated');assert.equal(fresh.runtimes.find(r=>r.id==='claude-local').enabled,true);
    assert.equal(await p.locator('#settings-current-password').count(),0);await matrix(p,'partial-results');
    const failed=p.locator('[data-testid^="fix-result-failed-"]');assert.ok((await failed.innerText()).includes('L’intégration a changé'));await failed.getByRole('button',{name:/^Ouvrir les réglages/}).click();await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();
  }finally{await h.close();}
});

test('a changed settings revision disables the reviewed selection until the owner reviews again', {skip,timeout:30000},async()=>{
  const h=await open('settings-fixall'),p=h.page;
  try {
    await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
    await p.evaluate(async()=>{const api=await import('/settings-api.js'),v=await api.readSettings();await api.settingsCommand('instance',{expectedRevision:v.revision,name:'Atelier updated'},'PUT');});
    await p.waitForFunction(()=>document.querySelector('[data-fix-all]')?.innerText.includes('Les paramètres ont changé'));
    assert.equal(await p.getByRole('button',{name:/^Corriger \d+ éléments$/}).isDisabled(),true);
    assert.equal(await p.locator('#settings-current-password').count(),0);await matrix(p,'stale');
  }finally{await h.close();}
});


test('a sheet stays dismissible when a fresh VM makes the instance readonly', {skip,timeout:30000},async()=>{
  const h=await open('settings-fixall'),p=h.page;
  try {
    await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
    await p.evaluate(async()=>{const m=await import('/mock/server.js');m.configure({scenario:'settings-readonly',standalone:true});const {services}=await import('/services.js');for(const changed of services.settingsListeners)changed({revision:2});});
    await p.waitForFunction(()=>document.querySelector('.ao-settings__banner')?.innerText.includes('lecture seule'));
    assert.equal(await p.getByRole('button',{name:/^Corriger \d+ éléments$/}).isDisabled(),true);
    assert.equal(await p.locator('[data-fix-all] input:enabled').count(),0);assert.ok((await p.locator('[data-fix-all]').innerText()).includes('lecture seule'));await matrix(p,'readonly');
    await p.locator('[role=dialog]').getByRole('button',{name:'Annuler',exact:true}).click();
    assert.equal(await p.locator('[data-fix-all]').count(),0);
  }finally{await h.close();}
});


test('an applying batch holds its actions until every result returns', {skip,timeout:30000},async()=>{
  const h=await open('settings-fixall-delayed'),p=h.page;
  try {
    await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
    await p.getByRole('button',{name:/^Corriger \d+ éléments$/}).click();
    await p.locator('#settings-current-password').fill(password);await p.locator('button[form=settings-reauth-form]').click();
    await p.locator('[data-fix-all=selection]').waitFor();
    assert.equal(await p.getByRole('button',{name:'Correction en cours…',exact:true}).isDisabled(),true);
    assert.equal(await p.locator('[data-fix-all] input:enabled').count(),0);
    await matrix(p,'applying');await p.locator('[data-fix-all=results]').waitFor();
    assert.equal(await p.locator('[data-testid^="fix-result-applied-"]').count(),2);
  }finally{await h.close();}
});


test('manual configure lands visibly on its runtime after navigation in every viewport and theme', {skip,timeout:60000},async()=>{
  for(const width of [1440,390,375])for(const theme of ['light','dark']){
    const h=await open('settings-fixall',{width,theme}),p=h.page;
    try {
      await p.locator('[data-testid="diagnostic-runtime:claude-code"]').getByRole('button',{name:/^Configurer.*Claude/}).click();
      await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();await targetVisible(p);
      assert.equal(await p.locator('#settings-enabled-claude-code').isChecked(),false);
      assert.equal(await p.locator('.ao-settings__footer').count(),0);
      await capture(p,`manual-runtime-target-${theme}-${width}`);
    }finally{await h.close();}
  }
});
