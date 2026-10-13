'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../../src/store/db');
const { createOfficeRepo, TEAM_HOME_MAX, TEAM_HOME_RETENTION_MS, TEAM_HOME_BYTES_MAX } = require('../../src/store/repos/office');
const { planOfficePlacement } = require('../../src/engine/office/placement');
const { placementToken } = require('../../src/engine/office/floors');
const manifest = require('../../design/office/manifest.example.json');
const baseLayout = require('../../design/office/layout.example.json');
const index = { manifest, rooms: new Map(manifest.rooms.map(row => [row.id, row])), furniture: new Map(manifest.furniture.map(row => [row.id, row])),
  characters: new Map(manifest.characters.map(row => [row.id, row])), accessories: new Map(manifest.accessories.map(row => [row.id, row])), themes: new Map(manifest.themes.map(row => [row.id, row])) };
const occupants = Array.from({ length: 10 }, (_, i) => ({ id: `agent:stable-${i}`, role: 'agent', teamId: 'team:stable',
  parentId: i ? 'agent:stable-0' : null, state: 'working', rosterOrder: 10 - i }));
const signature = rows => Object.fromEntries(rows.map(row => [row.id, `${row.floorId}:${row.stationUid}`]));

test('team home floors and stations survive store reopen and reset only on an explicit layout revision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let opened = openDatabase({ dir, instance: 'test' });
  let office = createOfficeRepo(opened.db, { now: () => 100 });
  const first = planOfficePlacement({ index, layout: baseLayout, occupants });
  const initial = first.homeAssignments;
  assert.equal(office.rememberTeamHomeAssignments(1, initial), 1);
  assert.deepEqual(office.teamHomeAssignments(1), initial);
  const expected = signature(first.placements);
  opened.close();

  opened = openDatabase({ dir, instance: 'test' });
  office = createOfficeRepo(opened.db, { now: () => 200 });
  assert.deepEqual(office.teamHomeAssignments(1), initial, 'process restart reads the committed placement');
  const replay = planOfficePlacement({ index, layout: baseLayout, occupants: [...occupants].reverse(), homeAssignments: office.teamHomeAssignments(1) });
  assert.deepEqual(signature(replay.placements), expected, 'the restarted planner retains the same floor and station for every member');

  const grown = [...occupants, ...[10, 11].map(i => ({ id: `agent:stable-${i}`, role: 'agent', teamId: 'team:stable',
    parentId: 'agent:stable-0', state: 'working', rosterOrder: i }))];
  const overflow = planOfficePlacement({ index, layout: baseLayout, occupants: grown, homeAssignments: office.teamHomeAssignments(1) });
  assert.ok(overflow.placements.every(row => row.floorId === first.placements[0].floorId), 'capacity overflow keeps the atomic team at its pinned home floor');
  assert.ok(overflow.placements.some(row => !row.stationUid), 'overflow members stand near the team instead of displacing its home');
  office.rememberTeamHomeAssignments(1, overflow.homeAssignments);
  const afterOverflow = planOfficePlacement({ index, layout: baseLayout, occupants: grown.toReversed(), homeAssignments: office.teamHomeAssignments(1) });
  assert.deepEqual(signature(afterOverflow.placements), signature(overflow.placements), 'capacity overflow and stations remain stable on the next poll');

  assert.deepEqual(office.teamHomeAssignments(2), {}, 'an owner-saved layout revision starts a new placement plan');
  const changedLayout = structuredClone(baseLayout);
  changedLayout.agents.push({ agentId: 'agent:stable-0', character: 'subagent', station: 'auto', homeFloor: '3' });
  const changedPlan = planOfficePlacement({ index, layout: changedLayout, occupants, homeAssignments: office.teamHomeAssignments(2) });
  assert.ok(changedPlan.placements.every(row => row.floorId === '3'), 'an explicit layout pin takes effect on its new revision');
  const changed = changedPlan.homeAssignments;
  assert.equal(office.rememberTeamHomeAssignments(2, changed), 1);
  assert.deepEqual(office.teamHomeAssignments(2), changed);
  // Temporary source omissions do not erase old member seats for the retained team.
  const teamKey = Object.keys(changed)[0];
  assert.equal(office.rememberTeamHomeAssignments(2, { [teamKey]: { floorId: '3', stations: {} } }), 0, 'unchanged observations do not write on every OfficeVM read');
  assert.deepEqual(office.teamHomeAssignments(2), changed);
  opened.close();
});

