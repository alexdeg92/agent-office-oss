'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectOfficeTeamOccupants: projectEngine } = require('../../src/engine/office/team-projection');
const { projectOfficeTeamOccupants: projectLegacy } = require('../../src/api/orchestrator-team-projection');
const { teamMemberId } = require('../../src/engine/office/placement-identity');
const { allocateMemberAppearances, lookKey } = require('../../src/engine/office/member-appearance');
const { indexManifest } = require('../../public/v2/office/assets');
const { openDatabase } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const { officePortraitForMember } = require('../../src/projects/orchestrator-teams');

const primaryLook = { character: 'timmy', variant: null, accessories: ['headphones'] };
const index = { manifest: { characters: [{ id: 'timmy', role: 'main' }, { id: 'cosmo', role: 'subagent' }] },
  characters: new Map([['timmy', { id: 'timmy', role: 'main' }], ['cosmo', { id: 'cosmo', role: 'subagent' }]]) };

test('host-only team occupants use a stable member appearance in both Office projectors', () => {
  const member = { id: 'member:revived', name: 'PM', teamId: 'team:delivery', roleKind: 'lead', parentMemberId: null };
  const snapshot = { observedAt: 1000, team: { id: member.teamId }, members: [member], agents: [], identityLinks: [] };
  const owner = { id: 'primary', role: 'primary', name: 'Atlas', look: primaryLook };
  let expectedLook = null;
  for (const project of [projectEngine, projectLegacy]) {
    const result = project({ occupants: [owner] }, snapshot, { id: 'admin', role: 'admin', permissionRevision: 1 }, {
      sourceEnabled: true, version: 3, index,
    });
    const projected = result.occupants.find(row => row.name === 'PM');
    assert.ok(projected, 'the registered member is represented without a session join');
    if (expectedLook) assert.deepEqual(projected.look, expectedLook);
    else expectedLook = projected.look;
    assert.equal(projected.look.character === owner.look.character, false, 'the host-only member never inherits Atlas’s character');
    assert.equal(teamMemberId(projected), member.id, 'the Office row keeps the stable private member join');
    assert.equal(projected.memberId, member.id, 'the authorized OfficeVM carries the stable join through schema/cache serialization');
    assert.deepEqual(result.occupants.find(row => row.id === 'primary').look, primaryLook, 'the main agent appearance is unchanged');
    const restricted = project({ occupants: [owner] }, snapshot,
      { id: 'reader', role: 'viewer', permissionRevision: 1, effectivePermissions: { orchestrators: 'read' } }, {
        sourceEnabled: true, version: 3, index,
      });
    assert.equal(restricted.occupants.some(row => row.memberId), false, 'the stable member join is hidden without teams.read');
  }
});

test('Office projectors allocate the whole host-only team without portrait collisions', () => {
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const ids = ['member:collision-1', 'member:collision-5', 'member:seat-c', 'member:seat-d', 'member:seat-e', 'member:seat-f'];
  const members = ids.map((id, i) => ({ id, name: `Member ${i}`, teamId: 'team:delivery',
    roleKind: i === 0 ? 'lead' : 'member', parentMemberId: i === 0 ? null : ids[0] }));
  const snapshot = { observedAt: 1000, team: { id: 'team:delivery' }, members, agents: [], identityLinks: [] };
  const office = { occupants: [{ id: 'primary', role: 'primary', name: 'Atlas', look: primaryLook }] };
  for (const project of [projectEngine, projectLegacy]) {
    const result = project(office, snapshot, { id: 'admin', role: 'admin', permissionRevision: 1 }, {
      sourceEnabled: true, version: 3, index: portraitIndex,
      assignMemberAppearances: (memberIds, idx, opts) => Object.fromEntries(allocateMemberAppearances(memberIds, idx, opts)),
    });
    const looks = result.occupants.filter(row => row.memberId).map(row => lookKey(row.look));
    assert.equal(looks.length, ids.length, `${project === projectEngine ? 'engine' : 'legacy'} rows: ${JSON.stringify(result.occupants.map(row => ({ id: row.id, name: row.name, memberId: row.memberId, teamId: row.teamId, role: row.role })))}`);
    assert.equal(new Set(looks).size, ids.length, `set allocation is wired into ${project === projectEngine ? 'engine' : 'legacy'} projection: ${JSON.stringify(result.occupants.filter(row => row.memberId).map(row => ({ id: row.id, memberId: row.memberId, look: row.look })))}`);
  }
});

