'use strict';
// PM audit (B), part 3: the frontend's shared VM schema module (public/v2/generated/vm-schemas.js) is up to date and
// validates exactly like the server (same DSL, same schemas).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { build, OUT } = require('../../scripts/build-vm-schemas');
const { loadExample } = require('../helpers/contract-shape');

describe('shared VM schema module (frontend)', () => {
  it('is up to date (run node scripts/build-vm-schemas.js)', () => {
    assert.equal(fs.readFileSync(OUT, 'utf8'), build());
  });
  it('as a browser ES module: the examples pass, undefined and wrong enums fail, issues are value-free', async () => {
    const m = await import(pathToFileURL(path.resolve(OUT)).href);
    assert.deepEqual(m.validateVM('office', loadExample('office-vm').data), { ok: true });
    assert.deepEqual(m.validateVM('project', loadExample('project-vm').data), { ok: true });
    assert.deepEqual(m.validateVM('prefs', { uiTheme: undefined }), { ok: false, issues: [{ path: '$.uiTheme', detail: 'undefined value' }] });
    const bad = m.validateVM('prefs', { uiTheme: 'secret-value' });
    assert.equal(bad.ok, false); assert.ok(!JSON.stringify(bad).includes('secret-value'));
    assert.equal(m.validateVM('nope', {}).ok, false);
  });
  it('browser v2/v3 validators accept the backend blocked state', async () => {
    const m = await import(pathToFileURL(path.resolve(OUT)).href);
    for (const version of [2, 3]) {
      const vm = structuredClone(loadExample('office-vm', version).data);
      vm.occupants[0].state = 'blocked';
      vm.occupants[0].stateLabel = { key: 'agentState.blocked' };
      assert.equal(m.validateVM('office', vm, version).ok, true, `v${version} blocked state is in the generated schema`);
    }
  });
});
