'use strict';
// Onboarding B-lite: an install whose login came from the environment, without config.json, gets an opt-in
// "Finish setting up your office" card in Settings. It lists the wizard's chapters as the Settings sections that write
// them, survives the first save (which creates config.json), and stays hidden once the owner hides it.
// An install that already has config.json never gets it.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { settingsFixture } = require('../helpers/settings-fixture');
const BASE = '/api/v3/settings';
const steps = (vm) => vm.finishSetup && Object.fromEntries(vm.finishSetup.steps.map(s => [s.id, s.done]));

test('env-login install without config.json: the card is offered, tracks what is configured, survives the first save, and hides for good', async t => {
  const h = await settingsFixture({ envOnly: true }); t.after(() => h.close());
  let vm = (await h.get(BASE)).json.data;
  assert.equal(fs.existsSync(h.paths.file), false);
  assert.deepEqual(vm.finishSetup.steps.map(s => [s.id, s.section]),
    [['connection', 'connection'], ['agents', 'runtimes'], ['looks', 'store'], ['instance', 'instance'], ['integrations', 'integrations'], ['access', 'access']]);
  assert.equal(steps(vm).instance, false); assert.equal(steps(vm).access, false); assert.equal(steps(vm).looks, null);
  await h.reauth();
  const saved = await h.put(BASE + '/instance', { expectedRevision: vm.revision, name: 'Synthetic Office' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(fs.existsSync(h.paths.file), true, 'the existing settings command wrote config.json');
  vm = (await h.get(BASE)).json.data;
  assert.equal(steps(vm).instance, true, 'still offered after the first save, with the name step done');
  const hidden = await h.post(BASE + '/finish-setup/hide', {});
  assert.equal(hidden.status, 200, hidden.text);
  assert.equal(hidden.json.data.vm.finishSetup, undefined);
  assert.equal((await h.get(BASE)).json.data.finishSetup, undefined, 'hidden stays hidden');
});

test('an install that already has config.json (wizard or earlier saves) never gets the card', async t => {
  const h = await settingsFixture(); t.after(() => h.close());
  assert.equal((await h.get(BASE)).json.data.finishSetup, undefined);
});

test('env-login install running Claude Code: the first Settings save writes a valid config (include/exclude resolved, not form strings)', async t => {
  const h = await settingsFixture({ envOnly: true, env: { AO_RUNTIME: 'claude-code' } }); t.after(() => h.close());
  const vm = (await h.get(BASE)).json.data;
  await h.reauth();
  const saved = await h.put(BASE + '/instance', { expectedRevision: vm.revision, name: 'Synthetic Office' });
  assert.equal(saved.status, 200, saved.text);
  const runtime = JSON.parse(fs.readFileSync(h.paths.file)).runtimes.find(r => r.adapter === 'claude-code');
  assert.deepEqual([runtime.claudeCode.include, runtime.claudeCode.exclude], [[], []]);
});

test('RBAC: the card summarises several settings sections, so only a caller who may read all of them gets it (owner yes, reader no)', async t => {
  const { startServer } = require('../helpers/harness'), { loadScenario } = require('../helpers/scenario');
  const h = await startServer(loadScenario('foreign-instance'), { loginEnv: true, env: { AO_RBAC_ENABLED: '1', AO_ENV: 'production', AO_API_ONLY: '1' } });
  t.after(() => h.stop());
  const owner = await h.get(BASE);
  assert.equal(owner.status, 200, owner.text);
  assert.ok(owner.json.data.finishSetup, 'the env-login owner gets the card');
  assert.equal((await h.post(BASE + '/reauth', { password: require('../helpers/harness').TEST_PASSWORD })).status, 200);
  const body = { expectedRevision: 0, email: 'reader@example.invalid', name: 'Synthetic reader', roleId: 'rol_reader' };
  const confirmation = { action: 'users.invite', target: body.email, name: body.name, revision: 0, changes: { email: body.email, name: body.name, roleId: body.roleId } };
  const issued = await h.post('/api/v3/users/invitations', { ...body, confirmation });
  assert.equal(issued.status, 200, issued.text);
  h.cookie = '';
  assert.equal((await h.post('/api/auth/invitations/accept', { token: issued.json.data.result.token, password: 'synthetic-reader-password' })).status, 200);
  const login = await h.post('/api/login', { email: body.email, password: 'synthetic-reader-password' });
  assert.equal(login.status, 200); h.cookie = login.headers.get('set-cookie').split(';')[0];
  const reader = await h.get(BASE);
  assert.equal(reader.status, 200, reader.text);
  assert.equal(reader.json.data.instance, null, 'the reader cannot read Instance');
  assert.equal(Object.hasOwn(reader.json.data, 'finishSetup'), false, 'so no completion bits about it either');
  assert.equal((await h.post(BASE + '/finish-setup/hide', {})).status, 403, 'and the reader cannot hide it');
});
