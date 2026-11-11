// F7 runtime config (public/v2/config.js) and its server half (scripts/serve-frontend.js): one config, two mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

function transportCallFingerprint(source, start) {
  const open = source.indexOf('(', start);
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (char === '/' && next === '/') { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue; }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) {
      const expression = source.slice(start, i + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
      return createHash('sha256').update(expression).digest('hex');
    }
  }
  return null;
}

function transportBoundaryViolations(sources, allowedSites, scannedFiles) {
  const bad = [];
  const marker = /\/\* (?:transport-allow:|t:)(fetch|EventSource):([a-z0-9-]+) \*\//g;
  for (const file of scannedFiles) {
    const expected = new Map(Object.entries(allowedSites[file] || {}).map(([site, fingerprint]) => [site, { fingerprint, count: 0 }]));
    let lineOffset = 0;
    for (const [index, line] of (sources[file] || '').split('\n').entries()) {
      const markers = [...line.matchAll(marker)];
      const code = line.replace(marker, (value) => ' '.repeat(value.length));
      const operations = [...(code.matchAll(/\bfetch\s*\(|\bnew\s+EventSource\s*\(/g))];
      for (const match of markers) {
        const site = `${match[1]}:${match[2]}`;
        if (!expected.has(site)) bad.push(`${file}:${index + 1}: undeclared transport marker ${site}`);
        else expected.get(site).count++;
      }
      for (const operation of operations) {
        const kind = operation[0].includes('EventSource') ? 'EventSource' : 'fetch';
        const matching = markers.filter((match) => match[1] === kind);
        if (matching.length !== 1) bad.push(`${file}:${index + 1}: ${kind} call needs one exact-line marker`);
        else {
          const site = `${kind}:${matching[0][2]}`;
          const expectedSite = expected.get(site);
          if (expectedSite && transportCallFingerprint(sources[file], lineOffset + operation.index) !== expectedSite.fingerprint) {
            bad.push(`${file}:${index + 1}: ${site} call fingerprint changed`);
          }
        }
      }
      if (markers.length !== operations.length) bad.push(`${file}:${index + 1}: marker count does not match transport call count`);
      lineOffset += line.length + 1;
    }
    for (const [site, entry] of expected) if (entry.count !== 1) bad.push(`${file}: expected exactly one ${site} marker, found ${entry.count}`);
  }
  return bad;
}

test('transport exceptions are scoped to one marked call site', () => {
  const files = ['pages/chat-api.js'];
  const expression = 'fetch(apiUrl(path))';
  const allow = { 'pages/chat-api.js': { 'fetch:chat-request': transportCallFingerprint(expression, 0) } };
  const oneCall = { 'pages/chat-api.js': 'return fetch(apiUrl(path)) /* t:fetch:chat-request */;' };
  assert.deepEqual(transportBoundaryViolations(oneCall, allow, files), []);
  const replaced = { 'pages/chat-api.js': "return fetch('/other') /* t:fetch:chat-request */;" };
  assert.ok(transportBoundaryViolations(replaced, allow, files).some((item) => item.includes('call fingerprint changed')));
  const relocated = { 'pages/chat-api.js': 'return fetch(apiUrl(path));\n/* t:fetch:chat-request */' };
  assert.ok(transportBoundaryViolations(relocated, allow, files).some((item) => item.includes('exact-line marker')));
  const duplicate = { 'pages/chat-api.js': `${oneCall['pages/chat-api.js']}\nreturn fetch('/unreviewed');` };
  assert.ok(transportBoundaryViolations(duplicate, allow, files).some((item) => item.includes('fetch call needs one exact-line marker')));
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
  const sources = {};
  for (const f of files) {
    const code = readFileSync(new URL(f, root), 'utf8');
    sources[f] = code;
    const uncommented = code.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/['"`(]\/v2[/'"`]/.test(uncommented)) sources[f] += '\n/* checker: /v2 literal */';
  }
  // Each marker is on the exact line of one reviewed call. New calls in these files
  // still fail; markers are also bound to SHA-256 fingerprints of normalized calls.
  const allowedSites = {
    'api.js': {
      'fetch:api-prewarm': '42b0d7dea51e2404bf8f6db35b572c27e69d96ea8e397be72cb81de7c6ceb849',
      'fetch:ui-build': '1388618413fc266e23129cb01b177314e20673ce69a41b0e8fbb01094ba837d4',
      'fetch:meta': '2cea5a0967fa4ff57bf7a2729d5808325668d9e2add139452a8478c38bdabf9b',
      'fetch:request': '658d176568aaa27c106ce0f02493a304b9ac91596a66eb26ce3a69c0c8e95031',
      'fetch:me': '65eba11d3e0fff1441359caf9dc35368fa2eaed289a9651b12c3c7eefa12f34e',
      'fetch:asset-text': 'f9850503f7b84eb8d842512ae6dd8977748a1284b6cebb7c86e0af7451ae592c',
      'fetch:asset-json': '9b07cf91ee7348d306d680d54154d85b43a802c5096dda7948885a679f99ad03',
    },
    'split-auth.js': {
      'fetch:auth-operation': 'efc061f344e8985e79dc1d25146830daa49af0e3ff7da7e1489ed2e48375e601',
      'fetch:split-request': '705f0fd60f68f42ca0b2b6cbcdc13958147f47cc531636287d2dbfecc9737bc9',
    },
    'mock/server.js': {
      'fetch:office-asset': '0a16f37339dbb383d8faf1f2c34f943fa79483220f8c8c2664b0b4d7724e5fea',
      'fetch:settings-example': '9f3ba89fcfa7e300ccb37562c83e0acd017380bf0993547bc156ad74d5c5b547',
      'fetch:setup-catalog': '71645309c479c960233ff77679ac61cfd2e923691c499a5dc0a5c2ec70815424',
      'fetch:store-catalog': 'a8998ce511ac3a7c7626c7857316ca1a60ff93ed4b249f0c4fac4f6aa571b2c5',
    },
    'mock/palette.js': { 'fetch:palette-catalog': '3500f41e3b2b2162febc786d1ba12f2c36d4a41f2f2c344c0a91aacf980d6f90' },
    'pages/chat-api.js': { 'fetch:chat-request': 'e72a7982166b655ef8792a9b71c0b0f32eb3b5e1b5e67ea651b17cd1063bf824' },
    'app.js': { 'EventSource:app-stream': '6ead8506e5bd27d26018c6d3e9ba6304245d7633e7d39c629a22ba4db0b70d77' },
    'split-stream.js': { 'EventSource:split-stream': 'c20ae6bfbe867e560158bd75482989fbabaa501a9e9f290e54a18f81e6d372e3' },
    'pages/chat-live.js': { 'EventSource:chat-stream': 'e938b8f13233aa6838260ba692b5d9f44c5b08dc05a34fdc0ee25d6c2380fc0e' },
    'pages/project-live.js': { 'EventSource:project-stream': 'e938b8f13233aa6838260ba692b5d9f44c5b08dc05a34fdc0ee25d6c2380fc0e' },
  };
  const bad = transportBoundaryViolations(sources, allowedSites, files);
  for (const [file, source] of Object.entries(sources)) if (/['"`(]\/v2[/'"`]/.test(source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))) bad.push(file + ': /v2 literal');
  assert.deepEqual(bad, []);
});
