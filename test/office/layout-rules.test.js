'use strict';
// The shared semantic validator and occupant resolver (public/v2/office/layout-rules.js), the
// contract-v2 accessory/landmark/seated resolution (assets.js, landmarks.js), the editor model and
// the mock layout API. Covers review R3-07, R3-08, R3-14, R3-16, R3-18 and contract 2.0.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OFFICE = path.join(ROOT, 'public', 'v2', 'office');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const { indexManifest, accessoryLayers, poseImage, seatModeFor, landmarksFor, headTopY } = require(path.join(OFFICE, 'assets.js'));
const R = require(path.join(OFFICE, 'layout-rules.js'));
const M = require(path.join(OFFICE, 'editor-model.js'));
const { createMockLayoutStore } = require(path.join(OFFICE, 'mock-store.js'));
const { normalizeLandmarks } = require(path.join(OFFICE, 'landmarks.js'));

const idx = indexManifest(manifest);
const clone = (o) => structuredClone(o);
const codes = (l) => R.validateLayout(l, idx).map((e) => e.code);
const src = (id, role, name = id) => ({ id, role, sourceName: name });

describe('validateLayout (one validator for preview and PUT)', () => {
  it('accepts the shipped default, automatic stations included (R3-07)', () => {
    assert.deepEqual(R.validateLayout(layout, idx), []);
    assert.ok(layout.agents.some((a) => a.station === 'auto'));
  });

  it('rejects duplicate uids, unknown assets and wrong placement kinds (R3-16)', () => {
    const l = clone(layout);
    l.items.push({ ...l.items[0] });
    l.items.push({ uid: 'x-1', asset: 'nope', x: 0, y: 0 });
    l.items.push({ uid: 'wb-floor', asset: 'whiteboard', x: 5, y: 5 });
    const c = codes(l);
    for (const k of ['duplicate-uid', 'unknown-asset', 'placement-kind']) assert.ok(c.includes(k), k);
  });

  it('rejects an orientation the art does not have and a wall item on the wrong wall', () => {
    const l = clone(layout);
    l.items.find((i) => i.uid === 'st-2').orientation = 'se';
    l.items.find((i) => i.uid === 'wb').wall = 'left';
    const c = codes(l);
    assert.ok(c.includes('orientation'));
    assert.ok(c.includes('wrong-wall'));
  });

  it('rejects overlaps, out-of-room footprints and unreachable stations', () => {
    const overlap = clone(layout);
    overlap.items.push({ uid: 'p-9', asset: 'plant-small', x: 6, y: 1 });
    assert.ok(codes(overlap).includes('occupied'));
    const outside = clone(layout);
    outside.items.push({ uid: 'p-9', asset: 'plant-small', x: 12, y: 0 });
    assert.ok(codes(outside).includes('outside'));
    // Wall the entrance off with plants along row 8 → stations behind become unreachable.
    const sealed = clone(layout);
    sealed.items = sealed.items.filter((i) => !['st-3', 'st-6', 'sofa', 'lamp', 'coffee', 'rug'].includes(i.uid));
    for (let x = 0; x < 12; x++) sealed.items.push({ uid: `wall-${x}`, asset: 'plant-small', x, y: 8 });
    assert.ok(codes(sealed).includes('unreachable'));
  });

  it('checks agent rules: ids, match, stations, default rules, accessories, theme', () => {
    const l = clone(layout);
    l.agents.push({ agentId: 'subagent:abc', character: 'subagent', variant: 'teal', station: 'st-timmy', accessories: ['cap', 'headphones'] }); // desk taken, same slot twice
    l.agents.find((a) => a.agentId === '*subagent').station = 'st-2';       // default rules must be auto
    l.agents.push({ agentId: 'oops', character: 'timmy' });
    l.agents.push({ agentId: 'dm:1', match: { kind: 'cron' }, character: 'subagent' });
    l.theme = { mode: 'fixed' };
    const c = codes(l);
    for (const k of ['station-taken', 'slot-conflict', 'default-station', 'agent-id', 'match', 'theme']) assert.ok(c.includes(k), k);
  });

  it('refuses a coffee machine as a home station but accepts a sofa (contract 2.0)', () => {
    const l = clone(layout);
    l.agents.push({ agentId: 'subagent:z', character: 'subagent', station: 'coffee' });
    assert.ok(codes(l).includes('station-kind'));
    l.agents.at(-1).station = 'sofa';
    assert.ok(!codes(l).includes('station-kind'));
  });
});

