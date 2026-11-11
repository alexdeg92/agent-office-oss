'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const cursor = require('../../src/adapters/cursor');

test('Cursor settings values and resolve match the Codex scalar shape', () => {
  const v = cursor.setup.settings.values({ runtimeConfig: { cursor: { home: '/tmp/x/.cursor', include: ['a', 'b'], exclude: ['c'], agentGrouping: 'project' } } });
  assert.equal(v.home, '/tmp/x/.cursor');
  assert.deepEqual(v.include, ['a', 'b']);
  assert.deepEqual(v.exclude, ['c']);
  assert.equal(v.agentGrouping, 'project');
  const r = cursor.setup.settings.resolve({ include: 'a\nb', exclude: '' }, { home: '/tmp/x/.cursor', agentGrouping: 'project' });
  assert.equal(r.adapter, 'cursor');
  assert.deepEqual(r.include, ['a', 'b']);
  assert.deepEqual(r.exclude, []);
});
