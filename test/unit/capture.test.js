'use strict';
// S7d: the screenshot capturer and its egress proxy (SSRF safety). Real Chrome is used only when installed, against a
// local server that must NEVER be reached (the proxy refuses loopback); everything else uses a fake browser.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { isBlockedIp, createEgressProxy } = require('../../src/capture/egress-proxy');
const { createCapturer, findChrome, shotPath } = require('../../src/capture/capturer');
const { createPublicUrls } = require('../../src/api/v2/urls');

const PUBLIC = createPublicUrls({ publicUrl: 'https://agent.example', publicApiBase: '/backend' });
const connectVia = (port, target) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
  let buf = ''; s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(Number(buf.split(' ')[1])); } });
  s.on('error', () => resolve(0));
});

describe('capture · egress proxy', () => {
  it('special-purpose addresses are blocked, v4 and v6, including mapped, NAT64, CGNAT/tailnet and metadata', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.100.100.100', '169.254.169.254', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.0.8',
      '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1', 'fd00::1', 'fec0::1', 'ff02::1', '64:ff9b::a00:1', 'not-an-ip']) assert.equal(isBlockedIp(ip), true, ip);
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
  });

  it('check(): only 80/443; any private address of a name refuses it; the pinned address is the checked one; each request re-resolves', async () => {
    let answers = [[{ address: '93.184.216.34' }], [{ address: '10.0.0.5' }]];
    const proxy = createEgressProxy({ lookup: async () => answers.shift() || [] });
    assert.equal(await proxy.check('site.example', 443), '93.184.216.34');
    assert.equal(await proxy.check('site.example', 443), null, 'rebinding to a private address on the next request is refused');
    const mixed = createEgressProxy({ lookup: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] });
    assert.equal(await mixed.check('mixed.example', 443), null, 'any private answer refuses the name');
    for (const [h, p] of [['site.example', 22], ['localhost', 443], ['x.localhost', 80], ['nas.local', 443], ['db.internal', 443], ['127.0.0.1', 443], ['[::1]', 443]]) {
      assert.equal(await mixed.check(h, p), null, h + ':' + p);
    }
  });

  it('CONNECT and plain-http requests to private targets get 403 and nothing is contacted', async () => {
    let hits = 0;
    const victim = http.createServer((req, res) => { hits++; res.end('secret'); });
    await new Promise((r) => victim.listen(0, '127.0.0.1', r));
    const proxy = createEgressProxy({ lookup: async () => [{ address: '127.0.0.1' }] });
    const port = await proxy.listen();
    try {
      assert.equal(await connectVia(port, '127.0.0.1:' + victim.address().port), 403);
      assert.equal(await connectVia(port, 'rebind.example:443'), 403);
      const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: 'http://127.0.0.1:' + victim.address().port + '/' }, resolve));
      assert.equal(r.statusCode, 403);
      assert.equal(hits, 0);
      assert.ok(proxy.stats.refused >= 3);
    } finally { await proxy.close(); victim.close(); }
  });
});

