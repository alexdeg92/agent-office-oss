import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { browserSkipReason, openLayoutBrowser, chooseChatConversation } from './helpers/layout-browser.js';
const skip = browserSkipReason();

async function open(page, origin, path, ready) {
  // Journaux uses agent as a canonical filter, not the helper's mock display name.
  await page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}mock=1${path==='/discuter'?'&chat-plein=1':''}`, { waitUntil: 'domcontentloaded' });
  if(path==='/discuter')await chooseChatConversation(page);
  await page.locator(ready).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function crowded(page, topic) {
  if(topic==='chat')return; // The v3 mock owns its dense history; do not mutate the shell's legacy topic.
  await page.evaluate(async topic => {
    const build = document.querySelector('meta[name=ao-build]').content;
    const { services } = await import(new URL('services.js?v=' + build, document.baseURI).href);
    const stream = services.stream, entry = stream._topics.get(topic), data = structuredClone(entry.state.data);
    stream.stop(); stream.status.set({ conn: 'open' });
    const key = topic === 'chat' ? 'messages' : topic === 'logs' ? 'items' : 'flows', base = data[key][0];
    data[key] = Array.from({ length: 24 }, (_, i) => ({ ...base, id: 'mobile_fixture_' + i,
      ...(topic === 'chat' ? { text: 'Message de vérification du défilement. '.repeat(5) } : topic === 'logs'
        ? { title: null, label: `Conversation de vérification ${i + 1}` }
        : { name: `Tâche de vérification ${i + 1}`, enabled: true }) }));
    if (topic === 'flows') data.counts = { ...data.counts, total: 24, enabled: 24 };
    entry.state = { ...entry.state, rev: (entry.state.rev || 0) + 100 };
    stream.applyVM(topic, data);
  }, topic);
}

async function geometry(page, frame) {
  return page.evaluate(frame => ({
    document: [scrollX, scrollY, document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight],
    shell: [...document.querySelectorAll('main > .ao-frame__body')].map(e => [e.scrollTop, e.clientHeight, e.scrollHeight]),
    fixed: [...document.querySelectorAll(`${frame} > .ao-frame__head,${frame} > .ao-frame__bar,.bu-mtopbar,.bu-topbar,.bu-bottombar,.ao-chat__card > .ao-frame__foot`)]
      .map(e => e.getBoundingClientRect().toJSON()).filter(r => r.height),
  }), frame);
}

async function swipe(page, box) {
  const cdp = await page.context().newCDPSession(page), x = box.x + box.width / 2, y = box.y + box.height - 25;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 18 }] });
    await page.waitForTimeout(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
}

for (const theme of ['light', 'dark']) for (const [width, height] of [[390, 844], [360, 640], [1280, 800], [1440, 900]]) {
  test(`Workspace: bounded chat, logs and tasks ${theme} ${width}`, { skip, timeout: 90000 }, async () => {
    const mobile = width <= 820, h = await openLayoutBrowser({ theme, touch: mobile }), p = h.page, errors = [];
    p.on('pageerror', e => errors.push(e.message));
    try {
      await p.setViewportSize({ width, height });
      for (const [topic, path, frame, content, ready] of [
        ['chat', '/discuter', '.ao-chat', '.ao-chat .bu-chat__thread', '#chat-texte'],
        ['logs', '/journaux', '.ao-logs', '.ao-logs > .ao-frame__body', '.ao-logs:not([aria-busy=true])'],
        ['flows', '/flux', '.ao-flows', '.ao-flows > .ao-frame__body', '.ao-flows:not([aria-busy=true])'],
      ]) {
        await open(p, h.origin, path, ready); await crowded(p, topic);
        const list = p.locator(content);
        await p.waitForFunction(selector => { const e = document.querySelector(selector); return e.scrollHeight > e.clientHeight; }, content);
        await list.evaluate(e => { e.scrollTop = 0; }); await p.waitForTimeout(100);
        assert.ok(await list.evaluate(e => e.clientHeight > 100 && getComputedStyle(e).overflowY === 'auto'));
        const before = await geometry(p, frame);
        assert.deepEqual(before.document, [0, 0, width, height]);
        assert.ok(before.shell.every(([top, size, scroll]) => top === 0 && size === scroll), 'the shell body has no overflow');
        const box = await list.boundingBox();
        if (mobile) await swipe(p, box);
        else { await p.mouse.move(box.x + box.width / 2, box.y + 90); await p.mouse.wheel(0, 350); }
        await p.waitForFunction(selector => document.querySelector(selector).scrollTop > 40, content);
        assert.deepEqual(await geometry(p, frame), before, 'scrolling changes only content; controls and navigation remain fixed');
        await list.focus(); await p.keyboard.press('End');
        await p.waitForFunction(selector => { const e = document.querySelector(selector); return e.scrollTop + e.clientHeight >= e.scrollHeight - 1; }, content);
        await p.mouse.wheel(0, 500); await p.waitForTimeout(100);
        assert.deepEqual(await geometry(p, frame), before, 'end of content never scrolls the document');
        if (topic === 'chat') {
          const input = p.locator('#chat-texte'), send = p.getByRole('button', { name: 'Envoyer', exact: true });
          await input.fill('un\ndeux\ntrois\nquatre');
          if (mobile) assert.ok((await input.boundingBox()).height > 60);
          assert.equal(await send.isEnabled(), true);
          const composer = await p.locator('.ao-chat__card').boundingBox();
          if (mobile) assert.equal(Math.round(composer.y + composer.height), Math.round((await p.locator('.bu-bottombar').boundingBox()).y));
        }
      }
      assert.deepEqual(errors, []);
    } finally { await h.close(); }
  });
}

test('Journaux mobile: filter draft, dependent agents, apply, reset and return URL', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ touch: true }), p = h.page;
  try {
    await p.setViewportSize({ width: 360, height: 640 });
    await open(p, h.origin, '/journaux', '.ao-logs:not([aria-busy=true])');
    const filters = p.getByRole('button', { name: 'Filtres', exact: true });
    await filters.click();
    const close = await p.getByRole('button', { name: 'Fermer', exact: true }).boundingBox();
    assert.ok(close.width >= 44 && close.height >= 44 && close.x > 280, 'close is a 44px target at the right of the header');
    await p.setViewportSize({ width: 360, height: 400 });
    const body = p.locator('.ao-logs__filter-sheet > .ao-frame__body');
    assert.ok(await body.evaluate(e => e.scrollHeight > e.clientHeight), 'on a short viewport the sheet body scrolls');
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.ao-logs__filter-sheet')).transform === 'none');
    const footer = p.locator('.ao-logs__filter-sheet > .ao-frame__foot'), foot = await footer.boundingBox();
    await body.evaluate(e => { e.scrollTop = e.scrollHeight; });
    assert.deepEqual(await footer.boundingBox(), foot, 'the apply action stays fixed while filters scroll');
    assert.ok(foot.y + foot.height <= 400);
    await p.setViewportSize({ width: 360, height: 640 });
    await p.locator('#logs-connector').selectOption('claude-code');
    assert.equal(await p.locator('#logs-agent option').count(), 3);
    await p.locator('#logs-agent').selectOption('rt:claude-code:agent:portail-client');
    assert.ok(!new URL(p.url()).searchParams.has('connecteur'), 'editing the sheet makes no query or request');
    await p.keyboard.press('Escape'); await filters.waitFor();
    assert.equal(await filters.evaluate(e => document.activeElement === e), true, 'focus returns to the labelled opener');
    await filters.click(); assert.equal(await p.locator('#logs-connector').inputValue(), '');
    await p.locator('#logs-connector').selectOption('claude-code');
    await p.locator('#logs-agent').selectOption('rt:claude-code:agent:portail-client');
    await p.getByRole('button', { name: 'Appliquer', exact: true }).click();
    await p.waitForFunction(() => document.querySelectorAll('.ao-logs__cards li').length === 1);
    assert.equal(new URL(p.url()).searchParams.get('connecteur'), 'claude-code');
    await p.getByRole('button', { name: 'Filtres (2)', exact: true }).waitFor();
    await p.locator('.ao-logs__cards a').click(); await p.locator('.ao-session').waitFor();
    await p.goBack(); await p.getByRole('button', { name: 'Filtres (2)', exact: true }).click();
    await p.locator('#logs-connector').selectOption('legacy');
    assert.ok(await p.locator('#logs-agent').count() === 0 || await p.locator('#logs-agent').inputValue() === '', 'changing connector clears the old agent');
    await p.getByRole('button', { name: 'Réinitialiser', exact: true }).click();
    await p.getByRole('button', { name: 'Appliquer', exact: true }).click();
    await p.getByRole('button', { name: 'Filtres', exact: true }).waitFor();
    assert.ok(!new URL(p.url()).searchParams.has('agent'));
    assert.ok(!new URL(p.url()).searchParams.has('connecteur'));
  } finally { await h.close(); }
});

test('Flux mobile: horizontal filters, readable names, linked details and creation', { skip, timeout: 60000 }, async () => {
  const h = await openLayoutBrowser({ touch: true }), p = h.page;
  try {
    await p.setViewportSize({ width: 360, height: 640 });
    await open(p, h.origin, '/flux', '.ao-flows:not([aria-busy=true])');
    const rail = p.locator('.ao-flows__rail');
    assert.ok(await rail.evaluate(e => e.scrollWidth > e.clientWidth));
    const disabled = rail.getByRole('button', { name: /^Désactivées/ });
    await disabled.focus(); await p.keyboard.press('Enter');
    await p.waitForFunction(() => document.querySelector('.ao-flows__rail button:last-child').getAttribute('aria-pressed') === 'true');
    assert.equal(await disabled.getAttribute('aria-pressed'), 'true');
    assert.equal(new URL(p.url()).searchParams.get('etat'), 'desactivees');
    assert.ok(await rail.evaluate(e => { const b = e.querySelector('[aria-pressed=true]').getBoundingClientRect(), r = e.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; }));
    await rail.getByRole('button', { name: /^Toutes/ }).click();
    await p.evaluate(async () => {
      const build = document.querySelector('meta[name=ao-build]').content;
      const { services } = await import(new URL('services.js?v=' + build, document.baseURI).href);
      const data = structuredClone(services.stream._topics.get('flows').state.data);
      data.flows[0].name = 'Vérification des documents et des confirmations avant la livraison hebdomadaire';
      services.stream.applyVM('flows', data);
    });
    const title = p.locator('.ao-flows__mobile .bu-list-row__title a').first();
    await p.waitForFunction(() => document.querySelector('.ao-flows__mobile a').textContent.startsWith('Vérification des documents'));
    assert.ok(await title.evaluate(e => e.getClientRects().length > 1), 'a long name wraps rather than truncates');
    await p.locator('.ao-flows__mobile a').first().click(); await p.locator('.ao-flow').waitFor();
    await p.goBack(); await p.getByRole('button', { name: 'Créer une tâche', exact: true }).click();
    await p.getByRole('dialog').waitFor(); await p.locator('#nf-name').fill('Veille de vérification');
    await p.locator('#nf-message').fill('Préparer une synthèse avec des données inventées.');
    await p.getByRole('button', { name: 'Créer la tâche', exact: true }).click();
    await p.waitForURL(/\/flux\//); await p.locator('.ao-flow').waitFor();
  } finally { await h.close(); }
});

test('Workspace styles: failed stylesheet shows retry; successful retry renders once with pinned controls', { skip, timeout: 45000 }, async () => {
  const h = await openLayoutBrowser({ touch: true }), p = h.page;
  try {
    await p.setViewportSize({ width: 360, height: 640 });
    for (const [path, ready] of [['/discuter', '#chat-texte'], ['/journaux', '.ao-logs'], ['/flux', '.ao-flows']]) {
      const pattern = '**/pages/workspace-mobile.css*';
      await p.route(pattern, route => route.fulfill({ status: 503, contentType: 'text/css', body: '' }));
      await p.goto(`${h.origin}${path}?mock=1`, { waitUntil: 'domcontentloaded' });
      const retry = p.getByRole('button', { name: 'Réessayer', exact: true });
      await retry.waitFor(); assert.equal(await p.locator(ready).count(), 0, 'unstyled page is never rendered');
      await p.unroute(pattern); await retry.click(); if(path==='/discuter')await chooseChatConversation(p); await p.locator(ready).waitFor();
      assert.equal(await p.locator('link[href*="workspace-mobile.css"]').count(), 1);
      assert.equal(await p.locator('link[data-bureau-controls-css]').count(), 1);
      assert.ok(await p.locator('link[href*="workspace-mobile.css"]').evaluate(e => !!e.sheet && e.href.includes('?v=')));
    }
  } finally { await h.close(); }
});

test('Workspace mobile: accessible controls and filter sheet in French and English', { skip, timeout: 60000 }, async () => {
  const require = createRequire(import.meta.url), axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const h = await openLayoutBrowser({ touch: true }), p = h.page;
  try {
    await p.setViewportSize({ width: 360, height: 640 });
    for (const lang of ['fr', 'en']) for (const [path, ready] of [['/discuter', '#chat-texte'], ['/journaux', '.ao-logs:not([aria-busy=true])'], ['/flux', '.ao-flows:not([aria-busy=true])']]) {
      await open(p, h.origin, path, ready);
      await p.evaluate(async lang => {
        const build = document.querySelector('meta[name=ao-build]').content;
        const { chooseLang } = await import(new URL('lang.js?v=' + build, document.baseURI).href); await chooseLang(lang);
      }, lang);
      await p.waitForFunction(lang => document.documentElement.lang.startsWith(lang), lang);
      await p.evaluate(axeSource);
      if (path === '/journaux') await p.getByRole('button', { name: lang === 'fr' ? 'Filtres' : 'Filters', exact: true }).click();
      const violations = await p.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations
        .filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      assert.deepEqual(violations, [], `${lang} ${path}`);
    }
  } finally { await h.close(); }
});