test('unrepresented exact-linked host occupants use a stable non-primary appearance in both Office projectors', () => {
  const owner = { id: 'primary', role: 'primary', name: 'Atlas', look: primaryLook };
  const host = { id: 'host:detached', role: 'delegate', status: 'working', observedAt: 900, staleAfter: 1100 };
  const snapshot = { observedAt: 1000, agents: [host], members: [],
    identityLinks: [{ hostAgentId: host.id, agentId: 'agent:detached', confidence: 'exact', evidence: 'shared-runtime-session-ref' }] };
  let expectedLook = null;
  for (const project of [projectEngine, projectLegacy]) {
    const result = project({ occupants: [owner] }, snapshot,
      { id: 'admin', role: 'admin', permissionRevision: 1 }, {
        sourceEnabled: true, version: 3, index,
        runtimeAgents: [{ id: 'agent:detached', name: 'Detached', isPrimary: false }],
      });
    const projected = result.occupants.find(row => row.id === 'agent:agent:detached');
    assert.ok(projected, 'the exact-linked host remains visible without a member registry row');
    if (expectedLook) assert.deepEqual(projected.look, expectedLook);
    else expectedLook = projected.look;
    assert.notDeepEqual(projected.look, owner.look, 'an exact-linked non-primary host never inherits the primary look');
  }
});

test('member portraits probe collisions in the full installed pool', () => {
  const manifest = require('../../design/office/manifest.example.json');
  const portraitIndex = indexManifest(manifest);
  // These two IDs collided under the previous independent hash % 40 scheme.
  const ids = ['member:collision-1', 'member:collision-5'];
  const assigned = allocateMemberAppearances(ids, portraitIndex);
  assert.notEqual(lookKey(assigned.get(ids[0])), lookKey(assigned.get(ids[1])));
  assert.ok([...assigned.values()].every(look => look.character !== 'timmy'));
});

test('member set fills the available pool before reuse and balances overflow', () => {
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const characters = [...portraitIndex.manifest.characters, ...(portraitIndex.manifest.characterPacks?.packs || [])]
    .filter(row => row.role !== 'main' && portraitIndex.characters.has(row.id));
  const poolSize = characters.reduce((count, row) => count + Math.max(1, portraitIndex.characters.get(row.id).variants?.length || 0), 0);
  const ids = Array.from({ length: poolSize }, (_, n) => `member:pool-${n}`);
  const complete = allocateMemberAppearances(ids, portraitIndex);
  assert.equal(complete.size, poolSize);
  assert.equal(new Set([...complete.values()].map(lookKey)).size, poolSize, 'a set equal to the pool uses every look once');

  const overflowIds = Array.from({ length: poolSize * 2 + 7 }, (_, n) => `member:overflow-${n}`);
  const overflow = allocateMemberAppearances(overflowIds, portraitIndex);
  const counts = new Map();
  for (const look of overflow.values()) counts.set(lookKey(look), (counts.get(lookKey(look)) || 0) + 1);
  assert.equal(overflow.size, overflowIds.length);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1, 'reuse is spread evenly after the pool is exhausted');
});

test('adding a member preserves every previously assigned appearance', () => {
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const initialIds = Array.from({ length: 17 }, (_, n) => `member:stable-${n}`);
  const initial = allocateMemberAppearances(initialIds, portraitIndex);
  const expanded = allocateMemberAppearances([...initialIds, 'member:stable-new'], portraitIndex, { existing: initial });
  for (const id of initialIds) assert.deepEqual(expanded.get(id), initial.get(id), `${id} keeps its persisted look`);
  const reordered = allocateMemberAppearances([...initialIds].reverse(), portraitIndex, { existing: initial });
  for (const id of initialIds) assert.deepEqual(reordered.get(id), initial.get(id), 'input order does not alter stored assignments');
});

