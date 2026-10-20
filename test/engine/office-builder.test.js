'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/model');
const { buildOfficeView } = require('../../src/engine/office/builder');
const { officeDefaults, createStateTracker } = require('../../src/api/v2/vm/office');
const { projectionFor } = require('../../src/api/v2/project3x');

test('engine Office builder keeps one occupant with all memberships across teams', () => {
  const now = Date.UTC(2026, 9, 16, 16);
  const teams = ['team_alpha', 'team_beta'].map((id, index) => M.Team.from({ id, storeId: id,
    label: id, status: 'active', observedAt: now + index }));
  const members = teams.map((team, index) => M.TeamMember.from({ id: `member_${index}`, teamId: team.id,
    name: 'Shared engineer', roleKind: 'lead', roleLabel: 'lead', roleEvidence: 'explicit', sourceAgentName: 'Shared engineer',
    runtimeKind: 'codex', hostAgentId: 'pane_shared', parentMemberId: null, status: 'active' }));
  const sessionKey = 'session:shared';
  const refs = Object.fromEntries(members.map(member => [member.id, { memberId: member.id, runtimeKind: 'codex',
    sessionRef: 'native-shared-session', sessionKey, agentId: 'agent_shared' }]));
  const snapshot = { teams, team: null, members, agents: [{ id: 'pane_shared', role: 'delegate', status: 'working', observedAt: now,
    staleAfter: now + 60_000 }], identityLinks: [{ agentId: 'agent_shared', hostAgentId: 'pane_shared', confidence: 'exact',
    evidence: 'explicit-runtime-identity' }], observedAt: now };
  Object.defineProperties(snapshot, {
    privateMemberSessionRefs: { enumerable: false, value: refs },
    privateMemberSessionKeys: { enumerable: false, value: Object.fromEntries(members.map(member => [member.id, sessionKey])) },
  });
  const runtimeSession = { key: sessionKey, class: { kind: 'conversation', agentId: 'agent_shared' },
    run: { status: 'running', level: 'observed', observedAt: now, expiresAt: now + 60_000 },
    updatedAt: now, summary: '', usage: null };
  const agent = { id: 'agent_shared', isPrimary: false, name: 'Shared engineer', displayName: 'Shared engineer' };
  const engine = {
    agents: () => [agent], primaryAgent: () => null, session: key => key === sessionKey ? runtimeSession : null,
    sessions: () => [runtimeSession], identitySessions: () => [{ sessionKey, runtimeKind: 'codex', sessionRef: 'native-shared-session', agentId: agent.id }],
    activities: () => [], agentPresence: () => true, transcript: () => null,
  };
  const defaults = officeDefaults();
  const office = { occupants: [{ id: 'agent:' + agent.id, role: 'agent', name: agent.name,
    title: { key: 'sessionTitle.named', params: { name: agent.name } }, roleLabel: { key: 'occupantRole.agent' },
    state: 'working', stateSince: now, sessionKey, tokens: 0, lastSeenAt: now,
    look: { character: 'agent', variant: null, accessories: [] }, ruleId: null, floorId: '1', stationUid: null, parentId: null }] };
  const projected = buildOfficeView(engine, { office, snapshot, principal: { role: 'admin' }, projection: projectionFor(3),
    planningOffice: office, tracker: createStateTracker(), sourceEnabled: true, layout: defaults.layout, index: defaults.index,
    now, canReadSessions: true, agentPresenceWindowMs: 15 * 60_000, idleTransitionDebounceMs: 0 });
  assert.equal(projected.occupants.filter(row => row.id === 'agent:' + agent.id).length, 1);
  const shared = projected.occupants.find(row => row.id === 'agent:' + agent.id);
  assert.deepEqual(shared.teamIds, ['team_alpha', 'team_beta']);
  assert.equal(shared.teamId, 'team_alpha', 'the primary team is selected deterministically');
});
