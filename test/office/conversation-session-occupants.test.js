'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfficeVM, createStateTracker, officeDefaults } = require('../../src/api/v2/vm/office');
const { projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');
const { projectOfficeTeamOccupants } = require('../../src/api/orchestrator-team-projection');
const { createEngine } = require('../../src/engine');
const { definition: claudeDefinition } = require('../../src/adapters/claude-code');
const frLabels = require('../../src/i18n/fr').LABELS;
const enLabels = require('../../src/i18n/en').LABELS;

const NOW = 1791740000000;
function project({ kind = 'conversation', channel = null, displayName = 'agent-office-redesign', summary = 'Fix the session title', activity = null, primaryOwner = true, peerName = null } = {}) {
  const session = { key: 'rt:claude-code:session:synthetic', displayName, summary, projectLabel: 'agent-office-redesign', cwd: '/workspace/agent-office-redesign', updatedAt: NOW,
    interactive: true, usage: { total: 0 }, tokensKnown: false,
    class: { kind, agentId: 'coding-agent', channel, heartbeatOf: null, interlocutorId: channel ? 'discord-user:synthetic-peer' : null, explicitKey: null },
    run: { status: 'running', evidence: 'live-activity', evidenceLevel: 'observed', observedAt: NOW, expiresAt: NOW + 30_000,
      startedAt: NOW - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null } };
  const agent = { id: 'coding-agent', name: 'Coding agent', displayName: 'Coding agent', workspace: null, model: null, fallbackModels: [], isPrimary: primaryOwner, mainSessionKey: primaryOwner ? session.key : null };
  const engine = { sessions: () => [session], session: key => key === session.key ? session : null, agents: () => [agent], primaryAgent: () => primaryOwner ? agent : null,
    gateway: () => ({ connected: true, since: NOW - 1000 }), runtimeFor: () => ({ connected: true, name: 'Claude Code' }), activity: key => key === session.key ? activity : null,
    cronJobs: () => [], host: () => null, liveEvents: () => [], transcript: () => null };
  const build = (P, canReadSessions = true, extra = {}) => buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions, configuredAgents: primaryOwner ? {} : { 'coding-agent': 'Coding agent' }, P,
    names: { agentName: () => null, interlocutorName: () => peerName }, actorOf: () => ({ kind: 'system', name: 'System' }), ...extra });
  return { session, engine, build };
}

test('generic conversation sessions preserve primary and configured agent roles in both contracts and read projections', () => {
  for (const [P, ownerRole] of [[project2x, 'main'], [project3x, 'primary']]) {
    for (const primaryOwner of [true, false]) {
      for (const canReadSessions of [true, false]) {
        const { build } = project({ primaryOwner });
        const vm = build(P, canReadSessions);
        const owner = vm.occupants.find(o => o.id === (primaryOwner ? ownerRole : 'agent:coding-agent'));
        assert.ok(owner, `${primaryOwner ? 'primary' : 'configured agent'} remains visible with canReadSessions=${canReadSessions}`);
        assert.equal(owner.role, primaryOwner ? ownerRole : 'agent');
        assert.notEqual(owner.role, 'session');
        if (!canReadSessions) assert.equal(vm.occupants.some(o => o.role === 'session'), false, 'session occupants remain filtered without the grant');
      }
    }
  }
});

test('coding sessions use identity/project labels and omit transcript text in both contracts', () => {
  assert.equal(frLabels['occupantRole.session'], 'Session · {provider}');
  assert.equal(enLabels['occupantRole.session'], 'Session · {provider}');
  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    const { build } = project();
    const vm = build(P), row = vm.occupants.find(o => o.id.includes('rt:claude-code:session:synthetic'));
    assert.ok(row, 'conversation remains a visible occupant');
    assert.equal(row.role, version === 2 ? 'channel' : 'session');
    assert.deepEqual(row.roleLabel, { key: 'occupantRole.session', params: { provider: 'Claude Code' } });
    assert.ok(row.name.startsWith('Coding agent'));
    assert.equal(row.project, 'agent-office-redesign');
    assert.equal(row.summary, undefined, 'the project is a secondary detail, not a duplicated activity summary');
    assert.notEqual(row.name, row.project);
    assert.equal(validate(schemasFor(version).office, vm).ok, true);
  }
});

test('recent project aggregate history is idle instead of unknown, then leaves after its presence window', () => {
  const source = project(), session = { ...source.session, class: { ...source.session.class, agentId: 'project-agent' },
    run: { status: 'unknown', evidence: 'none', evidenceLevel: 'unknown', observedAt: null, expiresAt: null },
    updatedAt: NOW - 30 * 60 * 1000 };
  const primary = { ...source.engine.agents()[0], mainSessionKey: null };
  const projectAgent = { id: 'project-agent', name: 'Project', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null };
  const engine = { ...source.engine, sessions: () => [session], session: key => key === session.key ? session : null,
    agents: () => [primary, projectAgent], primaryAgent: () => primary,
    runtimeFor: () => ({ connected: true, name: 'Codex' }) };
  const build = () => buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
    configuredAgents: {}, P: project3x,
    names: { agentName: () => null, interlocutorName: () => null }, actorOf: () => ({ kind: 'system', name: 'System' }) });
  const recent = build().occupants.find(row => row.id === 'agent:project-agent');
  assert.equal(recent?.state, 'idle', 'a recent project session is present but its stale run evidence is not Unknown');
  session.updatedAt = NOW - 2 * 60 * 60 * 1000;
  assert.equal(build().occupants.some(row => row.id === 'agent:project-agent'), false,
    'an aggregate with no remaining session inside the 60-minute window is not seated');
});

test('source-backed chat groups keep their channel role and coding sessions do not invent Waiting', () => {
  const chat = project({ kind: 'conversation-group', channel: 'discord', displayName: 'Release room', summary: null });
  const chatRow = chat.build(project2x).occupants.find(o => o.sessionKey === chat.session.key && o.role !== 'main');
  assert.equal(chatRow.role, 'channel');
  assert.equal(chatRow.roleLabel.key, 'occupantRole.channel');
  const coder = project();
  const row = coder.build(project3x).occupants.find(o => o.id.includes('rt:claude-code:session:synthetic'));
  assert.equal(row.state, 'working', 'only canonical source state determines the status');
  assert.notEqual(row.state, 'waiting');
});

test('session task summaries never become office occupant names', () => {
  const { build } = project({ displayName: 'agent-office-redesign', summary: 'Update the conversation title' });
  const row = build(project3x).occupants.find(o => o.id.includes('rt:claude-code:session:synthetic'));
  assert.ok(row.name.startsWith('Coding agent'));
  assert.equal(JSON.stringify(row).includes('Update the conversation title'), false);
});

test('only a runtime-provided session title may name a coding occupant', () => {
  const { build, session } = project({ primaryOwner: false, displayName: 'A user prompt must stay private', summary: 'A user prompt must stay private' });
  session.summarySource = 'transcript';
  const privateOffice = build(project3x);
  const privateRow = privateOffice.occupants.find(row => row.sessionKey === session.key && row.role === 'session');
  assert.notEqual(privateRow.name, 'A user prompt must stay private');
  assert.equal(JSON.stringify(privateOffice).includes('A user prompt must stay private'), false);

  session.displayName = 'A user-set session title';
  session.summary = null;
  session.summarySource = 'runtime';
  const titledOffice = build(project3x);
  const titledRow = titledOffice.occupants.find(row => row.sessionKey === session.key && row.role === 'session');
  assert.equal(titledRow.name, 'A user-set session title');
});

test('untitled coding sessions use agent identity before project/provider and never the role label', () => {
  const { build } = project({ displayName: 'agent-office-redesign', summary: null });
  for (const P of [project2x, project3x]) {
    const row = build(P).occupants.find(o => o.id.includes('rt:claude-code:session:synthetic'));
    assert.ok(row.name.startsWith('Coding agent'));
    assert.notEqual(row.name, 'Session');
    assert.notEqual(row.name, 'Channel');
    assert.notEqual(row.name, 'Conversation');
  }
});

test('chat titles redact raw identifiers and OfficeVM omits transcript summaries', () => {
  const chat = project({ kind: 'conversation', channel: 'discord', displayName: 'lulu_mimoumou user id:14694…',
    summary: 'lulu_mimoumou user id:14694…' });
  const row = chat.build(project3x).occupants.find(o => o.sessionKey === chat.session.key && o.role === 'conversation');
  assert.equal(row.name, 'Conversation', 'redacts raw chat identifiers when no display label is available');
  const occupants = chat.build(project3x).occupants;
  assert.equal(JSON.stringify(occupants).includes('14694'), false);
  assert.equal(JSON.stringify(occupants).includes('lulu_mimoumou'), false);
  assert.ok(occupants.every(item => item.summary === undefined), 'transcript summaries do not project into the office');
  const labeled = project({ kind: 'conversation', channel: 'discord', displayName: 'lulu_mimoumou user id:14694…',
    summary: 'lulu_mimoumou user id:14694…', peerName: 'Ada Lovelace' });
  const labeledRow = labeled.build(project3x).occupants.find(o => o.sessionKey === labeled.session.key && o.role === 'conversation');
  assert.ok(labeledRow.name.startsWith('Ada Lovelace'));
  assert.equal(JSON.stringify(labeledRow).includes('14694'), false);
  const rawLabel = project({ kind: 'conversation', channel: 'discord', displayName: 'lulu_mimoumou user id:14694…',
    summary: 'lulu_mimoumou user id:14694…', peerName: 'lulu_mimoumou user id:14694…' });
  const rawLabelRow = rawLabel.build(project3x).occupants.find(o => o.sessionKey === rawLabel.session.key && o.role === 'conversation');
  assert.equal(rawLabelRow.name, 'Conversation', 'a resolver result that is still an account identifier is not a display label');
  assert.equal(JSON.stringify(rawLabelRow).includes('14694'), false);

  for (const kind of ['conversation-direct', 'conversation-group', 'conversation']) {
    const embedded = project({ kind, channel: 'discord', displayName: 'fixture_handle 123456789012345678',
      summary: 'fixture_handle 123456789012345678' });
    for (const P of [project2x, project3x]) {
      const rows = embedded.build(P).occupants.filter(o => o.sessionKey === embedded.session.key);
      assert.ok(rows.length > 0);
      const chatRow = rows.find(row => row.sessionKey === embedded.session.key && !['main', 'primary', 'agent'].includes(row.role));
      assert.ok(chatRow, `${kind} has a chat occupant in v${P.version}`);
      assert.ok(!chatRow.name.includes('fixture_handle') && !chatRow.name.includes('123456789012345678'), `${kind} v${P.version} name was ${chatRow.name}`);
      assert.equal(chatRow.summary, undefined, `${kind} transcript summary is omitted in v${P.version}`);
      assert.equal(JSON.stringify(rows).includes('123456789012345678'), false);
      assert.equal(JSON.stringify(rows).includes('fixture_handle'), false);
    }
  }
});

