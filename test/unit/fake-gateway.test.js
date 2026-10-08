'use strict';
// The real gateway.js client must handshake with the FakeGateway exactly as with OpenClaw.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { FakeGateway } = require('../helpers/fake-gateway');
const { Gateway } = require('../../gateway');

describe('FakeGateway + real Gateway client', () => {
  let fake, gw, tmp;
  before(async () => {
    fake = await new FakeGateway({ handlers: { 'agents.list': { agents: [{ id: 'main' }] }, 'boom': FakeGateway.error('nope') }, onConnectEvents: [{ event: 'health', payload: { ok: true } }] }).start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gw-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const idFile = path.join(tmp, 'device.json');
    fs.writeFileSync(idFile, JSON.stringify({ deviceId: 'dev', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    gw = new Gateway({ url: fake.url, gatewayToken: 'test-token', identityPath: idFile });
  });
  after(async () => { if (gw) { gw._retry = () => {}; try { gw.ws.close(); } catch (_) {} } await fake.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('connects, answers RPCs, reports errors and forwards events', async () => {
    const events = [];
    gw.on('gwevent', (e, p) => events.push([e, p]));
    await new Promise((r) => { gw.once('open', r); gw.start(); });
    const connect = fake.callsTo('connect')[0];
    assert.equal(connect.params.minProtocol, 4);
    assert.deepEqual(connect.params.scopes, ['operator.read']);
    assert.ok(connect.params.device.signature);
    assert.deepEqual(await gw.call('agents.list', {}), { agents: [{ id: 'main' }] });
    await assert.rejects(gw.call('boom', {}), /nope/);
    await assert.rejects(gw.call('not.a.method', {}), /unknown method/);
    fake.emit('session.tool', { sessionKey: 'k' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events.map((e) => e[0]), ['health', 'session.tool']);
  });
});
