// F10 performance budget for the UI's first load, computed from the files (scripts/first-load.js): no browser, no
// timing, so it is stable in CI. Measured on throttled 4G in design/reports/frontend-16.md. Raising a budget is a
// decision for the report that does it, not a test edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { firstLoad, preloadBlock, routePreloadScript, routePaths, MARK, ROOT } = require('../../scripts/first-load.js');

export const BUDGET = {
  // F11: the core (what every page needs: shell, sign-in, i18n, API, stream) and each page's own chunk.
  requests: 40,                       // index.html + 3 stylesheets + 2 boot scripts + the core module graph
  jsBytes: 300 * 1024, jsGzip: 95.5 * 1024, // identity-theme bootstrap is 0.15 KB gzipped; see identity-themes-1.md
  cssBytes: 160.5 * 1024, cssGzip: 30.5 * 1024, // +0.5 KB 2026-10-11: real provider logos (owner P0)
  routeGzip: 102 * 1024,              // the Bureau floor registry adds 4.5 KB gz; see design/reports/floors-04.md
  landingGzip: 195 * 1024,            // core + Bureau floor registry; see design/reports/floors-04.md
  criticalDepth: 1,                   // every module is preloaded: no import waterfall (1 round trip per level on 4G)
  loginArt: 120 * 1024,               // the sign-in illustration (the largest paint of a first visit)
};

const r = firstLoad();
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

test('first load: requests, JS and CSS stay within the budget (raw and gzip)', () => {
  const over = [];
  if (r.requests > BUDGET.requests) over.push(`requests ${r.requests} > ${BUDGET.requests}`);
  if (r.js.bytes > BUDGET.jsBytes) over.push(`JS ${kb(r.js.bytes)} > ${kb(BUDGET.jsBytes)}`);
  if (r.js.gzip > BUDGET.jsGzip) over.push(`JS gzip ${kb(r.js.gzip)} > ${kb(BUDGET.jsGzip)}`);
  if (r.css.bytes > BUDGET.cssBytes) over.push(`CSS ${kb(r.css.bytes)} > ${kb(BUDGET.cssBytes)}`);
  if (r.css.gzip > BUDGET.cssGzip) over.push(`CSS gzip ${kb(r.css.gzip)} > ${kb(BUDGET.cssGzip)}`);
  for (const [name, x] of Object.entries(r.routes)) if (x.gzip > BUDGET.routeGzip) over.push(`route ${name} ${kb(x.gzip)} gz > ${kb(BUDGET.routeGzip)}`);
  if (r.js.gzip + r.routes.bureau.gzip > BUDGET.landingGzip) over.push(`landing ${kb(r.js.gzip + r.routes.bureau.gzip)} gz > ${kb(BUDGET.landingGzip)}`);
  assert.deepEqual(over, [], 'first-load budget (node scripts/first-load.js prints the table)');
});

test('setup owns its onboarding dictionary and styles; signed-in pages do not load them', () => {
  const dictionary = 'messages/onboarding.js';
  assert.ok(!r.files.some((f) => f.rel === dictionary));
  assert.ok(r.routes.setup.modules.includes(dictionary));
  for (const [name, route] of Object.entries(r.routes)) if (name !== 'setup') assert.ok(!route.modules.includes(dictionary), name);
  assert.doesNotMatch(readFileSync(ROOT + '/app.css', 'utf8'), /\.ao-(?:setup|onb)[\s_-]/);
  assert.doesNotMatch(readFileSync(ROOT + '/index.html', 'utf8'), /rel="stylesheet"[^>]*setup\.css/);
});

test('Santé owns its UI dictionary; only the Santé route loads it', () => {
  const dictionary = 'messages/health.js';
  assert.ok(!r.files.some((f) => f.rel === dictionary), 'health copy is absent from the landing/core graph');
  assert.ok(r.routes.sante.modules.includes(dictionary), 'Santé loads its dictionary with the route');
  for (const [name, route] of Object.entries(r.routes)) if (name !== 'sante') assert.ok(!route.modules.includes(dictionary), name);
});

test('release notes data and copy stay on the À propos route', () => {
  const core = new Set(r.files.map((f) => f.rel));
  assert.ok(!core.has('release-notes.js'));
  assert.ok(!core.has('messages/releases.js'));
  assert.ok(r.routes['a-propos'].modules.includes('release-notes.js'));
  assert.ok(r.routes['a-propos'].modules.includes('messages/releases.js'));
});

