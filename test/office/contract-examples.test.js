'use strict';
// office-dev consumes the authoritative 2.1 examples (docs/architecture/examples/): the mocks the Bureau
// page, the scene and the editor run on must have exactly the example shapes (PM decision on review-07).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareExample, compareShape, loadExample, loadSidecar } = require('../helpers/contract-shape');

// api.md §3.0: updatedBy is an ActorVM = PersonChip | { kind:'system', name }. The seeded default layout has no
// human author, so the mock uses the system member, which layout-vm.types.json doesn't list at $.layout.updatedBy
// yet (asked of architect in office-dev-06). Until then the member is passed here, as the projects tests do.
const SYSTEM_ACTOR = { kind: 'system', name: 'Système' };
function compareLayoutVM(vm) {
  const sc = loadSidecar('layout-vm');
  // layout.data / default.data follow layout.schema.json (a union: auto | fixed theme, floor | wall items), owned
  // by office-dev and checked below with the shared validator; like the manifest they're opaque to the shape check.
  const opaque = [...(sc.opaque ?? []), '$.layout.data', '$.default.data'];
  return compareShape(loadExample('layout-vm').data, vm, { ...sc, opaque, variants: { ...(sc.variants ?? {}), '$.layout.updatedBy': [SYSTEM_ACTOR] } });
}

const ROOT = path.resolve(__dirname, '..', '..');
const { createOfficeMock } = require(path.join(ROOT, 'public/v2/office/mock-office.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));

describe('office mocks ↔ docs/architecture/examples (2.1)', () => {
  it('OfficeVM matches office-vm.json across the whole script and every scenario', async () => {
    for (const scenario of ['1', 'vide', 'panne']) {
      const om = createOfficeMock({ manifest, layout, scenario });
      for (let i = 0; i < 13; i++) {
        assert.deepEqual(compareExample('office-vm', await om.officeVM()), [], `${scenario} step ${i}`);
        om.tick();
      }
    }
  });

  it('LayoutVM matches layout-vm.json, before and after saves (manifest opaque)', async () => {
    const om = createOfficeMock({ manifest, layout });
    // layout.data / default.data: the shared semantic validator (their shape contract is layout.schema.json).
    const { validateLayout } = require(path.join(ROOT, 'public/v2/office/layout-rules.js'));
    const { indexManifest } = require(path.join(ROOT, 'public/v2/office/assets.js'));
    const idx = indexManifest(manifest);
    const vm0 = await om.layoutVM();
    assert.deepEqual(validateLayout(vm0.layout.data, idx), []);
    assert.deepEqual(validateLayout(vm0.default.data, idx), []);
    assert.deepEqual(compareLayoutVM(vm0), []);
    const r = await om.putTheme({ expectedRevision: 1, theme: { mode: 'fixed', fixed: 'night' } });
    assert.deepEqual(compareLayoutVM(r.vm), []);
    assert.deepEqual(validateLayout(r.vm.layout.data, idx), [], 'the fixed-theme layout is semantically valid');
    om.externalEdit();
    const err = await om.putLayout({ expectedRevision: 2, data: layout }).catch((e) => e);
    assert.equal(err.status, 409);
    assert.deepEqual(compareLayoutVM(err.error.current.vm), [], '409 current.vm is a LayoutVM');
  });

  it('the example itself runs through the shared resolver (stations, rules, looks)', async () => {
    const ex = loadExample('office-vm').data;
    const { resolveOccupants } = require(path.join(ROOT, 'public/v2/office/layout-rules.js'));
    const { indexManifest } = require(path.join(ROOT, 'public/v2/office/assets.js'));
    const r = resolveOccupants(layout, indexManifest(manifest), ex.occupants.map((o) => ({ id: o.id, role: o.role, sourceName: o.name })));
    assert.deepEqual(r.map((o) => o.ruleId), ex.occupants.map((o) => o.ruleId));
  });
});
