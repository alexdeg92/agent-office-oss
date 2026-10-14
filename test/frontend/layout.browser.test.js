import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { browserSkipReason, openLayoutBrowser, routes, visit } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const bars = '.ao-frame__head, .ao-frame__bar, .ao-frame__foot, .bu-topbar, .bu-mtopbar, .bu-bottombar, .ao-sidebar-foot';
const viewport = page => page.evaluate(() => ({
  height: document.scrollingElement.scrollHeight, width: document.scrollingElement.scrollWidth,
  vh: innerHeight, vw: innerWidth, y: scrollY,
}));
const rectangles = page => page.locator(bars).evaluateAll(elements => elements
  .map(e => e.getBoundingClientRect().toJSON()).filter(r => r.width && r.height));
function bounded(v, label) {
  assert.ok(v.height <= v.vh, `${label}: document height ${v.height} exceeds ${v.vh}`);
  assert.ok(v.width <= v.vw, `${label}: document width ${v.width} exceeds ${v.vw}`);
  assert.equal(v.y, 0, `${label}: document must never scroll`);
}

async function footerEdges(page, label) {
  const edges = await page.locator('.ao-frame__foot').evaluateAll(elements => elements.filter(e => e.children.length && e.getBoundingClientRect().height).map(e => ({
    cls: e.parentElement.className,
    gap: e.parentElement.getBoundingClientRect().bottom - parseFloat(getComputedStyle(e.parentElement).borderBottomWidth || 0) - e.getBoundingClientRect().bottom,
  })));
  for (const edge of edges) assert.ok(Math.abs(edge.gap) <= 1, `${label}: ${edge.cls} footer gap ${edge.gap}`);
}

for (const [width, height] of [[1440, 900], [390, 844], [375, 667]]) {
  test(`shared frame: every route at ${width}×${height}`, { skip, timeout: 120_000 }, async t => {
    const h = await openLayoutBrowser();
    try {
      await h.page.setViewportSize({ width, height });
      for (const [name, path, ready] of routes) await t.test(name, async () => {
        await visit(h.page, h.origin, path, ready);
        bounded(await viewport(h.page), name);
        // Density fixture: repeat rendered mock content inside each independent body. No viewport/style
        // overrides: short/empty routes must obey the same contract once their real content grows.
        const count = await h.page.locator('[data-scroll-body]').evaluateAll(elements => {
          const visible = elements.filter(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).overflowY === 'auto');
          visible.forEach((body, i) => {
            body.dataset.layoutProbe = String(i);
            const sample = [...body.children].find(e => e.getBoundingClientRect().height > 0);
            for (let n = 0; body.scrollHeight <= body.clientHeight + 200 && n < 100; n++) {
              const row = sample ? sample.cloneNode(true) : document.createElement('p');
              row.removeAttribute('id'); row.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
              if (!sample) row.textContent = `Élément de vérification ${n + 1}`;
              body.append(row);
            }
            body.scrollTop = 0;
          });
          return visible.length;
        });
        assert.ok(count > 0, `${name}: a visible frame body must own scrolling`);
        bounded(await viewport(h.page), `${name} dense content`);
        await footerEdges(h.page, name + ' long');
        const before = await rectangles(h.page);
        for (let i = 0; i < count; i++) {
          const body = h.page.locator(`[data-layout-probe="${i}"]`);
          const range = await body.evaluate(e => ({ height: e.clientHeight, max: e.scrollHeight - e.clientHeight, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }));
          assert.ok(range.top >= 0 && range.bottom <= height + 1, `${name}: body ${i} remains inside the viewport`);
          assert.ok(range.height > 0 && range.max > 0, `${name}: content remains accessible in body ${i}`);
          await body.evaluate(e => { e.scrollTop = e.scrollHeight; });
          assert.ok(await body.evaluate(e => e.scrollTop > 0), `${name}: body ${i} scrolls to its end`);
        }
        bounded(await viewport(h.page), `${name} at end`);
        assert.deepEqual(await rectangles(h.page), before, `${name}: heads, footers and shell bars stay put`);
        await footerEdges(h.page, name + ' after scrolling');
        await h.page.locator('[data-layout-probe]').evaluateAll(bodies => bodies.forEach(e => e.replaceChildren()));
        await footerEdges(h.page, name + ' short');
        assert.ok(before.every(r => r.top >= 0 && r.bottom <= height + 1), `${name}: bars stay inside the viewport`);
      });
    } finally { await h.close(); }
  });
}

