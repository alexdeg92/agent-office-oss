'use strict';
/*
 * G4 first-run setup end to end (api.md §5.7, ADR-001 §5), over HTTP on the real server:
 *   A. a fresh install boots in setup mode, is configured through the four routes, and switches in-process
 *   B. an install configured by ENV (production's way) reports configured and setup stays locked (PM, on architect-33)
 *   C. env always wins over stored setup values
 *   D. a read-only instance never offers setup; a bad config file refuses to start, naming the field
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');
const { compareExample } = require('../helpers/contract-shape');
const { hashPassword } = require('../../src/security/password');

const sc = loadScenario('foreign-instance');
const TOKEN = 'runtime-token-only-the-gateway-knows';
const configDir = (h) => path.join(h.tmp, '.config', 'agent-office');
const req = (h, method, p, body, headers = {}) => fetch(h.base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const saveBody = (code, over = {}) => Object.assign({ setupCode: code,
  instance: { name: 'Bureau de Camille', locale: 'en', timeZone: 'Europe/Paris' },
  owner: { displayName: 'Camille', email: TEST_EMAIL, password: TEST_PASSWORD },
  runtime: { adapter: 'openclaw', gatewayUrl: null },
  agents: { primary: 'atlas', looks: { atlas: { character: 'timmy', variant: null, accessories: ['headphones'] } } } }, over);

describe('G4 · A. a fresh install: setup mode → configured, in-process', () => {
  let h, code;
  before(async () => { h = await startServer(sc, { setupMode: true, gatewayToken: TOKEN, env: { AO_ENV: 'dev' } }); code = h.setupCode(); });
  after(async () => { if (h) await h.stop(); });

  it('setup mode: meta says not configured; every other API route is 503 not-configured; the code is in the log', async () => {
    assert.match(code, /^AO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const meta = await req(h, 'GET', '/api/v2/meta');
    assert.equal(meta.status, 200); assert.equal(meta.json.data.instance.configured, false);
    for (const p of ['/api/v2/views/office', '/api/v2/me', '/api/me']) {
      const r = await req(h, 'GET', p);
      assert.equal(r.status, 503, p);
    }
    assert.deepEqual((await req(h, 'GET', '/api/v2/views/office')).json.error.details, [{ issue: 'not-configured' }]);
    // R30-01: setup mode owns the data dir (its lock file only, 0700); no store is opened or written before setup
    assert.deepEqual(fs.readdirSync(path.join(h.tmp, 'data')).filter((f) => !f.startsWith('.server-lock.sqlite')), [], 'nothing but the lock before setup');
    assert.equal(fs.statSync(path.join(h.tmp, 'data')).mode & 0o777, 0o700);
  });

  it('GET /setup: open, a draft with no secret, the example shape', async () => {
    const r = await req(h, 'GET', '/api/v2/setup');
    assert.deepEqual(compareExample('setup-vm', r.json.data), []);
    assert.equal(r.json.data.state, 'open');
    assert.deepEqual(r.json.data.draft.runtime.tokenSet, false);
  });

  it('a wrong code is 403 setupCode and counts like a failed login (6 → 429)', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.90' };
    const r = await req(h, 'POST', '/api/v2/setup/check', { setupCode: 'AO-AAAA-AAAA', runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } }, ip);
    assert.equal(r.status, 403); assert.deepEqual(r.json.error.details, [{ field: 'setupCode', issue: 'invalid' }]);
    assert.deepEqual(compareExample('error-403-setup', r.json), []);
    for (let i = 0; i < 5; i++) await req(h, 'POST', '/api/v2/setup/check', { setupCode: 'AO-AAAA-AAAA' }, ip);
    assert.equal((await req(h, 'POST', '/api/v2/setup/check', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } }, ip)).status, 429, 'locked even with the right code');
  });

  it('check: an invalid URL is 400; a wrong token is unauthorized (200, ok:false); the right one connects (the example shape)', async () => {
    assert.deepEqual((await req(h, 'POST', '/api/v2/setup/check', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: 'http://x' } })).json.error.details, [{ field: 'runtime.gatewayUrl', issue: 'invalid' }]);
    const wrong = await req(h, 'POST', '/api/v2/setup/check', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url, token: 'wrong' } });
    assert.equal(wrong.status, 200); assert.deepEqual([wrong.json.data.result.ok, wrong.json.data.result.status], [false, 'unauthorized']);
    const good = await req(h, 'POST', '/api/v2/setup/check', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url, token: TOKEN } });
    assert.deepEqual(compareExample('setup-check-result', good.json.data), []);
    assert.deepEqual([good.json.data.result.ok, good.json.data.result.status, good.json.data.result.protocol], [true, 'connected', 4]);
    const vm = (await req(h, 'GET', '/api/v2/setup')).json.data;
    assert.equal(vm.draft.runtime.tokenSet, true);
    assert.ok(!JSON.stringify(vm).includes(TOKEN), 'the token is never echoed');
  });

  it('discover: the runtime\'s agents with the remembered token (the example shape)', async () => {
    const r = await req(h, 'POST', '/api/v2/setup/discover', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } });
    assert.deepEqual(compareExample('setup-discover-result', r.json.data), []);
    assert.deepEqual(r.json.data.result.agents.map((a) => [a.id, a.name, a.isPrimary, a.model]),
      [['atlas', 'Atlas', true, 'anthropic/claude-sonnet-5'], ['scribe', 'Scribe', false, 'mistral/mistral-large-3'], ['reviewer', 'Aaron', false, 'acme-llm/acme-1']]);
  });

  it('PUT: every invalid field is reported; nothing is written', async () => {
    const r = await req(h, 'PUT', '/api/v2/setup', saveBody(code, { instance: { name: '', locale: 'de', timeZone: 'Mars/Base' },
      owner: { displayName: 'C', email: 'nope', password: 'short' }, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url }, agents: { primary: '../x' } }));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.error.details.map((d) => d.field).sort(), ['agents.primary', 'instance.locale', 'instance.name', 'instance.timeZone', 'owner.email', 'owner.password']);
    assert.ok(!fs.existsSync(configDir(h)));
  });

  it('PUT: writes the config and the secret file (0600, no plaintext secret), spends the code, switches app in-process', async () => {
    const r = await req(h, 'PUT', '/api/v2/setup', saveBody(code, { runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(compareExample('setup-save-result', r.json.data), []);
    const cfgFile = path.join(configDir(h), 'config.json'), secFile = path.join(configDir(h), 'secrets.json');
    for (const f of [cfgFile, secFile]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
    assert.equal(fs.statSync(path.dirname(secFile)).mode & 0o777, 0o700);
    const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8')), secrets = JSON.parse(fs.readFileSync(secFile, 'utf8'));
    assert.deepEqual(config.instance, { name: 'Bureau de Camille', locale: 'en', timeZone: 'Europe/Paris' });
    assert.deepEqual(config.agents.looks.atlas, { character: 'timmy', variant: null, accessories: ['headphones'] });
    assert.ok(!fs.readFileSync(cfgFile, 'utf8').includes(TOKEN) && !fs.readFileSync(cfgFile, 'utf8').includes(TEST_PASSWORD), 'no secret in the config file');
    assert.equal(secrets.runtimeToken, TOKEN); assert.match(secrets.passwordHash, /^scrypt:/); assert.ok(!JSON.stringify(secrets).includes(TEST_PASSWORD));
    // the same process now serves the configured app on the same port
    await h.waitReady();
    const meta = (await h.get('/api/v2/meta')).json.data;
    assert.deepEqual(meta.instance, { timeZone: 'Europe/Paris', locale: 'en', configured: true });
    assert.equal(meta.primaryAgent && meta.primaryAgent.id, 'atlas');
    await waitFor(async () => (await h.get('/api/v2/me')).json.data.gateway === 'up', { what: 'the runtime connected with the token from setup' });
    // setup is locked for good; the spent code does nothing
    const vm = (await req(h, 'GET', '/api/v2/setup')).json.data;
    assert.deepEqual([vm.state, vm.configured, vm.draft], ['locked', true, null]);
    const again = await req(h, 'PUT', '/api/v2/setup', saveBody(code, { runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } }));
    assert.equal(again.status, 403); assert.deepEqual(again.json.error.details, [{ issue: 'locked' }]);
    // write-only secrets: never in the log or the audit
    assert.ok(!h.output.includes(TOKEN) && !h.output.includes(TEST_PASSWORD), 'no secret in the server output');
  });
  it('R30-01: after the handoff the configured app still owns the data dir (the lock it took in setup mode)', () => {
    const { acquireDirLock, SERVER_LOCK } = require('../../src/ops/lock');
    assert.throws(() => acquireDirLock(path.join(h.tmp, 'data'), SERVER_LOCK), (e) => e.code === 'EBUSY');
  });
});

describe('G4 · B. an install configured by ENV reports configured; setup stays locked (PM constraint)', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('configured: true; locked with no draft and no code; every setup write is 403 locked, whatever the code', async () => {
    assert.equal((await h.get('/api/v2/meta')).json.data.instance.configured, true);
    const vm = (await req(h, 'GET', '/api/v2/setup')).json.data;
    assert.deepEqual([vm.state, vm.configured, vm.draft], ['locked', true, null]);
    assert.equal(h.setupCode(), null, 'no setup code is ever printed');
    for (const [m, p] of [['POST', '/api/v2/setup/check'], ['POST', '/api/v2/setup/discover'], ['PUT', '/api/v2/setup']]) {
      for (const setupCode of ['AO-AAAA-AAAA', undefined]) {
        const r = await req(h, m, p, saveBody(setupCode, { runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url, token: 'x' } }));
        assert.equal(r.status, 403, p); assert.deepEqual(r.json.error.details, [{ issue: 'locked' }], p);
      }
    }
    assert.ok(!fs.existsSync(configDir(h)), 'nothing written');
  });
  it('a single login variable in the env locks setup too (an operator configuring by env is never taken over)', () => {
    const IC = require('../../src/instance-config');
    const none = { config: null, secrets: null };
    for (const k of IC.LOGIN_ENV) assert.equal(IC.setupState({ [k]: 'x' }, none), 'locked', k);
    assert.equal(IC.setupState({}, none), 'open');
  });
});

describe('G4 · C. env always wins over stored setup values', () => {
  let h;
  before(async () => {
    // a config + secret file from an earlier setup, with ANOTHER owner, password, locale and gateway
    h = await startServer(loadScenario('synthetic-basic'), { env: { AO_LOCALE: 'fr' }, prepare: async (tmp) => {
      const dir = path.join(tmp, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, instance: { name: 'Stored', locale: 'en', timeZone: 'Asia/Tokyo' },
        owner: { displayName: 'Mallory', email: 'mallory@example.invalid' }, runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:9' } },
        agents: { primary: 'scout', looks: {} } }), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, sessionSecret: 's'.repeat(48),
        passwordHash: await hashPassword('mallory-password-123'), runtimeToken: 'stored-token' }), { mode: 0o600 });
    } });
  });
  after(async () => { if (h) await h.stop(); });
  it('the env login works and the stored one does not; env locale and gateway win; the file fills only what env leaves unset', async () => {
    assert.equal((await req(h, 'POST', '/api/login', { email: 'mallory@example.invalid', password: 'mallory-password-123' }, { 'x-ao-request': '1' })).status, 401);
    const meta = (await h.get('/api/v2/meta')).json.data;   // h is logged in with the env credentials (harness)
    assert.equal(meta.instance.locale, 'fr', 'AO_LOCALE (env) beats the stored locale');
    assert.equal(meta.instance.timeZone, 'Asia/Tokyo', 'the stored zone fills what the env leaves unset');
    assert.equal((await h.get('/api/v2/me')).json.data.gateway, 'up', 'OC_GATEWAY_URL/TOKEN (env) beat the stored gateway');
    assert.equal(meta.primaryAgent.id, 'scout', 'the stored primary (no AO_PRIMARY_AGENT in env)');
    assert.equal((await req(h, 'GET', '/api/v2/setup')).json.data.state, 'locked');
  });
});

describe('G4 · D. read-only, and a bad config file', () => {
  let h;
  before(async () => { h = await startServer(sc, { setupMode: true, readonly: true, env: { AO_ENV: 'staging' } }); });
  after(async () => { if (h) await h.stop(); });
  it('a read-only instance never offers setup', async () => {
    const vm = (await req(h, 'GET', '/api/v2/setup')).json.data;
    assert.deepEqual([vm.state, vm.draft], ['readonly', null]);
    assert.equal(h.setupCode(), null);
    assert.equal((await req(h, 'PUT', '/api/v2/setup', saveBody('AO-AAAA-AAAA'))).status, 403);
  });
  it('an invalid config file refuses to start and names the field (never its value)', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ao-badcfg-'));
    try {
      const file = path.join(tmp, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, instance: { name: 'X', locale: 'en', timeZone: 'Secret/Zone-Value' },
        owner: { displayName: 'X', email: 'x@example.invalid' }, runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://h' } }, agents: { primary: null, looks: {} } }));
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { encoding: 'utf8', timeout: 20000,
        env: { PATH: process.env.PATH, HOME: tmp, AO_CONFIG: file, AO_ENV: 'test', AO_DATA_DIR: path.join(tmp, 'data'), PORT: '0' } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /\$\.instance\.timeZone/);
      assert.doesNotMatch(r.stderr, /Secret\/Zone-Value/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

it('an existing directory is tightened to 0700 when secrets.json is written', async () => {
  const IC = require('../../src/instance-config');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ao-mode-'));
  try {
    const dir = path.join(tmp, 'config');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    const paths = { file: path.join(dir, 'config.json'), secrets: path.join(dir, 'secrets.json') };
    IC.writeInstanceConfig(paths, {
      version: 1, instance: { name: 'Bureau', locale: 'en', timeZone: 'Europe/Paris' },
      owner: { displayName: 'Camille', email: 'owner@example.invalid' },
      runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:9' } },
      agents: { primary: 'atlas', looks: {} },
    }, { version: 1, sessionSecret: 's'.repeat(48), passwordHash: await hashPassword('owner-password-1'), runtimeToken: 'tok' });
    assert.equal(fs.statSync(paths.secrets).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
