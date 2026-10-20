'use strict';
// T-0062 P0 slice: OccupantVM.parentId for every occupant whose canonical session has a parent — sub-agents through
// parentKey or the parent's childKeys, and the main agent's DMs, groups and conversations under the main agent.
// Generic (canonical sessions only), gated like the other session fields, valid in 2.x and 3.0. Synthetic data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project3x } = require('../../src/api/v2/project3x');
const { project2x } = require('../../src/api/v2/project2x');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');
const { projectOfficeRoster, projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const { projectOfficeRoster: projectEngineOfficeRoster } = require('../../src/engine/office/roster');
const { officeDefaults } = require('../../src/api/v2/vm/office');

const NOW = 1791600000000;
const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
const running = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: null, startedAt: NOW - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null };
const session = (key, kind, cls = {}, extra = {}) => ({ key, sessionId: null, class: { kind, ruleId: 'synthetic', agentId: 'main', channel: null, heartbeatOf: null, background: false, rawClassification: null, ...cls },
  displayName: null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW, run: running,
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: kind !== 'primary', group: null, ...extra });

function office() {
  const e = createEngine({ adapter, now: () => NOW, primary: 'main' });
  e.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'agent:main:main' }]);
  e.ingestCanonical('sessions.snapshot', [
    // the main session lists one sub-agent in childKeys (OpenClaw shape: the child has no parentKey)
    session('agent:main:main', 'primary', {}, { childKeys: ['agent:main:subagent:aaa'] }),
    session('agent:main:subagent:aaa', 'subagent', { subagentId: 'aaa' }),
    session('agent:main:discord:direct:100000000000000001', 'conversation-direct', { channel: 'discord', interlocutorId: 'discord-user:100000000000000001' }),
    session('agent:main:discord:channel:100000000000000002', 'conversation-group', { channel: 'discord', interlocutorId: 'discord-channel:100000000000000002' }),
    // a sub-agent launched from the DM: its parentKey names the DM session, which is on stage
    session('agent:main:subagent:bbb', 'subagent', { subagentId: 'bbb' }, { parentKey: 'agent:main:discord:direct:100000000000000001' }),
    // critic-237: a running scheduled task of the main agent is not one of its team
    session('agent:main:cron:job-1', 'scheduled', { cronJobId: 'job-1' }),
  ]);
  e.setGatewayConnected(true);
  return (canReadSessions, P = project3x) => buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), canReadSessions, actorOf: () => ({ kind: 'system', name: 'System' }), P });
}

test('3.0: sub-agents and the main agent\'s conversations name their parent occupant', () => {
  const vm = office()(true);
  const byKey = Object.fromEntries(vm.occupants.map(o => [o.sessionKey, o]));
  assert.equal(byKey['agent:main:subagent:aaa'].parentId, 'primary', 'childKeys of the main session');
  assert.equal(byKey['agent:main:discord:direct:100000000000000001'].parentId, 'primary', 'a DM sits under its agent');
  assert.equal(byKey['agent:main:discord:channel:100000000000000002'].parentId, 'primary', 'a group sits under its agent');
  assert.equal(byKey['agent:main:subagent:bbb'].parentId, byKey['agent:main:discord:direct:100000000000000001'].id, 'parentKey wins: the DM it was launched from');
  assert.equal(byKey['agent:main:main'].parentId, null, 'the main agent has an explicit empty parent');
  assert.ok(byKey['agent:main:cron:job-1'], 'the scheduled task is on stage'); assert.equal(byKey['agent:main:cron:job-1'].parentId, null, 'no owning-agent fallback for a scheduled task');
  const ids = new Set(vm.occupants.map(o => o.id));
  for (const o of vm.occupants) if (o.parentId) { assert.ok(ids.has(o.parentId), `${o.id}: parent on stage`); assert.notEqual(o.parentId, o.id); }
  // the roster reads as a team: each spawned sub-agent is listed right after its parent occupant
  const order = vm.occupants.map(o => o.id);
  for (const o of vm.occupants.filter(o => o.role === 'subagent' && o.parentId)) assert.equal(order[order.indexOf(o.id) - 1] === o.parentId || vm.occupants[order.indexOf(o.id) - 1].parentId === o.parentId, true, `${o.id} follows ${o.parentId}: ${order}`);
  assert.equal(validate(schemasFor(3).office, vm).ok, true);
});

