'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { once } = require('events');
const { spawn } = require('child_process');
const { detectRuntimes } = require('../../src/adapters/detection');
const { createSetupIntegrations } = require('../../src/ops/setup-integrations');
const { createNetworkGuide, networkConfig, listener } = require('../../src/ops/onboarding-network');
const IC = require('../../src/instance-config');
const { openStore } = require('../../src/store');
const { hashPassword, verifyPassword } = require('../../src/security/password');
const { startServer, waitFor } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const ROOT = path.resolve(__dirname, '../..');
const { seed, TOKEN } = require('../helpers/onboarding-fixture');
function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ao-onboarding-')); }

test('migration 014: owner hash, unique owner/email, person link and persistence', async () => {
  const tmp = fixture(); let s;
  try {
    s = openStore({ dir: tmp, instance: 'test', ownerName: 'Operator' });
    assert.equal(s.version, 15);
    const hash = await hashPassword('synthetic-owner-password');
    const owner = s.users.createOwner({ email: 'OWNER@example.invalid', passwordHash: hash, personId: s.owner.id });
    assert.equal(owner.role, 'owner'); assert.equal(owner.person_id, s.owner.id);
    assert.equal(await verifyPassword('synthetic-owner-password', owner.password_hash), true);
    assert.throws(() => s.users.createOwner({ email: 'other@example.invalid', passwordHash: hash, personId: s.owner.id }), { code: 'EOWNER' });
    s.close(); s = openStore({ dir: tmp, instance: 'test' });
    assert.equal(s.users.credential('Owner@Example.Invalid').id, owner.id);
    assert.equal(s.users.owner().password_hash, hash);
  } finally { s?.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('detectors: absent, presence-only, config/name/identity/missing name, alternate state; never write or expose fixtures outside temp', async () => {
  const tmp = fixture();
  try {
    const env = { HOME: tmp, PATH: '', AO_ENV: 'test' };
    const empty = await detectRuntimes({ env }); assert.equal(empty.length, 6); assert.ok(empty.every(d => !d.found));
    const agents = seed(tmp), file = path.join(tmp, '.openclaw', 'openclaw.json'); const before = fs.readFileSync(file, 'utf8');
    const all = await detectRuntimes({ env }), d = all.find(d => d.runtime === 'openclaw');
    assert.deepEqual(d.agents.map(a => [a.id, a.name, a.nameSource]), [['atlas', 'Orion', 'IDENTITY.md'], ['scribe', null, null]]);
    assert.equal(d.connection.gatewayUrl, 'ws://127.0.0.1:19991'); assert.equal(d.secret, TOKEN);
    assert.equal(Object.hasOwn(all.find(d => d.runtime === 'claude-code'), 'supported'), false); assert.equal(all.find(d => d.runtime === 'codex').found, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const config = JSON.parse(before); config.agents.list[0].name = 'Configured name'; config.agents.list[0].workspace = path.relative(tmp, agents[0].workspace); fs.writeFileSync(file, JSON.stringify(config));
    const named = (await detectRuntimes({ env })).find(d => d.runtime === 'openclaw').agents[0];
    assert.equal(named.nameSource, 'openclaw.json'); assert.equal(named.workspace, agents[0].workspace, 'relative paths derive from the runtime home');
    config.gateway.remote = { url: 'wss://user:synthetic-password@runtime.example.invalid/api?token=' + TOKEN, token: TOKEN };
    fs.writeFileSync(file, JSON.stringify(config));
    const remote = (await detectRuntimes({ env })).find(d => d.runtime === 'openclaw');
    assert.equal(remote.connection.gatewayUrl, 'wss://runtime.example.invalid/api');
    assert.ok(!JSON.stringify(remote.connection).includes(TOKEN) && !JSON.stringify(remote.connection).includes('synthetic-password'));
    const state = path.join(tmp, 'alternate-state'); fs.renameSync(path.join(tmp, '.openclaw'), state);
    assert.equal((await detectRuntimes({ env: { ...env, OPENCLAW_STATE_DIR: state } })).find(d => d.runtime === 'openclaw').agents.length, agents.length);
    await assert.rejects(detectRuntimes({ env: { ...env, HOME: ROOT } }), { code: 'ETESTPATH' });
    const outside = path.join(tmp, 'outside'); fs.symlinkSync(ROOT, outside);
    await assert.rejects(detectRuntimes({ env: { ...env, OC_CONFIG: path.join(outside, 'package.json') } }), { code: 'ETESTPATH' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('adapter installation: exact per-agent plans, one confirmation, idempotence, stale-plan/symlink refusal, uninstall preserves unrelated text', async () => {
  const tmp = fixture();
  try {
    const agents = seed(tmp), env = { HOME: tmp, AO_ENV: 'test', PATH: '' };
    const I = createSetupIntegrations({ env, paths: {}, dataDir: path.join(tmp, 'data') });
    const p = await I.plan({ runtime: 'openclaw', agents, locale: 'en' });
    assert.equal(p.agents.length, 2); assert.ok(p.agents.every(a => a.files.length === 3 && a.status === 'absent'));
    assert.ok(!fs.existsSync(path.join(agents[0].workspace, 'skills')), 'planning writes nothing');
    assert.throws(() => I.apply({ planId: p.planId, agentIds: ['atlas'] }), { code: 'ECONFIRM' });
    const apply = action => I.apply({ planId: p.planId, agentIds: ['atlas', 'scribe'], confirmed: true, action });
    assert.ok(apply('install').agents.every(a => a.status === 'installed'));
    assert.ok(apply('install').agents.every(a => a.changed.length === 0));
    assert.ok(fs.readdirSync(p.backupDir).length >= 2);
    assert.ok(apply('uninstall').agents.every(a => a.status === 'absent')); assert.ok(!fs.existsSync(path.join(agents[0].workspace, 'skills', 'projet')));
    assert.match(fs.readFileSync(path.join(agents[0].workspace, 'AGENTS.md'), 'utf8'), /Keep this text/);
    const stale = await I.plan({ runtime: 'openclaw', agents }); fs.appendFileSync(path.join(agents[1].workspace, 'AGENTS.md'), 'Changed after plan\n');
    assert.throws(() => I.apply({ planId: stale.planId, agentIds: ['atlas', 'scribe'], confirmed: true }), { code: 'ESTALEPLAN' });
    assert.ok(!fs.existsSync(path.join(agents[0].workspace, 'skills', 'projet')), 'all targets checked before first write');
    fs.symlinkSync(agents[0].workspace, path.join(tmp, 'linked-workspace'));
    await assert.rejects(I.plan({ runtime: 'openclaw', agents: [{ id: 'linked', workspace: path.join(tmp, 'linked-workspace') }] }), { code: 'EUNSAFEPATH' });
    fs.symlinkSync(path.join(tmp, 'missing-target'), path.join(tmp, 'dangling-workspace'));
    await assert.rejects(I.plan({ runtime: 'openclaw', agents: [{ id: 'dangling', workspace: path.join(tmp, 'dangling-workspace') }] }), { code: 'EUNSAFEPATH' });
    assert.equal((await I.plan({ runtime: 'demo', agents: [{ id: 'a' }] })).agents[0].status, 'unsupported');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});


test('network probes fail closed in tests when any fixture is missing', async () => {
  const { networkFixtures } = require('../helpers/onboarding-network-fixture');
  const env = { AO_ENV: 'test', HOST: '127.0.0.1', PORT: '19999' };
  const deps = networkFixtures(env);
  for (const key of ['lookup', 'fetcher', 'interfaces', 'run', 'findBinary']) {
    const partial = { ...deps }; delete partial[key];
    const guide = createNetworkGuide({ env, ...partial });
    await assert.rejects(guide.inspect({ domain: 'office.example.invalid', publicIp: true }), { code: 'ETESTPROBE' }, key);
    await assert.rejects(guide.probe('https://office.example.invalid'), { code: 'ETESTPROBE' }, key);
  }
  assert.deepEqual(deps.calls, [], 'guard runs before even an injected probe');
});

test('network guidance: no system writes, explicit public IP, injected DNS/tailnet, build check and typed own config', async () => {
  const tmp = fixture();
  try {
    const bin = path.join(tmp, 'tailscale'); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 }); let requests = [];
    const G = createNetworkGuide({ findBinary: () => bin, env: { AO_ENV: 'test', PATH: tmp, HOST: '127.0.0.1', PORT: '18789' },
      interfaces: () => ({ lan: [{ address: '192.0.2.20' }] }), lookup: async () => [{ address: '203.0.113.42' }],
      run: async (_, argv) => { assert.deepEqual(argv, ['status', '--json']); return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'office.tail.example.' } }) }; },
      fetcher: async url => { requests.push(url); return new Response(JSON.stringify(url.includes('ipify') ? { ip: '203.0.113.42' } : { buildId: 'synthetic' }), { headers: { 'content-type': 'application/json' } }); } });
    const g = await G.inspect({ domain: 'office.example.com', port: 18789 }); assert.equal(g.dns.status, 'unknown'); assert.equal(requests.length, 0);
    assert.equal((await G.inspect({ domain: 'office.example.com', publicIp: true })).dns.status, 'matches');
    assert.deepEqual(listener({ HOST: '127.0.0.1', PORT: '19999', AO_UI_HOST: '0.0.0.0', AO_UI_PORT: '18888' }), { host: '0.0.0.0', port: 18888 }, 'combined public listener takes precedence over API child');
    assert.equal(g.tailnet.online, true); assert.ok(g.snippets.caddy.includes('127.0.0.1:18789'));
    assert.equal((await G.probe('https://office.example.com')).ok, true); assert.equal(requests.at(-1), 'https://office.example.com/build.json');
    await assert.rejects(G.probe('https://user:secret@example.com'));
    await assert.rejects(G.inspect({ domain: 'bad\nconfig' }));
    assert.throws(() => networkConfig({ mode: 'public', port: 18789, publicUrl: 'http://office.example.com' }));
    assert.deepEqual(networkConfig({ mode: 'lan', port: 19999, publicUrl: 'http://192.0.2.20:19999' }), { mode: 'lan', host: '0.0.0.0', port: 19999, publicUrl: 'http://192.0.2.20:19999', cookieSecure: false });
    assert.equal(networkConfig({ mode: 'tunnel', port: 18789, publicUrl: 'https://office.example.com' }).cookieSecure, true);
    assert.deepEqual(fs.readdirSync(tmp), ['tailscale']);
    const hash = await hashPassword('synthetic-network-owner-password');
    for (const mode of ['local', 'lan', 'tailnet', 'public', 'tunnel']) {
      const publicUrl = mode === 'local' ? null : mode === 'lan' ? 'http://192.0.2.20:19999' : 'https://office.example.invalid';
      const network = networkConfig({ mode, port: 19999, publicUrl });
      const dir = path.join(tmp, 'own-' + mode), env = { HOME: tmp, AO_CONFIG: path.join(dir, 'config.json') };
      IC.writeInstanceConfig(IC.configPaths(env), { version: 2, instance: { name: 'Synthetic', locale: 'fr', timeZone: 'UTC' },
        owner: { displayName: 'Operator', email: 'owner@example.invalid', authSource: 'database' }, runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: 'a', looks: {} }, network },
        { version: 2, sessionSecret: 's'.repeat(48), runtimeToken: null });
      const files = IC.readInstanceConfig(env), eff = IC.effectiveEnv({}, files);
      assert.equal(eff.HOST, mode === 'lan' ? '0.0.0.0' : '127.0.0.1'); assert.equal(eff.PORT, '19999');
      assert.equal(eff.AO_PUBLIC_URL || null, publicUrl); assert.equal(eff.PORTAL_COOKIE_SECURE, ['tailnet', 'public', 'tunnel'].includes(mode) ? '1' : '0');
      assert.equal(IC.effectiveEnv({ PORT: '20000' }, files).PORT, '20000', 'explicit env retains precedence');
    }

  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('an unfinished DB owner resumes setup with a fresh code and can amend the saved account', async () => {
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { OC_CONFIG: '' }, prepare: async tmp => {
    const store = openStore({ dir: path.join(tmp, 'data'), instance: 'test', ownerName: 'Operator' });
    try { store.users.createOwner({ email: 'owner@example.invalid', passwordHash: await hashPassword('synthetic-owner-password'), personId: store.owner.id }); }
    finally { store.close(); }
  } });
  try {
    const vm = (await h.get('/api/v2/setup')).json.data;
    assert.equal(vm.state, 'open'); assert.deepEqual(vm.draft.owner, { displayName: '', email: '', passwordSet: true });
    const resumed = await h.post('/api/v2/setup/resume', { setupCode: h.setupCode() });
    assert.deepEqual(resumed.json.data.result.owner, { displayName: 'Operator', email: 'owner@example.invalid', passwordSet: true });
    assert.ok(h.setupCode());
    const owner = { displayName: 'Operator', email: 'owner@example.invalid' };
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner })).status, 200);
    assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner: { ...owner, email: 'other@example.invalid' } })).status, 200);
    h.withStore(db => assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1));
  } finally { await h.stop(); }
});

