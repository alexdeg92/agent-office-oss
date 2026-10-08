'use strict';
// Go-live topology (PM): the UI is served elsewhere; the API runs API-only behind a reverse proxy that strips
// `/backend` (Traefik StripPrefix). This test puts a real stripping proxy in front of the server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadScenario } = require('../helpers/scenario');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { urlFields } = require('../helpers/contract-shape');

// Minimal StripPrefix proxy: /backend/x → upstream /x, streaming both ways (SSE included); other paths 404.
function stripProxy(upstreamPort, prefix = '/backend') {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith(prefix + '/')) { res.writeHead(404); res.end('proxy: no route'); return; }
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url.slice(prefix.length), headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe('API-only mode behind a stripped /backend prefix', () => {
  let h, proxy, cookie;
  const seen = [];   // every proxied response: no Location header may ever appear
  const call = async (method, p, body, extra = {}) => {
    const r = await fetch(proxy.base + p, { method, redirect: 'manual', headers: Object.assign({ 'content-type': 'application/json', 'x-ao-request': '1' }, cookie ? { cookie } : {}, extra),
      body: body === undefined ? undefined : JSON.stringify(body) });
    seen.push([p, r.status, r.headers.get('location')]);
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, headers: r.headers, json, text };
  };
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { env: { AO_API_ONLY: '1' } });
    proxy = await stripProxy(h.port);
  });
  after(async () => { if (proxy) proxy.server.close(); if (h) await h.stop(); });

  it('serves the API at the stripped prefix and nothing else: no UI, no static files, JSON 404s', async () => {
    const meta = await call('GET', '/backend/api/v2/meta');
    assert.equal(meta.status, 200); assert.ok(meta.headers.get('x-request-id'));
    for (const p of ['/', '/v2/', '/v2/projets', '/index.html', '/app.js', '/_ds/x.css', '/v2']) {
      const r = await fetch(h.base + p, { redirect: 'manual' });
      assert.equal(r.status, 404, p); assert.equal(r.headers.get('location'), null, p);
      assert.equal((await r.json()).error.code, 'not_found', p);
    }
  });

  it('login through the proxy sets taco_sess with Path=/ and no Domain; the session works on /backend/api', async () => {
    const r = await call('POST', '/backend/api/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie');
    assert.match(set, /; Path=\/; /); assert.doesNotMatch(set, /Domain=/i);
    cookie = set.split(';')[0];
    const me = await call('GET', '/backend/api/v2/me');
    assert.equal(me.status, 200); assert.equal(me.json.data.gateway, 'up');
  });

  it('the SSE stream works through the proxy (hello, snapshot)', async () => {
    const S = openSse(proxy.base, '/backend/api/v2/stream?topics=health', { cookie });
    try {
      const hello = await S.next((f) => f.event === 'hello');
      assert.equal(hello.data.resumed, false);
      const snap = await S.next((f) => f.event === 'snapshot' && f.data.topic === 'health');
      assert.ok(snap.data.rev >= 1);
    } finally { S.close(); }
  });

  it('live v2 responses carry no relative URL (frontend-07)', async () => {
    const created = await call('POST', '/backend/api/v2/projects', { name: 'URL check', sources: [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'agent-office' } }] });
    assert.equal(created.status, 200);
    const id = created.json.data.vm.id;
    const bad = [];
    for (const p of ['/backend/api/v2/meta', '/backend/api/v2/me', '/backend/api/v2/views/health', '/backend/api/v2/views/projects', `/backend/api/v2/views/projects/${id}`, `/backend/api/v2/views/projects/${id}/history`]) {
      const r = await call('GET', p);
      for (const [path_, u] of urlFields(r.json)) if (!/^https?:\/\//.test(u)) bad.push(p + ' ' + path_ + ' ' + u);
    }
    assert.deepEqual(bad, []);
  });

  it('logout through the proxy clears the cookie at Path=/; no response ever carried a Location header', async () => {
    const r = await call('POST', '/backend/api/logout');
    assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /^taco_sess=; .*Path=\/; Max-Age=0/);
    await call('GET', '/backend/api/v2/views/health');
    await call('GET', '/backend/api/v2/nope');
    assert.deepEqual(seen.filter(([, , loc]) => loc !== null), []);
  });
});
