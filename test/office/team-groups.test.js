'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { projectTeamGroups, projectFloorAgentGroups, withoutTeamMembership } = require('../../src/engine/office/roster');
const { projectOfficeTeamOccupants } = require('../../src/engine/office/team-projection');
const { runtimePresentationFor } = require('../../src/adapters');

it('projects N runtime-neutral team pods with shared leads once and linked across teams', () => {
  const occupants = [
    { id: 'agent:shared', memberId: 'alpha-lead', teamId: 'alpha', teamIds: ['alpha', 'beta'], role: 'agent', name: 'Atlas', state: 'working',
      stateLabel: { key: 'agentState.working' }, stateSince: 1, floorId: '2', stationUid: 'desk-atlas', rosterOrder: 0, hostAgentId: 'host-atlas' },
    { id: 'agent:a', memberId: 'alpha-worker', teamId: 'alpha', parentId: 'agent:shared', role: 'subagent', name: 'A', state: 'idle',
      stateLabel: { key: 'agentState.idle' }, stateSince: 1, floorId: '2', stationUid: 'desk-a', rosterOrder: 1, hostAgentId: 'host-a' },
    { id: 'agent:b', memberId: 'beta-worker', teamId: 'beta', parentId: 'agent:shared', role: 'subagent', name: 'B', state: 'unknown',
      stateLabel: { key: 'agentState.unknown' }, stateSince: 1, floorId: '2', standingPoint: { x: 7, y: 4 }, rosterOrder: 2, hostAgentId: 'host-b' },
    { id: 'agent:nox', role: 'agent', name: 'Nox', state: 'idle', floorId: '2',
      sceneTarget: { point: { x: 13, y: 12 } } },
  ];
  const snapshot = {
    teams: [{ id: 'alpha', label: 'Domaine Kildare' }, { id: 'beta', label: 'Plateforme VCE' }],
    members: [
      { id: 'alpha-lead', teamId: 'alpha', name: 'Atlas', roleKind: 'lead', roleLabel: 'lead', hostAgentId: 'host-atlas', runtimeKind: 'codex' },
      { id: 'alpha-worker', teamId: 'alpha', name: 'A', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'alpha-lead', hostAgentId: 'host-a', runtimeKind: 'claude-code' },
      { id: 'beta-lead', teamId: 'beta', name: 'Atlas', roleKind: 'lead', roleLabel: 'lead', hostAgentId: 'host-atlas', runtimeKind: 'codex' },
      { id: 'beta-worker', teamId: 'beta', name: 'B', roleKind: 'member', roleLabel: 'reviewer', parentMemberId: 'beta-lead', hostAgentId: 'host-b', runtimeKind: 'codex' },
    ],
    identityLinks: [
      { hostAgentId: 'host-atlas', agentId: 'shared', confidence: 'exact' },
      { hostAgentId: 'host-a', agentId: 'a', confidence: 'exact' },
      { hostAgentId: 'host-b', agentId: 'b', confidence: 'exact' },
    ],
  };
  const presentation = kind => ({ label: { key: `team.runtime.${kind}` }, brand: { logo: `assets/connectors/${kind}.svg` } });
  const floorLayouts = [{ id: '2', layout: { room: 'office', items: [
    { uid: 'desk-atlas', asset: 'desk', x: 2, y: 2 },
    { uid: 'desk-a', asset: 'desk', x: 5, y: 2 },
  ] } }];
  const index = { rooms: new Map([['office', { cols: 24, rows: 18 }]]),
    furniture: new Map([['desk', { station: { seat: { x: 0.5, y: 0.5 } } }]]) };
  const groups = projectTeamGroups(occupants, snapshot, presentation, { floorLayouts, index });
  assert.deepEqual(groups.map(group => group.id), ['alpha', 'beta']);
  assert.deepEqual(groups.map(group => group.label.params.text), ['Domaine Kildare', 'Plateforme VCE']);
  assert.ok(groups.every(group => ['violet', 'teal', 'amber', 'rose', 'sky', 'lime'].includes(group.accentToken)),
    'every team count uses only the six approved palette accents');
  assert.equal(new Set(groups.map(group => group.accentToken)).size, groups.length,
    'accent choices are stable hash preferences with collision probing');
  assert.ok(groups.every(group => group.floorId === '2' && group.pod.floorId === '2'));
  assert.deepEqual(groups.map(group => group.members.map(member => member.occupantId)), [
    ['agent:shared', 'agent:a'], ['agent:shared', 'agent:b'],
  ]);
  assert.equal(groups[0].members[0].occupantId, groups[1].members[0].occupantId,
    'a shared lead is linked into each pod without duplicating its scene occupant');
  assert.deepEqual(groups[0].sharedLeadLinks.map(link => link.teamId), ['beta']);
  assert.deepEqual(groups[1].sharedLeadLinks, [], 'a two-team shared lead emits only the home-pod-to-other-pod link');
  assert.deepEqual(groups[0].pod.zone.bounds, { minX: 1, minY: 1, maxX: 6, maxY: 3 });
  assert.deepEqual(groups[0].pod.zone.polygon, [
    { x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 3 }, { x: 1, y: 3 },
  ]);
  assert.ok(groups.every(group => Object.keys(group.pod).sort().join(',') === 'coordinateSpace,floorId,seats,zone'),
    'team pods contain only their floor, zone, and seats');
  const center = zone => ({ x: (zone.bounds.minX + zone.bounds.maxX) / 2, y: (zone.bounds.minY + zone.bounds.maxY) / 2 });
  assert.deepEqual(groups[0].sharedLeadLinks[0].fromPoint, center(groups[0].pod.zone));
  assert.deepEqual(groups[0].sharedLeadLinks[0].toPoint, center(groups[1].pod.zone));
  assert.equal(groups[0].members[1].parentLabel.params.name, 'Atlas');
  assert.equal(groups[0].members[1].runtimeMark.logo, 'assets/connectors/claude-code.svg');
  assert.deepEqual(groups[0].pod.seats.map(seat => seat.occupantId), ['agent:shared', 'agent:a']);
  assert.deepEqual(groups[1].pod.seats.map(seat => seat.occupantId), ['agent:b'], 'the shared lead seats only its first team pod');
  assert.ok(groups[1].pod.zone.bounds.minX > 2, 'the second team pod geometry excludes its shared lead');
  assert.equal(groups[1].pod.seats[0].standingPoint.x, 7);
  assert.equal(groups[0].memberCount, 2);
  assert.equal(groups[0].memberCountLabel.params.n, 2);
});

