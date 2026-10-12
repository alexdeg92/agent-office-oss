// F7 runtime config (public/v2/config.js) and its server half (scripts/serve-frontend.js): one config, two mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalise, readConfig, configure, config, apiUrl, assetUrl, routeBase, DEFAULTS } from '../../public/v2/config.js';
import serve from '../../scripts/serve-frontend.js';

const INDEX = readFileSync(new URL('../../public/v2/index.html', import.meta.url), 'utf8');
const fakeDoc = (content) => ({ querySelector: () => (content == null ? null : { getAttribute: () => content }) });

test('defaults are the production topology: UI at /, API behind /backend', () => {
  assert.deepEqual(DEFAULTS, { basePath: '/', apiBase: '/backend', apiVersion: DEFAULTS.apiVersion });
  assert.ok([2, 3].includes(DEFAULTS.apiVersion));
  assert.deepEqual(readConfig(fakeDoc(null)), DEFAULTS);
  assert.deepEqual(readConfig(fakeDoc('pas du json')), DEFAULTS);
});

test('normalise: slashes, HTTPS split-origin API and hostile values fail closed', () => {
  assert.deepEqual(normalise({ basePath: '/v2', apiBase: '/backend/' }), { basePath: '/v2/', apiBase: '/backend', apiVersion: DEFAULTS.apiVersion });
  assert.deepEqual(normalise({ basePath: '/v2/', apiBase: '', apiVersion: 3 }), { basePath: '/v2/', apiBase: '', apiVersion: 3 });
  for (const bad of [4, '3', null, 2.5]) assert.equal(normalise({ apiVersion: bad }).apiVersion, DEFAULTS.apiVersion, 'G5: only 2 or 3, as a number; else the default');
  assert.equal(normalise({ apiBase: 'https://api.example/backend/' }).apiBase, 'https://api.example/backend');
  assert.equal(normalise({ apiBase: 'http://api.example/backend' }).apiBase, '/backend');
  assert.equal(normalise({ apiBase: '//ailleurs.example' }).apiBase, '/backend');
  assert.equal(normalise({ basePath: '//evil' }).basePath, '/');
  assert.equal(normalise({ basePath: '/a" onload="x' }).basePath, '/');
});

test('apiUrl, assetUrl, routeBase and assetBase follow the active config', () => {
  configure({ basePath: '/', apiBase: '/backend' });
  assert.equal(apiUrl('/api/v2/views/health'), '/backend/api/v2/views/health');
  assert.equal(assetUrl('bureau/assets/Logos/favicon.svg'), '/bureau/assets/Logos/favicon.svg');
  assert.equal(routeBase(), '');
  assert.equal(config.assetBase, '/bureau/');
  configure({ basePath: '/v2/', apiBase: '' });
  assert.equal(apiUrl('/api/v2/stream'), '/api/v2/stream');
  assert.equal(assetUrl('/bureau/x.png'), '/v2/bureau/x.png');
  assert.equal(routeBase(), '/v2');
  assert.equal(config.assetBase, '/v2/bureau/');
  configure({});
});

test('renderIndex writes <base> and the config meta that config.js reads back; og:image absolute with a public URL', () => {
  for (const cfg of [{ basePath: '/', apiBase: '/backend', apiVersion: 2 }, { basePath: '/v2/', apiBase: '', apiVersion: 3 }]) {
    const out = serve.renderIndex(INDEX, cfg);
    assert.match(out, new RegExp(`<base href="${cfg.basePath}">`));
    const content = /<meta name="ao-config" content='([^']*)'>/.exec(out)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.deepEqual(readConfig(fakeDoc(content)), cfg);
  }
  const out = serve.renderIndex(INDEX, { basePath: '/' }, { publicUrl: 'https://agent.exemple.ca/ignored' });
  assert.match(out, /<meta property="og:image" content="https:\/\/agent\.exemple\.ca\/bureau\/assets\/Logos\/og-agent-office\.png">/);
  assert.throws(() => serve.renderIndex('<html></html>', {}), /no <base href>/);
  assert.equal(serve.normaliseConfig({ apiBase: 'https://api.example/backend/' }).apiBase, 'https://api.example/backend');
  for (const apiBase of ['http://api.example/backend','https://user@api.example/backend','https://api.example/a%2fb','https://api.example/backend?x=1'])
    assert.throws(() => serve.normaliseConfig({ apiBase }), /invalid API base/);
  assert.throws(() => serve.normaliseConfig({ apiVersion: 4 }), /invalid API version/);
  assert.equal(serve.normaliseConfig({ apiVersion: '3' }).apiVersion, 3, 'AO_API_VERSION=3 from the environment');
});

test('frontend-21: one switch. An unpinned deployment writes no apiVersion, so the page follows config.js DEFAULTS.apiVersion', () => {
  assert.equal('apiVersion' in serve.normaliseConfig({}), false);
  assert.equal('apiVersion' in serve.normaliseConfig({ apiVersion: '' }), false, 'an empty AO_API_VERSION is unset');
  const out = serve.renderIndex(INDEX, { basePath: '/', apiBase: '/backend' });
  const content = /<meta name="ao-config" content='([^']*)'>/.exec(out)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.deepEqual(readConfig(fakeDoc(content)), { basePath: '/', apiBase: '/backend', apiVersion: DEFAULTS.apiVersion });
  for (const pinned of [2, 3]) {
    const c = /<meta name="ao-config" content='([^']*)'>/.exec(serve.renderIndex(INDEX, { basePath: '/', apiBase: '/backend', apiVersion: pinned }))[1].replace(/&quot;/g, '"');
    assert.equal(readConfig(fakeDoc(c)).apiVersion, pinned, 'a pinned deployment keeps its version whatever the default');
  }
});

test('index.html, manifest and CSS carry no mount point: every URL is relative to <base>', () => {
  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(strip(INDEX).replace(/<base href="\/">/, ''), /(href|src|content)="\/(?!\/)/, 'no root-absolute URL in index.html');
  const manifest = JSON.parse(readFileSync(new URL('../../public/v2/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const i of manifest.icons) assert.ok(!i.src.startsWith('/'), i.src);
  const css = readFileSync(new URL('../../public/v2/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /url\(['"]?\//, 'app.css url()s are relative');
});

test('UI modules keep transport in the API client and split-origin adapters', async () => {
  const { readdirSync } = await import('node:fs');
  const root = new URL('../../public/v2/', import.meta.url);
  const files = [];
  const walk = (dir, rel = '') => { for (const e of readdirSync(new URL(rel, dir), { withFileTypes: true })) {
    if (e.isDirectory()) { if (!['bureau', 'vendor', 'office'].includes(e.name) || rel) walk(dir, rel + e.name + '/'); }   // office/ is office-dev's (reported separately)
    else if (/\.(js|css|html)$/.test(e.name)) files.push(rel + e.name);
  } };
  walk(root);
  const bad = [];
  for (const f of files) {
    const code = readFileSync(new URL(f, root), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/['"`(]\/v2[/'"`]/.test(code)) bad.push(f + ': /v2 literal');
    // Connector marks read only their packaged public provenance catalog, never API data.
    if (!['api.js', 'split-auth.js', 'mock/server.js', 'pages/connector-brand.js'].includes(f) && /\bfetch\(/.test(code)) bad.push(f + ': fetch outside transport modules');
    if (!['app.js', 'split-stream.js'].includes(f) && /new EventSource\(/.test(code)) bad.push(f + ': EventSource outside stream modules');
  }
  assert.deepEqual(bad, []);
});