describe('capture · capturer with a fake browser', () => {
  let tmp, data;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cap-')); data = path.join(tmp, 'data'); fs.mkdirSync(data); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // a fake chrome: records its argv, tries a private CONNECT through the proxy it was given, writes the requested output
  const fake = (body) => { const f = path.join(tmp, 'chrome-' + Math.random().toString(36).slice(2)); fs.writeFileSync(f, '#!/usr/bin/env node\n' + body, { mode: 0o755 }); return f; };
  const PNG = "Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0])";
  const common = `const a=process.argv.slice(2); const fs=require('fs'); const out=a.find(x=>x.startsWith('--screenshot=')).slice(13);
fs.writeFileSync(${JSON.stringify(path.join('ARGS'))}.replace('ARGS', process.env.HOME + '/../args.json'), JSON.stringify(a));`;

  it('no capturer without a browser or an https public origin', () => {
    assert.equal(createCapturer({ chromeBin: null, dataDir: data, publicUrls: PUBLIC }), null);
    assert.equal(createCapturer({ chromeBin: '/bin/true', dataDir: data, publicUrls: createPublicUrls({ publicUrl: null }) }), null);
    assert.equal(createCapturer({ chromeBin: '/bin/true', dataDir: data, publicUrls: createPublicUrls({ publicUrl: 'http://100.100.100.100:18790' }) }), null);
  });

  it('argv routes everything through the proxy (no bypass, no QUIC, no direct WebRTC); the PNG is stored 0600; the URL is public', async () => {
    const chrome = fake(`const net=require('net'); const a=process.argv.slice(2);
const port=Number(a.find(x=>x.startsWith('--proxy-server=')).split(':').pop());
const s=net.connect(port,'127.0.0.1',()=>s.write('CONNECT 169.254.169.254:443 HTTP/1.1\\r\\n\\r\\n'));
s.on('data',(d)=>{ require('fs').writeFileSync(process.env.AO_EVID+'/connect.txt', String(d).split('\\r\\n')[0]);
  require('fs').writeFileSync(process.env.AO_EVID+'/argv.json', JSON.stringify(a));
  require('fs').writeFileSync(a.find(x=>x.startsWith('--screenshot=')).slice(13), ${PNG}); process.exit(0); });`);
    // HOME is the capture's temp dir; the fake writes its evidence next to it (in os.tmpdir) — read it back from there
    process.env.AO_EVID = fs.mkdtempSync(path.join(tmp, 'evid-'));   // the capturer passes process.env to the browser
    const capture = createCapturer({ chromeBin: chrome, dataDir: data, publicUrls: PUBLIC });
    const r = await capture({ url: 'https://site.example/', width: 1200, height: 630, timeoutMs: 5000, maxBytes: 2 * 1024 * 1024 });
    assert.match(r.url, /^https:\/\/agent\.example\/backend\/api\/v2\/shots\/[0-9a-f]{64}\.png$/);
    assert.equal(r.bytes, 12);
    const file = shotPath(data, r.url.split('/').pop());
    assert.ok(file); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const evidence = (name) => fs.readFileSync(path.join(process.env.AO_EVID, name), 'utf8');
    const argv = JSON.parse(evidence('argv.json'));
    for (const flag of ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy', '--window-size=1200,630']) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.length - 1], 'https://site.example/');
    assert.equal(evidence('connect.txt'), 'HTTP/1.1 403 Forbidden', 'the metadata address is refused through the proxy');
  });

  it('a non-PNG output → null; too big → no URL; past the timeout → timedOut (the browser is killed)', async () => {
    const write = (content) => fake(`const a=process.argv.slice(2); require('fs').writeFileSync(a.find(x=>x.startsWith('--screenshot=')).slice(13), ${content});`);
    const run = (chrome, extra = {}) => createCapturer({ chromeBin: chrome, dataDir: data, publicUrls: PUBLIC })(Object.assign({ url: 'https://site.example/', width: 1200, height: 630, timeoutMs: 3000, maxBytes: 100 }, extra));
    assert.equal(await run(write("'<html>not a png</html>'")), null);
    assert.deepEqual(await run(write(`Buffer.concat([${PNG}, Buffer.alloc(200)])`)), { url: null, bytes: 212 });
    const t0 = Date.now();
    assert.deepEqual(await run(fake('setInterval(() => {}, 1000);'), { timeoutMs: 300 }), { timedOut: true });
    assert.ok(Date.now() - t0 < 3000);
  });

  it('shot paths: only <sha256>.png inside shots/', () => {
    for (const f of ['../../etc/passwd', 'x.png', '0'.repeat(64) + '.jpg', '0'.repeat(64) + '.png/..', '']) assert.equal(shotPath(data, f), null, f);
  });
});

describe('capture · real Chrome never reaches a private address', { skip: (process.env.AO_TEST_REAL_CHROME !== '1' && 'opt-in: AO_TEST_REAL_CHROME=1 (documents the loopback-bypass finding; the capturer is off by default)') || (!findChrome() && 'no Chrome on this host') }, () => {
  // FOUND (architect-19): Chrome connects to loopback literals directly despite --proxy-bypass-list=<-loopback>; the
  // capturer stays OFF by default (AO_CAPTURE) until it runs in an isolated network namespace.
  it('a page on 127.0.0.1 is refused by the proxy: the local server sees no request', { todo: 'Chrome bypasses the proxy for loopback; needs a network namespace' }, async () => {
    let hits = 0;
    const victim = http.createServer((req, res) => { hits++; res.end('<h1>secret</h1>'); });
    await new Promise((r) => victim.listen(0, '127.0.0.1', r));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-realcap-'));
    try {
      const capture = createCapturer({ chromeBin: findChrome(), dataDir: data, publicUrls: PUBLIC });
      await capture({ url: 'http://127.0.0.1:' + victim.address().port + '/', width: 1200, height: 630, timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 });
      assert.equal(hits, 0, 'Chrome went through the proxy, which refused loopback');
    } finally { victim.close(); fs.rmSync(data, { recursive: true, force: true }); }
  });
});