it('supplies each floor with only its seated team members plus an explicit no-team group', () => {
  const occupants = [
    { id: 'lead-a', role: 'agent', floorId: '1', teamId: 'alpha', teamIds: ['alpha', 'beta'], state: 'blocked', stateKind: 'blocked', stateLabel: { key: 'agentState.blocked' }, stateActive: false },
    { id: 'worker-a', role: 'subagent', floorId: '1' }, { id: 'worker-b', role: 'subagent', floorId: '1' },
    { id: 'solo-3', role: 'agent', floorId: '3' }, { id: 'visitor-3', role: 'conversation', floorId: '3', visitPhase: 'person' },
  ];
  const floorOne = { id: '1', count: 3, occupantIds: ['lead-a', 'worker-a', 'worker-b'], items: [
    { kind: 'occupant', id: 'lead', occupantId: 'lead-a' }, { kind: 'occupant', id: 'worker-a', occupantId: 'worker-a' },
    { kind: 'occupant', id: 'worker-b', occupantId: 'worker-b' },
  ] };
  const floorThree = { id: '3', occupantIds: ['solo-3', 'visitor-3'], items: [
    { kind: 'occupant', id: 'solo', occupantId: 'solo-3' }, { kind: 'occupant', id: 'visit', occupantId: 'visitor-3' },
  ] };
  const groups = projectFloorAgentGroups([floorOne, floorThree], occupants, [
    { id: 'alpha', floorId: '1', label: { key: 'team:alpha' }, leadOccupantId: 'lead-a', accentToken: 'teal',
      members: [{ occupantId: 'lead-a' }, { occupantId: 'worker-a' }], sharedLeadLinks: [{ teamId: 'beta' }] },
    { id: 'beta', floorId: '1', label: { key: 'team:beta' }, leadOccupantId: 'lead-a', accentToken: 'rose',
      members: [{ occupantId: 'lead-a' }, { occupantId: 'worker-b' }] },
  ]);
  assert.deepEqual(groups[0].agentGroups.map(group => [group.kind, group.id, group.occupantIds]), [
    ['team', 'alpha', ['lead-a', 'worker-a']], ['team', 'beta', ['worker-b']],
  ]);
  assert.deepEqual(groups[1].agentGroups.map(group => [group.kind, group.occupantIds]), [['unassigned', ['solo-3']]]);
  assert.equal(groups[0].agentGroups.reduce((sum, group) => sum + group.count, 0), floorOne.count,
    'floor groups count each occupant exactly once even when a lead belongs to several teams');
  assert.equal(new Set(groups[0].agentGroups.flatMap(group => group.occupantIds)).size, floorOne.count,
    'a shared lead is rendered in only its canonical floor group');
  assert.ok(groups[0].agentGroups.find(group => group.teamId === 'alpha')?.sharedLabel,
    'the canonical team explains that its lead is shared');
  assert.equal(groups[0].showTeamPanel, true);
  assert.equal(groups[1].showTeamPanel, false);
  assert.deepEqual([groups[0].agentGroups[0].previewOccupantId, groups[0].agentGroups[0].previewState, groups[0].agentGroups[0].previewStateLabel],
    ['lead-a', 'blocked', { key: 'agentState.blocked' }], 'mobile group previews reuse the backend state of their canonical lead');
  assert.equal(groups[1].agentGroups[0].countLabel.key, 'office.floor.count.one');
  assert.equal(groups[0].agentGroups[0].countLabel.key, 'office.floor.count.other');
  assert.deepEqual(groups[1].otherItems.map(item => item.occupantId), ['visitor-3'], 'visiting conversations remain in their backend-authored floor items');
  assert.ok(groups.every(floor => floor.agentGroups.every(group => group.occupantIds.every(id => floor.occupantIds.includes(id)))),
    'no floor can display agents seated on another floor');
});

