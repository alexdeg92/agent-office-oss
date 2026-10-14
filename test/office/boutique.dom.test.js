'use strict';
// office-dev-21 · la Boutique in the real app (scripts/serve-frontend.js, mock mode): tabs and cards from the manifest,
// placing an item in full-screen placement mode, undo/redo, trying an accessory on an agent and applying it, one
// « Enregistrer » through the layout write, English.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('node:fs');
const { launch, findChrome } = require('./helpers/browser');
const serveFrontend = require('../../scripts/serve-frontend.js');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser, server, origin;
before(async () => {
  if (skip) return;
  browser = await launch();
  server = serveFrontend.createFrontendServer({ root: path.join(__dirname, '..', '..', 'public', 'v2'), basePath: '/v2/', apiBase: '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); await new Promise((r) => (server ? server.close(r) : r())); });

async function open(route, lang = 'fr') {
  const p = await browser.page('/');
  await p.viewport(1440,900);
  await p.eval(`location.href = ${JSON.stringify(origin + '/v2/' + route)};`);
  await p.waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
  // the UI language is stored per origin: set it on the app's origin, then reload (and wait for the NEW document)
  await p.eval(`window.__old = true; localStorage.setItem('ao.locale', ${JSON.stringify(lang)}); location.reload();`);
  await p.waitFor(`!window.__old && document.documentElement?.lang?.startsWith(${JSON.stringify(lang)}) && document.querySelectorAll('#ao-shop-section option').length === 6 && document.querySelectorAll('.ao-shop__card,[data-theme-mode]').length > 0`);
  await p.eval(`performance.setResourceTimingBufferSize(2000);`);
  return p;
}
const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
const status = `document.querySelector('.ao-shop__status').innerText`;
const card = (name) => `[...document.querySelectorAll('.ao-shop__card')].find((c) => c.querySelector('.ao-shop__name').innerText === ${JSON.stringify(name)})`;

// A selection finishes when the returned VM has been committed to the frame.
async function chooseSection(p,value) {
  await p.eval(`const s=document.querySelector('#ao-shop-section');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
  await p.waitFor(`document.querySelector('.ao-shop')?.dataset.storeSection===${JSON.stringify(value)} && document.querySelector('.ao-shop')?.dataset.storeCategory===''`);
}
async function chooseCategory(p,value) {
  await p.eval(`const s=document.querySelector('#ao-shop-category');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
  await p.waitFor(`document.querySelector('.ao-shop')?.dataset.storeCategory===${JSON.stringify(value)}`);
}

describe('la Boutique (office-dev-21)', { skip, timeout: 180_000 }, () => {
  it('Bureau section/category dropdowns share one row; backend filtering restores all three catalogues', async () => {
    const p=await open('boutique?mock=1');
    assert.equal(await p.eval(`return performance.getEntriesByType('resource').some(e=>e.name.includes('/office/themes-panel.js'));`),false);
    for(const width of [1440,390]) {
      await p.viewport(width,width===390?844:900);
      for(const section of ['mobilier','decoration','accessoires']) {
        await chooseSection(p,section);
        await p.waitFor(`document.querySelector('#ao-shop-section').value==='${section}' && document.querySelector('#ao-shop-category') && !document.querySelector('#ao-shop-category').hasAttribute('aria-busy')`);
        const state=await p.eval(`const section=document.querySelector('#ao-shop-section'),category=document.querySelector('#ao-shop-category'),a=section.getBoundingClientRect(),b=category.getBoundingClientRect();return {sameRow:Math.abs(a.top-b.top)<1,gap:b.left-a.right,fits:a.left>=0&&b.right<=innerWidth,noPage:document.scrollingElement.scrollHeight===innerHeight,styled:!!document.querySelector('link[data-bureau-controls-css]')?.sheet,all:document.querySelectorAll('.ao-shop__card').length,floor:!!document.querySelector('#ao-shop-floor')};`);
        assert.ok(state.sameRow&&state.gap>=7&&state.fits&&state.noPage&&state.styled,JSON.stringify(state));
        assert.equal(state.floor,section!=='accessoires');
        await chooseCategory(p,await p.eval(`return document.querySelector('#ao-shop-category').options[1].value;`));
        await p.waitFor(`document.querySelectorAll('.ao-shop__card').length<${state.all}`);
        await chooseCategory(p,'');
        await p.waitFor(`document.querySelectorAll('.ao-shop__card').length===${state.all}`);
      }
    }
    await chooseSection(p,'themes');
    await p.waitFor(`document.querySelectorAll('[data-theme-mode]').length===3 && document.querySelector('.ao-theme-preview .ao-office')`);
    assert.equal(await p.eval(`return !!document.querySelector('#ao-shop-floor');`),false);await p.close();
  });
  it('section dropdown remains in the viewport in French/English at 320px', async () => {
    for(const lang of ['fr','en']) {
      const p=await open('boutique?mock=1&onglet=accessoires',lang);await p.viewport(320,844);
      for(const section of ['mobilier','decoration','personnages','couleurs','accessoires','themes']) {
        await chooseSection(p,section);
        await p.waitFor(`document.querySelector('#ao-shop-section').value==='${section}' && document.querySelector('#ao-shop-panel-${section}')`);
        assert.ok(await p.eval(`const r=document.querySelector('#ao-shop-section').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;`));
      }
      await p.close();
    }
  });
  it('production décor: thumbnails first, eight categories, authored rotation, mobile placement, undo/redo and save', async () => {
    const p = await open('boutique?mock=1');
    const evidence=path.join(__dirname,'../../design/reports/decor-02');
    const initial=await p.eval(`return performance.getEntriesByType('resource').filter(e=>e.name.includes('/Decor/')).map(e=>e.name);`);
    assert.ok(initial.every(u=>u.includes('/thumbnails/')),JSON.stringify(initial));
    const samples=[['mobilier','Bureau debout'],['mobilier','Fauteuil'],['mobilier','Bibliothèque haute'],['mobilier','Réfrigérateur'],['decoration','Monstera'],['decoration','Lampadaire arqué'],['decoration','Cadre géométrique'],['decoration','Tapis rond']];
    const filters=['Postes','Assises','Rangement','Équipement','Plantes','Déco','Mur','Sol'];
    for(let i=0;i<samples.length;i++){
      const [tab,name]=samples[i];
      if(i===4){await p.viewport(390,844);await p.emulateTouch();}
      await chooseSection(p,tab);
      await p.waitFor(`[...document.querySelectorAll('#ao-shop-category option')].some(o=>o.textContent===${JSON.stringify(filters[i])})`);
      await chooseCategory(p,await p.eval(`return [...document.querySelector('#ao-shop-category').options].find(o=>o.textContent===${JSON.stringify(filters[i])}).value;`));
      await p.waitFor(`${card(name)}`);
      await p.eval(`${card(name)}.click();`);
      await p.waitFor(`document.querySelector('.ao-shop__sheetactions .bu-btn--primary')&&!document.querySelector('.ao-shop__sheetactions .bu-btn--primary').disabled`);
      await p.eval(`document.querySelector('.ao-shop__sheetactions .bu-btn--primary').click();`);
      await p.waitFor(`document.querySelector('.ao-place .ao-office')&&!document.querySelector('.ao-place__actions .bu-btn--primary').disabled`);
      if(i===0){
        await p.eval(`[...document.querySelectorAll('.ao-place__actions button')].find(b=>b.innerText.includes('Pivoter')).click();`);
        await p.waitFor(`document.querySelector('.ao-place img[src*="standing-desk-se-day"]')?.naturalWidth>0`);
        fs.writeFileSync(path.join(evidence,'store-standing-desk-se.png'),await p.screenshot());
      }
      if(i===7)fs.writeFileSync(path.join(evidence,'store-mobile-rug.png'),await p.screenshot());
      if(i===7){const point=await p.eval(`const r=document.querySelector('.ao-place__actions .bu-btn--primary').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];`);await p.touch('touchStart',[point]);await p.touch('touchEnd',[]);}
      else await p.eval(`document.querySelector('.ao-place__actions .bu-btn--primary').click();`);
      await p.waitFor(`document.querySelector('.ao-place__hint').innerText.includes('placé')`);
      await p.eval(`[...document.querySelectorAll('.ao-place__actions button')].find(b=>b.innerText.includes('Terminé')).click();`);
      await p.waitFor(`!document.querySelector('.ao-place')`);
      assert.equal(await p.eval(`return ${status};`),'Une modification non enregistrée.');
      await p.eval(`document.querySelector('.ao-shop__saverow [aria-label^="Annuler"]').click();`);
      await p.waitFor(`${status}==='Tout est enregistré.'`);
      if(i===7){await p.eval(`document.querySelector('.ao-shop__saverow [aria-label^="Rétablir"]').click();`);await p.waitFor(`${status}==='Une modification non enregistrée.'`);await p.eval(`document.querySelector('.ao-shop__saverow .bu-btn--primary').click();`);await p.waitFor(`${status}==='Tout est enregistré.'`);}
    }
    await p.eval(`if(!document.querySelector('.ao-shop__sheetactions'))${card('Tapis rond')}.click();`);
    await p.waitFor(`document.querySelector('.ao-shop__sheetactions')`);
    await p.eval(`[...document.querySelectorAll('.ao-shop__sheetactions button')].find(b=>b.innerText.includes('Déplacer')).click();`);
    await p.waitFor(`document.querySelector('.ao-place .ao-office')`);
    await p.eval(`[...document.querySelectorAll('.ao-place__actions button')].find(b=>b.innerText.includes('Retirer')).click();`);
    await p.waitFor(`document.querySelector('.ao-place__hint').innerText.includes('retiré')`);
    await p.key('Escape');await p.waitFor(`!document.querySelector('.ao-place')`);
    await p.eval(`document.querySelector('.ao-shop__saverow .bu-btn--primary').click();`);
    await p.waitFor(`${status}==='Tout est enregistré.'`);
    await p.close();
  });
  it('tabs and cards from the manifest; place a plant in placement mode; undo/redo', async () => {
    const p = await open('boutique?mock=1');
    const r0 = await p.eval(`${wait(300)} return { tabs: [...document.querySelectorAll('#ao-shop-section option')].map((t) => t.textContent.trim()), selected: document.querySelector('#ao-shop-section option:checked').textContent.trim(),
      cards: document.querySelectorAll('.ao-shop__card').length, imgs: [...document.querySelectorAll('.ao-shop__thumb img')].every((i) => i.getAttribute('src').includes('/furniture/') || (i.getAttribute('src').includes('/Decor/') && i.getAttribute('src').includes('/thumbnails/'))),
      badges: [...document.querySelectorAll('.ao-shop__badge')].map((b) => b.innerText), status: ${status} };`);
    assert.deepEqual(r0.tabs, ['Mobilier', 'Décoration', 'Personnages', 'Couleurs', 'Accessoires', 'Thèmes']);
    assert.equal(r0.selected, 'Mobilier');
    assert.ok(r0.cards >= 6 && r0.imgs);
    assert.ok(r0.badges.some((b) => /^Dans le bureau ×\d+$/.test(b)));
    assert.equal(r0.status, 'Tout est enregistré.');
    // Décoration → Petite plante → Placer dans le bureau → placement mode → Confirmer → Terminé
    await chooseSection(p,'decoration');
    const before = await p.eval(`return ${card('Petite plante')}.querySelector('.ao-shop__badge').innerText;`);
    await p.eval(`${card('Petite plante')}.click(); ${wait(200)} document.querySelector('.ao-shop__sheetactions .bu-btn--primary').click();`);
    await p.waitFor(`document.querySelector('.ao-place .ao-office') && location.search.includes('placer=plant-small')`);
    const pl = await p.eval(`${wait(600)} return { title: document.querySelector('.ao-place__title').innerText, ok: !document.querySelector('.ao-place__actions .bu-btn--primary').disabled,
      full: document.querySelector('.ao-place').getBoundingClientRect().height === innerHeight };`);
    assert.deepEqual(pl, { title: 'Placer : Petite plante', ok: true, full: true });
    await p.eval(`document.querySelector('.ao-place__actions .bu-btn--primary').click(); ${wait(300)}`);
    assert.match(await p.eval(`return document.querySelector('.ao-place__hint').innerText;`), /Petite plante placé/);
    await p.eval(`[...document.querySelectorAll('.ao-place__actions .bu-btn')].find((b) => b.innerText.includes('Terminé')).click();`);
    await p.waitFor(`!document.querySelector('.ao-place') && !location.search.includes('placer=')`);
    const after1 = await p.eval(`${wait(200)} return { badge: ${card('Petite plante')}.querySelector('.ao-shop__badge').innerText, status: ${status} };`);
    assert.notEqual(after1.badge, before);
    assert.equal(after1.status, 'Une modification non enregistrée.');
    await p.eval(`document.querySelector('.ao-shop__saverow [aria-label^="Annuler"]').click(); ${wait(200)}`);
    assert.equal(await p.eval(`return ${card('Petite plante')}.querySelector('.ao-shop__badge').innerText;`), before, 'undo');
    await p.eval(`document.querySelector('.ao-shop__saverow [aria-label^="Rétablir"]').click(); ${wait(200)}`);
    assert.equal(await p.eval(`return ${status};`), 'Une modification non enregistrée.', 'redo');
    await p.close();
  });

  it('new shared accessory previews, owner choice, slot dropdown and save work on mobile', async () => {
    const p=await open('boutique?mock=1&onglet=accessoires');await p.viewport(390,844);
    assert.equal(await p.eval(`return document.querySelectorAll('.ao-shop__card').length;`),15);
    await p.eval(`${card('Bonnet')}.click();`);
    await p.waitFor(`document.querySelector('.ao-shop__previewfig img[src^="data:"]')?.naturalWidth===192 && !document.querySelector('.ao-shop__previewtext .bu-btn--primary').disabled`);
    const dir=path.join(__dirname,'../../design/reports/accessories-02');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'mobile-beanie-preview.png'),await p.screenshot());
    await p.eval(`document.querySelector('.ao-shop__previewtext .bu-btn--primary').click();`);
    await p.waitFor(`${card('Bonnet')}.querySelector('.ao-shop__badge').innerText==='Porté'`);
    await chooseCategory(p,'neck');
    await p.waitFor(`document.querySelectorAll('.ao-shop__card').length===4`);
    assert.equal(await p.eval(`return !!${card('Cravate')};`),true);
    await chooseCategory(p,'');await p.eval(`document.querySelector('.ao-shop__saverow .bu-btn--primary').click();`);
    await p.waitFor(`${status}==='Tout est enregistré.'`);
    assert.equal(await p.eval(`return ${card('Bonnet')}.querySelector('.ao-shop__badge').innerText;`),'Porté');
    await p.close();
  });
  it('try an accessory on a chosen agent (live preview), apply it, and save once', async () => {
    const p = await open('boutique?mock=1&onglet=accessoires');
    const r = await p.eval(`${wait(300)}
      const chips = [...document.querySelectorAll('.ao-shop__chip')];
      chips[1].click(); ${wait(300)}
      const who = document.querySelector('.ao-shop__previewname').innerText;
      const c = [...document.querySelectorAll('.ao-shop__card')].find((x) => !x.querySelector('.ao-shop__badge').classList.contains('is-on'));
      const item = c.querySelector('.ao-shop__name').innerText;
      const layersBefore = document.querySelectorAll('.ao-shop__previewfig img').length;
      c.click(); ${wait(300)}
      const tryText = document.querySelector('.ao-shop__previewtext [aria-live]').innerText;
      const layersTry = document.querySelectorAll('.ao-shop__previewfig img').length;
      document.querySelector('.ao-shop__previewtext .bu-btn--primary').click(); ${wait(300)}
      const badge = [...document.querySelectorAll('.ao-shop__card')].find((x) => x.querySelector('.ao-shop__name').innerText === item).querySelector('.ao-shop__badge').innerText;
      return { chips: chips.length, checked: chips[1].getAttribute('aria-checked'), who, item, tryText, layersBefore, layersTry, badge, agentQ: location.search.includes('agent='), status: ${status} };`);
    assert.ok(r.chips >= 2);
    assert.equal(r.checked, 'true'); assert.ok(r.agentQ, 'the agent is in the URL');
    assert.equal(r.tryText, `Essai : ${r.item}.`);
    assert.ok(r.layersTry >= r.layersBefore, 'the preview shows the item');
    assert.equal(r.badge, 'Porté');
    assert.equal(r.status, 'Une modification non enregistrée.');
    await p.eval(`[...document.querySelectorAll('.ao-shop__saverow .bu-btn--primary')][0].click();`);
    await p.waitFor(`document.querySelector('.ao-shop__status').innerText === 'Tout est enregistré.'`, 10000);
    await p.close();
  });

  it('an item already in the office: « Déplacer ou retirer » selects it in placement mode; Retirer removes it (undoable)', async () => {
    const p = await open('boutique?mock=1&onglet=decoration');
    const before = await p.eval(`${wait(200)} return ${card('Grande plante')}.querySelector('.ao-shop__badge').innerText;`);
    assert.match(before, /^Dans le bureau/);
    await p.eval(`${card('Grande plante')}.click(); ${wait(200)} [...document.querySelectorAll('.ao-shop__sheetactions .bu-btn')].find((b) => b.innerText.includes('Déplacer')).click();`);
    await p.waitFor(`document.querySelector('.ao-place .ao-office')`);
    const r = await p.eval(`${wait(400)} return { title: document.querySelector('.ao-place__title').innerText, actions: [...document.querySelectorAll('.ao-place__actions .bu-btn')].map((b) => b.innerText.trim()),
      selected: !!document.querySelector('.ao-place .ao-office [data-item].is-selected, .ao-place .ao-office .is-selected') };`);
    assert.deepEqual(r.actions, ['Pivoter', 'Retirer', 'Terminé']);
    await p.eval(`[...document.querySelectorAll('.ao-place__actions .bu-btn')].find((b) => b.innerText.includes('Retirer')).click(); ${wait(300)}`);
    assert.match(await p.eval(`return document.querySelector('.ao-place__hint').innerText;`), /retiré/);
    await p.key('Escape');
    await p.waitFor(`!document.querySelector('.ao-place')`);
    const after = await p.eval(`${wait(200)} return { badge: ${card('Grande plante')}.querySelector('.ao-shop__badge').innerText, status: ${status} };`);
    assert.notEqual(after.badge, before);
    assert.equal(after.status, 'Une modification non enregistrée.');
    await p.close();
  });

  it('English; Thèmes; every tab has its panel', async () => {
    const p = await open('boutique?mock=1&onglet=themes', 'en');
    const r = await p.eval(`${wait(300)} return { tabs: [...document.querySelectorAll('#ao-shop-section option')].map((t) => t.textContent.trim()), title: document.querySelector('.bu-topbar__title').innerText,
      themes: [...document.querySelectorAll('[data-theme-mode] .ao-theme-mode__label')].map((n) => n.innerText), panel: document.querySelector('[role=region][id^=ao-shop-panel-]').getAttribute('aria-labelledby') };`);
    assert.deepEqual(r.tabs, ['Furniture', 'Decoration', 'Characters', 'Colours', 'Accessories', 'Themes']);
    assert.equal(r.title, 'Store');
    assert.equal(r.themes.length, 3);
    assert.equal(r.panel, 'ao-shop-section');
    for (const t of ['mobilier', 'decoration', 'personnages', 'couleurs', 'accessoires']) {
      await chooseSection(p,t);
      assert.equal(await p.eval(`return document.querySelector('[role=region][id^=ao-shop-panel-]').id;`), 'ao-shop-panel-' + t);
      if (t === 'mobilier' || t === 'decoration' || t === 'accessoires') assert.equal(await p.eval(`return document.querySelector('#ao-shop-category').selectedOptions[0].textContent;`), 'All');
    }
    await p.close();
  });
});
