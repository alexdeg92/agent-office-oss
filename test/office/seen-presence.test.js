'use strict';
// Historical agents remain available in LayoutVM for appearance editing, but do not become office occupants.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
let R, seenOccupants, idx;
before(async () => {
  R = await import('../../public/v2/office/layout-rules.js');
  ({ indexManifest: idx } = await import('../../public/v2/office/assets.js'));
  idx = idx(manifest);
  // page.js imports the browser app; the pure function is tested through a minimal import of its module graph
  ({ seenOccupants } = await import('../../public/v2/office/seen.js'));
});
const NOW = 1791223200000, MIN = 60_000;
const lay3 = (presence) => ({ manifest, layout: { data: { ...R.toVocabulary(layout, '3.0'), ...(presence === undefined ? {} : { presence }) } },
  agentsSeen: [
    { id: 'primary', role: 'primary', name: 'Orion', lastSeenAt: NOW },
    { id: 'subagent:scout', role: 'subagent', name: 'Scout', lastSeenAt: NOW - 12 * MIN },
    { id: 'subagent:old', role: 'subagent', name: 'Ancien', lastSeenAt: NOW - 3 * 86_400_000 },
  ] });
const vm = { occupants: [{ id: 'primary', role: 'primary', name: 'Orion', state: 'working', stationUid: 'st-timmy', look: {} }] };

describe('historical presence inventory', () => {
  it('never creates occupants from recently seen rows on either contract', () => {
    const history = lay3();
    assert.ok(history.agentsSeen.some(row => row.id === 'subagent:scout'), 'the inventory remains available to layout editing');
    assert.deepEqual(seenOccupants(vm, history, NOW, 3), []);
    assert.deepEqual(seenOccupants(vm, history, NOW, 2), []);
    assert.deepEqual(seenOccupants(vm, lay3({ seenMinutes: 120 }), NOW, 3), [], 'legacy presence settings cannot stage history');
  });

  it('the validator and schema accept layout.presence; invalid values are refused', () => {
    const ok = { ...layout, presence: { seenMinutes: 60 } };
    assert.deepEqual(R.validateLayout(ok, idx), []);
    for (const bad of [{ seenMinutes: -1 }, { seenMinutes: 2000 }, { seenMinutes: 1.5 }, { seenMinutes: '30' }]) {
      assert.ok(R.validateLayout({ ...layout, presence: bad }, idx).some((e) => e.code === 'presence'), JSON.stringify(bad));
    }
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.schema.json'), 'utf8'));
    assert.equal(schema.properties.presence.properties.seenMinutes.maximum, 1440);
  });
});
