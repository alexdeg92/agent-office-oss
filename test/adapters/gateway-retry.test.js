'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: immediate, setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const { Gateway } = require('../../src/adapters/openclaw/transport');
const { FakeGateway } = require('../helpers/fake-gateway');
function clock() {
  let id = 0; const jobs = new Map();
  return { jobs, setTimeout(fn, ms) { jobs.set(++id, { fn, ms }); return id; }, clearTimeout(id) { jobs.delete(id); },
    next() { assert.equal(jobs.size, 1); return [...jobs.values()][0].ms; }, fire() { assert.equal(jobs.size, 1); const [id, job] = [...jobs][0]; jobs.delete(id); job.fn(); } };
}
async function until(fn) { for (let i = 0; i < 20000; i++) { if (fn()) return; await immediate(); } assert.ok(fn(), 'fixture condition did not settle'); }
async function fixture(t, { timers, retry = true, token = 'fixture-wrong-token' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gw-retry-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'), identityPath = path.join(tmp, 'identity.json');
  fs.writeFileSync(identityPath, JSON.stringify({ deviceId: 'fixture-device', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const fake = await new FakeGateway({ token: 'fixture-accepted-token' }).start();
  const gw = new Gateway({ url: fake.url, gatewayToken: token, identityPath, timers, retry });
  const logs = []; gw.on('log', line => logs.push(line));
  t.after(async () => { gw.retry = false; if (gw.close) gw.close(); else { clearTimeout(gw._retryTimer); gw.ws?.terminate(); } for (const ws of fake.wss.clients) ws.terminate(); await fake.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  return { fake, gw, logs, identityPath };
}
test('critic-08: real refused connect opens only once in five seconds and logs no credential/URL', async t => {
  const h = await fixture(t); h.gw.start(); await until(() => h.fake.callsTo('connect').length === 1 && !h.gw.connected && h.gw.rejected);
  await delay(5100);
  assert.equal(h.fake.callsTo('connect').length, 1);
  assert.equal(h.logs.filter(l => l.includes('connect rejected')).length, 1);
  assert.ok(h.logs.every(l => !l.includes('fixture-wrong-token') && !l.includes(h.fake.url)));
});
test('refused connect backs off 30 seconds to ten minutes, logs once and self-heals without dashboard restart', async t => {
  const timers = clock(), h = await fixture(t, { timers }); h.gw.start();
  for (const ms of [30000,60000,120000,240000,480000,600000,600000]) {
    await until(() => timers.jobs.size === 1); assert.equal(timers.next(), ms); timers.fire();
  }
  await until(() => timers.jobs.size === 1); assert.equal(h.logs.filter(l => l.includes('connect rejected')).length, 1);
  h.fake.token = 'fixture-wrong-token'; timers.fire(); await until(() => h.gw.connected);
  assert.equal(h.gw.rejected, false); h.fake.dropAll(); await until(() => timers.jobs.size === 1); assert.equal(timers.next(), 1000);
});
test('ordinary network retries retain the 1s ×1.7 policy capped at 30s', async t => {
  const h = await fixture(t, { timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, ms = 1000;
  h.gw._connect = () => { attempts++; }; h.gw.lastErrorCode = 'ECONNREFUSED';
  for (let i = 0; i < 18; i++) {
    h.gw._retry(); t.mock.timers.tick(ms - 1); assert.equal(attempts, i);
    t.mock.timers.tick(1); assert.equal(attempts, i + 1); ms = Math.min(30000, Math.round(ms * 1.7));
  }
});
test('a socket closed during handshake is a transport failure, not an explicit rejected response', async t => {
  const timers = clock(), h = await fixture(t, { timers }), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => server.once('listening', r));
  server.on('connection', ws => { ws.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'fixture'}})); ws.on('message', () => ws.close()); });
  t.after(() => new Promise(r => server.close(r)));
  h.gw.url = `ws://127.0.0.1:${server.address().port}`; h.gw.start();
  await until(() => timers.jobs.size === 1); await immediate();
  assert.equal(h.gw.rejected, false); assert.equal(timers.next(), 1000);
});
test('changing the explicit URL/token pair cancels rejection delay and reconnects immediately; stale callbacks are ignored', async t => {
  const timers = clock(), h = await fixture(t, { timers }); h.gw.start(); await until(() => timers.jobs.size === 1);
  const old = h.gw.ws, other = await new FakeGateway({ token:'fixture-other-token' }).start();
  t.after(async () => { for (const ws of other.wss.clients) ws.terminate(); await other.stop(); });
  assert.equal(h.gw.updateConnection({ url: other.url, gatewayToken:'fixture-other-token' }), true);
  assert.equal(timers.jobs.size, 0); await until(() => h.gw.connected);
  old.emit('close'); old.emit('message', Buffer.from(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'stale'}})));
  assert.equal(h.gw.connected, true); assert.equal(timers.jobs.size, 0);
  assert.equal(other.callsTo('connect').length, 1); assert.equal(other.callsTo('connect')[0].params.auth.token, 'fixture-other-token');
});
test('changing only the token on the same URL immediately retries; an unchanged pair keeps its timer', async t => {
  const timers = clock(), h = await fixture(t, { timers }); h.gw.start(); await until(() => timers.jobs.size === 1);
  assert.equal(h.gw.updateConnection({ url:h.fake.url, gatewayToken:'fixture-wrong-token' }), false); assert.equal(timers.next(), 30000);
  assert.equal(h.gw.updateConnection({ url:h.fake.url, gatewayToken:'fixture-accepted-token' }), true); await until(() => h.gw.connected);
  assert.equal(h.fake.callsTo('connect').length, 2); assert.equal(timers.jobs.size, 0);
});
test('URL and token must be supplied as one pair; never carry a local token to a new URL implicitly', async t => {
  const timers = clock(), h = await fixture(t, { timers });
  assert.throws(() => h.gw.updateConnection({ url:'ws://remote.example.invalid:1' }), /pair/);
  assert.equal(h.gw.url, h.fake.url); assert.equal(timers.jobs.size, 0);
});
test('one-shot setup probe does not retry a rejection', async t => {
  const timers = clock(), h = await fixture(t, { timers, retry:false }); h.gw.start(); await until(() => h.gw.rejected && h.gw.ws.readyState === 3);
  assert.equal(timers.jobs.size, 0); assert.equal(h.fake.callsTo('connect').length, 1);
});
test('a previously missing token can be supplied and loads only the fixture identity', async t => {
  const timers = clock(), h = await fixture(t, { timers, token:null }); h.gw.start(); assert.equal(h.gw.notConfigured, 'no-token');
  h.gw.updateConnection({ url:h.fake.url, gatewayToken:'fixture-accepted-token' }); await until(() => h.gw.connected);
  assert.equal(h.fake.callsTo('connect').length, 1);
});
test('closing cancels the pending rejection timer and prevents later reconnect', async t => {
  const timers = clock(), h = await fixture(t, { timers }); h.gw.start(); await until(() => timers.jobs.size === 1); h.gw.close();
  assert.equal(timers.jobs.size, 0); assert.equal(h.gw.connected, false); await immediate(); assert.equal(h.fake.callsTo('connect').length, 1);
});

test('ECONNREFUSED after an authentication rejection uses normal transport backoff', async t => {
  const timers = clock(), h = await fixture(t, { timers }); h.gw.start(); await until(() => timers.jobs.size === 1);
  assert.equal(timers.next(), 30000); await h.fake.stop(); timers.fire();
  await until(() => timers.jobs.size === 1);
  assert.equal(h.gw.lastErrorCode, 'ECONNREFUSED'); assert.equal(h.gw.rejected, false); assert.equal(timers.next(), 1000);
});