test('frame footers preserve form submission; wheel scrolling reaches Store content', { skip, timeout: 30_000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    await h.page.setViewportSize({ width: 390, height: 844 });
    await visit(h.page, h.origin, '/boutique?onglet=personnages', '.ao-shop__savebar');
    const body = h.page.locator('.ao-shop__catalogue');
    await body.evaluate(e => { e.scrollTop = 0; });
    const box = await body.boundingBox();
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await h.page.mouse.wheel(0, 400);
    await h.page.waitForFunction(() => document.querySelector('.ao-shop__catalogue').scrollTop > 0, null, { timeout: 5000 });
    bounded(await viewport(h.page), 'Store wheel');

    await visit(h.page, h.origin, '/?mock=installation', '#setup-code');
    assert.equal(await h.page.locator('.ao-setup__nav button[type=submit]').evaluate(e => e.form?.id), 'setup-form');
    await h.page.locator('.ao-setup__nav button[type=submit]').click();
    await h.page.locator('#setup-erreur').waitFor({ state: 'visible' });

    await visit(h.page, h.origin, '/flux/ffffffff-0c01-4000-8000-000000000001', '.ao-flow');
    await h.page.locator('[aria-controls=fl-edit-form]').click();
    await h.page.locator('#flow-edit').waitFor({ state: 'visible' });
    const save = h.page.locator('#fl-edit-form > .ao-frame__foot button[type=submit]');
    assert.equal(await save.evaluate(e => e.form?.id), 'flow-edit');
    await h.page.locator('#flow-edit input[name=name]').fill('');
    await save.click();
    await h.page.locator('#flow-edit [aria-invalid=true]').first().waitFor({ state: 'visible' });
    bounded(await viewport(h.page), 'flow form error');
  } finally { await h.close(); }
});

// A reduced visual viewport models browser chrome/keyboard changes without a route-specific vh calculation.
test('shared frame follows a reduced mobile viewport', { skip, timeout: 30_000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    for (const size of [{ width: 390, height: 480 }, { width: 720, height: 640 }]) {
      await h.page.setViewportSize(size);
      for (const name of ['store', 'chat', 'setup', 'login']) {
        const [, path, ready] = routes.find(r => r[0] === name);
        await visit(h.page, h.origin, path, ready);
        bounded(await viewport(h.page), `${name} reduced viewport`);
        assert.ok((await rectangles(h.page)).every(r => r.top >= 0 && r.bottom <= size.height + 1), `${name}: reduced viewport bars remain visible`);
      }
    }
  } finally { await h.close(); }
});

