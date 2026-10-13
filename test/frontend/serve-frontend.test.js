// scripts/serve-frontend.js security (review-13: R13-01, R13-10, R13-11, R13-12, R13-13). Synthetic files and
// loopback fake servers only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import serve from '../../scripts/serve-frontend.js';
import { readConfig, DEFAULTS } from '../../public/v2/config.js';

const INDEX = readFileSync(new URL('../../public/v2/index.html', import.meta.url), 'utf8');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

/** A raw HTTP/1.1 exchange, so paths (//, \) and headers reach the server exactly as written. */
function raw(port, request, { timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const end = (how) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve({ text: buf, how }); } };
    const timer = setTimeout(() => end('timeout'), timeout);
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => end('end'));
    sock.on('error', () => end('error'));
    sock.on('close', () => end('close'));
    sock.write(request);
  });
}

let root, outside, upstream, attacker, upstreamPort, attackerPort, front, frontPort;
const seen = { upstream: [], attacker: [] };
let upstreamHandler = null;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-serve-'));
  root = join(dir, 'ui');
  outside = join(dir, 'private');
  mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, 'bureau'));
  mkdirSync(join(root,'pages'),{recursive:true}); mkdirSync(join(root,'components','bureau'),{recursive:true});
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'bureau', 'ok.txt'), 'PUBLIC');
  writeFileSync(join(root,'pages','ds.js'),'export const example="synthetic gallery";');
  writeFileSync(join(root,'pages','design-system.css'),'.ds-gallery{}');
  writeFileSync(join(root,'components','bureau','primitives.js'),'export const Example=()=>null;');
  writeFileSync(join(outside, 'secret.txt'), 'SYNTHETIC_PRIVATE');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(outside, join(root, 'linkdir'));

  upstream = http.createServer((req, res) => {
    seen.upstream.push({ url: req.url, headers: req.headers });
    if (upstreamHandler) return upstreamHandler(req, res);
    res.writeHead(200, { 'content-type': 'application/json', connection: 'x-review-response', 'x-review-response': 'response-hop-secret', 'keep-alive': 'timeout=5' });
    res.end('{"ok":true}');
  });
  attacker = http.createServer((req, res) => { seen.attacker.push({ url: req.url, headers: req.headers }); res.end('ATTACKER'); });
  upstreamPort = await listen(upstream);
  attackerPort = await listen(attacker);
  front = serve.createFrontendServer({ root, basePath: '/', apiBase: '/backend', apiProxy: `http://127.0.0.1:${upstreamPort}/api-root` });
  frontPort = await listen(front);
});
after(async () => { await close(front); await close(upstream); await close(attacker); rmSync(join(root, '..'), { recursive: true, force: true }); });

