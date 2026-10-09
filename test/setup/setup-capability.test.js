'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');
const { createSetup } = require('../../src/api/v2/setup');
const SETUP_CODE_TTL = 30 * 60 * 1000; // The documented horizon, also usable against the audited release.
const { errorMiddleware } = require('../../src/api/v2/errors');
const IC = require('../../src/instance-config');
const { createNetworkGuide } = require('../../src/ops/onboarding-network');
const { networkFixtures } = require('../helpers/onboarding-network-fixture');
const POSTS = ['resume', 'owner', 'detect', 'integrations/plan', 'integrations/apply', 'network', 'check', 'discover'];
const owner = { displayName: 'Synthetic Operator', email: 'synthetic-owner@example.invalid', password: 'synthetic-owner-password', passwordConfirmation: 'synthetic-owner-password' };
async function fixture(options = {}) {
  const tmp = options.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'ao-setup-capability-'));
  const env = { HOME: tmp, AO_ENV: 'test', PATH: '', ...options.env };
  const files = IC.readInstanceConfig(env), clock = options.clock || { value: 1000 };
  let detectCalls = 0;
  const setup = createSetup({ env, files, dataDir: path.join(tmp, 'data'), instance: 'test', now: () => clock.value,
    detect: async () => { detectCalls++; return []; }, networkGuide: createNetworkGuide({ env, ...networkFixtures(env) }), ...options.deps });
  const app = express(); app.use(express.json()); const router = express.Router(); setup.mount(router); app.use(router); app.use(errorMiddleware());
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (method, route, body) => {
    const r = await fetch(base + '/setup' + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  return { tmp, files, setup, clock, get detectCalls() { return detectCalls; },
    post: (route, body = {}) => request('POST', '/' + route, body), get: route => request('GET', route), put: body => request('PUT', '', body),
    async stop(remove = true) { await new Promise(resolve => server.close(resolve)); setup.close(); if (remove) fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('S02-01: monotonic 30-minute expiry refuses every capability route before runtime reads or writes', async () => {
  const h = await fixture(); const code = h.setup._code();
  try {
    h.clock.value = 1000 + SETUP_CODE_TTL - 1;
    assert.equal((await h.post('check', { setupCode: code, runtime: { adapter: 'demo' } })).status, 200);
    h.clock.value++;
    const aged = await h.post('check', { setupCode: code, runtime: { adapter: 'demo' } });
    assert.equal(aged.status, 403, 'a previously valid payload cannot use an aged code');
    for (const route of POSTS) {
      const r = await h.post(route, { setupCode: code }); assert.equal(r.status, 403, route);
      assert.equal(JSON.parse(r.text).error.details[0].issue, 'expired', route);
    }
    assert.equal((await h.put({ setupCode: code })).status, 403);
    assert.equal(h.detectCalls, 0); assert.equal(h.setup._code(), null);
    assert.ok(!fs.existsSync(h.files.paths.file)); assert.ok(!fs.existsSync(path.join(h.tmp, 'data')));
  } finally { await h.stop(); }
});

test('S02-01: expiry during async detection discards secrets and the result', async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const h = await fixture({ deps: { detect: () => { started(); return new Promise(resolve => { release = resolve; }); } } });
  try {
    const pending = h.post('detect', { setupCode: h.setup._code() }); await ready;
    h.clock.value += SETUP_CODE_TTL;
    release([{ runtime: 'openclaw', found: true, secret: 'synthetic-private-token', connection: { gatewayUrl: 'ws://127.0.0.1:19999', tokenSet: true }, agents: [] }]);
    const r = await pending; assert.equal(r.status, 403); assert.ok(!r.text.includes('synthetic-private-token'));
    assert.equal(JSON.parse((await h.get('')).text).data.draft.runtime.tokenSet, false);
  } finally { await h.stop(); }
});

test('S02-01: expiry forgets detected credentials and prevents an old installation plan from writing, including after restart', async () => {
  let agents = [];
  let h = await fixture({ deps: { detect: async () => [{ runtime: 'openclaw', found: true, supported: true,
    secret: 'synthetic-private-token', connection: { gatewayUrl: 'ws://127.0.0.1:19999', tokenSet: true }, agents }] } });
  const tmp = h.tmp, workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Synthetic instructions.');
  agents = [{ id: 'synthetic', workspace, name: 'Synthetic', isPrimary: true }];
  try {
    const oldCode = h.setup._code();
    assert.equal((await h.post('detect', { setupCode: oldCode })).status, 200);
    assert.equal(JSON.parse((await h.get('')).text).data.draft.runtime.tokenSet, true);
    const planned = await h.post('integrations/plan', { setupCode: oldCode, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://127.0.0.1:19999' } });
    assert.equal(planned.status, 200);
    const operation = { planId: JSON.parse(planned.text).data.result.planId, agentIds: ['synthetic'], confirmed: true };
    h.clock.value += SETUP_CODE_TTL;
    assert.equal(JSON.parse((await h.get('')).text).data.draft.runtime.tokenSet, false);
    assert.equal((await h.post('integrations/apply', { ...operation, setupCode: oldCode })).status, 403);
    await h.stop(false); h = await fixture({ tmp });
    assert.equal((await h.post('integrations/apply', { ...operation, setupCode: oldCode })).status, 403);
    const stale = await h.post('integrations/apply', { ...operation, setupCode: h.setup._code() });
    assert.equal(stale.status, 400); assert.equal(JSON.parse(stale.text).error.details[0].issue, 'EPLAN');
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), 'Synthetic instructions.');
    assert.ok(!fs.existsSync(path.join(workspace, 'skills')));
  } finally { await h.stop(); }
});

test('S02-01: expiry during password derivation never creates an owner or publishes config', async () => {
  for (const save of [false, true]) {
    let release, started; const ready = new Promise(resolve => { started = resolve; });
    const h = await fixture({ deps: { derivePassword: () => { started(); return new Promise(resolve => { release = resolve; }); } } });
    try {
      const code = h.setup._code();
      const pending = save ? h.put({ setupCode: code, owner, instance: { name: 'Synthetic', locale: 'fr', timeZone: 'UTC' }, runtime: { adapter: 'demo' }, agents: { primary: 'synthetic', looks: {} }, integrations: { projet: false } }) : h.post('owner', { setupCode: code, owner });
      await ready; h.clock.value += SETUP_CODE_TTL; release('synthetic-unused-hash');
      const r = await pending; assert.equal(r.status, 403); assert.equal(JSON.parse(r.text).error.details[0].issue, 'expired');
      assert.ok(!fs.existsSync(h.files.paths.file)); assert.ok(!fs.existsSync(path.join(h.tmp, 'data')));
    } finally { await h.stop(); }
  }
});

test('S02-02: public owner identity stays hidden before/after creation and restart; resume requires the fresh code', async () => {
  let h = await fixture(), oldCode = h.setup._code(); const tmp = h.tmp;
  const privateGet = async () => { const r = await h.get(''); assert.equal(r.status, 200); assert.ok(!r.text.includes(owner.email)); assert.ok(!r.text.includes(owner.displayName)); };
  try {
    await privateGet(); assert.equal((await h.post('owner', { setupCode: oldCode, owner })).status, 200); await privateGet();
    h.clock.value += SETUP_CODE_TTL; assert.equal((await h.post('resume', { setupCode: oldCode })).status, 403);
    await h.stop(false); h = await fixture({ tmp }); await privateGet();
    assert.notEqual(h.setup._code(), oldCode);
    assert.equal((await h.post('resume', { setupCode: oldCode })).status, 403);
    const r = await h.post('resume', { setupCode: h.setup._code() }); assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).data.result.owner, { displayName: owner.displayName, email: owner.email, passwordSet: true });
    await privateGet();
  } finally { await h.stop(); }
});

test('new setup routes deliberately require capability admission and obey locked/readonly state', async () => {
  for (const route of POSTS) {
    const h = await fixture();
    try {
      for (const setupCode of [undefined, 'AO-INVALID-CODE']) {
        const r = await h.post(route, { setupCode }); assert.equal(r.status, 403, route);
        assert.equal(JSON.parse(r.text).error.details[0].field, 'setupCode');
      }
      assert.equal(h.detectCalls, 0); assert.ok(!fs.existsSync(path.join(h.tmp, 'data')));
    } finally { await h.stop(); }
  }
  for (const env of [{ PORTAL_EMAIL: 'configured@example.invalid' }, { PORTAL_READONLY: '1' }]) {
    const h = await fixture({ env });
    try {
      for (const route of POSTS) assert.equal((await h.post(route, { setupCode: 'AO-INVALID-CODE' })).status, 403, route);
      assert.equal((await h.get('/catalog')).status, 403); assert.equal(h.detectCalls, 0);
    } finally { await h.stop(); }
  }
});