test('new HTTP onboarding: DB owner, hidden detected token, names/styles, network files, lock, DB login after restart and env fallback', async () => {
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, gatewayToken: TOKEN, env: { OC_CONFIG: '' }, prepare: seed });
  let restarted;
  try {
    assert.deepEqual((await h.get('/api/v2/setup')).json.data.network, { host: '127.0.0.1', port: h.port });
    const code = h.setupCode(), owner = { displayName: 'Operator', email: 'owner@example.invalid', password: 'synthetic-owner-password', passwordConfirmation: 'synthetic-owner-password' };
    const post = (p, b = {}) => h.post('/api/v2/setup/' + p, { setupCode: code, ...b });
    assert.equal((await post('owner', { owner: { ...owner, passwordConfirmation: 'different' } })).status, 400);
    assert.equal((await post('owner', { owner })).status, 200);
    h.withStore(db => { const row = db.prepare('SELECT * FROM users').get(); assert.equal(row.role, 'owner'); assert.match(row.password_hash, /^scrypt:/); assert.ok(!JSON.stringify(row).includes(owner.password)); });
    const detection = await post('detect'); assert.equal(detection.status, 200, detection.text);
    assert.ok(!detection.text.includes(TOKEN)); assert.ok(!detection.text.includes(h.tmp), 'no private workspace paths in detection');
    const runtime = { adapter: detection.json.data.result.selected, gatewayUrl: h.gw.url };
    assert.equal((await post('check', { runtime })).json.data.result.ok, true);
    assert.equal((await post('discover', { runtime })).json.data.result.agents[0].name, 'Orion');
    const plan = (await post('integrations/plan', { runtime })).json.data.result;
    assert.equal((await post('integrations/apply', { planId: plan.planId, agentIds: ['atlas', 'scribe'], confirmed: true })).status, 200);
    const body = { setupCode: code, instance: { name: 'Synthetic Bureau', locale: 'fr', timeZone: 'UTC' }, owner: { displayName: owner.displayName, email: owner.email }, runtime,
      agents: { primary: 'atlas', names: { atlas: 'Orion', scribe: 'Lyra' }, looks: { atlas: { character: 'fen', variant: null, accessories: [] }, scribe: { character: 'robot', variant: null, accessories: [] } } },
      integrations: { projet: true, reviewed: true }, network: { mode: 'public', port: h.port, publicUrl: 'https://bureau.example.invalid' } };
    // Unknown model fails before publishing. Valid model comes from the catalog.
    const catalog = (await h.get('/api/v2/setup/catalog')).json.data;
    body.agents.looks.scribe.character = catalog.characterPacks.packs[1].id;
    const save = await h.request('PUT', '/api/v2/setup', body); assert.equal(save.status, 200, save.text);
    await h.waitReady({ login: false });
    const login = await h.post('/api/login', { email: owner.email, password: owner.password }); assert.equal(login.status, 200, login.text); h.cookie = login.headers.get('set-cookie').split(';')[0];
    assert.ok(h.cookie.startsWith('taco_sess='));
    assert.ok(!login.headers.get('set-cookie').includes('; Secure'), 'saved network cookie settings are deferred until restart');
    await waitFor(async () => (await h.get('/api/v2/meta')).json.data.primaryAgent?.name === 'Orion');
    const layout = (await h.get('/api/v3/office/layout')).json.data;
    assert.equal(layout.layout.data.agents.find(a => a.agentId === 'primary').character, 'fen');
    assert.equal(layout.layout.data.agents.find(a => a.agentId === 'agent:scribe').name, 'Lyra');
    const bureau = (await h.get('/api/v3/views/office')).json.data;
    assert.equal(bureau.occupants.find(o => o.id === 'agent:scribe').name, 'Lyra');
    assert.equal(bureau.occupants.find(o => o.id === 'agent:scribe').look.character, body.agents.looks.scribe.character);
    assert.ok(bureau.occupants.find(o => o.id === 'agent:scribe').stationUid, 'selected agent already placed');
    const cfgFile = path.join(h.tmp, '.config', 'agent-office', 'config.json');
    const secFile = path.join(path.dirname(cfgFile), 'secrets.json');
    const config = JSON.parse(fs.readFileSync(cfgFile)), secrets = JSON.parse(fs.readFileSync(secFile));
    assert.equal(config.owner.authSource, 'database'); assert.equal(secrets.passwordHash, undefined); assert.equal(config.network.host, '127.0.0.1'); assert.equal(config.network.publicUrl, 'https://bureau.example.invalid'); assert.equal(config.network.cookieSecure, true);
    assert.ok(!JSON.stringify(config).includes(TOKEN)); assert.ok(!h.output.includes(TOKEN) && !h.output.includes(owner.password));
    for (const p of ['resume', 'owner', 'detect', 'integrations/plan', 'integrations/apply', 'network']) assert.equal((await post(p)).status, 403, p);
    const closed = once(h.child, 'exit'); h.child.kill('SIGTERM'); await closed;
    const env = { PATH: process.env.PATH, HOME: h.tmp, AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), PORT: String(h.port), HOST: '127.0.0.1', AO_RUNTIME: 'demo', AO_PROJECTS_DISCOVERY: '0', AO_FAKE_NOW: String(h.sc.now), OC_BIN: path.join(ROOT, 'test/bin/openclaw') };
    restarted = spawn(process.execPath, ['--require', path.join(ROOT, 'test/helpers/freeze-env.js'), path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; restarted.stdout.on('data', b => output += b); restarted.stderr.on('data', b => output += b);
    await waitFor(() => /AO_READY/.test(output), { what: () => 'restart: ' + output });
    assert.ok(!output.includes('One-time setup code'));
    const afterRestart = await h.post('/api/login', { email: owner.email, password: owner.password });
    assert.equal(afterRestart.status, 200); assert.ok(afterRestart.headers.get('set-cookie').includes('; Secure'), 'network cookie setting applies on restart');
    assert.equal((await h.get('/api/me')).status, 200, 'existing taco_sess survives restart');
    const exit = once(restarted, 'exit'); restarted.kill('SIGTERM'); await exit; restarted = null;
    restarted = spawn(process.execPath, ['--require', path.join(ROOT, 'test/helpers/freeze-env.js'), path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...env, PORTAL_EMAIL: 'legacy@example.invalid', PORTAL_PASSWORD: 'legacy-password', PORTAL_SECRET: 's'.repeat(48) }, stdio: ['ignore', 'pipe', 'pipe'] });
    output = ''; restarted.stdout.on('data', b => output += b); restarted.stderr.on('data', b => output += b);
    await waitFor(() => /AO_READY/.test(output));
    assert.equal((await h.post('/api/login', { email: 'legacy@example.invalid', password: 'legacy-password' })).status, 200);
    assert.equal((await h.post('/api/login', { email: owner.email, password: owner.password })).status, 401);
  } finally { if (restarted) { const exit = once(restarted, 'exit'); restarted.kill('SIGTERM'); await exit; } await h.stop(); }
});
