'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { compareExample, compareShape } = require('../helpers/contract-shape');

const read = (name) => require('../../docs/architecture/examples/v3/' + name + '.json');
const payload = (name) => read(name).data;

test('external-access response fixtures are separately registered and match their payload-relative contracts', () => {
  for (const name of ['external-access-vm', 'external-access-setup-vm', 'external-access-plan', 'external-access-check-status']) {
    assert.deepEqual(compareExample(name, payload(name), { version: 3 }), [], name);
  }
  assert.deepEqual(compareExample('external-access-check-status', payload('external-access-check-status-waiting'), { version: 3 }), []);
});

test('named setup and job request bodies are strict shapes with no arbitrary probe target fields', () => {
  for (const name of ['external-access-plan-request', 'external-access-checks-request', 'external-access-check-status-request', 'external-access-cancel-request']) {
    const example = read(name);
    assert.deepEqual(compareExample(name, example, { version: 3 }), [], name);
  }
  const plan = read('external-access-plan-request');
  assert.deepEqual(compareShape(plan, { ...plan, url: 'http://127.0.0.1:22/' }), ['$.url: unexpected']);
});

test('topology examples permit public-free local/LAN/private drafts and distinguish public cardinalities', () => {
  const local = payload('external-access-setup-vm').draft;
  for (const mode of ['local', 'lan', 'private']) {
    assert.deepEqual(validateDraft({ ...local, mode }), []);
  }
  const split = payload('external-access-vm').draft;
  assert.deepEqual(validateDraft(split), []);
  for (const mode of ['public-same-origin', 'tunnel']) assert.deepEqual(validateDraft({ ...split, mode, uiOrigins: [] }), []);
  assert.ok(validateDraft({ ...local, mode: 'local', apiPublicUrl: 'https://api.example.org' }).includes('apiPublicUrl'));
  assert.ok(validateDraft({ ...split, uiOrigins: [] }).includes('uiOrigins'));
  assert.ok(validateDraft({ ...split, mode: 'public-same-origin', uiOrigins: ['https://office.example.org'] }).includes('uiOrigins'));
  assert.deepEqual(payload('external-access-setup-vm').saved, null);
  assert.equal(payload('external-access-setup-vm').savedRevision, null);
  assert.equal(payload('external-access-setup-vm').activeRevision, null);
});

test('whole Settings, setup request, locked plan and no-evidence payloads validate as documented variants', () => {
  const vm = payload('external-access-vm');
  assert.deepEqual(compareExample('external-access-vm', { ...vm, draft: payload('external-access-setup-vm').draft,
    saved: { ...vm.saved, draft: payload('external-access-setup-vm').draft },
    active: { ...vm.active, draft: payload('external-access-setup-vm').draft }, lastVerification: null }, { version: 3 }), []);

  const request = read('external-access-plan-request');
  assert.deepEqual(compareExample('external-access-plan-request', request, { version: 3 }), []);
  const splitRequest = { ...request, settingsRevision: 12, draft: payload('external-access-vm').draft };
  assert.deepEqual(compareExample('external-access-plan-request', splitRequest, { version: 3 }), []);
  assert.deepEqual(compareExample('external-access-plan-request', { ...request, arbitraryUrl: 'http://127.0.0.1/' }, { version: 3 }), ['$.arbitraryUrl: unexpected']);

  const plan = payload('external-access-plan');
  assert.deepEqual(compareExample('external-access-plan', { ...plan, result: { ...plan.result,
    environmentImposed: [{ field: 'access.uiOrigins', source: 'environment', reasonKey: 'config.environment-override' }] } }, { version: 3 }), []);

  const status = payload('external-access-check-status');
  assert.deepEqual(compareExample('external-access-check-status', { ...status, result: { ...status.result,
    checks: status.result.checks.map(check => ({ ...check, evidence: null })) } }, { version: 3 }), []);
});

test('plan configDigest is the versioned normalized config candidate and excludes observations', () => {
  const plan = payload('external-access-plan').result;
  const expected = crypto.createHash('sha256').update(JSON.stringify({ version: 1, baseRevision: plan.baseRevision, access: plan.draft }), 'utf8').digest('hex');
  assert.equal(plan.configDigest, expected);
  assert.match(plan.configDigest, /^[a-f0-9]{64}$/);
});

test('saved and active revisions remain distinct and verification is pinned to the active origin/revision/expiry', () => {
  const vm = payload('external-access-vm');
  assert.equal(vm.settingsRevision, 12, 'Settings optimistic concurrency is its global revision');
  assert.equal(vm.savedRevision, 12);
  assert.equal(vm.activeRevision, 11);
  assert.equal(vm.pendingActivation, true);
  assert.equal(vm.restartRequired, true);
  assert.equal(vm.saved.revision, vm.savedRevision);
  assert.equal(vm.active.revision, vm.activeRevision);
  assert.equal(vm.lastVerification.revision, vm.activeRevision);
  assert.equal(vm.lastVerification.origin, vm.active.draft.uiOrigins[0]);
  assert.ok(vm.lastVerification.expiresAt > vm.lastVerification.checkedAt);
  assert.notEqual(vm.lastVerification.revision, vm.savedRevision, 'an old verification cannot establish the saved revision');
});

test('resolver timeout is unknown while propagation waiting requires two valid divergent answers', () => {
  const timeout = payload('external-access-check-status');
  const waiting = payload('external-access-check-status-waiting');
  assert.equal(timeout.result.state, 'unknown');
  assert.equal(timeout.result.checks[0].state, 'unknown');
  assert.equal(timeout.result.checks[0].reason.key, 'dns.timeout');
  assert.equal(timeout.result.checks[0].evidence.resolvers.filter(r => r.state === 'answered').length, 1);
  assert.equal(waiting.result.state, 'waiting');
  assert.equal(waiting.result.checks[0].state, 'waiting');
  assert.equal(waiting.result.checks[0].reason.key, 'dns.resolver-disagreement');
  assert.ok(waiting.result.checks[0].evidence.resolvers.every(r => r.state === 'answered'));
  assert.notDeepEqual(waiting.result.checks[0].evidence.resolvers[0].records.A, waiting.result.checks[0].evidence.resolvers[1].records.A);
});

function validateDraft(draft) {
  const errors = [];
  const nonPublic = ['local', 'lan', 'private'].includes(draft.mode);
  if (nonPublic && (draft.apiPublicUrl !== null || draft.domain !== null)) errors.push('apiPublicUrl');
  if (nonPublic && draft.uiOrigins.length) errors.push('uiOrigins');
  if (['public-same-origin', 'tunnel'].includes(draft.mode) && draft.uiOrigins.length) errors.push('uiOrigins');
  if (['public-split-origin'].includes(draft.mode) && (draft.uiOrigins.length < 1 || draft.uiOrigins.length > 16)) errors.push('uiOrigins');
  if (!nonPublic && (!draft.apiPublicUrl || !draft.domain)) errors.push('publicTarget');
  return errors;
}
