'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../../src/security/orchestrator-team-resources');
const { projectOfficeOccupant, projectOfficeTeamOccupants: projectOfficeTeamOccupantsImpl, projectOrchestrators, projectTeamBoard, projectionCacheKey, issueReportRef } = require('../../src/api/orchestrator-team-projection');
const { officeDefaults } = require('../../src/api/v2/vm/office');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');

const projectOfficeTeamOccupants = (...args) => {
  const options = args[3] || {};
  args[3] = { index: officeDefaults().index, ...options };
  return projectOfficeTeamOccupantsImpl(...args);
};

const admin = { id: 'admin-user', role: 'admin', permissionRevision: 4 };
const editor = { id: 'editor-user', role: 'editor', permissionRevision: 2 };
const canary = 'private-path-task-body-pane-title';

test('ADR-004 resources are closed and default-deny for every non-admin role including children', () => {
  assert.deepEqual(registry.RESOURCES.map((x) => [x.key, x.parent]), [
    ['orchestrators', null], ['teams', null], ['teams.report.resolve', 'teams'],
  ]);
  for (const role of ['editor', 'reader', 'custom', 'unknown', null]) {
    for (const resource of registry.RESOURCES) assert.equal(registry.allows(role, resource.key), false, `${role}/${resource.key}`);
  }
  for (const resource of registry.RESOURCES) assert.equal(registry.allows('admin', resource.key), true);
  assert.equal(registry.allows('admin', 'teams.future.mutate'), false);
  assert.equal(registry.allows('admin', 'teams', 'write'), false);
});

test('unauthorized office projection is byte-for-byte the old occupant shape', () => {
  const occupant = { id: 'runtime-agent', name: 'Scribe', role: 'primary' };
  const linked = { id: 'opaque-host-agent', role: 'delegate', status: 'working', name: canary, paneRef: canary };
  const exactLink = { agentId: occupant.id, hostAgentId: linked.id, confidence: 'exact', evidence: 'explicit-runtime-identity' };
  assert.deepEqual(projectOfficeOccupant(occupant, linked, exactLink, editor), occupant);
  assert.deepEqual(projectOfficeOccupant(occupant, null, null, admin), occupant);
  assert.deepEqual(projectOfficeOccupant(occupant, linked, { ...exactLink, agentId: 'other' }, admin, { sourceEnabled: true }), occupant, 'mismatched links cannot annotate');
  assert.deepEqual(projectOfficeOccupant(occupant, linked, exactLink, admin, { sourceEnabled: true }), {
    ...occupant, hostAgentId: 'opaque-host-agent', hostRole: 'delegate', hostStatus: 'working',
  });
});

test('host collection denies before reading rows and authorized projection allowlists metadata', () => {
  const snapshot = { hosts: [{ id: 'h', label: 'Host', platform: 'linux', status: 'available', observedAt: 10, path: canary }],
    orchestrators: [{ id: 'o', hostId: 'h', kind: 'herdr', label: 'Herdr', sourceStatus: 'available', observedAt: 10, argv: canary }],
    agents: [{ id: 'ha', hostId: 'h', orchestratorId: 'o', name: 'Builder', runtimeKind: 'claude-code', role: 'delegate', status: 'working', observedAt: 10, staleAfter: 20, paneRef: canary, sessionRef: canary }], revision: 3 };
  assert.throws(() => projectOrchestrators(snapshot, editor, { sourceEnabled: true }), { code: 'permission-denied' });
  assert.deepEqual(projectOrchestrators(snapshot, admin), { hosts: [], orchestrators: [], agents: [], revision: null }, 'a disabled source publishes no inventory');
  const projected = projectOrchestrators(snapshot, admin, { sourceEnabled: true });
  assert.deepEqual(projected.agents[0], { id: 'ha', hostId: 'h', orchestratorId: 'o', name: 'Builder', runtimeKind: 'claude-code', role: 'delegate', status: 'working', observedAt: 10, staleAfter: 20 });
  assert.equal(JSON.stringify(projected).includes(canary), false);
});

test('exact identity links project only an existing runtime occupant reference; names and ambiguous links do not', () => {
  const snapshot = { hosts: [], orchestrators: [], revision: 4,
    agents: [{ id: 'pane-1', hostId: 'h', orchestratorId: 'o', name: 'Same Name', runtimeKind: 'claude-code', role: 'delegate', status: 'working', observedAt: 1, staleAfter: 2 },
      { id: 'pane-2', hostId: 'h', orchestratorId: 'o', name: 'Same Name', runtimeKind: 'claude-code', role: 'delegate', status: 'idle', observedAt: 1, staleAfter: 2 }],
    identityLinks: [{ hostAgentId: 'pane-1', agentId: 'runtime-main', evidence: 'shared-runtime-session-ref', confidence: 'exact' },
      { hostAgentId: 'pane-2', agentId: 'runtime-main', evidence: 'shared-runtime-session-ref', confidence: 'exact' },
      { hostAgentId: 'pane-2', agentId: 'runtime-other', evidence: 'shared-runtime-session-ref', confidence: 'exact' }] };
  const projected = projectOrchestrators(snapshot, admin, { sourceEnabled: true, runtimeAgents: [
    { id: 'runtime-main', isPrimary: true, name: 'Same Name' }, { id: 'runtime-other', isPrimary: false, name: 'Same Name' },
  ] });
  assert.equal(projected.agents.length, 1, 'exactly linked pane is represented by its existing runtime occupant');
  assert.equal(projected.agents[0].id, 'pane-2');
  assert.equal('linkedOccupantId' in projected.agents[0], false, 'ambiguous pane has no link');
  const noNames = projectOrchestrators({ ...snapshot, identityLinks: [] }, admin, { sourceEnabled: true, runtimeAgents: [{ id: 'runtime-main', isPrimary: true, name: 'Same Name' }] });
  assert.ok(noNames.agents.every(row => !('linkedOccupantId' in row)), 'a shared display name is not evidence');
});

