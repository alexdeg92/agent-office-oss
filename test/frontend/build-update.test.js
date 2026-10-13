import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuildUpdate } from '../../public/v2/build-update.js';
import { reloadGuards, hasDirtyDraft, allowReload } from '../../public/v2/services.js';
import { createRouter } from '../../public/v2/router.js';
import { configure } from '../../public/v2/config.js';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createFrontendServer } = require('../../scripts/serve-frontend.js');
const { createApp } = require('../../src/api/http.js');

test('reload guards preserve all dirty owners until every discard confirmation succeeds', async () => {
  let confirm = false, asked = 0;
  const a = { dirty: () => true, confirm: async () => { asked++; return confirm; } };
  const b = { dirty: () => true, confirm: async () => { asked++; return true; } };
  reloadGuards.add(a); reloadGuards.add(b);
  try {
    assert.equal(hasDirtyDraft(), true); assert.equal(asked, 0, 'automatic predicate never prompts or discards');
    assert.equal(await allowReload(), false); assert.equal(asked, 1);
    assert.equal(a.approved, false); assert.equal(b.approved, false);
    confirm = true;
    assert.equal(await allowReload(), true); assert.equal(asked, 3);
    assert.equal(a.approved, true); assert.equal(b.approved, true);
  } finally { reloadGuards.delete(a); reloadGuards.delete(b); }
  assert.equal(hasDirtyDraft(), false);
});

test('build update: one non-blocking notification, no navigation until a full reload of the target', async () => {
  let deployed = 'A', notice, notifications = 0;
  const reloads = [];
  const release = createBuildUpdate({ build: 'A', fetchBuild: async () => deployed,
    notify: (run) => { notice = run; notifications++; }, reload: (url) => reloads.push(url), currentUrl: () => '/projets/ancien' });
  assert.equal(await release.beforeNavigate('/sante'), true);
  deployed = 'B';
  assert.equal(await release.check(), true);
  assert.equal(release.stale, true);
  assert.deepEqual(reloads, [], 'notification does not interrupt the current page');
  await release.check(); release.observe('B');
  assert.equal(notifications, 1);
  assert.equal(await release.beforeNavigate('/projets/prj_1?onglet=historique'), false);
  assert.deepEqual(reloads, ['/projets/prj_1?onglet=historique']);
  notice(); assert.equal(reloads.at(-1), '/projets/ancien');
});

test('build update: missing/failed checks preserve offline navigation; concurrent checks share the request', async () => {
  let resolve, reads = 0;
  const release = createBuildUpdate({ build: 'A', fetchBuild: () => { reads++; return new Promise((r) => { resolve = r; }); } });
  const a = release.check(), b = release.check();
  await Promise.resolve(); assert.equal(reads, 1);
  resolve(null); assert.equal(await a, false); assert.equal(await b, false);
  assert.equal(release.observe(null), false);
  assert.equal(await createBuildUpdate({ build: 'A', fetchBuild: async () => { throw Error('offline'); } }).beforeNavigate('/journaux'), true);
});

test('build update: navigation awaits a slow complete response instead of assuming current after 800ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reads = 0, resolve, notices = 0;
  const release = createBuildUpdate({ build: 'A', fetchBuild: () => {
    reads++; return new Promise(r => { resolve = r; });
  }, notify: () => { notices++; }, reload: () => {} });
  let continued = false;
  let settled = false;
  const navigation = release.beforeNavigate('/journaux').then(value => { continued = value; settled = true; });
  await Promise.resolve();
  t.mock.timers.tick(799); await Promise.resolve();
  assert.equal(continued, false);
  t.mock.timers.tick(2201); await Promise.resolve();
  assert.equal(settled, false);
  const shared = release.check({ maxAge: 800 });
  assert.equal(reads, 1, 'the lazy page does not add a second navigation delay');
  resolve('B'); await navigation;
  assert.equal(continued, false);
  assert.equal(await shared, true);
  assert.equal(release.stale, true, 'a late deployment result still announces the update');
  assert.equal(notices, 1);
  assert.equal(await release.beforeNavigate('/bureau'), false);
});

