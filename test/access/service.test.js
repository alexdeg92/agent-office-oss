'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createExternalAccessService, createBootAccessRuntime, configDigest, reduceDnsObservation } = require('../../src/access/service');

const draft = require('../../docs/architecture/examples/v3/external-access-setup-vm.json').data.draft;
const allowedOrigin = 'https://office.example.org';
function dnsObservation(hostname) {
  const records = { A: [{ name: hostname, type: 'A', value: '8.8.8.8', ttl: 60 }], AAAA: [], CNAME: [],
    NS: [{ name: 'example.org', type: 'NS', value: 'ns1.example.org', ttl: 60 }] };
  return { hostname, zone: 'example.org', observedAt: 1, elapsedMs: 1,
    provider: { id: 'unknown', confidence: 'unknown', evidence: [] },
    resolvers: ['google', 'cloudflare'].map(id => ({ id, state: 'answered', records })), records };
}
function fixture() {
  let revision = 7, saved = null;
  const settings = { revision: () => revision, accessConfig: () => saved, accessRevision: () => saved ? 1 : 0 };
  const service = createExternalAccessService({ settings, cfg: {}, files: {}, env: {} });
  return { service, settings, revision: () => revision, bump: () => ++revision, save: value => { saved = value; revision++; } };
}

test('boot publishes only the effective access profile; split origin requires matching active auth hooks', () => {
  const split = { ...draft, mode: 'public-split-origin', domain: 'example.org', apiPublicUrl: 'https://api.example.org', uiOrigins: [allowedOrigin] };
  const unavailable = createBootAccessRuntime({ access: split, accessRevision: 6 });
  assert.equal(unavailable.revision, 0);
  assert.equal(unavailable.draft.mode, 'local');
  const mismatched = createBootAccessRuntime({ access: split, accessRevision: 6, splitAuthEnabled: true,
    apiPublicUrl: 'https://other.example.org', allowedOrigins: [allowedOrigin] });
  assert.equal(mismatched.revision, 0);
  assert.equal(mismatched.draft.mode, 'local');
  const active = createBootAccessRuntime({ access: split, accessRevision: 6, splitAuthEnabled: true,
    apiPublicUrl: split.apiPublicUrl, allowedOrigins: split.uiOrigins });
  assert.equal(active.revision, 6);
  assert.deepEqual(active.draft, { ...split, security: { ...split.security, partitionedCookie: true } });
  assert.equal(active.draft.security.accessTokenMinutes, 10);
  assert.equal(active.draft.security.refreshIdleHours, 12);
  assert.equal(active.draft.security.refreshAbsoluteDays, 7);
  const splitService = createExternalAccessService({ settings: { revision: () => 14, accessConfig: () => split, accessRevision: () => 6 },
    cfg: { access: split, accessRevision: 6, accessRuntime: active }, files: {}, env: {} });
  assert.equal(splitService.stateVm().pendingActivation, true, 'the saved non-partitioned choice is not presented as active');
  const customLifetime = { ...split, security: { ...split.security, accessTokenMinutes: 5, refreshIdleHours: 1 } };
  const effective = createBootAccessRuntime({ access: customLifetime, accessRevision: 6, splitAuthEnabled: true,
    apiPublicUrl: split.apiPublicUrl, allowedOrigins: split.uiOrigins });
  assert.equal(effective.revision, 6);
  assert.equal(effective.draft.security.accessTokenMinutes, 10, 'active profile reports the repository-enforced lifetime');
  assert.equal(effective.draft.security.refreshIdleHours, 12);
  assert.equal(effective.draft.security.partitionedCookie, true, 'active profile reports the split transport cookie policy');
  const lan = { ...draft, mode: 'lan', apiPublicUrl: 'https://office.example.org', uiOrigins: [] };
  const unsupportedTopology = createBootAccessRuntime({ access: lan, accessRevision: 9 });
  assert.equal(unsupportedTopology.revision, 0, 'non-local topology is not active without listener/proxy evidence');
  assert.equal(unsupportedTopology.draft.mode, 'local');
});