test('2.x: the same links with 2.x occupant ids, schema-valid', () => {
  const vm = office()(true, project2x);
  const sub = vm.occupants.find(o => o.sessionKey === 'agent:main:subagent:aaa');
  assert.equal(sub.parentId, 'main');
  assert.equal(validate(schemasFor(2).office, vm).ok, true);
});

test('gateway-level subagent lineage falls back to its primary owner, with a localized generic label (v2 and v3)', async () => {
  const { displayName } = await import('../../public/v2/office/names.js');
  const e = createEngine({ adapter, now: () => NOW, primary: 'main' });
  e.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'agent:main:main' }]);
  e.ingestCanonical('sessions.snapshot', [
    session('agent:main:main', 'primary'),
    // The gateway parent is transport lineage, not a session rendered in the office.
    session('agent:main:subagent:gateway-child', 'subagent', { subagentId: 'gateway-child', agentId: 'main' }, { parentKey: 'gateway:subagent:gateway-child' }),
    // An adapter-provided task label remains the occupant name when available.
    session('agent:main:subagent:labelled-child', 'subagent', { subagentId: 'labelled-child', agentId: 'main' }, { parentKey: 'gateway:subagent:labelled-child', label: 'Index the repository' }),
  ]);
  e.setGatewayConnected(true);
  for (const P of [project2x, project3x]) {
    const vm = buildOfficeVM({ engine: e, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const primary = vm.occupants.find(row => row.role === (P.version === 2 ? 'main' : 'primary'));
    const generic = vm.occupants.find(row => row.sessionKey === 'agent:main:subagent:gateway-child');
    const labelled = vm.occupants.find(row => row.sessionKey === 'agent:main:subagent:labelled-child');
    assert.equal(generic.parentId, primary.id, `v${P.version}: unresolved gateway parent falls back to the owning primary`);
    assert.equal(generic.title.key, 'occupantRole.subagent', `v${P.version}: generic label is localized by the client locale`);
    assert.equal(generic.roleLabel, null, `v${P.version}: backend omits a role label that duplicates the generic name`);
    assert.equal(generic.name, '', `v${P.version}: no server-language generic literal overrides the viewer locale`);
    assert.equal(displayName(generic, { title: 'Sub-agent', titleSource: 'Sous-agent' }), 'Sub-agent',
      `v${P.version}: English client uses its localized LabelRef rather than a French literal`);
    const withoutLabelRef = displayName(generic, { title: null, titleSource: null });
    assert.ok(withoutLabelRef.trim(), `v${P.version}: the client never renders a blank label`);
    assert.notEqual(withoutLabelRef, 'Sub-agent', `v${P.version}: removing the LabelRef renderer fails the English label assertion`);
    assert.notEqual(withoutLabelRef, 'Sous-agent', `v${P.version}: removing the LabelRef renderer fails the French label assertion`);
    assert.equal(labelled.parentId, primary.id, `v${P.version}: task-labelled subagent remains under its primary`);
    assert.equal(labelled.name, 'Index the repository', `v${P.version}: adapter task label is preferred`);
    assert.equal(labelled.title.key, 'sessionTitle.named');
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
  }
});

test('without the sessions read grant the backend emits explicit empty parents', () => {
  const vm = office()(false);
  assert.ok(vm.occupants.every(o => o.parentId === null));
  assert.equal(validate(schemasFor(3).office, vm).ok, true);
});