for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844], [375, 667]]) {
  test(`Store fixed rows and preview: ${theme} ${width}×${height}`, { skip, timeout: 30_000 }, async () => {
    const h = await openLayoutBrowser({ theme, touch: width < 800 });
    try {
      await h.page.setViewportSize({ width, height });
      await visit(h.page, h.origin, '/boutique?onglet=personnages', '.ao-shop__savebar');
      assert.equal(await h.page.locator('.ao-shop__title, .ao-shop__lede').count(), 0);
      const shell = await h.page.locator('.bu-shell').evaluate(e => ({ position: getComputedStyle(e).position, height: e.getBoundingClientRect().height }));
      assert.equal(shell.position, 'fixed'); assert.equal(shell.height, height);
      assert.equal(await h.page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehavior), 'none');
      assert.match(await h.page.locator('meta[name=viewport]').getAttribute('content'), /interactive-widget=resizes-content/);
      const fixed = h.page.locator('.ao-shop__navigation, .ao-shop__agents, .ao-shop__preview, .ao-shop__savebar, .bu-bottombar');
      const boxes = () => fixed.evaluateAll(es => es.map(e => e.getBoundingClientRect().toJSON()).filter(r => r.height));
      const before = await boxes();
      const catalogue = h.page.locator('.ao-shop__catalogue');
      await catalogue.evaluate(e => { const ul = e.querySelector('ul'); const row = ul.firstElementChild; for(let i=0;i<20;i++) ul.append(row.cloneNode(true)); e.scrollTop=0; });
      assert.equal(await catalogue.evaluate(e => getComputedStyle(e).overscrollBehavior), 'contain');
      const box = await catalogue.boundingBox();
      if (width < 800) {
        await h.page.touchscreen.tap(box.x + box.width - 3, box.y + box.height / 2);
        const cdp = await h.page.context().newCDPSession(h.page);
        const x = box.x + box.width / 2, y = box.y + box.height - 30;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * Math.min(25, (box.height - 60) / 10) }] });
          await h.page.waitForTimeout(25);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await h.page.waitForFunction(() => document.querySelector('.ao-shop__catalogue').scrollTop > 0, null, { timeout: 5000 });
        await cdp.detach();
      }
      for (const end of ['bottom', 'top']) {
        await catalogue.evaluate((e, end) => { e.scrollTop = end === 'bottom' ? e.scrollHeight : 0; }, end);
        await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await h.page.mouse.wheel(0, end === 'bottom' ? 500 : -500);
        await h.page.waitForTimeout(150);
        bounded(await viewport(h.page), `Store ${end}`);
        assert.deepEqual(await boxes(), before, 'tabs, chips, preview, footer and nav stay fixed');
        await footerEdges(h.page, `Store ${end}`);
      }
      const scrollOwners = await h.page.locator('.ao-shop *').evaluateAll(es => es.filter(e => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)).map(e => e.className));
      assert.equal(scrollOwners.length, 1, `one Store vertical scroller: ${scrollOwners}`);
      assert.match(scrollOwners[0], /ao-shop__catalogue/);
      await visit(h.page, h.origin, '/boutique?onglet=themes', '.ao-shop__savebar');
      await footerEdges(h.page, 'Store Themes short content');
      const storeEdges = await h.page.locator('.ao-shop').evaluate(e => ({ frame: e.getBoundingClientRect().bottom, footer: e.querySelector('.ao-shop__savebar').getBoundingClientRect().bottom, main: document.querySelector('#contenu').getBoundingClientRect().bottom }));
      assert.equal(storeEdges.footer, storeEdges.frame); assert.equal(storeEdges.frame, storeEdges.main);
      assert.equal(await h.page.locator('[data-theme-mode]').count(), 3);
      await footerEdges(h.page, 'Store three-mode catalogue');
      await h.page.locator('.ao-theme-controls').evaluate(e => { for (const child of [...e.children].slice(1)) child.remove(); });
      assert.ok(await h.page.locator('.ao-shop__catalogue').evaluate(e => e.scrollHeight <= e.clientHeight), 'nonempty short fixture actually fits');
      await footerEdges(h.page, 'Store nonempty short catalogue');
      await h.page.locator('.ao-shop__catalogue').evaluate(e => e.replaceChildren());
      await footerEdges(h.page, 'Store empty catalogue');
    } finally { await h.close(); }
  });
}

test('one title per page and frame scroll resets on route and tab changes', { skip, timeout: 60_000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    for (const [name, path, ready] of routes.filter(r => !['login', 'setup'].includes(r[0]))) {
      await visit(h.page, h.origin, path, ready);
      const duplicates = await h.page.evaluate(() => {
        const title = [...document.querySelectorAll('.bu-topbar__title')].find(e => e.getBoundingClientRect().height)?.textContent.trim();
        return [...document.querySelectorAll('#contenu h1,#contenu h2')].filter(e => e.getBoundingClientRect().height && e.textContent.trim() === title).map(e => e.outerHTML);
      });
      assert.deepEqual(duplicates, [], `${name}: topbar title isn't repeated`);
    }
    await visit(h.page, h.origin, '/boutique?onglet=personnages', '.ao-shop__savebar');
    await h.page.evaluate(() => { window.__windowScrollCalls = 0; window.scrollTo = () => { window.__windowScrollCalls++; }; });
    await h.page.locator('.ao-shop__catalogue').evaluate(e => { const ul=e.querySelector('ul'); for(let i=0;i<20;i++)ul.append(ul.firstElementChild.cloneNode(true)); e.scrollTop=e.scrollHeight; });
    await h.page.locator('[role=tab]').filter({ hasText: 'Thèmes' }).click();
    await h.page.waitForFunction(() => document.querySelector('.ao-shop__catalogue')?.scrollTop === 0);
    await h.page.locator('.ao-shop__back').click();
    await h.page.locator('.ao-bureau__stage').waitFor();
    bounded(await viewport(h.page), 'route change');
    await h.page.goBack();
    await h.page.locator('.ao-shop__savebar').waitFor();
    await h.page.waitForFunction(() => document.querySelector('.ao-shop__catalogue')?.scrollTop === 0);
    assert.equal(await h.page.evaluate(() => window.__windowScrollCalls), 0);
    bounded(await viewport(h.page), 'history navigation');
  } finally { await h.close(); }
});