describe('resolveOccupants (what OfficeVM.occupants carries)', () => {
  const people = [src('main', 'main', 'main'), src('subagent:a', 'subagent', 'Scout'), src('subagent:b', 'subagent', 'Plume'), src('cron:x', 'cron', 'Veille')];

  it('matches exact id → *role → *subagent; rotates variants; LabelRef role labels (R3-14)', () => {
    const r = R.resolveOccupants(layout, idx, people);
    // Platform direction: the shipped default names no one; the primary agent shows its discovered name…
    assert.equal(r[0].name, 'main');
    // …unless the instance configures a display name in its layout rule.
    const named = clone(layout);
    named.agents.find((x) => x.agentId === 'main').name = 'Nova';
    assert.equal(R.resolveOccupants(named, idx, people)[0].name, 'Nova');
    // The shipped rules set no role: the semantic label, localized by the UI (FR + EN).
    assert.deepEqual(r[0].roleLabel, { key: 'occupantRole.main' });
    assert.equal(r[0].stationUid, 'st-timmy');
    assert.equal(r[1].ruleId, '*subagent');
    assert.equal(r[1].name, 'Scout');
    assert.notEqual(r[1].look.variant, r[2].look.variant);
    assert.equal(r[3].ruleId, '*cron');
    assert.deepEqual(r[1].roleLabel, { key: 'occupantRole.subagent' });
    // A role written in the layout is user content: shown as written, in every language.
    const custom = clone(layout);
    custom.agents.find((a) => a.agentId === '*subagent').role = 'Recherche';
    assert.deepEqual(R.resolveOccupants(custom, idx, people)[1].roleLabel, { key: 'custom', params: { text: 'Recherche' } });
  });

  it('accessory precedence: omitted → variant defaults, [] → none, list → replaces (R3-08)', () => {
    const l = clone(layout);
    l.agents.push({ agentId: 'subagent:t', character: 'subagent', variant: 'teal' });
    l.agents.push({ agentId: 'subagent:n', character: 'subagent', variant: 'teal', accessories: [] });
    l.agents.push({ agentId: 'subagent:s', character: 'subagent', variant: 'teal', accessories: ['scarf'] });
    const [t, n, s] = R.resolveOccupants(l, idx, [src('subagent:t', 'subagent'), src('subagent:n', 'subagent'), src('subagent:s', 'subagent')]);
    assert.deepEqual(t.look.accessories, idx.characters.get('subagent').variants.find((v) => v.id === 'teal').defaultAccessories);
    assert.deepEqual(n.look.accessories, []);
    assert.deepEqual(s.look.accessories, ['scarf']);
  });

  it('allocates work desks only; legacy lounge pins migrate to desks or remain unseated', () => {
    const many = [src('main', 'main'), ...Array.from({ length: 8 }, (_, i) => src(`subagent:${i}`, 'subagent'))];
    const r = R.resolveOccupants(layout, idx, many);
    const desks = R.homeStations(layout, idx);
    assert.equal(desks.includes('sofa'), false);
    assert.ok(desks.every(uid => idx.furniture.get(layout.items.find(item => item.uid === uid)?.asset)?.station?.kind === 'desk'));
    assert.equal(r.filter(o => o.stationUid).length, desks.length);
    assert.ok(r.every(o => o.stationUid !== 'sofa'));
    assert.ok(r.filter(o => !desks.includes(o.stationUid)).every(o => o.stationUid === null));
    assert.equal(new Set(r.filter((o) => o.stationUid).map((o) => o.stationUid)).size, desks.length);
  });

  it('keeps a legacy explicit sofa rule valid but never resolves it as the agent home', () => {
    const legacy = clone(layout);
    legacy.agents.push({ agentId: 'subagent:legacy-sofa', character: 'subagent', station: 'sofa' });
    assert.deepEqual(R.validateLayout(legacy, idx), [], 'existing owner layout files remain loadable');
    const [row] = R.resolveOccupants(legacy, idx, [src('subagent:legacy-sofa', 'subagent')]);
    assert.notEqual(row.stationUid, 'sofa');
    assert.ok(R.homeStations(legacy, idx).includes(row.stationUid));
  });
});