test('OfficeVM supplies the ordered roster tree and floor aggregates to every client', () => {
  for (const P of [project2x, project3x]) {
    const vm = office()(true, P);
    assert.deepEqual(vm.occupants.map(row => row.rosterOrder), vm.occupants.map((_row, index) => index));
    for (const row of vm.occupants) {
      assert.ok(Object.hasOwn(row, 'parentId'));
      assert.ok(Object.hasOwn(row, 'teamId'));
      assert.ok(Object.hasOwn(row, 'groupId'));
      assert.ok(Object.hasOwn(row, 'floorId'));
      assert.ok(row.stateLabel?.key);
      if (row.parentId) assert.ok(vm.occupants.some(parent => parent.id === row.parentId));
    }
    const visitingHosts = new Map((vm.visitIntent?.visitors || []).filter(visitor => visitor.hostId).map(visitor => [visitor.id, visitor.hostId]));
    for (const id of vm.conversationIds) {
      const row = vm.occupants.find(item => item.id === id);
      const visitHost = visitingHosts.get(id);
      if (visitHost) {
        assert.equal(row?.parentId, visitHost, 'an active human visit nests under its exact host');
        const host = vm.occupants.find(item => item.id === visitHost);
        assert.equal(row?.rosterDepth, host?.floorId === row?.floorId ? host.rosterDepth + 1 : 1,
          'same-floor visits follow the host tree; cross-floor visits use the explicit team header');
      } else assert.equal(row?.rosterDepth, 0, 'non-visiting conversation lineage is not presented as a spawned member');
    }
    for (const group of vm.rosterGroups) {
      assert.equal(group.occupantIds[0], group.rootId);
      assert.equal(group.count, group.occupantIds.length - 1);
      assert.ok(group.occupantIds.slice(1).every(id => vm.occupants.find(row => row.id === id)?.groupId === group.rootId));
    }
    const agentCount = vm.occupants.filter(row => !row.visitPhase).length;
    assert.equal(vm.rosterFloors.reduce((count, floor) => count + floor.count, 0), agentCount,
      'floor count labels count agents, excluding people who are visiting');
    assert.equal(vm.rosterFloors.reduce((count, floor) => count + floor.occupantIds.length, 0), vm.occupants.length,
      'all occupants including visiting people remain present in floor rosters');
    assert.equal(vm.rosterSummary.count, agentCount, 'the mobile “in office” count describes agents, not visiting people');
    assert.equal(vm.rosterSummary.count, vm.rosterFloors.reduce((count, floor) => count + floor.count, 0));
    assert.equal(vm.rosterSummary.activeCount, vm.kpis.find(row => row.id === 'active').value,
      'mobile summary and the active KPI share unknown-state handling');
    assert.equal(vm.rosterItems.reduce((count, item) => count + item.occupantIds.length, 0),
      vm.occupants.length - vm.conversationIds.length + visitingHosts.size,
      'active visiting conversations join their host group; other conversations stay in their separate view');
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
  }
});

test('activity targets and travel intents validate in both OfficeVM contracts', () => {
  const defaults = officeDefaults();
  for (const P of [project2x, project3x]) {
    const vm = office()(true, P);
    const occupants = vm.occupants.map(row => ({ ...row, state: 'idle', stateSince: NOW - 60 * 60_000 }));
    const placed = projectOfficePlacement({ ...vm, occupants }, { layout: defaults.layout, index: defaults.index, now: NOW, tracker: createStateTracker() });
    assert.ok(placed.occupants.some(row => row.activity), `v${P.version} assigns a declared activity`);
    const workers = placed.occupants.filter(row => ['primary', 'main', 'agent', 'subagent', 'host', 'team-host', 'member', 'team-member'].includes(row.role));
    assert.ok(workers.every(row => row.homeTarget && row.sceneTarget && Object.hasOwn(row, 'sceneTravel')));
    const checked = validate(schemasFor(P.version).office, placed);
    assert.equal(checked.ok, true, `v${P.version} OfficeVM: ${JSON.stringify(checked.issues)}`);
  }
});

test('roster preview and activity uncertainty are backend-projected without client counting', () => {
  const projected = projectOfficeRoster({ occupants: [
    { id: 'lead', role: 'primary', state: 'working', name: 'Lead', floorId: '1' },
    { id: 'one', role: 'subagent', parentId: 'lead', state: 'working', floorId: '1' },
    { id: 'two', role: 'subagent', parentId: 'lead', state: 'idle', floorId: '1' },
    { id: 'three', role: 'subagent', parentId: 'lead', floorId: '1' },
  ] });
  const item = projected.rosterPreviewItems[0];
  assert.equal(item.isGroup, true);
  assert.deepEqual(item.previewOccupantIds, ['lead', 'one', 'two']);
  assert.equal(item.overflowCount, 1);
  assert.equal(projected.rosterGroups[0].activeCount, null);
  assert.equal(projected.rosterFloors[0].activeCount, null);
  assert.equal(projected.occupants.find(row => row.id === 'three').state, 'unknown');
  assert.equal(projected.rosterFloors[0].statusLabel.key, 'office.floor.activityUnknown');

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/manifest.example.json')));
  const index = Object.fromEntries(['rooms', 'furniture', 'characters', 'accessories', 'themes'].map(key => [key,
    new Map(manifest[key].map(row => [row.id, row]))]));
  index.manifest = manifest;
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/layout.example.json')));
  const placed = projectOfficePlacement({ occupants: [
    { id: 'quiet-lead', role: 'primary', state: 'idle', floorId: '1' },
    { id: 'uncertain-child', role: 'subagent', parentId: 'quiet-lead', state: 'unknown', floorId: '1' },
  ] }, { layout, index });
  assert.equal(placed.rosterFloors.find(floor => floor.id === '1')?.activeCount, null, 'unknown execution cannot inflate a placed floor count');
});

