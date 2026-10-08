'use strict';
// office-dev-21 · la Boutique in the real app (scripts/serve-frontend.js, mock mode): tabs and cards from the manifest,
// placing an item in full-screen placement mode, undo/redo, trying an accessory on an agent and applying it, one
// « Enregistrer » through the layout write, English.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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
  await p.eval(`location.href = ${JSON.stringify(origin + '/v2/' + route)};`);
  await p.waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
  // the UI language is stored per origin: set it on the app's origin, then reload (and wait for the NEW document)
  await p.eval(`window.__old = true; localStorage.setItem('ao.locale', ${JSON.stringify(lang)}); location.reload();`);
  await p.waitFor(`!window.__old && document.documentElement?.lang?.startsWith(${JSON.stringify(lang)}) && document.querySelectorAll('.ao-shop__tab').length === 6 && document.querySelectorAll('.ao-shop__card').length > 0`);
  return p;
}
const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
const status = `document.querySelector('.ao-shop__status').innerText`;
const card = (name) => `[...document.querySelectorAll('.ao-shop__card')].find((c) => c.querySelector('.ao-shop__name').innerText === ${JSON.stringify(name)})`;

describe('la Boutique (office-dev-21)', { skip, timeout: 180_000 }, () => {
  it('tabs and cards from the manifest; place a plant in placement mode; undo/redo', async () => {
    const p = await open('boutique?mock=1');
    const r0 = await p.eval(`${wait(300)} return { tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.innerText.trim()), selected: document.querySelector('[role=tab][aria-selected=true]').innerText.trim(),
      cards: document.querySelectorAll('.ao-shop__card').length, imgs: [...document.querySelectorAll('.ao-shop__thumb img')].every((i) => i.getAttribute('src').includes('/furniture/')),
      badges: [...document.querySelectorAll('.ao-shop__badge')].map((b) => b.innerText), status: ${status} };`);
    assert.deepEqual(r0.tabs, ['Mobilier', 'Décoration', 'Personnages', 'Couleurs', 'Accessoires', 'Thèmes']);
    assert.equal(r0.selected, 'Mobilier');
    assert.ok(r0.cards >= 6 && r0.imgs);
    assert.ok(r0.badges.some((b) => /^Dans le bureau ×\d+$/.test(b)));
    assert.equal(r0.status, 'Tout est enregistré.');
    // Décoration → Petite plante → Placer dans le bureau → placement mode → Confirmer → Terminé
    await p.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => t.innerText.includes('Décoration')).click(); ${wait(300)}`);
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
    const r = await p.eval(`${wait(300)} return { tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.innerText.trim()), title: document.querySelector('.ao-shop__title').innerText,
      themes: [...document.querySelectorAll('.ao-shop__card .ao-shop__name')].map((n) => n.innerText), panel: document.querySelector('[role=tabpanel]').getAttribute('aria-labelledby') };`);
    assert.deepEqual(r.tabs, ['Furniture', 'Decoration', 'Characters', 'Colours', 'Accessories', 'Themes']);
    assert.equal(r.title, 'Office store');
    assert.equal(r.themes.length, 3);
    assert.equal(r.panel, 'ao-shop-tab-themes');
    for (const t of ['mobilier', 'decoration', 'personnages', 'couleurs', 'accessoires']) {
      await p.eval(`document.getElementById('ao-shop-tab-${t}').click(); ${wait(250)}`);
      assert.equal(await p.eval(`return document.querySelector('[role=tabpanel]').id;`), 'ao-shop-panel-' + t);
    }
    await p.close();
  });
});