test('OfficeVM never serializes primary or subagent prompt and CLI-notice summaries', () => {
  const privateText = 'PRIVATE_TASK_PROMPT: Verify the live office roster';
  const privateNotice = '[team] message from security: run team inbox';
  const main = { key: 'rt:main:session:one', displayName: null, summary: privateText, class: { kind: 'primary', agentId: 'atlas', heartbeatOf: null },
    interactive: true, usage: { total: 1 }, updatedAt: NOW, projectLabel: 'Synthetic Project', run: { status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } };
  const sub = { key: 'rt:main:session:delegate', displayName: null, summary: privateNotice, class: { kind: 'subagent', agentId: 'atlas', subagentId: 'delegate-1', heartbeatOf: null },
    interactive: true, usage: { total: 1 }, updatedAt: NOW, projectLabel: 'Synthetic Project', run: { status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } };
  const agent = { id: 'atlas', name: 'Atlas', displayName: 'Atlas', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: main.key };
  const sessions = [main, sub];
  const engine = { sessions: () => sessions, session: key => sessions.find(row => row.key === key) || null, agents: () => [agent], primaryAgent: () => agent,
    gateway: () => ({ connected: true, since: NOW - 1000 }), runtimeFor: () => ({ connected: true, name: 'Synthetic Runtime' }), activity: () => null,
    cronJobs: () => [], host: () => null, liveEvents: () => [], transcript: () => null };
  for (const P of [project2x, project3x]) {
    const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true, P,
      names: { agentName: () => null, interlocutorName: () => null }, actorOf: () => ({ kind: 'system', name: 'System' }) });
    const serialized = JSON.stringify(vm);
    assert.equal(serialized.includes(privateText), false, `v${P.version} omits primary prompt text from all fields`);
    assert.equal(serialized.includes(privateNotice), false, `v${P.version} omits subagent CLI notices from all fields`);
    assert.ok(vm.occupants.every(row => row.summary === undefined), `v${P.version} has no session summaries`);
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true, `v${P.version} OfficeVM remains schema-valid`);
  }
});

test('v2 and v3 OfficeVM schemas accept coding sessions alongside projected team members', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const snapshot = { observedAt: NOW, revision: 1, tasks: [], identityLinks: [],
    agents: ['pm-host', 'builder-host'].map(id => ({ id, role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 })),
    members: [
      { id: 'pm-member', name: 'Project lead', roleKind: 'lead', roleLabel: 'pm', hostAgentId: 'pm-host', parentMemberId: null },
      { id: 'builder-member', name: 'Builder', roleKind: 'member', roleLabel: 'builder', hostAgentId: 'builder-host', parentMemberId: 'pm-member' },
    ] };
  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    const { build } = project();
    const office = build(P);
    const withTeam = projectOfficeTeamOccupants(office, snapshot, principal, { sourceEnabled: true, version });
    assert.ok(withTeam.occupants.some(row => row.role === (version === 2 ? 'channel' : 'session')),
      `version ${version} includes the coding session`);
    assert.ok(withTeam.occupants.some(row => row.name === 'Builder' && row.role === 'subagent'), `version ${version} includes the team member`);
    assert.equal(validate(schemasFor(version).office, withTeam).ok, true, `version ${version} OfficeVM schema`);
  }
});

test('team grouping survives an unavailable Herdr host when private Claude and Codex session refs match', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build, session } = project();
  const codexKey = 'rt:codex:session:builder-session';
  const codexSession = { ...session, key: codexKey, class: { ...session.class, agentId: 'codex-worker' },
    run: { ...session.run, status: 'running', evidence: 'status-field', evidenceLevel: 'verified' } };
  const memberIds = { lead: 'member:claude-pm', child: 'member:codex-builder' };
  const snapshotBase = {
    observedAt: NOW, revision: 1, tasks: [], team: { id: 'team:fixture' }, identityLinks: [],
    members: [
      { id: memberIds.lead, name: 'PM', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-pm' },
      { id: memberIds.child, name: 'Builder', roleKind: 'member', parentMemberId: memberIds.lead, hostAgentId: 'pane-builder' },
    ],
    privateMemberSessionKeys: { [memberIds.lead]: session.key, [memberIds.child]: codexKey },
    privateMemberSessionRefs: {
      [memberIds.lead]: { runtimeKind: 'claude-code', sessionRef: 'claude-native-pm', sessionKey: session.key },
      [memberIds.child]: { runtimeKind: 'codex', sessionRef: 'codex-native-builder', sessionKey: codexKey },
    },
  };
  const runtimeAgents = [{ id: 'coding-agent', isPrimary: true, mainSessionKey: session.key }, { id: 'codex-worker', isPrimary: false }];
  const runtimeSessions = [session, codexSession];
  for (const [P, version, primaryId] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const base = build(P);
    const input = { ...base, occupants: base.occupants.map(row => row.id === primaryId ? { ...row, sessionKey: session.key } : row)
      .concat([{ ...base.occupants.find(row => row.id === primaryId), id: 'agent:codex-worker', role: 'agent', name: 'Worker aggregate', sessionKey: codexKey,
        state: 'working', stateSince: NOW, execution: { status: 'running', evidence: { level: 'verified', observedAt: NOW, expiresAt: NOW + 30_000 } },
        tokens: 4, lastSeenAt: NOW }]) };
    const hosts = [
      { id: 'pane-pm', role: 'primary', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 },
      { id: 'pane-builder', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 },
    ];
    const projectWithHosts = agents => projectOfficeTeamOccupants(input, { ...snapshotBase, agents }, principal, {
      sourceEnabled: true, version, canReadSessions: true, runtimeAgents, primaryAgentId: 'coding-agent',
      runtimeIdentitySessions: [], runtimeSessions,
    });
    const hostDown = projectWithHosts([]);
    const hostUp = projectWithHosts(hosts);
    for (const office of [hostDown, hostUp]) {
      const pm = office.occupants.find(row => row.id === primaryId);
      const builder = office.occupants.find(row => row.name === 'Builder');
      assert.equal(pm?.role, version === 2 ? 'main' : 'primary');
      assert.equal(builder?.id, 'agent:codex-worker');
      assert.equal(builder?.parentId, pm.id, `v${version} team-store lineage holds with host ${office === hostDown ? 'down' : 'up'}`);
      assert.equal(builder?.state, 'working', `v${version} fresh runtime evidence remains visible without Herdr`);
      const checked = validate(schemasFor(version).office, office);
      assert.equal(checked.ok, true, `v${version} schema with host ${office === hostDown ? 'down' : 'up'}: ${JSON.stringify(checked.errors || checked.issues || [])}`);
    }
    assert.deepEqual(hostDown.occupants.filter(row => row.teamId).map(row => [row.id, row.parentId]),
      hostUp.occupants.filter(row => row.teamId).map(row => [row.id, row.parentId]), `v${version} membership tree does not depend on Herdr availability`);
  }
});

test('offline member activity requires sessions.read, while an authorized host may still supply presence', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build, session } = project();
  const memberId = 'member:restricted-codex';
  const workerKey = 'rt:codex:session:restricted-worker';
  const workerSession = { ...session, key: workerKey, sessionId: 'private-native-session',
    displayName: 'Private task title', summary: 'Private session summary', model: { id: 'private-model' },
    cwd: '/private/workspace', class: { ...session.class, agentId: 'codex-worker' },
    run: { ...session.run, status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } };
  const member = { id: memberId, name: 'Builder', roleKind: 'member', parentMemberId: null, hostAgentId: null };
  const privateRef = { runtimeKind: 'codex', sessionRef: 'private-native-session', sessionKey: workerKey, agentId: 'codex-worker' };
  const snapshot = { observedAt: NOW, revision: 1, team: { id: 'team:restricted' }, members: [member], agents: [], identityLinks: [],
    privateMemberSessionKeys: { [memberId]: workerKey }, privateMemberSessionRefs: { [memberId]: privateRef } };
  const runtimeAgents = [{ id: 'coding-agent', isPrimary: true }, { id: 'codex-worker', isPrimary: false }];
  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    const ordinary = build(P);
    const template = ordinary.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
    const base = { ...ordinary, occupants: ordinary.occupants.concat([{ ...template, id: `private-session:${version}`,
      role: version === 2 ? 'channel' : 'conversation', sessionKey: workerKey, summary: 'Private session summary',
      state: 'working', stateSince: NOW, execution: { status: 'running', evidence: { level: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } },
      tokens: 900, lastSeenAt: NOW, model: 'private-model', project: 'private-project', runtime: 'Codex', tokensKnown: true,
      startedAt: NOW - 1000, lastActivityAt: NOW }]) };
    const denied = projectOfficeTeamOccupants(base, snapshot, principal, { sourceEnabled: true, version, canReadSessions: false,
      primaryAgentId: 'coding-agent', runtimeAgents, runtimeSessions: [workerSession] });
    const row = denied.occupants.find(occupant => occupant.name === 'Builder');
    assert.ok(row, `v${version} retains the registered team member`);
    assert.equal(row.state, 'unknown', `v${version} has no session-derived state without sessions.read`);
    assert.equal(row.execution.status, 'unknown');
    assert.deepEqual(row.execution.evidence, { level: 'unknown', observedAt: null, expiresAt: null });
    assert.equal(row.sessionKey, null);
    for (const field of ['summary', 'model', 'project', 'runtime', 'startedAt', 'lastActivityAt']) {
      assert.equal(row[field], undefined, `v${version} withholds ${field}`);
    }
    assert.equal(row.tokens, 0);
    const serialized = JSON.stringify(denied);
    for (const secret of ['private-native-session', 'Private task title', 'Private session summary', 'private-model', '/private/workspace']) {
      assert.equal(serialized.includes(secret), false, `v${version} response omits ${secret}`);
    }
    assert.equal(validate(schemasFor(version).office, denied).ok, true, `v${version} withheld state remains schema-valid`);

    const host = { id: 'pane-restricted', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 };
    const hostSnapshot = { ...snapshot, members: [{ ...member, hostAgentId: host.id }], agents: [host] };
    const hostProjection = projectOfficeTeamOccupants(base, hostSnapshot, principal, { sourceEnabled: true, version, canReadSessions: false,
      primaryAgentId: 'coding-agent', runtimeAgents, runtimeSessions: [workerSession] });
    const hostRow = hostProjection.occupants.find(occupant => occupant.name === 'Builder');
    assert.equal(hostRow.state, 'working', `v${version} host status remains available without sessions.read`);
    assert.deepEqual(hostRow.execution.evidence, { level: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 });
    assert.equal(validate(schemasFor(version).office, hostProjection).ok, true, `v${version} host-authorized state is schema-valid`);
  }
});

