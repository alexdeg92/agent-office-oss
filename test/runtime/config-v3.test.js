'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const IC = require('../../src/instance-config'), s = require('../../src/schema');
const { scopedId, parseId } = require('../../src/runtime-ids');
const config = () => ({ version: 2, instance: { name: 'Synthetic office', locale: 'en', timeZone: 'UTC' },
  owner: { displayName: 'Operator', email: 'operator@example.test', authSource: 'database' },
  runtime: { adapter: 'demo', demo: { seed: 42 } },
  agents: { primary: 'atlas', looks: {}, names: { demo: { atlas: null } }, hidden: { demo: ['hidden'] }, configured: { demo: ['atlas'] } },
  integrations: { projet: false } });
const secrets = () => ({ version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null });
test('runtime identity codec is reversible, entity-scoped, and collision-free', () => {
  for (const local of ['agent:atlas', 'ä:/宇宙', 'rt:source:agent:eA', '__proto__', 'a:b']) {
    const id = scopedId('source', 'agent', local);
    assert.deepEqual(parseId(id), { runtime: 'source', entity: 'agent', local });
    assert.notEqual(id, scopedId('other', 'agent', local));
    assert.equal(parseId(id, 'session'), null);
  }
  for (const invalid of ['rt:source:agent:_w', 'rt:source:agent:YQ=', 'rt:source:fake:YQ', 'rt:source:agent:YQZ']) assert.equal(parseId(invalid), null);
  assert.throws(() => scopedId('bad:id', 'agent', 'a'), { code: 'EIDENTITY' });
});
test('v2 upgrade preserves auth, null names and unrelated config without mutating or writing', t => {
  const before = config(), privateValues = secrets(), expected = structuredClone(before);
  const upgraded = IC.upgradeV2(before, privateValues);
  assert.deepEqual(before, expected);
  assert.equal(upgraded.config.version, 3);
  assert.equal(upgraded.config.agents.primary, scopedId('legacy', 'agent', 'atlas'));
  assert.deepEqual(upgraded.config.agents.names, { legacy: { atlas: null } });
  assert.deepEqual(upgraded.config.agents.hidden, { legacy: ['hidden'] });
  assert.deepEqual(upgraded.config.integrations, before.integrations);
  assert.deepEqual(upgraded.config.owner, before.owner);
  assert.equal(upgraded.secrets.sessionSecret, privateValues.sessionSecret);
  assert.equal(s.validate(IC.ConfigV3Schema, upgraded.config).ok, true);
  assert.equal(s.validate(IC.SecretsV3Schema, upgraded.secrets).ok, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-config-v3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { AO_CONFIG: path.join(dir, 'config.json') }, paths = IC.configPaths(env);
  IC.writeInstanceConfig(paths, before, privateValues);
  assert.equal(IC.readInstanceConfig(env).config.version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.file)), before);
  IC.writeInstanceConfig(paths, upgraded.config, upgraded.secrets, { replace: true });
  assert.deepEqual(IC.readInstanceConfig(env).config, upgraded.config);
});
test('v3 allows zero/disabled sources, rejects duplicate IDs and malformed declared configs', () => {
  const { config: cfg } = IC.upgradeV2(config(), secrets());
  assert.equal(s.validate(IC.ConfigV3Schema, { ...cfg, runtimes: [] }).ok, true);
  assert.equal(s.validate(IC.ConfigV3Schema, { ...cfg, runtimes: [{ ...cfg.runtimes[0], enabled: false }] }).ok, true);
  assert.equal(s.validate(IC.ConfigV3Schema, { ...cfg, runtimes: [cfg.runtimes[0], cfg.runtimes[0]] }).ok, false);
  assert.equal(s.validate(IC.ConfigV3Schema, { ...cfg, runtime: cfg.runtimes[0] }).ok, false);
  assert.equal(s.validate(IC.ConfigV3Schema, { ...cfg, runtimes: [{ ...cfg.runtimes[0], unexpected: 'secret' }] }).ok, false);
});
test('runtime configuration scopes saved credentials and legacy env overrides to one instance', () => {
  const cfg = config(); cfg.runtime = { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:1234' } };
  const upgraded = IC.upgradeV2(cfg, { ...secrets(), runtimeToken: 'first-token' });
  upgraded.config.runtimes.push({ id: 'remote', adapter: 'openclaw', enabled: true, openclaw: { gatewayUrl: 'ws://127.0.0.1:5678' } });
  upgraded.secrets.runtimes.remote = { runtimeToken: 'second-token' };
  const env = IC.effectiveEnv({}, upgraded), base = require('../../src/config').tryLoadConfig({ ...env, AO_ENV: 'test', AO_DATA_DIR: '/tmp/ao-v3-synthetic' });
  const rows = IC.runtimeInstances(base, upgraded, { OC_GATEWAY_TOKEN: 'override-token', OC_GATEWAY_URL: 'ws://127.0.0.1:2345' });
  assert.equal(rows[0].cfg.gatewayToken, 'override-token'); assert.equal(rows[0].cfg.gatewayUrl, 'ws://127.0.0.1:2345');
  assert.equal(rows[1].cfg.gatewayToken, 'second-token'); assert.equal(rows[1].cfg.gatewayUrl, 'ws://127.0.0.1:5678');
  const changedDestination = IC.runtimeInstances(base, upgraded, { OC_GATEWAY_URL: 'wss://new.example.test/api' });
  assert.equal(changedDestination[0].cfg.gatewayToken, null, 'changing a destination never borrows its saved token');
  assert.equal(changedDestination[1].cfg.gatewayToken, 'second-token');
  const noLegacy = { config: { ...upgraded.config, runtimes: [upgraded.config.runtimes[1]] }, secrets: upgraded.secrets };
  assert.throws(() => IC.effectiveEnv({ OC_GATEWAY_TOKEN: 'override-token' }, noLegacy), IC.ConfigError);
});

test('runtime display labels are bounded metadata, never adapter fields or identities',()=>{
  const {config:cfg}=IC.upgradeV2(config(),secrets());
  cfg.runtimes[0].name='Synthetic demo team';
  assert.equal(s.validate(IC.ConfigV3Schema,cfg).ok,true);
  assert.deepEqual(IC.nativeRuntime(cfg.runtimes[0]),{adapter:'demo',demo:{seed:42}});
  for(const name of ['', ' ', 'a'.repeat(81), 'line\nfeed',null]) {
    cfg.runtimes[0].name=name;assert.equal(s.validate(IC.ConfigV3Schema,cfg).ok,false);
  }
});


test('RBAC activation is strict, defaults off, survives upgrades, and env overrides the file',()=>{
  const load=require('../../src/config').tryLoadConfig;
  const before=config();before.auth={rbacEnabled:true};
  const upgraded=IC.upgradeV2(before,secrets());
  assert.deepEqual(upgraded.config.auth,before.auth);
  for(const cfg of [before,upgraded.config]) {
    assert.equal(s.validate(cfg.version===3?IC.ConfigV3Schema:IC.ConfigV2Schema,cfg).ok,true);
    const files={config:cfg,secrets:cfg.version===3?upgraded.secrets:secrets()};
    const base={AO_ENV:'test',AO_DATA_DIR:'/tmp/ao-rbac-config-synthetic'};
    assert.equal(load(IC.effectiveEnv(base,files)).rbacEnabled,true);
    assert.equal(load(IC.effectiveEnv({...base,AO_RBAC_ENABLED:'0'},files)).rbacEnabled,false);
    assert.equal(s.validate(cfg.version===3?IC.ConfigV3Schema:IC.ConfigV2Schema,{...cfg,auth:{rbacEnabled:'true'}}).ok,false);
    assert.equal(s.validate(cfg.version===3?IC.ConfigV3Schema:IC.ConfigV2Schema,{...cfg,auth:{rbacEnabled:true,unexpected:true}}).ok,false);
    assert.throws(()=>load(IC.effectiveEnv({...base,AO_RBAC_ENABLED:'true'},files)));
    assert.equal(load(IC.effectiveEnv(base,{...files,config:{...cfg,auth:undefined}})).rbacEnabled,false);
  }
});
