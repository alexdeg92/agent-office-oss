'use strict';
// R16-03 / R16-04 / R16-11: the one-port proxy keeps each client's address, a loopback browse
// host, and refuses a Connection-nominated Content-Length.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const combined = require('../../packaging/bin/combined.js');
const serve = require('../../scripts/serve-frontend.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('combined proxy headers', () => {
  it('R16-11: drops a Connection-nominated Content-Length on every shipped proxy', () => {
    const input = { connection: 'content-length', 'content-length': '2' };
    for (const endToEnd of [combined.endToEnd, serve.endToEnd]) {
      const out = endToEnd(input);
      assert.equal(out['content-length'], undefined);
      assert.equal(out.connection, undefined);
    }
    const kept = combined.endToEnd({ 'content-length': '2', host: '127.0.0.1:18789' });
    assert.equal(kept['content-length'], '2');
    assert.equal(kept.host, undefined);
  });

  it('R16-03: sets X-Forwarded-For from the socket and ignores a caller-supplied chain', () => {
    const a = combined.proxyHeaders({
      host: '127.0.0.1:18789',
      'x-forwarded-for': '203.0.113.9, 198.51.100.1',
      'x-real-ip': '203.0.113.9',
    }, { remoteAddress: '::ffff:192.0.2.10', listenPort: 18789, apiPort: 40000 });
    const b = combined.proxyHeaders({
      host: '127.0.0.1:18789',
    }, { remoteAddress: '192.0.2.11', listenPort: 18789, apiPort: 40000 });
    assert.equal(a['x-forwarded-for'], '192.0.2.10');
    assert.equal(b['x-forwarded-for'], '192.0.2.11');
    assert.equal(a['x-real-ip'], undefined);
    assert.equal(a['x-forwarded-proto'], 'http');
    assert.equal(a.host, '127.0.0.1:40000');
  });

  it('R16-04: forwards a loopback browse Host and drops any other Host', () => {
    const local = combined.proxyHeaders({ host: 'localhost:18789' }, { remoteAddress: '127.0.0.1', listenPort: 18789, apiPort: 40000 });
    const v6 = combined.proxyHeaders({ host: '[::1]:18789' }, { remoteAddress: '::1', listenPort: 18789, apiPort: 40000 });
    const foreign = combined.proxyHeaders({ host: 'evil.example:18789' }, { remoteAddress: '127.0.0.1', listenPort: 18789, apiPort: 40000 });
    const otherPort = combined.proxyHeaders({ host: '127.0.0.1:80' }, { remoteAddress: '127.0.0.1', listenPort: 18789, apiPort: 40000 });
    assert.equal(local['x-forwarded-host'], 'localhost:18789');
    assert.equal(v6['x-forwarded-host'], '[::1]:18789');
    assert.equal(foreign['x-forwarded-host'], undefined);
    assert.equal(otherPort['x-forwarded-host'], undefined);
  });

  it('R16-03: the API child trusts only the loopback hop', () => {
    const env = combined.apiChildEnv({ AO_TRUST_PROXY: 'loopback,172.30.0.0/16', AO_PUBLIC_URL: 'https://office.example' }, 40000);
    assert.equal(env.AO_TRUST_PROXY, 'loopback');
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.PORT, '40000');
    assert.equal(env.AO_API_ONLY, '1');
    assert.equal(env.AO_PUBLIC_URL, 'https://office.example');
  });

  it('R16-03: a live forward records the socket address, not the client X-Forwarded-For', async () => {
    const seen = [];
    const api = http.createServer((req, res) => {
      seen.push(req.headers['x-forwarded-for']);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const apiPort = await listen(api);
    const proxy = http.createServer((req, res) => {
      combined.forward(req, res, apiPort, req.url, 18789);
    });
    const proxyPort = await listen(proxy);
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path: '/api/login',
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.9', host: '127.0.0.1:18789', 'content-length': '0' },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(body, 200);
      assert.deepEqual(seen, ['127.0.0.1']);
    } finally {
      proxy.close();
      api.close();
    }
  });
});


it('a restarted one-port install uses the stored listener and DB owner without turning file login into env login', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { spawn } = require('child_process'), { once } = require('events');
  const { openStore } = require('../../src/store');
  const { hashPassword } = require('../../src/security/password');
  const IC = require('../../src/instance-config');
  const { waitFor } = require('../helpers/harness');
  const root = path.resolve(__dirname, '../..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-combined-owner-'));
  let child;
  try {
    const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
    const dataDir = path.join(tmp, 'data'), store = openStore({ dir: dataDir, instance: 'test', ownerName: 'Operator' });
    const password = 'synthetic-combined-password';
    try { store.users.createOwner({ email: 'owner@example.invalid', passwordHash: await hashPassword(password), personId: store.owner.id }); }
    finally { store.close(); }
    const env = { HOME: tmp, AO_ENV: 'test', AO_CONFIG: path.join(tmp, 'config/config.json'), AO_DATA_DIR: dataDir,
      AO_PROJECTS_DISCOVERY: '0', PATH: path.dirname(process.execPath) };
    IC.writeInstanceConfig(IC.configPaths(env), { version: 2, instance: { name: 'Synthetic', locale: 'fr', timeZone: 'UTC' },
      owner: { displayName: 'Operator', email: 'owner@example.invalid', authSource: 'database' }, runtime: { adapter: 'demo', demo: { seed: 1 } },
      agents: { primary: null, looks: {} }, network: { mode: 'local', host: '127.0.0.1', port, publicUrl: null, cookieSecure: false } },
      { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null });
    child = spawn(process.execPath, [path.join(root, 'packaging/bin/combined.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    await waitFor(() => /AO_READY/.test(output), { what: () => 'combined DB boot: ' + output });
    const origin = 'http://127.0.0.1:' + port;
    const login = await fetch(origin + '/backend/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-request': '1', origin }, body: JSON.stringify({ email: 'owner@example.invalid', password }) });
    assert.equal(login.status, 200, await login.text()); assert.ok(login.headers.get('set-cookie').startsWith('taco_sess='));
    assert.equal((await fetch(origin + '/build.json')).status, 200);
    assert.ok(!output.includes(password) && !output.includes('One-time setup code'));
  } finally {
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
