'use strict';
// Shadow taps must be invisible to the legacy path: same results, same errors.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { FakeGateway } = require('../helpers/fake-gateway');
const { Gateway } = require('../../src/adapters/openclaw/transport');
const { createEngine } = require('../../src/engine');
const { tapGateway, tapCli } = require('../../src/adapters/openclaw/taps');

describe('engine taps', () => {
  let fake, gw, tmp;
  const engine = createEngine();
  before(async () => {
    fake = await new FakeGateway({
      handlers: { 'sessions.list': { sessions: [{ key: 'agent:main:main', updatedAt: Date.now() }] }, 'cron.list': FakeGateway.error('boom'), 'gateway.restart.request': { ok: true } },
      hello: { protocol: 4, server: { version: '2026.9.8' } },
    }).start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tap-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const idFile = path.join(tmp, 'device.json');
    fs.writeFileSync(idFile, JSON.stringify({ deviceId: 'd', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    gw = new Gateway({ url: fake.url, gatewayToken: 't', identityPath: idFile });
    tapGateway(gw, engine);
    await new Promise((r) => { gw.once('open', r); gw.start(); });
  });
  after(async () => { gw._retry = () => {}; try { gw.ws.close(); } catch (_) {} await fake.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('learns the OpenClaw version from the hello frame', () => { assert.equal(engine.openclawVersion, '2026.9.8'); assert.ok(engine.latest('gw.hello')); });

  it('passes RPC results and errors through unchanged, and ingests both', async () => {
    assert.deepEqual((await gw.call('sessions.list', { limit: 300 })).sessions.length, 1);
    await assert.rejects(gw.call('cron.list', {}), /boom/);
    assert.ok(engine.latest('gw.rpc.sessions.list'));
    assert.ok(engine.quarantine.list().some((i) => i.code === 'rpc.failed' && i.channel === 'gw.rpc.cron.list'));
  });

  it('does not ingest non-ingestion RPCs', async () => {
    await gw.call('gateway.restart.request', {});
    assert.ok(!engine.registryKeys().some((k) => k.includes('restart')));
  });

  it('ingests events (unknown activity events become event.unknown)', async () => {
    fake.emit('session.tool', { sessionKey: 'k' }); fake.emit('tick', { ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    // PM rule: an event the gateway did not advertise is hashed in the channel name.
    assert.ok(engine.quarantine.list().some((i) => i.code === 'event.unknown' && i.channel === 'gw.event.<unadvertised>'));
    assert.ok(engine.latest('gw.event.tick'));
  });

  it('CLI tap: same result object, ingests skills reads only, ignores refused calls', async () => {
    const e = createEngine();
    const results = { 'skills list': { ok: true, out: '{"skills":[]}', err: '' }, 'cron run': { ok: true, out: 'ok', err: '' }, 'skills info': { ok: false, out: '', err: '', refused: 'missing-agent' } };
    const cli = { run: async (args) => results[args.slice(0, 2).join(' ')] };
    tapCli(cli, e);
    assert.equal(await cli.run(['skills', 'list', '--agent', 'main', '--json']), results['skills list']);
    await cli.run(['cron', 'run', 'x']); await cli.run(['skills', 'info', 'w']);
    assert.deepEqual(e.registryKeys(), ['cli.skills.list']);
    assert.deepEqual(e.quarantine.list(), []);
  });
});
