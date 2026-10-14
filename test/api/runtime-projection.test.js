'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectLegacy } = require('../../src/api/v2/runtime-projection');
const { scopedId } = require('../../src/runtime-ids');

test('v2 final legacy projection keeps floor and roster occupant references aligned with projected occupants', () => {
  const scopedLegacyAgent = `agent:${scopedId('legacy', 'agent', 'builder')}`;
  const codexAgent = `agent:${scopedId('codex', 'agent', 'worker')}`;
  const input = {
    occupants: [
      { id: scopedLegacyAgent, role: 'agent', parentId: null, groupId: scopedLegacyAgent },
      { id: codexAgent, role: 'agent', parentId: scopedLegacyAgent, groupId: scopedLegacyAgent, communication: {peerIds:[scopedLegacyAgent]} },
    ],
    rosterFloors: [{ id: '1', occupantIds: [scopedLegacyAgent, codexAgent], mobileLabelIds: [scopedLegacyAgent, codexAgent], items: [
      { kind: 'occupant', id: `occupant:${scopedLegacyAgent}`, occupantId: scopedLegacyAgent },
      { kind: 'occupant', id: `occupant:${codexAgent}`, occupantId: codexAgent },
    ] }],
    rosterGroups: [{ id: scopedLegacyAgent, rootId: scopedLegacyAgent, occupantIds: [scopedLegacyAgent, codexAgent], childIds: [codexAgent] }],
    rosterItems: [{ id: scopedLegacyAgent, rootId: scopedLegacyAgent, occupantIds: [scopedLegacyAgent, codexAgent], childIds: [codexAgent], previewOccupantIds: [codexAgent] }],
    conversationIds: [codexAgent],
    occupantsSummary: 'agent:rt:legacy:agent:YnVpbGRlcg remains ordinary user text',
  };

  const projected = projectLegacy(input, 'office');
  const projectedIds = new Set(projected.occupants.map(row => row.id));
  assert.deepEqual(projected.occupants.map(row => row.id), ['agent:builder', codexAgent]);
  assert.deepEqual(projected.rosterFloors[0].occupantIds, ['agent:builder', codexAgent]);
  assert.deepEqual(projected.rosterFloors[0].mobileLabelIds, ['agent:builder', codexAgent]);
  assert.ok(projected.rosterFloors[0].mobileLabelIds.every(id => projectedIds.has(id)), 'every shortlist ID resolves to a projected occupant');
  assert.deepEqual(projected.rosterFloors[0].items.map(row => row.occupantId), ['agent:builder', codexAgent]);
  assert.deepEqual(projected.rosterFloors[0].items.map(row => row.id), ['occupant:agent:builder', `occupant:${codexAgent}`]);
  assert.ok(projected.rosterFloors[0].items.every(row => projectedIds.has(row.occupantId)), 'every floor item resolves to a projected occupant');
  assert.deepEqual(projected.rosterGroups[0].occupantIds, ['agent:builder', codexAgent]);
  assert.deepEqual(projected.rosterItems[0].childIds, [codexAgent]);
  assert.deepEqual(projected.rosterItems[0].previewOccupantIds, [codexAgent]);
  assert.deepEqual(projected.conversationIds, [codexAgent]);
  assert.equal(projected.occupants[1].parentId, 'agent:builder');
  assert.deepEqual(projected.occupants[1].communication.peerIds, ['agent:builder']);
  assert.equal(projected.occupantsSummary, input.occupantsSummary, 'ordinary text is not rewritten');
});