test('saved custom security remains pending when boot can only apply repository defaults', () => {
  const selected = { ...draft, security: { ...draft.security, accessTokenMinutes: 5, refreshIdleHours: 1 } };
  const active = createBootAccessRuntime({ access: selected, accessRevision: 3 });
  const service = createExternalAccessService({ settings: { revision: () => 14, accessConfig: () => selected, accessRevision: () => 3 },
    cfg: { access: selected, accessRevision: 3, accessRuntime: active }, files: {}, env: {} });
  const vm = service.stateVm();
  assert.equal(vm.activeRevision, 3);
  assert.equal(vm.active.draft.security.accessTokenMinutes, 10);
  assert.equal(vm.pendingActivation, true);
  assert.equal(vm.restartRequired, true);
});

test('plan computes the opaque digest from canonical draft and apply requires the same live plan, revision and digest', async () => {
  const f = fixture(), req = { user: { id: 'usr_a' } };
  const result = await f.service.createPlan({ req, draft, expectedRevision: 7 });
  const normalized = require('../../src/access/draft').validateAccessDraft(draft);
  const expected = crypto.createHash('sha256').update(JSON.stringify({ version: 1, baseRevision: 7, access: normalized }), 'utf8').digest('hex');
  assert.equal(result.configDigest, expected);
  assert.equal(result.configDigest, configDigest(7, normalized));
  await assert.rejects(f.service.applySettings({ req, planId: result.planId, expectedRevision: 7, digest: '0'.repeat(64), publish() {} }), { code: 'conflict' });
  const applied = await f.service.applySettings({ req, planId: result.planId, expectedRevision: 7, digest: result.configDigest,
    publish: async candidate => { assert.deepEqual(candidate.draft, normalized); assert.equal(candidate.configDigest, expected); f.save(normalized); return { saved: true }; } });
  assert.deepEqual(applied, { saved: true });
  await assert.rejects(f.service.applySettings({ req, planId: result.planId, expectedRevision: 7, digest: result.configDigest, publish() {} }), { code: 'not_found' });
});

test('apply rejects an otherwise correct digest after the live settings revision changes', async () => {
  const f = fixture(), req = { user: { id: 'usr_a' } };
  const plan = await f.service.createPlan({ req, draft, expectedRevision: 7 });
  f.bump();
  await assert.rejects(f.service.applySettings({ req, planId: plan.planId, expectedRevision: 7, digest: plan.configDigest, publish() {} }), { code: 'conflict' });
});

test('Settings VM exposes the global concurrency revision separately from saved and active access revisions', async () => {
  const f = fixture(), req = { user: { id: 'usr_revision' } };
  const vm = f.service.stateVm();
  assert.equal(vm.settingsRevision, 7);
  assert.equal(vm.savedRevision, 0);
  const plan = await f.service.createPlan({ req, draft, expectedRevision: vm.settingsRevision });
  assert.equal(plan.baseRevision, vm.settingsRevision);
});

test('persisted public access remains pending until runtime and security hooks report an effective profile', () => {
  const settings = { revision: () => 14, accessConfig: () => draft, accessRevision: () => 3 };
  const service = createExternalAccessService({ settings, cfg: { access: draft, accessRevision: 3 }, files: {}, env: {} });
  const vm = service.stateVm();
  assert.equal(vm.savedRevision, 3);
  assert.equal(vm.activeRevision, 0);
  assert.equal(vm.active.draft.mode, 'local');
  assert.equal(vm.pendingActivation, true);
  assert.equal(vm.restartRequired, true);
});

