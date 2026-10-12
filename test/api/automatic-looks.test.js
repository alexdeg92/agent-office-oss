'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { compareExample } = require('../helpers/contract-shape');
test('real API: both contracts share durable appearances; owner override/reset retain assignment', { timeout: 60000 }, async () => {
  const h = await startServer(loadScenario('synthetic-basic'));
  try {
    const before = (await h.get('/api/v3/views/office')).json;
    assert.deepEqual(compareExample('office-vm', before, { envelope: true, version: 3 }), []);
    assert.ok(before.data.occupants.every(o => o.automaticLook));
    const first = before.data.occupants.find(o => o.role === 'primary');
    const legacy = (await h.get('/api/v2/views/office')).json.data;
    assert.deepEqual(legacy.occupants.find(o => o.role === 'main').automaticLook, first.automaticLook);
    const vm = (await h.get('/api/v3/office/layout')).json;
    assert.deepEqual(compareExample('layout-vm', vm, { envelope: true, version: 3 }), []);
    assert.ok(vm.data.agentsSeen.every(o => o.automaticLook));
    const data = structuredClone(vm.data.layout.data);
    Object.assign(data.agents.find(a => a.agentId === 'primary'), { character: 'fen', variant: 'moss', accessories: [], appearance: 'manual' });
    let save = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: vm.data.layout.revision, data });
    assert.equal(save.status, 200, save.text);
    const chosen = (await h.get('/api/v3/views/office')).json.data.occupants.find(o => o.role === 'primary');
    assert.deepEqual(chosen.look, { character: 'fen', variant: 'moss', accessories: [] });
    assert.deepEqual(chosen.automaticLook, first.automaticLook);
    const restored = structuredClone(vm.data.default.data);
    save = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: save.json.data.revision, data: restored });
    assert.equal(save.status, 200, save.text);
    assert.deepEqual((await h.get('/api/v3/views/office')).json.data.occupants.find(o => o.role === 'primary').look, first.look);
    Object.assign(restored.agents.find(a => a.agentId === 'primary'), { appearance: 'invalid' });
    assert.equal((await h.request('PUT', '/api/v3/office/layout', { expectedRevision: save.json.data.revision, data: restored })).status, 400);
  } finally { await h.stop(); }
});
