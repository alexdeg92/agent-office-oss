'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const IC = require('../../src/instance-config');
const { startServer, testServerPath } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const { openStore } = require('../../src/store');
const { hashPassword } = require('../../src/security/password');
const ROOT = path.resolve(__dirname, '../..');
async function publish(home, { missingSecrets = false } = {}) {
  const store = openStore({ dir: path.join(home, 'data'), instance: 'test', ownerName: 'Synthetic Owner' });
  try { store.users.createOwner({ email: 'synthetic-owner@example.invalid', passwordHash: await hashPassword('synthetic-owner-password'), personId: store.owner.id }); }
  finally { store.close(); }
  const config = { version: 2, instance: { name: 'Synthetic Office', locale: 'fr', timeZone: 'UTC' },
    owner: { displayName: 'Synthetic Owner', email: 'synthetic-owner@example.invalid', authSource: 'database' },
    runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: null, looks: {} } };
  const paths = IC.configPaths({ HOME: home });
  IC.writeInstanceConfig(paths, config, { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null });
  if (missingSecrets) fs.unlinkSync(paths.secrets);
}
test('critic-05 P0: a partial LOGIN_ENV is a named private boot error and preserves DB auth files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-partial-login-'));
  try {
    await publish(home);
    const files = IC.readInstanceConfig({ HOME: home });
    const protectedFiles = [files.paths.file, files.paths.secrets, path.join(home, 'data/agent-office.sqlite')];
    const before = protectedFiles.map(file => fs.readFileSync(file));
    const inherited = IC.effectiveEnv({}, files);
    assert.equal(inherited.AO_AUTH_DATABASE, '1'); assert.equal(inherited.PORTAL_EMAIL, files.config.owner.email);
    for (const key of ['PORTAL_SECRET', 'PORTAL_EMAIL', 'PORTAL_PASSWORD', 'PORTAL_PASSWORD_HASH']) {
      const value = 'synthetic-private-do-not-echo';
      assert.throws(() => IC.effectiveEnv({ [key]: value }, files), e => e instanceof IC.ConfigError && e.message.includes('incomplete environment login: ' + key) && !e.message.includes(value));
      const result = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, encoding: 'utf8', timeout: 10000,
        env: { HOME: home, PATH: testServerPath(), AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data'), [key]: value } });
      assert.equal(result.status, 1); assert.match(result.stderr, new RegExp('incomplete environment login: ' + key));
      assert.ok(!result.stderr.includes(value)); assert.ok(!result.stdout.includes('One-time setup code:'));
    }
    assert.deepEqual(protectedFiles.map(file => fs.readFileSync(file)), before);
    assert.equal(IC.effectiveEnv({}, files).AO_AUTH_DATABASE, '1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('critic-05 P1: config without secrets listens with locked setup, no code or writes, and a recovery message', async () => {
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { OC_CONFIG: '' }, prepare: home => publish(home, { missingSecrets: true }) });
  try {
    const files = IC.readInstanceConfig({ HOME: h.tmp }), before = fs.readFileSync(files.paths.file);
    for (const version of [2, 3]) {
      const response = await h.get('/api/v' + version + '/setup'); assert.equal(response.status, 200);
      assert.equal(response.json.data.state, 'locked'); assert.equal(response.json.data.lockReason, 'missing-secrets');
      assert.equal(response.json.data.draft, null); assert.ok(!response.text.includes('synthetic-owner@example.invalid'));
    }
    assert.equal(h.setupCode(), null); assert.match(h.output, /secrets.json is missing.*Restore the matching private secrets file/);
    for (const route of ['owner', 'resume', 'detect', 'check', 'discover', 'integrations/plan', 'integrations/apply', 'network']) {
      assert.equal((await h.post('/api/v2/setup/' + route, { setupCode: 'AO-ABCD-EFGH' })).status, 403, route);
    }
    assert.equal((await h.request('PUT', '/api/v2/setup', { setupCode: 'AO-ABCD-EFGH' })).status, 403);
    assert.deepEqual(fs.readFileSync(files.paths.file), before); assert.equal(fs.existsSync(files.paths.secrets), false);
  } finally { await h.stop(); }
});