test('an exact registered PM session keeps the canonical v2/v3 owner row and folds duplicate conversations into it', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const now = NOW;
  const host = { id: 'pane-pm', role: 'primary', status: 'idle', observedAt: now, staleAfter: now + 60_000 };
  const snapshot = { observedAt: now, revision: 1, privateMemberSessionKeys: { 'member:pm': 'rt:claude-code:session:synthetic', 'member:child': 'other-session' },
    privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'claude-code', sessionRef: 'synthetic', sessionKey: 'rt:claude-code:session:synthetic' } },
    agents: [host], members: [
      { id: 'member:pm', name: 'Project lead', roleLabel: 'lead', hostAgentId: host.id, parentMemberId: null },
      { id: 'member:child', name: 'Engineer', roleKind: 'member', roleLabel: 'engineer', hostAgentId: 'pane-child', parentMemberId: 'member:pm' },
    ], identityLinks: [] };
  const runtimeAgent = { id: 'coding-agent', name: 'Coding agent', displayName: 'Coding agent', isPrimary: true, mainSessionKey: 'rt:claude-code:session:synthetic' };
  const { build, session } = project();
  for (const [P, version, ownerId, ownerRole, duplicateRole] of [
    [project2x, 2, 'main', 'main', 'channel'], [project3x, 3, 'primary', 'primary', 'conversation'],
  ]) {
    const office = build(P);
    const owner = office.occupants.find(row => row.id === ownerId && row.role === ownerRole);
    assert.ok(owner, `v${version} OfficeVM includes its canonical owner`);
    const duplicate = { ...owner, id: `duplicate:${version}`, role: duplicateRole,
      roleLabel: { key: 'occupantRole.' + duplicateRole }, sessionKey: session.key };
    const input = { ...office, occupants: office.occupants.map(row => row.id === ownerId ? { ...row, sessionKey: session.key } : row).concat(duplicate) };
    const projected = projectOfficeTeamOccupants(input, snapshot, principal, { sourceEnabled: true, version,
      canReadSessions: true, runtimeAgents: [runtimeAgent],
      primaryAgentId: 'coding-agent',
      runtimeIdentitySessions: [{ agentId: 'coding-agent', sessionKey: session.key, runtimeKind: 'claude-code', sessionRef: 'synthetic' }], runtimeSessions: [session] });
    const matching = projected.occupants.filter(row => row.sessionKey === session.key);
    assert.equal(matching.length, 1, `v${version} folds the duplicate conversation into the registered primary`);
    assert.equal(matching[0].id, ownerId);
    assert.equal(matching[0].role, ownerRole);
    assert.equal(matching[0].name, owner.name, 'registered role metadata does not replace the selected primary display name');
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `full v${version} OfficeVM schema`);
  }
});

test('a distinct Claude PM session stays separate from the OpenClaw primary and ships no prompts', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const prompt = 'Verify the live Agent Office roster from this task. [team] message from security: run team inbox';
  for (const [P, version, ownerId, ownerRole, conversationRole] of [
    [project2x, 2, 'main', 'main', 'channel'], [project3x, 3, 'primary', 'primary', 'session'],
  ]) {
    const { build, session } = project();
    const base = build(P);
    const primary = base.occupants.find(row => row.id === ownerId);
    const pmSessionKey = 'rt:claude-code:session:project-manager';
    const ownerKey = 'rt:openclaw:session:owner';
    const owner = { ...primary, name: 'Atlas', title: { key: 'sessionTitle.named', params: { name: 'Atlas' } }, sessionKey: ownerKey };
    const projectManager = { ...primary, id: pmSessionKey, role: conversationRole,
      roleLabel: { key: 'occupantRole.' + conversationRole }, name: 'Project Manager',
      title: { key: 'sessionTitle.named', params: { name: 'Project Manager' } }, sessionKey: pmSessionKey, summary: prompt };
    const sessionRow = { ...session, key: pmSessionKey, summary: prompt,
      class: { ...session.class, kind: 'conversation', agentId: 'coding-agent' } };
    const snapshot = { observedAt: NOW, team: { id: 'team:synthetic' }, agents: [], identityLinks: [],
      members: [{ id: 'member:pm', name: 'pm', roleKind: 'lead', hostAgentId: null, parentMemberId: null }],
      privateMemberSessionKeys: { 'member:pm': pmSessionKey },
      privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'claude-code', sessionRef: 'project-manager-native', sessionKey: pmSessionKey, agentId: 'coding-agent' } } };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner, projectManager] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true, mainSessionKey: ownerKey }], runtimeSessions: [sessionRow],
      runtimeIdentitySessions: [{ runtimeKind: 'claude-code', sessionRef: 'project-manager-native', sessionKey: pmSessionKey, agentId: 'coding-agent' }],
    });
    const projectedPrimary = projected.occupants.find(row => row.id === ownerId);
    const pm = projected.occupants.find(row => row.id === pmSessionKey);
    assert.equal(projected.occupants.filter(row => row.role === ownerRole).length, 1, `v${version} has only one instance primary`);
    assert.equal(projectedPrimary.name, 'Atlas', `v${version} keeps the configured primary name`);
    assert.equal(projectedPrimary.sessionKey, ownerKey, `v${version} keeps the primary's native main session`);
    assert.equal(pm?.role, 'agent', `v${version} retains the distinct Claude team lead as an agent`);
    assert.equal(pm?.name, 'pm');
    assert.equal(pm?.parentId, null, 'the distinct team lead remains a root');
    assert.equal(JSON.stringify(projected).includes(prompt), false, 'raw task prompts and CLI notices never enter the office VM');
  }
});

test('an exact PM main session keeps its user-set runtime name ahead of the member fallback', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, ownerId, ownerRole] of [
    [project2x, 2, 'main', 'main'], [project3x, 3, 'primary', 'primary'],
  ]) {
    const { build, session } = project();
    const base = build(P), owner = base.occupants.find(row => row.id === ownerId);
    const runtimeName = 'Project Manager';
    const titledSession = { ...session, displayName: runtimeName, summarySource: 'runtime' };
    const ref = { runtimeKind: 'claude-code', sessionRef: 'primary-runtime-title', sessionKey: session.key, agentId: 'coding-agent' };
    const snapshot = { observedAt: NOW, team: { id: 'team:primary-title' }, agents: [], identityLinks: [],
      members: [{ id: 'member:pm', name: 'pm', roleKind: 'lead', parentMemberId: null, hostAgentId: null }],
      privateMemberSessionKeys: { 'member:pm': session.key }, privateMemberSessionRefs: { 'member:pm': ref } };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [{ ...owner, name: 'pm', sessionKey: session.key }] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true, mainSessionKey: session.key }], runtimeSessions: [titledSession],
      runtimeIdentitySessions: [{ ...ref }],
    });
    const primary = projected.occupants.find(row => row.role === ownerRole);
    assert.equal(primary.name, runtimeName, `v${version} uses the session's user-set name rather than the member name`);
    assert.deepEqual(primary.title.params, { name: runtimeName });
    assert.equal(projected.occupants.filter(row => row.role === ownerRole).length, 1, `v${version} keeps one primary`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} schema`);
  }
});

test('a folded team lead keeps rich activity from its exact transcript session in both Office contracts', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, ownerRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const { build, session } = project();
    const base = build(P), owner = base.occupants.find(row => row.role === ownerRole);
    const key = session.key, ref = { runtimeKind: 'claude-code', sessionRef: `native-folded-lead-v${version}`, sessionKey: key, agentId: 'coding-agent' };
    const primary = { ...owner, sessionKey: key, state: 'idle', execution: { status: 'idle', evidence: { level: 'verified', observedAt: NOW - 1000, expiresAt: NOW + 60_000 } } };
    const transcriptRow = { ...owner, id: key, role: version === 2 ? 'channel' : 'session', sessionKey: key, state: 'waiting',
      execution: { status: 'idle', evidence: { level: 'observed', observedAt: NOW, expiresAt: NOW + 15 * 60_000 } } };
    const snapshot = { observedAt: NOW, team: { id: 'team:folded-lead' }, agents: [], identityLinks: [],
      members: [{ id: 'member:pm', name: 'pm', roleKind: 'lead', parentMemberId: null, hostAgentId: null }],
      privateMemberSessionKeys: { 'member:pm': key }, privateMemberSessionRefs: { 'member:pm': ref } };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [primary, transcriptRow] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true, mainSessionKey: key }], runtimeSessions: [session],
      runtimeIdentitySessions: [{ ...ref }],
    });
    const folded = projected.occupants.find(row => row.role === ownerRole);
    assert.equal(folded?.state, 'waiting', `v${version} folded lead receives its exact transcript's richer waiting state`);
    assert.equal(projected.occupants.filter(row => row.role === ownerRole).length, 1, `v${version} keeps one canonical primary`);
    assert.equal(projected.occupants.some(row => row.id === key), false, `v${version} consumes the folded transcript row`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} schema-valid OfficeVM`);
  }
});

test('a distinct orchestrator lead is an agent root, never a second instance primary', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, primaryId, primaryRole] of [
    [project2x, 2, 'main', 'main'], [project3x, 3, 'primary', 'primary'],
  ]) {
    const { build, session } = project();
    const base = build(P);
    const leadKey = `rt:claude-code:session:separate-lead-v${version}`;
    const leadSession = { ...session, key: leadKey, class: { ...session.class, kind: 'conversation', agentId: 'claude-pm' } };
    const primary = base.occupants.find(row => row.id === primaryId);
    const leadSessionRow = { ...primary, id: 'agent:claude-pm', role: 'agent', sessionKey: leadKey, name: 'Runtime default' };
    const child = { ...primary, id: 'agent:codex-builder', role: 'agent', sessionKey: 'rt:codex:session:builder', name: 'Builder' };
    const members = [
      { id: 'member:pm', name: 'PM', roleKind: 'lead', hostAgentId: null, parentMemberId: null },
      { id: 'member:builder', name: 'Builder', roleKind: 'member', hostAgentId: null, parentMemberId: 'member:pm' },
    ];
    const snapshot = { observedAt: NOW, team: { id: 'team:distinct-lead' }, agents: [], identityLinks: [], members,
      privateMemberSessionKeys: { 'member:pm': leadKey },
      privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'claude-code', sessionRef: `native-pm-${version}`, sessionKey: leadKey, agentId: 'claude-pm' } } };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [primary, leadSessionRow, child] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'claude-pm', isPrimary: false }],
      runtimeIdentitySessions: [{ agentId: 'claude-pm', sessionKey: leadKey, runtimeKind: 'claude-code', sessionRef: `native-pm-${version}` }],
      runtimeSessions: [leadSession],
    });
    assert.equal(projected.occupants.filter(row => row.role === (version === 2 ? 'main' : 'primary')).length, 1,
      `v${version} only the instance primary uses the primary role`);
    const pm = projected.occupants.find(row => row.id === 'agent:claude-pm');
    const builder = projected.occupants.find(row => row.name === 'Builder');
    assert.equal(pm?.role, 'agent', `v${version} a distinct team lead remains an agent root`);
    assert.equal(builder?.parentId, pm?.id, `v${version} children stay grouped under that lead`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} schema-valid distinct lead`);
  }
});