test('dialog frames contain long content and retain focus and footer actions', { skip, timeout: 30_000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    for (const size of [{ width: 1440, height: 900 }, { width: 375, height: 667 }]) {
      await h.page.setViewportSize(size);
      await visit(h.page, h.origin, '/projets', '[data-card]');
      const opener = h.page.getByRole('button', { name: 'Nouveau projet', exact: true }).first();
      await opener.click();
      const dialog = h.page.getByRole('dialog');
      await dialog.waitFor();
      await h.page.locator('#np-name').waitFor();
      await dialog.evaluate(async e => { await Promise.all(e.getAnimations().map(a => a.finished)); });
      assert.equal(await h.page.locator('#np-name').evaluate(e => e === document.activeElement), true);
      assert.equal(await dialog.locator('button[type=submit]').evaluate(e => e.form?.id), 'new-project');
      await footerEdges(h.page, 'short dialog');
      const body = dialog.locator('[data-scroll-body]');
      await body.evaluate(e => { const form = e.firstElementChild; for (let i = 0; i < 12; i++) { const row = form.cloneNode(true); row.removeAttribute('id'); row.querySelectorAll('[id]').forEach(n => n.removeAttribute('id')); e.append(row); } });
      const before = await rectangles(h.page);
      await body.evaluate(e => { e.scrollTop = e.scrollHeight; });
      assert.ok(await body.evaluate(e => e.scrollTop > 0));
      assert.deepEqual(await rectangles(h.page), before);
      await footerEdges(h.page, 'long dialog');
      bounded(await viewport(h.page), 'dialog');
      await h.page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await opener.evaluate(e => e === document.activeElement), true);
    }
  } finally { await h.close(); }
});

