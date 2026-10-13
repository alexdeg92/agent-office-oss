'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture');
const { openSse } = require('../helpers/sse-client');
const { waitFor } = require('../helpers/harness');
const { createHerdrReader } = require('../../src/adapters/herdr/reader');
const { createTeamStoreReader } = require('../../src/adapters/agent-team-pm/store-reader');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots');
const { validate } = require('../../src/schema');
const { hashPassword } = require('../../src/security/password');

const people = ['pm', 'chars-b', 'chars-c', 'access-codex', 'office-codex', 'backend-codex', 'decor', 'critic', 'security', 'designer'];
const statuses = ['working', 'idle', 'done', 'blocked'];
const herdrOutput = () => Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: people.map((name, index) => ({
  pane_id: 'pane-' + index, agent: ['claude-code', 'codex', 'cursor'][index % 3], name, agent_status: statuses[index % statuses.length],
  agent_session: { value: `session-ref-${index}` },
})).concat([{ pane_id: 'pane-unregistered', agent: 'codex', name: 'Unregistered source-only worker', agent_status: 'idle' }]) } }));

describe('T-0045 · wired orchestrator/team projections', () => {
  let h;
  let activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 };
  let sessionsGrant = true;
  before(async () => {
    h = await settingsFixture({ sourcePrincipalFor: () => activePrincipal, sessionsReadable: () => sessionsGrant, orchestratorTeams: ({ tmp }) => {
      const root = path.join(tmp, 'synthetic-team');
      fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
      fs.mkdirSync(path.join(root, 'members'), { recursive: true });
      const memberIds = people.map((_person, index) => `member:${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
      people.forEach((person, index) => fs.writeFileSync(path.join(root, 'members', `${person}.json`), JSON.stringify({
        id: memberIds[index], name: person, role: index === 0 ? 'pm' : index >= 7 ? 'reviewer' : 'builder',
        runtime: ['claude-code', 'codex', 'cursor'][index % 3], herdrPane: `pane-${index}`,
        session: { source: `herdr:${['claude-code', 'codex', 'cursor'][index % 3]}`, kind: 'agent_session', value: `session-ref-${index}` },
        spawnedBy: index === 0 ? null : memberIds[0],
      })));
      people.forEach((person, index) => fs.writeFileSync(path.join(root, 'tasks', `T-${String(index + 1).padStart(4, '0')}.json`), JSON.stringify({
        id: `T-${String(index + 1).padStart(4, '0')}`, title: `Synthetic task for ${person}`, state: 'working', owner: person,
        prio: 1, brief: 'PRIVATE_BRIEF_CANARY', after: [], reviewers: ['critic', 'security', 'designer'], created_by: 'pm',
        created: '2026-10-10T20:00:00Z', updated: '2026-10-10T20:01:00Z', commit: null, report: '/synthetic/private/report.md',
        history: [], reviews: [{ ts: '2026-10-10T20:01:00Z', by: 'critic', verdict: 'go', note: 'PRIVATE_REVIEW_CANARY', report: '/synthetic/private/report.md' }],
      })));
      fs.writeFileSync(path.join(root, 'tasks', 'T-9999.json'), JSON.stringify({ id: 'T-9999', title: '', state: 'working' }));
      const herdr = createHerdrReader({ binaryPath: '/synthetic/herdr', hostId: 'host_fixture', orchestratorId: 'orchestrator_fixture',
        platform: 'container', label: 'Synthetic host', env: {}, supportsStableSessionRef: true,
        run: async (_binary, argv) => { assert.deepEqual(argv, ['agent', 'list']); return { stdout: herdrOutput() }; } });
      const teamStore = createTeamStoreReader({ root, label: 'Agent Office team', now: () => Date.parse('2026-10-10T20:02:00Z') });
      return createOrchestratorTeamSnapshots({ herdr, teamStore, now: () => Date.parse('2026-10-10T20:02:00Z') });
    } });
  });
  after(async () => { await h?.close(); });

  it('projects the synthetic PM team, runtime panes and board over v3 HTTP with private source fields removed', async () => {
    const hosts = await h.get('/api/v3/orchestrators');
    const teams = await h.get('/api/v3/teams');
    assert.equal(hosts.status, 200, hosts.text);
    assert.equal(teams.status, 200, teams.text);
    assert.equal(hosts.json.data.agents.length, 1, 'registered panes belong to the team projection; only unlinked observations remain in Herdr presence');
    assert.equal(hosts.json.data.agents[0].name, 'Unregistered source-only worker');
    assert.deepEqual(teams.json.data.members.map(x => x.name).sort(), [...people].sort());
    const codexMember = teams.json.data.members.find(member => member.runtimeKind === 'codex');
    assert.deepEqual({ providerName: codexMember.brand.providerName, logo: codexMember.brand.logo, logoDark: codexMember.brand.logoDark },
      { providerName: 'Codex', logo: 'assets/connectors/codex.svg', logoDark: 'assets/connectors/codex-dark.svg' },
      'inactive provider branding is supplied by its registered adapter without starting that runtime');
    assert.equal(teams.json.data.tasks.length, people.length);
    assert.deepEqual(teams.json.data.diagnostics, { skippedTaskCount: 1, skippedMemberCount: 0, skippedCount: 1,
      partialLabel: { key: 'team.board.partial', params: { count: 1 } }, quality: 'partial' }, 'the server provides the aggregate and localized banner label');
    assert.ok(teams.json.data.members.every(member => member.sessionStatus === 'known'));
    assert.ok(teams.json.data.tasks[0].reviews.length);
    assert.equal((await h.get('/api/v2/teams')).status, 404);
    const serialized = JSON.stringify([hosts.json.data, teams.json.data]);
    assert.equal(serialized.includes('PRIVATE_BRIEF_CANARY'), false);
    assert.equal(serialized.includes('PRIVATE_REVIEW_CANARY'), false);
    assert.equal(serialized.includes('/synthetic/private/report.md'), false);
    assert.ok(people.every(name => teams.json.data.members.some(member => member.name === name)));
    const office = await h.get('/api/v3/views/office');
    assert.equal(office.status, 200, office.text);
    const projectedMembers = office.json.data.occupants.filter(row => people.includes(row.name));
    assert.equal(projectedMembers.length, people.length, 'registered Herdr panes with no live runtime occupants still join the office');
    const executionByHerdrStatus = { working: 'running', idle: 'idle', done: 'succeeded', blocked: 'failed' };
    for (const occupant of projectedMembers) {
      const status = statuses[people.indexOf(occupant.name) % statuses.length];
      assert.equal(occupant.execution.status, executionByHerdrStatus[status], `${occupant.name} reflects Herdr status ${status}`);
      assert.equal(occupant.execution.evidence.level, 'verified');
      assert.ok(Number.isSafeInteger(occupant.execution.evidence.observedAt));
      assert.ok(occupant.execution.evidence.expiresAt > occupant.execution.evidence.observedAt, 'evidence lease expires with Herdr presence');
      assert.equal(occupant.state, ({ working: 'working', idle: 'idle', done: 'idle', blocked: 'blocked' })[status]);
    }
    const pm = projectedMembers.find(row => row.name === 'pm');
    assert.ok(pm);
    for (const member of projectedMembers.filter(row => row.name !== 'pm')) assert.equal(member.parentId, pm.id, member.name + ' grouped beneath PM');
    assert.equal(new Set(projectedMembers.map(row => row.id)).size, people.length, 'one stable office occupant per team member');
    const active = office.json.data.kpis.find(row => row.id === 'active');
    const subagents = office.json.data.kpis.find(row => row.id === 'subagents');
    assert.equal(active.value, office.json.data.occupants.filter(row => !['idle', 'offline'].includes(row.state)).length,
      'activity KPI counts the exact occupant set rendered in the office');
    assert.equal(active.sub.params.n, office.json.data.occupants.length, 'on-stage detail uses the same final occupant set');
    assert.equal(subagents.value, office.json.data.occupants.filter(row => row.role === 'subagent').length,
      'subagent KPI includes registered panes in the office projection');

    // The shipped Bureau page still reads the v2 OfficeVM. Optional source
    // enrichment must reach that route too or the owner sees no team grouping.
    const bureauOffice = await h.get('/api/v2/views/office');
    assert.equal(bureauOffice.status, 200, bureauOffice.text);
    const bureauMembers = bureauOffice.json.data.occupants.filter(row => people.includes(row.name));
    assert.equal(bureauMembers.length, people.length, 'the v2 Bureau API includes registered Herdr team members');
    const bureauPm = bureauMembers.find(row => row.name === 'pm');
    assert.ok(bureauPm);
    for (const member of bureauMembers.filter(row => row.name !== 'pm')) assert.equal(member.parentId, bureauPm.id, member.name + ' grouped beneath PM in the shipped Bureau API');
    const bureauIds = new Set(bureauOffice.json.data.occupants.map(row => row.id));
    for (const item of bureauOffice.json.data.rosterFloors.flatMap(floor => floor.items).filter(item => item.kind === 'occupant')) {
      assert.ok(bureauIds.has(item.occupantId), `floor roster references the projected v2 occupant ${item.occupantId}`);
    }
    assert.ok(bureauMembers.every(row => !('hostAgentId' in row) && !('hostStatus' in row)), 'the v2 contract omits the v3-only host annotation');
  });

  it('keeps shared occupant placement identical for admin and limited team readers', async () => {
    activePrincipal = { id: 'owner-placement-reader', role: 'admin', permissionRevision: 1 };
    sessionsGrant = true;
    try {
      const admin = await h.get('/api/v2/views/office');
      assert.equal(admin.status, 200, admin.text);
      const adminRows = new Map(admin.json.data.occupants.map(row => [row.id, row]));
      const revision = h.store.office.active(() => require('../../src/api/v2/vm/office').officeDefaults().layout).revision;
      const pinned = h.store.office.teamHomeAssignments(revision);
      assert.ok(Object.keys(pinned).length >= 1, 'the first full/admin path commits one durable team placement');
      activePrincipal = { id: 'placement-reader', role: 'reader', permissionRevision: 2,
        permissions: { teams: 'read', orchestrators: 'read' } };
      sessionsGrant = false;
      const reader = await h.get('/api/v2/views/office');
      assert.equal(reader.status, 200, reader.text);
      for (const row of reader.json.data.occupants) {
        const full = adminRows.get(row.id);
        if (!full) continue;
        assert.deepEqual({ floorId: row.floorId, stationUid: row.stationUid, standingPoint: row.standingPoint,
          homeTarget: row.homeTarget, sceneTarget: row.sceneTarget, activity: row.activity, sceneTravel: row.sceneTravel },
        { floorId: full.floorId, stationUid: full.stationUid, standingPoint: full.standingPoint,
          homeTarget: full.homeTarget, sceneTarget: full.sceneTarget, activity: full.activity, sceneTravel: full.sceneTravel },
        `${row.id} uses the same placement independent of sessions.read`);
      }
      const replay = await h.get('/api/v3/views/office');
      assert.equal(replay.status, 200, replay.text);
      for (const row of replay.json.data.occupants.filter(row => people.includes(row.name))) {
        const prior = [...adminRows.values()].find(candidate => candidate.name === row.name);
        assert.ok(prior);
        assert.deepEqual([row.floorId, row.stationUid], [prior.floorId, prior.stationUid], `${row.name} keeps the same home after v2→v3/admin/reader projections`);
      }
    } finally {
      activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 };
      sessionsGrant = true;
    }
  });

  it('keeps limited Office private when a reader requests Teams before the first Office view', async () => {
    let principal = { id: 'first-office-reader', role: 'reader', permissionRevision: 1, permissions: { office: 'read', teams: 'read' } };
    let mayReadSessions = false;
    const source = { detected: true, hasHerdr: true, hasTeamStore: true, enabled: true, start() {}, close() {}, onChange: () => () => {},
      getSnapshot: () => ({ observedAt: Date.now(), revision: 1, team: { id: 'team:first-reader', label: 'Synthetic team', status: 'active' },
        hosts: [], orchestrators: [], agents: [], identityLinks: [],
        members: [{ id: 'member:first-lead', name: 'Synthetic lead', roleKind: 'lead', status: 'active', runtimeKind: 'claude-code', parentMemberId: null, hostAgentId: null },
          { id: 'member:first-child', name: 'Synthetic child', roleKind: 'member', status: 'active', runtimeKind: 'codex', parentMemberId: 'member:first-lead', hostAgentId: null }],
        privateMemberSessionKeys: {}, privateMemberSessionRefs: {}, tasks: [], reviews: [] }) };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, sessionsReadable: () => mayReadSessions, orchestratorTeams: source });
    try {
      const at = Date.now(), privateKey = 'rt:codex:session:teams-first-private';
      const run = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
        expiresAt: at + 60_000, startedAt: at - 1_000, endedAt: null, hasActiveSubagentRun: false,
        runtimeMs: null, lastRunId: null, lastError: null };
      const ingested = fixture.engine.ingestCanonical('sessions.snapshot', [{ key: privateKey, sessionId: 'native-private',
        class: { kind: 'conversation', ruleId: 'private-fixture', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null },
        displayName: 'PRIVATE_OFFICE_SCOPE_TITLE', summary: 'PRIVATE_OFFICE_SCOPE_SUMMARY', model: null, provider: null,
        usage: { total: 0, input: null, output: null }, updatedAt: at, run, costUsd: null, parentKey: null, childKeys: [],
        goal: null, cwd: null, messageCount: 1, interactive: true, group: null }]);
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      const teamsFirst = await fixture.get('/api/v3/teams');
      assert.equal(teamsFirst.status, 200, teamsFirst.text);
      const limited = await fixture.get('/api/v2/views/office');
      assert.equal(limited.status, 200, limited.text);
      assert.equal(JSON.stringify(limited.json.data).includes('PRIVATE_OFFICE_SCOPE_'), false,
        'a prior team-view request cannot cause limited Office to reuse transcript-derived fields');
      principal = { id: 'full-office-admin', role: 'admin', permissionRevision: 2 };
      mayReadSessions = true;
      const full = await fixture.get('/api/v2/views/office');
      assert.equal(full.status, 200, full.text);
      const fullById = new Map(full.json.data.occupants.map(row => [row.id, row]));
      for (const row of limited.json.data.occupants) {
        const expected = fullById.get(row.id);
        if (!expected) continue;
        assert.deepEqual([row.floorId, row.stationUid, row.homeTarget, row.sceneTarget, row.activity, row.sceneTravel],
          [expected.floorId, expected.stationUid, expected.homeTarget, expected.sceneTarget, expected.activity, expected.sceneTravel],
          `${row.id} was planned from the same population even before a full OfficeVM cache existed`);
      }
    } finally { await fixture.close(); }
  });

  it('uses the private canonical placement graph for session-only team members in full and limited Office routes', async () => {
    const at = Date.now(), sessionKey = 'rt:codex:session:limited-member';
    let mayReadSessions = false;
    const principal = () => ({ id: 'limited-placement-reader', role: 'admin', permissionRevision: 1,
      permissions: { logs: mayReadSessions ? 'read' : 'none' } });
    const snapshot = { hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 1, observedAt: at,
      agents: [], identityLinks: [], team: { id: 'team:limited-session', name: 'Synthetic team' },
      members: [
        { id: 'member:limited-lead', name: 'PM', roleKind: 'lead', parentMemberId: null, hostAgentId: null },
        { id: 'member:limited-builder', name: 'Builder', roleKind: 'member', parentMemberId: 'member:limited-lead', hostAgentId: null },
      ], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0 } };
    Object.defineProperties(snapshot, {
      privateMemberSessionKeys: { enumerable: false, value: { 'member:limited-builder': sessionKey } },
      privateMemberSessionRefs: { enumerable: false, value: { 'member:limited-builder': {
        runtimeKind: 'codex', sessionRef: 'native-limited-builder', sessionKey,
      } } },
    });
    const source = { detected: false, hasHerdr: false, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {}, getSnapshot: () => snapshot };
    const fixture = await settingsFixture({
      sourcePrincipalFor: principal,
      sessionsReadable: () => mayReadSessions, orchestratorTeams: source,
    });
    try {
      const run = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
        expiresAt: at + 60_000, startedAt: at - 1_000, endedAt: null, hasActiveSubagentRun: false,
        runtimeMs: null, lastRunId: null, lastError: null };
      const ingested = fixture.engine.ingestCanonical('sessions.snapshot', [{ key: sessionKey, sessionId: 'native-limited-builder',
        class: { kind: 'conversation', ruleId: 'synthetic', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null },
        displayName: null, summary: null, model: null, provider: null, usage: { total: 0, input: null, output: null },
        updatedAt: at, run, costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null,
        interactive: true, group: null }]);
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      const limitedByVersion = new Map();
      for (const version of [2, 3]) {
        const limited = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(limited.status, 200, limited.text);
        const limitedMembers = limited.json.data.occupants.filter(row => row.name === 'Builder');
        assert.equal(limitedMembers.length, 1, `v${version} limited Office contains one registered member`);
        assert.ok(limitedMembers[0].stationUid, `v${version} limited identity receives the planned seat`);
        assert.equal(limitedMembers[0].sceneTarget.stationUid, limitedMembers[0].stationUid);
        assert.equal(JSON.stringify(limited.json.data).includes(sessionKey), false, 'private session identity never enters limited JSON');
        assert.equal(validate(require('../../src/api/v2/vm/schemas').schemasFor(version).office, limited.json.data).ok, true);
        limitedByVersion.set(version, limitedMembers[0]);
      }

      mayReadSessions = true;
      for (const version of [2, 3]) {
        const full = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(full.status, 200, full.text);
        const fullMembers = full.json.data.occupants.filter(row => row.name === 'Builder');
        assert.equal(fullMembers.length, 1, `v${version} full Office contains the member once`);
        assert.ok(fullMembers[0].stationUid, `v${version} full projection plans the registered session-only member`);
        assert.equal(fullMembers[0].stationUid, limitedByVersion.get(version).stationUid,
          `v${version} full and limited Office keep the same seat`);
        assert.equal(fullMembers[0].sceneTarget.stationUid, fullMembers[0].stationUid);
      }
    } finally { await fixture.close(); }
  });

  it('keeps an identity-only registered member in both mounted OfficeVM versions and reports a malformed peer', async () => {
    const fixture = await settingsFixture({ sourcePrincipalFor: () => ({ id: 'identity-only-owner', role: 'admin', permissionRevision: 1 }), orchestratorTeams: ({ tmp }) => {
      const root = path.join(tmp, 'sparse-team');
      for (const dir of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'members', 'connect-ux.json'), JSON.stringify({ id: 'member:cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'connect-ux' }));
      fs.writeFileSync(path.join(root, 'members', 'malformed.json'), JSON.stringify({ id: 'bad', name: 'Malformed' }));
      const herdr = createHerdrReader({ binaryPath: '/synthetic/herdr', hostId: 'host_sparse', orchestratorId: 'orchestrator_sparse',
        platform: 'container', label: 'Synthetic host', env: {}, supportsStableSessionRef: true,
        run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'empty', result: { type: 'ok', agents: [] } })) }) });
      const teamStore = createTeamStoreReader({ root, label: 'Synthetic team', now: () => Date.parse('2026-10-10T20:02:00Z') });
      return createOrchestratorTeamSnapshots({ herdr, teamStore, now: () => Date.parse('2026-10-10T20:02:00Z') });
    } });
    try {
      await fixture.orchestratorTeams.refresh();
      const board = await fixture.get('/api/v3/teams');
      assert.equal(board.status, 200, board.text);
      assert.deepEqual(board.json.data.diagnostics, { skippedTaskCount: 0, skippedMemberCount: 1, skippedCount: 1,
        partialLabel: { key: 'team.board.partial', params: { count: 1 } }, quality: 'partial' });
      assert.deepEqual(board.json.data.members.map(row => row.name), ['connect-ux']);
      for (const version of [2, 3]) {
        const office = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(office.status, 200, office.text);
        assert.ok(office.json.data.occupants.some(row => row.name === 'connect-ux'), `v${version} keeps the identity-only member`);
      }
    } finally { await fixture.close(); }
  });

  it('preserves registered Herdr rows for orchestrators-only readers and redacts cross-resource links for teams-only readers', async () => {
    activePrincipal = { id: 'host-reader-fixture', role: 'reader', permissionRevision: 10, permissions: { orchestrators: 'read' } };
    try {
      const hostOnly = await h.get('/api/v3/orchestrators');
      assert.equal(hostOnly.status, 200, hostOnly.text);
      assert.equal(hostOnly.json.data.agents.length, people.length + 1, 'registered panes remain available in their authorized host resource');
      assert.ok(hostOnly.json.data.agents.every(row => !('memberId' in row) && !('parentId' in row)));
      assert.equal(JSON.stringify(hostOnly.json.data).includes('member:'), false, 'host rows contain no team identity keys');
      assert.equal((await h.get('/api/v3/views/office')).status, 200, 'the base office remains available without either optional resource');
    } finally { activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 }; }

    activePrincipal = { id: 'team-reader-fixture', role: 'reader', permissionRevision: 11, permissions: { teams: 'read' } };
    try {
      const teamOnly = await h.get('/api/v3/teams');
      assert.equal(teamOnly.status, 200, teamOnly.text);
      assert.ok(teamOnly.json.data.members.every(row => row.hostAgentId === null && !('sessionStatus' in row)),
        'teams-only gets neither host identity nor live session existence');
    } finally { activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 }; }
  });

  it('does not disclose either collection to scoped agent credentials or when sources are disabled', async () => {
    const scoped = h.store.tokens.create({ agentId: 'atlas', scope: 'projects-agent' });
    const agentRead = await h.request('GET', '/api/v3/teams', undefined, { authorization: 'Bearer ' + scoped.token });
    assert.ok([403, 404].includes(agentRead.status), 'agent-scoped credentials cannot read team rows');
    const empty = await settingsFixture();
    try {
      assert.equal((await empty.get('/api/v3/orchestrators')).status, 404);
      assert.equal((await empty.get('/api/v3/teams')).status, 404);
    } finally { await empty.close(); }
  });

  it('denies a Lecteur without resource grants on both HTTP and a previously issued SSE topic', async () => {
    const adminBoard = await h.get('/api/v3/teams');
    assert.equal(adminBoard.status, 200);
    const scopedTopic = adminBoard.json.meta.topic.id;
    activePrincipal = { id: 'reader-fixture', role: 'reader', permissionRevision: 8, permissions: {} };
    const deniedHttp = await h.get('/api/v3/teams');
    assert.equal(deniedHttp.status, 403);
    assert.equal(deniedHttp.json.error.code, 'forbidden');
    try {
      for (const version of [2, 3]) {
        const foreignOfficeScope = scopedTopic.replace(/^teams:/, 'office-scope:');
        const stream = openSse(h.base, `/api/v${version}/stream?topics=` + encodeURIComponent(foreignOfficeScope), { cookie: h.cookie });
        try {
          const response = await stream.opened;
          assert.equal(response.statusCode, 403, `v${version} rejects another principal's issued scope before a snapshot`);
        } finally { stream.close(); }
      }
    } finally { activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 }; }
  });

  it('honors the effective per-resource grant rather than elevating a human role', async () => {
    activePrincipal = { id: 'reader-with-team-grant', role: 'reader', permissionRevision: 9, permissions: { teams: 'read' } };
    try {
      assert.equal((await h.get('/api/v3/teams')).status, 200);
      const denied = await h.get('/api/v3/orchestrators');
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error.code, 'forbidden');
    } finally { activePrincipal = { id: 'owner-fixture', role: 'admin', permissionRevision: 1 }; }
  });

  it('uses the same projected snapshots for v3 SSE and invalidates after a reader refresh', async () => {
    const teamTopic = (await h.get('/api/v3/teams')).json.meta.topic.id;
    const hostTopic = (await h.get('/api/v3/orchestrators')).json.meta.topic.id;
    const stream = openSse(h.base, '/api/v3/stream?topics=' + encodeURIComponent([hostTopic, teamTopic].join(',')), { cookie: h.cookie });
    try {
      await stream.next(event => event.event === 'hello');
      const firstTeam = await stream.next(event => event.data?.topic === teamTopic);
      const firstHosts = await stream.next(event => event.data?.topic === hostTopic);
      assert.equal(firstTeam.data.data.members.length, people.length);
    assert.equal(firstHosts.data.data.agents.length, 1, 'SSE uses the same registered-member de-duplication projection');
      const taskPath = path.join(h.tmp, 'synthetic-team', 'tasks', 'T-0001.json');
      const changed = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      changed.state = 'review'; fs.writeFileSync(taskPath, JSON.stringify(changed));
      await h.orchestratorTeams.refresh();
      const update = await stream.next(event => event.data?.topic === teamTopic && event.data.rev > firstTeam.data.rev);
      assert.ok(update.data.ops || update.data.data);
      await waitFor(async () => (await h.get('/api/v3/teams')).json.data.tasks.some(task => task.state === 'review'));
    } finally { stream.close(); }
  });

  it('projects an exact Herdr link onto only the existing, authorized OfficeVM occupant', async () => {
    let principal = { id: 'owner-link-fixture', role: 'admin', permissionRevision: 1 };
    const source = {
      hasHerdr: true, hasTeamStore: false, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {},
      getSnapshot: () => ({ hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 0, observedAt: Date.now(),
        agents: [
          { id: 'host-pane-1', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'Scribe', runtimeKind: 'claude-code',
            role: 'delegate', status: 'waiting', observedAt: Date.now(), staleAfter: Date.now() + 60_000 },
          { id: 'host-pane-2', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'Waiting pane', runtimeKind: 'codex',
            role: 'delegate', status: 'waiting', observedAt: Date.now(), staleAfter: Date.now() + 60_000 },
        ],
        identityLinks: [{ hostAgentId: 'host-pane-1', agentId: 'runtime-main', evidence: 'shared-runtime-session-ref', confidence: 'exact' }],
        team: null, members: [], tasks: [], reviews: [] }),
    };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, sessionsReadable: () => true, orchestratorTeams: source });
    try {
      fixture.engine.ingestCanonical('agents', [{ id: 'runtime-main', name: 'Scribe', workspace: null, model: null, fallbackModels: [], isPrimary: true,
        mainSessionKey: 'private-runtime-ref', hostObservations: [] }]);
      const hosts = await fixture.get('/api/v3/orchestrators');
      assert.equal(hosts.status, 200, hosts.text);
      assert.equal(hosts.json.data.agents.length, 1, 'the linked observation is not repeated while the unlinked pane remains visible');
      assert.equal(hosts.json.data.agents[0].status, 'waiting', 'host VM preserves its canonical waiting state');
      const office = await fixture.get('/api/v3/views/office');
      assert.equal(office.status, 200, office.text);
      const occupants = office.json.data.occupants;
      const annotated = occupants.filter(row => row.hostAgentId === 'host-pane-1');
      assert.equal(annotated.length, 1, 'the exact link annotates one existing occupant');
      assert.deepEqual({ id: annotated[0].hostAgentId, role: annotated[0].hostRole, status: annotated[0].hostStatus, state: annotated[0].state },
        { id: 'host-pane-1', role: 'delegate', status: 'waiting', state: 'waiting' });
      const v2Office = await fixture.get('/api/v2/views/office');
      assert.equal(v2Office.status, 200, v2Office.text);
      assert.equal(office.json.meta.topic.id, 'office', 'the API keeps the logical office topic while the server scopes its projection');
      principal = { id: 'reader-link-fixture', role: 'reader', permissionRevision: 2, permissions: {} };
      const readerOffice = await fixture.get('/api/v3/views/office');
      assert.equal(readerOffice.status, 200, readerOffice.text);
      assert.equal(readerOffice.json.data.occupants.length, occupants.length, 'Herdr observations never create runtime occupants');
      assert.equal('hostStatus' in readerOffice.json.data.occupants[0], false);
      assert.equal('hostAgentId' in readerOffice.json.data.occupants[0], false);
    } finally { await fixture.close(); }
  });

  it('serves the scoped OfficeVM through both API versions with RBAC HTTP projection enabled', async () => {
    const principal = { id: 'owner-secure-office', role: 'admin', permissionRevision: 1 };
    const at = Date.now();
    const source = {
      detected: true, hasHerdr: true, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {},
      getSnapshot: () => ({ hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 1, observedAt: at,
        agents: [
          { id: 'host-pm', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'PM', runtimeKind: 'claude-code', role: 'delegate', status: 'working', observedAt: at, staleAfter: at + 60_000 },
          { id: 'host-builder', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'Builder', runtimeKind: 'codex', role: 'delegate', status: 'waiting', observedAt: at, staleAfter: at + 60_000 },
        ], identityLinks: [],
        team: { id: 'team-fixture', label: 'PM team', status: 'active' },
        members: [
          { id: 'member:pm-fixture', name: 'PM', roleKind: 'lead', roleLabel: 'pm', status: 'active', runtimeKind: 'claude-code', hostAgentId: 'host-pm', parentMemberId: null },
          { id: 'member:builder-fixture', name: 'Builder', roleKind: 'member', roleLabel: 'builder', status: 'active', runtimeKind: 'codex', hostAgentId: 'host-builder', parentMemberId: 'member:pm-fixture' },
        ], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0 } }),
    };
    const fixture = await settingsFixture({ enforceAuthorization: true, sourcePrincipalFor: () => principal,
      sessionsReadable: () => true, orchestratorTeams: source });
    try {
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        assert.equal(response.json.meta.topic.id, 'office');
        const rows = response.json.data.occupants.filter(row => ['PM', 'Builder'].includes(row.name));
        assert.equal(rows.length, 2);
        const pm = rows.find(row => row.name === 'PM');
        const builder = rows.find(row => row.name === 'Builder');
        assert.equal(builder.parentId, pm.id);
        assert.equal(builder.state, 'waiting', `live host-reported waiting reaches v${version} OfficeVM`);
        if (version === 2) assert.ok(rows.every(row => !('hostAgentId' in row) && !('hostStatus' in row)));
      }
      const stream = openSse(fixture.base, '/api/v2/stream?topics=office', { cookie: fixture.cookie });
      try {
        const snapshot = await stream.next(event => event.data?.topic === 'office');
        const rows = snapshot.data.data.occupants.filter(row => ['PM', 'Builder'].includes(row.name));
        assert.equal(rows.length, 2, 'the v2 Bureau stream uses the same scoped team projection as HTTP');
        assert.equal(rows.find(row => row.name === 'Builder').parentId, rows.find(row => row.name === 'PM').id);
      } finally { stream.close(); }
    } finally { await fixture.close(); }
  });

  it('redacts chat account IDs from team member names and title params in mounted v2/v3 Office', async () => {
    const at = Date.now();
    const principal = { id: 'owner-chat-name-fixture', role: 'admin', permissionRevision: 1 };
    const source = { detected: true, hasHerdr: true, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {},
      getSnapshot: () => ({ hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 1, observedAt: at,
        agents: [{ id: 'host-chat-name', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'synthetic pane',
          runtimeKind: 'codex', role: 'delegate', status: 'idle', observedAt: at, staleAfter: at + 60_000 }], identityLinks: [],
        team: { id: 'team-fixture', label: 'Fixture team', status: 'active' },
        members: [{ id: 'member:chat-name', name: 'fixture_handle 123456789012345678', roleKind: 'member', roleLabel: 'builder', status: 'active',
          runtimeKind: 'codex', hostAgentId: 'host-chat-name', parentMemberId: null }], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0 } }) };
    const fixture = await settingsFixture({ enforceAuthorization: true, sourcePrincipalFor: () => principal,
      sessionsReadable: () => true, orchestratorTeams: source });
    try {
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        const member = response.json.data.occupants.find(row => row.id === 'team-member:member:chat-name');
        assert.ok(member, `v${version} includes the registered team member`);
        assert.equal(member.name, 'Conversation');
        assert.equal(member.title.params.name, 'Conversation');
        const serialized = JSON.stringify(response.json.data);
        assert.equal(serialized.includes('fixture_handle'), false);
        assert.equal(serialized.includes('123456789012345678'), false);
      }
    } finally { await fixture.close(); }
  });

  it('uses default signed-cookie RBAC Logs grants for scoped Office session fields in v2/v3', async () => {
    const at = Date.now(), sessionKey = 'rt:openclaw:session:private-team-title', sessionRef = 'private-session-ref';
    const canary = 'PRIVATE_SESSION_TITLE_CANARY';
    const member = { id: 'member:private-title', name: 'Safe team lead', roleKind: 'lead', roleLabel: 'lead', status: 'active',
      runtimeKind: 'openclaw', hostAgentId: null, parentMemberId: null };
    const snapshot = { hosts: [], orchestrators: [], agents: [], identityLinks: [],
      observedAt: at, revision: 1, team: { id: 'team:private-title', label: 'Synthetic team', status: 'active' },
      members: [member], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0 } };
    Object.defineProperty(snapshot, 'privateMemberSessionKeys', { enumerable: false, value: { [member.id]: sessionKey } });
    Object.defineProperty(snapshot, 'privateMemberSessionRefs', { enumerable: false, value: { [member.id]: {
      runtimeKind: 'openclaw', sessionRef, sessionKey, agentId: 'private-title-runtime' } } });
    const source = { detected: false, hasHerdr: false, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {}, getSnapshot: () => snapshot };
    const fixture = await settingsFixture({ enforceAuthorization: true, orchestratorTeams: source });
    try {
      assert.equal(fixture.engine.ingestCanonical('agents', [{ id: 'private-title-runtime', name: 'Safe runtime', displayName: 'Safe runtime',
        workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: sessionKey }]).ok, true);
      const run = { status: 'idle', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
        expiresAt: null, startedAt: at - 1000, endedAt: at, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null };
      assert.equal(fixture.engine.ingestCanonical('sessions.snapshot', [{ key: sessionKey, sessionId: sessionRef,
        class: { kind: 'primary', ruleId: 'synthetic', agentId: 'private-title-runtime', channel: null, heartbeatOf: null,
          background: false, rawClassification: null }, displayName: canary, summarySource: 'runtime', summary: null, model: null, provider: 'openclaw',
        usage: { total: 0, input: null, output: null }, updatedAt: at, run, costUsd: null, parentKey: null, childKeys: [], goal: null,
        cwd: null, messageCount: null, interactive: true, group: null }]).ok, true);
      fixture.engine.setIdentitySessionRefs([{ sessionKey, sessionRef, agentId: 'private-title-runtime' }]);
      const ownerCookie = fixture.cookie;
      const reader = fixture.store.userManagement.invite({ name: 'Synthetic reader', email: 'reader-t0113@example.invalid', roleId: 'rol_reader' },
        { userId: fixture.store.users.owner().id, authGeneration: fixture.store.users.owner().auth_generation, requestId: 'req_t0113_invite', authorize: () => {} });
      fixture.store.userManagement.accept({ token: reader.token, purpose: 'invite', passwordHash: await hashPassword('synthetic-t0113-password') },
        { userId: fixture.store.users.owner().id, authGeneration: fixture.store.users.owner().auth_generation, requestId: 'req_t0113_accept', authorize: () => {} });
      const readerUser = fixture.store.users.byId(reader.user.id);
      fixture.cookie = 'taco_sess=' + fixture.auth.signSession({ email: readerUser.email, userId: readerUser.id,
        authGeneration: readerUser.auth_generation, sid: 'synthetic-t0113-reader', exp: Date.now() + 60_000 });
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.stringify(response.json.data).includes(canary), false, `v${version} omits private runtime titles without sessions.read`);
        const primary = response.json.data.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
        assert.ok(primary);
        assert.notEqual(primary.name, canary);
        assert.notEqual(primary.title?.params?.name, canary);
        assert.equal(primary.sessionKey, null);
      }
      const role = fixture.store.rbac.role('rol_reader');
      fixture.store.userManagement.editRole('rol_reader', { expectedRevision: role.revision, permissions: [{ resource: 'logs', level: 'read' }] },
        { userId: fixture.store.users.owner().id, authGeneration: fixture.store.users.owner().auth_generation, requestId: 'req_t0113_logs_on', authorize: () => {} });
      assert.equal(fixture.store.policy.can(fixture.store.users.byId(reader.user.id), 'logs', 'read'), true, 'role edit grants Logs read');
      assert.equal((await fixture.get('/api/v3/me')).json.data.permissions.logs, 'read', 'signed-in account sees current effective Logs grant');
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.stringify(response.json.data).includes(canary), false,
          `v${version} never puts transcript-derived session titles in Office`);
        const primary = response.json.data.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
        assert.equal(primary.sessionKey, sessionKey);
      }
      const grantedRole = fixture.store.rbac.role('rol_reader');
      fixture.store.userManagement.editRole('rol_reader', { expectedRevision: grantedRole.revision, permissions: [{ resource: 'logs', level: 'none' }] },
        { userId: fixture.store.users.owner().id, authGeneration: fixture.store.users.owner().auth_generation, requestId: 'req_t0113_logs_off', authorize: () => {} });
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.stringify(response.json.data).includes(canary), false, `v${version} drops title after Logs read is removed`);
        const primary = response.json.data.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
        assert.equal(primary.sessionKey, null, `v${version} drops session identity after Logs read is removed`);
      }
      fixture.cookie = ownerCookie;
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.stringify(response.json.data).includes(canary), true, `v${version} preserves the owner legacy-cookie grant`);
      }
    } finally { await fixture.close(); }
  });

  it('serves an exact non-team host addition through both strict Office contracts', async () => {
    const at = Date.now();
    const principal = { id: 'orchestrator-only-reader', role: 'custom', permissions: { orchestrators: 'read' }, permissionRevision: 1 };
    const source = { detected: true, hasHerdr: true, hasTeamStore: false, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {},
      getSnapshot: () => ({ hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 0, observedAt: at,
        agents: [{ id: 'pane-live', hostId: 'host-fixture', orchestratorId: 'herdr-fixture', name: 'Live coding agent',
          runtimeKind: 'codex', role: 'delegate', status: 'working', observedAt: at, staleAfter: at + 60_000 }],
        identityLinks: [{ hostAgentId: 'pane-live', agentId: 'runtime-coding-agent', confidence: 'exact', evidence: 'shared-runtime-session-ref' }],
        team: null, members: [], tasks: [], reviews: [] }) };
    const fixture = await settingsFixture({ enforceAuthorization: true, sourcePrincipalFor: () => principal,
      sessionsReadable: () => true, orchestratorTeams: source });
    try {
      fixture.engine.ingestCanonical('agents', [{ id: 'runtime-coding-agent', name: 'Live coding agent', displayName: 'Live coding agent',
        workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null }]);
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        const addition = response.json.data.occupants.find(row => row.id === 'agent:runtime-coding-agent');
        assert.ok(addition, `v${version} projects the fresh exact host addition`);
        assert.equal('hostAgentId' in addition, version === 3);
        assert.equal('hostRole' in addition, version === 3);
        assert.equal('hostStatus' in addition, version === 3);
      }
    } finally { await fixture.close(); }
  });

  it('keeps exact mixed-runtime team grouping through mounted office routes when Herdr has no host observations', async () => {
    const at = Date.now();
    let principal = { id: 'owner-herdr-offline', role: 'admin', permissionRevision: 1 };
    const pmKey = 'rt:claude-code:session:pm-offline';
    const builderKey = 'rt:codex:session:builder-offline';
    const memberIds = { pm: 'member:offline-pm', builder: 'member:offline-builder' };
    const snapshot = { hosts: [], orchestrators: [], revision: 1, hostRevision: 2, teamRevision: 1, observedAt: at,
      agents: [], identityLinks: [], team: { id: 'team:offline-fixture', name: 'Synthetic team' },
      members: [
        { id: memberIds.pm, name: 'PM', runtimeKind: 'claude-code', roleKind: 'lead', parentMemberId: null, hostAgentId: null },
        { id: memberIds.builder, name: 'Builder', runtimeKind: 'codex', roleKind: 'member', parentMemberId: memberIds.pm, hostAgentId: null },
      ], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0 } };
    Object.defineProperties(snapshot, {
      privateMemberSessionKeys: { enumerable: false, value: { [memberIds.pm]: pmKey, [memberIds.builder]: builderKey } },
      privateMemberSessionRefs: { enumerable: false, value: {
        [memberIds.pm]: { runtimeKind: 'claude-code', sessionRef: 'claude-session-pm', sessionKey: pmKey, agentId: 'claude-primary' },
        [memberIds.builder]: { runtimeKind: 'codex', sessionRef: 'codex-session-builder', sessionKey: builderKey, agentId: 'codex-worker' },
      } },
    });
    const source = { detected: false, hasHerdr: false, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {}, getSnapshot: () => snapshot };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, sessionsReadable: () => true, orchestratorTeams: source });
    try {
      const agentsIngested = fixture.engine.ingestCanonical('agents', [
        { id: 'claude-primary', name: 'Runtime lead', displayName: 'Runtime lead', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: pmKey },
        { id: 'codex-worker', name: 'Runtime worker', displayName: 'Runtime worker', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: builderKey },
      ]);
      assert.equal(agentsIngested.ok, true, JSON.stringify(agentsIngested));
      const run = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
        expiresAt: at + 60_000, startedAt: at - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null };
      const canonicalSession = (key, sessionId, kind, agentId) => ({ key, sessionId,
        class: { kind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null },
        displayName: null, summary: null, model: null, provider: null, usage: { total: 0, input: null, output: null },
        updatedAt: at, run, costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null,
        interactive: true, group: null });
      const sessionsIngested = fixture.engine.ingestCanonical('sessions.snapshot', [
        canonicalSession(pmKey, 'claude-session-pm', 'primary', 'claude-primary'),
        canonicalSession(builderKey, 'codex-session-builder', 'conversation', 'codex-worker'),
      ]);
      assert.equal(sessionsIngested.ok, true, JSON.stringify(sessionsIngested));
      assert.ok(fixture.engine.sessions().some(row => row.key === builderKey), 'the synthetic exact runtime session reaches the engine');
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        const occupants = response.json.data.occupants;
        const pm = occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
        const builder = occupants.find(row => row.name === 'Builder');
        assert.ok(pm, `v${version} projects the team lead from the store without a Herdr row`);
        assert.equal(pm.name, 'Runtime lead', `v${version} preserves the configured primary display name`);
        assert.ok(builder, `v${version} projects the registered Codex member without a Herdr row`);
        assert.equal(builder.parentId, pm.id, `v${version} membership parent does not depend on host availability`);
        assert.equal(builder.state, 'working', `v${version} retains the fresh runtime evidence`);
        assert.equal(builder.summary, undefined, 'session-derived summaries remain hidden when not readable');
        assert.ok(builder.stationUid, `v${version} plans the final exact-session-folded occupant id onto a desk`);
        assert.equal(builder.sceneTarget?.stationUid, builder.stationUid,
          `v${version} scene intent targets the folded occupant's allocated desk`);
        assert.notEqual(builder.stationUid, pm.stationUid, `v${version} does not allocate the lead's desk twice`);
        assert.equal(validate(require('../../src/api/v2/vm/schemas').schemasFor(version).office, response.json.data).ok, true,
          `v${version} mounted OfficeVM validates`);
        const serialized = JSON.stringify(response.json.data);
        assert.equal(serialized.includes('claude-session-pm'), false, 'native session references remain private');
        assert.equal(serialized.includes('codex-session-builder'), false, 'native session references remain private');
      }
      // Production regression: with sessions.read on, both the admin's full
      // runtime-session path and an ordinary authorized reader must receive
      // the same server-owned team tree and floor assignment.
      const adminProjection = new Map();
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        adminProjection.set(version, response.json.data.occupants.map(row => ({
          name: row.name, id: row.id, parentId: row.parentId || null, teamId: row.teamId || null,
          floorId: row.floorId || null, stationUid: row.stationUid || null, order: row.order ?? null,
        })));
      }
      principal = { id: 'reader-with-all-projection-grants', role: 'custom', permissionRevision: 2,
        permissions: { office: 'read', sessions: 'read', teams: 'read', orchestrators: 'read' } };
      for (const version of [2, 3]) {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        const rows = response.json.data.occupants.map(row => ({
          name: row.name, id: row.id, parentId: row.parentId || null, teamId: row.teamId || null,
          floorId: row.floorId || null, stationUid: row.stationUid || null, order: row.order ?? null,
        }));
        assert.deepEqual(rows, adminProjection.get(version), `v${version} parent/team/floor/order are independent of admin role when sessions.read is granted`);
        const pm = rows.find(row => row.id === (version === 2 ? 'main' : 'primary')), builder = rows.find(row => row.name === 'Builder');
        assert.ok(pm && builder, `v${version} retains the runtime-backed registered team rows: ${JSON.stringify(rows)}`);
        assert.equal(builder.parentId, pm.id, `v${version} attaches the runtime-backed builder under its team lead`);
      }
      for (const version of [2, 3]) {
        const stream = openSse(fixture.base, `/api/v${version}/stream?topics=office`, { cookie: fixture.cookie });
        try {
          const frame = await stream.next(event => event.data?.topic === 'office');
          const occupants = frame.data.data.occupants;
          const pm = occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
          const builder = occupants.find(row => row.name === 'Builder');
          assert.ok(pm && builder, `v${version} SSE projects registered members without a Herdr reader`);
          assert.equal(builder.parentId, pm.id, `v${version} SSE preserves the team parent`);
          assert.equal(validate(require('../../src/api/v2/vm/schemas').schemasFor(version).office, frame.data.data).ok, true,
            `v${version} streamed OfficeVM validates`);
        } finally { stream.close(); }
      }
    } finally { await fixture.close(); }
  });

  it('keeps a runtime-backed team tree identical for admin and sessions.read readers', async () => {
    const at = Date.now();
    let principal = { id: 'owner-session-team', role: 'admin', permissionRevision: 1 };
    const memberRows = Array.from({ length: 6 }, (_, index) => ({
      id: `member:session-team-${index}`, name: index === 0 ? 'Lead' : `Builder ${index}`,
      roleKind: index === 0 ? 'lead' : 'member', parentMemberId: index === 0 ? null : 'member:session-team-0',
      runtimeKind: index === 0 ? 'claude-code' : 'codex', hostAgentId: null,
    }));
    const sessionKeys = memberRows.map((_member, index) => `rt:${index === 0 ? 'claude' : 'codex'}:session:team-${index}`);
    const sessionRefs = memberRows.map((_member, index) => `native-session-${index}`);
    const snapshot = { observedAt: at, revision: 1, hosts: [], orchestrators: [], agents: [], identityLinks: [],
      team: { id: 'team:session-backed', label: 'Session-backed team', status: 'active' },
      members: memberRows, tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0 } };
    Object.defineProperties(snapshot, {
      privateMemberSessionKeys: { enumerable: false, value: Object.fromEntries(memberRows.map((member, index) => [member.id, sessionKeys[index]])) },
      privateMemberSessionRefs: { enumerable: false, value: Object.fromEntries(memberRows.map((member, index) => [member.id, {
        runtimeKind: index === 0 ? 'openclaw' : 'openclaw', sessionRef: sessionRefs[index], sessionKey: sessionKeys[index],
        agentId: index === 0 ? 'team-primary' : `project-${index}`,
      }])) },
    });
    const source = { detected: false, hasHerdr: false, hasTeamStore: true, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {}, getSnapshot: () => snapshot };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, sessionsReadable: () => true, orchestratorTeams: source });
    try {
      const agents = [
        { id: 'team-primary', name: 'Runtime lead', displayName: 'Runtime lead', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: sessionKeys[0] },
        ...memberRows.slice(1).map((_member, index) => ({ id: `project-${index + 1}`, name: `Project ${index + 1}`,
          displayName: `Project ${index + 1}`, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: sessionKeys[index + 1] })),
      ];
      assert.equal(fixture.engine.ingestCanonical('agents', agents).ok, true);
      const observedAt = at - 20 * 60 * 1000;
      const run = { status: 'idle', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt,
        expiresAt: at + 30 * 60 * 1000, startedAt: observedAt - 60_000, endedAt: observedAt, hasActiveSubagentRun: false,
        runtimeMs: null, lastRunId: null, lastError: null };
      const sessions = sessionKeys.map((key, index) => ({ key, sessionId: sessionRefs[index],
        class: { kind: index === 0 ? 'primary' : 'conversation', ruleId: 'synthetic', agentId: index === 0 ? 'team-primary' : `project-${index}`,
          channel: null, heartbeatOf: null, background: false, rawClassification: null },
        displayName: null, summary: null, model: null, provider: null, usage: { total: 0, input: null, output: null },
        updatedAt: observedAt, run, costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null,
        interactive: true, group: null }));
      const sessionIngestion = fixture.engine.ingestCanonical('sessions.snapshot', sessions);
      assert.equal(sessionIngestion.ok, true, JSON.stringify(sessionIngestion));
      fixture.engine.setIdentitySessionRefs(sessionKeys.map((sessionKey, index) => ({ sessionKey, sessionRef: sessionRefs[index],
        agentId: index === 0 ? 'team-primary' : `project-${index}` })));

      const officeRows = async (version) => {
        const response = await fixture.get(`/api/v${version}/views/office`);
        assert.equal(response.status, 200, response.text);
        const data = response.json.data;
        return { occupants: data.occupants.map(row => ({ name: row.name, id: row.id, role: row.role,
          parentId: row.parentId || null, teamId: row.teamId || null, floorId: row.floorId || null,
          stationUid: row.stationUid || null, state: row.state })),
          rosterFloors: data.rosterFloors.map(floor => ({ id: floor.id, items: floor.items.map(item => ({ kind: item.kind,
            occupantId: item.occupantId || null, teamId: item.teamId || null, depth: item.depth ?? null })) })) };
      };
      for (const version of [2, 3]) {
        const adminRows = await officeRows(version);
        principal = { id: 'reader-session-team', role: 'custom', permissionRevision: 2,
          permissions: { office: 'read', sessions: 'read', teams: 'read', orchestrators: 'read' } };
        const readerRows = await officeRows(version);
        assert.deepEqual(readerRows, adminRows, `v${version} session-visible team occupants have identical parent/floor/order placement across principals`);
        assert.equal(readerRows.occupants.length, memberRows.length, `v${version} has one on-stage row per project agent, with old session occupants omitted`);
        const lead = readerRows.occupants.find(row => row.name === 'Runtime lead');
        assert.ok(lead, `v${version} lead remains the primary team row`);
        for (const member of readerRows.occupants.filter(row => row.name.startsWith('Builder '))) {
          assert.equal(member.parentId, lead.id, `v${version} keeps ${member.name} under the canonical lead`);
          assert.equal(member.teamId, 'team:session-backed');
        }
        principal = { id: 'owner-session-team', role: 'admin', permissionRevision: 1 };
      }
    } finally { await fixture.close(); }
  });

  it('keeps newer mounted OfficeVM evidence when v3 exact-link annotation sees an older host status', async () => {
    const at = Date.now();
    const principal = { id: 'owner-evidence-order', role: 'admin', permissionRevision: 1 };
    const host = { id: 'pane-runtime-coding-agent', hostId: 'host-fixture', orchestratorId: 'herdr-fixture',
      name: 'Primary agent', runtimeKind: 'openclaw', role: 'primary', status: 'done', observedAt: at - 10_000, staleAfter: at + 60_000 };
    const source = { detected: true, hasHerdr: true, hasTeamStore: false, enabled: true,
      start() {}, close() {}, refresh: async () => {}, onChange: () => () => {},
      getSnapshot: () => ({ hosts: [], orchestrators: [], revision: 1, hostRevision: 1, teamRevision: 0, observedAt: Date.now(),
        agents: [host],
        identityLinks: [{ hostAgentId: 'pane-runtime-coding-agent', agentId: 'atlas',
          evidence: 'shared-runtime-session-ref', confidence: 'exact' }],
        team: null, members: [], tasks: [], reviews: [] }) };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, sessionsReadable: () => true, orchestratorTeams: source });
    try {
      const v2 = await fixture.get('/api/v2/views/office');
      assert.equal(v2.status, 200, v2.text);
      const baseline = v2.json.data.occupants.find(occupant => occupant.role === 'main');
      assert.ok(baseline, 'v2 retains the primary runtime occupant');
      assert.equal(baseline.execution.evidence.level, 'verified', 'the test starts with fresh runtime evidence');
      // Make the stale host report disagree with the current runtime result so
      // the v3 annotation cannot accidentally pass by matching its status.
      host.observedAt = baseline.execution.evidence.observedAt - 1000;
      host.staleAfter = Date.now() + 60_000;
      host.status = baseline.state === 'working' ? 'done' : 'working';
      fixture.api.topics.invalidate('office-scope');
      const v3 = await fixture.get('/api/v3/views/office');
      assert.equal(v3.status, 200, v3.text);
      const projected = v3.json.data.occupants.find(occupant => occupant.role === 'primary');
      assert.ok(projected, 'v3 retains the same linked primary occupant');
      assert.equal(projected.state, baseline.state, 'v3 annotation preserves the newer runtime state over contradictory host status');
      assert.deepEqual(projected.execution, baseline.execution, 'v2/v3 retain the same newer runtime evidence');
      assert.equal(validate(require('../../src/api/v2/vm/schemas').schemasFor(2).office, v2.json.data).ok, true, 'v2 mounted OfficeVM remains schema-valid');
      assert.equal(validate(require('../../src/api/v2/vm/schemas').schemasFor(3).office, v3.json.data).ok, true, 'v3 mounted OfficeVM remains schema-valid');
    } finally { await fixture.close(); }
  });

  it('broadcasts cues to authorized logical full-office streams and excludes limited Office streams', async () => {
    const source = { detected: true, hasHerdr: true, hasTeamStore: false, enabled: true,
      start() {}, close() {}, onChange: () => () => {}, getSnapshot: () => ({ hosts: [], orchestrators: [], agents: [], identityLinks: [], team: null, members: [], tasks: [], reviews: [], observedAt: Date.now() }) };
    const full = await settingsFixture({ sourcePrincipalFor: () => ({ id: 'cue-full', role: 'admin', permissionRevision: 1 }), sessionsReadable: () => true, orchestratorTeams: source });
    const limited = await settingsFixture({ sourcePrincipalFor: () => ({ id: 'cue-limited', role: 'admin', permissionRevision: 1 }), sessionsReadable: () => false, orchestratorTeams: source });
    const fullStream = openSse(full.base, '/api/v2/stream?topics=office', { cookie: full.cookie });
    const limitedStream = openSse(limited.base, '/api/v2/stream?topics=office', { cookie: limited.cookie });
    try {
      await fullStream.next(event => event.data?.topic === 'office');
      await limitedStream.next(event => event.data?.topic === 'office');
      const cue = { occupantId: 'primary', kind: 'subagent.spawn', at: Date.now() };
      full.api.hubs[2].broadcastOffice(cue);
      const received = await fullStream.next(event => event.event === 'cue');
      assert.equal(received.event, 'cue');
      await assert.rejects(limitedStream.next(event => event.event === 'cue', 250), /no matching frame/);
    } finally { fullStream.close(); limitedStream.close(); await full.close(); await limited.close(); }
  });

  it('offers the opt-in office hint only to administrators when the orchestrator is detected but disabled', async () => {
    let principal = { id: 'owner-herdr-off', role: 'admin', permissionRevision: 1 };
    const source = { detected: true, hasHerdr: false, hasTeamStore: false, start() {}, close() {}, onChange: () => () => {}, getSnapshot: () => null };
    const fixture = await settingsFixture({ sourcePrincipalFor: () => principal, orchestratorTeams: source });
    try {
      const ownerOffice = await fixture.get('/api/v2/views/office');
      assert.equal(ownerOffice.status, 200, ownerOffice.text);
      assert.equal(ownerOffice.json.data.orchestratorActivationAvailable, true);
      principal = { id: 'reader-herdr-off', role: 'reader', permissionRevision: 2, permissions: { office: 'read' } };
      const readerOffice = await fixture.get('/api/v2/views/office');
      assert.equal(readerOffice.status, 200, readerOffice.text);
      assert.equal('orchestratorActivationAvailable' in readerOffice.json.data, false);
    } finally { await fixture.close(); }
  });
});