test('a PM session on the primary agent does not replace its different native main session', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, primaryId, primaryRole, pmRole] of [
    [project2x, 2, 'main', 'main', 'channel'], [project3x, 3, 'primary', 'primary', 'session'],
  ]) {
    const { build, session } = project();
    const base = build(P), primary = base.occupants.find(row => row.id === primaryId);
    const mainKey = 'native-session-A', pmKey = 'native-session-B';
    const mainRef = { runtimeKind: 'claude-code', sessionRef: 'native-A', sessionKey: mainKey, agentId: 'coding-agent' };
    const pmRef = { runtimeKind: 'claude-code', sessionRef: 'native-B', sessionKey: pmKey, agentId: 'coding-agent' };
    const pm = { ...primary, id: pmKey, role: pmRole, sessionKey: pmKey, name: 'Session B title' };
    const snapshot = { observedAt: NOW, team: { id: 'team:distinct-native-session' }, agents: [], identityLinks: [],
      members: [{ id: 'member:pm', name: 'PM', roleKind: 'lead', parentMemberId: null, hostAgentId: null }],
      privateMemberSessionKeys: { 'member:pm': pmKey }, privateMemberSessionRefs: { 'member:pm': pmRef } };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [{ ...primary, sessionKey: mainKey }, pm] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true, mainSessionKey: mainKey }],
      runtimeIdentitySessions: [mainRef, pmRef],
      runtimeSessions: [
        { ...session, key: mainKey, class: { ...session.class, agentId: 'coding-agent' } },
        { ...session, key: pmKey, class: { ...session.class, agentId: 'coding-agent' } },
      ],
    });
    const owner = projected.occupants.find(row => row.id === primaryId);
    const teamLead = projected.occupants.find(row => row.name === 'PM');
    assert.equal(owner?.sessionKey, mainKey, `v${version} keeps the actual native main session A on the owner`);
    assert.equal(owner?.role, primaryRole, `v${version} keeps the instance primary role on its canonical owner`);
    assert.equal(teamLead?.id, pmKey, `v${version} keeps the PM's distinct session B occupant`);
    assert.equal(teamLead?.role, 'agent', `v${version} does not promote a second native session to primary`);
    assert.equal(projected.occupants.filter(row => row.role === primaryRole).length, 1, `v${version} emits one primary`);
    assert.equal(projected.occupants.filter(row => row.sessionKey === pmKey).length, 1, `v${version} keeps one PM session row`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} validates the separate native session`);
  }
});

test('off-stage history cannot keep a matched agent ghost, while an unmatched live sibling remains visible', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const activeKey = 'rt:codex:session:builder-current', staleKey = 'rt:codex:session:builder-stale', siblingKey = 'rt:codex:session:builder-sibling';
  const runtimeSession = (key, summary) => ({ key, summary,
    class: { kind: 'conversation', agentId: 'codex-builder' },
    run: { status: 'running', evidenceLevel: 'verified', evidence: 'status-field', observedAt: NOW, expiresAt: NOW + 30_000 } });
  for (const [P, version, ownerId, conversationRole] of [
    [project2x, 2, 'main', 'channel'], [project3x, 3, 'primary', 'session'],
  ]) {
    const { build } = project();
    const base = build(P);
    const owner = base.occupants.find(row => row.id === ownerId);
    const memberSession = { ...owner, id: activeKey, role: conversationRole,
      roleLabel: { key: 'occupantRole.session', params: { provider: 'Codex' } }, name: 'Builder session', sessionKey: activeKey, parentId: ownerId };
    const aggregate = { ...owner, id: 'agent:codex-builder', role: 'agent', roleLabel: { key: 'occupantRole.agent' },
      name: 'Codex project agent', sessionKey: activeKey };
    const sibling = { ...memberSession, id: siblingKey, name: 'Unmatched sibling', sessionKey: siblingKey };
    const snapshot = { observedAt: NOW, team: { id: 'team:synthetic' }, agents: [], identityLinks: [],
      members: [{ id: 'member:builder', name: 'Builder', roleKind: 'member', parentMemberId: 'member:pm' }],
      privateMemberSessionKeys: { 'member:builder': activeKey },
      privateMemberSessionRefs: { 'member:builder': { runtimeKind: 'codex', sessionRef: 'builder-native', sessionKey: activeKey, agentId: 'codex-builder' } } };
    const runtimeSessions = [runtimeSession(activeKey, 'PRIVATE_MEMBER_PROMPT'), { ...runtimeSession(staleKey, 'PRIVATE_STALE_PROMPT'),
      updatedAt: NOW - 2 * 60 * 60 * 1000,
      run: { status: 'unknown', evidence: 'none', evidenceLevel: 'unknown', observedAt: null, expiresAt: null } }];
    const projectRows = withSibling => projectOfficeTeamOccupants({ ...base, occupants: [owner, aggregate, memberSession, ...(withSibling ? [sibling] : [])] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, primaryAgentId: 'coding-agent',
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'codex-builder', isPrimary: false }],
      runtimeSessions: withSibling ? [...runtimeSessions, runtimeSession(siblingKey, 'PRIVATE_SIBLING_PROMPT')] : runtimeSessions,
      runtimeIdentitySessions: [activeKey, staleKey, ...(withSibling ? [siblingKey] : [])].map((sessionKey, index) => ({
        runtimeKind: 'codex', sessionRef: `builder-ref-${index}`, sessionKey, agentId: 'codex-builder',
      })),
    });
    const withoutSibling = projectRows(false);
    assert.equal(withoutSibling.occupants.some(row => row.id === 'agent:codex-builder'), false,
      `v${version} ignores stale off-stage sessions when deciding whether to absorb the aggregate`);
    assert.equal(JSON.stringify(withoutSibling).includes('PRIVATE_MEMBER_PROMPT'), false, 'member prompt is never shipped');
    assert.equal(JSON.stringify(withoutSibling).includes('PRIVATE_STALE_PROMPT'), false, 'off-stage session content is never shipped');

    const withLiveSibling = projectRows(true);
    assert.ok(withLiveSibling.occupants.some(row => row.id === 'agent:codex-builder'),
      `v${version} retains the project-agent aggregate when an unmatched sibling session remains on stage`);
    assert.ok(withLiveSibling.occupants.some(row => row.id === siblingKey), `v${version} keeps the unmatched sibling visible`);
  }
});

test('latest-CWD project aggregates fold covered members and seat only fresh uncovered siblings', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build } = project();
  const leadKey = 'rt:codex:session:old-0';
  const memberRows = Array.from({ length: 5 }, (_, index) => ({ id: `member:codex-${index}`, name: `Builder ${index}`,
    roleKind: index === 0 ? 'lead' : 'member', parentMemberId: index === 0 ? null : 'member:codex-0' }));
  const memberKeys = memberRows.map((_row, index) => `rt:codex:session:member-${index}`);
  const staleKeys = Array.from({ length: 78 }, (_, index) => `rt:codex:session:old-${index}`);
  const siblingKey = 'rt:codex:session:fresh-unmatched';
  const refs = memberRows.map((_row, index) => ({ runtimeKind: 'codex', sessionRef: `rollout-uuid-${index}`, sessionKey: memberKeys[index], agentId: 'old-project-agent-id' }));
  const snapshot = { observedAt: NOW, team: { id: 'team:codex' }, agents: [], identityLinks: [], members: memberRows,
    privateMemberSessionKeys: Object.fromEntries(memberRows.map((row, index) => [row.id, memberKeys[index]])),
    privateMemberSessionRefs: Object.fromEntries(memberRows.map((row, index) => [row.id, refs[index]])) };
  const oldAt = NOW - 2 * 60 * 60 * 1000;
  const session = (key, index, updatedAt = oldAt) => ({ key, updatedAt, usage: { total: index },
    class: { kind: 'conversation', agentId: 'codex-project', heartbeatOf: null },
    run: { status: 'unknown', evidenceLevel: 'unknown', observedAt: null, expiresAt: null } });
  const runtimeSessions = [...memberKeys.map((key, index) => session(key, index)), ...staleKeys.map((key, index) => session(key, index + 5))];
  const runtimeIdentitySessions = [...refs, ...staleKeys.map((key, index) => ({ runtimeKind: 'codex', sessionRef: `unregistered-${index}`, sessionKey: key, agentId: 'codex-project' }))];
  const projectAgent = { id: 'codex-project', isPrimary: false, mainSessionKey: leadKey };
  for (const [P, version, primaryRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const base = build(P), owner = base.occupants.find(row => row.role === primaryRole);
    const aggregate = { ...owner, id: 'agent:codex-project', role: 'agent', name: 'Codex project aggregate',
      sessionKey: leadKey, state: 'unknown', tokens: 83, lastSeenAt: oldAt };
    const projectRows = (sessions, showFreshSibling = false) => {
      const siblingOccupant = showFreshSibling ? { ...owner, id: siblingKey, role: version === 2 ? 'channel' : 'session',
        name: 'Fresh sibling', sessionKey: siblingKey, state: 'idle', lastSeenAt: NOW - 1000 } : null;
      return projectOfficeTeamOccupants({ ...base, occupants: [owner, aggregate, ...(siblingOccupant ? [siblingOccupant] : [])] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: true, runtimeAgents: [projectAgent], runtimeSessions: sessions,
      runtimeIdentitySessions, agentPresenceWindowMs: 60 * 60 * 1000,
      });
    };

    const oldOnly = projectRows(runtimeSessions);
    assert.equal(oldOnly.occupants.filter(row => row.name === 'Codex project aggregate').length, 0,
      `v${version}: five exact member refs absorb their represented sessions; 78 two-hour siblings cannot keep an aggregate seated`);
    assert.equal(oldOnly.occupants.filter(row => /^Builder [0-4]$/.test(row.name)).length, 5,
      `v${version}: all five registered members remain represented exactly once`);
    assert.equal(oldOnly.occupants.some(row => row.state === 'unknown' && row.name === 'Codex project aggregate'), false,
      `v${version}: stale project transcript state is never exposed as Unknown`);

    const freshSibling = session(siblingKey, 99, NOW - 1000);
    const withFreshSibling = projectRows([...runtimeSessions, freshSibling], true);
    const residual = withFreshSibling.occupants.find(row => row.id === 'agent:codex-project');
    assert.ok(residual, `v${version}: one fresh uncovered sibling keeps a residual project row`);
    assert.equal(residual.sessionKey, siblingKey, `v${version}: the residual points to its own remaining session`);
    assert.equal(residual.state, 'idle', `v${version}: recent transcript presence without current run evidence is idle, never unknown`);
    assert.equal(withFreshSibling.occupants.filter(row => /^Builder [0-4]$/.test(row.name)).length, 5,
      `v${version}: the residual does not merge or duplicate any registered member`);
    const runningSibling = { ...session('rt:codex:session:running-sibling', 100, NOW - 5_000),
      run: { status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW - 5_000, expiresAt: NOW + 60_000 } };
    const newerIdleSibling = { ...session('rt:codex:session:newer-idle-sibling', 101, NOW - 1_000),
      run: { status: 'idle', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW - 1_000, expiresAt: NOW + 60_000 } };
    const newerUnknownSibling = { ...session('rt:codex:session:newer-unknown-sibling', 102, NOW - 500) };
    const newerRunningSibling = { ...session('rt:codex:session:newer-running-sibling', 103, NOW - 250),
      run: { status: 'running', evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW - 250, expiresAt: NOW + 60_000 } };
    const witnessCases = [
      ['idle sibling appears first', [runningSibling, newerIdleSibling]],
      ['idle sibling appears last', [newerIdleSibling, runningSibling]],
      ['unknown sibling appears first', [runningSibling, newerUnknownSibling]],
      ['unknown sibling appears last', [newerUnknownSibling, runningSibling]],
      ['live sibling is newest', [newerIdleSibling, newerRunningSibling]],
    ];
    let liveWins;
    for (const [label, siblings] of witnessCases) {
      const replay = projectRows([...runtimeSessions, ...siblings]);
      const workingResidual = replay.occupants.find(row => row.id === 'agent:codex-project');
      const witness = siblings.find(row => row.run.status === 'running');
      assert.equal(workingResidual?.state, 'working', `v${version}: ${label} keeps the project aggregate Working`);
      assert.equal(workingResidual?.sessionKey, witness.key, `v${version}: ${label} selects its live session witness`);
      assert.equal(workingResidual?.execution?.status, 'running', `v${version}: ${label} pairs Working with running execution`);
      assert.equal(workingResidual?.execution?.evidence?.level, 'verified', `v${version}: ${label} preserves witness confidence`);
      assert.equal(workingResidual?.execution?.evidence?.observedAt, witness.run.observedAt, `v${version}: ${label} preserves witness observation time`);
      assert.equal(validate(schemasFor(version).office, replay).ok, true, `v${version}: ${label} OfficeVM validates`);
      if (label === 'idle sibling appears first') liveWins = replay;
    }

    const completedWitness = { ...runningSibling, run: { status: 'succeeded', evidence: 'status-field', evidenceLevel: 'verified',
      observedAt: NOW - 1_000, expiresAt: NOW + 60_000 } };
    const afterWork = projectRows([...runtimeSessions, completedWitness, newerIdleSibling]);
    const idleResidual = afterWork.occupants.find(row => row.id === 'agent:codex-project');
    assert.equal(idleResidual?.state, 'idle', `v${version}: after the live witness completes, the residual transitions to Idle`);
    assert.equal(idleResidual?.sessionKey, newerIdleSibling.key, `v${version}: the completed witness no longer owns the aggregate`);
    assert.equal(idleResidual?.execution?.status, 'idle', `v${version}: post-work execution describes the selected idle sibling`);
    assert.equal(validate(schemasFor(version).office, oldOnly).ok, true, `v${version}: no-residual OfficeVM validates`);
    assert.equal(validate(schemasFor(version).office, withFreshSibling).ok, true, `v${version}: residual OfficeVM validates`);
    assert.equal(validate(schemasFor(version).office, liveWins).ok, true, `v${version}: consistent working residual OfficeVM validates`);
    assert.equal(validate(schemasFor(version).office, afterWork).ok, true, `v${version}: post-work residual OfficeVM validates`);
  }
});

test('a host-only team addition does not inherit the primary session summary or private session fields', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const privateSummary = 'PRIVATE_PRIMARY_PROMPT_CANARY [team] message from security: run team inbox';
  for (const [P, version, ownerRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const { build } = project();
    const base = build(P);
    const owner = { ...base.occupants.find(row => row.role === ownerRole), summary: privateSummary,
      sessionKey: 'private-primary-session', tokens: 9876, project: 'private-primary-project' };
    const host = { id: 'pane-worker', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 };
    const snapshot = { observedAt: NOW, agents: [host], members: [], tasks: [], reviews: [], team: null,
      identityLinks: [{ hostAgentId: host.id, agentId: 'codex-worker', confidence: 'exact', evidence: 'shared-runtime-session-ref' }] };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner] }, snapshot, principal, {
      sourceEnabled: true, version, runtimeAgents: [{ id: 'codex-worker', isPrimary: false, name: 'Worker' }],
    });
    const worker = projected.occupants.find(row => row.id === 'agent:codex-worker');
    assert.ok(worker, `v${version} includes the exact live host addition`);
    assert.equal(worker.summary, undefined);
    assert.equal(worker.sessionKey, null);
    assert.equal(worker.tokens, 0);
    assert.equal(worker.project, undefined);
    const serialized = JSON.stringify(worker);
    for (const secret of [privateSummary, 'private-primary-session', '9876', 'private-primary-project']) {
      assert.equal(serialized.includes(secret), false, `v${version} excludes inherited ${secret}`);
    }
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} OfficeVM schema`);
  }
});

