'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAccessDraft } = require('../../src/access/draft');

const split = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
const local = require('../../docs/architecture/examples/v3/external-access-setup-vm.json').data.draft;

test('all six topology choices validate their own public-target and origin cardinality', () => {
  for (const mode of ['local', 'lan', 'private']) assert.equal(validateAccessDraft({ ...local, mode }).mode, mode);
  for (const mode of ['public-same-origin', 'tunnel']) assert.equal(validateAccessDraft({ ...split, mode, uiOrigins: [] }).mode, mode);
  assert.equal(validateAccessDraft(split).mode, 'public-split-origin');
});

test('local modes cannot smuggle a public URL, domain or browser origin into a public probe', () => {
  for (const patch of [
    { apiPublicUrl: 'https://api.example.org' },
    { domain: 'api.example.org' },
    { uiOrigins: ['https://office.example.org'] },
  ]) assert.throws(() => validateAccessDraft({ ...local, ...patch }), { code: 'EACCESSDRAFT' });
});

test('public targets are canonical HTTPS URLs and split origin sets are bounded, unique origins', () => {
  for (const apiPublicUrl of ['http://api.example.org', 'https://user@api.example.org', 'https://*.example.org', 'https://api.example.org/x/../admin', 'https://api.example.org/%2fadmin', 'https://api.example.org/unsafe.path']) {
    assert.throws(() => validateAccessDraft({ ...split, apiPublicUrl }), { code: 'EACCESSDRAFT' });
  }
  assert.equal(validateAccessDraft({ ...split, apiPublicUrl: 'https://api.example.org:8443/api' }).apiPublicUrl, 'https://api.example.org:8443/api');
  assert.equal(validateAccessDraft({ ...split, uiOrigins: ['https://office.example.org:8443'] }).uiOrigins[0], 'https://office.example.org:8443');
  assert.throws(() => validateAccessDraft({ ...split, uiOrigins: ['https://*.example.org'] }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, uiOrigins: ['https://office.example.org/path'] }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, uiOrigins: ['https://office.example.org', 'https://office.example.org'] }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, uiOrigins: [] }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, uiOrigins: Array(17).fill('https://office.example.org') }), { code: 'EACCESSDRAFT' });
});

test('draft object and security values reject unknown fields and out-of-range lifetimes', () => {
  assert.throws(() => validateAccessDraft({ ...split, debugUrl: 'http://127.0.0.1' }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, security: { ...split.security, accessTokenMinutes: 60 } }), { code: 'EACCESSDRAFT' });
  assert.throws(() => validateAccessDraft({ ...split, security: { ...split.security, customHeaders: ['unsafe'] } }), { code: 'EACCESSDRAFT' });
});
