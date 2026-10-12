'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { indexManifest } = require('../../public/v2/office/assets.js');
const { floorLayout, saveFloor } = require('../../public/v2/office/floors.js');

describe('office floor registry API', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });

  it('validates and persists floor layouts with optimistic revision; older 2.x saves preserve the registry', async () => {
    const current = (await h.get('/api/v3/office/layout')).json.data;
    const index = indexManifest(current.manifest), local = floorLayout(current.layout.data, index, '2');
    const registry = saveFloor(current.layout.data, index, '2', local);
    const saved = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: current.layout.revision, data: registry });
    assert.equal(saved.status, 200, saved.text);
    let latest = (await h.get('/api/v3/office/layout')).json.data;
    assert.ok(latest.layout.data.floors.some(f => f.id === '2' && f.layout.items.some(item => item.asset === 'elevator-door')));

    const oldV2 = (await h.get('/api/v2/office/layout')).json.data;
    const oldShape = structuredClone(oldV2.layout.data); delete oldShape.floors;
    const legacySave = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: oldV2.layout.revision, data: oldShape });
    assert.equal(legacySave.status, 200, legacySave.text);
    latest = (await h.get('/api/v3/office/layout')).json.data;
    assert.ok(latest.layout.data.floors.some(f => f.id === '2'), 'a legacy writer cannot erase floors it does not know about');
  });

  it('rejects invalid floor IDs, kinds, rooms and geometry', async () => {
    const current = (await h.get('/api/v3/office/layout')).json.data;
    for (const floor of [
      { id: '../2', kind: 'office', layout: { room: 'bureau', theme: { mode: 'auto' }, items: [] } },
      { id: '129', kind: 'office', layout: { room: 'bureau', theme: { mode: 'auto' }, items: [] } },
      { id: '2', kind: 'gym', layout: { room: 'bureau', theme: { mode: 'auto' }, items: [] } },
      { id: '3', kind: 'office', layout: { room: 'unknown', theme: { mode: 'auto' }, items: [] } },
    ]) {
      const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: current.layout.revision, data: { ...current.layout.data, floors: [floor] } });
      assert.equal(r.status, 400, JSON.stringify(floor));
    }
  });

  it('rejects a persisted homeFloor above the 128-floor domain cap', async () => {
    const current = (await h.get('/api/v3/office/layout')).json.data;
    const data = structuredClone(current.layout.data);
    for (const homeFloor of ['129', '9007199254740991']) {
      data.agents[0].homeFloor = homeFloor;
      const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: current.layout.revision, data });
      assert.equal(r.status, 400, `homeFloor ${homeFloor}: ${r.text}`);
    }
  });
});
