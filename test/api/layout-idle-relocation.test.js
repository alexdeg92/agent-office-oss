'use strict';
// T-0099: the backend-persisted ambient relocation threshold belongs to the office layout.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

describe('office layout idle relocation threshold', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('ships four entrance waiting targets and four Gym targets in both real layout contracts', async () => {
    const fs = require('node:fs'), path = require('node:path');
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/v2/bureau/office/manifest.example.json'), 'utf8'));
    for (const version of [2, 3]) {
      const response = await h.get(`/api/v${version}/office/layout`);
      assert.equal(response.status, 200);
      const rooms = response.json.data.manifest.rooms;
      for (const [id, kind] of [['bureau', 'idle'], ['gym', 'gym']]) {
        const room = rooms.find(r => r.id === id);
        const spots = room.activitySpots.filter(s => s.kind === kind);
        assert.equal(spots.reduce((n, s) => n + s.capacity, 0), 4);
        for (const spot of spots) {
          assert.equal(spot.capacity, spot.points.length);
          assert.equal(new Set(spot.points.map(p => `${p.x},${p.y}`)).size, spot.capacity);
        }
        assert.deepEqual(room.activitySpots, shipped.rooms.find(r => r.id === id).activitySpots, 'packaged runtime manifest carries the API destinations');
      }
      assert.ok(rooms.every(r => !r.activitySpots?.some(s => s.kind === 'smoke')), 'an indoor shell does not declare an outdoor smoking deck');
    }
  });
  it('validates 1–1440 minutes, round-trips on both contracts, and survives a v2 save that omits it', async () => {
    let l3 = (await h.get('/api/v3/office/layout')).json.data;
    for (const bad of [0, -1, 1441, 1.5, '15', null]) {
      const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision,
        data: { ...l3.layout.data, idleRelocationMinutes: bad } });
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.json.error.details[0].field, 'idleRelocationMinutes');
    }
    const saved = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision,
      data: { ...l3.layout.data, idleRelocationMinutes: 7 } });
    assert.equal(saved.status, 200, saved.text);
    l3 = (await h.get('/api/v3/office/layout')).json.data;
    assert.equal(l3.layout.data.idleRelocationMinutes, 7);
    const l2 = (await h.get('/api/v2/office/layout')).json.data;
    assert.equal(l2.layout.data.idleRelocationMinutes, 7);
    const data2 = { ...l2.layout.data };
    delete data2.idleRelocationMinutes;
    const saved2 = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: l2.layout.revision, data: data2 });
    assert.equal(saved2.status, 200, saved2.text);
    assert.equal((await h.get('/api/v3/office/layout')).json.data.layout.data.idleRelocationMinutes, 7);
  });
});