test('DNS reducer ignores TTL/order, and never calls empty or invalid evidence a pass/wait', () => {
  const records = (ttl, order = false) => ({ A: [{ name: 'api.example.org', type: 'A', value: '8.8.8.8', ttl }], AAAA: [], CNAME: [],
    NS: [{ name: 'example.org', type: 'NS', value: order ? 'ns2.example.org' : 'ns1.example.org', ttl }] });
  const row = (id, value) => ({ id, state: 'answered', records: value });
  assert.deepEqual(reduceDnsObservation({ zone: 'example.org', resolvers: [row('google', records(300)), row('cloudflare', records(270, true))] }),
    { state: 'waiting', reason: 'dns.resolver-disagreement' }, 'different nameserver values are real divergence');
  const sameValues = records(300); sameValues.NS.push({ name: 'example.org', type: 'NS', value: 'ns2.example.org', ttl: 300 });
  const sameValuesOtherTtl = records(270); sameValuesOtherTtl.NS.push({ name: 'example.org', type: 'NS', value: 'ns2.example.org', ttl: 240 });
  assert.equal(reduceDnsObservation({ zone: 'example.org', resolvers: [row('google', sameValues), row('cloudflare', sameValuesOtherTtl)] }).state, 'passed');
  assert.deepEqual(reduceDnsObservation({ zone: null, resolvers: [row('google', { A: [], AAAA: [], CNAME: [], NS: [] }), row('cloudflare', { A: [], AAAA: [], CNAME: [], NS: [] })] }),
    { state: 'unknown', reason: 'dns.no-delegation' });
  assert.equal(reduceDnsObservation({ zone: null, resolvers: [row('google', records(300)), { id: 'cloudflare', state: 'invalid-response', records: records(300) }] }).reason,
    'dns.invalid-response');
  assert.equal(reduceDnsObservation({ zone: null, resolvers: [row('google', records(300)), { id: 'cloudflare', state: 'timeout', records: records(300) }] }).reason,
    'dns.timeout');
  const malformed = records(60); malformed.A[0].ttl = null;
  assert.equal(reduceDnsObservation({ zone: 'example.org', resolvers: [row('google', malformed), row('cloudflare', records(60))] }).reason,
    'dns.invalid-response', 'a malformed TTL cannot be hidden by matching address values');
});

test('plans cannot cross sessions, origins, generations or live policy revisions for the same user', async () => {
  const user = { id: 'usr_authority', status: 'active', auth_generation: 0, role_id: 'rol_owner', permission_revision: 1 };
  const store = { users: { byId: id => id === user.id ? user : null }, rbac: { fingerprint: () => `${user.auth_generation}:${user.permission_revision}` },
    sessions: { isRevoked: () => false } };
  const service = createExternalAccessService({ settings: { revision: () => 1 }, cfg: {}, files: {}, store, env: {} });
  const req = { user, session: { userId: user.id, sid: 'session-a', authGeneration: 0 }, headers: { origin: 'https://office.example.org' } };
  const plan = await service.createPlan({ req, draft, expectedRevision: 1 });
  req.session = { userId: user.id, sid: 'session-b', authGeneration: 1 };
  req.headers.origin = 'https://other.example.org'; user.auth_generation = 1; user.permission_revision++;
  let published = false;
  await assert.rejects(service.applySettings({ req, planId: plan.planId, expectedRevision: 1, digest: plan.configDigest, publish: async () => { published = true; } }), { code: 'not_found' });
  assert.equal(published, false);
});

test('async plans are discarded if permission generation or setup epoch changes before DNS finishes', async () => {
  const user = { id: 'usr_pending_authority', status: 'active', auth_generation: 0, role_id: 'rol_owner', permission_revision: 1 };
  const store = { users: { byId: () => user }, rbac: { fingerprint: () => `${user.auth_generation}:${user.permission_revision}` },
    sessions: { isRevoked: () => false } };
  const releases = [];
  const inspector = { inspect: hostname => new Promise(resolve => releases.push(() => resolve(dnsObservation(hostname)))) };
  const settings = { revision: () => 1 };
  const publicDraft = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
  const service = createExternalAccessService({ settings, cfg: {}, files: {}, store, env: {}, inspector });
  const req = { user, session: { userId: user.id, sid: 'pending-sid', authGeneration: 0 }, headers: { origin: allowedOrigin } };
  const pending = service.createPlan({ req, draft: publicDraft, expectedRevision: 1 });
  user.permission_revision++;
  releases.shift()();
  await assert.rejects(pending, { code: 'not_found' });

  let liveEpoch = 'setup-epoch-a';
  const setup = createExternalAccessService({ settings, cfg: {}, files: {}, env: {}, inspector,
    setupEpochCurrent: code => liveEpoch === code });
  const setupReq = { setupCodeEpoch: liveEpoch, headers: { origin: allowedOrigin } };
  const staged = setup.createPlan({ req: setupReq, draft: publicDraft, expectedRevision: null, setup: true });
  setup.clearSetup({ kind: 'setup', id: liveEpoch });
  liveEpoch = null;
  releases.shift()();
  await assert.rejects(staged, { code: 'not_found' });
});

