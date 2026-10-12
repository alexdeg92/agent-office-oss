'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../../src/api/http');
const { contentSecurityPolicy, inlineScriptHashes, createFrontendServer } = require('../../scripts/serve-frontend');
const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../public/v2/index.html'), 'utf8');
async function fixture(trustProxy = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-direct-headers-')), root = path.join(tmp, 'v2'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'index.html'), TEMPLATE); fs.writeFileSync(path.join(root, 'local.js'), 'export const x=1;'); fs.writeFileSync(path.join(root, 'sw.js'), '');
  const app = createApp({ readonly: false, publicDir: tmp, trustProxy, mountRoutes(app) { app.get('/api/test', (req,res) => res.json({ ok: true })); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  return { root, server, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); } };
}
test('S03-02: direct shell aliases, SPA routes and static files have the current frontend policy', async () => {
  const f = await fixture(); let front;
  try {
    const shell = await fetch(f.origin + '/v2/'); const html = await shell.text(); const policy = contentSecurityPolicy(html, { apiBase: '' });
    for (const url of ['/v2/', '/v2/index.html', '/v%32/', '/v2/%69ndex.html', '/v2/index', '/v2/agents', '/v2/local.js', '/sw.js']) {
      const res = await fetch(f.origin + url); assert.equal(res.status, 200, url);
      assert.equal(res.headers.get('content-security-policy'), policy, url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY'); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin'); assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.match(res.headers.get('permissions-policy'), /camera=\(\)/); assert.equal(res.headers.get('strict-transport-security'), null);
    }
    for (const hash of inlineScriptHashes(html)) assert.ok(policy.includes(hash));
    front = createFrontendServer({ root: f.root, basePath: '/v2/', apiBase: '' }); await new Promise(r => front.listen(0, '127.0.0.1', r));
    const separate = await fetch(`http://127.0.0.1:${front.address().port}/v2/`);
    for (const h of ['content-security-policy','x-frame-options','x-content-type-options','referrer-policy','permissions-policy','cross-origin-opener-policy']) assert.equal(shell.headers.get(h), separate.headers.get(h), h);
    const api = await fetch(f.origin + '/api/test'); assert.match(api.headers.get('content-type'), /application\/json/); assert.deepEqual(await api.json(), { ok: true });
    assert.equal(api.headers.get('content-security-policy'), null);
  } finally { if (front) { front.closeAllConnections(); await new Promise(r => front.close(r)); } await f.close(); }
});
test('S03-02: replacing a deployed import map regenerates direct CSP hashes', async () => {
  const f = await fixture();
  try {
    const before = await fetch(f.origin + '/v2/'); const previous = before.headers.get('content-security-policy'); await before.text();
    const updated = TEMPLATE.replace(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (_,a,b,c) => a + b + ' ' + c);
    assert.notEqual(updated, TEMPLATE); fs.writeFileSync(path.join(f.root, 'index.html'), updated);
    const res = await fetch(f.origin + '/v2/'), html = await res.text();
    const current = res.headers.get('content-security-policy'); assert.notEqual(current, previous);
    assert.equal(current, contentSecurityPolicy(html)); for (const hash of inlineScriptHashes(html)) assert.ok(current.includes(hash));
  } finally { await f.close(); }
});
test('S03-02: HSTS only follows an established trusted HTTPS request', async () => {
  for (const trusted of [false, 'loopback']) {
    const f = await fixture(trusted);
    try { const r = await fetch(f.origin + '/v2/', { headers: { 'x-forwarded-proto':'https' } }); await r.text();
      assert.equal(r.headers.get('strict-transport-security'), trusted ? 'max-age=31536000' : null);
    } finally { await f.close(); }
  }
});
