import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymousPresenceGroups, dedupeHostRows, groupedTeamMembers, isResolvedPresenceName, linkedPresence, unlinkedHostRows } from '../../public/v2/office/team-office-model.js';

test('a team member links to Herdr presence only through the exact canonical host id', () => {
  const hostRows = [
    { id: 'host-1', name: 'Same display name', runtimeKind: 'codex', status: 'working' },
    { id: 'host-2', name: 'Unlinked observer', runtimeKind: 'claude-code', status: 'idle' },
  ];
  assert.equal(linkedPresence({ id: 'member-1', name: 'Same display name' }, hostRows), null,
    'a matching display name cannot create an identity link');
  assert.equal(linkedPresence({ id: 'member-1', hostAgentId: 'host-1' }, hostRows), hostRows[0]);
  assert.equal(linkedPresence({ id: 'member-2', hostAgentId: 'missing' }, hostRows), null,
    'a dangling reference does not expose a guessed match');
});

test('mixed-runtime team members group by stable parent IDs, never names, and retain cyclic rows safely', () => {
  const rows = groupedTeamMembers([
    { id: 'member:pm', name: 'PM', parentMemberId: null },
    { id: 'member:codex', name: 'Builder', parentMemberId: 'member:pm' },
    { id: 'member:cursor', name: 'Critic', parentMemberId: 'member:pm' },
    { id: 'member:cycle-a', name: 'Cycle A', parentMemberId: 'member:cycle-b' },
    { id: 'member:cycle-b', name: 'Cycle B', parentMemberId: 'member:cycle-a' },
    { id: 'member:unknown', name: 'Unknown parent', parentMemberId: 'missing' },
    { id: 'member:codex', name: 'duplicate row', parentMemberId: 'member:pm' },
  ]);
  assert.deepEqual(rows.map(row => [row.member.id, row.depth, row.parent?.id || null]), [
    ['member:pm', 0, null], ['member:codex', 1, 'member:pm'], ['member:cursor', 1, 'member:pm'],
    ['member:cycle-a', 0, null], ['member:cycle-b', 0, null], ['member:unknown', 0, null],
  ]);
});

test('unnamed Herdr observations collapse by status instead of repeating a generic label', () => {
  assert.deepEqual(anonymousPresenceGroups([
    { id: 'one', name: null, status: 'working' },
    { id: 'two', name: 'Agent', status: 'working' },
    { id: 'two', name: 'Agent', status: 'working' },
    { id: 'three', name: null, status: 'idle' },
    { id: 'four', name: 'Named observer', status: 'working' },
  ]), [
    { status: 'working', count: 2 },
    { status: 'idle', count: 1 },
  ]);
  assert.equal(isResolvedPresenceName('Unknown'), false);
  assert.equal(isResolvedPresenceName('Agent Smith'), true);
  assert.equal(dedupeHostRows([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).length, 2);
});

test('an exact-linked Herdr observation annotates its occupant and is excluded from presence rows and counts', () => {
  const rows = [
    { id: 'linked', name: 'Pane', status: 'working', linkedOccupantId: 'agent:atlas' },
    { id: 'other', name: 'Agent', status: 'idle' },
    { id: 'other', name: 'Agent', status: 'idle' },
  ];
  assert.deepEqual(unlinkedHostRows(rows), [rows[1]]);
  assert.deepEqual(anonymousPresenceGroups(unlinkedHostRows(rows)), [{ status: 'idle', count: 1 }]);
});