test('OfficeVM occupant annotation is closed, exact, and principal-gated', () => {
  const occupant = { id: 'primary', name: 'Scribe', role: 'primary' };
  const host = { id: 'opaque-host-agent', role: 'delegate', status: 'working', name: canary, paneRef: canary };
  const link = { agentId: 'runtime-main', hostAgentId: host.id, confidence: 'exact', evidence: 'explicit-runtime-identity' };
  assert.deepEqual(projectOfficeOccupant(occupant, host, link, admin, { sourceEnabled: true, agentId: 'runtime-main' }), {
    ...occupant, hostAgentId: host.id, hostRole: 'delegate', hostStatus: 'working',
  });
  assert.deepEqual(projectOfficeOccupant(occupant, host, link, editor, { sourceEnabled: true, agentId: 'runtime-main' }), occupant);
  assert.deepEqual(projectOfficeOccupant(occupant, { ...host, status: 'host-invented-value' }, link, admin, { sourceEnabled: true, agentId: 'runtime-main' }), occupant);
  assert.equal(projectOfficeOccupant({ ...occupant, id: 'agent:child' }, host, { ...link, agentId: 'agent:child' }, admin,
    { sourceEnabled: true, agentId: 'agent:child', parentOccupantId: 'primary' }).parentId, 'primary');
  const teamsOnly = { id: 'teams-reader', role: 'custom', permissions: { teams: 'read' } };
  assert.equal(projectOfficeOccupant(occupant, host, link, teamsOnly,
    { sourceEnabled: true, agentId: 'runtime-main', parentOccupantId: 'primary' }).parentId, undefined);
});

test('registered pane-linked team members enter the office once with stable PM lineage and permission gates', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'Agent principal', title: { key: 'sessionTitle.named', params: { name: 'Agent principal' } },
    roleLabel: { key: 'occupantRole.primary' }, state: 'idle', stateSince: 10, stationUid: 'desk', look: { character: 'agent', variant: null, accessories: [] },
    ruleId: null, destination: null, sessionKey: null, tokens: 0, lastSeenAt: null }], kpis: [
    { id: 'active', label: { key: 'kpi.active' }, value: 0, unit: 'count', sub: { key: 'kpi.idle', params: { agent: 'Agent principal' } } },
    { id: 'subagents', label: { key: 'kpi.subagents' }, value: 0, unit: 'count', sub: null },
  ] };
  const snapshot = { members: [
    { id: 'member:pm', name: 'PM', roleKind: 'lead', roleLabel: 'pm', parentMemberId: null, hostAgentId: 'pane-pm' },
    { id: 'member:builder', name: 'Builder', roleKind: 'member', roleLabel: 'builder', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
    { id: 'member:critic', name: 'Critic', roleKind: 'member', roleLabel: 'reviewer', parentMemberId: 'member:pm', hostAgentId: 'pane-critic' },
    { id: 'member:duplicate', name: 'Duplicate pane member', roleKind: 'unknown', roleLabel: null, parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [
    { id: 'pane-pm', name: 'host-only PM', role: 'primary', status: 'working', observedAt: 11, staleAfter: 30 },
    { id: 'pane-builder', name: 'host-only Builder', role: 'delegate', status: 'working', observedAt: 12, staleAfter: 30 },
    { id: 'pane-critic', name: 'host-only Critic', role: 'delegate', status: 'blocked', observedAt: 13, staleAfter: 30 },
  ], observedAt: 14, identityLinks: [] };
  const projected = projectOfficeTeamOccupants(base, snapshot, admin, { sourceEnabled: true });
  const additions = projected.occupants.filter(row => row.id.startsWith('team-member:'));
  assert.equal(additions.length, 3, 'duplicate references to a pane do not duplicate the person');
  const byName = new Map(additions.map(row => [row.name, row]));
  assert.equal(byName.get('PM').role, 'agent', 'a host-only team lead is not a second instance primary');
  assert.equal(projected.occupants.filter(row => row.role === 'primary').length, 1, 'only the instance main agent is primary');
  assert.equal(byName.get('Builder').parentId, byName.get('PM').id);
  assert.equal(byName.get('Critic').parentId, byName.get('PM').id);
  assert.equal(byName.get('Critic').state, 'blocked');
  assert.equal(byName.get('Builder').state, 'unknown', 'a shared pane without exact identity does not assert status for either member');
  assert.equal(projected.kpis.find(row => row.id === 'active').value, null, 'the ambiguous host state makes the active count unknown');
  assert.deepEqual(projected.kpis.find(row => row.id === 'active').sub, { key: 'kpi.stateUnknown' }, 'the count explains ambiguous host evidence');
  assert.equal(projected.kpis.find(row => row.id === 'subagents').value, 2, 'subagent count includes both registered delegates');
  assert.equal('paneRef' in byName.get('Builder'), false, 'private pane references never project');
  const withoutTeams = { id: 'teams-only', role: 'custom', permissions: { teams: 'read' } };
  const withoutOrchestrators = { id: 'herdr-only', role: 'custom', permissions: { orchestrators: 'read' } };
  assert.equal(projectOfficeTeamOccupants(base, snapshot, withoutTeams, { sourceEnabled: true }), base);
  assert.equal(projectOfficeTeamOccupants(base, snapshot, withoutOrchestrators, { sourceEnabled: true }), base);
});

test('provider-neutral canonical teams group native lead/engineer labels and infer an unlabelled leader from structure', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'Main', state: 'idle', stateSince: 1, stationUid: null,
    look: { character: 'agent', variant: null, accessories: [] }, ruleId: null, destination: null, sessionKey: null, tokens: 0, lastSeenAt: null }],
    kpis: [{ id: 'active', value: 0, sub: null }, { id: 'subagents', value: 0, sub: null }] };
  const members = [
    { id: 'org-lead', name: 'Lead', roleKind: 'lead', roleLabel: 'lead', hostAgentId: 'host-org-lead', parentMemberId: null },
    { id: 'org-engineer', name: 'Engineer', roleKind: 'member', roleLabel: 'engineer', hostAgentId: 'host-org-engineer', parentMemberId: 'org-lead' },
    { id: 'unlabelled-root', name: 'Coordinator', roleKind: 'unknown', roleLabel: null, hostAgentId: 'host-root', parentMemberId: null },
    { id: 'unlabelled-child', name: 'Analyst', roleKind: 'unknown', roleLabel: null, hostAgentId: 'host-child', parentMemberId: 'unlabelled-root' },
  ];
  const agents = members.map(member => ({ id: member.hostAgentId, role: 'delegate', status: 'idle', observedAt: 10, staleAfter: 100 }));
  const projected = projectOfficeTeamOccupants(base, { observedAt: 20, members, agents, identityLinks: [] }, admin, { sourceEnabled: true });
  const byName = new Map(projected.occupants.map(row => [row.name, row]));
  assert.equal(byName.get('Lead').role, 'agent');
  assert.equal(byName.get('Engineer').role, 'subagent');
  assert.equal(byName.get('Engineer').parentId, byName.get('Lead').id);
  assert.equal(byName.get('Coordinator').role, 'agent', 'a root with children is structurally recognized as a lead, not a second primary');
  assert.equal(projected.occupants.filter(row => row.role === 'primary').length, 1);
  assert.equal(byName.get('Analyst').role, 'subagent');
  assert.equal(byName.get('Analyst').parentId, byName.get('Coordinator').id);
});

