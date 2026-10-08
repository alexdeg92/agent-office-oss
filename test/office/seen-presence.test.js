'use strict';
// O8: seen-agent presence (contract 3.0). Agents in LayoutVM.agentsSeen (migration 008's canonical inventory) that are
// no longer on stage stay at their desk, greyed, for layout.presence.seenMinutes (default 30), then leave.
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

describe('seen-agent presence (O8)', () => {
  it('shows an agent seen within the period, greyed (offline) with « vu il y a X », never one on stage or too old', () => {
    const s = seenOccupants(vm, lay3(), NOW, 3);
    assert.deepEqual(s.map((o) => o.id), ['subagent:scout']);
    const o = s[0];
    assert.deepEqual([o.state, o.presence, o.stateSince, o.lastSeenAt], ['offline', 'seen', NOW - 12 * MIN, NOW - 12 * MIN]);
    assert.match(o.presenceLabel.replace(/[  ]/g, ' '), /^Vu il y a 12 minutes$/);
    assert.ok(o.look && o.look.character, 'styled by the layout rules');
  });

  it('leaves after the layout’s period; the period is configurable; 0 turns it off; default 30 min', () => {
    assert.equal(seenOccupants(vm, lay3({ seenMinutes: 10 }), NOW, 3).length, 0, '12 min > 10 min: gone');
    assert.equal(seenOccupants(vm, lay3({ seenMinutes: 15 }), NOW, 3).length, 1);
    assert.equal(seenOccupants(vm, lay3({ seenMinutes: 0 }), NOW, 3).length, 0);
    assert.equal(seenOccupants(vm, lay3(), NOW + 18 * MIN + 1, 3).length, 0, 'default 30 min after the last activity');
    assert.equal(R.presenceMinutes({}), 30);
  });

  it('contract 3.0 only; ids compared canonically; live agents keep their desks, a seen one takes a free one', () => {
    assert.deepEqual(seenOccupants(vm, lay3(), NOW, 2), [], 'not on 2.x');
    const vm2 = { occupants: [{ ...vm.occupants[0], id: 'main', role: 'main' }] };
    assert.ok(!seenOccupants(vm2, lay3(), NOW, 3).some((o) => o.id === 'primary'), 'main ≡ primary: on stage, not seen');
    const s = seenOccupants(vm, lay3(), NOW, 3)[0];
    assert.notEqual(s.stationUid, 'st-timmy');
    assert.ok(s.stationUid === null || typeof s.stationUid === 'string');
  });

  it('R27-05: a seen agent shows the layout’s custom name (its own rule), like a live one', () => {
    const l = lay3();
    l.layout.data = { ...l.layout.data, agents: [...l.layout.data.agents, { agentId: 'subagent:scout', match: { kind: 'subagent' }, character: 'subagent', variant: 'teal', name: 'Éclaireur', role: null, station: 'auto' }] };
    assert.deepEqual(R.validateLayout(l.layout.data, idx), []);
    assert.equal(seenOccupants(vm, l, NOW, 3)[0].name, 'Éclaireur');
    assert.equal(seenOccupants(vm, lay3(), NOW, 3)[0].name, 'Scout', 'no custom name: the inventory’s');
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