test('team placement keeps members on the lead floor and cross-floor roster entries get an explicit header', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/manifest.example.json')));
  const index = Object.fromEntries(['rooms', 'furniture', 'characters', 'accessories', 'themes'].map(key => [key,
    new Map(manifest[key].map(row => [row.id, row]))]));
  index.manifest = manifest;
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/layout.example.json')));
  const pinnedMainLayout = { ...layout, agents: layout.agents.map(rule => rule.agentId === 'main' ? { ...rule, homeFloor: '2' } : rule) };
  const pinnedLeadLayout = { ...layout, agents: [...layout.agents,
    { agentId: 'agent:pm', match: { kind: 'agent' }, character: 'subagent', variant: 'teal', accessories: [],
      name: null, role: null, station: 'auto', homeFloor: '2', appearance: 'auto' }] };
  const crowdedTeam = projectOfficePlacement({ occupants: [
    { id: 'primary', role: 'primary', state: 'working', name: 'Lead', teamId: 'team:synthetic', floorId: '2' },
    { id: 'member:backend', role: 'subagent', state: 'working', name: 'Builder', teamId: 'team:synthetic', parentId: 'primary', floorId: '1' },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `agent:pressure-${index}`, role: 'agent', state: 'idle', name: `Worker ${index}`, floorId: '1' })),
  ] }, { layout: pinnedMainLayout, index });
  const lead = crowdedTeam.occupants.find(row => row.id === 'primary');
  const member = crowdedTeam.occupants.find(row => row.id === 'member:backend');
  assert.equal(lead.floorId, '2', 'the lead retains its configured second-floor placement');
  assert.equal(member.floorId, lead.floorId, 'desk pressure cannot separate a team member from its lead');

  const liveTeam = projectOfficePlacement({ occupants: [
    { id: 'primary', role: 'primary', state: 'idle', name: 'Owner', floorId: '1' },
    { id: 'agent:pm', role: 'agent', state: 'idle', name: 'Lead', teamId: 'team:synthetic', floorId: '2' },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `member:${index}`, role: 'subagent', state: 'working',
      name: `Builder ${index}`, teamId: 'team:synthetic', parentId: 'agent:pm', floorId: '1' })),
  ] }, { layout: pinnedLeadLayout, index });
  const floorOneIds = liveTeam.rosterFloors.find(row => row.id === '1').occupantIds;
  const floorTwoIds = liveTeam.rosterFloors.find(row => row.id === '2').occupantIds;
  assert.deepEqual(floorOneIds, ['primary'], 'team members are not rendered beneath the unrelated floor-one owner');
  assert.deepEqual(floorTwoIds, ['agent:pm', 'member:0', 'member:1', 'member:2', 'member:3'],
    'the lead and all four working members occupy floor two together');

  const overflowTeam = projectOfficePlacement({ occupants: [
    { id: 'agent:pm', role: 'agent', state: 'idle', name: 'Lead', teamId: 'team:synthetic', floorId: '2' },
    ...Array.from({ length: 20 }, (_, index) => ({ id: `overflow:${index}`, role: 'subagent', state: 'working',
      name: `Worker ${index}`, teamId: 'team:synthetic', parentId: 'agent:pm', floorId: '1' })),
  ] }, { layout: pinnedLeadLayout, index });
  assert.ok(overflowTeam.unseatedTeams.some(team => team.parentId === 'agent:pm' && team.floorId === '2'),
    'overflow is reported against the lead floor');
  assert.ok(overflowTeam.occupants.filter(row => row.id.startsWith('overflow:')).every(row => row.floorId === '2'),
    'desk overflow never moves team members to another floor');
  assert.ok(overflowTeam.occupants.some(row => row.id.startsWith('overflow:') && row.standingPoint),
    'overflow members stand at planner-provided positions near their team');

  const forcedCrossFloor = projectOfficeRoster({ occupants: [
    { id: 'lead', role: 'primary', state: 'working', name: 'PM', floorId: '2' },
    { id: 'child', role: 'subagent', state: 'working', name: 'Builder', parentId: 'lead', teamId: 'team:synthetic', floorId: '1' },
    { id: 'unrelated', role: 'agent', state: 'idle', name: 'Unrelated', floorId: '1' },
  ] });
  const floorOne = forcedCrossFloor.rosterFloors.find(row => row.id === '1');
  assert.deepEqual(floorOne.items.map(item => item.kind === 'team-header' ? item.kind : item.occupantId),
    ['team-header', 'child', 'unrelated'], 'a cross-floor team header precedes its member, never an unrelated root');
  assert.equal(floorOne.items[0].label.key, 'office.floor.team');
  assert.equal(floorOne.items[0].label.params.name, 'PM');
  assert.equal(forcedCrossFloor.occupants.find(row => row.id === 'child').rosterDepth, 1);
});