test('build update: a successful check is reused and the next navigation checks afresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let deployed = 'A', reads = 0;
  const release = createBuildUpdate({ build: 'A', fetchBuild: async () => { reads++; return deployed; }, reload: () => {} });
  assert.equal(await release.beforeNavigate('/journaux'), true);
  assert.equal(await release.check({ maxAge: 800 }), false);
  assert.equal(reads, 1);
  t.mock.timers.tick(3000);
  assert.equal(await release.beforePageLoad(), false);
  assert.equal(reads, 1, 'a slow render consumes the completed navigation check without a second wait');
  deployed = 'B';
  assert.equal(await release.beforeNavigate('/bureau'), false);
  assert.equal(reads, 2);
  t.mock.timers.tick(800);
  assert.equal(release.stale, true);
});

test('router: deployment guard blocks links and popstate before subscribers can render a lazy route', async () => {
  configure({ basePath: '/', apiBase: '/backend' });
  const events = {}, emitted = [], history = [];
  const win = { location: { pathname: '/sante', search: '?mock=1', href: 'http://example.test/sante?mock=1' },
    document: { addEventListener() {} }, addEventListener: (name, fn) => { events[name] = fn; }, scrollTo() {},
    history: { pushState: (...args) => history.push(args), replaceState: (...args) => history.push(args) } };
  let allowed = false, checked;
  const router = createRouter(win, { beforeNavigate: async (url) => { checked = url; return allowed; } });
  router.subscribe((m) => emitted.push(m));
  await router.navigate('/projets/prj_1');
  assert.equal(checked, '/projets/prj_1?mock=1');
  assert.equal(history.length, 0); assert.equal(emitted.length, 0);
  events.popstate(); await new Promise((r) => setImmediate(r));
  assert.equal(emitted.length, 0);
  allowed = true; await router.navigate('/journaux'); assert.equal(history.length, 1); assert.equal(emitted.length, 1);
});

for (const mode of ['frontend root', 'frontend subpath', 'Express']) {
  test(`deploy while running: ${mode} reports the new build, rejects obsolete JS/CSS/JSON, and refreshes its shell`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-build-update-')), root = join(dir, 'v2');
    mkdirSync(root);
    const template = readFileSync(new URL('../../public/v2/index.html', import.meta.url), 'utf8');
    const shell = (id) => template.replace(/name="ao-build" content="[^"]+"/, `name="ao-build" content="${id}"`);
    writeFileSync(join(root, 'index.html'), shell('A'));
    for (const ext of ['js', 'css', 'json']) writeFileSync(join(root, 'file.' + ext), 'old');
    const prefix = mode === 'frontend root' ? '/' : '/v2/';
    const server = mode === 'Express'
      ? createApp({ readonly: false, publicDir: dir, mountRoutes() {} }).listen(0, '127.0.0.1')
      : createFrontendServer({ root, basePath: prefix }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    try {
      let res = await fetch(base + 'build.json'); assert.match(res.headers.get('cache-control'), /no-store/); assert.equal((await res.json()).buildId, 'A');
      assert.equal((await fetch(base + 'file.js?v=A')).status, 200);
      writeFileSync(join(root, 'index.html'), shell('B'));
      for (const ext of ['js', 'css', 'json']) writeFileSync(join(root, 'file.' + ext), 'new');
      assert.equal((await (await fetch(base + 'build.json')).json()).buildId, 'B');
      for (const ext of ['js', 'css', 'json']) {
        res = await fetch(base + 'file.' + ext + '?v=A'); assert.equal(res.status, 410); assert.equal(res.headers.get('cache-control'), 'no-store');
        res = await fetch(base + 'file.' + ext + '?v=B'); assert.equal(res.status, 200); assert.equal(await res.text(), 'new');
      }
      assert.match(await (await fetch(base + 'projets/prj_1')).text(), /name="ao-build" content="B"/);
    } finally { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });
}