test('flat canonical member roles attach to the one canonical lead when parent refs are absent', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'Main', state: 'idle', stateSince: 1, stationUid: null,
    look: { character: 'agent', variant: null, accessories: [] }, ruleId: null, destination: null, sessionKey: null, tokens: 0, lastSeenAt: null }],
    kpis: [{ id: 'active', value: 0, sub: null }, { id: 'subagents', value: 0, sub: null }] };
  const members = [
    { id: 'lead', name: 'Lead', roleKind: 'lead', roleLabel: 'coordinator', hostAgentId: 'host-lead' },
    { id: 'one', name: 'One', roleKind: 'member', roleLabel: 'engineer', hostAgentId: 'host-one' },
    { id: 'two', name: 'Two', roleKind: 'member', roleLabel: 'reviewer', hostAgentId: 'host-two' },
  ];
  const agents = members.map(member => ({ id: member.hostAgentId, role: 'delegate', status: 'idle', observedAt: 10, staleAfter: 100 }));
  const out = projectOfficeTeamOccupants(base, { observedAt: 20, team: { id: 'org-team' }, members, agents, identityLinks: [] }, admin, { sourceEnabled: true });
  const rows = new Map(out.occupants.map(row => [row.name, row]));
  assert.equal(rows.get('One').parentId, rows.get('Lead').id);
  assert.equal(rows.get('Two').parentId, rows.get('Lead').id);
  assert.equal(rows.get('Lead').parentId, null);
  assert.ok([rows.get('Lead'), rows.get('One'), rows.get('Two')].every(row => row.teamId === 'org-team'));
});

test('team population overlay preserves unknown activity when any rendered occupant is unknown', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'PM', title: { key: 'sessionTitle.named', params: { name: 'PM' } },
    roleLabel: { key: 'occupantRole.primary' }, state: 'unknown', stateSince: 10, stationUid: null, look: { character: 'agent', variant: null, accessories: [] },
    ruleId: null, destination: null, sessionKey: null, tokens: 0, lastSeenAt: null }], kpis: [
    { id: 'active', label: { key: 'kpi.active' }, value: null, unit: 'count', sub: { key: 'kpi.stateUnknown' } },
    { id: 'subagents', label: { key: 'kpi.subagents' }, value: 0, unit: 'count', sub: null },
  ] };
  const snapshot = { observedAt: 20, members: [
    { id: 'member:builder', name: 'Builder', roleKind: 'member', roleLabel: 'builder', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [{ id: 'pane-builder', role: 'delegate', status: 'working', observedAt: 15, staleAfter: 30 }], identityLinks: [] };
  const projected = projectOfficeTeamOccupants(base, snapshot, admin, { sourceEnabled: true });
  const active = projected.kpis.find(row => row.id === 'active');
  assert.equal(active.value, null, 'an observed active member cannot turn unknown primary activity into a precise count');
  assert.deepEqual(active.sub, { key: 'kpi.stateUnknown' });
  assert.equal(projected.occupants.length, 2);
});

test('expired Herdr execution lease makes the team occupant presentation unknown too', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'PM', title: { key: 'sessionTitle.named', params: { name: 'PM' } },
    roleLabel: { key: 'occupantRole.primary' }, state: 'idle', stateSince: 10, stationUid: null, look: { character: 'agent', variant: null, accessories: [] },
    ruleId: null, destination: null, sessionKey: null, tokens: 0, lastSeenAt: null }], kpis: [
    { id: 'active', label: { key: 'kpi.active' }, value: 0, unit: 'count', sub: { key: 'kpi.idle', params: { agent: 'PM' } } },
    { id: 'subagents', label: { key: 'kpi.subagents' }, value: 0, unit: 'count', sub: null },
  ] };
  const snapshot = { observedAt: 20, members: [
    { id: 'member:builder', name: 'Builder', roleKind: 'member', roleLabel: 'builder', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [{ id: 'pane-builder', role: 'delegate', status: 'working', observedAt: 10, staleAfter: 15 }], identityLinks: [] };
  const projected = projectOfficeTeamOccupants(base, snapshot, admin, { sourceEnabled: true });
  const builder = projected.occupants.find(row => row.name === 'Builder');
  assert.equal(builder.state, 'unknown', 'expired raw Herdr activity is not shown as live work');
  assert.deepEqual(builder.execution, { status: 'unknown', evidence: { level: 'unknown', observedAt: null, expiresAt: null } });
  const active = projected.kpis.find(row => row.id === 'active');
  assert.equal(active.value, null);
  assert.deepEqual(active.sub, { key: 'kpi.stateUnknown' });
});

