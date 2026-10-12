'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visitsFromOfficeVM } = require('../../public/v2/office/visits.js');

test('browser reads the server visit intent without inferring phases, states or departure', () => {
  const intent = { hostId: 'lead', desk: ['person'], meeting: [], talking: true, speaker: 'person', until: 1800000012000,
    visitors: [{ id: 'person', phase: 'person', stateLabel: { key: 'agentState.working' }, onStage: true }] };
  const vm = { visitIntent: intent, occupants: [{ id: 'person', role: 'direct', state: 'offline', exchanges: null }] };
  assert.equal(visitsFromOfficeVM(vm), intent);
  assert.equal(visitsFromOfficeVM({ occupants: [] }), null);
});
