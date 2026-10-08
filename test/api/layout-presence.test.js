'use strict';
// G8 / office-dev O8 · LayoutData.presence { seenMinutes: 0..1440 } (operations.md §4): 3.0 reads and writes it; 2.x
// doesn't show it, and a 2.x save keeps the stored value.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

describe('O8 · layout presence', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('validated structurally; round-trips on v3; hidden on v2; a v2 save keeps it', async () => {
    let l3 = (await h.get('/api/v3/office/layout')).json.data;
    for (const bad of [{ seenMinutes: -1 }, { seenMinutes: 1441 }, { seenMinutes: 1.5 }, { seenMinutes: 10, other: 1 }, 'x']) {
      const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision, data: Object.assign({}, l3.layout.data, { presence: bad }) });
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.json.error.details[0].field, 'presence');
    }
    const ok = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision, data: Object.assign({}, l3.layout.data, { presence: { seenMinutes: 90 } }) });
    assert.equal(ok.status, 200, ok.text);
    l3 = (await h.get('/api/v3/office/layout')).json.data;
    assert.deepEqual(l3.layout.data.presence, { seenMinutes: 90 });
    const l2 = (await h.get('/api/v2/office/layout')).json.data;
    assert.equal('presence' in l2.layout.data, false, '2.x layouts have no presence');
    const data2 = JSON.parse(JSON.stringify(l2.layout.data));
    assert.equal((await h.request('PUT', '/api/v2/office/layout', { expectedRevision: l2.layout.revision, data: data2 })).status, 200);
    assert.deepEqual((await h.get('/api/v3/office/layout')).json.data.layout.data.presence, { seenMinutes: 90 }, 'a 2.x save kept it');
  });
});
