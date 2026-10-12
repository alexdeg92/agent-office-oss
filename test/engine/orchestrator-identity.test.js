'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/model');
const { createOrchestratorIdentityResolver } = require('../../src/engine/orchestrator-identity');
const { createEngine } = require('../../src/engine');

const now = Date.UTC(2026, 9, 10);
const hostAgent = (id, hostId = 'hst_local', runtimeKind = 'claude-code') => M.HostAgent.from({
  id, hostId, orchestratorId: 'orc_herdr', name: 'Claude Code', runtimeKind,
  role: 'primary', status: 'working', observedAt: now, staleAfter: now + 120_000,
});
const baseAgent = (id, runtime = 'claude-code') => ({ id, hostId: 'hst_local', runtimeKind: runtime });

test('ADR-004 canonical entities validate source-safe orchestrator and team records', () => {
  const h = M.Host.from({ id: 'hst_local', label: null, platform: 'linux', sourceStatus: 'available', observedAt: now });
  const o = M.Orchestrator.from({ id: 'orc_herdr', hostId: h.id, kind: 'herdr', label: null, sourceStatus: 'available', observedAt: now });
  const a = hostAgent('ha_1');
  const t = M.Team.from({ id: 'team_1', storeId: 'store_1', label: 'Default', status: 'active', observedAt: now });
  const member = M.TeamMember.from({ id: 'member_1', teamId: t.id, name: 'builder', roleKind: 'member', roleLabel: 'builder',
    roleEvidence: 'explicit', sourceAgentName: 'builder', hostAgentId: null, status: 'active' });
  const task = M.Task.from({ id: 'task_1', teamId: t.id, title: 'A task', state: 'working', priority: 1, ownerMemberId: member.id,
    reviewerMemberIds: [], createdAt: now, updatedAt: now, commit: null, reportPresent: true, briefPresent: true, messageCount: 0 });
  const review = M.Review.from({ id: 'review_1', taskId: task.id, reviewerMemberId: null, verdict: 'pending', createdAt: null, reportPresent: false });
  const msg = M.TeamMessage.from({ id: 'message_1', teamId: t.id, taskId: task.id, fromMemberId: member.id,
    toMemberId: null, createdAt: now, bodyPresent: true });
  assert.ok(h && o && a && t && member && task && review && msg);
  assert.ok(M.Task.from({ id: 'task_p0', teamId: t.id, title: 'P0', state: 'open', priority: 0, ownerMemberId: null,
    reviewerMemberIds: [], createdAt: now, updatedAt: now, commit: null, reportPresent: false, briefPresent: false, messageCount: 0 }));
  assert.equal('body' in msg, false);
  assert.equal('brief' in task, false);
  assert.equal('reportPath' in task, false);
  assert.equal(M.HostAgent.from({ ...a.toJSON(), title: 'private title' }), null);
  assert.equal(M.HostAgent.from({ ...a.toJSON(), runtimeSessionRef: 'private session' }), null);
  assert.equal(M.HostAgent.from({ ...a.toJSON(), status: 'prompt text' }), null);
});

test('exact runtime identity links host rows without returning or persisting private session refs', () => {
  const resolver = createOrchestratorIdentityResolver();
  const host = hostAgent('ha_1');
  const links = resolver.reconcile({
    hosts: [{ row: host, sessionRef: 'opaque-private-session' }],
    agents: [{ ...baseAgent('rt:claude-code:agent:atlas'), sessionRef: 'opaque-private-session' }],
  });
  assert.deepEqual(links, [{ hostAgentId: host.id, agentId: 'rt:claude-code:agent:atlas', evidence: 'shared-runtime-session-ref', confidence: 'exact' }]);
  assert.equal(JSON.stringify(links).includes('opaque-private-session'), false);
  assert.ok(M.IdentityLink.from(links[0]));
});

test('adapter identity candidates outside the canonical session window stay private but joinable', () => {
  const engine = createEngine({ adapter: require('../../src/adapters/codex').definition });
  const ref = '123e4567-e89b-42d3-a456-426614174000';
  engine.setIdentitySessionRefs([{ sessionKey: 'codex:' + 'a'.repeat(64), sessionRef: ref }]);
  assert.deepEqual(engine.identitySessions('herdr').map(row => ({ sessionKey: row.sessionKey, runtimeKind: row.runtimeKind, sessionRef: row.sessionRef })), [
    { sessionKey: 'codex:' + 'a'.repeat(64), runtimeKind: 'codex', sessionRef: ref },
  ]);
  assert.deepEqual(engine.sessions(), [], 'unread adapter candidates do not enter canonical sessions or public views');
  assert.equal(JSON.stringify(engine.sessions()).includes(ref), false);
});

test('missing, ambiguous, cross-host and mismatched-runtime evidence never links by name', () => {
  const resolver = createOrchestratorIdentityResolver();
  const host = hostAgent('ha_1');
  const observation = { row: host, name: 'same visible name', sessionRef: null, identityRef: null };
  assert.deepEqual(resolver.reconcile({ hosts: [observation], agents: [baseAgent('agent_1')] }), []);
  assert.deepEqual(resolver.reconcile({ hosts: [{ ...observation, sessionRef: 's1' }], agents: [
    { ...baseAgent('agent_1'), sessionRef: 's1', runtimeKind: 'codex' },
  ] }), []);
  assert.deepEqual(resolver.reconcile({ hosts: [{ ...observation, sessionRef: 's1' }], agents: [
    { ...baseAgent('agent_1'), sessionRef: 's1' }, { ...baseAgent('agent_2'), sessionRef: 's1' },
  ] }), []);
  assert.deepEqual(resolver.reconcile({ hosts: [{ ...observation, sessionRef: 's1' }], agents: [
    { ...baseAgent('agent_1'), hostId: 'hst_other', sessionRef: 's1' },
  ] }), []);
});

test('one runtime agent may link from several distinct panes; ambiguous links stay omitted', () => {
  const resolver = createOrchestratorIdentityResolver();
  const hosts = ['ha_1', 'ha_2'].map(id => ({ row: hostAgent(id), sessionRef: 'session-1' }));
  const links = resolver.reconcile({ hosts, agents: [{ ...baseAgent('agent_1'), sessionRef: 'session-1' }] });
  assert.deepEqual(links.map(x => x.hostAgentId), ['ha_1', 'ha_2']);
  assert.equal(resolver.reconcile({ hosts: [hosts[0]], agents: [
    { ...baseAgent('agent_1'), sessionRef: 'session-1' }, { ...baseAgent('agent_2'), sessionRef: 'session-1' },
  ] }).length, 0);
});

test('explicit adapter-mapped runtime identity is exact, and overlong refs fail closed', () => {
  const resolver = createOrchestratorIdentityResolver();
  const host = { row: hostAgent('ha_1'), identityRef: 'agent-session-uuid' };
  const linked = resolver.reconcile({ hosts: [host], agents: [{ ...baseAgent('agent_1'), identityRef: 'agent-session-uuid' }] });
  assert.equal(linked[0].evidence, 'explicit-runtime-identity');
  assert.deepEqual(resolver.reconcile({ hosts: [{ ...host, identityRef: 'x'.repeat(1025) }],
    agents: [{ ...baseAgent('agent_1'), identityRef: 'x'.repeat(1025) }] }), []);
});