describe('checkPlacement (editor ghost)', () => {
  it('reports occupied, blocks-access, outside and wall conflicts in French', () => {
    assert.match(R.checkPlacement(layout, idx, { asset: 'plant-small', x: 6, y: 1 }).reason, /^Occupé par /);
    // The seat tile in front of a desk keeps the station usable.
    const s = R.seatTile(layout.items.find((i) => i.uid === 'st-2'), idx.furniture.get('desk'));
    const c = R.checkPlacement(layout, idx, { asset: 'plant-small', x: s.x, y: s.y });
    assert.equal(c.ok, false);
    assert.equal(R.checkPlacement(layout, idx, { asset: 'sofa', x: 10, y: 0 }).code, 'outside');
    assert.equal(R.checkPlacement(layout, idx, { asset: 'window', wall: 'left', offset: 5 }).code, 'occupied');
    assert.equal(R.checkPlacement(layout, idx, { asset: 'window', wall: 'right', offset: 1 }).code, 'wrong-wall');
    assert.equal(R.checkPlacement(layout, idx, { asset: 'plant-small', x: 11, y: 9 }).ok, true);
  });
});

describe('editor model', () => {
  it('removing a station sends its agents back to automatic; duplicate finds a free spot', () => {
    const l = M.removeItem(layout, 'st-timmy');
    assert.equal(l.agents.find((a) => a.agentId === 'main').station, 'auto');
    const d = M.duplicateItem(layout, idx, 'plant-2');
    assert.ok(d && d.uid !== 'plant-2');
    assert.equal(R.validateLayout(d.layout, idx).length, 0);
  });

  it('toggleAccessory keeps one accessory per slot and reports the replacement', () => {
    const r = M.toggleAccessory(idx, ['headphones', 'scarf'], 'cap');
    assert.deepEqual(r, { accessories: ['scarf', 'cap'], replaced: 'headphones' });
    assert.deepEqual(M.toggleAccessory(idx, r.accessories, 'cap').accessories, ['scarf']);
  });

  it('History: undo/redo, no-op pushes ignored, dirty against the saved baseline', () => {
    const h = new M.History(layout);
    assert.equal(h.dirty, false);
    assert.equal(h.push(clone(layout)), false);
    h.push(M.renameItem(layout, 'st-2', 'Poste de Scout'));
    assert.equal(h.dirty, true);
    h.undo();
    assert.equal(h.dirty, false);
    h.redo();
    h.markSaved(h.current);
    assert.equal(h.dirty, false);
    assert.equal(h.current.items.find((i) => i.uid === 'st-2').label, 'Poste de Scout');
  });
});

describe('mock layout API (contract 2.0 shapes)', () => {
  it('PUT with a stale revision → 409 with current {revision, vm}; overwrite = resubmit with it', async () => {
    const store = createMockLayoutStore({ data: layout, defaultData: layout, manifest: null, validate: (d) => R.validateLayout(d, idx) });
    const vm = await store.get();
    assert.equal(vm.layout.revision, 1);
    assert.ok(['day', 'night'].includes(vm.theme.resolved));
    store.externalEdit((d) => { d.theme = { mode: 'fixed', fixed: 'night' }; });
    const err = await store.put({ expectedRevision: 1, data: layout }).catch((e) => e);
    assert.equal(err.status, 409);
    assert.equal(err.error.code, 'conflict');
    assert.equal(err.error.current.revision, 2);
    assert.equal(err.error.current.vm.layout.data.theme.fixed, 'night');
    const ok = await store.put({ expectedRevision: err.error.current.revision, data: layout });
    assert.equal(ok.revision, 3);
    assert.equal(ok.vm.layout.revision, 3);
  });

  it('rejects semantically invalid layouts with 400 and issue codes; keeps 20 revisions', async () => {
    const store = createMockLayoutStore({ data: layout, defaultData: layout, validate: (d) => R.validateLayout(d, idx) });
    const bad = clone(layout);
    bad.items.push({ ...bad.items[0] });
    const err = await store.put({ expectedRevision: 1, data: bad }).catch((e) => e);
    assert.equal(err.status, 400);
    assert.ok(err.error.details.some((d) => d.issue === 'duplicate-uid'));
    for (let i = 0; i < 25; i++) store.externalEdit();
    const vm = await store.get();
    assert.equal(vm.revisions.length, 20);
    assert.equal(vm.revisions[0].revision, 26);
    const old = await store.getRevision(vm.revisions.at(-1).revision);
    assert.ok(old.data.items.length);
  });
});