test('the office store keeps member appearances stable across a new roster and repo instance', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-member-looks-'));
  let db = openDatabase({ dir, instance: 'test' });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const firstIds = ['member:persist-a', 'member:persist-b', 'member:persist-c'];
  const before = createOfficeRepo(db.db).memberAppearances(firstIds, portraitIndex);
  db.close();
  db = openDatabase({ dir, instance: 'test' });
  const after = createOfficeRepo(db.db).memberAppearances([...firstIds, 'member:persist-d'], portraitIndex);
  for (const id of firstIds) assert.deepEqual(after[id], before[id], `${id} stays assigned after reload`);
  assert.equal(new Set([...Object.values(after)].map(lookKey)).size, 4);
});

test('project fallback portraits survive member removal, rejoin, and process restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-project-looks-'));
  let db = openDatabase({ dir, instance: 'test' });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const ids = ['member:collision-1', 'member:collision-5'];
  const office = { occupants: [{ id: 'primary', role: 'primary', floorId: 'floor-1', look: primaryLook }] };
  const project = activeIds => {
    const members = activeIds.map(id => ({ id, name: id, roleKind: id === ids[0] ? 'lead' : 'member' }));
    const snapshot = { members };
    const repo = createOfficeRepo(db.db);
    return Object.fromEntries(members.map(member => [member.id, officePortraitForMember(member, snapshot, office, {
      index: portraitIndex,
      assignMemberAppearances: (memberIds, index, options) => repo.memberAppearances(memberIds, index, options),
    }).look]));
  };

  const initial = project(ids);
  const survivorOnly = project([ids[1]]);
  assert.deepEqual(survivorOnly[ids[1]], initial[ids[1]], 'removing a colliding member does not change the survivor');
  const rejoined = project(ids);
  assert.deepEqual(rejoined, initial, 'rejoining restores the same assignments');

  db.close();
  db = openDatabase({ dir, instance: 'test' });
  assert.deepEqual(project(ids), initial, 'a fresh repository/process keeps both saved looks');
});

test('member portrait assignment excludes reserved same-floor looks', () => {
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const reserved = { character: 'subagent', variant: 'teal', accessories: [] };
  const assigned = allocateMemberAppearances(['member:reserved'], portraitIndex, { reservedLooks: [reserved] });
  assert.notEqual(lookKey(assigned.get('member:reserved')), lookKey(reserved));
});

test('appearance allocation still returns a valid non-primary look when every choice is reserved', () => {
  const portraitIndex = indexManifest(require('../../design/office/manifest.example.json'));
  const allChoices = [...portraitIndex.manifest.characters, ...(portraitIndex.manifest.characterPacks?.packs || [])]
    .filter(row => row.role !== 'main' && portraitIndex.characters.has(row.id))
    .flatMap(row => {
      const definition = portraitIndex.characters.get(row.id);
      return (definition.variants || []).length
        ? definition.variants.map(variant => ({ character: row.id, variant: variant.id, accessories: [] }))
        : [{ character: row.id, variant: null, accessories: [] }];
    });
  const memberId = 'member:non-main-primary';
  const primaryLook = allocateMemberAppearances([memberId], portraitIndex).get(memberId);
  assert.ok(primaryLook && primaryLook.character !== 'timmy', 'the primary can have a non-main character from the member pool');
  const assigned = allocateMemberAppearances([memberId], portraitIndex, { reservedLooks: allChoices, primaryLook });
  assert.ok(assigned.has(memberId), 'Office projection never receives an undefined look after the pool is reserved');
  assert.ok(allChoices.some(look => lookKey(look) === lookKey(assigned.get(memberId))));
  assert.notEqual(lookKey(assigned.get(memberId)), lookKey(primaryLook), 'relaxing floor reservations never reuses the actual primary look');
  assert.notEqual(assigned.get(memberId).character, 'timmy');
});
