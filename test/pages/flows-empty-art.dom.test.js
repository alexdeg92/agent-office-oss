'use strict';
// Flux with no scheduled task (office-dev-16): the lead shows artist-15's « no flows » spot, and only the active
// theme's file is downloaded (frontend's StateArt: lazy images, the other variant is display:none, never fetched).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { launch, findChrome } = require('../office/helpers/browser');
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

describe('Flux: the « no flows » state spot', { skip, timeout: 120_000 }, () => {
  it('shows on an empty register, one file per theme; not when tasks exist', async () => {
    let p;
    for (const theme of ['dark', 'light']) {
      // a fresh browser per theme: an image already in the memory cache would be served regardless of display:none
      if (p) { await p.close(); await browser.close(); browser = await launch(); }
      p = await browser.page('/');
      // the theme is stored per origin: set it on the app's own origin, then load the page fresh
      await p.eval(`location.href = ${JSON.stringify(origin + '/v2/connexion?mock=1')};`);
      await p.waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
      await p.eval(`localStorage.setItem('ao.uiTheme', ${JSON.stringify(theme)}); localStorage.setItem('ao.locale', 'fr');
        location.href = ${JSON.stringify(origin + '/v2/flux?mock=vide&t=' + theme)};`);
      await p.waitFor(`location.pathname === '/v2/flux' && document.querySelector('.ao-flows .bu-empty__title')`);
      await p.waitFor(`[...document.querySelectorAll('.ao-stateart img')].some((i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).display !== 'none')`, 10000);
      const r = await p.eval(`return {
        head: document.querySelector('.ao-flows .bu-empty__title').innerText,
        hidden: document.querySelector('.ao-stateart').getAttribute('aria-hidden'),
        shown: [...document.querySelectorAll('.ao-stateart img')].filter((i) => getComputedStyle(i).display !== 'none').map((i) => i.getAttribute('src').split('/').pop()),
        fetched: performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).filter((u) => u.startsWith('state-')) };`);
      assert.match(r.head, /Aucune tâche planifiée/);
      assert.equal(r.hidden, 'true', 'decorative');
      assert.deepEqual(r.shown, [`state-no-flows-${theme}.webp`]);
      assert.deepEqual(r.fetched, [`state-no-flows-${theme}.webp`], 'the other variant is never downloaded');
    }
    await p.eval(`location.href = ${JSON.stringify(origin + '/v2/flux?mock=1')};`);
    await p.waitFor(`location.search === '?mock=1' && document.querySelector('.ao-flows__grid .ao-flow-card')`);
    assert.equal(await p.eval(`return document.querySelectorAll('.ao-stateart').length;`), 0);
    await p.close();
  });
});
