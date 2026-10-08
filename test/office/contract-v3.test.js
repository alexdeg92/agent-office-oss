'use strict';
// api-v3.md D3/D4: the office mock in 3.0 mode (version: 3) against docs/architecture/examples/v3, and the 3.0
// vocabulary end to end: occupant ids/roles, rule ids, layouts written in either vocabulary, the client's names.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareExample, compareShape, loadExample, loadSidecar } = require('../helpers/contract-shape');

const ROOT = path.resolve(__dirname, '..', '..');
const { createOfficeMock } = require(path.join(ROOT, 'public/v2/office/mock-office.js'));
const R = require(path.join(ROOT, 'public/v2/office/layout-rules.js'));
const { indexManifest } = require(path.join(ROOT, 'public/v2/office/assets.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const idx = indexManifest(manifest);
const SYSTEM_ACTOR = { kind: 'system', name: 'Système' };
const ROLES3 = ['primary', 'subagent', 'scheduled', 'direct', 'group', 'conversation'];

function compareLayoutVM3(vm) {
  const sc = loadSidecar('layout-vm', 3);
  const opaque = [...(sc.opaque ?? []), '$.layout.data', '$.default.data'];
  // layout data is checked by the shared validator, not by shape: its optional paths (presence, O8) are asserted directly
  const optional = (sc.optional ?? []).filter((p) => !opaque.some((o) => p.startsWith(o + '.')));
  return compareShape(loadExample('layout-vm', 3).data, vm, { ...sc, opaque, optional, variants: { ...(sc.variants ?? {}), '$.layout.updatedBy': [SYSTEM_ACTOR] } });
}
const only3 = (data) => data.agents.every((a) => /^(primary|\*(subagent|scheduled|direct|group|conversation)|(subagent|scheduled|direct|group|conversation):\S+)$/.test(a.agentId)
  && (!a.match || ROLES3.includes(a.match.kind)));

describe('office mock in 3.0 (api-v3 D3/D4)', () => {
  it('OfficeVM matches examples/v3/office-vm.json across the script; ids, roles, rule ids and cues are 3.0', async () => {
    for (const scenario of ['1', 'vide', 'panne']) {
      const om = createOfficeMock({ manifest, layout, scenario, version: 3 });
      for (let i = 0; i < 13; i++) {
        const vm = await om.officeVM();
        assert.deepEqual(compareExample('office-vm', vm, { version: 3 }), [], `${scenario} step ${i}`);
        for (const o of vm.occupants) {
          assert.ok(ROLES3.includes(o.role), o.role);
          assert.ok(o.id === 'primary' || /^(subagent|scheduled|direct|group|conversation):/.test(o.id), o.id);
          assert.ok(o.roleLabel.key === 'custom' || o.roleLabel.key === `occupantRole.${o.role}`);
          assert.ok(!o.ruleId || R.canonicalRuleId(o.ruleId) === o.ruleId, o.ruleId);
        }
        for (const c of om.tick()) assert.notEqual(c.occupantId, 'main');
      }
    }
  });

  it('LayoutVM matches examples/v3/layout-vm.json in 3.0 names; saves in either vocabulary; 409 current.vm too', async () => {
    const om = createOfficeMock({ manifest, layout, version: 3 });
    const vm0 = await om.layoutVM();
    assert.deepEqual(compareLayoutVM3(vm0), []);
    assert.ok(only3(vm0.layout.data) && only3(vm0.default.data), 'layout and default in 3.0 names');
    assert.ok(vm0.agentsSeen.every((a) => ROLES3.includes(a.role)));
    assert.deepEqual(vm0.layout.data.presence, { seenMinutes: 30 }, '3.0 reads show presence (O8)');
    // a 3.0 layout saves; the served layout stays 3.0; the office resolves it
    const r = await om.putLayout({ expectedRevision: vm0.layout.revision, data: vm0.layout.data });
    assert.ok(only3(r.vm.layout.data));
    assert.deepEqual(R.validateLayout(r.vm.layout.data, idx), []);
    // a 2.x layout (an old client) is accepted too, and served back in 3.0 names
    const r2 = await om.putLayout({ expectedRevision: r.revision, data: layout });
    assert.ok(only3(r2.vm.layout.data));
    om.externalEdit();
    const err = await om.putLayout({ expectedRevision: r2.revision, data: layout }).catch((e) => e);
    assert.equal(err.status, 409);
    assert.ok(only3(err.error.current.vm.layout.data), '409 current.vm in 3.0 names');
  });

  it('the same mock in 2.x mode still serves 2.x names (the client switches with config.apiVersion alone)', async () => {
    const om = createOfficeMock({ manifest, layout: R.toVocabulary(layout, '3.0'), version: 2 });
    const vm = await om.officeVM();
    assert.ok(vm.occupants.some((o) => o.id === 'main' && o.role === 'main'));
    const l2 = await om.layoutVM();
    assert.ok(l2.layout.data.agents.some((a) => a.agentId === 'main'));
    assert.equal('presence' in l2.layout.data, false, '2.x reads have no presence (O8)');
    // a 2.x save keeps the stored period
    const om3 = createOfficeMock({ manifest, layout: { ...layout, presence: { seenMinutes: 90 } }, version: 2 });
    const r = await om3.putLayout({ expectedRevision: (await om3.layoutVM()).layout.revision, data: (await om3.layoutVM()).layout.data });
    assert.equal('presence' in r.vm.layout.data, false);
    let stored; om3.externalEdit((d) => { stored = structuredClone(d.presence); });
    assert.deepEqual(stored, { seenMinutes: 90 }, 'kept in storage');
  });

  it('client names and the headline read 3.0 occupants like 2.x ones', async () => {
    const { displayName, isRawId } = await import(path.join(ROOT, 'public/v2/office/names.js'));
    const { headline } = await import(path.join(ROOT, 'public/v2/office/headline.js'));
    assert.equal(displayName({ id: 'primary', role: 'primary', name: 'primary' }, { primaryName: 'Nova' }), 'Nova');
    assert.equal(displayName({ id: 'primary', role: 'primary', name: 'primary' }), 'L’agent');
    assert.equal(displayName({ id: 'scheduled:j1', role: 'scheduled', name: 'scheduled:j1' }), 'Tâche planifiée');
    assert.equal(displayName({ id: 'conversation:k', role: 'conversation', name: '' }), 'Conversation');
    assert.ok(isRawId('direct:42', {}) && isRawId('primary', { role: 'primary' }));
    const NOW = 1791223200000;
    const h = headline({ connection: { gateway: 'up', since: NOW }, occupants: [{ id: 'primary', role: 'primary', name: 'Nova', state: 'working', stateSince: NOW - 120000 }], journal: [], queue: [] }, { now: NOW, locale: 'fr' });
    assert.equal(h.lead.replace(/[  ]/g, ' '), 'Nova travaille depuis 2 minutes.');
  });
});