test('exact runtime session identity reuses one office occupant and attaches its registered parent', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'PM', state: 'idle', sessionKey: 'pm-session' },
    { id: 'agent:builder', role: 'subagent', name: 'Builder', state: 'working', sessionKey: 'builder-session' }] };
  const snapshot = { privateMemberSessionKeys: { 'member:pm': 'pm-session', 'member:builder': 'builder-session' },
    privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'openclaw', sessionRef: 'pm-ref', sessionKey: 'pm-session' },
      'member:builder': { runtimeKind: 'codex', sessionRef: 'builder-ref', sessionKey: 'builder-session' } }, members: [
    { id: 'member:pm', name: 'PM', roleKind: 'lead', roleLabel: 'project lead', hostAgentId: 'pane-pm' },
    { id: 'member:builder', name: 'Builder', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [
    { id: 'pane-pm', role: 'primary', status: 'working' }, { id: 'pane-builder', role: 'delegate', status: 'working' },
  ], identityLinks: [
    { hostAgentId: 'pane-pm', agentId: 'runtime-main', evidence: 'shared-runtime-session-ref', confidence: 'exact' },
    { hostAgentId: 'pane-builder', agentId: 'builder', evidence: 'shared-runtime-session-ref', confidence: 'exact' },
  ] };
  const out = projectOfficeTeamOccupants(base, snapshot, admin, { sourceEnabled: true, canReadSessions: true, runtimeSessions: [
    { key: 'pm-session', class: { kind: 'conversation', agentId: 'runtime-main' } },
    { key: 'builder-session', class: { kind: 'conversation', agentId: 'builder' } },
  ], runtimeAgents: [
    { id: 'runtime-main', isPrimary: true, mainSessionKey: 'pm-session' }, { id: 'builder', isPrimary: false },
  ], primaryAgentId: 'runtime-main', runtimeIdentitySessions: [
    { agentId: 'runtime-main', sessionKey: 'pm-session', runtimeKind: 'openclaw', sessionRef: 'pm-ref' },
    { agentId: 'builder', sessionKey: 'builder-session', runtimeKind: 'codex', sessionRef: 'builder-ref' },
  ] });
  assert.equal(out.occupants.length, 2);
  assert.equal(out.occupants[1].hostAgentId, 'pane-builder');
  assert.equal(out.occupants[1].parentId, 'primary');
});

test('a fresh exact Herdr pane keeps an otherwise quiet runtime agent on stage; closed or stale panes do not', () => {
  const base = { occupants: [{ id: 'primary', role: 'primary', name: 'PM', state: 'idle', stationUid: null }], kpis: [
    { id: 'active', value: 0, sub: { key: 'kpi.idle', params: { agent: 'PM' } } },
    { id: 'subagents', value: 0, sub: null },
  ] };
  const host = { id: 'pane-builder', hostId: 'host', orchestratorId: 'herdr', name: 'Pane label', runtimeKind: 'claude-code',
    role: 'unknown', status: 'idle', observedAt: 10, staleAfter: 40 };
  const snapshot = { observedAt: 20, agents: [host], members: [], identityLinks: [
    { hostAgentId: host.id, agentId: 'project-agent', confidence: 'exact', evidence: 'shared-runtime-session-ref' },
  ] };
  const runtimeAgents = [{ id: 'project-agent', isPrimary: false, name: 'Project agent', displayName: null, spawnedBy: null }];
  const projected = projectOfficeTeamOccupants(base, snapshot, admin, { sourceEnabled: true, runtimeAgents });
  const occupant = projected.occupants.find(row => row.id === 'agent:project-agent');
  assert.ok(occupant, 'a current pane is presence even when its session transcript has gone quiet');
  assert.equal(occupant.name, 'Project agent');
  assert.equal(occupant.state, 'idle');
  assert.equal(occupant.execution.evidence.level, 'verified');
  assert.equal(projected.kpis.find(row => row.id === 'active').value, 0);

  const closedPane = projectOfficeTeamOccupants(base, { ...snapshot, agents: [] }, admin, { sourceEnabled: true, runtimeAgents });
  assert.deepEqual(closedPane.occupants, base.occupants, 'a closed pane cannot keep a dynamic runtime agent on stage');
  const stalePane = projectOfficeTeamOccupants(base, { ...snapshot, agents: [{ ...host, staleAfter: 20 }] }, admin, { sourceEnabled: true, runtimeAgents });
  assert.deepEqual(stalePane.occupants, base.occupants, 'an expired Herdr observation is not live process presence');
});

