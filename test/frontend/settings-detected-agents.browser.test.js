import test from 'node:test';
import assert from 'node:assert/strict';
import { openLive, skip, tab } from './helpers/settings-live-browser.js';
import { realisticOptions } from './helpers/settings-real-home.js';

test('detected agents stay informational and Voir opens the filtered highlighted connector in French and English', {skip,timeout:45000}, async()=>{
  const detect=async context=>{
    const rows=await realisticOptions.detect(context);
    return rows.map(row=>row.runtime==='codex'?{...row,agents:[{id:'test-codex-101154',name:'Synthetic Codex'}]}:row);
  };
  const b=await openLive({...realisticOptions,detect,effectiveV3:true}),p=b.page;
  try {
    b.h.store.runtimeAutoAdd.setEnabled('codex',false);
    await tab(p,'agents');
    await p.getByRole('button',{name:'Relancer la détection',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
    await tab(p,'diagnostic');
    const summary=p.locator('[data-testid="diagnostic-detected-agents:codex"]');
    await summary.waitFor();
    assert.match(await summary.innerText(),/1 agent détecté · Codex/);
    assert.equal(await summary.getByRole('img',{name:'Information'}).count(),1);
    assert.equal(await summary.getByRole('button').count(),1);
    await summary.getByRole('button',{name:/^Voir/}).click();
    await p.locator('#settings-tab-agents[aria-selected="true"]').waitFor();
    await p.waitForFunction(()=>location.search.includes('onglet=agents')&&location.search.includes('connecteur=codex'));
    const detected=p.locator('[data-testid="settings-unconfigured-agent-test-codex-101154"]');
    await detected.waitFor();
    await p.waitForFunction(()=>document.activeElement?.dataset?.fixTarget==='true');
    assert.ok(await detected.getAttribute('data-fix-target'));
    assert.equal(await p.locator('[role="status"]').filter({hasText:'élément à corriger'}).count(),0,'agent discovery did not create a fix count');

    await detected.getByRole('button',{name:'Ajouter au bureau'}).click();
    await p.getByRole('button',{name:'Actions de Synthetic Codex'}).click();
    await p.getByRole('menuitem',{name:'Définir comme principal'}).click();
    const draftRow=p.locator('[data-testid^="settings-agent-row-"]').filter({hasText:'Synthetic Codex'});
    await draftRow.locator('.ao-settings__role').waitFor();
    await tab(p,'diagnostic');
    await p.locator('[data-testid="diagnostic-detected-agents:codex"]').getByRole('button',{name:/^Voir/}).click();
    await p.locator('[data-testid^="settings-agent-row-"]').filter({hasText:'Synthetic Codex'}).locator('.ao-settings__role').waitFor();
    assert.equal(await p.getByRole('dialog').count(),0,'same-connector navigation preserves the dirty draft without prompting');

    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('en');});
    await tab(p,'diagnostic');
    const english=p.locator('[data-testid="diagnostic-detected-agents:codex"]');
    await english.waitFor();
    assert.match(await english.innerText(),/1 agent detected · Codex/);
    assert.equal(await english.getByRole('button',{name:/^View/}).count(),1);
    assert.ok(!/settings\./.test(await english.innerText()));

    await p.evaluate(async()=>{const {chooseLang}=await import('/lang.js?v='+document.querySelector('meta[name=ao-build]').content);await chooseLang('fr');});
    await tab(p,'diagnostic');
    const integration=p.locator('[data-testid^="diagnostic-agent"]').filter({hasText:'Atlas'}).first();
    if (await integration.count()) {
      const action=integration.getByRole('button',{name:/^Installer/});
      if (await action.count()) {
        await action.click();
        await p.locator('#settings-tab-connexion[aria-selected="true"]').waitFor();
        await p.waitForFunction(()=>document.activeElement?.dataset?.fixTarget==='true');
        assert.ok(await p.locator('[data-fix-target="true"]').count(),'integration fixes point to their exact agent/integration row');
      }
    }
  } finally { await b.close(); }
});
