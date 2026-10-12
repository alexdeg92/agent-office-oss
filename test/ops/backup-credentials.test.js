'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../../src/store');
const { hashPassword } = require('../../src/security/password');
const { backup, restore, inspectBackup } = require('../../src/ops/backup');
const cli = require('../../src/ops/cli');
const IC = require('../../src/instance-config');
const { testServerPath, waitFor, startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const ROOT = path.resolve(__dirname, '../..');
async function loginRestored(home) {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = { HOME: home, PATH: testServerPath(), NODE_OPTIONS: '', AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data'),
    PORT: String(port), HOST: '127.0.0.1', AO_RUNTIME: 'demo', AO_PROJECTS_DISCOVERY: '0', OC_CONFIG: '', OC_BIN: path.join(ROOT, 'test/bin/openclaw') };
  const child = spawn(process.execPath, ['--require', path.join(ROOT, 'test/helpers/freeze-env.js'), path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await waitFor(() => /^AO_READY \{"mode":"app"/m.test(output), { what: 'restored DB-auth app', timeoutMs: 10000 });
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-request': '1' }, body: JSON.stringify({ email: 'synthetic-owner@example.invalid', password: 'synthetic-backup-owner-password' }) });
    assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /^taco_sess=/);
  } finally { child.kill('SIGTERM'); await exited; }
}

test('S01-05: default DB-owner backups are classified sensitive; default/opt-in restores preserve owner login', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-backup-credentials-'));
  try {
    const source = path.join(tmp, 'source'), dataDir = path.join(source, 'data'), env = { HOME: source, AO_ENV: 'test', AO_DATA_DIR: dataDir };
    const hash = await hashPassword('synthetic-backup-owner-password');
    const store = openStore({ dir: dataDir, instance: 'test', ownerName: 'Synthetic Operator' });
    store.users.createOwner({ email: 'synthetic-owner@example.invalid', passwordHash: hash, personId: store.owner.id }); store.close();
    const paths = IC.configPaths(env), config = { version: 2, instance: { name: 'Synthetic backup', locale: 'fr', timeZone: 'UTC' }, owner: { displayName: 'Synthetic Operator', email: 'synthetic-owner@example.invalid', authSource: 'database' }, runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: null, looks: {} } };
    const secrets = { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null }; IC.writeInstanceConfig(paths, config, secrets);
    for (const includeSecrets of [false, true]) {
      const file = path.join(tmp, includeSecrets ? 'with-secrets.sqlite' : 'default.sqlite');
      const info = await backup({ dataDir, paths, out: file, includeSecrets });
      assert.equal(info.hasSecrets, true); assert.equal(info.hasCredentialHashes, true); assert.equal(info.hasSecretsFile, includeSecrets);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const db = new DatabaseSync(file);
      try {
        assert.ok(db.prepare('SELECT password_hash FROM users').get().password_hash === hash, 'default credential content is deliberately preserved');
        assert.equal(db.prepare("SELECT value FROM ao_backup WHERE key = 'hasCredentialHashes'").get().value, 'true');
        db.prepare("UPDATE ao_backup SET value = 'false' WHERE key = 'hasCredentialHashes'").run();
        assert.throws(() => inspectBackup(file), /credential classification/);
        db.prepare("DELETE FROM ao_backup WHERE key = 'hasCredentialHashes'").run();
        assert.equal(inspectBackup(file).hasSecrets, true, 'legacy backups are classified from actual DB contents');
      } finally { db.close(); }
      const target = path.join(tmp, includeSecrets ? 'fresh-restore' : 'existing-secrets-restore'), targetPaths = IC.configPaths({ HOME: target, AO_ENV: 'test' });
      if (!includeSecrets) IC.writeInstanceConfig(targetPaths, config, secrets);
      await restore({ dataDir: path.join(target, 'data'), paths: targetPaths, file, instance: 'test' });
      await loginRestored(target);
    }
    let message = '';
    assert.equal(await cli.run('backup', [path.join(tmp, 'cli.sqlite')], env, text => { message += text; }), 0);
    assert.match(message, /credential hashes \(sensitive; keep this file private\)/); assert.match(message, /no secrets file/); assert.ok(!message.includes(hash));
    const incomplete = path.join(tmp, 'missing-secrets'), incompletePaths = IC.configPaths({ HOME: incomplete, AO_ENV: 'test' });
    await restore({ dataDir: path.join(incomplete, 'data'), paths: incompletePaths, file: path.join(tmp, 'default.sqlite'), instance: 'test' });
    const locked = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { OC_CONFIG: '' }, prepare: home => fs.cpSync(incomplete, home, { recursive: true }) });
    try {
      const vm = (await locked.get('/api/v2/setup')).json.data;
      assert.equal(vm.state, 'locked'); assert.equal(vm.lockReason, 'missing-secrets');
      assert.equal(locked.setupCode(), null, 'configured instance never reopens onboarding');
      locked.withStore(db => assert.equal(db.prepare('SELECT password_hash FROM users').get().password_hash, hash));
    } finally { await locked.stop(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
