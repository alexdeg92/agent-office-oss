'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSetup } = require('../../src/api/v2/setup');
const { errorMiddleware } = require('../../src/api/v2/errors');
const IC = require('../../src/instance-config');
const adapter = require('../../src/adapters/openclaw');
const { createNetworkGuide } = require('../../src/ops/onboarding-network');
const { networkFixtures } = require('../helpers/onboarding-network-fixture');
async function fixture(detect) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-adapter-discover-'));
  const env = { HOME: tmp, AO_ENV: 'test', PATH: '' }; let closes = 0;
  const setup = createSetup({ env, files: IC.readInstanceConfig(env), dataDir: path.join(tmp, 'data'), detect,
    probe: async () => ({ status: 'connected', protocol: 1, latencyMs: 0, gw: { call() { assert.fail('setup core must not call agents.list'); }, close() { closes++; } } }),
    networkGuide: createNetworkGuide({ env, ...networkFixtures(env) }) });
  const app = express(); app.use(express.json()); const r = express.Router(); setup.mount(r); app.use(r); app.use(errorMiddleware());
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { tmp, setup, get closes() { return closes; }, async post(route, body = {}) {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/setup/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: setup._code(), ...body }) });
    return { status: r.status, json: await r.json() };
  }, async stop() { await new Promise(resolve => server.close(resolve)); setup.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}
test('critic P1: setup delegates canonical discovery exclusively to the adapter', async () => {
  const original = adapter.setup.discover; let calls = 0;
  adapter.setup.discover = async ({ gw, detected }) => { calls++; assert.ok(gw); assert.deepEqual(detected, []); return [{ id: 'atlas', name: 'Foreign Agent', nameSource: 'foreign', isPrimary: true, model: null }]; };
  const h = await fixture(async () => []);
  try {
    const r = await h.post('discover', { runtime: { adapter: 'openclaw', gatewayUrl: 'ws://127.0.0.1:19999', token: 'synthetic-token' } });
    assert.equal(r.status, 200); assert.equal(calls, 1); assert.equal(h.closes, 1); assert.equal(r.json.data.result.agents[0].nameSource, 'foreign');
  } finally { adapter.setup.discover = original; await h.stop(); }
});
test('critic P1: an empty detected runtime config never fabricates a primary agent', async () => {
  const h = await fixture(async () => []);
  try {
    fs.mkdirSync(path.join(h.tmp, '.openclaw/workspace'), { recursive: true });
    fs.writeFileSync(path.join(h.tmp, '.openclaw/openclaw.json'), JSON.stringify({ agents: { list: [] } }));
    const d = await adapter.detect({ env: { HOME: h.tmp, AO_ENV: 'test', PATH: '' }, home: h.tmp });
    assert.equal(d.found, true); assert.deepEqual(d.agents, []);
  } finally { await h.stop(); }
});
test('critic P1: multiple connectable detections require operator choice; presence flags cannot select transport', async () => {
  const rows = ['openclaw', 'demo', 'codex'].map(runtime => ({ runtime, name: runtime, found: true, supported: true, confidence: 'presence', agents: [], connection: null }));
  const h = await fixture(async () => rows);
  try {
    const r = await h.post('detect'); assert.equal(r.status, 200); assert.equal(r.json.data.result.selected, null);
    assert.equal(r.json.data.result.runtimes.find(d => d.runtime === 'codex').supported, false);
    assert.equal((await h.post('check', { runtime: { adapter: 'codex' } })).status, 400);
  } finally { await h.stop(); }
});
test('critic P1: configured agent labels belong only to the selected runtime', () => {
  const c = { instance: {}, owner: {}, agents: { primary: null, names: { openclaw: { atlas: 'OC Atlas' }, demo: { atlas: 'Demo Atlas' } } }, runtime: { adapter: 'demo' } };
  assert.deepEqual(JSON.parse(IC.fileEnv(c, null).AO_AGENT_NAMES), { atlas: 'Demo Atlas' });
  assert.deepEqual(JSON.parse(IC.effectiveEnv({ AO_RUNTIME: 'openclaw' }, { config: c, secrets: null }).AO_AGENT_NAMES), { atlas: 'OC Atlas' });
  assert.deepEqual(JSON.parse(IC.effectiveEnv({ AO_RUNTIME: 'openclaw', AO_AGENT_NAMES: '{}' }, { config: c, secrets: null }).AO_AGENT_NAMES), {});
});