describe('contract v2 art resolution', () => {
  const fake = indexManifest({
    ...manifest,
    accessories: [
      { id: 'headphones', label: 'Casque', slot: 'head', images: { timmy: { idle: 'assets/Characters/x/legacy.png' } },
        layers: { timmy: { idle: { back: 'assets/Characters/x/idle.back.png', front: 'assets/Characters/x/idle.front.png' } }, 'subagent/teal': { idle: { front: 'assets/Characters/x/teal.front.png' } } } },
      { id: 'scarf', label: 'Foulard', slot: 'neck', images: { timmy: { idle: 'assets/Characters/x/scarf.png' } } },
    ],
  });

  it('draws back layers behind and front layers over the body; v2 wins over legacy per pose', () => {
    const r = accessoryLayers(fake, 'timmy', ['headphones', 'scarf'], 'idle');
    assert.deepEqual(r.back.map((a) => a.path), ['assets/Characters/x/idle.back.png']);
    assert.deepEqual(r.front.map((a) => a.path), ['assets/Characters/x/scarf.png', 'assets/Characters/x/idle.front.png']);
    assert.equal(r.front[0].legacy, true);
    assert.deepEqual(accessoryLayers(fake, 'subagent', ['headphones'], 'idle', 'teal').front.map((a) => a.path), ['assets/Characters/x/teal.front.png']);
    assert.deepEqual(accessoryLayers(fake, 'timmy', ['scarf'], 'idle', null, { legacy: false }).front, []);
  });

  it('normalises the artist landmark spelling and places markers from the head box', () => {
    const lm = normalizeLandmarks({ headCentre: [98, 151], headBox: [51.8, 115.35, 144.45, 188.45], tiltDegreesClockwise: 19, earPoints: { left: [58, 144], right: [137, 165] }, eyeLine: [[74, 149], [101, 158]], neckPoint: [85, 186], chestPoint: [81, 202] });
    assert.deepEqual(lm.headBox, { x: 51.8, y: 115.35, w: 144.45 - 51.8, h: 188.45 - 115.35 });
    assert.equal(lm.tilt, 19);
    assert.deepEqual(lm.earRight, { x: 137, y: 165 });
    assert.deepEqual(lm.eyeLine, { a: { x: 74, y: 149 }, b: { x: 101, y: 158 } });
    const sub = idx.characters.get('subagent');
    assert.ok(landmarksFor(sub, 'teal', 'idle'), 'variants inherit the family landmarks');
    const lmIdle = sub.variants.find((v) => v.id === 'teal').landmarks?.idle ?? sub.landmarks.idle;   // variant landmarks may land with 5b
    assert.equal(headTopY(sub, 'teal', 'idle'), lmIdle.headBox.y);
  });

  it('seated poses: frames and seat anchors resolve; seat mode needs the poses and station.seated', () => {
    const ch = clone(idx.characters.get('timmy'));
    const desk = idx.furniture.get('desk').station;
    assert.equal(seatModeFor(ch, null, desk), 'desk', 'Batch 6 delivered');
    for (const k of Object.keys(ch.poses)) if (/-ne$|-sw$/.test(k)) delete ch.poses[k];
    assert.equal(seatModeFor(ch, null, desk), 'stand', 'v1 standing interim without seated art');
    ch.poses['seated-ne'] = 'assets/Characters/timmy/idle.png';
    ch.poses['seated-turn-sw'] = 'assets/Characters/timmy/idle.png';
    ch.poses['working-ne'] = { frames: ['a.png', 'b.png', 'c.png'], frameMs: 350, anchor: { x: 90, y: 250 } };
    assert.equal(seatModeFor(ch, null, desk), 'desk');
    const w = poseImage(ch, null, 'working-ne');
    assert.deepEqual(w.frames, ['a.png', 'b.png', 'c.png']);
    assert.deepEqual(w.anchor, { x: 90, y: 250 });
    assert.equal(poseImage(ch, null, 'reading-ne').pose, 'working-ne');
    assert.equal(poseImage(ch, null, 'seated-celebrating-sw').pose, 'seated-turn-sw');
    assert.equal(poseImage(ch, null, 'walking-ne').pose, 'walking-se');
    assert.equal(seatModeFor(ch, null, idx.furniture.get('sofa').station), 'stand');
    assert.equal(seatModeFor(idx.characters.get('subagent'), 'teal', idx.furniture.get('sofa').station), 'sofa');
    const real = poseImage(idx.characters.get('subagent'), 'teal', 'working-ne');
    assert.equal(real.frames.length, 3);
    assert.ok(real.seatAnchor && real.seatAnchor.y > 200);
  });
});