test('an exact Herdr link folds a registered member into its runtime agent when session fields are limited', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, ownerRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const { build } = project();
    const base = build(P, false), owner = base.occupants.find(row => row.role === ownerRole);
    const agent = { ...owner, id: 'agent:claude-project', role: 'agent', name: 'Project Manager',
      title: { key: 'sessionTitle.named', params: { name: 'Project Manager' } }, sessionKey: null };
    const sessionKey = 'private:claude-session';
    const snapshot = { observedAt: NOW, team: { id: 'team:restricted' },
      agents: [{ id: 'pane-pm', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 }],
      identityLinks: [{ hostAgentId: 'pane-pm', agentId: 'claude-project', confidence: 'exact', evidence: 'shared-runtime-session-ref' }],
      members: [{ id: 'member:pm', name: 'pm', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-pm' }],
      privateMemberSessionKeys: { 'member:pm': sessionKey },
      privateMemberSessionRefs: { 'member:pm': { runtimeKind: 'claude-code', sessionRef: 'native-pm-ref', sessionKey, agentId: 'claude-project' } } };
    const tracker = createStateTracker();
    const projectAt = (at, agents) => projectOfficeTeamOccupants({ ...base, occupants: [owner, agent] },
      { ...snapshot, observedAt: at, agents }, principal, {
        sourceEnabled: true, version, canReadSessions: false, tracker,
        runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'claude-project', isPrimary: false }],
        runtimeIdentitySessions: [{ agentId: 'claude-project', runtimeKind: 'claude-code', sessionRef: 'native-pm-ref', sessionKey }],
      });
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner, agent] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: false, tracker,
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'claude-project', isPrimary: false }],
      runtimeIdentitySessions: [{ agentId: 'claude-project', runtimeKind: 'claude-code', sessionRef: 'native-pm-ref', sessionKey }],
    });
    const rows = projected.occupants.filter(row => row.name === 'pm');
    assert.equal(rows.length, 1, `v${version} renders the exact linked member once`);
    assert.equal(rows[0].id, 'agent:claude-project', `v${version} reuses the runtime agent identity`);
    assert.equal(rows[0].sessionKey, null, `v${version} does not restore private session fields`);
    assert.equal(projected.occupants.some(row => row.name === 'Project Manager'), false, `v${version} removes the duplicate runtime label`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} OfficeVM schema`);

    const missedPoll = projectAt(NOW + 5_000, []);
    const retained = missedPoll.occupants.find(row => row.name === 'pm');
    assert.ok(retained, `v${version} a one-poll missing Herdr row keeps the exact runtime occupant present`);
    assert.equal(retained.id, 'agent:claude-project', `v${version} preserves its stable runtime occupant identity`);
    assert.equal(retained.state, 'working', `v${version} keeps the last known host state through one transient missing poll`);
    assert.equal(retained.execution.evidence.level, 'observed', `v${version} downgrades cached state during the grace period`);
    assert.equal(retained.sessionKey, null, `v${version} keeps private session fields redacted after a missed poll`);
    const expiredGrace = projectAt(NOW + 31_000, []).occupants.find(row => row.name === 'pm');
    assert.equal(expiredGrace.state, 'unknown', `v${version} resumes normal presence rules after the short grace period`);
  }
});

test('member host grace cache prunes removed members and has a fixed size bound', () => {
  const tracker = createStateTracker();
  const presence = { state: 'working', stateSince: NOW,
    execution: { status: 'running', evidence: { level: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } } };
  tracker.memberHostPresence('member:removed', presence, NOW);
  tracker.keepMemberHostPresence([], NOW + 5_000);
  assert.equal(tracker.memberHostPresence('member:removed', null, NOW + 6_000), null,
    'a removed team record does not retain its grace entry');
  tracker.memberHostPresence('member:expired-evidence', { ...presence,
    execution: { status: 'running', evidence: { level: 'verified', observedAt: NOW, expiresAt: NOW + 1_000 } } }, NOW);
  assert.equal(tracker.memberHostPresence('member:expired-evidence', null, NOW + 2_000), null,
    'grace never extends beyond the original evidence lease');

  const ids = [];
  for (let index = 0; index < 2_001; index++) {
    const id = `member:${index}`;
    ids.push(id);
    tracker.memberHostPresence(id, presence, NOW);
  }
  tracker.keepMemberHostPresence(ids, NOW + 1_000);
  assert.equal(tracker.memberHostPresence('member:0', null, NOW + 2_000), null,
    'the fixed cache bound evicts the oldest observation under registry churn');
  assert.equal(tracker.memberHostPresence('member:2000', null, NOW + 2_000)?.state, 'working',
    'recent members retain their transient-miss grace');
});

test('limited team readers do not clear another viewer’s transient host grace', () => {
  const tracker = createStateTracker();
  const admin = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const orchestratorsOnly = { id: 'synthetic-operator', role: 'human', permissionRevision: 1,
    effectivePermissions: { orchestrators: 'read' } };
  const member = { id: 'member:pm', name: 'Lead', roleKind: 'lead', hostAgentId: 'pane-pm' };
  const host = { id: 'pane-pm', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 };
  for (const [P, version, role] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const { build } = project();
    const base = build(P, false);
    const projectAt = (principal, at, agents) => projectOfficeTeamOccupants(base,
      { observedAt: at, team: { id: 'team:grace' }, members: [member], agents, identityLinks: [] }, principal,
      { sourceEnabled: true, version, tracker });
    assert.equal(projectAt(admin, NOW, [host]).occupants.find(row => row.name === 'Lead').state, 'working');
    projectAt(admin, NOW + 5_000, []);
    projectAt(orchestratorsOnly, NOW + 10_000, []);
    assert.equal(projectAt(admin, NOW + 15_000, []).occupants.find(row => row.name === 'Lead').state, 'working',
      `v${version} keeps the grace cache across a limited-viewer projection`);
  }
});

test('distinct native sessions in one project agent keep separate team occupants', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, ownerRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    const { build } = project();
    const base = build(P, false), owner = base.occupants.find(row => row.role === ownerRole);
    const projectAgent = { ...owner, id: 'agent:shared-project', role: 'agent', name: 'Shared project', sessionKey: null };
    const refs = [
      { member: { id: 'member:lead', name: 'Lead', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-lead' },
        sessionKey: 'private:session-a', sessionRef: 'native-session-a' },
      { member: { id: 'member:worker', name: 'Worker', roleKind: 'member', parentMemberId: 'member:lead', hostAgentId: 'pane-worker' },
        sessionKey: 'private:session-b', sessionRef: 'native-session-b' },
    ];
    const members = refs.map(row => row.member);
    const privateMemberSessionKeys = Object.fromEntries(refs.map(row => [row.member.id, row.sessionKey]));
    const privateMemberSessionRefs = Object.fromEntries(refs.map(row => [row.member.id, {
      runtimeKind: 'claude-code', sessionRef: row.sessionRef, sessionKey: row.sessionKey, agentId: 'shared-project' }]));
    const runtimeIdentitySessions = refs.map(row => ({ agentId: 'shared-project', runtimeKind: 'claude-code',
      sessionRef: row.sessionRef, sessionKey: row.sessionKey }));
    const snapshot = { observedAt: NOW, team: { id: 'team:shared-project' }, members,
      agents: refs.map(({ member }) => ({ id: member.hostAgentId, role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 })),
      identityLinks: refs.map(({ member }) => ({ hostAgentId: member.hostAgentId, agentId: 'shared-project',
        confidence: 'exact', evidence: 'shared-runtime-session-ref' })), privateMemberSessionKeys, privateMemberSessionRefs };
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner, projectAgent] }, snapshot, principal, {
      sourceEnabled: true, version, canReadSessions: false,
      runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'shared-project', isPrimary: false }], runtimeIdentitySessions,
    });
    for (const name of ['Lead', 'Worker']) {
      const rows = projected.occupants.filter(row => row.name === name);
      assert.equal(rows.length, 1, `v${version} retains the distinct ${name} native identity`);
      assert.notEqual(rows[0].id, 'agent:shared-project', `v${version} does not overwrite ${name} with the shared project row`);
    }
    assert.equal(projected.occupants.find(row => row.name === 'Worker').parentId,
      projected.occupants.find(row => row.name === 'Lead').id, `v${version} preserves team lineage`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} OfficeVM schema`);
  }
});

