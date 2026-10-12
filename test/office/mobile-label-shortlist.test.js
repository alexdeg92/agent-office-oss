'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const example = require('../../docs/architecture/examples/v3/office-vm.json').data;
const { projectOfficeRoster, projectOfficePlacement } = require('../../src/api/v2/vm/office-roster');
const schema = require('../../src/schema');
const { VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');

test('mobile label shortlist is backend-ranked, capped per floor and stable by roster order', () => {
  const occupants = [
    { id: 'agent:lead-b', role: 'agent', name: 'Lead B', state: 'idle', floorId: '1' },
    { id: 'agent:worker', role: 'agent', name: 'Worker', state: 'working', floorId: '1' },
    { id: 'agent:member-b', role: 'agent', name: 'Member B', state: 'idle', parentId: 'agent:lead-b', teamId: 'team-b', floorId: '1' },
    { id: 'agent:lead-a', role: 'agent', name: 'Lead A', state: 'idle', floorId: '1' },
    { id: 'agent:member-a', role: 'agent', name: 'Member A', state: 'idle', parentId: 'agent:lead-a', teamId: 'team-a', floorId: '1' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `agent:idle-${i}`, role: 'agent', name: `Idle ${i}`, state: 'idle', floorId: '1' })),
    { id: 'agent:other-floor', role: 'agent', name: 'Other floor', state: 'working', floorId: '2' },
  ];
  const vm = projectOfficeRoster({ occupants });
  const floorOne = vm.rosterFloors.find(floor => floor.id === '1');
  assert.deepEqual(floorOne.mobileLabelIds, ['agent:worker', 'agent:lead-b', 'agent:lead-a']);
  assert.equal(floorOne.mobileLabelIds.length, 3);
  assert.ok(floorOne.mobileLabelIds.every(id => floorOne.occupantIds.includes(id)));
  assert.equal(new Set(floorOne.mobileLabelIds).size, floorOne.mobileLabelIds.length);
  assert.deepEqual(vm.rosterFloors.find(floor => floor.id === '2').mobileLabelIds, ['agent:other-floor']);
});

test('conversation rows do not become team leads, and active team members outrank their idle lead', () => {
  const vm = projectOfficeRoster({ occupants: [
    { id: 'agent:lead', role: 'agent', name: 'Lead', state: 'idle', floorId: '1' },
    { id: 'agent:active-member', role: 'agent', name: 'Member', state: 'researching', parentId: 'agent:lead', teamId: 'team', floorId: '1' },
    { id: 'direct:chat', role: 'direct', name: 'Chat', state: 'working', floorId: '1' },
  ] });
  assert.deepEqual(vm.rosterFloors[0].mobileLabelIds, ['agent:active-member', 'agent:lead']);
  assert.equal(vm.rosterGroups[0].rootId, 'agent:lead');
});

test('the shortlist follows the backend final floor placement', () => {
  const manifest = require('../../design/office/manifest.example.json');
  const index = Object.fromEntries(['rooms', 'furniture', 'characters', 'accessories', 'themes'].map(key => [key,
    new Map(manifest[key].map(row => [row.id, row]))]));
  index.manifest = manifest;
  const layout = require('../../design/office/layout.example.json');
  const placed = projectOfficePlacement({ occupants: [
    { id: 'primary', role: 'primary', name: 'Lead', state: 'idle', floorId: '2' },
    { id: 'agent:worker', role: 'agent', name: 'Worker', state: 'working', floorId: '1' },
  ] }, { layout, index });
  const worker = placed.occupants.find(row => row.id === 'agent:worker');
  const floor = placed.rosterFloors.find(row => row.id === worker.floorId);
  assert.ok(floor.mobileLabelIds.includes(worker.id));
  assert.ok(floor.occupantIds.includes(worker.id));
  assert.ok(placed.rosterFloors.every(row => row.mobileLabelIds.length <= 3));
});

test('the strict OfficeVM schema requires a shortlist capped at three IDs', () => {
  assert.equal(schema.validate(VM_SCHEMAS_V3.office, example).ok, true);
  const tooMany = structuredClone(example);
  tooMany.rosterFloors[0].mobileLabelIds.push('agent:extra');
  assert.equal(schema.validate(VM_SCHEMAS_V3.office, tooMany).ok, false);
});
