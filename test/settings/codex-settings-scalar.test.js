'use strict';
// P0 regression (2026-10-11): Codex include/exclude arrays reached SettingsVM field.value (scalar only) and broke /api/v3/settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const codex = require('../../src/adapters/codex');

test('Codex adapter settings values preserve canonical filter arrays for runtime operations', () => {
  const v = codex.setup.settings.values({ runtimeConfig: { codex: { home: '/tmp/x/.codex', include: ['a', 'b'], exclude: ['c'], agentGrouping: 'project' } } });
  assert.deepEqual(v.include, ['a', 'b']);
  assert.deepEqual(v.exclude, ['c']);
});

test('Codex resolve turns one-per-line Settings input into canonical arrays', () => {
  const r = codex.setup.settings.resolve({ include: 'a\nb', exclude: '' }, { home: '/tmp/x/.codex', agentGrouping: 'project' });
  assert.deepEqual(r.include, ['a', 'b']);
  assert.deepEqual(r.exclude, []);
});