test('office roster nests a visiting contact under the exact addressed agent with the supplied visit label', () => {
  const projected = projectOfficeRoster({ occupants: [
    { id: 'primary', role: 'primary', state: 'working', name: 'Atlas', floorId: '2' },
    { id: 'agent:worker', role: 'agent', state: 'working', name: 'Worker', parentId: 'primary', floorId: '2' },
    { id: 'contact', role: 'direct', state: 'working', name: 'Contact', parentId: 'agent:worker', floorId: '2',
      visitPhase: 'linger', visitLabel: { key: 'office.visitingWith', params: { name: 'Worker' } } },
  ] });
  const visitor = projected.occupants.find(row => row.id === 'contact');
  assert.equal(visitor.parentId, 'agent:worker');
  assert.equal(visitor.rosterDepth, 2, 'the visitor stays below its exact host in the full parent tree');
  assert.equal(visitor.parentName, null, 'a visit parent is not described as a launcher');
  assert.deepEqual(visitor.roleLabel, { key: 'occupantRole.visitor' });
  assert.deepEqual(visitor.stateLabel, { key: 'occupantRole.visitor' });
  assert.equal(visitor.stateKind, 'visitor');
  assert.equal(visitor.stateActive, false, 'visiting people use their own badge rather than agent activity styling');
  assert.deepEqual(projected.rosterSummary, { count: 2, activeCount: 2 }, 'visitors stay in the roster but do not inflate agent activity');
  const floor = projected.rosterFloors.find(row => row.id === '2');
  assert.equal(floor.count, 2, 'floor agent count excludes a visiting person');
  assert.equal(floor.activeCount, 2, 'floor active count excludes a visiting person');
  assert.equal(visitor.groupId, 'primary', 'mobile team grouping follows the existing primary-rooted roster tree');
  assert.deepEqual(projected.rosterFloors.find(row => row.id === '2').items.map(row => row.occupantId), ['primary', 'agent:worker', 'contact']);
  const mobileGroup = projected.rosterItems.find(row => row.rootId === 'primary');
  assert.deepEqual(mobileGroup.occupantIds, ['primary', 'agent:worker', 'contact'], 'the mobile group includes the visit under its exact host lineage');
  assert.deepEqual(mobileGroup.childIds, ['agent:worker', 'contact']);
  assert.deepEqual(mobileGroup.openLabel, { key: 'office.mobile.openTeam', params: { name: 'Atlas', n: 1 } },
    'the subagent count excludes visiting people');
  assert.deepEqual(mobileGroup.delegatesLabel, { key: 'office.mobile.delegates', params: { n: 1 } },
    'the delegated-agent label counts only agents, not a visiting person');
  assert.deepEqual(mobileGroup.teamLabel, { key: 'office.mobile.team', params: { name: 'Atlas' } });
  assert.deepEqual(visitor.visitLabel, { key: 'office.visitingWith', params: { name: 'Worker' } });
});

test('visitor role labels override only human direct contacts, preserving coding and channel labels', () => {
  const occupants = [
    { id: 'primary', role: 'primary', state: 'working', name: 'Atlas', floorId: '1' },
    { id: 'human', role: 'direct', state: 'working', name: 'Riley', parentId: 'primary', floorId: '1',
      roleLabel: { key: 'occupantRole.direct' }, visitPhase: 'person' },
    { id: 'coding', role: 'conversation', state: 'working', name: 'Build task', parentId: 'primary', floorId: '1',
      roleLabel: { key: 'occupantRole.session', params: { provider: 'Claude Code' } }, visitPhase: 'agent' },
    { id: 'group', role: 'group', state: 'working', name: 'Team channel', parentId: 'primary', floorId: '1',
      roleLabel: { key: 'occupantRole.group' }, visitPhase: 'agent' },
    { id: 'channel', role: 'channel', state: 'working', name: 'Project channel', parentId: 'primary', floorId: '1',
      roleLabel: { key: 'occupantRole.channel' }, visitPhase: 'agent' },
  ];
  for (const project of [projectOfficeRoster, projectEngineOfficeRoster]) {
    const rows = new Map(project({ occupants }).occupants.map(row => [row.id, row]));
    assert.deepEqual(rows.get('human').roleLabel, { key: 'occupantRole.visitor' });
    assert.deepEqual(rows.get('coding').roleLabel, { key: 'occupantRole.session', params: { provider: 'Claude Code' } });
    assert.deepEqual(rows.get('group').roleLabel, { key: 'occupantRole.group' });
    assert.deepEqual(rows.get('channel').roleLabel, { key: 'occupantRole.channel' });
  }
});

