'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createSetup } = require('../../src/api/v2/setup');
const { errorMiddleware } = require('../../src/api/v2/errors');
const { createExternalAccessService } = require('../../src/access/service');
const { hashPassword } = require('../../src/security/password');
const { compareExample } = require('../helpers/contract-shape');

test('setup access plan is staged and final PUT publishes it without carrying the draft', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-external-access-setup-'));
  const files = { config: null, secrets: null, paths: { dir, file: path.join(dir, 'config.json'), secrets: path.join(dir, 'secrets.json') } };
  const records = { A: [{ name: 'api.example.org', type: 'A', value: '8.8.8.8', ttl: 300 }], AAAA: [], CNAME: [], NS: [] };
  const externalAccess = createExternalAccessService({ cfg: {}, files, env: {},
    inspector: { inspect: async hostname => ({ hostname, zone: 'example.org', observedAt: Date.now(), elapsedMs: 1,
      provider: { id: 'unknown', confidence: 'unknown', evidence: [] },
      resolvers: ['google', 'cloudflare'].map(id => ({ id, state: 'answered', records })), records }) },
    requester: async () => ({ status: 200, headers: {}, body: '' }) });
  const setup = createSetup({ env: { AO_ENV: 'test' }, files, externalAccess, instance: 'test', log: () => {}, derivePassword: hashPassword });
  const app = express(); app.use(express.json(), (req, _res, next) => { req.apiVersion = 3; next(); }); const router = express.Router(); setup.mount(router); app.use('/api/v3', router); app.use(errorMiddleware());
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { setup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/v3`, setupCode = setup._code();
  const request = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode, ...body }) });
    return { status: response.status, json: await response.json() };
  };
  const state = await request('POST', '/setup/access/state', {});
  assert.equal(state.status, 200, JSON.stringify(state));
  assert.deepEqual(compareExample('external-access-setup-vm', state.json.data, { version: 3 }), []);
  const planRequest = require('../../docs/architecture/examples/v3/external-access-plan-request.json');
  const accessDraft = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
  const plan = await request('POST', '/setup/access/plan', { settingsRevision: null, draft: accessDraft });
  assert.equal(plan.status, 200, JSON.stringify(plan));
  assert.deepEqual(compareExample('external-access-plan', plan.json.data, { version: 3 }), []);
  const result = plan.json.data.result;
  assert.match(result.configDigest, /^[a-f0-9]{64}$/);
  const checks = await request('POST', '/setup/access/checks', { planId: result.planId, checks: ['tls'] });
  assert.equal(checks.status, 200); assert.equal(checks.json.data.result.planId, result.planId);
  const status = await request('POST', '/setup/access/checks/status', { jobId: checks.json.data.result.jobId });
  assert.equal(status.status, 200, JSON.stringify(status)); assert.equal(status.json.data.result.checks[0].kind, 'tls');
  const cancel = await request('POST', '/setup/access/checks/cancel', { jobId: checks.json.data.result.jobId });
  assert.equal(cancel.status, 200); assert.equal(cancel.json.data.result.cancelled, true);
  const mismatch = await request('POST', '/setup/access/apply', { planId: result.planId, settingsRevision: null, confirmation: { configDigest: '0'.repeat(64) } });
  assert.equal(mismatch.status, 409);
  const staged = await request('POST', '/setup/access/apply', { planId: result.planId, settingsRevision: null, confirmation: { configDigest: result.configDigest } });
  assert.equal(staged.status, 200); assert.equal(staged.json.data.result.configDigest, result.configDigest);
  const stagedState = await request('POST', '/setup/access/state', {});
  assert.deepEqual(stagedState.json.data.draft, result.draft);
  const final = await request('PUT', '/setup', {
    instance: { name: 'Synthetic Setup', locale: 'en', timeZone: 'UTC' },
    owner: { displayName: 'Synthetic Owner', email: 'owner@example.invalid', password: 'synthetic-password-123' },
    runtime: { adapter: 'demo' }, agents: { primary: 'nova' },
  });
  assert.equal(final.status, 200, JSON.stringify(final));
  const persisted = JSON.parse(fs.readFileSync(files.paths.file, 'utf8'));
  assert.deepEqual(persisted.access, result.draft);
  assert.equal(persisted.accessRevision, 1);
  assert.equal(Object.hasOwn(final.json.data.result, 'access'), false, 'final PUT publishes staged settings; it does not accept a second draft');
});
