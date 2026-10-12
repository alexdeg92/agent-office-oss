import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { browserSkipReason, openLayoutBrowser, visit } from './helpers/layout-browser.js';
const skip = browserSkipReason();
const evidence = process.env.PROJECTS_EVIDENCE || 'design/reports/projects-mobile-1';
const bodySelector = '.ao-projects-mobile__list';
const fixedSelector = '.bu-mtopbar, .bu-bottombar, .ao-projects--mobile > .ao-frame__bar';
async function swipe(page, body, upward = true) {
  const r = await body.boundingBox(), x = r.x + r.width / 2;
  const start = upward ? r.y + r.height - 25 : r.y + 25;
  const distance = Math.min(r.height - 50, 240) * (upward ? -1 : 1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
  for (let n = 1; n <= 10; n++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + distance * n / 10 }] });
    await page.waitForTimeout(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach(); await page.waitForTimeout(250);
}
async function frameState(page) {
  return page.evaluate(selector => {
    const body=document.querySelector('.ao-projects--mobile > .ao-frame__body');
    return {
      document: { x: scrollX, y: scrollY, width: document.scrollingElement.scrollWidth, height: document.scrollingElement.scrollHeight },
      pageBody: body ? { top: body.scrollTop,height: body.clientHeight,scrollHeight: body.scrollHeight } : null,
      fixed: [...document.querySelectorAll(selector)].map(e => e.getBoundingClientRect().toJSON()).filter(r => r.height),
      scrollers: [...document.querySelectorAll('[data-scroll-body]')].filter(e => e.clientHeight && getComputedStyle(e).overflowY === 'auto').length,
    };
  }, fixedSelector);
}
for (const theme of ['light', 'dark']) for (const [width, height] of [[390, 844], [375, 667]]) {
  test(`mobile Projects: real touch, fixed controls and end clearance ${theme} ${width}×${height}`, { skip, timeout: 30000 }, async () => {
    const h = await openLayoutBrowser({ theme, touch: true });
    try {
      const { page } = h; await page.setViewportSize({ width, height });
      await visit(page, h.origin, '/projets?vue=tableau', '[data-card]');
      const body = page.locator(bodySelector), before = await frameState(page);
      await swipe(page, body);
      const top = await body.evaluate(e => e.scrollTop);
      assert.ok(top > 40, `touch must move the card list; got ${top}`);
      assert.deepEqual(await frameState(page), before, 'document, title, controls and navigation stay fixed');
      assert.equal(before.scrollers, 1);
      assert.equal(before.pageBody.top, 0);
      assert.equal(before.pageBody.scrollHeight, before.pageBody.height, 'the page body has no vertical overflow');
      assert.deepEqual(before.document, { x: 0, y: 0, width, height });
      assert.equal(await page.locator('[role=dialog]').count(), 0, 'swipe cancels long press');
      assert.ok(new URL(page.url()).pathname.endsWith('/projets'), 'swipe never opens details');
      await swipe(page, body, false);
      assert.ok(await body.evaluate(e => e.scrollTop) < top, 'reverse swipe moves back');
      const choices = page.locator('[data-project-choice]');
      assert.equal(await choices.count(), 6);
      assert.equal(await page.locator('[data-project-choice][aria-pressed=true]').count(), 1);
      assert.equal(await page.locator('.ao-mobile-card__key').count(), 0);
      assert.equal(await page.locator('.ao-projects--mobile > .ao-frame__foot').textContent(), '');
      assert.ok(await page.locator('.ao-mobile-card__more .bu-control-menu__trigger').evaluateAll(es => es.every(e => e.getBoundingClientRect().height >= 44)));
      assert.ok(await page.locator('.ao-mobile-card .bu-thumb').evaluateAll(es => es.every(e => e.getBoundingClientRect().width <= 64 && e.getBoundingClientRect().height <= 48)));
      if (process.env.PROJECTS_SCREENSHOTS) { await mkdir(evidence, { recursive: true }); await body.evaluate(e => { e.scrollTop = 0; }); await page.screenshot({ path: `${evidence}/after-${theme}-${width}.png` }); }
      await body.evaluate(e => { e.scrollTop = e.scrollHeight; });
      const last = await page.locator('.ao-mobile-card').last().boundingBox(), fab = await page.locator('.ao-projects-mobile__fab').boundingBox();
      assert.ok(last.y + last.height <= fab.y, `entire last card clears +: ${last.y + last.height} <= ${fab.y}`);
      if (process.env.PROJECTS_SCREENSHOTS) {
        await page.screenshot({ path: `${evidence}/end-${theme}-${width}.png` });
        await writeFile(`${evidence}/touch-${theme}-${width}.json`, JSON.stringify({ before, scrollAfterSwipe: top, last, fab }, null, 2));
      }
    } finally { await h.close(); }
  });
}
async function capture(page, name) {
  if (!process.env.PROJECTS_SCREENSHOTS) return;
  if (process.env.PROJECTS_SHEETS_ONLY && !/^(move|filters)-/.test(name)) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png` });
}
async function settledSheet(page, name, filters = false) {
  await page.waitForFunction(() => {
    const sheet = document.querySelector('[role=dialog]');
    return sheet && getComputedStyle(sheet).opacity === '1' &&
      sheet.closest('.bu-scrim').getAnimations({ subtree: true }).every(a => a.playState === 'finished');
  });
  if (filters) await page.getByRole('dialog').getByRole('link', { name: 'Importer des projets', exact: true }).scrollIntoViewIfNeeded();
  const state = await page.getByRole('dialog').evaluate(sheet => {
    const rect = e => e.getBoundingClientRect().toJSON();
    const hit = e => {
      const r = rect(e), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const target = document.elementFromPoint(x, y);
      return { rect: r, abovePage: sheet.closest('.bu-scrim').contains(target), insideSheet: sheet.contains(target) };
    };
    const surface = e => ({ opacity: getComputedStyle(e).opacity, background: getComputedStyle(e).backgroundColor });
    const footer = sheet.querySelector('.bu-modal__footer'), importer = sheet.querySelector('a');
    return {
      sheet: { ...surface(sheet), ...hit(sheet) },
      scrimOpacity: getComputedStyle(sheet.closest('.bu-scrim')).opacity,
      header: hit(sheet.querySelector('.bu-modal__header')),
      footer: footer && { ...surface(footer), ...hit(footer) },
      importer: importer && hit(importer),
      actions: [...sheet.querySelectorAll('.ao-projects-mobile__destinations button,.bu-modal__footer button')].map(hit),
      underlying: [...document.querySelectorAll('.ao-projects-mobile__fab,.bu-bottombar')].map(hit),
      viewport: { width: innerWidth, height: innerHeight },
      toastCount: document.querySelectorAll('.bu-toast').length,
      body: { top: sheet.querySelector('.ao-frame__body').scrollTop, height: sheet.querySelector('.ao-frame__body').clientHeight },
    };
  });
  const opaque = color => /^rgb\(/.test(color) || /^rgba\([^,]+,[^,]+,[^,]+,\s*1\)$/.test(color);
  assert.equal(state.sheet.opacity, '1'); assert.ok(opaque(state.sheet.background), 'settled sheet surface is opaque');
  assert.equal(state.scrimOpacity, '1');
  assert.equal(state.toastCount, 0, 'unrelated toast cannot obscure sheet evidence');
  for (const sample of [state.sheet, state.header, ...state.underlying, state.footer, state.importer].filter(Boolean)) {
    assert.ok(sample.abovePage, 'sheet or scrim wins hit-test above the page, FAB and navigation');
  }
  assert.ok(state.sheet.rect.y >= 0 && state.sheet.rect.bottom <= state.viewport.height);
  for (const sample of [state.sheet, state.header, state.footer, state.importer, ...state.actions].filter(Boolean)) {
    assert.ok(sample.insideSheet, 'sheet content wins the top hit-test');
    assert.ok(sample.rect.y >= state.sheet.rect.y && sample.rect.bottom <= state.sheet.rect.bottom, 'complete sheet controls stay inside the viewport');
  }
  if (filters) {
    assert.equal(state.footer.opacity, '1'); assert.ok(opaque(state.footer.background));
    assert.ok(state.importer.rect.y >= state.sheet.rect.y && state.importer.rect.bottom <= state.footer.rect.y, 'Importer is visible above the complete anchored footer');
    assert.ok(state.footer.rect.bottom <= state.viewport.height);
  }
  await capture(page, name);
  if (process.env.PROJECTS_SCREENSHOTS) await writeFile(`${evidence}/${name}.json`, JSON.stringify(state, null, 2) + '\n');
}
async function canonical(page, module, operation, args) {
  return page.evaluate(async ({ module, operation, args }) => {
    const build = document.querySelector('meta[name=ao-build]').content;
    const m = await import(new URL(module + '?v=' + build, document.baseURI).href);
    return m[operation](...args);
  }, { module, operation, args });
}
for (const theme of ['light', 'dark']) for (const [width,height] of [[375,667],[390,844]]) test(`mobile Projects: status counts, filters, move focus, comments, read-only and English ${theme} ${width}`, { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ theme, touch: true });
  try {
    const { page } = h; await page.setViewportSize({ width, height });
    await visit(page, h.origin, '/projets?vue=liste', '[data-card]');
    const choices = page.locator('[data-project-choice]');
    const statuses = await choices.evaluateAll(es => es.map(e => e.dataset.projectChoice));
    for (const status of statuses) {
      await page.locator(`[data-project-choice="${status}"]`).click();
      await page.waitForFunction(s => document.querySelector(`[data-project-choice="${s}"]`).getAttribute('aria-pressed') === 'true', status);
      const expected = Number(await page.locator(`[data-project-choice="${status}"] .bu-count`).textContent());
      assert.equal(await page.locator('[data-card]').count(), expected, 'selected list matches the filtered count');
      if (status !== 'all') assert.ok(await page.locator('.ao-mobile-card [data-project-status]').evaluateAll((es, s) => es.every(e => e.dataset.projectStatus === s), status));
      assert.equal(await page.locator(bodySelector).evaluate(e => e.scrollTop), 0);
      await capture(page, `status-${status}-${theme}-${width}`);
      if (status === 'all') {
        await page.locator(bodySelector).evaluate(e => { e.scrollTop = 120; });
        assert.ok(await page.locator(bodySelector).evaluate(e => e.scrollTop) > 0, 'exercise status reset from a scrolled list');
      }
    }
    await page.locator('[data-project-choice=all]').click();
    await page.locator('.ao-mobile-card:has([data-card=prj_portail]) [data-comment-count="1"]').waitFor();
    await canonical(page, 'api.js', 'post', ['/api/v2/projects/prj_portail/comments', { body: 'Commentaire de vérification mobile' }, { quiet: true }]);
    await page.locator('.ao-mobile-card:has([data-card=prj_portail]) [data-comment-count="2"]').waitFor();
    await page.locator('[data-project-choice="in-progress"]').click();
    const count = async s => Number(await page.locator(`[data-project-choice="${s}"] .bu-count`).textContent());
    const oldFrom = await count('in-progress'), oldTo = await count('in-review');
    const move = page.locator('.ao-mobile-card:has([data-card=prj_portail]) .bu-control-menu__trigger');
    await move.focus(); await move.tap();
    await page.getByRole('menuitem', { name: 'Déplacer', exact: true }).tap();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.getByRole('dialog').textContent(), /Refonte du portail client/);
    await settledSheet(page, `move-${theme}-${width}`);
    await page.keyboard.press('Escape');
    assert.ok(await move.evaluate(e => document.activeElement === e), 'move sheet returns focus to its real opener');
    await move.press('Enter');
    await page.getByRole('menuitem', { name: 'Déplacer', exact: true }).press('Enter');
    await page.locator('[role=dialog] [data-project-status="in-review"]').click();
    await page.locator('[data-card=prj_portail]').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.dataset.projectChoice === 'in-progress');
    assert.equal(await count('in-progress'), oldFrom - 1); assert.equal(await count('in-review'), oldTo + 1);
    await page.locator('[data-project-choice=all]').click();
    const search = page.getByRole('searchbox');
    await search.fill('zzzzunmatched');
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 0);
    assert.ok(await page.locator('.bu-empty').isVisible()); await capture(page, `filtered-empty-${theme}-${width}`);
    assert.equal(await count('all'), 0, 'counts respect search');
    await search.fill(''); await page.locator('[data-card]').first().waitFor();
    // Use the real toast close control, retaining the preceding mutation checks.
    while (await page.locator('.bu-toast').count()) await page.locator('.bu-toast button[aria-label="Fermer"]').first().click();
    const filter = page.locator('.ao-projects-mobile__filter');
    await filter.focus(); await filter.click(); await page.getByRole('dialog').waitFor();
    assert.equal(await page.locator('#mobile-project-filters select').count(), 3);
    await page.locator('#mobile-priority').selectOption('P0');
    await canonical(page, 'lang.js', 'chooseLang', ['fr']);
    assert.equal(await page.locator('#mobile-priority').inputValue(), 'P0', 'a live parent update preserves the filter draft');
    await settledSheet(page, `filters-${theme}-${width}`, true);
    await page.getByRole('button', { name: 'Appliquer', exact: true }).click();
    await page.locator('[data-active-filters="1"]').waitFor();
    assert.ok(await filter.evaluate(e => document.activeElement === e));
    assert.ok(await page.locator('.ao-mobile-card [data-priority]').evaluateAll(es => es.every(e => e.dataset.priority === 'P0')));
    assert.equal(await count('all'), await page.locator('[data-card]').count());
    await capture(page, `active-filter-${theme}-${width}`);
    await filter.click(); await page.getByRole('button', { name: 'Réinitialiser', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-active-filters]'));
    await visit(page, h.origin, '/projets?lecture=tout', '[data-card]');
    assert.equal(await page.locator('.ao-projects-mobile__fab,.ao-mobile-card__more').count(), 0);
    assert.equal(await choices.count(), 6); await capture(page, `readonly-${theme}-${width}`);
    await filter.click(); assert.equal(await page.getByRole('dialog').getByRole('link').count(), 0, 'read-only omits import');
    await page.keyboard.press('Escape');
    await canonical(page, 'lang.js', 'chooseLang', ['en']);
    await page.getByRole('button', { name: /Filter/ }).waitFor();
    assert.equal(await page.locator('[data-project-choice=all]').textContent(), 'All12');
    await capture(page, `english-${theme}-${width}`);
    await visit(page, h.origin, '/projets', '[data-card]');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.ao-projects:not(.ao-projects--mobile) [data-card]').first().waitFor();
    assert.equal(await page.locator('.ao-projects:not(.ao-projects--mobile) [data-column]').count(), 5);
    assert.equal(await page.locator('.ao-projects-mobile-shell').count(), 0);
    await capture(page, `desktop-${theme}-1440`);
  } finally { await h.close(); }
});

// State-only BoardVMs enter through the real page's topic boundary. The shell, controls,
// layout and card rendering are shipped code; no cloned DOM or overridden viewport CSS.
for (const theme of ['light', 'dark']) for (const [width,height] of [[375,667],[390,844]]) test(`mobile Projects: loading, error, empty and wrapping fixtures ${theme} ${width}`, { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ theme });
  try {
    const { page } = h; await page.setViewportSize({ width, height });
    await visit(page, h.origin, '/projets', '[data-card]');
    await page.evaluate(async () => {
      const build = document.querySelector('meta[name=ao-build]').content;
      const module = path => import(new URL(path + '?v=' + build, document.baseURI).href);
      const [{ services }, api] = await Promise.all([module('services.js'), module('api.js')]);
      window.__projectBoard = (await api.get('/api/v2/views/projects', { quiet: true })).data;
      const subscribe = services.stream.subscribe.bind(services.stream);
      services.stream.subscribe = (topic, url, listener) => {
        if (topic !== 'projects') return subscribe(topic, url, listener);
        window.__emitProjects = listener; return () => { window.__emitProjects = null; };
      };
      services.router.navigate(services.router.href('plus'));
    });
    await page.locator('.bu-morelist').waitFor();
    await page.evaluate(async () => {
      const build = document.querySelector('meta[name=ao-build]').content;
      const { services } = await import(new URL('services.js?v=' + build, document.baseURI).href);
      services.router.navigate(services.router.href('projets'));
    });
    await page.waitForFunction(() => window.__emitProjects);
    await page.locator('[aria-busy=true]').first().waitFor(); await capture(page, `loading-${theme}-${width}`);
    await page.evaluate(() => window.__emitProjects({ data: undefined, loading: false, error: { message: 'Connexion interrompue', status: 503 } }));
    await page.getByRole('button', { name: /Réessayer/ }).waitFor();
    assert.equal(await page.locator('.ao-projects--mobile [aria-busy=true]').count(), 0, 'error does not leave a loading skeleton');
    assert.equal(await page.locator('[data-project-choice]').count(), 6); await capture(page, `error-${theme}-${width}`);
    await page.evaluate(() => window.__emitProjects({ data: { ...window.__projectBoard, columns: window.__projectBoard.columns.map(c => ({ ...c, count: 0, cards: [] })) }, loading: false, error: null }));
    await page.locator('.bu-empty').waitFor(); assert.equal(await page.locator('[data-card]').count(), 0); await capture(page, `empty-${theme}-${width}`);
    await page.evaluate(() => {
      const data = structuredClone(window.__projectBoard);
      const card = data.columns.flatMap(c => c.cards)[0];
      card.name = 'Un projet au titre très long pour vérifier le retour à la ligne des cartes';
      card.priority = 'P0'; card.lastActivityAt = Date.now();
      card.commentCount = 123456;
      card.thumb = { kind: 'cover', url: '/missing-test-cover.png' };
      window.__emitProjects({ data, loading: false, error: null });
    });
    await page.locator('[data-card]').first().waitFor();
    await page.locator('[data-comment-count="123456"]').waitFor();
    assert.match(await page.locator('[data-card]').first().textContent(), /Un projet au titre très long/);
    await page.locator('.ao-mobile-card [data-cover=monogram]').first().waitFor();
    // Large result counts need not allocate hundreds of thousands of fake projects. Probe
    // only the count text geometry; card wrapping and failed cover use a real BoardVM above.
    await page.locator('[data-project-choice] .bu-count').evaluateAll(es => es.forEach(e => { e.textContent = '123456'; }));
    await capture(page, `wrapping-${theme}-${width}`);
    const state = await frameState(page); assert.deepEqual(state.document, { x: 0, y: 0, width, height });
    assert.ok(await page.locator('[data-project-choice]').evaluateAll(es => es.every(e => e.clientWidth >= e.scrollWidth && e.getBoundingClientRect().height === 44)));
    assert.ok(await page.locator('.ao-mobile-card').evaluateAll(es => es.every(e => e.clientWidth >= e.scrollWidth)));
    assert.ok(await page.locator('.ao-mobile-card .bu-thumb').evaluateAll(es => es.every(e => e.getBoundingClientRect().width === 64 && e.getBoundingClientRect().height === 48)));
    await canonical(page, 'lang.js', 'chooseLang', ['en']);
    await page.getByRole('button', { name: /Filter/ }).waitFor();
    await page.locator('[data-project-choice] .bu-count').evaluateAll(es => es.forEach(e => { e.textContent = '123456'; }));
    await page.locator('[data-comment-count="123456"]').waitFor();
    assert.match(await page.locator('[data-card]').first().textContent(), /Un projet au titre très long/);
    await capture(page, `wrapping-english-${theme}-${width}`);
    assert.equal((await frameState(page)).document.width, width);
  } finally { await h.close(); }
});

for (const theme of ['light','dark']) for (const [width,height] of [[375,667],[390,844]]) test(`mobile Projects: horizontal stage rail and Menu hit areas ${theme} ${width}`, { skip, timeout: 30000 }, async () => {
  const h = await openLayoutBrowser({ theme, touch: true });
  try {
    const { page } = h; await page.setViewportSize({ width, height });
    await visit(page, h.origin, '/projets?etape=shipped', '[data-card]');
    const rail = page.locator('.ao-projects-mobile__statuses');
    const selected = page.locator('[data-project-choice=shipped]');
    assert.ok(await rail.evaluate(e => e.scrollLeft > 0), 'route selection reveals the last stage');
    async function selectedInside() {
      const r = await rail.boundingBox(), c = await selected.boundingBox();
      assert.ok(c.x >= r.x - 1 && c.x + c.width <= r.x + r.width + 1, 'selected button is fully visible');
    }
    await selectedInside();
    assert.ok(await page.locator('[data-project-choice]').evaluateAll(es => es.every(e => e.getBoundingClientRect().top === es[0].getBoundingClientRect().top && getComputedStyle(e).whiteSpace === 'nowrap')));
    await page.locator('[data-project-choice=all]').focus(); await page.keyboard.press('Space');
    await page.locator('[data-project-choice=all][aria-pressed=true]').waitFor();
    assert.equal(await rail.evaluate(e => e.scrollLeft), 0);
    await selected.focus(); await page.keyboard.press('Space');
    await selected.waitFor(); await page.waitForFunction(() => document.querySelector('[data-project-choice=shipped]').getAttribute('aria-pressed') === 'true');
    await selectedInside();
    await page.locator('[data-project-choice=all]').click();
    await page.locator('[data-project-choice=all][aria-pressed=true]').waitFor();
    const railBox=await rail.boundingBox(), cdp=await page.context().newCDPSession(page);
    const x=railBox.x+railBox.width-24, y=railBox.y+railBox.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let n=1;n<=10;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-n*18,y}]});await page.waitForTimeout(25);}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    await page.waitForFunction(()=>document.querySelector('.ao-projects-mobile__statuses').scrollLeft>40);
    await page.waitForTimeout(250);
    assert.equal((await frameState(page)).document.y,0);assert.equal(await page.locator(bodySelector).evaluate(e=>e.scrollTop),0);
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.locator('[data-project-choice=all]').focus();await page.keyboard.press('Space');
    assert.equal(await rail.evaluate(e=>e.scrollLeft),0,'keyboard reactivation reveals an already selected offscreen chip');
    const row = page.locator('.ao-mobile-card').first(), trigger = row.locator('.bu-control-menu__trigger');
    await trigger.tap(); await page.getByRole('menu').waitFor();
    await capture(page, `menu-top-${theme}-${width}`);
    const menu = await page.getByRole('menu').boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= width && menu.y >= 0 && menu.y + menu.height <= height);
    await page.keyboard.press('Escape'); assert.ok(await trigger.evaluate(e => document.activeElement === e));
    const linkHit = await row.locator('[data-card]').evaluate(e => {
      const css = getComputedStyle(e, '::after'), r = e.closest('li').getBoundingClientRect();
      return { right: r.right - parseFloat(css.right), top: r.top, bottom: r.bottom };
    });
    const action = await trigger.boundingBox(); assert.ok(linkHit.right <= action.x, 'stretched link never overlaps Menu target');
    await page.locator(bodySelector).evaluate(e => { e.scrollTop = e.scrollHeight; });
    const lastTrigger = page.locator('.ao-mobile-card').last().locator('.bu-control-menu__trigger');
    await lastTrigger.tap(); await page.getByRole('menu').waitFor(); await capture(page, `menu-bottom-${theme}-${width}`);
    const bottom = await page.getByRole('menu').boundingBox(); assert.ok(bottom.y >= 0 && bottom.y + bottom.height <= height);
    await page.keyboard.press('Escape'); assert.ok(await lastTrigger.evaluate(e => document.activeElement === e));
    // A genuine tap on the decorative thumbnail still follows the card's native detail link.
    await page.locator(bodySelector).evaluate(e => { e.scrollTop = 0; });
    const target = await row.locator('[data-card]').getAttribute('href');
    const thumb = await row.locator('.bu-list-row__avatar').boundingBox();
    await page.touchscreen.tap(thumb.x+thumb.width/2,thumb.y+thumb.height/2);
    await page.waitForURL(url => url.pathname === new URL(target, h.origin).pathname);
    await page.locator('.ao-project').waitFor();
    assert.equal((await frameState(page)).document.y, 0);
  } finally { await h.close(); }
});