it('emits one canonical connector from a shared lead home pod to each of three teams', () => {
  const teams = ['alpha', 'beta', 'gamma'].map(id => ({ id, label: id.toUpperCase() }));
  const occupants = [{ id: 'agent:shared', memberId: 'alpha-lead', teamId: 'alpha', teamIds: ['alpha', 'beta', 'gamma'],
    role: 'agent', name: 'Atlas', state: 'idle', floorId: '2' }];
  const members = [];
  for (const team of teams) {
    const leadMemberId = `${team.id}-lead`;
    members.push({ id: leadMemberId, teamId: team.id, name: 'Atlas', roleKind: 'lead', roleLabel: 'lead', hostAgentId: 'host-shared' });
    const workerId = `agent:${team.id}-worker`;
    occupants.push({ id: workerId, memberId: `${team.id}-worker`, teamId: team.id, parentId: 'agent:shared',
      role: 'subagent', name: `${team.id} worker`, state: 'idle', floorId: '2' });
    members.push({ id: `${team.id}-worker`, teamId: team.id, name: `${team.id} worker`, roleKind: 'member',
      parentMemberId: leadMemberId, hostAgentId: `${team.id}-worker-host` });
  }
  const identityLinks = [{ hostAgentId: 'host-shared', agentId: 'shared', confidence: 'exact' },
    ...teams.map(team => ({ hostAgentId: `${team.id}-worker-host`, agentId: `${team.id}-worker`, confidence: 'exact' }))];
  const groups = projectTeamGroups(occupants, { teams, members, identityLinks });
  assert.deepEqual(groups.map(group => group.sharedLeadLinks.map(link => link.teamId)), [['beta', 'gamma'], [], []]);
  const links = groups.flatMap(group => group.sharedLeadLinks);
  assert.equal(links.length, 2, 'three linked pods need exactly two connectors');
  assert.ok(links.every(link => link.occupantId === 'agent:shared'));
  assert.deepEqual(new Set(links.map(link => `${link.teamId}:${link.occupantId}`)).size, 2);
});

