'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwnerSession } = require('../../src/api/design-system-access');
const { createApp } = require('../../src/api/http');
const path = require('node:path');

test('design-system access follows the canonical active owner account', () => {
  const store = { users: { owner: () => ({ id: 'usr-owner', email: 'owner@example.test', status: 'active' }) } };
  assert.equal(isOwnerSession({ userId: 'usr-owner', email: 'owner@example.test' }, { store }), true);
  assert.equal(isOwnerSession({ userId: 'usr-editor', email: 'owner@example.test' }, { store }), false);
  assert.equal(isOwnerSession({ email: 'OWNER@example.test' }, { store }), true, 'legacy owner cookie is bound by its verified email');
  assert.equal(isOwnerSession({ email: 'editor@example.test' }, { store }), false);
  assert.equal(isOwnerSession({ userId: 'usr-owner', email: 'owner@example.test' }, { store: { users: { owner: () => ({ id: 'usr-owner', email: 'owner@example.test', status: 'deleted' }) } } }), false);
});

test('single-owner deployments require an exact configured owner email when no owner row exists', () => {
  assert.equal(isOwnerSession({ email: 'owner@example.test' }, { ownerEmail: 'OWNER@example.test' }), true);
  assert.equal(isOwnerSession({ email: 'editor@example.test' }, { ownerEmail: 'owner@example.test' }), false);
  assert.equal(isOwnerSession({ email: 'owner@example.test' }, {}), false);
  assert.equal(isOwnerSession(null, { ownerEmail: 'owner@example.test' }), false);
});

test('the combined frontend serves the design-system shell only after the owner check', async t => {
  const server = createApp({ readonly: false, publicDir: path.resolve('public'), mountRoutes: () => {}, designSystemAllowed: req => req.headers['x-test-owner'] === 'yes' })
    .listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for(const path of ['/v2/design-system','/v2/pages/ds.js','/v2/pages/design-system.css','/v2/components/bureau/primitives.js']) {
    const denied = await fetch(base + path);
    assert.equal(denied.status, 404, path+' is denied anonymously');
    const allowed = await fetch(base + path, { headers: { 'x-test-owner': 'yes' } });
    assert.equal(allowed.status, 200, path+' is available to the owner');
    if(path==='/v2/design-system')assert.match(await allowed.text(), /Agent Office/);
  }
  assert.equal((await fetch(base + '/v%32/pages/ds.js')).status,404,'canonical asset aliases receive the same gate');
});
