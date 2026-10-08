'use strict';
// /v2/ static files + SPA fallback (S3 add-on). Uses a temp public dir, so it doesn't depend on
// whether frontend has created public/v2/ yet.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createApp } = require('../../src/api/http');

const SHELL = '<!doctype html><base href="/"><meta name="ao-config" content=\'{"basePath":"/","apiBase":"/backend"}\'><title>v2</title>';   // F7 template markers

function serve(publicDir, readonly = false) {
  const app = createApp({ readonly, publicDir, mountRoutes: (a) => { a.get('/api/me', (req, res) => res.status(401).json({ error: 'unauthorized' })); } });
  return new Promise((r) => { const srv = app.listen(0, '127.0.0.1', () => r(srv)); });
}

describe('HTTP: /v2 static + SPA fallback', () => {
  let tmp, srv, base;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pub-'));
    fs.mkdirSync(path.join(tmp, 'v2', 'office'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>old</title>');
    fs.writeFileSync(path.join(tmp, 'v2', 'index.html'), SHELL);
    fs.writeFileSync(path.join(tmp, 'v2', 'app.js'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'v2', 'office', 'scene.js'), 'export {};');
    srv = await serve(tmp); base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const get = async (p) => { const r = await fetch(base + p, { redirect: 'follow' }); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') }; };

  it('serves the v2 shell for /v2, /v2/ and deep client routes', async () => {
    for (const p of ['/v2', '/v2/', '/v2/projets', '/v2/projets/prj_abc/historique', '/v2/journaux?cursor=x']) {
      const r = await get(p);
      assert.equal(r.status, 200, p); assert.match(r.text, /<title>v2<\/title>/, p); assert.match(r.cache, /no-cache/, p);
    }
  });

  it('F7: the shell is rendered once with basePath /v2/ and the API on the same root; config.json says the same', async () => {
    for (const p of ['/v2/', '/v2/index.html', '/v2/projets']) {
      const r = await get(p);
      assert.match(r.text, /<base href="\/v2\/">/, p);
      // the mount point and API root (frontend may add fields, e.g. apiVersion for the /api/v3 switch: G5)
      assert.ok(r.text.includes(`content='{&quot;basePath&quot;:&quot;/v2/&quot;,&quot;apiBase&quot;:&quot;&quot;`), p);
    }
    const c = await get('/v2/config.json');
    const conf = JSON.parse(c.text);
    assert.deepEqual([conf.basePath, conf.apiBase], ['/v2/', '']); assert.ok(conf.apiVersion === undefined || conf.apiVersion === 2, 'backend-served /v2 stays on /api/v2 until the switch'); assert.match(c.cache, /no-cache/);
  });

  it('a template without the F7 markers fails loudly (500 for the shell), assets still served', async () => {
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pub-'));
    fs.mkdirSync(path.join(t3, 'v2'), { recursive: true });
    fs.writeFileSync(path.join(t3, 'v2', 'index.html'), '<!doctype html><title>no markers</title>');
    fs.writeFileSync(path.join(t3, 'v2', 'app.js'), 'export {};');
    const s3 = await serve(t3);
    try {
      const b = `http://127.0.0.1:${s3.address().port}`;
      for (const p of ['/v2/', '/v2/projets']) { const r = await fetch(b + p); assert.equal(r.status, 500, p); assert.doesNotMatch(await r.text(), /no markers/); }
      assert.equal((await fetch(b + '/v2/app.js')).status, 200);
    } finally { s3.close(); fs.rmSync(t3, { recursive: true, force: true }); }
  });

  it('serves real files under /v2 and 404s missing assets (never the shell)', async () => {
    assert.equal((await get('/v2/app.js')).text, 'export {};');
    assert.match((await get('/v2/app.js')).type, /javascript/);
    assert.equal((await get('/v2/office/scene.js')).status, 200);
    for (const p of ['/v2/missing.js', '/v2/office/nope.png']) { const r = await get(p); assert.equal(r.status, 404, p); assert.doesNotMatch(r.text, /<title>(v2|old)</, p); }
  });

  it('S16: the old UI\'s routes go to /v2/ (never its index.html); the API is left alone', async () => {
    for (const p of ['/', '/index.html', '/journaux', '/v2x']) {   // /v2x is not under /v2
      const r = await fetch(base + p, { redirect: 'manual' });
      assert.deepEqual([r.status, r.headers.get('location')], [302, '/v2/'], p);
    }
    const me = await get('/api/me'); assert.equal(me.status, 401); assert.deepEqual(JSON.parse(me.text), { error: 'unauthorized' });
  });

  it('404s /v2 routes cleanly while public/v2/index.html does not exist yet', async () => {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pub-'));
    fs.writeFileSync(path.join(t2, 'index.html'), '<title>old</title>');
    const s2 = await serve(t2);
    try {
      const r = await fetch(`http://127.0.0.1:${s2.address().port}/v2/projets`);
      assert.equal(r.status, 404); assert.doesNotMatch(await r.text(), /old/);
    } finally { s2.close(); fs.rmSync(t2, { recursive: true, force: true }); }
  });
});

describe('HTTP: /v2 routing on the canonical decoded path (R2-10)', () => {
  let tmp, srv, base;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pub-'));
    fs.mkdirSync(path.join(tmp, 'v2'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>old</title>');
    fs.writeFileSync(path.join(tmp, 'v2', 'index.html'), SHELL);
    fs.writeFileSync(path.join(tmp, 'v2', 'app.js'), 'export {};');
    srv = await serve(tmp); base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

  it('encoded prefixes and extensions route like their decoded forms', async () => {
    assert.match((await get('/v%32/projets')).text, /<title>v2</);
    assert.match((await get('/%76%32/projets/prj_x')).text, /<title>v2</);
    for (const p of ['/v2/missing%2ejs', '/v2/missing%2Ejs', '/v%32/missing.js']) { const r = await get(p); assert.equal(r.status, 404, p); assert.doesNotMatch(r.text, /<title>(v2|old)</, p); }
    assert.equal((await get('/v%32/app.js')).text, 'export {};');
  });

  it('dot segments are normalised and malformed encodings are refused', async () => {
    assert.match((await get('/v2/x/%2e%2e/projets')).text, /<title>v2</);
    const out = await fetch(base + '/v2/%2e%2e/journaux', { redirect: 'manual' });
    assert.deepEqual([out.status, out.headers.get('location')], [302, '/v2/'], 'leaves /v2 after normalisation: an old-UI route');
    assert.equal((await get('/v2/%E0%A4%A')).status, 400);
    assert.equal((await get('/v2/a%00b')).status, 400);
  });
});
