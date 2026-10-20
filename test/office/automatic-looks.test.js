'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../src/store/db');
const { createOfficeRepo } = require('../../src/store/repos/office');
const { indexManifest } = require('../../public/v2/office/assets.js');
const R = require('../../public/v2/office/layout-rules.js');
const A = require('../../public/v2/office/agent-looks.js');
const Auto = require('../../public/v2/office/automatic-looks.js');
const manifest = require('../../design/office/manifest.example.json');
const layout = require('../../design/office/layout.example.json');
const index = indexManifest(manifest);
const source = id => ({ id, role: 'agent', sourceName: id });
function database(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-looks-'))) {
  const store = openDatabase({ dir, instance: 'test', now: () => 1791673200000 });
  return { db: store.db, repo: createOfficeRepo(store.db, { now: () => 1791673200000 }), close: () => store.close(), dir };
}
function resolve(repo, sources, data = layout) {
  return R.resolveOccupants(data, index, sources, { assignLook: (id, idx, opts) => repo.automaticLook(id, idx, opts) });
}
test('every installed family is used before repeats; counts stay balanced for N identities', () => {
  const h = database(), { db, repo } = h;
  try {
    const families = Auto.installedFamilies(index).map(f => f.id);
    const rows = Array.from({ length: families.length * 9 + 3 }, (_, i) => resolve(repo, [source('agent:foreign-' + i)])[0]);
    assert.equal(new Set(rows.slice(0, families.length).map(o => index.characters.get(o.look.character).family)).size, families.length);
    const counts = db.prepare('SELECT family,count(*) AS n FROM office_automatic_looks GROUP BY family').all();
    assert.deepEqual(counts.map(r => r.family).sort(), families.sort());
    assert.ok(Math.max(...counts.map(r => r.n)) - Math.min(...counts.map(r => r.n)) <= 1);
    assert.ok(rows.some(o => !o.look.accessories.length));
    assert.ok(rows.some(o => o.look.accessories.length));
    for (const o of rows) for (const aid of o.look.accessories) assert.ok(Auto.supportedAccessories(index, o.look.character, o.look.variant).includes(aid));
  } finally { h.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});
test('assign once: join, leave, inventory pruning, restart and second connection never change a look', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-looks-'));
  let h = database(dir);
  try {
    const before = resolve(h.repo, [source('agent:hermes-alpha'), source('agent:open-beta')]);
    resolve(h.repo, Array.from({ length: 40 }, (_, i) => source('agent:new-' + i)));
    h.repo.seen(before, 1); h.repo.pruneSeen(1791673200000);
    h.close(); h = database(dir);
    assert.deepEqual(resolve(h.repo, [source('agent:open-beta'), source('agent:hermes-alpha')]).map(o => o.look), [...before].reverse().map(o => o.look));
    const second = database(dir);
    try { assert.deepEqual(resolve(second.repo, [source('agent:hermes-alpha')])[0].look, before[0].look); } finally { second.close(); }
  } finally { h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('canonical IDs share assignments across roles and 2.x/3.0 names; separate runtimes stay distinct', () => {
  const h = database(), { db, repo } = h;
  try {
    const { scopedId } = require('../../src/runtime-ids');
    const a = scopedId('hermes-one', 'agent', 'alpha'), b = scopedId('hermes-two', 'agent', 'alpha');
    const first = resolve(repo, [{ ...source('main'), role: 'main', appearanceId: 'agent:' + a }])[0];
    assert.deepEqual(resolve(repo, [source('agent:' + a)])[0].automaticLook, first.automaticLook);
    assert.deepEqual(resolve(repo, [{ ...source('subagent:' + a), role: 'subagent' }])[0].automaticLook, first.automaticLook);
    resolve(repo, [source('agent:' + b)]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM office_automatic_looks').get().n, 2);
    assert.throws(() => repo.automaticLook('*subagent', index), /invalid/);
    assert.throws(() => repo.automaticLook('main', index), /invalid/);
  } finally { h.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});
test('owner choice overrides auto, including explicit no gear; removing choice restores saved auto', () => {
  const h = database(), { db, repo } = h;
  try {
    const src = [source('agent:a')], before = resolve(repo, src)[0];
    const customized = structuredClone(layout);
    customized.agents.push({ agentId: 'agent:a', character: 'fen', variant: 'moss', accessories: [], station: 'auto', appearance: 'manual' });
    const current = resolve(repo, src, customized)[0];
    assert.deepEqual(current.look, { character: 'fen', variant: 'moss', accessories: [] });
    assert.deepEqual(current.automaticLook, before.automaticLook);
    assert.deepEqual(resolve(repo, src)[0].look, before.look);
    const wildcard = structuredClone(layout);
    Object.assign(wildcard.agents.find(a => a.agentId === '*subagent'), { appearance: 'manual', accessories: [] });
    assert.equal(resolve(repo, src, wildcard)[0].look.character, 'subagent');
  } finally { h.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});
test('editor and Store keep the persisted look and gear when changing name/station; look choice becomes manual', () => {
  const h = database(), { db, repo } = h;
  try {
    const occupants = resolve(repo, Array.from({ length: 12 }, (_, i) => source('agent:editor-' + i)));
    const rows = A.agentRows(layout, occupants, [], id => id);
    const row = rows.find(r => occupants.find(o => o.id === r.id)?.look.accessories.length);
    assert.ok(row);
    const original = occupants.find(o => o.id === row.id).look;
    assert.deepEqual(A.looksOf(layout, index, rows)[row.id], original);
    const named = A.patchAgent(layout, index, row, { name: 'Nova' });
    assert.equal(named.agents.find(a => a.agentId === row.id).appearance, 'auto');
    assert.deepEqual(A.looksOf(named, index, rows)[row.id], original);
    assert.deepEqual(R.resolveOccupants(named, index, occupants).find(o => o.id === row.id).look, original);
    const manual = A.patchAgent(named, index, row, { character: 'mote', variant: 'clay', accessories: [] });
    assert.equal(manual.agents.find(a => a.agentId === row.id).appearance, 'manual');
    assert.deepEqual(A.looksOf(manual, index, rows)[row.id], { character: 'mote', variant: 'clay', accessories: [] });
    repo.seen(occupants);
    const seen = repo.seenRecent();
    assert.deepEqual(A.looksOf(layout, index, A.agentRows(layout, [], seen, id => id))[row.id], original);
  } finally { h.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});
test('only supported accessories are automatically assigned; disabled families are absent for new IDs', () => {
  const clone = structuredClone(manifest);
  clone.characterPacks.packs = clone.characterPacks.packs.filter(p => p.id === 'fen');
  for (const a of Object.values(clone.characterPacks.packs[0].accessorySupport)) a.supported = false;
  clone.characterPacks.packs[0].accessorySupport.scarf.supported = true;
  const idx = indexManifest(clone);
  for (let i = 0; i < 100; i++) {
    const selected = Auto.chooseAutomaticLook(idx, 'agent:' + i, new Map([['bureau-bot', 5], ['family-b', 5]]));
    assert.equal(selected.look.character, 'fen');
    assert.ok(selected.look.accessories.every(a => a === 'scarf'));
  }
});
test('long native canonical-role identities retain a durable look even outside the seen inventory bound', () => {
  const h = database(), { db, repo } = h;
  try {
    const id = 'scheduled:' + '𝒜'.repeat(250);
    const first = repo.automaticLook(id, index);
    resolve(repo, [source('agent:new')]);
    assert.deepEqual(repo.automaticLook(id, index), first);
    assert.deepEqual(resolve(repo, [{ ...source('cron:' + id.slice(10)), role: 'cron' }])[0].automaticLook, first);
  } finally { h.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});
