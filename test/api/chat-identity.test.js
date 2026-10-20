'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scopeForAccount, sessionRefForScope, portalChatIdentity, visibleToAccount } = require('../../src/api/chat-identity');
const { buildMetaVM3 } = require('../../src/api/v2/vm/meta');

test('chat scopes are stable, opaque, and distinct per authenticated account', () => {
  const store = { users: { owner: () => ({ id: 'owner-account-id' }) } };
  const owner = scopeForAccount('owner-account-id', store);
  const member = scopeForAccount('member-account-id', store);
  assert.equal(member, scopeForAccount('member-account-id', store));
  assert.equal(owner, scopeForAccount('owner-account-id', store));
  assert.match(owner, /^[a-f0-9]{64}$/);
  assert.match(member, /^[a-f0-9]{64}$/);
  assert.notEqual(member, owner);
  assert.ok(!sessionRefForScope(member).includes('member-account-id'));
  assert.equal(sessionRefForScope(owner), 'portal-chat:user:' + owner);
  const singleOwner = scopeForAccount(null, null);
  assert.match(singleOwner, /^[a-f0-9]{64}$/);
  assert.equal(sessionRefForScope(singleOwner), 'portal-chat:user:' + singleOwner);
  const privateSession={class:{kind:'explicit',explicitKey:sessionRefForScope(member)+':session:cs_'+'A'.repeat(32)}};
  assert.deepEqual(portalChatIdentity(privateSession),{kind:'private',scope:member});
  assert.equal(visibleToAccount(privateSession,member),true);
  assert.equal(visibleToAccount(privateSession,owner),false);
});

test('v3 metadata disables chat unless the adapter declares principal-scoped sessions', () => {
  const engine = {
    primaryAgent: () => null,
    runtime: () => ({ adapterId: 'synthetic', name: 'Synthetic', capabilities: { chat: true } }),
    runtimes: () => [{ id: 'synthetic', adapter: 'synthetic', name: 'Synthetic', enabled: true, connection: 'connected', capabilities: { chat: true } }],
    gateway: () => ({ connected: true }),
    agents: () => [], channels: () => [], sessions: () => [],
  };
  const vm = buildMetaVM3({ instance: 'test' }, { engine, authenticated: true });
  assert.equal(vm.runtime.capabilities.chat, false);
  assert.equal(vm.runtimes[0].capabilities.chat, false);
});