for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844], [375, 667]]) {
  test(`Themes controls and preview: ${theme} ${width}×${height}`, { skip, timeout: 30_000 }, async () => {
    const h = await openLayoutBrowser({ theme, touch: width < 800 });
    const failures = []; h.page.on('pageerror', e => failures.push(e.message));
    try {
      await h.page.setViewportSize({ width, height });
      await visit(h.page, h.origin, '/boutique?onglet=themes', '.ao-theme-modes');
      await h.page.evaluate(async () => {
        const version = document.querySelector('meta[name=ao-build]').content;
        const { officeApi } = await import(new URL('office/layout-source.js?v=' + version, document.baseURI));
        window.__themeApi = officeApi('1');
        window.__themeBefore = await window.__themeApi.get();
        window.__themeManifest = window.__themeBefore.manifest;
      });
      const preview = h.page.locator('.ao-theme-preview > .ao-theme-scene');
      const control = mode => h.page.locator(`[data-theme-mode="${mode}"]`);
      const save = h.page.locator('.ao-shop__saverow > .bu-btn--primary');
      const undo = h.page.getByRole('button', { name: /^Annuler la modification/ });
      const redo = h.page.getByRole('button', { name: /^Rétablir/ });
      assert.equal(await control('auto').locator('.ao-theme-scene').count(), 2);
      const images = await h.page.locator('[data-theme-mode] .ao-shell').evaluateAll(es => es.map(e => e.getAttribute('src')));
      assert.ok(images.some(s => /room\/day/.test(s))); assert.ok(images.some(s => /room\/night/.test(s)));
      assert.equal(await h.page.locator('.ao-theme-mode').filter({ hasText: 'Disponible' }).count(), 0);
      const setPreviewTime = async (minutes, resolved) => {
        await h.page.locator('.ao-theme-preview__time input').evaluate((e,m) => { e.value=m; e.dispatchEvent(new Event('input',{bubbles:true})); }, minutes);
        await h.page.waitForFunction(m => document.querySelector('.ao-theme-preview > .ao-theme-scene').dataset.officeTheme === m, resolved);
        assert.equal(await preview.getAttribute('data-preview-theme'), resolved);
        assert.equal(await preview.locator('.ao-light').evaluate(e => e.hidden), resolved === 'day');
        assert.equal(await preview.locator('.ao-layer--scene img[src*="lamp@on"]').count() > 0, resolved === 'night');
      };
      await setPreviewTime(300, 'night');
      const nightStyles = e => ({ filter: getComputedStyle(e.querySelector('.ao-world')).filter, background: getComputedStyle(e).backgroundColor });
      assert.deepEqual(await preview.evaluate(nightStyles), await control('night').locator('.ao-theme-scene').evaluate(nightStyles), 'live night matches the thumbnail');
      await setPreviewTime(420, 'day'); await setPreviewTime(1125, 'day'); await setPreviewTime(1140, 'night');
      assert.equal(await save.isDisabled(), true, 'previewing time never edits the draft');
      if(width>=800) assert.ok(await h.page.locator('.ao-theme-preview').evaluate(e => e.clientHeight < e.parentElement.clientHeight * .75), 'desktop preview trims the empty band');
      const original = await preview.getAttribute('data-preview-theme');
      const alternative = original === 'day' ? 'night' : 'day';
      if (width >= 800) {
        await control(alternative).hover();
        await h.page.waitForFunction(m => document.querySelector('.ao-theme-preview > .ao-theme-scene').dataset.previewTheme === m, alternative);
        assert.equal(await save.isDisabled(), true, 'hover only previews');
        await h.page.mouse.move(0, 0);
      }
      await control('day').click(); await h.page.mouse.move(0, 0);
      assert.equal(await h.page.locator('.ao-theme-hours').count(), 0);
      assert.equal(await preview.getAttribute('data-preview-theme'), 'day');
      await control('night').click(); await h.page.mouse.move(0, 0);
      assert.equal(await h.page.locator('.ao-theme-hours').count(), 0);
      assert.equal(await preview.getAttribute('data-preview-theme'), 'night');
      await undo.click(); assert.equal(await control('day').getAttribute('aria-pressed'), 'true');
      await redo.click(); assert.equal(await control('night').getAttribute('aria-pressed'), 'true');
      await control('auto').click(); await h.page.mouse.move(0, 0);
      const start = h.page.getByRole('slider', { name: 'Début de la nuit' });
      const end = h.page.getByRole('slider', { name: 'Fin de la nuit' });
      assert.equal(await start.getAttribute('step'), '15');
      await start.focus(); await h.page.keyboard.press('ArrowLeft');
      assert.equal(await start.getAttribute('aria-valuetext'), '18:45');
      await end.focus(); await h.page.keyboard.press('ArrowRight');
      assert.equal(await end.getAttribute('aria-valuetext'), '07:15');
      assert.match(await h.page.locator('.ao-theme-summary').innerText(), /18:45.*07:15.*12,5 h/);
      // Native two-handle timeline: several moves are one undoable draft gesture.
      await h.page.locator('.ao-theme-hours').evaluate(async e => { await Promise.all(e.getAnimations().map(a => a.finished)); });
      await start.scrollIntoViewIfNeeded();
      const handleBox = await start.boundingBox();
      const xAt = m => handleBox.x + 10 + (handleBox.width - 20) * m / 1440;
      const y = handleBox.y + handleBox.height / 2;
      if (width >= 800) {
        await h.page.mouse.move(xAt(1125), y); await h.page.mouse.down();
        await h.page.mouse.move(xAt(1200), y, { steps: 5 }); await h.page.mouse.up();
      } else {
        const cdp = await h.page.context().newCDPSession(h.page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: xAt(1125), y }] });
        for (let i=1;i<=5;i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: xAt(1125 + i*27), y }] });
          await h.page.waitForTimeout(25);
        }
        // Cross Chromium's touch slop, then settle at the requested quarter hour.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: xAt(1200), y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      assert.equal(await start.getAttribute('aria-valuetext'), '20:00', 'drag snaps to quarter hours');
      await undo.click();
      assert.equal(await start.getAttribute('aria-valuetext'), '18:45', 'one undo restores the whole drag');
      const field = h.page.locator('.ao-theme-clock input').first();
      assert.equal(await field.getAttribute('type'), 'text');
      await field.fill('23:59'); await field.press('Enter');
      assert.equal(await field.inputValue(), '00:00');
      await field.fill('99:00'); await field.press('Enter');
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      await field.press('Escape');
      const seasons = await h.page.evaluate(() => window.__themeManifest.themes.filter(t => t.kind === 'season').map(t => t.id));
      assert.deepEqual(await h.page.locator('[data-theme-season]').evaluateAll(es => es.map(e => e.dataset.themeSeason)), ['', ...seasons]);
      for (const id of seasons) {
        const choice = h.page.locator(`[data-theme-season="${id}"]`);
        const icon = await choice.locator('.ao-theme-season__thumb img').getAttribute('src');
        const expected = await h.page.evaluate(id => window.__themeManifest.themes.find(t=>t.id===id).thumbnail, id);
        assert.ok(icon.endsWith(expected));
        await choice.click(); await h.page.mouse.move(0, 0);
        await h.page.waitForFunction(id => document.querySelector('.ao-theme-preview > .ao-theme-scene').dataset.officeSeason === id, id);
        const sources = await preview.locator('[data-season]').evaluateAll(es=>es.map(e=>e.getAttribute('src')));
        const extras = await h.page.evaluate(id => window.__themeManifest.themes.find(t=>t.id===id).extras.map(x=>window.__themeManifest.furniture.find(f=>f.id===x.asset).image), id);
        assert.deepEqual(sources.map(src=>extras.find(path=>src.endsWith(path))), extras, 'selected season shows actual manifest decorations');
      }
      await h.page.locator('[data-theme-season=""]').click(); await h.page.mouse.move(0,0);
      await h.page.waitForFunction(() => !document.querySelector('.ao-theme-preview [data-season]'));
      const season = seasons[0];
      if (season) {
        await h.page.locator(`[data-theme-season="${season}"]`).click(); await h.page.mouse.move(0, 0);
        assert.equal(await preview.getAttribute('data-preview-season'), season);
      }
      assert.equal(await h.page.evaluate(async () => (await window.__themeApi.get()).layout.revision === window.__themeBefore.layout.revision), true, 'all choices remain an unsaved draft');
      await save.click();
      await h.page.waitForFunction(() => document.querySelector('.ao-shop__status').textContent === 'Tout est enregistré.');
      const persisted = await h.page.evaluate(async () => ({ before: window.__themeBefore.layout, after: (await window.__themeApi.get()).layout }));
      assert.equal(persisted.after.revision, persisted.before.revision + 1, 'Save accepts exactly one scoped revision');
      assert.equal(persisted.after.data.theme.nightFrom, '00:00');
      assert.equal(persisted.after.data.theme.nightTo, '07:15'); assert.equal(persisted.after.data.theme.season, season || null);
      assert.deepEqual(persisted.after.data.items, persisted.before.data.items, 'theme save preserves selected-floor furniture');
      const fixed = h.page.locator('.ao-theme-preview,.ao-shop__navigation,.ao-shop__savebar,.bu-bottombar');
      const boxes = () => fixed.evaluateAll(es => es.map(e => e.getBoundingClientRect().toJSON()).filter(r => r.height));
      const before = await boxes();
      const body = h.page.locator('.ao-theme-controls');
      await body.evaluate(e => { const sample=e.lastElementChild; for(let i=0;i<12;i++)e.append(sample.cloneNode(true)); e.scrollTop=e.scrollHeight; });
      assert.ok(await body.evaluate(e => e.scrollTop > 0));
      assert.deepEqual(await boxes(), before);
      await footerEdges(h.page, 'Themes scrolled'); bounded(await viewport(h.page), 'Themes scrolled');
      await body.evaluate(e => e.replaceChildren());
      await footerEdges(h.page, 'Themes empty');
      assert.deepEqual(failures, []);
    } finally { await h.close(); }
  });
}


