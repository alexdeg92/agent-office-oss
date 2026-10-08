'use strict';
// O9 · from 1 to 30 agents: agents without a home station (the overflow) fill annex rooms below the office. annex.js
// is pure: desk placement (every seat reachable, aisles), split order, and the occupants' looks kept as resolved.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const R = require(path.join(ROOT, 'public/v2/office/layout-rules.js'));
const { indexManifest } = require(path.join(ROOT, 'public/v2/office/assets.js'));
const { annexDesks, annexCapacity, annexDecor, planAnnexes } = require(path.join(ROOT, 'public/v2/office/annex.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const idx = indexManifest(manifest);

/** n agents (the primary, then sub-agents) resolved against the office like the server does. */
function crowd(n) {
  const src = [{ id: 'main', role: 'main', sourceName: 'main' }];
  for (let i = 2; i <= n; i++) src.push({ id: `subagent:a${String(i).padStart(2, '0')}`, role: 'subagent', sourceName: `Agent ${i}` });
  return R.resolveOccupants(layout, idx, src).map((o, i) => ({ ...o, id: src[i].id, role: src[i].role, name: src[i].sourceName, state: 'working' }));
}

describe('O9 · annex rooms', () => {
  it('an annex seats 12 at desks on a 3-tile grid; every seat is reachable and the layout validates', () => {
    const desks = annexDesks(idx, layout);
    assert.equal(annexCapacity(idx, layout), 12);
    assert.equal(new Set(desks.map((d) => `${d.x},${d.y}`)).size, desks.length, 'unique tiles');
    assert.ok(desks.every((d) => d.x % 3 === 0 && d.y % 3 === 0), 'aisles between desks');
    const plan = planAnnexes(idx, layout, crowd(30));
    for (const a of plan.annexes) {
      assert.deepEqual(R.validateLayout(a.layout, idx), [], a.id);
      assert.deepEqual(R.unreachableStations(a.layout, idx), [], a.id);
    }
  });

  it('O10: each annex has a little decor (alternating looks); no station, capacity and reachability unchanged', () => {
    const d1 = annexDecor(idx, layout, 1), d2 = annexDecor(idx, layout, 2);
    assert.ok(d1.length >= 3 && d2.length >= 3, 'a plant, a lamp, a window or whiteboard');
    assert.notDeepEqual(d1.map((d) => d.asset), d2.map((d) => d.asset), 'neighbouring annexes differ');
    assert.deepEqual(annexDecor(idx, layout, 3), d1);
    for (const d of [...d1, ...d2]) assert.ok(!idx.furniture.get(d.asset).station, `${d.asset} is not a station`);
    assert.ok([...d1, ...d2].some((d) => d.wall), 'something on a wall');
    const plan = planAnnexes(idx, layout, crowd(30));
    for (const a of plan.annexes) {
      const desks = a.layout.items.filter((it) => it.uid.startsWith('annex-desk-'));
      assert.equal(desks.length, 12);
      assert.ok(a.layout.items.some((it) => it.uid.startsWith('annex-decor-')), a.id);
      assert.ok(a.occupants.every((o) => o.stationUid.startsWith('annex-desk-')), 'agents sit at desks only');
    }
  });

  it('no overflow, no annex: the office is unchanged', () => {
    const few = crowd(3);
    assert.ok(few.every((o) => o.stationUid));
    const plan = planAnnexes(idx, layout, few);
    assert.equal(plan.office, few);
    assert.deepEqual(plan.annexes, []);
  });

  it('30 agents: the office keeps its stations, the rest fill annexes in roster order, 12 per room', () => {
    const all = crowd(30);
    const plan = planAnnexes(idx, layout, all);
    const seated = all.filter((o) => o.stationUid);
    const overflow = all.filter((o) => !o.stationUid);
    assert.ok(overflow.length > 12, `overflow ${overflow.length}`);
    assert.deepEqual(plan.office.map((o) => [o.id, o.stationUid]), seated.map((o) => [o.id, o.stationUid]), 'office desks untouched');
    assert.equal(plan.annexes.length, Math.ceil(overflow.length / 12));
    assert.deepEqual(plan.annexes.map((a) => a.n), plan.annexes.map((_, i) => i + 1));
    assert.deepEqual(plan.annexes.flatMap((a) => a.occupants.map((o) => o.id)), overflow.map((o) => o.id), 'roster order');
    assert.ok(plan.annexes.slice(0, -1).every((a) => a.occupants.length === 12), 'rooms fill before the next opens');
    for (const a of plan.annexes) {
      const uids = a.occupants.map((o) => o.stationUid);
      assert.ok(uids.every(Boolean), `${a.id}: everyone seated`);
      assert.equal(new Set(uids).size, uids.length, `${a.id}: one agent per desk`);
      assert.ok(uids.every((u) => a.layout.items.some((it) => it.uid === u)), `${a.id}: desks of that room`);
      assert.ok(a.layout.agents.every((r) => r.station === 'auto'), 'rules keep styling, desks are automatic');
    }
    // looks and states are kept as the server resolved them
    const before = new Map(overflow.map((o) => [o.id, o]));
    for (const o of plan.annexes.flatMap((a) => a.occupants)) {
      assert.deepEqual(o.look, before.get(o.id).look);
      assert.equal(o.state, 'working');
      assert.equal(o.destination, null);
    }
    assert.equal(plan.office.length + plan.annexes.reduce((n, a) => n + a.occupants.length, 0), 30, 'nobody lost');
  });
});
