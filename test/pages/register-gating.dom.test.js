'use strict';
// api-v3 D1/D7 on the register pages (office-dev): Flux writes need `flows.write`, the skill toggle `skills.toggle`,
// the restart `restart`. A runtime that can't do one shows the reason instead of the action. The real app in mock
// mode (scripts/serve-frontend.js), capabilities set as a 3.0 MetaVM would declare them.
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

async function open(route) {
  const p = await browser.page('/');
  await p.eval(`location.href = ${JSON.stringify(origin + '/v2/' + route)};`);
  await p.waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete' && !!document.querySelector('main h1, main h2')`);
  // the UI language is stored per origin: set French on the app's own origin, then reload
  await p.eval(`localStorage.setItem('ao.locale', 'fr'); location.reload();`);
  await p.waitFor(`document.documentElement?.lang?.startsWith('fr') && document.querySelector('main h1, main h2')`);
  return p;
}
// Write actions: a page marks its actions container with [data-write-actions] (the editorial pages used .ao-lead__actions).
const read = `return { actions: [...document.querySelectorAll('[data-write-actions] button, [data-write-actions] .bu-switch, .ao-lead__actions button, .ao-lead__actions .bu-switch')].map((b) => b.innerText.trim()), note: document.querySelector('.ao-ro')?.innerText ?? null };`;
const limit = (caps) => `const { services } = await import('/v2/services.js');
  services.meta = { ...services.meta, runtime: { ...(services.meta?.runtime ?? {}), capabilities: ${JSON.stringify(caps)} } };
  services.router.setQuery({ x: '1' }); await new Promise((r) => setTimeout(r, 400));`;

describe('register pages follow the runtime’s capabilities (api-v3 D1)', { skip, timeout: 120_000 }, () => {
  it('Flux: without flows.write, no create/run/enable/edit/delete, and the reason is said', async () => {
    for (const route of ['flux?mock=1', 'flux/ffffffff-0c01-4000-8000-000000000003?mock=1']) {
      const p = await open(route);
      const before = await p.eval(read);
      assert.ok(before.actions.length >= 1, route);
      await p.eval(limit({ flows: { read: true, write: false } }));
      const after = await p.eval(read);
      assert.deepEqual(after.actions, [], route);
      assert.match(after.note, /ne permet pas de créer ni de modifier les tâches planifiées/);
      await p.close();
    }
  });

  it('Compétences: without skills.toggle no switch (reason said); without restart no restart action', async () => {
    const p = await open('competences/meteo?mock=1');
    assert.deepEqual((await p.eval(read)).actions, ['Compétence activée']);
    await p.eval(limit({ skills: { read: true, toggle: false }, restart: false }));
    const after = await p.eval(read);
    assert.deepEqual(after.actions, []);
    assert.match(after.note, /ne permet pas d’activer ou de désactiver une compétence/);
    await p.close();
  });

  it('a 2.x meta declares no capabilities: everything stays', async () => {
    const p = await open('flux/ffffffff-0c01-4000-8000-000000000003?mock=1');
    await p.eval(limit(null));
    assert.ok((await p.eval(read)).actions.includes('Exécuter maintenant'));
    await p.close();
  });
});
