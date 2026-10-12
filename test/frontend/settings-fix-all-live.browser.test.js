import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { openLive, tab, confirm, reloadSettings, skip } from './helpers/settings-live-browser.js';
import { realisticOptions } from './helpers/settings-real-home.js';
const require=createRequire(import.meta.url);
const { settingsProcessFixture, freePort }=require('../helpers/settings-process-fixture');
const { adapterById }=require('../../src/adapters');
const vm=async b => (await b.h.get('/api/v3/settings')).json.data;
async function screenshot(p,name) {if(process.env.SETTINGS_SCREENSHOTS==='1'){await mkdir('design/reports/diagnostics-fixall-1',{recursive:true});await p.screenshot({path:'design/reports/diagnostics-fixall-1/'+name+'.png',animations:'disabled'});}}
async function matrix(p,state) {if(process.env.SETTINGS_SCREENSHOTS!=='1')return;for(const width of [1440,390,375])for(const theme of ['light','dark']){await p.setViewportSize({width,height:width===375?667:width===1440?900:844});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await screenshot(p,`${state}-${theme}-${width}`);}}
async function fix(p,password) {
  await p.getByRole('button',{name:'Tout corriger',exact:true}).click();
  await p.getByRole('button',{name:/^Corriger \d+ éléments$/}).click();
  if(await p.locator('#settings-current-password').count()) await confirm(p,password);
  await p.locator('[data-fix-all=results]').waitFor();
}

test('real fix-all installs both integrations, offers restart in the result sheet, boots a new API and re-diagnoses after reload', {skip,timeout:65000},async()=>{
  const b=await openLive({fixtureFactory:settingsProcessFixture}),p=b.page;
  try {
    const initial=b.h.bootId,next=await freePort();
    // The existing Instance UI stages an effective network change. Fix-all must keep
    // that pending restart and reuse the same recent password confirmation.
    await tab(p,'instance');await p.locator('#settings-network-port').fill(String(next));
    await p.locator('.ao-settings__footer button[type=submit]').click();await confirm(p,b.h.password);
    await p.waitForFunction(()=>document.querySelector('.ao-settings__content')?.innerText.includes('Modifications enregistrées'));
    await tab(p,'diagnostic');
    const before=await vm(b);assert.equal(before.network.restartRequired,true);
    assert.equal(before.diagnostics.filter(d=>d.fix?.automatic).length,2);
    await p.setViewportSize({width:375,height:667});
    await fix(p,b.h.password);
    assert.equal(await p.locator('[data-testid^="fix-result-applied-"]').count(),2);
    const applied=await vm(b);assert.ok(applied.agents.filter(a=>a.configured).every(a=>a.integrations[0].status==='installed'));
    assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/settings/reauth')).length,1,'one password confirmation covers batch and restart');
    await matrix(p,'restart-offer');
    await p.locator('[role=dialog]').getByRole('button',{name:'Redémarrer maintenant',exact:true}).click();
    await p.getByRole('button',{name:'Redémarrer',exact:true}).click();
    await p.waitForFunction(()=>!document.querySelector('[data-fix-all]') && !!document.querySelector('#settings-section-form'),{},{timeout:45000});
    const after=await vm(b);assert.notEqual(b.h.bootId,initial);assert.equal(after.network.active.port,next);assert.equal(after.network.restartRequired,false);
    assert.ok(after.agents.filter(a=>a.configured).every(a=>a.integrations[0].status==='installed'));
    assert.equal(after.diagnostics.filter(d=>d.fix?.automatic).length,0);
    assert.equal(b.h.boots,2);assert.deepEqual(b.h.restartExits,[75]);
    assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/settings/fix-all')).length,1);
    assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/settings/restart')).length,1);
    assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/settings/reauth')).length,1);
    await screenshot(p,'live-restart-reloaded-375');
  }finally{await b.close();}
});

test('real browser partial failure preserves the installed integration through GET and page reload', {skip,timeout:40000},async()=>{
  const adapter=adapterById('openclaw'),original=adapter.projectTag;
  const b=await openLive(realisticOptions),p=b.page;
  try {
    adapter.projectTag=()=>({...original(),install:(agent,options)=>{
      if(agent.id==='scribe'&&!options.dryRun)throw Error('Synthetic installation failure');
      return original().install(agent,options);
    }});
    await fix(p,b.h.password);
    assert.equal(await p.locator('[data-testid^="fix-result-applied-"]').count(),1);assert.equal(await p.locator('[data-testid^="fix-result-failed-"]').count(),1);
    await screenshot(p,'live-partial-results');
    const before=await vm(b);assert.equal(before.agents.find(a=>a.agentId==='atlas').integrations[0].status,'installed');assert.equal(before.agents.find(a=>a.agentId==='scribe').integrations[0].status,'missing');
    await p.locator('[role=dialog]').getByRole('button',{name:'Fermer',exact:true}).last().click();
    const after=await reloadSettings(b,'diagnostic');assert.equal(after.agents.find(a=>a.agentId==='atlas').integrations[0].status,'installed');assert.equal(after.agents.find(a=>a.agentId==='scribe').integrations[0].status,'missing');
    assert.equal(after.diagnostics.filter(d=>d.fix?.automatic).length,1);
  }finally{adapter.projectTag=original;await b.close();}
});