test('pending DNS-backed plans reserve the per-actor capacity before asynchronous inspection', async () => {
  const waiters = [], records = { A: [], AAAA: [], CNAME: [], NS: [] };
  const inspector = { inspect: hostname => new Promise(resolve => waiters.push(() => resolve({ hostname, zone: null, observedAt: 1, elapsedMs: 1,
    provider: { id: 'unknown', confidence: 'unknown', evidence: [] },
    resolvers: ['google', 'cloudflare'].map(id => ({ id, state: 'answered', records })), records }))) };
  const service = createExternalAccessService({ settings: { revision: () => 1 }, cfg: {}, files: {}, env: {}, inspector });
  const req = { user: { id: 'usr_capacity' } };
  const publicDraft = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
  const requests = Array.from({ length: 12 }, () => service.createPlan({ req, draft: publicDraft, expectedRevision: 1 }));
  assert.equal(waiters.length, 4, 'only the four reserved slots enter DNS inspection');
  for (const release of waiters) release();
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 4);
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'rate_limited').length, 8);
});

test('environment-imposed origins are reported, omitted from writes and cannot be changed by a plan', async () => {
  const origin = 'https://office.example.org';
  const settings = { revision: () => 3, accessConfig: () => null, accessRevision: () => 0 };
  const service = createExternalAccessService({ settings, cfg: {}, files: {}, env: { AO_ALLOWED_ORIGINS: JSON.stringify([origin]) },
    inspector: { inspect: async hostname => ({ hostname, observedAt: 1, provider: { id: 'unknown', confidence: 'unknown', evidence: [] }, zone: null,
      resolvers: [{ id: 'google', state: 'answered', records: { A: [], AAAA: [], CNAME: [], NS: [] } },
        { id: 'cloudflare', state: 'answered', records: { A: [], AAAA: [], CNAME: [], NS: [] } }], records: { A: [], AAAA: [], CNAME: [], NS: [] } }) } });
  const req = { user: { id: 'usr_env' } };
  const split = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
  const plan = await service.createPlan({ req, draft: split, expectedRevision: 3 });
  assert.deepEqual(plan.environmentImposed, [{ field: 'access.uiOrigins', source: 'environment', reasonKey: 'config.environment-override' }]);
  assert.equal(plan.writes.some(row => row.field === 'access.uiOrigins'), false);
  await assert.rejects(service.createPlan({ req, draft: { ...split, uiOrigins: ['https://other.example.net'] }, expectedRevision: 3 }), { code: 'forbidden' });
});

test('setup apply stages the exact plan draft for the final PUT and binds it to the setup-code epoch', async () => {
  const f = fixture(), req = { setupCodeEpoch: 'AO-ABCD-EFGH' };
  const plan = await f.service.createPlan({ req, draft, expectedRevision: null, setup: true });
  assert.equal(plan.configDigest, configDigest(null, require('../../src/access/draft').validateAccessDraft(draft)));
  await assert.rejects(Promise.resolve().then(() => f.service.stageSetup({ req, planId: plan.planId, expectedRevision: null, digest: 'wrong' })), { code: 'conflict' });
  const staged = f.service.stageSetup({ req, planId: plan.planId, expectedRevision: null, digest: plan.configDigest });
  assert.equal(staged.configDigest, plan.configDigest);
  assert.deepEqual(f.service.stagedSetup({ kind: 'setup', id: 'AO-ABCD-EFGH' }), require('../../src/access/draft').validateAccessDraft(draft));
  assert.equal(f.service.stagedSetup({ kind: 'setup', id: 'AO-IJKL-MNOP' }), null);
  f.service.clearSetup({ kind: 'setup', id: 'AO-ABCD-EFGH' });
  assert.equal(f.service.stagedSetup({ kind: 'setup', id: 'AO-ABCD-EFGH' }), null);
});