test('R13-01: the proxy never leaves its configured upstream (//, backslash, encoded variants); the cookie stays home', async () => {
  for (const path of [`//127.0.0.1:${attackerPort}/capture`, `/\\127.0.0.1:${attackerPort}/capture`, `/%2F%2F127.0.0.1:${attackerPort}/capture`, `/%5C%5C127.0.0.1:${attackerPort}/capture`, `/..//127.0.0.1:${attackerPort}/capture`]) {
    const r = await raw(frontPort, `GET /backend${path} HTTP/1.1\r\nHost: x\r\nCookie: taco_sess=synthetic-secret\r\nConnection: close\r\n\r\n`);
    assert.doesNotMatch(r.text, /ATTACKER/, path);
  }
  assert.deepEqual(seen.attacker, [], 'nothing reached the second server');
  for (const u of seen.upstream) assert.match(u.url, /^\/api-root\//, 'upstream path prefix kept: ' + u.url);
});

test('R13-01: only a loopback http upstream may be configured', () => {
  for (const bad of ['http://backend.example', 'https://127.0.0.1:1', 'http://user:pw@127.0.0.1:1', 'file:///etc/passwd', 'pas une url']) {
    assert.throws(() => serve.createFrontendServer({ root, apiProxy: bad }), /api-proxy/, bad);
  }
  assert.doesNotThrow(() => serve.createFrontendServer({ root, apiProxy: 'http://localhost:18789' }));
});

test('R13-11: forwarding headers are generated, never copied; hop-by-hop fields are dropped both ways', async () => {
  seen.upstream.length = 0;
  const r = await raw(frontPort, 'GET /backend/api/v2/meta HTTP/1.1\r\nHost: evil.invalid\r\nX-Forwarded-For: 198.51.100.77\r\nX-Forwarded-Host: evil.invalid\r\n'
    + 'Forwarded: for=198.51.100.77;host=evil.invalid\r\nX-Real-IP: 198.51.100.77\r\nConnection: close, x-review-hop\r\nX-Review-Hop: hop-secret\r\nCookie: taco_sess=s\r\n\r\n');
  const h = seen.upstream[0].headers;
  assert.equal(seen.upstream[0].url, '/api-root/api/v2/meta');
  assert.equal(h.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(h['x-forwarded-for'], '127.0.0.1');
  assert.equal(h['x-forwarded-prefix'], '/backend');
  assert.equal(h['x-forwarded-host'], undefined);
  assert.equal(h.forwarded, undefined);
  assert.equal(h['x-real-ip'], undefined);
  assert.equal(h['x-review-hop'], undefined);
  assert.equal(h.cookie, 'taco_sess=s', 'the session cookie does reach the configured API');
  assert.match(r.text, /^HTTP\/1\.1 200/);
  assert.doesNotMatch(r.text, /x-review-response|response-hop-secret|keep-alive: timeout/i);
});

test('R13-12: a severed upstream stream closes the browser-facing stream promptly', async () => {
  upstreamHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: hello\ndata: {}\n\n');
    setTimeout(() => res.socket.destroy(), 50);
  };
  const t0 = Date.now();
  const r = await raw(frontPort, 'GET /backend/api/v2/stream HTTP/1.1\r\nHost: x\r\n\r\n', { timeout: 1500 });
  upstreamHandler = null;
  assert.match(r.text, /event: hello/);
  assert.notEqual(r.how, 'timeout', 'the downstream connection must end, not hang');
  assert.ok(Date.now() - t0 < 1000);
});

test('R13-13: symlinks out of the served root are 404 (files and directories); real files still serve', async () => {
  const get = (p) => raw(frontPort, `GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  assert.match((await get('/bureau/ok.txt')).text, /^HTTP\/1\.1 200[\s\S]*PUBLIC$/);
  for (const p of ['/leak.txt', '/linkdir/secret.txt']) {
    const r = await get(p);
    assert.match(r.text, /^HTTP\/1\.1 404/, p);
    assert.doesNotMatch(r.text, /SYNTHETIC_PRIVATE/, p);
  }
  assert.match((await get('/x%00.png')).text, /^HTTP\/1\.1 400/, 'an encoded NUL is refused, not a crash');
});

test('the standalone static server omits owner-gallery files unless an authenticated edge enables them', async () => {
  for(const p of ['/design-system','/design-system/','/pages/ds.js','/pages/design-system.css','/components/bureau/primitives.js']) {
    assert.equal((await fetch(`http://127.0.0.1:${frontPort}${p}`)).status,404,p+' is omitted by default');
  }
  const trusted=serve.createFrontendServer({root,allowDesignSystem:true});
  const port=await listen(trusted);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/design-system`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/pages/ds.js`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/components/bureau/primitives.js`)).status,200);
  } finally {await close(trusted);}
});

test('R13-10: renderIndex writes config text literally ($&, $$, $`, quotes) and reads back identically', () => {
  for (const cfg of [{ basePath: '/$&/', apiBase: '/backend/$&' }, { basePath: '/a$$b/', apiBase: '/x$`y' }, { basePath: '/l&app/', apiBase: '' }]) {
    const out = serve.renderIndex(INDEX, cfg);
    assert.equal((out.match(/<base href=/g) || []).length, 1, JSON.stringify(cfg));
    const content = /<meta name="ao-config" content='([^']*)'>/.exec(out)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const doc = { querySelector: () => ({ getAttribute: () => content }) };
    assert.deepEqual(readConfig(doc), { apiVersion: DEFAULTS.apiVersion, ...serve.normaliseConfig(cfg) }, JSON.stringify(cfg));   // unpinned: the UI's default
    const base = /<base href="([^"]*)">/.exec(out)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.equal(base, serve.normaliseConfig(cfg).basePath);
  }
  assert.throws(() => serve.normaliseConfig({ basePath: '/a?b/' }), /base path/);
  assert.throws(() => serve.normaliseConfig({ basePath: '/a#b/' }), /base path/);
});