test('a shared pane linked only to a grouped project agent cannot overwrite native member states', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version, ownerRole] of [[project2x, 2, 'main'], [project3x, 3, 'primary']]) {
    for (const reverseMembers of [false, true]) {
      const { build } = project();
      const base = build(P), owner = base.occupants.find(row => row.role === ownerRole);
      const leadKey = 'rt:claude-code:session:native-a', workerKey = 'rt:claude-code:session:native-b';
      const sessionRow = (key, name, state) => ({ ...owner, id: key, role: version === 2 ? 'channel' : 'session',
        name, title: { key: 'sessionTitle.named', params: { name } }, roleLabel: { key: 'occupantRole.session', params: { provider: 'Claude Code' } },
        sessionKey: key, state, stateSince: NOW - 1000,
        execution: { status: state === 'working' ? 'running' : 'succeeded', evidence: { level: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } } });
      const runtimeSession = (key, sessionRef, status) => ({ key, class: { kind: 'conversation', agentId: 'shared-project' },
        run: { status, evidenceLevel: 'verified', observedAt: NOW, expiresAt: NOW + 60_000 } });
      const lead = { id: 'member:lead', name: 'Lead', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-shared' };
      const worker = { id: 'member:worker', name: 'Worker', roleKind: 'member', parentMemberId: 'member:lead', hostAgentId: 'pane-shared' };
      const members = reverseMembers ? [worker, lead] : [lead, worker];
      const snapshot = { observedAt: NOW, team: { id: 'team:shared-pane' }, members,
        agents: [{ id: 'pane-shared', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 }],
        identityLinks: [{ hostAgentId: 'pane-shared', agentId: 'shared-project', confidence: 'exact', evidence: 'shared-runtime-session-ref' }],
        privateMemberSessionKeys: { 'member:lead': leadKey, 'member:worker': workerKey },
        privateMemberSessionRefs: {
          'member:lead': { runtimeKind: 'claude-code', sessionRef: 'native-a', sessionKey: leadKey, agentId: 'shared-project' },
          'member:worker': { runtimeKind: 'claude-code', sessionRef: 'native-b', sessionKey: workerKey, agentId: 'shared-project' },
        } };
      const runtimeIdentitySessions = [
        { agentId: 'shared-project', runtimeKind: 'claude-code', sessionRef: 'native-a', sessionKey: leadKey },
        { agentId: 'shared-project', runtimeKind: 'claude-code', sessionRef: 'native-b', sessionKey: workerKey },
      ];
      const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner, sessionRow(leadKey, 'Lead thread', 'idle'),
        sessionRow(workerKey, 'Worker thread', 'working'), { ...owner, id: 'agent:shared-project', role: 'agent', name: 'Shared project', sessionKey: null }] }, snapshot, principal, {
        sourceEnabled: true, version, canReadSessions: true,
        runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'shared-project', isPrimary: false }],
        runtimeIdentitySessions,
        runtimeSessions: [runtimeSession(leadKey, 'native-a', 'succeeded'), runtimeSession(workerKey, 'native-b', 'running')],
      });
      assert.equal(projected.occupants.find(row => row.name === 'Lead')?.state, 'idle', `v${version} retains Lead's exact idle state`);
      assert.equal(projected.occupants.find(row => row.name === 'Worker')?.state, 'working', `v${version} retains Worker's exact running state`);
      assert.equal(projected.occupants.some(row => row.id === 'agent:shared-project'), false,
        `v${version} folds the generic project row into the exact distinct team sessions`);
      assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} OfficeVM schema`);
    }
  }
});

test('distinct registered session refs survive a temporarily reused Herdr pane reference', () => {
  const { build } = project();
  const base = build(project3x), owner = base.occupants.find(row => row.role === 'primary');
  const leadKey = 'private:session-lead', decorKey = 'private:session-decor';
  const snapshot = { observedAt: NOW, team: { id: 'team:synthetic' },
    agents: [{ id: 'pane-reused', role: 'delegate', status: 'working', observedAt: NOW, staleAfter: NOW + 60_000 }],
    identityLinks: [{ hostAgentId: 'pane-reused', agentId: 'decor-agent', confidence: 'exact', evidence: 'shared-runtime-session-ref' }], members: [
      { id: 'member:lead', name: 'Lead', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-reused' },
      { id: 'member:decor', name: 'Decor', roleKind: 'member', parentMemberId: 'member:lead', hostAgentId: 'pane-reused' },
      { id: 'member:unlinked', name: 'Unlinked', roleKind: 'member', parentMemberId: 'member:lead', hostAgentId: 'pane-reused' },
    ], privateMemberSessionKeys: { 'member:lead': leadKey, 'member:decor': decorKey },
    privateMemberSessionRefs: {
      'member:lead': { runtimeKind: 'claude-code', sessionRef: 'native-lead', sessionKey: leadKey, agentId: 'lead-agent' },
      'member:decor': { runtimeKind: 'codex', sessionRef: 'native-decor', sessionKey: decorKey, agentId: 'decor-agent' },
    } };
  const runtimeSession = key => ({ key, class: { kind: 'conversation', agentId: key === leadKey ? 'lead-agent' : 'decor-agent' },
    run: { status: key === leadKey ? 'succeeded' : 'running', evidenceLevel: 'verified', evidence: 'status-field', observedAt: NOW, expiresAt: NOW + 60_000 } });
  for (const members of [snapshot.members, [...snapshot.members].reverse()]) {
    const projected = projectOfficeTeamOccupants({ ...base, occupants: [owner] }, { ...snapshot, members },
      { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 }, { sourceEnabled: true, version: 3, canReadSessions: true,
        runtimeAgents: [{ id: 'coding-agent', isPrimary: true }, { id: 'lead-agent' }, { id: 'decor-agent' }],
        runtimeIdentitySessions: [
          { runtimeKind: 'claude-code', sessionRef: 'native-lead', sessionKey: leadKey, agentId: 'lead-agent' },
          { runtimeKind: 'codex', sessionRef: 'native-decor', sessionKey: decorKey, agentId: 'decor-agent' },
        ], runtimeSessions: [runtimeSession(leadKey), runtimeSession(decorKey)] });
    const lead = projected.occupants.find(row => row.name === 'Lead');
    const decor = projected.occupants.find(row => row.name === 'Decor');
    assert.ok(lead);
    assert.ok(decor, 'both exact members survive a reused pane reference');
    assert.equal(lead.state, 'idle', 'pane status linked to Decor never overwrites the lead session state');
    assert.equal(decor.state, 'working', 'the exact host link supplies status only to its matching member');
    assert.equal(decor.parentId, lead.id);
    const unlinked = projected.occupants.find(row => row.name === 'Unlinked');
    assert.equal(unlinked?.state, 'unknown', 'the pane status is not inferred for a colocated member without an exact session identity');
    assert.equal(unlinked?.hostAgentId, undefined);
  }
});

test('generic lead preserves the selected primary identity and only folds runtime-qualified duplicates', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const sharedKey = 'rt:openclaw:session:shared';
  const primaryRef = { runtimeKind: 'openclaw', sessionRef: 'primary-native-ref', sessionKey: sharedKey };
  for (const explicit of [true, false]) for (const [P, version, ownerId, ownerRole] of [
    [project2x, 2, 'main', 'main'], [project3x, 3, 'primary', 'primary'],
  ]) {
    const { build } = project();
    const base = build(P);
    const template = base.occupants.find(row => row.id === ownerId);
    const office = { ...base, occupants: [
      { ...template, name: 'Runtime owner', sessionKey: sharedKey },
      { ...template, id: 'agent:unrelated-agent', role: 'agent', name: 'Unrelated primary collision', sessionKey: sharedKey },
      { ...template, id: `duplicate:${version}`, role: version === 2 ? 'channel' : 'conversation', name: 'Duplicate session', sessionKey: sharedKey },
    ] };
    const members = [
      { id: 'member:lead', name: 'Project lead', ...(explicit ? { roleKind: 'lead' } : {}), roleLabel: 'lead', hostAgentId: 'pane-lead', parentMemberId: null },
      { id: 'member:child', name: 'Engineer', roleKind: 'member', roleLabel: 'engineer', hostAgentId: 'pane-child', parentMemberId: 'member:lead' },
    ];
    const snapshot = { observedAt: NOW, privateMemberSessionKeys: { 'member:lead': sharedKey },
      privateMemberSessionRefs: { 'member:lead': primaryRef }, members,
      agents: [{ id: 'pane-lead', role: 'primary', status: 'idle', observedAt: NOW, staleAfter: NOW + 60_000 },
        { id: 'pane-child', role: 'delegate', status: 'idle', observedAt: NOW, staleAfter: NOW + 60_000 }], identityLinks: [] };
    const projected = projectOfficeTeamOccupants(office, snapshot, principal, { sourceEnabled: true, version, canReadSessions: true,
      primaryAgentId: 'selected-primary', runtimeAgents: [{ id: 'selected-primary', isPrimary: true, mainSessionKey: sharedKey }, { id: 'unrelated-agent', isPrimary: false }],
      runtimeIdentitySessions: [
        { agentId: 'selected-primary', ...primaryRef },
        { agentId: 'unrelated-agent', runtimeKind: 'openclaw', sessionRef: 'other-native-ref', sessionKey: sharedKey },
      ], runtimeSessions: [{ key: sharedKey, class: { kind: 'conversation', agentId: 'selected-primary' }, run: { status: 'idle' } }],
    });
    assert.ok(projected.occupants.some(row => row.id === ownerId && row.name === 'Runtime owner'), `v${version} keeps the selected primary display name`);
    assert.ok(projected.occupants.some(row => row.id === 'agent:unrelated-agent'), `v${version} preserves an unrelated occupant sharing the key`);
    assert.equal(projected.occupants.some(row => row.id === `duplicate:${version}`), false, `v${version} folds the exact duplicate`);
    const child = projected.occupants.find(row => row.name === 'Engineer');
    assert.equal(child.parentId, ownerId, `v${version} derives and retains the generic lead lineage`);
    assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} OfficeVM schema`);
  }
});