test('backend projects visitor phase, state, on-stage membership and expiry intent', () => {
  const tracker = createStateTracker();
  const rows = [
    { id: 'lead', role: 'primary', state: 'working', stateSince: NOW - 1000 },
    { id: 'person', role: 'direct', parentId: 'lead', state: 'working', stateSince: NOW - 5000, visitPendingAt: NOW - 1000, exchanges: { recent: 1, lastAt: NOW - 5000 } },
    { id: 'agent', role: 'direct', parentId: 'lead', state: 'working', stateSince: NOW - 5000, exchanges: { recent: 2, lastAt: NOW - 5000 } },
    { id: 'linger', role: 'group', parentId: 'lead', state: 'idle', stateSince: NOW - 5000, exchanges: { recent: 0, lastAt: NOW - 5000 } },
    { id: 'gone', role: 'direct', parentId: 'lead', state: 'idle', stateSince: NOW - 120_000, exchanges: { recent: 0, lastAt: NOW - 120_000 } },
  ];
  const vm = tracker.visitRows(rows, NOW, 3);
  const byId = Object.fromEntries(vm.occupants.map(row => [row.id, row]));
  assert.equal(byId.person.visitPhase, 'person');
  assert.equal(byId.person.state, 'working');
  assert.equal(byId.agent.visitPhase, 'agent');
  assert.equal(byId.agent.state, 'working', 'visit phase is separate from canonical execution state');
  assert.deepEqual(byId.agent.visitStateLabel, { key: 'agentState.working' });
  assert.equal(byId.linger.visitPhase, 'linger');
  assert.equal(byId.linger.state, 'idle');
  assert.equal(byId.gone, undefined);
  assert.deepEqual(vm.visitIntent.visitors.map(row => [row.id, row.phase, row.onStage]), [
    ['person', 'person', true], ['agent', 'agent', true], ['linger', 'linger', true],
  ]);
  assert.equal(vm.visitIntent.meeting.includes('lead'), true);
  assert.equal(vm.visitIntent.until, NOW + 11_000);

  const expired = tracker.visitRows([{ ...rows[0] }, { ...rows[3] }], NOW + 61_000, 3);
  assert.deepEqual(expired.occupants.map(row => row.id), ['lead']);
  assert.deepEqual(expired.visitIntent.visitors, []);

  const departedTracker = createStateTracker();
  departedTracker.visitRows([rows[0], { ...rows[1], exchanges: null }], NOW, 3);
  const departed = departedTracker.visitRows([rows[0]], NOW + 5_000, 3);
  assert.equal(departed.occupants.find(row => row.id === 'person')?.visitPhase, 'linger');
  assert.equal(departed.visitIntent.until, NOW + 60_000);
  assert.equal(departedTracker.visitRows([rows[0]], NOW + 60_001, 3).occupants.some(row => row.id === 'person'), false);
});

test('visitors follow the exact owning agent, retain that parent through linger, and expose grouped visit intent', () => {
  const tracker = createStateTracker();
  const rows = [
    { id: 'primary', role: 'primary', name: 'Primary', state: 'working' },
    { id: 'agent:worker', role: 'agent', name: 'Worker', state: 'working' },
    { id: 'contact', role: 'direct', name: 'Contact', parentId: 'agent:worker', state: 'working',
      visitPendingAt: NOW - 1000, exchanges: { recent: 1, lastAt: NOW - 500 } },
  ];
  const current = tracker.visitRows(rows, NOW, 3);
  const visitor = current.occupants.find(row => row.id === 'contact');
  assert.equal(visitor.parentId, 'agent:worker');
  assert.equal(visitor.visitLabel.key, 'office.visitingWith');
  assert.deepEqual(current.visitIntent.hosts, [{ id: 'agent:worker', visitorIds: ['contact'] }]);
  assert.equal(current.visitIntent.hostId, 'agent:worker');
  assert.equal(current.visitIntent.visitors[0].hostId, 'agent:worker');

  const lingering = tracker.visitRows(rows.slice(0, 2), NOW + 5_000, 3);
  const retained = lingering.occupants.find(row => row.id === 'contact');
  assert.equal(retained.visitPhase, 'linger');
  assert.equal(retained.parentId, 'agent:worker');
  assert.equal(lingering.visitIntent.hosts[0].id, 'agent:worker');
});

