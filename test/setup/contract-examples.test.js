'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const { seed, TOKEN } = require('../helpers/onboarding-fixture');
const { compareExample, loadExample, EXAMPLES_DIR } = require('../helpers/contract-shape');
const s = require('../../src/schema');
const { SetupVM } = require('../../src/api/v2/vm/schemas');
const ROUTES = {
  'GET /setup': 'setup-vm', 'GET /setup/catalog': 'setup-catalog',
  'POST /setup/owner': 'setup-owner', 'POST /setup/resume': 'setup-resume', 'POST /setup/detect': 'setup-detect',
  'POST /setup/check': 'setup-check', 'POST /setup/discover': 'setup-discover',
  'POST /setup/integrations/plan': 'setup-integration-plan', 'POST /setup/integrations/apply': 'setup-integration-apply',
  'POST /setup/network': 'setup-network', 'PUT /setup': 'setup-finalize',
  'POST /setup/access/state': 'external-access-setup-vm', 'POST /setup/access/plan': 'external-access-plan',
  'POST /setup/access/checks': 'external-access-check-status', 'POST /setup/access/checks/status': 'external-access-check-status',
  'POST /setup/access/checks/cancel': 'external-access-check-status', 'POST /setup/access/apply': 'external-access-plan',
};
test('critic P2: every setup route has authoritative request/result fixtures and a strict public VM schema', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/api/v2/setup.js'), 'utf8');
  const mounted = [...source.matchAll(/r\.(get|post|put)\('(\/setup[^']*)'/g)].map(m => m[1].toUpperCase() + ' ' + m[2]);
  assert.deepEqual(mounted.sort(), Object.keys(ROUTES).sort(), 'a new route needs a contract fixture mapping');
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, gatewayToken: TOKEN, env: { OC_CONFIG: '' }, prepare: seed });
  const seen = new Set();
  try {
    const example = (name, actual) => {
      if (process.env.UPDATE_GOLDEN === '1') {
        const value = JSON.parse(JSON.stringify(actual).split(h.tmp).join('/tmp/agent-office-synthetic'));
        if (value.meta) value.meta.generatedAt = 1791288000000;
        fs.writeFileSync(path.join(EXAMPLES_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n');
      }
      assert.deepEqual(compareExample(name, actual.data), [], name);
    };
    const request = async (method, route, fields = {}) => {
      const base = ROUTES[method + ' ' + route], body = { setupCode: h.setupCode(), ...fields };
      if (process.env.UPDATE_GOLDEN === '1' && method !== 'GET' && base !== 'setup-check') fs.writeFileSync(path.join(EXAMPLES_DIR, base + '-request.json'), JSON.stringify({ ...body, setupCode: 'AO-ABCD-EFGH' }, null, 2) + '\n');
      if (method !== 'GET') assert.deepEqual(Object.keys(loadExample(base + '-request')).sort(), Object.keys(body).sort(), base + ' request');
      const result = await h.request(method, '/api/v2' + route, method === 'GET' ? undefined : body);
      assert.equal(result.status, 200, result.text); seen.add(method + ' ' + route);
      const name = route === '/setup' && method === 'GET' ? base : base + '-result';
      if (route !== '/setup/catalog') example(name, result.json);
      else { assert.equal(result.json.data.version, loadExample(name).data.version); assert.deepEqual(compareExample(name, result.json.data), []); }
      return result.json.data;
    };
    const vm = await request('GET', '/setup'); assert.equal(s.validate(SetupVM, vm).ok, true);
    const bad = structuredClone(vm); delete bad.network; assert.equal(s.validate(SetupVM, bad).ok, false);
    const leaked = structuredClone(vm); leaked.draft.owner.email = 'synthetic@example.invalid'; assert.equal(s.validate(SetupVM, leaked).ok, false);
    await request('GET', '/setup/catalog');
    const owner = { displayName: 'Synthetic Operator', email: 'owner@example.invalid', password: 'synthetic-owner-password', passwordConfirmation: 'synthetic-owner-password' };
    await request('POST', '/setup/owner', { owner });
    await request('POST', '/setup/resume');
    const detected = await request('POST', '/setup/detect');
    assert.equal(detected.result.runtimes.find(r => r.runtime === 'claude-code').supported, true, 'the Claude connector is available');
    assert.equal(detected.result.selected, null, 'multiple supported detections require owner choice');
    const runtime = { adapter: 'openclaw', gatewayUrl: h.gw.url };
    await request('POST', '/setup/check', { runtime }); await request('POST', '/setup/discover', { runtime });
    const plan = await request('POST', '/setup/integrations/plan', { runtime, locale: 'fr' });
    await request('POST', '/setup/integrations/apply', { planId: plan.result.planId, agentIds: ['atlas', 'scribe'], confirmed: true, action: 'install' });
    await request('POST', '/setup/network', { domain: 'office.example.invalid', port: h.port, publicIp: true });
    await request('PUT', '/setup', { instance: { name: 'Synthetic Office', locale: 'en', timeZone: 'UTC' }, owner: { displayName: owner.displayName, email: owner.email }, runtime,
      agents: { primary: 'atlas', names: { atlas: 'Orion', scribe: 'Lyra' }, looks: {} }, integrations: { projet: true, reviewed: true }, network: { mode: 'local', port: h.port, publicUrl: null } });
    const registeredAccessRoutes = Object.keys(ROUTES).filter(key => key.includes('/setup/access/'));
    assert.deepEqual([...seen, ...registeredAccessRoutes].sort(), mounted.sort());
  } finally { await h.stop(); }
});
