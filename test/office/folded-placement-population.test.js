'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { officeDefaults, createStateTracker } = require('../../src/api/v2/vm/office');
const { projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const { tagTeamMember } = require('../../src/api/v2/vm/office-placement-identity');

test('exact session folding plans the final team occupant id and does not spend a second desk on its runtime alias', () => {
  const { layout, index } = officeDefaults();
  const sessionKey = 'rt:codex:session:opaque-fixture';
  const office = { occupants: [
    { id: 'primary', role: 'primary', state: 'idle', stateSince: 1_800_000_000_000 - 60_000, teamId: 'team:fixture' },
    tagTeamMember({ id: 'team-member:member:builder', role: 'subagent', parentId: 'primary', teamId: 'team:fixture', state: 'working',
      stateSince: 1_800_000_000_000 - 30_000 }, 'member:builder'),
  ], rosterFloors: [], unseatedTeams: [] };
  // The source-side planner saw the project aggregate before exact Herdr ↔
  // Codex session folding. The mounted OfficeVM shows the folded session id.
  const planningOccupants = [
    { id: 'primary', role: 'primary', state: 'idle', stateSince: 1_800_000_000_000 - 60_000, teamId: 'team:fixture' },
    tagTeamMember({ id: sessionKey, role: 'subagent', parentId: 'primary', teamId: 'team:fixture', state: 'working',
      stateSince: 1_800_000_000_000 - 30_000, sessionKey }, 'member:builder'),
  ];
  const vm = projectOfficePlacement(office, { layout, index, planningOccupants, now: 1_800_000_000_000,
    tracker: createStateTracker() });
  const folded = vm.occupants.find(row => row.id === 'team-member:member:builder');
  assert.ok(folded?.stationUid, 'the final folded occupant receives a real desk');
  assert.equal(folded.sceneTarget.stationUid, folded.stationUid, 'the scene target points at the assigned desk');
  assert.equal(vm.occupants.length, 2, 'the pre-fold aggregate is not rendered as a second occupant');
  assert.equal(vm.occupants.some(row => row.id === sessionKey), false);
});

test('folded lead aliases rewrite retained child references before private placement', () => {
  const { layout, index } = officeDefaults();
  const oldLeadId = 'agent:private-lead';
  const now = 1_800_000_000_000;
  const office = { occupants: [
    tagTeamMember({ id: 'team-member:lead', role: 'agent', parentId: null, teamId: 'team:fixture', state: 'working',
      stateSince: now - 10_000, homeFloor: '2' }, 'member:lead', [oldLeadId]),
    tagTeamMember({ id: 'child-retained', role: 'subagent', parentId: oldLeadId, teamId: 'team:fixture', state: 'working',
      stateSince: now - 5_000 }, 'member:child'),
  ], rosterFloors: [], unseatedTeams: [] };
  // The private planner still has the lead's old runtime ID. The child already
  // has its final ID, but points at that pre-fold parent.
  const planningOccupants = [
    tagTeamMember({ id: oldLeadId, role: 'agent', parentId: null, teamId: 'team:fixture', state: 'working',
      stateSince: now - 10_000, homeFloor: '2' }, 'member:lead', [oldLeadId]),
    tagTeamMember({ id: 'child-retained', role: 'subagent', parentId: oldLeadId, teamId: 'team:fixture', state: 'working',
      stateSince: now - 5_000 }, 'member:child'),
  ];
  const vm = projectOfficePlacement(office, { layout, index, planningOccupants, now, tracker: createStateTracker() });
  const lead = vm.occupants.find(row => row.id === 'team-member:lead');
  const child = vm.occupants.find(row => row.id === 'child-retained');
  assert.ok(lead?.stationUid);
  assert.ok(child?.stationUid, 'retained child is still planned after its private parent ID is folded');
  assert.equal(child.parentId, lead.id, 'public roster lineage points at the visible folded lead');
  assert.equal(child.floorId, lead.floorId, 'team remains atomic on the lead floor');
  assert.equal(child.sceneTarget.stationUid, child.stationUid);
});

test('private session identity gives full and limited member IDs the same single seat', () => {
  const { layout, index } = officeDefaults();
  const now = 1_800_000_000_000, memberId = 'member:session-only', sessionKey = 'rt:codex:session:private';
  const pinnedLayout = { ...layout, agents: layout.agents.map(rule => rule.agentId === 'main' ? { ...rule, homeFloor: '2' } : rule) };
  const planningOccupants = [
    tagTeamMember({ id: 'primary', role: 'primary', teamId: 'team:fixture', state: 'idle', stateSince: now - 60_000 }, 'member:lead'),
    tagTeamMember({ id: sessionKey, role: 'subagent', parentId: 'primary', teamId: 'team:fixture', state: 'working',
      stateSince: now - 5_000 }, memberId, [sessionKey]),
  ];
  const project = id => projectOfficePlacement({ occupants: [
    tagTeamMember({ id: 'primary', role: 'primary', teamId: 'team:fixture', state: 'idle', stateSince: now - 60_000 }, 'member:lead'),
    tagTeamMember({ id, role: 'subagent', parentId: 'primary', teamId: 'team:fixture', state: 'working', stateSince: now - 5_000 },
      memberId, [sessionKey]),
  ], rosterFloors: [], unseatedTeams: [] }, { layout: pinnedLayout, index, planningOccupants, now, tracker: createStateTracker() });
  const full = project(sessionKey), limited = project('team-member:' + memberId);
  const fullLead = full.occupants.find(row => row.id === 'primary');
  const limitedLead = limited.occupants.find(row => row.id === 'primary');
  const fullMember = full.occupants.find(row => row.id === sessionKey);
  const limitedMembers = limited.occupants.filter(row => row.id !== 'primary');
  assert.equal(limitedMembers.length, 1, 'limited view plans the member once');
  assert.ok(fullMember.stationUid);
  assert.equal(fullLead.floorId, '2', 'registered primary keeps its exact saved floor rule');
  assert.equal(limitedLead.floorId, fullLead.floorId);
  assert.equal(limitedMembers[0].stationUid, fullMember.stationUid);
  assert.equal(limitedMembers[0].sceneTarget.stationUid, limitedMembers[0].stationUid);
  assert.equal(JSON.stringify(limited).includes(sessionKey), false, 'private session key is absent from limited output');
});

test('identity upgrade keeps persisted team stations when occupant IDs become private member identities', () => {
  const { layout, index } = officeDefaults();
  const now = 1_800_000_000_000;
  const teamId = 'team:upgrade-replay';
  const pinnedLayout = { ...layout, agents: [...layout.agents, { agentId: 'agent:lead', homeFloor: '2' }] };
  const priorRows = [
    { id: 'agent:lead', role: 'agent', parentId: null, teamId, state: 'working', stateSince: now - 60_000 },
    { id: 'agent:builder', role: 'subagent', parentId: 'agent:lead', teamId, state: 'working', stateSince: now - 30_000 },
  ];
  let saved;
  const first = projectOfficePlacement({ occupants: priorRows, rosterFloors: [], unseatedTeams: [] }, {
    layout: pinnedLayout, index, now, tracker: createStateTracker(), rememberHomeAssignments(value) { saved = value; },
  });
  assert.ok(saved?.[Object.keys(saved)[0]]?.stations);
  const previousBuilderSeat = first.occupants.find(row => row.id === 'agent:builder')?.stationUid;
  const upgradedRows = [
    tagTeamMember({ ...priorRows[0] }, 'member:lead', ['agent:lead']),
    tagTeamMember({ ...priorRows[1] }, 'member:builder', ['agent:builder']),
  ];
  const replay = projectOfficePlacement({ occupants: upgradedRows, rosterFloors: [], unseatedTeams: [] }, {
    layout: pinnedLayout, index, now: now + 1, tracker: createStateTracker(), homeAssignments: saved,
  });
  assert.equal(replay.occupants.find(row => row.id === 'agent:lead')?.floorId, '2',
    'the registered non-primary lead still resolves its saved layout homeFloor through the private identity');
  assert.equal(replay.occupants.find(row => row.id === 'agent:builder')?.floorId, '2');
  assert.equal(replay.occupants.find(row => row.id === 'agent:builder')?.stationUid, previousBuilderSeat,
    'an upgraded private member identity inherits the exact persisted station instead of reserving the old token');
  assert.equal(replay.occupants.find(row => row.id === 'agent:builder')?.state, 'working');
});