test('R15-13: a Connection-nominated Content-Length is dropped in both directions (Node frames the body)', async () => {
  seen.upstream.length = 0;
  upstreamHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'content-length, x-up-hop', 'x-up-hop': 'secret', 'content-length': '2' });
    res.end('ok');
  };
  const r = await raw(frontPort, 'POST /backend/api/v2/echo HTTP/1.1\r\nHost: x\r\nConnection: content-length, x-review-hop\r\nX-Review-Hop: hop-secret\r\nContent-Length: 12\r\n\r\n{"a":"bcde"}');
  upstreamHandler = null;
  const h = seen.upstream[0].headers;
  assert.equal(h['x-review-hop'], undefined);
  assert.notEqual(h['content-length'], '12', 'the nominated client Content-Length is not forwarded as such');
  assert.match(r.text, /^HTTP\/1\.1 200/);
  assert.doesNotMatch(r.text.split('\r\n\r\n')[0], /x-up-hop|content-length: 2\r?$/im);
});

test('F10: text goes out gzipped when accepted, every file has an ETag, and a revalidation is a 304', async () => {
  writeFileSync(join(root, 'big.js'), 'export const x = ' + JSON.stringify('lorem ipsum '.repeat(400)) + ';\n');
  writeFileSync(join(root, 'img.png'), Buffer.alloc(2048, 7));
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: frontPort, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const { gunzipSync } = await import('node:zlib');
  const plain = await get('/big.js');
  assert.equal(plain.res.headers['content-encoding'], undefined, 'no gzip unless accepted');
  const zipped = await get('/big.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(zipped.res.headers['content-encoding'], 'gzip');
  assert.equal(zipped.res.headers.vary, 'accept-encoding');
  assert.ok(zipped.body.length < plain.body.length / 4, `${zipped.body.length} vs ${plain.body.length}`);
  assert.deepEqual(gunzipSync(zipped.body), plain.body);
  assert.equal(Number(zipped.res.headers['content-length']), zipped.body.length);
  const tag = plain.res.headers.etag;
  assert.match(tag, /^"[\w-]+"$/);
  const again = await get('/big.js', { 'if-none-match': tag, 'accept-encoding': 'gzip' });
  assert.equal(again.res.statusCode, 304); assert.equal(again.body.length, 0);
  // the page (client routes included) and binaries
  const page = await get('/journaux', { 'accept-encoding': 'gzip' });
  assert.equal(page.res.headers['content-encoding'], 'gzip');
  assert.equal((await get('/journaux', { 'if-none-match': page.res.headers.etag })).res.statusCode, 304);
  const img = await get('/img.png', { 'accept-encoding': 'gzip' });
  assert.equal(img.res.headers['content-encoding'], undefined, 'binaries are sent as they are');
  assert.equal((await get('/img.png', { 'if-none-match': img.res.headers.etag })).res.statusCode, 304);
});

test('F12: security headers on every response; HSTS only over HTTPS; the CSP allows the import map by hash and nothing inline', async () => {
  const get = (p, headers = {}) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: frontPort, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject); });
  for (const p of ['/journaux', '/bureau/ok.txt', '/nope.js']) {
    const r = await get(p);
    assert.match(r.headers['content-security-policy'], /^default-src 'self'; script-src 'self' 'sha256-[A-Za-z0-9+/=]+'; style-src 'self';/, p);
    assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(r.headers['permissions-policy'], /camera=\(\), geolocation=\(\)/);
    assert.equal(r.headers['strict-transport-security'], undefined, p + ': no HSTS over plain http');
  }
  assert.equal((await get('/journaux', { 'x-forwarded-proto': 'https' })).headers['strict-transport-security'], 'max-age=31536000');
  // the hash is the import map's, exactly as served
  const { createHash } = await import('node:crypto');
  const page = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: frontPort, path: '/' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ b, csp: res.headers['content-security-policy'] })); }));
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page.b)[1];
  assert.ok(page.csp.includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`));
  assert.equal([...page.b.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="importmap")[^>]*>/g)].length, 0, 'no other inline script');
  assert.doesNotMatch(page.b.replace(/<!--[\s\S]*?-->/g, ''), /\sstyle="/, 'no inline style attribute in the page');
});

test('R27-06: Accept-Encoding is negotiated with its q-values: gzip;q=0 or identity-only gets the plain body', async () => {
  writeFileSync(join(root, 'neg.js'), 'export const y = ' + JSON.stringify('lorem ipsum '.repeat(400)) + ';\n');
  const enc = (ae) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: frontPort, path: '/neg.js', headers: ae == null ? {} : { 'accept-encoding': ae } }, (res) => { res.resume(); res.on('end', () => resolve(res.headers['content-encoding'] || 'identity')); }).on('error', reject));
  const cases = [
    ['gzip', 'gzip'], ['gzip, deflate, br', 'gzip'], ['GZIP;q=0.5', 'gzip'], ['*', 'gzip'], ['br;q=1, *;q=0.1', 'gzip'],
    ['gzip;q=0, identity;q=1', 'identity'], ['gzip;q=0.0', 'identity'], ['identity', 'identity'], ['*;q=0, identity', 'identity'],
    ['gzip;q=0, *;q=1', 'identity'], ['br', 'identity'], [null, 'identity'], ['', 'identity'],
  ];
  const got = [];
  for (const [ae, want] of cases) got.push([ae, await enc(ae), want]);
  assert.deepEqual(got.filter(([, a, w]) => a !== w), []);
});

test('PM on frontend-18: an absolute cross-origin apiBase is added to connect-src; a path keeps it same-origin', () => {
  const html = '<script type="importmap">{}</script>';
  const connect = (apiBase) => serve.contentSecurityPolicy(html, { apiBase }).split('; ').find((d) => d.startsWith('connect-src'));
  assert.equal(connect('/backend'), "connect-src 'self'");
  assert.equal(connect(''), "connect-src 'self'");
  assert.equal(connect('https://api.example.invalid/backend/'), "connect-src 'self' https://api.example.invalid");
  assert.equal(connect('http://127.0.0.1:9000'), "connect-src 'self' http://127.0.0.1:9000");
  assert.equal(connect('javascript:alert(1)'), "connect-src 'self'", 'never anything but an http(s) origin');
});

test('review-30: X-Forwarded-Proto counts only from a trusted proxy (AO_TRUST_PROXY semantics); else the socket decides', async () => {
  const strict = serve.createFrontendServer({ root, basePath: '/', apiBase: '/backend', trustProxy: '10.0.0.0/8' });
  const port = await listen(strict);
  try {
    const hsts = (p, headers) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: p, path: '/journaux', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.headers['strict-transport-security'] || null)); }).on('error', reject));
    assert.equal(await hsts(port, { 'x-forwarded-proto': 'https' }), null, 'a loopback peer is not a trusted proxy here: its header is ignored');
    assert.equal(await hsts(frontPort, { 'x-forwarded-proto': 'https' }), 'max-age=31536000', 'default trust (loopback): honoured');
    assert.equal(await hsts(frontPort, { 'x-forwarded-proto': 'http, https' }), null, 'the first (client-side) value decides');
  } finally { await close(strict); }
  const t = serve.trustProxyList('loopback,172.30.0.0/16,fd00::/8,203.0.113.7');
  assert.deepEqual(['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.30.4.2', '172.31.0.1', 'fd12::1', '203.0.113.7', '203.0.113.8', '10.0.0.1', ''].map(t),
    [true, true, true, true, false, true, true, false, false, false]);
  const u = serve.trustProxyList('uniquelocal');
  assert.deepEqual(['10.1.2.3', '192.168.1.1', '172.16.0.1', '8.8.8.8'].map(u), [true, true, true, false]);
  for (const bad of ['nope', '10.0.0.0/33', '::1/129', 'loopback,example.com']) assert.throws(() => serve.trustProxyList(bad), /invalid AO_TRUST_PROXY/, bad);
});

test('R32-04: AO_TRUST_PROXY is parsed by the API\'s own parser (proxy-addr, as Express): what the API refuses, the web unit refuses', async () => {
  const { createRequire } = await import('node:module');
  const proxyaddr = createRequire(import.meta.url)('proxy-addr');
  const apiAccepts = (spec) => { try { proxyaddr.compile(spec.split(',').map((v) => v.trim())); return true; } catch { return false; } };
  const webAccepts = (spec) => { try { serve.trustProxyList(spec); return true; } catch { return false; } };
  const specs = ['127.0.0.0/8/ignored', '::1/128/ignored', '10.0.0.0/33', '::1/129', 'nope', 'loopback,example.com', '10.0.0.0/8 /8', '1.2.3.4/', '/8',
    'loopback', 'loopback,172.30.0.0/16', 'uniquelocal,linklocal', '::ffff:127.0.0.1', 'fd00::/8', '203.0.113.7', '10.0.0.0/255.0.0.0'];
  assert.deepEqual(specs.map((s) => [s, webAccepts(s)]), specs.map((s) => [s, apiAccepts(s)]));
  assert.equal(webAccepts('127.0.0.0/8/ignored'), false);
  assert.throws(() => serve.createFrontendServer({ root, trustProxy: '::1/128/ignored' }), /AO_TRUST_PROXY/, 'startup fails');
});

test('T-0106: only a successful current-release file is immutable; every error (404, 410, 5xx) is no-store', async () => {
  const build = /<meta name="ao-build" content="([^"]+)">/.exec(INDEX)[1];
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${frontPort}${p}`); await r.arrayBuffer(); return [r.status, r.headers.get('cache-control')]; };
  assert.deepEqual(await get(`/pages/ds-late.js?v=${build}`), [404, 'no-store'], 'a missing current-release module is never cached');
  assert.deepEqual(await get('/pages/ds-late.js'), [404, 'no-store']);
  assert.deepEqual(await get(`/bureau/missing.txt?v=${build}`), [404, 'no-store']);
  assert.deepEqual(await get('/pages/ds-late.js?v=0000000000000000'), [410, 'no-store']);
  writeFileSync(join(root, 'pages', 'ds-late.js'), 'export const late = 1;');
  assert.deepEqual(await get(`/pages/ds-late.js?v=${build}`), [200, 'public, max-age=31536000, immutable'], 'the same URL serves once the file exists');
  assert.deepEqual(await get('/pages/ds-late.js'), [200, 'no-cache, must-revalidate'], 'an unversioned module still revalidates');
  assert.match((await get(`/?v=${build}`))[1], /no-cache/, 'the shell is never immutable');
});