test('a real engine resolves the selected primary session through its private native identity reference', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build, session } = project();
  const real = createEngine({ adapter: claudeDefinition, now: () => NOW });
  real.ingestCanonical('agents', [{ id: 'coding-agent', name: 'Coding agent', workspace: null, model: null, fallbackModels: [],
    isPrimary: true, mainSessionKey: session.key }]);
  real.setIdentitySessionRefs([{ sessionKey: session.key, sessionRef: 'native-pm-ref', agentId: 'coding-agent' }]);
  const host = { id: 'pane-pm', role: 'primary', status: 'working', observedAt: NOW, staleAfter: NOW + 30_000 };
  const snapshot = { observedAt: NOW, privateMemberSessionKeys: { 'member:pm': session.key },
    privateMemberSessionRefs: { 'member:pm': { runtimeKind: claudeDefinition.id, sessionRef: 'native-pm-ref', sessionKey: session.key } },
    members: [{ id: 'member:pm', name: 'PM', roleLabel: 'lead', hostAgentId: host.id },
      { id: 'member:builder', name: 'Engineer', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'member:pm', hostAgentId: 'pane-builder' }],
    agents: [host, { id: 'pane-builder', role: 'delegate', status: 'idle', observedAt: NOW, staleAfter: NOW + 30_000 }], identityLinks: [] };
  try {
    for (const [P, version, canonicalId, canonicalRole] of [[project2x, 2, 'main', 'main'], [project3x, 3, 'primary', 'primary']]) {
      const office = build(P);
      const duplicate = { ...office.occupants.find(row => row.id === canonicalId), id: `duplicate:${version}`, role: version === 2 ? 'channel' : 'conversation', sessionKey: session.key };
      const input = { ...office, occupants: office.occupants.map(row => row.id === canonicalId ? { ...row, sessionKey: session.key } : row).concat(duplicate) };
      const projected = projectOfficeTeamOccupants(input, snapshot, principal, { sourceEnabled: true, version, canReadSessions: true,
        runtimeAgents: real.agents(), primaryAgentId: real.primaryAgent().id,
        runtimeIdentitySessions: real.identitySessions('host'), runtimeSessions: [session] });
      const matching = projected.occupants.filter(row => row.sessionKey === session.key);
      assert.equal(matching.length, 1, `v${version} collapses same-runtime duplicate sessions`);
      assert.equal(matching[0].id, canonicalId);
      assert.equal(matching[0].role, canonicalRole);
      assert.equal(matching[0].name, office.occupants.find(row => row.id === canonicalId).name);
      assert.equal(validate(schemasFor(version).office, projected).ok, true, `v${version} schema`);
    }
  } finally { real.close(); }
});

test('live host idle status outlives session history, while an expired host lease is unknown', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build, session } = project({ primaryOwner: false });
  const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
  session.updatedAt = twoHoursAgo;
  session.run = { ...session.run, status: 'succeeded', evidence: 'terminal', evidenceLevel: 'verified',
    observedAt: twoHoursAgo, expiresAt: twoHoursAgo, startedAt: twoHoursAgo - 1000,
    endedAt: twoHoursAgo, hasActiveSubagentRun: false };
  const sessionRef = { runtimeKind: 'claude-code', sessionRef: 'synthetic', sessionKey: session.key };
  const host = { id: 'pane-builder', role: 'delegate', status: 'done', observedAt: NOW, staleAfter: NOW + 60_000 };
  const snapshot = { observedAt: NOW, revision: 1, tasks: [], agents: [host], identityLinks: [],
    members: [{ id: 'member:builder', name: 'Builder', roleKind: 'member', hostAgentId: host.id,
      parentMemberId: null }], privateMemberSessionKeys: { 'member:builder': session.key },
    privateMemberSessionRefs: { 'member:builder': sessionRef } };
  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    const base = build(P);
    const office = { ...base, occupants: base.occupants.map(row => row.id === 'agent:coding-agent'
      ? { ...row, state: 'unknown', execution: { status: 'unknown', evidence: { level: 'unknown', observedAt: null, expiresAt: null } } }
      : row) };
    assert.equal(office.occupants.find(row => row.id === 'agent:coding-agent')?.state, 'unknown',
      `the expired session-only terminal evidence starts unknown in v${version}`);
    const projectHost = (hostRow) => projectOfficeTeamOccupants(office, { ...snapshot, agents: [hostRow] }, principal, {
      sourceEnabled: true, version, canReadSessions: true,
      runtimeAgents: [{ id: 'coding-agent', isPrimary: false }],
      runtimeIdentitySessions: [{ agentId: 'coding-agent', sessionKey: session.key,
        runtimeKind: sessionRef.runtimeKind, sessionRef: sessionRef.sessionRef }],
      runtimeSessions: [session],
    }).occupants.find(row => row.name === 'Builder');

    const current = projectHost(host);
    assert.equal(current.execution.status, 'succeeded', `fresh host-reported done supplies current evidence in v${version}`);
    assert.equal(current.state, 'idle', `fresh host presence stays idle in v${version}`);
    assert.equal(current.execution.evidence.expiresAt, host.staleAfter);

    const gone = projectHost({ ...host, staleAfter: NOW - 1 });
    assert.equal(gone.execution.status, 'unknown', `expired host lease cannot inherit session-only idle in v${version}`);
    assert.equal(gone.state, 'unknown', `expired host lease is unknown in v${version}`);

    const waitingHost = projectHost({ ...host, status: 'waiting' });
    assert.equal(waitingHost.state, 'waiting', `live host-reported waiting is current even when transcript history is old in v${version}`);
    const expiredWaitingHost = projectHost({ ...host, status: 'waiting', staleAfter: NOW - 1 });
    assert.equal(expiredWaitingHost.execution.status, 'unknown', `expired waiting host lease is unknown in v${version}`);
    assert.equal(expiredWaitingHost.state, 'unknown', `expired waiting never remains on stage in v${version}`);
  }
});

test('newer Herdr activity confirms live runtime detail, idle bounds stale detail, and blocked stays blocked', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    const { build, session } = project({ primaryOwner: false });
    const base = build(P), primary = base.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary'));
    const member = { id: 'member:activity', name: 'Worker', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-activity' };
    const ref = { runtimeKind: 'claude-code', sessionRef: 'native-activity-session', sessionKey: session.key, agentId: 'coding-agent' };
    const runtimeIdentitySessions = [{ ...ref }];
    const runtimeAgent = { id: 'coding-agent', isPrimary: false };
    const projectState = (state, runtimeObservedAt, runtimeExpiresAt, hostStatus, observedAt) => {
      const runtimeRow = { ...primary, id: session.key, role: version === 2 ? 'channel' : 'session',
        roleLabel: { key: 'occupantRole.' + (version === 2 ? 'channel' : 'session') }, sessionKey: session.key,
        name: 'Runtime worker', state,
        execution: { status: 'running', evidence: { level: 'verified', observedAt: runtimeObservedAt, expiresAt: runtimeExpiresAt } } };
      const office = { ...base, occupants: [primary, runtimeRow] };
      return projectOfficeTeamOccupants(office, { observedAt, team: { id: 'team:activity' }, members: [member],
        privateMemberSessionKeys: { [member.id]: session.key }, privateMemberSessionRefs: { [member.id]: ref },
        agents: [{ id: 'pane-activity', role: 'delegate', status: hostStatus, observedAt, staleAfter: observedAt + 60_000 }],
        identityLinks: [{ hostAgentId: 'pane-activity', agentId: 'coding-agent', confidence: 'exact', evidence: 'shared-runtime-session-ref' }],
      }, principal, { sourceEnabled: true, version, canReadSessions: true, runtimeAgents: [runtimeAgent], runtimeIdentitySessions, runtimeSessions: [session] });
    };

    const thinking = projectState('thinking', NOW, NOW + 60_000, 'working', NOW + 1000);
    const thinkingRow = thinking.occupants.find(row => row.name === 'Worker');
    assert.equal(thinkingRow.state, 'thinking', `v${version} host running confirms fresh richer runtime state`);
    assert.equal(thinkingRow.stateLabel.key, 'agentState.thinking');

    const waiting = projectState('unknown', NOW - 60_000, NOW - 1, 'waiting', NOW + 1500);
    const waitingRow = waiting.occupants.find(row => row.name === 'Worker');
    assert.equal(waitingRow.state, 'waiting', `v${version} live orchestrator waiting is current regardless of session history`);
    assert.equal(waitingRow.execution.status, 'idle', `v${version} waiting is not active execution`);

    const staleTool = projectState('writing', NOW - 60_000, NOW - 1, 'idle', NOW + 2000);
    assert.equal(staleTool.occupants.find(row => row.name === 'Worker').state, 'idle', `v${version} stale runtime detail does not outlive host idle`);

    const blocked = projectState('working', NOW, NOW + 60_000, 'blocked', NOW + 3000);
    const blockedRow = blocked.occupants.find(row => row.name === 'Worker');
    assert.equal(blockedRow.state, 'blocked', `v${version} Herdr blocked status remains distinct`);
    assert.equal(blockedRow.stateLabel.key, 'agentState.blocked');
    assert.equal(validate(schemasFor(version).office, blocked).ok, true, `v${version} blocked OfficeVM schema`);
  }
});

