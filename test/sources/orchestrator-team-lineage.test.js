'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectSnapshot } = require('../../src/adapters/agent-team-pm/store-reader');
const { parseSnapshot } = require('../../src/adapters/herdr/reader');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots');
const { projectOrchestrators, projectTeamBoard, projectOfficeOccupant } = require('../../src/api/orchestrator-team-projection');
const { scopedId } = require('../../src/runtime-ids');

const admin = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 };
const IDs = Object.freeze({ pm: 'member:11111111-1111-4111-8111-111111111111', builder: 'member:22222222-2222-4222-8222-222222222222',
  critic: 'member:33333333-3333-4333-8333-333333333333' });

test('Claude PM, Codex builder, and Cursor critic join by stable member IDs and exact session/pane refs without duplicate occupants', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-mixed-team-lineage-'));
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.promises.mkdir(path.join(root, directory));
    const records = [
      { id: IDs.pm, name: 'pm', role: 'pm', runtime: 'claude-code', herdrPane: 'pane-pm', session: { source: 'herdr:claude', kind: 'agent_session', value: 'session-pm' }, spawnedBy: null },
      { id: IDs.builder, name: 'builder', role: 'builder', runtime: 'codex', herdrPane: 'pane-builder', session: { source: 'herdr:codex', kind: 'agent_session', value: 'old-session-builder' }, spawnedBy: IDs.pm },
      { id: IDs.critic, name: 'critic', role: 'reviewer', runtime: 'cursor', herdrPane: 'pane-critic', session: { source: 'herdr:cursor', kind: 'agent_session', value: 'session-critic' }, spawnedBy: IDs.pm },
    ];
    for (const row of records) await fs.promises.writeFile(path.join(root, 'members', `${row.name}.json`), JSON.stringify(row), { mode: 0o600 });
    const at = Date.UTC(2026, 9, 11);
    const teamStore = { start() {}, stop() {}, refresh: async () => projectSnapshot({ root, now: () => at }) };
    const herdr = { start() {}, stop() {}, refresh: async () => parseSnapshot(Buffer.from(JSON.stringify({ id: 'synthetic', result: { type: 'ok', agents: [
      { pane_id: 'pane-pm', agent: 'claude-code', name: 'PM', agent_status: 'working', agent_session: { value: 'session-pm' } },
      { pane_id: 'pane-builder', agent: 'codex', name: 'Builder', agent_status: 'working', agent_session: { value: 'session-builder' } },
      { pane_id: 'pane-critic', agent: 'cursor', name: 'Critic', agent_status: 'working', agent_session: { value: 'session-critic' } },
    ] } })), { hostId: 'host_local', orchestratorId: 'herdr_local', observedAt: at, supportsStableSessionRef: true }) };
    const team = createOrchestratorTeamSnapshots({ herdr, teamStore, now: () => at,
      runtimeIdentitySessions: () => records.map((row, index) => ({ agentId: ['rt:claude-code:agent:pm', 'rt:codex:agent:builder', 'rt:cursor:agent:critic'][index],
        sessionKey: scopedId(['claude-code', 'codex', 'cursor'][index], 'session', ['pm', 'builder', 'critic'][index]),
        hostId: 'host_local', runtimeKind: ['claude-code', 'codex', 'cursor'][index], sessionRef: index === 1 ? 'session-builder' : row.session.value })) });
    const snapshot = await team.refresh();
    const pmSessionKey = scopedId('claude-code', 'session', 'pm');
    assert.equal(snapshot.identityLinks.length, 3);
    assert.deepEqual(snapshot.members.map(row => row.id).sort(), Object.values(IDs).sort());
    assert.deepEqual(snapshot.members.map(row => row.hostAgentId).filter(Boolean).length, 3, 'each stable record links to its exact Herdr pane');
    const builder = snapshot.members.find(row => row.id === IDs.builder);
    const critic = snapshot.members.find(row => row.id === IDs.critic);
    assert.deepEqual(snapshot.privateMemberSessionRefs[IDs.pm], { runtimeKind: 'claude-code', sessionRef: 'session-pm', sessionKey: pmSessionKey,
      agentId: 'rt:claude-code:agent:pm' });
    assert.deepEqual(snapshot.privateMemberSessionRefs[IDs.builder], { runtimeKind: 'codex', sessionRef: 'session-builder',
      sessionKey: scopedId('codex', 'session', 'builder'), agentId: 'rt:codex:agent:builder' });
    assert.equal(Object.keys(snapshot).includes('privateMemberSessionRefs'), false, 'runtime session refs stay non-enumerable/private');
    assert.equal(builder.parentMemberId, IDs.pm);
    assert.equal(critic.parentMemberId, IDs.pm);
    assert.equal(builder.sessionStatus, 'unknown', 'a stale member session reference leaves the registered member visible and explicitly unknown');
    assert.equal(critic.sessionStatus, 'known');
    assert.deepEqual(builder.spawnedBy, { agentId: null, sessionKey: pmSessionKey, via: 'orchestrator', label: null });
    assert.deepEqual(critic.spawnedBy, builder.spawnedBy, 'spawnedBy member ID resolves through the PM record, not member names');
    assert.equal(snapshot.agents.find(row => row.id === builder.hostAgentId).spawnedBy.sessionKey, pmSessionKey);

    const herdrProjection = projectOrchestrators(snapshot, admin, { sourceEnabled: true, runtimeAgents: records.map((row, i) => ({
      id: ['rt:claude-code:agent:pm', 'rt:codex:agent:builder', 'rt:cursor:agent:critic'][i],
      isPrimary: i === 0,
    })) });
    const board = projectTeamBoard(snapshot, admin, { sourceEnabled: true });
    assert.equal(herdrProjection.agents.length, 0, 'member-linked and runtime-linked Herdr observations are represented once by the team/runtime occupants');
    assert.equal(board.members.length, 3, 'the mixed-runtime team has one board row per stable member');
    assert.deepEqual(Object.fromEntries(board.members.map(row => [row.name, row.runtimeKind])), {
      pm: 'claude-code', builder: 'codex', critic: 'cursor',
    }, 'runtime identity comes from stable member records and is canonicalized with the member');
    assert.equal(board.members.find(row => row.id === IDs.builder).parentMemberId, IDs.pm,
      'the board carries only the opaque stable parent member link for UI grouping');
    assert.equal(board.members.find(row => row.id === IDs.builder).sessionStatus, 'unknown');
    assert.deepEqual(board.members.find(row => row.id === IDs.builder).spawnedBy,
      { agentId: null, sessionKey: pmSessionKey, via: 'orchestrator', label: null });
    const occupants = records.map((row, i) => ({ id: i === 0 ? 'primary' : 'agent:' + ['rt:claude-code:agent:pm', 'rt:codex:agent:builder', 'rt:cursor:agent:critic'][i],
      name: row.name, role: i === 0 ? 'primary' : 'agent' }));
    const linkedByHost = new Map(snapshot.identityLinks.map(link => [link.hostAgentId, link]));
    const projectedOccupants = occupants.map(occupant => {
      const link = snapshot.identityLinks.find(row => row.agentId === (occupant.id === 'primary' ? 'rt:claude-code:agent:pm' : occupant.id.slice(6)));
      const host = snapshot.agents.find(row => row.id === link.hostAgentId);
      const parent = host.spawnedBy?.sessionKey === pmSessionKey ? 'primary' : null;
      return projectOfficeOccupant(occupant, host, linkedByHost.get(host.id), admin,
        { sourceEnabled: true, agentId: link.agentId, parentOccupantId: parent });
    });
    assert.equal(projectedOccupants.length, 3);
    assert.equal(projectedOccupants.filter(row => row.id === 'agent:rt:codex:agent:builder').length, 1);
    assert.equal(projectedOccupants.find(row => row.id === 'agent:rt:codex:agent:builder').parentId, 'primary');
    assert.equal(projectedOccupants.find(row => row.id === 'agent:rt:cursor:agent:critic').parentId, 'primary');
    assert.equal(JSON.stringify([snapshot, herdrProjection, board, projectedOccupants]).includes('session-pm'), false);
    team.close();
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('registered Claude and Codex session refs remain joinable when the Herdr reader is unavailable', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-offline-herdr-team-'));
  const pmId = 'member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const builderId = 'member:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.promises.mkdir(path.join(root, directory));
    const members = [
      { id: pmId, name: 'PM', role: 'lead', runtime: 'claude-code', herdrPane: 'pane-pm',
        session: { source: 'herdr:claude', kind: 'agent_session', value: 'claude-pm-session' }, spawnedBy: null },
      { id: builderId, name: 'Builder', role: 'member', runtime: 'codex', herdrPane: 'pane-builder',
        session: { source: 'herdr:codex', kind: 'agent_session', value: 'codex-builder-session' }, spawnedBy: pmId },
    ];
    for (const row of members) await fs.promises.writeFile(path.join(root, 'members', `${row.name}.json`), JSON.stringify(row), { mode: 0o600 });
    const at = Date.UTC(2026, 9, 12);
    const runtimeRows = [
      { agentId: 'claude-primary', sessionKey: 'rt:claude-code:session:pm', runtimeKind: 'claude-code', sessionRef: 'claude-pm-session' },
      { agentId: 'codex-worker', sessionKey: 'rt:codex:session:builder', runtimeKind: 'codex', sessionRef: 'codex-builder-session' },
    ];
    const teamStore = { start() {}, stop() {}, refresh: async () => projectSnapshot({ root, now: () => at }) };
    const joined = createOrchestratorTeamSnapshots({ herdr: null, teamStore, now: () => at,
      runtimeIdentitySessions: () => runtimeRows });
    try {
      const snapshot = await joined.refresh();
      assert.deepEqual(snapshot.agents, [], 'an unavailable host source contributes no stale host rows');
      assert.deepEqual(snapshot.members.map(row => [row.id, row.parentMemberId, row.hostAgentId]).sort((a, b) => a[0].localeCompare(b[0])), [
        [pmId, null, null], [builderId, pmId, null],
      ].sort((a, b) => a[0].localeCompare(b[0])), 'the registered team graph survives without Herdr');
      assert.deepEqual(snapshot.privateMemberSessionRefs[pmId], { runtimeKind: 'claude-code', sessionRef: 'claude-pm-session', sessionKey: 'rt:claude-code:session:pm', agentId: 'claude-primary' });
      assert.deepEqual(snapshot.privateMemberSessionRefs[builderId], { runtimeKind: 'codex', sessionRef: 'codex-builder-session', sessionKey: 'rt:codex:session:builder', agentId: 'codex-worker' });
      assert.equal(Object.keys(snapshot).includes('privateMemberSessionRefs'), false, 'private exact join refs never become enumerable source data');
    } finally { joined.close(); }
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
