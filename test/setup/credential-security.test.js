'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const { seed } = require('../helpers/onboarding-fixture');
const { FakeGateway } = require('../helpers/fake-gateway');
const LOCAL = 'synthetic-local-credential', REMOTE = 'synthetic-remote-credential', ENV = 'synthetic-env-credential';

test('S01-02: destination/credential pairs never guess, downgrade TLS or borrow a local token remotely', () => {
  const { connection, credential } = require('../../src/adapters/openclaw/connection');
  const config = { gateway: { port: 19991, auth: { token: LOCAL }, remote: { url: 'wss://remote.example.invalid:444/api' } } };
  assert.deepEqual(connection({}, config), { gatewayUrl: config.gateway.remote.url, token: null });
  config.gateway.remote.token = REMOTE;
  assert.deepEqual(connection({}, config), { gatewayUrl: config.gateway.remote.url, token: REMOTE });
  assert.equal(connection({ OC_GATEWAY_URL: 'ws://different.example.invalid:19991' }, config).token, null);
  assert.equal(connection({ OC_GATEWAY_URL: config.gateway.remote.url }, config).token, REMOTE);
  assert.equal(connection({ OC_GATEWAY_URL: config.gateway.remote.url, OC_GATEWAY_TOKEN: ENV }, config).token, ENV);
  config.gateway.remote.url = 'wss:// malformed ';
  assert.deepEqual(connection({}, config), { gatewayUrl: null, token: null });
  config.gateway.remote.url = 'wss://remote.example.invalid/' + REMOTE;
  assert.deepEqual(connection({}, config), { gatewayUrl: null, token: null });
  delete config.gateway.remote;
  assert.deepEqual(connection({}, config), { gatewayUrl: 'ws://127.0.0.1:19991', token: LOCAL });
  const env = { OC_GATEWAY_URL: 'wss://remote.example.invalid:444/api', OC_GATEWAY_TOKEN: ENV };
  assert.equal(credential({ env, gatewayUrl: env.OC_GATEWAY_URL }), ENV);
  for (const changed of ['ws://remote.example.invalid:444/api', 'wss://other.example.invalid:444/api', 'wss://remote.example.invalid:445/api', 'wss://remote.example.invalid:444/other']) assert.equal(credential({ env, gatewayUrl: changed }), null);
});

test('S01-02: actual loopback handshakes send only the selected destination credential; tokenless/changed destinations send none', async () => {
  for (const mode of ['remote-missing', 'remote-token', 'local', 'env']) {
    const expected = mode === 'local' ? LOCAL : mode === 'env' ? ENV : REMOTE;
    const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, gatewayToken: expected,
      env: { OC_CONFIG: '', ...(mode === 'env' ? { OC_GATEWAY_TOKEN: ENV } : {}) },
      prepare: (tmp, context) => {
        seed(tmp, context); const file = path.join(tmp, '.openclaw/openclaw.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
        config.gateway.auth.token = LOCAL;
        if (mode !== 'local') config.gateway.remote = { url: context.gateway.url, ...(mode === 'remote-token' ? { token: REMOTE } : {}) };
        fs.writeFileSync(file, JSON.stringify(config));
      } });
    const other = await new FakeGateway().start();
    try {
      const setupCode = h.setupCode(), d = await h.post('/api/v2/setup/detect', { setupCode });
      const selected = d.json.data.result.runtimes.find(r => r.runtime === 'openclaw');
      assert.equal(selected.connection.tokenSet, mode !== 'remote-missing');
      for (const token of [LOCAL, REMOTE, ENV]) assert.ok(!d.text.includes(token));
      const check = await h.post('/api/v2/setup/check', { setupCode, runtime: { adapter: 'openclaw', gatewayUrl: selected.connection.gatewayUrl } });
      assert.equal(check.status, 200);
      if (mode === 'remote-missing') { assert.equal(check.json.data.result.status, 'unauthorized'); assert.equal(h.gw.callsTo('connect').length, 0, 'no device signature or token was sent'); }
      else { assert.equal(check.json.data.result.ok, true); assert.equal(h.gw.callsTo('connect')[0].params.auth.token, expected); }
      const changed = await h.post('/api/v2/setup/check', { setupCode, runtime: { adapter: 'openclaw', gatewayUrl: other.url } });
      assert.equal(changed.json.data.result.status, 'unauthorized'); assert.equal(other.callsTo('connect').length, 0);
    } finally { await other.stop(); await h.stop(); }
  }
});


test('S01-02: a configured gateway URL override cannot carry the stored token to a new destination', () => {
  const IC = require('../../src/instance-config');
  const files = { config: { version: 2, instance: { name: 'Synthetic', locale: 'en', timeZone: 'UTC' },
    owner: { displayName: 'Operator', email: 'owner@example.invalid', authSource: 'database' },
    runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:19991' } }, agents: { primary: null, looks: {} } },
    secrets: { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: LOCAL } };
  assert.equal(IC.effectiveEnv({}, files).OC_GATEWAY_TOKEN, LOCAL);
  assert.equal(IC.effectiveEnv({ OC_GATEWAY_URL: 'ws://127.0.0.1:19991/' }, files).OC_GATEWAY_TOKEN, LOCAL);
  for (const url of ['wss://remote.example.invalid/api', 'ws://127.0.0.1:19992', 'ws://127.0.0.1:19991/other']) {
    assert.equal(IC.effectiveEnv({ OC_GATEWAY_URL: url }, files).OC_GATEWAY_TOKEN, undefined, url);
    assert.equal(IC.effectiveEnv({ OC_GATEWAY_URL: url, OC_GATEWAY_TOKEN: ENV }, files).OC_GATEWAY_TOKEN, ENV);
  }
});
