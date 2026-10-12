'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const IC = require('../../src/instance-config');
const { tryLoadConfig } = require('../../src/config');
const { openStore } = require('../../src/store');
const { hashPassword } = require('../../src/security/password');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const scenario = () => loadScenario('foreign-instance');
const owner = { displayName: 'Synthetic Operator', email: TEST_EMAIL, password: TEST_PASSWORD, passwordConfirmation: TEST_PASSWORD };
function config(version = 2) {
  return { version, instance: { name: 'Synthetic Office', locale: 'en', timeZone: 'UTC' },
    owner: { displayName: owner.displayName, email: owner.email, ...(version === 2 ? { authSource: 'database' } : {}) },
    runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: 'atlas', looks: {} } };
}
async function publish(tmp, { withOwner = true } = {}) {
  const store = openStore({ dir: path.join(tmp, 'data'), instance: 'test', ownerName: owner.displayName });
  try { if (withOwner) store.users.createOwner({ email: owner.email, passwordHash: await hashPassword(owner.password), personId: store.owner.id }); }
  finally { store.close(); }
  // Also valid on the audited onboarding build, whose DB shape still claimed v1.
  const cfg = config(2); cfg.owner.authSource = 'database';
  IC.writeInstanceConfig(IC.configPaths({ HOME: tmp }), cfg, { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null });
}
function saveBody(code, o = owner) {
  return { setupCode: code, instance: config().instance, owner: { displayName: o.displayName, email: o.email }, runtime: { adapter: 'demo' },
    agents: { primary: 'atlas', looks: {} }, integrations: { projet: false, reviewed: true } };
}
test('critic P0: actual DB-auth boot preserves database mode and only a complete env login overrides it', async () => {
  const h = await startServer(scenario(), { loginEnv: false, demo: true, env: { AO_RUNTIME: 'demo', OC_CONFIG: '' }, prepare: publish });
  try {
    assert.equal((await h.get('/api/me')).status, 200);
    const files = IC.readInstanceConfig({ HOME: h.tmp });
    const cfg = tryLoadConfig(IC.effectiveEnv({ AO_ENV: 'test', HOME: h.tmp }, files));
    assert.equal(cfg.authDatabase, true); assert.equal(cfg.loginEmail, owner.email); assert.equal(cfg.sessionSecret, 's'.repeat(48));
    let hash; h.withStore(db => { hash = db.prepare('SELECT password_hash FROM users').get().password_hash; });
    const complete = tryLoadConfig(IC.effectiveEnv({ AO_ENV: 'test', HOME: h.tmp, PORTAL_EMAIL: 'env@example.invalid', PORTAL_PASSWORD: 'env-password', PORTAL_PASSWORD_HASH: hash, PORTAL_SECRET: 'e'.repeat(48) }, files));
    assert.equal(complete.authDatabase, false); assert.equal(complete.loginEmail, 'env@example.invalid');
    assert.throws(() => IC.effectiveEnv({ PORTAL_SECRET: 'never-echo-secret' }, files), e => e instanceof IC.ConfigError && e.message.includes('PORTAL_SECRET') && !e.message.includes('never-echo'));
    assert.throws(() => IC.effectiveEnv({ PORTAL_EMAIL: 'never-echo@example.invalid' }, files), e => e instanceof IC.ConfigError && e.message.includes('PORTAL_EMAIL') && !e.message.includes('never-echo'));
  } finally { await h.stop(); }
});
test('critic P1: kill before publication, restart, amend owner with fresh code, then publish and log in', async () => {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-owner-restart-')); let h;
  try {
    h = await startServer(scenario(), { setupMode: true, env: { OC_CONFIG: '' } });
    const oldCode = h.setupCode();
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: oldCode, owner })).status, 200);
    let id; h.withStore(db => { id = db.prepare('SELECT id FROM users').get().id; });
    const exited = once(h.child, 'exit'); h.child.kill('SIGKILL'); await exited;
    fs.cpSync(path.join(h.tmp, 'data'), path.join(saved, 'data'), { recursive: true });
    await h.stop(); h = await startServer(scenario(), { setupMode: true, env: { OC_CONFIG: '' }, prepare: tmp => fs.cpSync(path.join(saved, 'data'), path.join(tmp, 'data'), { recursive: true }) });
    const amended = { displayName: 'Corrected Operator', email: 'corrected@example.invalid', password: 'corrected-owner-password', passwordConfirmation: 'corrected-owner-password' };
    assert.notEqual(h.setupCode(), oldCode);
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: oldCode, owner: amended })).status, 403);
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner: amended })).status, 200);
    h.withStore(db => {
      assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1); assert.equal(db.prepare('SELECT id FROM users').get().id, id);
      assert.equal(db.prepare("SELECT value FROM store_meta WHERE key='setup_status'").get().value, 'open');
      assert.equal(db.prepare('SELECT count(*) n FROM office_layouts').get().n, 1);
    });
    const result = await h.request('PUT', '/api/v2/setup', saveBody(h.setupCode(), amended)); assert.equal(result.status, 200, result.text);
    await h.waitReady({ login: false });
    assert.equal((await h.post('/api/login', { email: owner.email, password: owner.password })).status, 401);
    const login = await h.post('/api/login', { email: amended.email, password: amended.password }); assert.equal(login.status, 200);
    const encoded = login.headers.get('set-cookie').split(';')[0].split('=')[1].split('.')[0];
    assert.equal(JSON.parse(Buffer.from(encoded, 'base64url')).userId, id);
    h.withStore(db => assert.equal(db.prepare("SELECT value FROM store_meta WHERE key='setup_status'").get().value, 'configured'));
  } finally { await h?.stop(); fs.rmSync(saved, { recursive: true, force: true }); }
});
test('critic P1: valid DB config with no owner reopens local code-protected recovery', async () => {
  const h = await startServer(scenario(), { setupMode: true, env: { OC_CONFIG: '' }, prepare: tmp => publish(tmp, { withOwner: false }) });
  try {
    assert.equal((await h.get('/api/v2/setup')).json.data.state, 'open');
    assert.equal((await h.post('/api/v2/setup/owner', { owner })).status, 403);
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner })).status, 200);
    const r = await h.request('PUT', '/api/v2/setup', saveBody(h.setupCode())); assert.equal(r.status, 200, r.text);
    await h.waitReady(); assert.equal((await h.get('/api/me')).status, 200);
  } finally { await h.stop(); }
});
test('critic P1: owner, person, layout seed and setup status roll back together', async () => {
  const h = await startServer(scenario(), { setupMode: true, env: { OC_CONFIG: '' }, prepare: tmp => {
    const s = openStore({ dir: path.join(tmp, 'data'), instance: 'test', seedOwner: false }); s.close();
  } });
  try {
    const counts = db => ['persons', 'users', 'office_layouts', 'store_meta'].map(table => db.prepare('SELECT count(*) n FROM ' + table).get().n);
    let before; h.withStore(db => { before = counts(db); db.exec("CREATE TRIGGER synthetic_seed_failure BEFORE INSERT ON office_layouts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"); });
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner })).status, 500);
    h.withStore(db => assert.deepEqual(counts(db), before));
  } finally { await h.stop(); }
});
test('critic P1: strict legacy v1 loads; DB-auth v2 is a separate incompatible version', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-versioned-config-'));
  const s = require('../../src/schema');
  try {
    const secrets = { version: 1, sessionSecret: 's'.repeat(48), passwordHash: await hashPassword(owner.password), runtimeToken: null };
    IC.writeInstanceConfig(IC.configPaths({ HOME: tmp }), config(1), secrets);
    assert.equal(IC.readInstanceConfig({ HOME: tmp }).config.version, 1);
    const v2 = config(2); assert.equal(s.validate(IC.ConfigSchema, v2).ok, true);
    assert.equal(s.validate(IC.LegacyConfigSchema || IC.ConfigSchema, { ...v2, version: 1 }).ok, false);
    assert.equal(s.validate(IC.LegacySecretsSchema || IC.SecretsSchema, { version: 1, sessionSecret: secrets.sessionSecret, runtimeToken: null }).ok, false);
    const malformed = structuredClone(config(1)); malformed.owner['synthetic-secret-key'] = true;
    fs.writeFileSync(IC.configPaths({ HOME: tmp }).file, JSON.stringify(malformed));
    assert.throws(() => IC.readInstanceConfig({ HOME: tmp }), e => e.message.includes('$.owner: 1 undeclared field') && !e.message.includes('synthetic-secret-key'));
    malformed.version = 999; fs.writeFileSync(IC.configPaths({ HOME: tmp }).file, JSON.stringify(malformed));
    assert.throws(() => IC.readInstanceConfig({ HOME: tmp }), /version/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