it('omits redundant member roles and uses the adapter-declared OpenClaw label', () => {
  const occupants = [
    { id: 'agent:pm', memberId: 'member:pm', teamId: 'team:office', role: 'agent', name: 'pm', state: 'idle', floorId: '2' },
    { id: 'subagent:designer', memberId: 'member:designer', teamId: 'team:office', parentId: 'agent:pm', role: 'subagent', name: 'designer', state: 'idle', floorId: '2' },
    { id: 'subagent:openclaw', memberId: 'member:openclaw', teamId: 'team:office', parentId: 'agent:pm', role: 'subagent', name: 'Nova', state: 'idle', floorId: '2' },
  ];
  const snapshot = { team: { id: 'team:office', label: 'Office' }, members: [
    { id: 'member:pm', teamId: 'team:office', name: 'pm', roleKind: 'lead', roleLabel: 'pm', runtimeKind: 'openclaw' },
    { id: 'member:designer', teamId: 'team:office', name: 'designer', roleKind: 'member', roleLabel: 'designer', parentMemberId: 'member:pm', runtimeKind: 'openclaw' },
    { id: 'member:openclaw', teamId: 'team:office', name: 'Nova', roleKind: 'member', roleLabel: 'engineer', parentMemberId: 'member:pm', runtimeKind: 'openclaw' },
  ] };
  const group = projectTeamGroups(occupants, snapshot, runtimePresentationFor)[0];
  assert.equal(group.members[0].roleLabel, null, 'pm is not repeated as both name and role');
  assert.equal(group.members[1].roleLabel, null, 'designer is not repeated as both name and role');
  assert.equal(group.members[2].runtimeLabel.key, 'team.runtime.openclaw');
  assert.equal(group.members[2].runtimeMark.providerName, 'OpenClaw');
});

it('assigns deterministic team-id accents, preserves non-colliding assignments, and balances reuse', () => {
  const teams = Array.from({ length: 5 }, (_, index) => ({ id: `team-${String(index).padStart(2, '0')}`, label: `Team ${index}`, createdAt: index + 1 }));
  const occupants = teams.map(team => ({ id: `agent:${team.id}`, memberId: `member:${team.id}`, teamId: team.id,
    role: 'agent', name: team.id, state: 'idle' }));
  const members = teams.map(team => ({ id: `member:${team.id}`, teamId: team.id, name: team.id, roleKind: 'lead', hostAgentId: null }));
  const snapshot = { teams, members };
  const first = new Map(projectTeamGroups(occupants, snapshot).map(group => [group.id, group.accentToken]));
  const repeated = new Map(projectTeamGroups(occupants, snapshot).map(group => [group.id, group.accentToken]));
  assert.deepEqual(repeated, first, 'the same IDs produce the same accents across repeated projections');
  assert.equal(new Set(first.values()).size, teams.length, 'each visible team has a distinct accent while the palette has room');
  const hash = id => { let value = 2166136261; for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; };
  const paletteSize = 6;
  const usedPreferences = new Set(teams.map(team => hash(team.id) % paletteSize));
  let addedId = 'team-added-non-colliding';
  while (usedPreferences.has(hash(addedId) % paletteSize)) addedId += '-x';
  const addedTeam = { id: addedId, label: 'Added later', createdAt: 0 };
  const withAdded = { teams: [...teams.slice().reverse(), addedTeam], members: [...members.slice().reverse(),
    { id: `member:${addedId}`, teamId: addedId, name: 'Added', roleKind: 'lead', hostAgentId: null }] };
  const afterAdd = new Map(projectTeamGroups([...occupants,
    { id: `agent:${addedId}`, memberId: `member:${addedId}`, teamId: addedId, role: 'agent', name: 'Added', state: 'idle' }], withAdded)
    .map(group => [group.id, group.accentToken]));
  for (const team of teams) assert.equal(afterAdd.get(team.id), first.get(team.id), `${team.id} keeps its color when a non-colliding team joins`);
  const afterRemoval = new Map(projectTeamGroups(occupants, { teams: teams.slice().reverse(), members: members.slice().reverse() })
    .map(group => [group.id, group.accentToken]));
  for (const team of teams) assert.equal(afterRemoval.get(team.id), first.get(team.id), `${team.id} keeps its color when another non-colliding team leaves`);
  const allowedAccents = new Set(['violet', 'teal', 'amber', 'rose', 'sky', 'lime']);
  const fullPaletteTeams = Array.from({ length: paletteSize }, (_, index) => ({ id: `palette-${String(index).padStart(2, '0')}`, label: `Palette ${index}` }));
  const fullPalette = projectTeamGroups(fullPaletteTeams.map(team => ({ id: `agent:${team.id}`, memberId: `member:${team.id}`, teamId: team.id,
    role: 'agent', name: team.id, state: 'idle' })), { teams: fullPaletteTeams, members: fullPaletteTeams.map(team => ({
    id: `member:${team.id}`, teamId: team.id, name: team.id, roleKind: 'lead' })) });
  assert.equal(new Set(fullPalette.map(group => group.accentToken)).size, fullPaletteTeams.length,
    'a full palette supports distinct accents for every visible team');
  assert.ok(fullPalette.every(group => allowedAccents.has(group.accentToken)), 'assignments use only the approved six-color palette');
  const collisionIds = Array.from({ length: 100 }, (_, index) => `collision-${index}`);
  const colliding = new Map();
  let collisionPairCovered = false;
  for (const id of collisionIds) {
    const slot = hash(id) % paletteSize;
    if (colliding.has(slot)) {
      const pair = [colliding.get(slot), id];
      const pairData = pair.map(teamId => ({ id: teamId, label: teamId }));
      const pairMembers = pair.map(teamId => ({ id: `member:${teamId}`, teamId, name: teamId, roleKind: 'lead' }));
      const pairOccupants = pair.map(teamId => ({ id: `agent:${teamId}`, memberId: `member:${teamId}`, teamId, role: 'agent', name: teamId, state: 'idle' }));
      assert.equal(new Set(projectTeamGroups(pairOccupants, { teams: pairData, members: pairMembers }).map(group => group.accentToken)).size, 2,
        'colliding hash preferences probe to distinct colors while palette space remains');
      collisionPairCovered = true;
      break;
    }
    colliding.set(slot, id);
  }
  assert.equal(collisionPairCovered, true, 'fixture contains a known pair with the same preferred palette slot');
  const overflowTeams = Array.from({ length: 13 }, (_, index) => ({ id: `overflow-${index}`, label: `Overflow ${index}`, createdAt: index + 1 }));
  const overflowSnapshot = { teams: overflowTeams, members: overflowTeams.map(team => ({ id: `member:${team.id}`, teamId: team.id,
    name: team.id, roleKind: 'lead', hostAgentId: null })) };
  const overflowOccupants = overflowTeams.map(team => ({ id: `agent:${team.id}`, memberId: `member:${team.id}`,
    teamId: team.id, role: 'agent', name: team.id, state: 'idle' }));
  const overflow = projectTeamGroups(overflowOccupants, overflowSnapshot).map(group => group.accentToken);
  assert.ok(overflow.every(token => allowedAccents.has(token)), 'overflow never introduces unapproved colors');
  const usage = new Map();
  for (const token of overflow) usage.set(token, (usage.get(token) || 0) + 1);
  assert.ok(Math.max(...usage.values()) - Math.min(...usage.values()) <= 1, 'excess teams reuse accents evenly');
});