test('visitor projection preserves rows and omits visit intent when the source has no primary host', () => {
  const tracker = createStateTracker();
  assert.deepEqual(tracker.visitRows([], NOW, 3), { occupants: [], visitIntent: undefined });
  const agents = [{ id: 'worker', role: 'agent', state: 'working', name: 'Worker' }];
  assert.deepEqual(tracker.visitRows(agents, NOW, 3), { occupants: agents, visitIntent: undefined });
});

test('retained visits expire observed execution leases without ending the presence animation', () => {
  for (const P of [project2x, project3x]) {
    let now = NOW;
    const engine = createEngine({ adapter, now: () => now, primary: 'main' });
    engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'main-session' }]);
    const primary = session('main-session', 'primary');
    const visitorKey = 'agent:main:discord:direct:person-1';
    const visitor = session(visitorKey, 'conversation-direct', { interlocutorId: 'discord-user:person-1', channel: 'discord' }, {
      run: { ...running, evidence: 'live-activity', evidenceLevel: 'observed', observedAt: NOW, expiresAt: NOW + 10_000 },
    });
    engine.ingestCanonical('sessions.snapshot', [primary, visitor]);
    engine.setGatewayConnected(true);
    const tracker = createStateTracker();
    const build = () => buildOfficeVM({ engine, now, tracker, canReadSessions: true, actorOf: () => ({ kind: 'system', name: 'System' }), P });

    const live = build();
    const liveVisitor = live.occupants.find(row => row.sessionKey === visitorKey);
    assert.equal(liveVisitor.state, 'working');
    assert.equal(liveVisitor.execution.status, 'running');
    assert.equal(live.visitIntent.until, NOW + 10_000, 'schedule a refresh at the evidence lease boundary');

    now = NOW + 11_000;
    engine.ingestCanonical('sessions.snapshot', [primary]);
    const retained = build();
    const lingering = retained.occupants.find(row => row.sessionKey === visitorKey);
    assert.equal(lingering.visitPhase, 'linger', 'the presence animation remains during the visit grace period');
    assert.equal(lingering.state, 'unknown');
    assert.equal(lingering.stateActive, false);
    assert.equal(lingering.execution.status, 'unknown');
    assert.equal(lingering.execution.evidence.level, 'unknown');
    assert.deepEqual(retained.visitIntent.visitors.find(row => row.id === lingering.id)?.stateLabel, { key: 'agentState.unknown' });
    assert.equal(validate(schemasFor(P.version).office, retained).ok, true);
  }
});

