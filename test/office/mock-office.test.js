'use strict';
// mock-office.js: the OfficeVM / LayoutVM the Bureau page reads on mocks must match api.md 2.0
// (§3.2, §3.10) and the 2.1 proposal, and stay deterministic for screenshots and tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { createOfficeMock } = require(path.join(ROOT, 'public/v2/office/mock-office.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const STATES = ['idle', 'thinking', 'working', 'researching', 'writing', 'calling', 'waiting', 'error', 'offline'];

describe('mock OfficeVM', () => {
  it('has the api.md §3.2 shape: connection, 6 KPIs, occupants, journal, layoutRevision, queue', async () => {
    let t = 1_791_220_000_000;
    const om = createOfficeMock({ manifest, layout, now: () => (t += 1000) });
    for (let i = 0; i < 6; i++) om.tick();
    const vm = await om.officeVM();
    // T-0092 adds server-projected roster and visit data to the api.md §3.2 OfficeVM base shape.
    assert.deepEqual(Object.keys(vm).sort(), ['connection', 'conversationCount', 'conversationIds', 'conversationLabel', 'journal', 'kpis', 'layoutRevision', 'occupants', 'queue',
      'rosterAllLabel', 'rosterFloors', 'rosterGroups', 'rosterItems', 'rosterOverflowCount', 'rosterOverflowLabel', 'rosterPreviewItems', 'rosterSummary', 'stateLabels', 'unseatedTeams', 'visitIntent']);
    assert.deepEqual(vm.kpis.map((k) => k.id), ['active', 'runs', 'subagents', 'flows', 'tokens', 'cpu']);
    for (const k of vm.kpis) { assert.equal(typeof k.label.key, 'string'); assert.ok(['count', 'tokens', 'percent'].includes(k.unit)); }
    assert.equal(vm.occupants[0].id, 'main');
    for (const o of vm.occupants) {
      for (const f of ['id', 'role', 'name', 'roleLabel', 'state', 'stateSince', 'stationUid', 'look', 'sessionKey', 'tokens', 'lastSeenAt']) assert.ok(f in o, f);
      assert.ok(STATES.includes(o.state));
      assert.equal(typeof o.roleLabel.key, 'string');
      assert.deepEqual(Object.keys(o.look).sort(), ['accessories', 'character', 'variant']);
    }
    assert.equal(new Set(vm.occupants.map((o) => o.stationUid)).size, vm.occupants.length, 'unique stations');
    assert.ok(vm.journal.length <= 14);
    assert.ok(vm.journal.every((e) => e.text.key && e.actor.name));
  });

  it('scripted cues: delegating when a sub-agent appears, celebrating when one finishes', () => {
    const om = createOfficeMock({ manifest, layout });
    const all = [];
    for (let i = 0; i < 12; i++) all.push(...om.tick());
    assert.ok(all.some((c) => c.cue === 'delegating' && c.occupantId === 'main'));
    assert.ok(all.some((c) => c.cue === 'celebrating' && c.occupantId.startsWith('subagent:')));
    assert.ok(all.every((c) => c.type === 'cue' && typeof c.at === 'number'));
  });

  it('scenarios: vide = Timmy alone and idle; panne = gateway down, everyone offline', async () => {
    const vide = await createOfficeMock({ manifest, layout, scenario: 'vide' }).officeVM();
    assert.deepEqual(vide.occupants.map((o) => [o.id, o.state]), [['main', 'idle']]);
    const panne = await createOfficeMock({ manifest, layout, scenario: 'panne' }).officeVM();
    assert.equal(panne.connection.gateway, 'down');
    assert.ok(panne.occupants.every((o) => o.state === 'offline'));
  });

  it('theme route replaces only the theme, with the layout revision rule (proposal §4)', async () => {
    const om = createOfficeMock({ manifest, layout });
    const before = await om.layoutVM();
    const r = await om.putTheme({ expectedRevision: before.layout.revision, theme: { mode: 'fixed', fixed: 'night' } });
    assert.equal(r.revision, 2);
    assert.equal(r.vm.theme.resolved, 'night');
    assert.deepEqual(r.vm.layout.data.items, before.layout.data.items);
    const stale = await om.putTheme({ expectedRevision: 1, theme: { mode: 'auto' } }).catch((e) => e);
    assert.equal(stale.status, 409);
    assert.equal(stale.error.current.revision, 2);
  });
});