test('English theme controls, keyboard preview and accessible labels', { skip, timeout: 30_000 }, async () => {
  const h = await openLayoutBrowser();
  try {
    await h.page.context().addInitScript(() => localStorage.setItem('ao.locale', 'en'));
    await visit(h.page, h.origin, '/boutique?onglet=themes', '.ao-theme-modes');
    const preview = h.page.locator('.ao-theme-preview > .ao-theme-scene');
    const original = await preview.getAttribute('data-preview-theme');
    const mode = original === 'night' ? 'day' : 'night';
    await h.page.locator(`[data-theme-mode="${mode}"]`).focus();
    assert.equal(await preview.getAttribute('data-preview-theme'), mode, 'keyboard focus previews a mode');
    assert.equal(await h.page.locator('.ao-shop__saverow > .bu-btn--primary').isDisabled(), true);
    await h.page.getByRole('slider', { name: 'Preview time' }).focus();
    await h.page.waitForFunction(m => document.querySelector('.ao-theme-preview > .ao-theme-scene').dataset.previewTheme === m, original);
    assert.equal(await preview.getAttribute('data-preview-theme'), original, 'leaving choices restores the draft preview');
    assert.equal(await h.page.getByRole('slider', { name: 'Night starts' }).getAttribute('aria-valuetext'), '19:00');
    assert.match(await h.page.locator('.ao-theme-summary').innerText(), /Night from 19:00 to 07:00.*12 h/);
    const require = createRequire(import.meta.url);
    await h.page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
    const violations = await h.page.evaluate(async () => (await axe.run('.ao-shop', { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
    assert.deepEqual(violations, []);
  } finally { await h.close(); }
});
