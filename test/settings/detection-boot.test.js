'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { startServer, waitFor } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');

test('real composition root starts detection without a Settings POST, using only synthetic HOME', async t => {
  const h = await startServer(loadScenario('synthetic-basic'), { prepare(tmp, { env, gateway }) {
    require('../helpers/onboarding-fixture').seed(tmp, { gateway });
    env.OC_CONFIG = path.join(tmp, '.openclaw', 'openclaw.json');
    const preload = path.join(tmp, 'synthetic-detector.cjs');
    fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.resolve(__dirname, '../../server.js'))}) {
  const service = require(${JSON.stringify(path.resolve(__dirname, '../../src/settings/service.js'))}), create = service.createSettings;
  service.createSettings = options => create({ ...options,
    detect: ctx => require(${JSON.stringify(path.resolve(__dirname, '../../src/adapters/detection.js'))}).detectRuntimes({ env: { ...ctx.env, PATH: '' } }) });
}
`);
    env.NODE_OPTIONS = '--require=' + preload;
  } }); t.after(() => h.stop());
  const vm = await waitFor(async () => {
    const r = await h.get('/api/v3/settings'); assert.equal(r.status, 200, r.text);
    return r.json.data.runtimes.find(r => r.adapter === 'openclaw')?.detection?.status === 'detected' && r.json.data;
  }, { timeoutMs: 3000, what: 'boot detection without manual refresh' });
  const row = vm.runtimes.find(r => r.adapter === 'openclaw');
  assert.ok(Number.isSafeInteger(row.detection.checkedAt)); assert.equal(row.reason.key, 'settings.detection.config');
  assert.ok(row.checkedPaths.includes(path.join(h.tmp, '.openclaw', 'openclaw.json')));
  assert.equal(vm.runtimes.some(r => r.adapter === 'demo'), false);
  assert.ok(!JSON.stringify(vm).includes('test-gateway-token'));
});