test('a Discord contact is placed and nested under the configured agent that owns its session (v2 and v3)', () => {
  for (const P of [project2x, project3x]) {
    const engine = createEngine({ adapter, now: () => NOW, primary: 'main' });
    engine.ingestCanonical('agents', [
      { id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'main-session' },
      { id: 'worker', name: 'Worker', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: 'worker-session' },
    ]);
    const primary = session('main-session', 'primary', { agentId: 'main' });
    const worker = session('worker-session', 'primary', { agentId: 'worker' }, { parentKey: 'main-session' });
    const visitorKey = 'agent:worker:discord:direct:person-1';
    // The contact was initiated from Main's session, but belongs to Worker.
    // Ownership must win over that independent session lineage.
    const visitorSession = session(visitorKey, 'conversation-direct', { agentId: 'worker', channel: 'discord', interlocutorId: 'discord-user:person-1' }, { parentKey: 'main-session' });
    engine.ingestCanonical('sessions.snapshot', [primary, worker, visitorSession]);
    engine.setGatewayConnected(true);
    const defaults = officeDefaults();
    const layout = { ...defaults, layout: { ...defaults.layout, agents: [...defaults.layout.agents,
      { agentId: 'worker', match: { kind: 'agent' }, character: 'subagent', variant: 'teal', accessories: [],
        name: null, role: null, station: 'auto', homeFloor: '2', appearance: 'auto' }] } };
    const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      configuredAgents: { worker: 'Worker' }, names: { interlocutorName: () => 'Camille' }, layout,
      actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const lead = vm.occupants.find(row => row.sessionKey === 'worker-session');
    const visitor = vm.occupants.find(row => row.sessionKey === visitorKey);
    assert.ok(lead && visitor);
    assert.equal(visitor.parentId, lead.id);
    assert.equal(lead.parentId, P.occupantId('primary'));
    assert.equal(vm.visitIntent.hostId, lead.id);
    assert.deepEqual(vm.visitIntent.hosts, [{ id: lead.id, visitorIds: [visitor.id] }]);
    assert.equal(visitor.floorId, lead.floorId);
    assert.equal(visitor.stationUid, null);
    assert.equal(visitor.sceneTarget.kind, 'visit');
    assert.equal(visitor.visitLabel.key, 'office.visitingWith');
    assert.equal(visitor.rosterDepth, 2, 'same-floor visit depth follows the backend parent tree');
    assert.equal(visitor.parentName, null, 'a visit parent is not described as a launcher');
    assert.equal(visitor.groupId, P.occupantId('primary'), 'nested visitor remains in the owning team group');
    assert.ok(visitor.rosterOrder > lead.rosterOrder);
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
  }
});

test('conversation owner wins over a conversation-shaped parent bridge in both contracts', () => {
  for (const P of [project2x, project3x]) {
    const engine = createEngine({ adapter, now: () => NOW, primary: 'main' });
    engine.ingestCanonical('agents', [
      { id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'main-session' },
      { id: 'worker', name: 'Worker', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: 'worker-session' },
    ]);
    const bridgeKey = 'agent:main:discord:direct:bridge';
    const contactKey = 'agent:worker:discord:direct:contact';
    engine.ingestCanonical('sessions.snapshot', [
      session('main-session', 'primary', { agentId: 'main' }),
      session('worker-session', 'primary', { agentId: 'worker' }),
      session(bridgeKey, 'conversation-direct', { agentId: 'main', channel: 'discord', interlocutorId: 'discord-user:100000000000000002' }),
      session(contactKey, 'conversation-direct', { agentId: 'worker', channel: 'discord', interlocutorId: 'discord-user:100000000000000003' }, { parentKey: bridgeKey }),
    ]);
    engine.setGatewayConnected(true);
    const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      names: { interlocutorName: () => 'Contact' }, actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const worker = vm.occupants.find(row => row.sessionKey === 'worker-session');
    const bridge = vm.occupants.find(row => row.sessionKey === bridgeKey);
    const contact = vm.occupants.find(row => row.sessionKey === contactKey);
    assert.ok(worker && bridge && contact);
    assert.equal(contact.parentId, worker.id, 'the owning agent wins over the conversation-shaped parent bridge');
    assert.equal(contact.parentId === bridge.id, false);
    assert.equal(vm.visitIntent.hosts.find(group => group.visitorIds.includes(contact.id)).id, worker.id);
    assert.equal(contact.visitLabel.params.name, worker.name);
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
  }
});

test('a conversation with no resolvable owner never falls back to an unrelated primary', () => {
  for (const P of [project2x, project3x]) {
    const engine = createEngine({ adapter, now: () => NOW, primary: 'main' });
    engine.ingestCanonical('agents', [
      { id: 'main', name: 'Main', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'main-session' },
    ]);
    const contactKey = 'agent:missing:discord:direct:contact';
    engine.ingestCanonical('sessions.snapshot', [
      session('main-session', 'primary', { agentId: 'main' }),
      session(contactKey, 'conversation-direct', { agentId: 'missing', channel: 'discord', interlocutorId: 'discord-user:100000000000000004' }, { parentKey: 'main-session' }),
    ]);
    engine.setGatewayConnected(true);
    const vm = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), canReadSessions: true,
      names: { interlocutorName: () => 'Contact' }, actorOf: () => ({ kind: 'system', name: 'System' }), P });
    const contact = vm.occupants.find(row => row.sessionKey === contactKey);
    assert.ok(contact, 'unresolved conversations remain visible');
    assert.equal(contact.parentId, null);
    assert.equal(contact.visitPhase, undefined);
    assert.equal(vm.visitIntent, undefined, 'no visit is assigned to the unrelated primary');
    assert.equal(validate(schemasFor(P.version).office, vm).ok, true);
  }
});
