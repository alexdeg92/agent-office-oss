'use strict';
// ADR-001 §12.6 / migration-v3.md step 1: layout-rules.js accepts both rule vocabularies — 2.x (main, *cron, *dm,
// *channel, dm:<id>…) and 3.0 (primary, *scheduled, *direct, *group, *conversation, direct:<id>…) — everywhere:
// validation, resolution, display names, and a shared converter the server uses to normalise to 3.0 on save.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let R, idx, layout2;
before(async () => {
  R = await import('../../public/v2/office/layout-rules.js');
  const { indexManifest } = await import('../../public/v2/office/assets.js');
  idx = indexManifest(JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8')));
  layout2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
});
const clone = (x) => structuredClone(x);
const occupants2 = [
  { id: 'main', role: 'main', sourceName: 'Orion' }, { id: 'subagent:a1', role: 'subagent', sourceName: 'Lyra' },
  { id: 'cron:j1', role: 'cron', sourceName: 'Veille' }, { id: 'dm:u1', role: 'dm', sourceName: 'Camille' }, { id: 'channel:c1', role: 'channel', sourceName: 'général' },
];
const occupants3 = occupants2.map((o) => ({ ...o, id: o.id === 'main' ? 'primary' : o.id.replace(/^cron:/, 'scheduled:').replace(/^dm:/, 'direct:').replace(/^channel:/, 'group:'),
  role: { main: 'primary', cron: 'scheduled', dm: 'direct', channel: 'group' }[o.role] ?? o.role }));
const looks = (l, occ) => R.resolveOccupants(l, idx, occ).map((o) => ({ ...o.look, station: o.stationUid, rule: o.ruleId && R.canonicalRuleId(o.ruleId) }));

describe('layout rule vocabularies (ADR §12.6)', () => {
  it('canonical ids and kinds: main ≡ primary, *cron ≡ *scheduled, *dm ≡ *direct, *channel ≡ *group, plus *conversation', () => {
    const pairs = [['main', 'primary'], ['*cron', '*scheduled'], ['*dm', '*direct'], ['*channel', '*group'], ['dm:42', 'direct:42'], ['cron:j', 'scheduled:j'], ['channel:c', 'group:c']];
    for (const [a, b] of pairs) {
      assert.equal(R.canonicalRuleId(a), R.canonicalRuleId(b), `${a} ≡ ${b}`);
      assert.equal(R.ruleKind(a), R.ruleKind(b));
    }
    assert.equal(R.ruleKind('*conversation'), 'default');
    assert.equal(R.ruleKind('conversation:x'), 'exact');
    for (const bad of ['*main', '*primary', 'main:x', 'primary:x', 'robot', '', null, '*unknown', 'dm:']) assert.equal(R.ruleKind(bad), null, String(bad));
  });

  it('a layout validates in 2.x, in 3.0 and mixed; the primary rule is required under either name, once', () => {
    const layout3 = R.toVocabulary(layout2, '3.0');
    assert.ok(layout3.agents.some((a) => a.agentId === 'primary') && layout3.agents.some((a) => a.agentId === '*scheduled'));
    assert.deepEqual(R.validateLayout(layout2, idx), []);
    assert.deepEqual(R.validateLayout(layout3, idx), []);
    const mixed = clone(layout2);
    mixed.agents.find((a) => a.agentId === '*cron').agentId = '*scheduled';   // match.kind stays 'cron': same role
    assert.deepEqual(R.validateLayout(mixed, idx), []);
    const both = clone(layout2);
    both.agents.push({ ...clone(both.agents.find((a) => a.agentId === 'main')), agentId: 'primary', match: { kind: 'primary' }, station: 'auto' });
    assert.ok(R.validateLayout(both, idx).some((e) => e.code === 'duplicate-agent'), 'main + primary is one rule twice');
    const none = clone(layout2);
    none.agents = none.agents.filter((a) => a.agentId !== 'main');
    assert.ok(R.validateLayout(none, idx).some((e) => e.code === 'no-main'));
    const wrong = clone(layout3);
    wrong.agents.find((a) => a.agentId === '*direct').match = { kind: 'cron' };
    assert.ok(R.validateLayout(wrong, idx).some((e) => e.code === 'match'), 'a match kind of another role is still refused');
  });

  it('resolution gives the same looks and desks whatever vocabulary the layout and the occupants use', () => {
    const layout3 = R.toVocabulary(layout2, '3.0');
    const ref = looks(layout2, occupants2);
    assert.deepEqual(looks(layout3, occupants3), ref, '3.0 layout, 3.0 occupants');
    assert.deepEqual(looks(layout2, occupants3), ref, '2.x layout, 3.0 occupants');
    assert.deepEqual(looks(layout3, occupants2), ref, '3.0 layout, 2.x occupants');
  });

  it('*conversation styles direct and group occupants that have no rule of their own; a *direct rule wins over it', () => {
    const l = R.toVocabulary(layout2, '3.0');
    l.agents = l.agents.filter((a) => a.agentId !== '*direct' && a.agentId !== '*group');
    l.agents.push({ agentId: '*conversation', match: { kind: 'conversation' }, character: 'subagent', variant: 'teal', name: null, role: null, station: 'auto' });
    assert.deepEqual(R.validateLayout(l, idx), []);
    const pick = (layout, occ) => R.resolveOccupants(layout, idx, [occ])[0].ruleId;
    assert.equal(pick(l, { id: 'direct:u1', role: 'direct', sourceName: 'Camille' }), '*conversation');
    assert.equal(pick(l, { id: 'dm:u1', role: 'dm', sourceName: 'Camille' }), '*conversation', 'a 2.x dm occupant too');
    assert.equal(pick(l, { id: 'conversation:x', role: 'conversation', sourceName: 'Fil' }), '*conversation');
    assert.equal(pick(l, { id: 'subagent:a', role: 'subagent', sourceName: 'Lyra' }), '*subagent', 'not for sub-agents');
    l.agents.push({ agentId: '*direct', match: { kind: 'direct' }, character: 'subagent', variant: 'sage', name: null, role: null, station: 'auto' });
    assert.equal(pick(l, { id: 'direct:u1', role: 'direct', sourceName: 'Camille' }), '*direct');
  });

  it('toVocabulary converts both ways (ids and match kinds only) and round-trips', () => {
    const l3 = R.toVocabulary(layout2, '3.0');
    assert.deepEqual(l3.agents.map((a) => a.agentId), layout2.agents.map((a) => R.canonicalRuleId(a.agentId)));
    assert.ok(l3.agents.every((a) => !a.match || ['primary', 'subagent', 'scheduled', 'direct', 'group', 'conversation'].includes(a.match.kind)));
    assert.deepEqual(R.toVocabulary(l3, '2.x'), layout2, '2.x → 3.0 → 2.x is the identity');
    assert.deepEqual(l3.items, layout2.items, 'nothing else changes');
    const conv = { ...l3, agents: [...l3.agents, { agentId: '*conversation', character: 'subagent' }] };
    assert.equal(R.toVocabulary(conv, '2.x').agents.at(-1).agentId, '*conversation', 'no 2.x name: kept');
  });

  it('display names and the JSON schema accept both vocabularies', () => {
    const l = R.toVocabulary(layout2, '3.0');
    l.agents = l.agents.filter((a) => a.agentId !== 'primary');
    assert.ok(R.validateLayout(l, idx).some((e) => e.message === 'Il manque la règle de l’agent principal'));
    const dup = R.toVocabulary(layout2, '3.0');
    dup.agents.push({ ...clone(dup.agents.find((a) => a.agentId === '*scheduled')), agentId: '*cron' });
    assert.ok(R.validateLayout(dup, idx).some((e) => e.message === 'Règle en double : Tâches planifiées'), 'the 2.x id is named like its 3.0 twin');
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.schema.json'), 'utf8'));
    const pattern = new RegExp(JSON.stringify(schema).match(/"pattern":"(\^\(main\|primary[^"]+)"/)[1].replace(/\\\\/g, '\\'));
    for (const id of ['main', 'primary', '*cron', '*scheduled', '*conversation', 'dm:1', 'direct:1', 'group:c', 'subagent:x']) assert.match(id, pattern, id);
    for (const id of ['*main', 'robot', 'primary:x']) assert.doesNotMatch(id, pattern, id);
  });
});
