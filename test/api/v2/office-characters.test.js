'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { officeDefaults } = require('../../../src/api/v2/vm/office');
const { buildOfficeCharactersVM } = require('../../../src/api/v2/vm/office-characters');
const { createVmCheck } = require('../../../src/api/v2/vm/check');
const { project2x } = require('../../../src/api/v2/project2x');
const { project3x } = require('../../../src/api/v2/project3x');
const { loadScenario } = require('../../helpers/scenario');
const { startServer } = require('../../helpers/harness');

const defaults = officeDefaults();
const look = { character: 'fen', variant: 'moss', accessories: [] };
const runtimeInfo = () => ({ name: 'OpenClaw', brand: { monogram: 'OC', color: '#b54d31', logo: 'assets/connectors/openclaw.svg', providerName: 'OpenClaw' } });
function occupant(id, role, name) { return { id, role, name, state: 'working', stateLabel: { key: 'agentState.working' }, roleLabel: { key: `occupantRole.${role}` }, look, automaticLook: look, groupId: 'team-1' }; }

test('office character view preserves backend grouping, applies search and exposes detected rows only in all scope', () => {
  const office = { occupants: [occupant('primary', 'primary', 'Mila'), occupant('agent:worker', 'agent', 'Noé')],
    rosterGroups: [{ id: 'team-1', label: { key: 'team.named', params: { name: 'Atelier' } }, occupantIds: ['primary', 'agent:worker'] }] };
  const seen = [{ id: 'agent:recent', role: 'agent', name: 'Lune', lastSeenAt: 99, automaticLook: look }];
  const base = { office, layout: defaults.layout, rules: defaults.rules, index: defaults.index, seen, runtimeInfo, projection: project3x };
  const officeVM = buildOfficeCharactersVM(base);
  assert.deepEqual(officeVM.groups.map(group => group.id), ['team-1']);
  assert.deepEqual(officeVM.groups[0].rows.map(row => row.name), ['Mila', 'Noé']);
  assert.deepEqual(officeVM.groups[0].rows[0].automaticLook, look);
  assert.equal(officeVM.count, 2);
  const allVM = buildOfficeCharactersVM({ ...base, scope: 'all' });
  assert.deepEqual(allVM.groups.map(group => group.id), ['team-1', 'detected']);
  assert.equal(allVM.groups[1].rows[0].inOffice, false);
  assert.equal(allVM.groups[1].rows[0].state, null);
  const searchVM = buildOfficeCharactersVM({ ...base, scope: 'all', search: 'noé' });
  assert.equal(searchVM.count, 1);
  assert.equal(searchVM.groups[0].rows[0].name, 'Noé');
  const check3 = createVmCheck({ mode: 'throw', version: 3 });
  assert.equal(check3.check('officeCharacters', allVM).count, 3);
  const legacy = buildOfficeCharactersVM({ ...base, office: { ...office, occupants: office.occupants.map(row => ({ ...row, id: project2x.occupantId(row.id), role: project2x.occupantRole(row.role) })) }, projection: project2x });
  assert.equal(createVmCheck({ mode: 'throw', version: 2 }).check('officeCharacters', legacy).count, 2);
});

test('office character v2/v3 contracts accept a backend-omitted duplicate sub-agent role label', () => {
  const occupant = { id: 'agent:task', role: 'subagent', name: '', title: { key: 'occupantRole.subagent' },
    roleLabel: null, state: 'idle', stateLabel: { key: 'agentState.idle' }, look,
    groupId: null, lastSeenAt: null };
  const base = { office: { occupants: [occupant], rosterGroups: [] }, layout: defaults.layout,
    rules: { canonicalRuleId: id => id }, index: defaults.index };
  for (const version of [2, 3]) {
    const vm = buildOfficeCharactersVM({ ...base, projection: version === 2 ? project2x : project3x });
    const check = createVmCheck({ mode: 'throw', version }).check('officeCharacters', vm);
    assert.equal(check.count, 1, `v${version}: generic sub-agent row remains schema-valid`);
  }
});

test('office character endpoint is authenticated, validates filters, and projects v2/v3 rows', async t => {
  const h = await startServer(loadScenario('synthetic-basic'));
  t.after(() => h.stop());
  for (const version of [2, 3]) {
    const office = await h.get(`/api/v${version}/views/office`);
    const response = await h.get(`/api/v${version}/views/office/characters`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.data.scope, 'office');
    assert.equal(response.json.data.count, office.json.data.occupants.length);
    assert.equal(response.json.data.groups.flatMap(group => group.rows).length, office.json.data.occupants.length);
    assert.equal((await h.get(`/api/v${version}/views/office/characters?scope=bogus`)).status, 400);
    assert.equal((await h.get(`/api/v${version}/views/office/characters?search=${'x'.repeat(121)}`)).status, 400);
  }
  const anonymous = await fetch(`${h.base}/api/v2/views/office/characters`);
  assert.equal(anonymous.status, 401);
});