it('removes team labels from both complete and preview rosters for principals without teams.read', () => {
  const item = { kind: 'group', id: 'group:private-team', isGroup: true, rootId: 'member:private-lead', occupantIds: [],
    childIds: [], previewOccupantIds: [], overflowCount: 0, openLabel: { key: 'open' },
    teamLabel: { key: 'office.mobile.team', params: { name: 'PRIVATE_TEAM_NAME' } }, delegatesLabel: { key: 'delegates' },
    overflowLabel: { key: 'overflow' }, order: 0, count: 1, label: { key: 'roster.group' } };
  const safe = withoutTeamMembership({ rosterItems: [item], rosterPreviewItems: [item], teamGroups: [{ id: 'private-team' }] });
  assert.equal(safe.rosterItems[0].teamLabel, undefined);
  assert.equal(safe.rosterPreviewItems[0].teamLabel, undefined);
  assert.equal(JSON.stringify(safe).includes('PRIVATE_TEAM_NAME'), false);
  assert.deepEqual(safe.teamGroups, []);
});

it('strips cached team membership references before the no-teams-read early return', () => {
  const projected = projectOfficeTeamOccupants({ occupants: [{ id: 'agent:cached', role: 'agent', name: 'Cached',
    teamId: 'private-team-id', teamIds: ['private-team-id', 'private-team-2'], memberId: 'private-member-id' }] },
  { members: [], agents: [], identityLinks: [] }, { id: 'reader', role: 'reader', permissions: { orchestrators: 'read' } },
  { sourceEnabled: true });
  assert.deepEqual(projected.occupants, [{ id: 'agent:cached', role: 'agent', name: 'Cached', teamId: null }]);
});
