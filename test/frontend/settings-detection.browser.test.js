import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openLive, skip, tab, reloadSettings, idle } from './helpers/settings-live-browser.js';
import { realisticOptions } from './helpers/settings-real-home.js';

for (const automaticDetection of [false, true]) test('Settings discovery shows truthful '+(automaticDetection?'boot/cached':'unchecked')+' evidence and one OpenClaw card', {skip,timeout:30000}, async () => {
  const b=await openLive({...realisticOptions,effectiveV3:true,automaticDetection}),p=b.page;
  try {
    await tab(p,'agents');
    assert.equal(await p.locator('[data-testid=settings-runtime-legacy]').count(),1);
    assert.equal(await p.locator('[data-testid=settings-runtime-openclaw]').count(),0);
    assert.equal(await p.locator('[data-testid=settings-runtime-demo]').count(),0);
    let card=p.locator('[data-testid=settings-runtime-legacy]');await card.locator('summary').click();
    if (!automaticDetection) {
      assert.ok((await card.innerText()).includes('Pas encore vérifié'));
      assert.ok((await card.innerText()).includes('Détection pas encore effectuée.'));
      assert.ok(!(await card.innerText()).includes('Aucune installation'));
    } else {
      assert.ok((await card.innerText()).includes('Détecté'));
      assert.equal(await card.locator('[data-detection-checked-at]').count(),1);
      const before=await card.locator('[data-detection-checked-at]').getAttribute('data-detection-checked-at');
      await reloadSettings(b,'agents');
      assert.equal(await card.locator('[data-detection-checked-at]').getAttribute('data-detection-checked-at'),before);
      assert.equal(b.requests.filter(r=>r.path.endsWith('/settings/detect')).length,0,'open/reload never needs a manual POST');
    }
    if (process.env.SETTINGS_SCREENSHOTS==='1') {
      fs.mkdirSync('design/reports/t0027',{recursive:true});
      await card.screenshot({path:'design/reports/t0027/openclaw-'+(automaticDetection?'boot':'unchecked')+'.png'});
    }
    fs.rmSync(path.join(b.h.tmp,'.codex'),{recursive:true});
    await p.getByRole('button',{name:'Relancer la détection',exact:true}).click(); await idle(p);
    assert.ok((await p.locator('[data-testid=settings-runtime-codex]').innerText()).includes('Non détecté'));
    await p.locator('[data-testid=settings-runtime-codex] summary').click();
    assert.ok((await p.locator('[data-testid=settings-runtime-codex]').innerText()).includes('Aucune installation trouvée'));
    assert.equal(await p.locator('[data-testid=settings-runtime-legacy]').count(),1);
    assert.equal(await p.locator('[data-testid=settings-runtime-openclaw]').count(),0);
    assert.equal(await p.locator('[data-testid=settings-runtime-demo]').count(),0);
    assert.ok(!(await p.locator('.ao-settings').innerText()).includes('settings.detection.'));
    if (process.env.SETTINGS_SCREENSHOTS==='1') {
      fs.mkdirSync('design/reports/t0027',{recursive:true});
      await card.screenshot({path:'design/reports/t0027/openclaw-one-card-'+automaticDetection+'.png'});
      await p.screenshot({path:'design/reports/t0027/runtimes-'+automaticDetection+'.png'});
    }
    for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
      await p.setViewportSize(viewport);
      const frame=await p.evaluate(()=>({doc:document.scrollingElement.scrollHeight,height:innerHeight,width:document.scrollingElement.scrollWidth,viewport:innerWidth,titles:document.querySelectorAll('main h1').length}));
      assert.ok(frame.doc<=frame.height+1);assert.ok(frame.width<=frame.viewport+1);assert.equal(frame.titles,0);
    }
  } finally {await b.close();}
});