test('added team occupants never inherit the primary summary and reject chat identifiers', () => {
  const primarySummary = 'PRIMARY_CONVERSATION_CANARY';
  const office = { occupants: [{ id: 'primary', role: 'primary', name: 'PM', summary: primarySummary, state: 'idle', stateSince: 10,
    stationUid: null, look: { character: 'fox', variant: null, accessories: [] }, ruleId: 'main', destination: null,
    sessionKey: 'pm-session', tokens: 10, lastSeenAt: 10, execution: { status: 'idle', evidence: { level: 'verified', observedAt: 10, expiresAt: 90 } } }],
  kpis: [{ id: 'active', value: 0, sub: { key: 'kpi.idle' } }, { id: 'subagents', value: 0, sub: null }] };
  const key = 'session:member-builder';
  const snapshot = { observedAt: 20, privateMemberSessionKeys: { 'member:pm': 'pm-session', 'member:builder': key }, members: [
    { id: 'member:pm', name: 'PM', roleKind: 'lead', roleLabel: 'pm', hostAgentId: 'pane-pm' },
    { id: 'member:builder', name: 'builder', roleKind: 'member', roleLabel: 'builder', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [
    { id: 'pane-pm', role: 'primary', status: 'idle', observedAt: 10, staleAfter: 90 },
    { id: 'pane-builder', role: 'delegate', status: 'working', observedAt: 10, staleAfter: 90 },
  ], identityLinks: [] };
  const pmSession = { key: 'pm-session', class: { kind: 'conversation', agentId: 'pm-agent' }, run: { status: 'idle', evidenceLevel: 'verified' } };
  const cases = [primarySummary, `Task references ${primarySummary} for context`, 'Follow up with 123456789012345678',
    'discord-user:123456789012345678', 'User id: 123456789012345678', 'sample_handle user id:9999999999999', 'Reply to <@123456789012345678>'];
  for (const summary of cases) {
    const session = { key, class: { kind: 'conversation', agentId: 'builder-agent' }, run: { status: 'running', evidenceLevel: 'verified' },
      usage: { total: 12 }, updatedAt: 19, summary };
    const projected = projectOfficeTeamOccupants(office, snapshot, admin, { sourceEnabled: true, runtimeSessions: [pmSession, session], canReadSessions: true });
    const member = projected.occupants.find(row => row.name === 'builder');
    assert.ok(member, 'the registered member is still visible');
    assert.equal(member.summary, undefined, `unsafe member summary is omitted: ${summary}`);
  }
  const own = { key, class: { kind: 'conversation', agentId: 'builder-agent' }, run: { status: 'running', evidenceLevel: 'verified' },
    usage: { total: 12 }, updatedAt: 19, summary: 'Prepare the adapter regression' };
  const projected = projectOfficeTeamOccupants(office, snapshot, admin, { sourceEnabled: true, runtimeSessions: [pmSession, own], canReadSessions: true });
  const serialized = JSON.stringify(projected);
  assert.equal(projected.occupants.find(row => row.name === 'builder').summary, undefined,
    'team-member transcript summaries are omitted even when they belong to the exact member session');
  assert.equal(serialized.includes(own.summary), false);
});

test('session identity renames only the exact matching runtime row and keeps an unmatched sibling visible', () => {
  const keyA = 'session:member-a', keyB = 'session:unmatched-b';
  const office = { occupants: [
    { id: 'primary', role: 'primary', name: 'PM', state: 'idle', stateSince: 10, stationUid: null,
      look: { character: 'fox', variant: null, accessories: [] }, ruleId: 'main', destination: null, sessionKey: 'pm', tokens: 0,
      lastSeenAt: 10, execution: { status: 'idle', evidence: { level: 'verified', observedAt: 10, expiresAt: 90 } } },
    { id: 'agent:builder-agent', role: 'agent', name: 'Project · 2', state: 'working', stateSince: 15, stationUid: null,
      look: { character: 'fox', variant: null, accessories: [] }, ruleId: 'agent', destination: null, sessionKey: keyA, tokens: 22,
      lastSeenAt: 15, execution: { status: 'running', evidence: { level: 'verified', observedAt: 15, expiresAt: 90 } } },
  ], kpis: [{ id: 'active', value: 1, sub: { key: 'kpi.onStage', params: { n: 2 } } }, { id: 'subagents', value: 0, sub: null }] };
  const snapshot = { observedAt: 20, privateMemberSessionKeys: { 'member:pm': 'pm', 'member:builder': keyA },
    privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'openclaw', sessionRef: 'pm-ref', sessionKey: 'pm' },
      'member:builder': { runtimeKind: 'codex', sessionRef: 'builder-ref', sessionKey: keyA } }, members: [
    { id: 'member:pm', name: 'PM', roleKind: 'lead', roleLabel: 'project lead', hostAgentId: 'pane-pm' },
    { id: 'member:builder', name: 'builder', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' },
  ], agents: [
    { id: 'pane-pm', role: 'primary', status: 'idle', observedAt: 10, staleAfter: 90 },
    { id: 'pane-builder', role: 'delegate', status: 'working', observedAt: 10, staleAfter: 90 },
  ], identityLinks: [] };
  const pm = { key: 'pm', class: { kind: 'conversation', agentId: 'pm-agent' }, run: { status: 'idle', evidenceLevel: 'verified' } };
  const a = { key: keyA, class: { kind: 'conversation', agentId: 'builder-agent' }, run: { status: 'running', evidenceLevel: 'verified' }, usage: { total: 22 } };
  const exact = projectOfficeTeamOccupants(office, snapshot, admin, { sourceEnabled: true, runtimeAgents: [{ id: 'primary-agent', isPrimary: true, mainSessionKey: 'pm' }, { id: 'builder-agent' }],
    primaryAgentId: 'primary-agent', runtimeIdentitySessions: [
      { agentId: 'primary-agent', sessionKey: 'pm', runtimeKind: 'openclaw', sessionRef: 'pm-ref' }, { agentId: 'builder-agent', sessionKey: keyA, runtimeKind: 'codex', sessionRef: 'builder-ref' }],
    runtimeSessions: [pm, a], canReadSessions: true });
  assert.equal(exact.occupants.length, 2);
  assert.equal(exact.occupants.filter(row => row.name === 'builder').length, 1);
  assert.equal(exact.occupants.find(row => row.name === 'builder').id, 'agent:builder-agent', 'public occupant identity is retained');
  const b = { ...a, key: keyB };
  const siblingOffice = { ...office, occupants: office.occupants.map(row => row.id === 'agent:builder-agent' ? { ...row, sessionKey: keyB } : row) };
  const sibling = projectOfficeTeamOccupants(siblingOffice, snapshot, admin, { sourceEnabled: true, runtimeAgents: [{ id: 'primary-agent', isPrimary: true, mainSessionKey: 'pm' }, { id: 'builder-agent' }],
    primaryAgentId: 'primary-agent', runtimeIdentitySessions: [
      { agentId: 'primary-agent', sessionKey: 'pm', runtimeKind: 'openclaw', sessionRef: 'pm-ref' }, { agentId: 'builder-agent', sessionKey: keyA, runtimeKind: 'codex', sessionRef: 'builder-ref' }],
    runtimeSessions: [pm, a, b], canReadSessions: true });
  assert.equal(sibling.occupants.some(row => row.id === 'agent:builder-agent' && row.sessionKey === keyB), true,
    'an agent aggregate backed by an unmatched sibling session is never deleted');
  assert.equal(sibling.occupants.filter(row => row.name === 'builder').length, 1,
    'the exact registered session still gets exactly one named row');
});

test('a Codex project aggregate folds into five exactly linked members after their individual session rows expire', () => {
  const keys = Array.from({ length: 5 }, (_, i) => `codex-session-${i + 1}`);
  const agentId = 'codex-project-group';
  const office = { occupants: [
    { id: 'primary', role: 'primary', name: 'PM', state: 'idle', stateSince: 10, stationUid: null,
      look: { character: 'fox', variant: null, accessories: [] }, ruleId: 'main', destination: null, sessionKey: 'pm-session', tokens: 0, lastSeenAt: 10 },
    // The 60-minute project agent outlives its 15-minute conversation rows.
    { id: `agent:${agentId}`, role: 'agent', name: 'agent-office-redesign', state: 'idle', stateSince: 10, stationUid: null,
      look: { character: 'fox', variant: null, accessories: [] }, ruleId: 'agent', destination: null, sessionKey: keys[0], tokens: 60, lastSeenAt: 10 },
  ], kpis: [{ id: 'active', value: 0, sub: null }, { id: 'subagents', value: 0, sub: null }] };
  const members = keys.map((key, i) => ({ id: `member:${i + 1}`, name: `Builder ${i + 1}`, roleKind: 'member',
    roleLabel: 'engineer', parentMemberId: null, hostAgentId: `pane:${i + 1}` }));
  const refs = [
    { agentId: 'primary-agent', sessionKey: 'pm-session', runtimeKind: 'openclaw', sessionRef: 'pm-ref' },
    ...keys.map((sessionKey, i) => ({ agentId, sessionKey, runtimeKind: 'codex', sessionRef: `member-ref-${i + 1}` })),
  ];
  const snapshot = { observedAt: 20, members, privateMemberSessionKeys: Object.fromEntries(keys.map((key, i) => [`member:${i + 1}`, key])),
    privateMemberSessionRefs: Object.fromEntries(keys.map((sessionKey, i) =>
    [`member:${i + 1}`, { runtimeKind: 'codex', sessionRef: `member-ref-${i + 1}`, sessionKey }])),
    agents: members.map((member, i) => ({ id: member.hostAgentId, role: 'delegate', status: 'working', observedAt: 19, staleAfter: 90 })), identityLinks: [] };
  const runtimeSessions = keys.map((key, i) => ({ key, class: { kind: 'conversation', agentId }, run: { status: 'running', evidenceLevel: 'verified' }, usage: { total: i + 1 } }));
  const out = projectOfficeTeamOccupants(office, snapshot, admin, { sourceEnabled: true, canReadSessions: true,
    runtimeAgents: [{ id: 'primary-agent', isPrimary: true, mainSessionKey: 'pm-session' }, { id: agentId, isPrimary: false, mainSessionKey: keys[0] }],
    primaryAgentId: 'primary-agent', runtimeIdentitySessions: refs, runtimeSessions });
  assert.equal(out.occupants.length, 6, 'one instance primary plus five registered team members remain');
  assert.equal(out.occupants.some(row => row.id === `agent:${agentId}` && row.name === 'agent-office-redesign'), false,
    'the duplicate project aggregate is consumed when its selected session is exactly registered');
  for (const member of members) assert.equal(out.occupants.filter(row => row.name === member.name).length, 1);
});

test('PM lead resolves by its own runtime session ref across OpenClaw, Claude Code, and Codex in v2 and v3', () => {
  const now = 1791768000000, pmKey = 'same-projected-session-key', childKey = 'rt:codex:session:connect-ux';
  for (const version of [2, 3]) {
    const primaryRole = version === 2 ? 'main' : 'primary';
    const sessionRole = version === 2 ? 'channel' : 'session';
    const look = { character: 'fox', variant: null, accessories: [] };
    const occupant = (id, role, name, sessionKey) => ({ id, role, name, state: 'working', stateSince: now,
      title: { key: 'sessionTitle.named', params: { name } }, roleLabel: { key: 'occupantRole.' + role },
      stationUid: null, look, ruleId: null, destination: null, sessionKey, tokens: 0, lastSeenAt: now,
      execution: { status: 'running', evidence: { level: 'verified', observedAt: now, expiresAt: now + 60_000 } } });
    const office = { connection: { gateway: 'up', since: now }, kpis: [
      { id: 'active', label: { key: 'kpi.active' }, value: 3, unit: 'count', sub: null },
      { id: 'subagents', label: { key: 'kpi.subagents' }, value: 0, unit: 'count', sub: null }],
        occupants: [occupant(primaryRole, primaryRole, 'OpenClaw primary', pmKey),
        { ...occupant('rt:claude-code:session:pm', sessionRole, 'Claude PM session', pmKey), parentId: 'agent:unrelated-runtime-parent' },
        { ...occupant(childKey, sessionRole, 'Session · Codex', childKey), parentId: 'agent:codex-project-agent' }], journal: [], layoutRevision: 1, queue: [] };
    const snapshot = { observedAt: now, privateMemberSessionKeys: { pm: pmKey, 'member:connect-ux': childKey },
      privateMemberSessionRefs: { pm: { runtimeKind: 'claude-code', sessionRef: 'claude-pm', sessionKey: pmKey },
        'member:connect-ux': { runtimeKind: 'codex', sessionRef: 'codex-connect-ux', sessionKey: childKey } },
      members: [{ id: 'pm', name: 'PM', roles: ['pm'], hostAgentId: 'pane-pm' },
        { id: 'member:connect-ux', name: 'connect-ux', roles: ['builder'], parentMemberId: 'pm', hostAgentId: 'pane-connect-ux' }],
      agents: [{ id: 'pane-pm', role: 'primary', status: 'working', observedAt: now, staleAfter: now + 60_000 },
        { id: 'pane-connect-ux', role: 'delegate', status: 'working', observedAt: now, staleAfter: now + 60_000 }], identityLinks: [] };
    const runtimeAgents = [{ id: 'openclaw-primary', isPrimary: true }, { id: 'claude-pm', isPrimary: false }, { id: 'codex-connect-ux', isPrimary: false }];
    const runtimeIdentitySessions = [
      { agentId: 'openclaw-primary', sessionKey: pmKey, runtimeKind: 'openclaw', sessionRef: 'oc-primary' },
      { agentId: 'claude-pm', sessionKey: pmKey, runtimeKind: 'claude-code', sessionRef: 'claude-pm' },
      { agentId: 'codex-connect-ux', sessionKey: childKey, runtimeKind: 'codex', sessionRef: 'codex-connect-ux' },
    ];
    const projected = projectOfficeTeamOccupants(office, snapshot, admin, { sourceEnabled: true, version, runtimeAgents,
      primaryAgentId: 'openclaw-primary', runtimeIdentitySessions, runtimeSessions: [
        { key: pmKey, class: { kind: 'conversation', agentId: 'claude-pm' }, run: { status: 'running', evidenceLevel: 'verified' } },
        { key: childKey, class: { kind: 'conversation', agentId: 'codex-connect-ux' }, run: { status: 'running', evidenceLevel: 'verified' } },
      ], canReadSessions: true });
    const pm = projected.occupants.find(row => row.name === 'PM');
    const child = projected.occupants.find(row => row.name === 'connect-ux');
    assert.equal(pm.id, 'rt:claude-code:session:pm', `v${version} PM reuses the Claude Code session, not the OpenClaw primary`);
    assert.equal(pm.role, 'agent', `v${version} a distinct team lead stays an agent, not a second primary`);
    assert.equal(projected.occupants.filter(row => row.role === primaryRole).length, 1,
      `v${version} preserves exactly the unrelated OpenClaw instance primary`);
    assert.equal(pm.parentId, null, `v${version} team lead explicitly clears the runtime-derived parent`);
    assert.equal(child.id, childKey, `v${version} connect-ux reuses its Codex session occupant`);
    assert.equal(child.parentId, pm.id, `v${version} Codex child is nested under the PM occupant`);
    assert.equal(child.teamId, snapshot.team?.id ?? null, `v${version} occupant carries authoritative team identity`);
    assert.equal(projected.occupants.some(row => row.name === 'OpenClaw primary'), true, `v${version} keeps the unrelated primary visible`);
    assert.equal(projected.occupants.some(row => row.name === 'Session · Codex'), false, `v${version} does not leave a duplicate Codex session`);
    const validation = validate(schemasFor(version).office, projected);
    assert.equal(validation.ok, true, `v${version} Office schema: ${JSON.stringify(validation.issues)}`);
  }
});

test('team board requires teams.read; report resolution is separately gated and bodies/paths never project', () => {
  const snapshot = { team: { id: 'team-1', label: 'build team', status: 'active', root: canary },
    members: [{ id: 'm1', name: 'builder', roleKind: 'member', roleLabel: 'builder', status: 'active', hostAgentId: 'ha', inboxBody: canary }],
    tasks: [{ id: 'task-1', title: 'Safe title', state: 'working', priority: 1, ownerMemberId: 'm1', reviewerMemberIds: [],
      reportPresent: true, reportRef: issueReportRef(), briefPresent: true, messageCount: 2,
      reportPath: canary, brief: canary, messages: canary }], revision: 5 };
  assert.throws(() => projectTeamBoard(snapshot, editor, { sourceEnabled: true }), { code: 'permission-denied' });
  assert.equal(projectTeamBoard(snapshot, admin), null, 'a disabled source publishes no board or existence');
  const board = projectTeamBoard(snapshot, admin, { sourceEnabled: true });
  assert.equal(board.tasks[0].reportPresent, true);
  assert.match(board.tasks[0].reportRef.id, /^rpt_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(board.tasks[0].reportRef.displayName, { key: 'team.report' });
  assert.equal(JSON.stringify(board).includes(canary), false);
  const branded = projectTeamBoard({ ...snapshot, members: [{ id: 'm1', name: 'builder', roleKind: 'member', roleLabel: 'builder', status: 'active', runtimeKind: 'codex' }] }, admin,
    { sourceEnabled: true, runtimeBrands: [{ id: 'codex', brand: { mark: 'CX', color: '#187b67', providerName: 'Codex', logo: 'assets/connectors/codex.svg' } }] });
  assert.deepEqual(branded.members[0].brand, { mark: 'CX', color: '#187b67', providerName: 'Codex', logo: 'assets/connectors/codex.svg' });
  const teamsOnly = { id: 'reader', role: 'custom', permissions: { teams: 'read' } };
  const noResolve = projectTeamBoard(snapshot, teamsOnly, { sourceEnabled: true });
  assert.equal(noResolve.tasks[0].reportPresent, true);
  assert.equal('reportRef' in noResolve.tasks[0], false);
  assert.equal(noResolve.members[0].hostAgentId, null, 'teams-only cannot resolve the private host pane reference');
  assert.equal('sessionStatus' in noResolve.members[0], false, 'teams-only cannot infer whether the live host session exists');
  const hostAndTeam = projectTeamBoard(snapshot, { id: 'both', role: 'custom', permissions: { teams: 'read', orchestrators: 'read' } }, { sourceEnabled: true });
  assert.equal(hostAndTeam.members[0].hostAgentId, 'ha');
  assert.equal(hostAndTeam.members[0].sessionStatus, 'unknown');
});

test('orchestrators-only readers keep registered panes as safe host rows without team metadata', () => {
  const snapshot = { hosts: [], orchestrators: [], agents: [
    { id: 'pane-pm', hostId: 'host-1', orchestratorId: 'herdr-1', name: 'Observed PM', runtimeKind: 'claude-code', role: 'primary', status: 'working', observedAt: 1, staleAfter: 2 },
    { id: 'pane-builder', hostId: 'host-1', orchestratorId: 'herdr-1', name: 'Observed Builder', runtimeKind: 'codex', role: 'delegate', status: 'idle', observedAt: 1, staleAfter: 2 },
  ], members: [{ id: 'private-member-id', name: 'Private PM', hostAgentId: 'pane-pm' }, { id: 'private-builder-id', name: 'Private Builder', hostAgentId: 'pane-builder' }], identityLinks: [] };
  const principal = { id: 'host-reader', role: 'custom', permissions: { orchestrators: 'read' } };
  const rows = projectOrchestrators(snapshot, principal, { sourceEnabled: true }).agents;
  assert.deepEqual(rows.map(row => row.id), ['pane-pm', 'pane-builder']);
  assert.equal(JSON.stringify(rows).includes('private-member-id'), false);
  assert.equal(JSON.stringify(rows).includes('Private PM'), false);
  assert.ok(rows.every(row => !('parentId' in row) && !('memberId' in row)));
});

test('a fresh non-team exact host addition validates against strict v2 and v3 Office schemas', () => {
  const now = 1791768000000;
  const host = { id: 'pane-coding-agent', role: 'delegate', status: 'working', observedAt: now, staleAfter: now + 60_000 };
  const snapshot = { observedAt: now, revision: 1, members: [], agents: [host], identityLinks: [
    { hostAgentId: host.id, agentId: 'runtime-coding-agent', confidence: 'exact', evidence: 'shared-runtime-session-ref' },
  ] };
  const principal = { id: 'orchestrator-reader', role: 'custom', permissions: { orchestrators: 'read' } };
  for (const version of [2, 3]) {
    const primary = version === 2 ? 'main' : 'primary';
    const office = { connection: { gateway: 'up', since: now }, kpis: [], occupants: [{ id: primary, role: primary, name: 'Primary',
      title: { key: 'occupantRole.main' }, roleLabel: { key: 'occupantRole.' + primary }, state: 'idle', stateSince: now,
      stationUid: null, look: { character: 'primary', variant: null, accessories: [] }, ruleId: null, destination: null,
      sessionKey: null, tokens: 0, lastSeenAt: null, execution: { status: 'idle', evidence: { level: 'verified', observedAt: now, expiresAt: now + 60_000 } } }],
      journal: [], layoutRevision: 1, queue: [] };
    const projected = projectOfficeTeamOccupants(office, snapshot, principal, { sourceEnabled: true, version,
      runtimeAgents: [{ id: 'runtime-coding-agent', isPrimary: false, spawnedBy: null }] });
    const freshHost = projected.occupants.find(row => row.id === 'agent:runtime-coding-agent');
    assert.ok(freshHost, `v${version} has the exact linked live host occupant`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `strict v${version} Office schema`);
    assert.equal('hostAgentId' in freshHost, version === 3);
    assert.equal('hostRole' in freshHost, version === 3);
    assert.equal('hostStatus' in freshHost, version === 3);
  }
});

test('unissued path and basename canaries in report ref fields never serialize, even with child permission', () => {
  const pathCanary = '/private/team/reports/secret.md';
  const basenameCanary = 'secret-review-report.md';
  const snapshot = { team: { id: 'team-1', label: 'team', status: 'active' }, members: [], revision: 1,
    tasks: [{ id: 'task-1', title: 'task', state: 'done', reviewerMemberIds: [], reportPresent: true, messageCount: 0,
      reportRef: { id: pathCanary, displayName: { key: basenameCanary, params: { path: pathCanary } } },
      reportPath: pathCanary, reportName: basenameCanary }] };
  const principal = { id: 'delegated', role: 'custom', permissions: { teams: 'read', 'teams.report.resolve': 'read' } };
  const json = JSON.stringify(projectTeamBoard(snapshot, principal, { sourceEnabled: true }));
  assert.equal(json.includes(pathCanary), false);
  assert.equal(json.includes(basenameCanary), false);
  assert.equal(json.includes('reportRef'), false);
});

test('principal and policy revisions separate cached snapshots; source revision alone is insufficient', () => {
  const base = { sourceId: 'team-source', sourceRevision: 8, registryRevision: 1 };
  assert.notEqual(projectionCacheKey({ ...base, principalId: 'u1', permissionRevision: 1 }), projectionCacheKey({ ...base, principalId: 'u2', permissionRevision: 1 }));
  assert.notEqual(projectionCacheKey({ ...base, principalId: 'u1', permissionRevision: 1 }), projectionCacheKey({ ...base, principalId: 'u1', permissionRevision: 2 }));
  assert.notEqual(projectionCacheKey({ ...base, principalId: 'u1', permissionRevision: 1 }), projectionCacheKey({ ...base, principalId: 'u1', permissionRevision: 1, registryRevision: 2 }));
});
