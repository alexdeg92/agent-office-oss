'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s = require('../../src/schema');
const { SettingsVM, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
assert.equal(VM_SCHEMAS_V3.settings, SettingsVM);
const examples = path.join(__dirname, '../../docs/architecture/examples/settings');
const example = name => JSON.parse(fs.readFileSync(path.join(examples, name + '.json')));
test('Settings normal, read-only, and env override examples satisfy the strict VM', () => {
  for (const name of ['settings-vm', 'settings-readonly-vm', 'settings-env-vm', 'settings-integrations-vm']) {
    const r = s.validate(SettingsVM, example(name).data);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  }
});
test('canonical diagnostics name runtimes and distinguish healthy agents from each integration action',()=>{
 const vm=example('settings-integrations-vm').data;
 for(const r of vm.runtimes) {
  const d=vm.diagnostics.find(d=>d.id==='runtime:'+r.id);assert.equal(!!d,r.selected||r.found);
  if(d)assert.equal(d.label.params.runtime,r.name);
 }
 for(const status of ['missing','outdated','modified','unsupported']) {
  const a=vm.agents.find(a=>a.configured&&a.integrations.some(i=>i.status===status));assert.ok(a);
  const d=vm.diagnostics.find(d=>d.id==='agent:'+a.id);assert.equal(d.level,status==='unsupported'?'info':'warning');assert.equal(d.label.key,'settings.diagnostic.integration.'+status);assert.equal(d.label.params.agent,a.name);assert.equal(d.detail.key,'settings.diagnostic.integrationDetail.'+status);assert.equal(d.detail.params.integration,'projet');
 }
 const healthy=vm.diagnostics.find(d=>d.id==='agent:openclaw:atlas');assert.equal(healthy.level,'ok');assert.equal(healthy.label.key,'settings.diagnostic.agentConfigured');
});
test('SettingsVM rejects leaked credentials, unrecognized connection fields and undeclared VM properties', () => {
  for (const mutate of [
    vm => { vm.runtimes[0].values.token.value = 'secret'; },
    vm => { vm.runtimes[0].values.password = vm.runtimes[0].values.token; },
    vm => { vm.runtimes[0].secret = 'secret'; },
    vm => { vm.owner.passwordHash = 'scrypt:secret'; },
    vm => { vm.runtimes[0].values.gatewayUrl.tokenSet = true; },
    vm => { vm.agents.push(vm.agents[0]); },
  ]) {
    const vm = example('settings-vm').data; mutate(vm);
    assert.equal(s.validate(SettingsVM, vm).ok, false);
  }
});
test('every documented settings command has request and CommandResult examples', () => {
  const pairs = {
    reauth: 'reauth', check: 'check', detect: 'detect', agents: 'save', runtime: 'save', runtimes:'runtimes', restart:'restart', 'fix-all':'fix-all', instance: 'save',
    network: 'save', owner: 'save', password: 'password', 'integration-plan': 'integration-plan', 'integration-apply': 'integration-apply',
  };
  for (const [request, result] of Object.entries(pairs)) {
    assert.ok(example(request + '-request'));
    const value = example(result + '-result').data;
    assert.deepEqual(Object.keys(value).sort(), ['ok', 'result', 'revision', 'vm']);
    assert.equal(value.ok, true);
    if (value.vm) {
      assert.equal(s.validate(SettingsVM, value.vm).ok, true);
      assert.equal(value.revision, value.vm.revision);
    }
  }
});
test('environment overrides are read-only with a declared source reason; credentials stay null', () => {
  const values = example('settings-env-vm').data.runtimes[0].values;
  for (const f of Object.values(values)) {
    assert.equal(f.source, 'env'); assert.equal(f.editable, false);
    assert.equal(f.reason.key, 'settings.envOverride');
  }
  assert.equal(values.token.value, null); assert.equal(values.token.tokenSet, true);
});

test('settings refresh event has the same metadata-only payload on either stream version', () => {
  const event = example('settings-event');
  assert.equal(event.event, 'settings');
  assert.deepEqual(Object.keys(event.data).sort(), ['changed', 'restartRequired', 'revision']);
  assert.ok(Number.isInteger(event.data.revision));
  assert.ok(event.data.changed.every(field => typeof field === 'string'));
  assert.equal(typeof event.data.restartRequired, 'boolean');
  const doc = fs.readFileSync(path.join(__dirname, '../../docs/architecture/api-v3.md'), 'utf8');
  assert.ok(doc.includes('v2 and v3 streams both'));
});
