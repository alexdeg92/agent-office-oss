'use strict';
// G4: the setup probe makes ONE attempt and classifies it (api.md §5.7). Nothing is retried or kept.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { probeGateway } = require('../../src/adapters/openclaw/transport');
const { FakeGateway } = require('../helpers/fake-gateway');
const { makeIdentity } = require('../helpers/harness');

describe('G4 · setup probe', () => {
  let gw, tmp, identityPath;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-probe-'));
    identityPath = makeIdentity(tmp);
    gw = await new FakeGateway({ token: 'right-token', handlers: { 'agents.list': () => ({ defaultId: 'atlas', agents: [{ id: 'atlas', name: 'Atlas' }] }) } }).start();
  });
  after(async () => { if (gw) await gw.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const probe = (o) => probeGateway(Object.assign({ identityPath, stateDbPath: null }, o));

  it('connected: protocol and latency; the connection can make calls, then closes', async () => {
    const r = await probe({ url: gw.url, token: 'right-token' });
    assert.deepEqual([r.status, r.protocol, typeof r.latencyMs], ['connected', 4, 'number']);
    try { assert.equal((await r.gw.call('agents.list')).defaultId, 'atlas'); } finally { r.gw.close(); }
  });
  it('unauthorized: a wrong token, no token, or no device identity', async () => {
    assert.equal((await probe({ url: gw.url, token: 'wrong' })).status, 'unauthorized');
    assert.equal((await probe({ url: gw.url, token: '' })).status, 'unauthorized');
    assert.equal((await probe({ url: gw.url, token: 'right-token', identityPath: path.join(tmp, 'none.json') })).status, 'unauthorized');
  });
  it('refused: nothing listens on the port; unreachable: no answer in time, or a bad URL', async () => {
    const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    assert.equal((await probe({ url: `ws://127.0.0.1:${free}`, token: 'right-token' })).status, 'refused');
    const silent = net.createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((r) => silent.once('listening', r));
    try {
      assert.equal((await probe({ url: `ws://127.0.0.1:${silent.address().port}`, token: 'right-token', timeoutMs: 300 })).status, 'unreachable');
    } finally { silent.close(); }
    assert.equal((await probe({ url: 'not a url', token: 'right-token' })).status, 'unreachable');
  });
});