test('churned team identities are capped deterministically while active pins survive reopen', t => {
  const run = dir => {
    fs.mkdirSync(dir, { recursive: true });
    let at = 1000;
    let opened = openDatabase({ dir, instance: 'test' });
    let office = createOfficeRepo(opened.db, { now: () => at });
    let latest = [];
    for (let batch = 0; batch < 5; batch++) {
      at = 1000 + batch * 1000;
      latest = [];
      const assignments = {};
      for (let n = 0; n < 32; n++) {
        const id = `team-${String(batch).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
        const key = crypto.createHash('sha256').update(id).digest('hex');
        latest.push(key);
        assignments[key] = { floorId: String((n % 4) + 1), stations: {} };
      }
      office.rememberTeamHomeAssignments(1, assignments);
      assert.ok(opened.db.prepare('SELECT count(*) AS n FROM office_team_home_placements WHERE layout_revision=1').get().n <= TEAM_HOME_MAX);
      assert.ok(opened.db.prepare('SELECT coalesce(sum(length(CAST(assignments_json AS BLOB))), 0) AS n FROM office_team_home_placements WHERE layout_revision=1').get().n <= TEAM_HOME_BYTES_MAX);
    }
    const beforeRestart = Object.keys(office.teamHomeAssignments(1)).sort();
    assert.equal(beforeRestart.length, TEAM_HOME_MAX);
    assert.ok(latest.every(key => beforeRestart.includes(key)), 'the current set is protected before older departed teams');
    opened.close();

    at += 1000;
    opened = openDatabase({ dir, instance: 'test' });
    office = createOfficeRepo(opened.db, { now: () => at });
    assert.deepEqual(Object.keys(office.teamHomeAssignments(1)).sort(), beforeRestart, 'retention order is stable across process reopen');
    at += TEAM_HOME_RETENTION_MS + 1;
    office.rememberTeamHomeAssignments(1, Object.fromEntries(latest.map((key, i) => [key, { floorId: String((i % 4) + 1), stations: {} }])));
    assert.deepEqual(Object.keys(office.teamHomeAssignments(1)).sort(), [...latest].sort(), 'departed teams expire after the documented seven-day grace period');
    opened.close();
    return beforeRestart;
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-home-churn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = run(path.join(root, 'first'));
  const second = run(path.join(root, 'second'));
  assert.deepEqual(second, first, 'the same churn sequence retains the same keys deterministically');
});

test('legacy excess placement rows are bounded on reads and pruned on the next observation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-home-legacy-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = openDatabase({ dir, instance: 'test' });
  const now = 1000, office = createOfficeRepo(opened.db, { now: () => now });
  const insert = opened.db.prepare('INSERT INTO office_team_home_placements(layout_revision, team_key, assignments_json, updated_at) VALUES (1, ?, ?, ?)');
  for (let i = 0; i < 300; i++) insert.run(crypto.createHash('sha256').update(`legacy-${i}`).digest('hex'), JSON.stringify({ floorId: '1', stations: {} }), now);
  assert.equal(Object.keys(office.teamHomeAssignments(1)).length, TEAM_HOME_MAX,
    'even pre-cap databases expose only a bounded deterministic read set');
  const activeKey = crypto.createHash('sha256').update('active').digest('hex');
  office.rememberTeamHomeAssignments(1, { [activeKey]: { floorId: '1', stations: {} } });
  const rows = opened.db.prepare('SELECT team_key, assignments_json FROM office_team_home_placements WHERE layout_revision=1 ORDER BY updated_at DESC, team_key ASC').all();
  assert.ok(rows.length <= TEAM_HOME_MAX);
  assert.ok(rows.reduce((sum, row) => sum + Buffer.byteLength(row.assignments_json), 0) <= TEAM_HOME_BYTES_MAX);
  assert.ok(rows.some(row => row.team_key === activeKey), 'the currently observed team survives pruning');
  opened.close();
});

test('temporary absence reserves a teammate station and explicit layout stations outrank saved pins', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-home-return-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let opened = openDatabase({ dir, instance: 'test' });
  let office = createOfficeRepo(opened.db, { now: () => 100 });
  const lead = { id: 'agent:lead', role: 'agent', teamId: 'team:lead', parentId: null, state: 'working' };
  const z = { id: 'agent:z-member', role: 'agent', teamId: 'team:lead', parentId: lead.id, state: 'working' };
  const initial = planOfficePlacement({ index, layout: baseLayout, occupants: [lead, z] });
  const zStation = initial.placements.find(row => row.id === z.id).stationUid;
  assert.equal(zStation, 'st-2');
  office.rememberTeamHomeAssignments(1, initial.homeAssignments);

  const newcomer = { id: 'agent:a-new', role: 'agent', teamId: 'team:lead', parentId: lead.id, state: 'working' };
  const whileAbsent = planOfficePlacement({ index, layout: baseLayout, occupants: [lead, newcomer], homeAssignments: office.teamHomeAssignments(1) });
  assert.notEqual(whileAbsent.placements.find(row => row.id === newcomer.id).stationUid, zStation,
    'a new member cannot consume the saved station of a temporarily absent teammate');
  office.rememberTeamHomeAssignments(1, whileAbsent.homeAssignments);
  const teamKey = placementToken('team:lead');
  assert.equal(office.teamHomeAssignments(1)[teamKey].stations[placementToken(z.id)], zStation,
    'a temporary omission does not remove the departed member pin from storage');
  opened.close();

  opened = openDatabase({ dir, instance: 'test' });
  office = createOfficeRepo(opened.db, { now: () => 200 });
  const returned = planOfficePlacement({ index, layout: baseLayout, occupants: [lead, newcomer, z], homeAssignments: office.teamHomeAssignments(1) });
  assert.equal(returned.placements.find(row => row.id === z.id).stationUid, zStation,
    'after a SQLite close/reopen, the returning member reclaims its pin');

  const explicitLayout = structuredClone(baseLayout);
  explicitLayout.agents.push({ agentId: z.id, character: 'subagent', station: 'st-timmy' });
  const autoOwner = { id: 'agent:a-auto', role: 'agent', teamId: 'team:explicit', parentId: null, state: 'working' };
  const explicitMember = { id: z.id, role: 'agent', teamId: 'team:explicit', parentId: autoOwner.id, state: 'working' };
  const savedTeamKey = placementToken('team:explicit');
  const savedStations = { [placementToken(autoOwner.id)]: 'st-timmy' };
  const explicit = planOfficePlacement({ index, layout: explicitLayout, occupants: [autoOwner, explicitMember],
    homeAssignments: { [savedTeamKey]: { floorId: '1', stations: savedStations } } });
  assert.equal(explicit.placements.find(row => row.id === explicitMember.id).stationUid, 'st-timmy',
    'the explicit member rule wins over a conflicting persisted automatic pin');
  assert.equal(explicit.placements.find(row => row.id === autoOwner.id).stationUid, 'st-2',
    'the displaced saved occupant takes the next available station');

  const capacityLayout = structuredClone(baseLayout);
  const explicitId = 'agent:capacity-explicit';
  capacityLayout.agents.push({ agentId: explicitId, character: 'subagent', station: 'st-2' });
  const capacityTeam = Array.from({ length: 7 }, (_, i) => ({ id: i === 1 ? explicitId : `agent:capacity-${i}`,
    role: 'agent', teamId: 'team:capacity', parentId: i ? 'agent:capacity-0' : null, state: 'working' }));
  const capacityPlan = planOfficePlacement({ index, layout: capacityLayout, occupants: capacityTeam,
    homeAssignments: { [placementToken('team:capacity')]: { floorId: '1', stations: { [placementToken(explicitId)]: 'st-3' } } } });
  const capacityPlacements = capacityPlan.placements;
  assert.equal(capacityPlacements.find(row => row.id === explicitId).stationUid, 'st-2',
    'an occupant keeps its explicit station over its own conflicting saved pin');
  assert.equal(capacityPlacements.filter(row => row.stationUid).length, 7,
    'the explicit station remains available to the full seven-person team');
  assert.equal(new Set(capacityPlacements.map(row => row.stationUid).filter(Boolean)).size, 7,
    'every station is assigned once with no false capacity overflow');
  opened.close();
});