test('F11: pages are lazy chunks; each route\'s modules are in route-preload.js (no waterfall on arrival or navigation)', () => {
  assert.equal(readFileSync(ROOT + '/route-preload.js', 'utf8'), routePreloadScript(), 'run: node scripts/first-load.js --write');
  const paths = routePaths();
  for (const name of Object.keys(r.routes)) if (name !== 'setup') assert.ok(paths[name], `${name} has a route`);
  assert.ok(Object.keys(r.routes).length >= 14, 'every page is lazy');
  const core = new Set(r.files.map((f) => f.rel));
  const pageEntries = Object.values(r.routes).map((x) => x.entry);
  assert.deepEqual(pageEntries.filter((e) => core.has(e)), [], 'no page module is statically imported into the core again');
  const html = readFileSync(ROOT + '/index.html', 'utf8');
  assert.ok(html.indexOf('route-preload.js') < html.indexOf('type="module" src="app.js?v='), 'route-preload.js runs before app.js');
});

test('no import waterfall: index.html preloads exactly the static module graph', () => {
  const html = readFileSync(ROOT + '/index.html', 'utf8');
  const block = MARK.exec(html);
  assert.ok(block, 'index.html keeps its modulepreload markers');
  const hrefs = (text) => [...text.matchAll(/modulepreload" href="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(hrefs(block[0]), hrefs(preloadBlock()), 'run: node scripts/first-load.js --write');
  assert.ok(firstLoad().criticalDepth <= BUDGET.criticalDepth, `critical depth ${r.criticalDepth}`);
});

test('the public login uses the office scene instead of the former boxed illustration assets', () => {
  const css = readFileSync(ROOT + '/app.css', 'utf8');
  const page = readFileSync(ROOT + '/pages/login.js', 'utf8');
  assert.match(css, /\.bu-login__scene/);
  assert.doesNotMatch(css, /Illustrations\/login-/);
  assert.match(page, /office\/scene\.js/);
  assert.match(page, /manifest\.example\.json/);
});

test('the static server compresses text and answers revalidations with 304 (serve-frontend)', () => {
  const src = readFileSync(new URL('../../scripts/serve-frontend.js', import.meta.url), 'utf8');
  assert.match(src, /content-encoding'\] = 'gzip'/);
  assert.match(src, /if-none-match/);
});

test('fonts are self-hosted: index.html, the stylesheets and the manifest name no external origin', () => {
  const files = ['index.html', 'app.css', 'bureau/bureau.css', 'bureau/bundle.css', 'manifest.webmanifest'];
  const ext = [];
  for (const f of files) {
    const text = readFileSync(ROOT + '/' + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')]*/gi)) ext.push(f + ': ' + m[0]);
  }
  assert.deepEqual(ext, [], 'no third-party request (PM on frontend-16)');
  const src = readFileSync(new URL('../../design/css/bureau.css', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /googleapis|gstatic|@import/);
});

test('the preloaded fonts exist, are used by @font-face, and the OFL licences ship with them', () => {
  const html = readFileSync(ROOT + '/index.html', 'utf8');
  const css = readFileSync(ROOT + '/bureau/bureau.css', 'utf8');
  const pre = [...html.matchAll(/<link rel="preload" href="bureau\/(fonts\/[\w-]+\.woff2)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
  assert.ok(pre.length >= 1 && pre.length <= 2, 'one or two fonts above the fold: ' + pre.join());
  for (const p of pre) {
    assert.ok(statSync(ROOT + '/bureau/' + p).size > 0, p);
    assert.ok(css.includes(`url("${p}")`), p + ' is a face of bureau.css');
  }
  assert.ok([...css.matchAll(/@font-face \{[^}]*\}/g)].every((m) => /font-display: swap/.test(m[0])), 'font-display: swap everywhere');
  for (const lic of ['OFL-inter.txt', 'OFL-sora.txt', 'OFL-jetbrainsmono.txt']) assert.match(readFileSync(ROOT + '/bureau/fonts/' + lic, 'utf8'), /SIL OPEN FONT LICENSE/i);
});

test('artist-15 state spots: every slug the UI uses has a light and a dark WebP, each within 60 KB at 960 × 640', async () => {
  const ui = readFileSync(ROOT + '/components/ui.js', 'utf8');
  const files = [...ui.matchAll(/'(state-[\w-]+-(?:light|dark)\.webp)'/g)].map((m) => m[1]);
  assert.equal(files.length, 12, files.join());
  for (const f of files) {
    const buf = readFileSync(ROOT + '/bureau/assets/Illustrations/' + f);
    assert.ok(buf.length <= 60 * 1024, `${f} ${kb(buf.length)}`);
    // VP8X canvas size (RIFF WebP extended header): 24-bit width-1 and height-1 at bytes 24 and 27.
    assert.equal(buf.toString('ascii', 12, 16), 'VP8X', f);
    const w = 1 + buf.readUIntLE(24, 3), h = 1 + buf.readUIntLE(27, 3);
    assert.deepEqual([w, h], [960, 640], f);
  }
});