test('host lease resolves missing-base members, but a newer runtime observation wins', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build, session } = project({ primaryOwner: false });
  const sessionRef = { runtimeKind: 'claude-code', sessionRef: 'synthetic', sessionKey: session.key };
  const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
  session.updatedAt = twoHoursAgo;
  session.run = { ...session.run, status: 'succeeded', evidence: 'status-field', evidenceLevel: 'verified',
    observedAt: twoHoursAgo, expiresAt: twoHoursAgo, startedAt: twoHoursAgo - 1000, endedAt: twoHoursAgo };
  const oldTerminalRun = session.run;
  const host = { id: 'pane-builder', role: 'delegate', status: 'done', observedAt: NOW, staleAfter: NOW + 60_000 };
  const snapshot = { observedAt: NOW, revision: 1, tasks: [], agents: [host], identityLinks: [],
    members: [{ id: 'member:builder', name: 'Builder', roleKind: 'member', hostAgentId: host.id,
      parentMemberId: null }], privateMemberSessionKeys: { 'member:builder': session.key },
    privateMemberSessionRefs: { 'member:builder': sessionRef } };

  for (const [P, version] of [[project2x, 2], [project3x, 3]]) {
    session.updatedAt = twoHoursAgo; session.run = oldTerminalRun;
    const base = build(P);
    const missingBase = { ...base, occupants: base.occupants.filter(row => row.id !== 'agent:coding-agent') };
    const projectMember = (office, hostRow, runtimeSession = session) => projectOfficeTeamOccupants(office,
      { ...snapshot, agents: [hostRow] }, principal, { sourceEnabled: true, version, canReadSessions: true,
        runtimeAgents: [{ id: 'coding-agent', isPrimary: false }],
        runtimeIdentitySessions: [{ agentId: 'coding-agent', ...sessionRef }], runtimeSessions: [runtimeSession] });

    const fallback = projectMember(missingBase, host);
    const synthesized = fallback.occupants.find(row => row.name === 'Builder');
    assert.equal(synthesized.state, 'idle', `fresh host lease wins over old fallback session in v${version}`);
    assert.equal(synthesized.stateSince, NOW);
    assert.equal(validate(schemasFor(version).office, fallback).ok, true, `missing-row fallback validates in v${version}`);
    const expired = projectMember(missingBase, { ...host, staleAfter: NOW - 1 });
    assert.equal(expired.occupants.find(row => row.name === 'Builder').state, 'unknown', `expired host is unknown in v${version}`);
    assert.equal(validate(schemasFor(version).office, expired).ok, true, `expired-host fallback validates in v${version}`);

    const runtimeAtNow = { ...session, updatedAt: NOW, run: { ...session.run, status: 'running', evidence: 'status-field',
      evidenceLevel: 'verified', observedAt: NOW, expiresAt: NOW + 120_000, endedAt: null } };
    session.updatedAt = runtimeAtNow.updatedAt; session.run = runtimeAtNow.run;
    const currentBase = build(P);
    const olderDoneHost = { ...host, status: 'done', observedAt: NOW - 10_000, staleAfter: NOW + 120_000 };
    const newerRun = projectMember(currentBase, olderDoneHost, runtimeAtNow);
    const running = newerRun.occupants.find(row => row.name === 'Builder');
    assert.equal(running.state, 'working', `newer verified runtime activity outranks older host done in v${version}`);
    assert.equal(running.execution.status, 'running');
    assert.equal(validate(schemasFor(version).office, newerRun).ok, true, `newer-run projection validates in v${version}`);
    const expiredOlderHost = projectMember(currentBase, { ...olderDoneHost, staleAfter: NOW - 1 }, runtimeAtNow);
    assert.equal(expiredOlderHost.occupants.find(row => row.name === 'Builder').state, 'working',
      `expired host observation cannot erase newer runtime evidence in v${version}`);
  }
});

test('same-state host refreshes preserve idle age through placement for registered and unregistered occupants', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const { build } = project({ primaryOwner: true });
  const base = build(project3x);
  const defaults = officeDefaults();
  const tracked = new Map(['registered', 'unregistered'].map(kind => [kind, createStateTracker()]));
  const makeSnapshot = (kind, at, status = 'done') => {
    const hostAgentId = `pane-${kind}`;
    const host = { id: hostAgentId, role: 'delegate', status, observedAt: at, staleAfter: at + 30_000 };
    const member = kind === 'registered' ? [{ id: 'member:registered', name: 'Registered', roleKind: 'lead',
      parentMemberId: null, hostAgentId }] : [];
    return { snapshot: { observedAt: at, revision: at, team: { id: 'team:fixture' }, members: member, agents: [host],
      identityLinks: kind === 'registered' ? [] : [{ agentId: 'runtime-peer', hostAgentId, confidence: 'exact', evidence: 'explicit-runtime-identity' }] },
      options: { sourceEnabled: true, version: 3, canReadSessions: false,
        runtimeAgents: kind === 'registered' ? [] : [{ id: 'runtime-peer', isPrimary: false }] },
      id: kind === 'registered' ? 'team-member:member:registered' : 'agent:runtime-peer' };
  };
  const projectAt = (kind, at, status = 'done') => {
    const input = makeSnapshot(kind, at, status);
    const office = projectOfficeTeamOccupants(base, input.snapshot, principal, { ...input.options, tracker: tracked.get(kind) });
    const placed = projectOfficePlacement(office, { layout: defaults.layout, index: defaults.index, now: at, tracker: tracked.get(kind) });
    return placed.occupants.find(row => row.id === input.id);
  };

  for (const kind of ['registered', 'unregistered']) {
    const first = projectAt(kind, NOW);
    assert.equal(first.state, 'idle');
    assert.equal(first.stateSince, NOW);
    assert.equal(first.activity, null);
    const refreshed = projectAt(kind, NOW + 2 * 60 * 60_000);
    assert.equal(refreshed.state, 'idle');
    assert.equal(refreshed.stateSince, NOW, `${kind} same-state receipt refresh preserves state entry`);
    assert.ok(refreshed.activity, `${kind} host-reported idle is eligible after the threshold`);
    const working = projectAt(kind, NOW + 2 * 60 * 60_000 + 1000, 'working');
    assert.equal(working.stateSince, NOW + 2 * 60 * 60_000 + 1000);
    assert.equal(working.activity, null, 'a current working report clears idle relocation');
    const idleAgain = projectAt(kind, NOW + 2 * 60 * 60_000 + 2000, 'done');
    assert.equal(idleAgain.stateSince, NOW + 2 * 60 * 60_000 + 2000, 'idle transition starts a fresh threshold');
    assert.equal(idleAgain.activity, null);
  }
});

test('a newer runtime state resets host idle age before a later host idle report', () => {
  const principal = { id: 'synthetic-admin', role: 'admin', permissionRevision: 1 };
  const tracker = createStateTracker();
  const { build } = project({ primaryOwner: false });
  const base = build(project3x);
  const sessionKey = 'rt:codex:session:host-transition';
  const ref = { runtimeKind: 'codex', sessionRef: 'native-host-transition', sessionKey, agentId: 'runtime-peer' };
  const member = { id: 'member:host-transition', name: 'Host member', roleKind: 'lead', parentMemberId: null, hostAgentId: 'pane-transition' };
  const makeOffice = (runtimeState, evidenceAt) => ({ ...base, occupants: base.occupants.concat([{
    ...base.occupants[0], id: 'agent:runtime-peer', role: 'agent', name: 'Runtime peer', sessionKey,
    state: runtimeState, stateSince: evidenceAt,
    execution: { status: runtimeState === 'working' ? 'running' : 'unknown', evidence: {
      level: runtimeState === 'working' ? 'verified' : 'unknown', observedAt: runtimeState === 'working' ? evidenceAt : null,
      expiresAt: runtimeState === 'working' ? evidenceAt + 60_000 : null } },
  }]) });
  const projectAt = (snapshotAt, hostAt, runtimeState, evidenceAt) => projectOfficeTeamOccupants(makeOffice(runtimeState, evidenceAt), {
    observedAt: snapshotAt, revision: snapshotAt, team: { id: 'team:fixture' }, members: [member],
    privateMemberSessionKeys: { [member.id]: sessionKey }, privateMemberSessionRefs: { [member.id]: ref },
    agents: [{ id: member.hostAgentId, role: 'delegate', status: 'done', observedAt: hostAt, staleAfter: snapshotAt + 60_000 }],
    identityLinks: [],
  }, principal, { sourceEnabled: true, version: 3, canReadSessions: true,
    runtimeAgents: [{ id: 'runtime-peer', isPrimary: false }], runtimeIdentitySessions: [{ ...ref }], tracker });

  const first = projectAt(NOW, NOW, 'unknown', NOW);
  assert.equal(first.occupants.find(row => row.name === 'Host member').stateSince, NOW);
  const runtimeWorking = projectAt(NOW + 1000, NOW, 'working', NOW + 1000);
  const runtimeRow = runtimeWorking.occupants.find(row => row.name === 'Host member');
  assert.equal(runtimeRow.state, 'working');
  assert.equal(runtimeRow.stateSince, NOW + 1000);
  const hostIdleAgain = projectAt(NOW + 2000, NOW + 2000, 'working', NOW + 1000);
  const idleRow = hostIdleAgain.occupants.find(row => row.name === 'Host member');
  assert.equal(idleRow.state, 'idle');
  assert.equal(idleRow.stateSince, NOW + 2000, 'the effective state transition starts a new idle interval');
});

test('a missing runtime primary still gets a valid durable automatic-look identity', () => {
  const { engine, build } = project();
  const unavailable = { ...engine, agents: () => [], primaryAgent: () => null };
  const identities = [];
  const vm = buildOfficeVM({ engine: unavailable, now: NOW, tracker: createStateTracker(), canReadSessions: true,
    P: project2x, names: { agentName: () => null }, actorOf: () => ({ kind: 'system', name: 'System' }),
    assignLook: id => { identities.push(id); return null; } });
  assert.equal(validate(schemasFor(2).office, vm).ok, true);
  assert.ok(identities.every(id => id !== 'primary'));
  assert.ok(identities.includes('agent:main'));
});
