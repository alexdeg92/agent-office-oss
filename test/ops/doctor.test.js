'use strict';
// G11 · `agent-office doctor`, through the real bin (spawned, async: the fake gateway runs in this process). Every run
// carries planted secrets (env, secrets file, a gateway URL with user info, a secret-looking undeclared config key) and
// asserts none of them reaches stdout or stderr, in text and in --json.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../../src/security/password');
const { openDatabase } = require('../../src/store/db');
const { runDoctor, renderText } = require('../../src/ops/doctor');
const { proxyView } = require('../../src/ops/health');
const { loadScenario, makeFakeGateway } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'packaging', 'bin', 'agent-office.js');
const FAKE_OC = path.join(ROOT, 'test', 'bin', 'openclaw');
const M = { secret: 'PLANTED-SESSION-SECRET-0d1e', password: 'PLANTED-PASSWORD-77ab', token: 'PLANTED-GATEWAY-TOKEN-5c2f',
  urlPass: 'PLANTEDURLPASS93', fileToken: 'PLANTED-FILE-TOKEN-a41c', fileSecret: 'PLANTED-FILE-SECRET-6be0', key: 'PLANTEDKEYNAME71' };
const MARKERS = Object.values(M);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const mode = (p) => fs.statSync(p).mode & 0o777;

function doctor(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, 'doctor', ...args], { env: Object.assign({ PATH: process.env.PATH }, env) });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}
// node -- BIN …: Node 24 itself acts on `--env-file <missing path>` anywhere in argv and prints the path before any
// script runs (pinned below); `--` stops that, so this runs the doctor's own handling of every argument shape
function doctorAfterDashDash(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--', BIN, 'doctor', ...args], { env: Object.assign({ PATH: process.env.PATH }, env) });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}
function noSecrets(r, also = []) {
  for (const m of MARKERS.concat(also)) {
    assert.ok(!r.stdout.includes(m), `stdout leaks ${m}`); assert.ok(!r.stderr.includes(m), `stderr leaks ${m}`);
  }
}
const byId = (report, id) => report.checks.filter((c) => c.id === id);
const one = (report, id) => { const c = byId(report, id); assert.equal(c.length, 1, id + ': ' + JSON.stringify(report.checks.map((x) => x.id))); return c[0]; };
// the env a healthy doctor run shares with the server under test
const serverEnv = (h, extra = {}) => Object.assign({
  HOME: h.tmp, AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), PORTAL_EMAIL: 'test@example.invalid', PORTAL_PASSWORD: M.password, PORTAL_SECRET: M.secret,
  OC_GATEWAY_URL: h.gw.url, OC_GATEWAY_TOKEN: M.token, OC_IDENTITY: path.join(h.tmp, 'device.json'), OC_STATE_DB: path.join(h.tmp, 'none.sqlite'), OC_BIN: FAKE_OC,
  FAKE_OC_SCENARIO: h.sc.name, FAKE_OC_FIXTURES: path.join(ROOT, 'test', 'fixtures'),
}, extra);

describe('G11 · doctor against a healthy running instance', () => {
  let h;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { gatewayToken: M.token, env: { OC_GATEWAY_TOKEN: M.token, PORTAL_SECRET: M.secret } });   // the harness logs in with its own password
  });
  after(async () => { if (h) await h.stop(); });

  it('every group is checked; the instance is healthy (exit = worst status; only plaintext-password and loopback notes)', async () => {
    const env = serverEnv(h, { OC_GATEWAY_URL: h.gw.url.replace('ws://', `ws://doctor:${M.urlPass}@`) });
    const r = await doctor(['--json', '--url', h.base], env);
    noSecrets(r);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual([rep.version, rep.instance, rep.locale], [1, 'test', 'fr']);
    for (const g of ['env', 'files', 'data', 'store', 'runtime', 'url', 'host']) assert.ok(rep.checks.some((c) => c.group === g), g);
    const status = (id) => one(rep, id).status;
    assert.equal(status('env.login'), 'ok'); assert.equal(status('env.password'), 'warn', 'plaintext PORTAL_PASSWORD');
    assert.equal(status('env.config'), 'ok'); assert.equal(status('env.token'), 'ok');
    assert.equal(status('files.perms'), 'ok');
    assert.deepEqual([status('data.dir'), status('data.instance'), status('data.server')], ['ok', 'ok', 'info']);
    assert.match(one(rep, 'data.server').key, /running/);
    assert.deepEqual([status('store.integrity'), status('store.schema')], ['ok', 'ok']);
    for (const id of ['runtime.identity', 'runtime.gateway', 'runtime.protocol', 'runtime.scope', 'runtime.clock', 'runtime.cli', 'runtime.agent']) assert.equal(status(id), 'ok', id + ' ' + one(rep, id).message);
    assert.match(one(rep, 'runtime.gateway').message, /ws:\/\/127\.0\.0\.1:\d+/); assert.ok(!one(rep, 'runtime.gateway').message.includes('doctor'), 'no user info');
    assert.match(one(rep, 'runtime.agent').message, /--agent main/);
    // architect-56: the project tag in the primary agent's workspace (the fake CLI lists a workspace with nothing in it)
    assert.deepEqual([one(rep, 'runtime.projectTag').status, one(rep, 'runtime.projectTag').key], ['info', 'runtime.projectTag.absent']);
    assert.deepEqual([status('url.reach'), status('url.tls'), status('url.api'), status('url.proxy')], ['ok', 'info', 'ok', 'info']);
    assert.equal(rep.exitCode, 1); assert.equal(r.status, 1, 'exit 1: one warning (the plaintext password)');
    // nothing was changed: the gateway saw reads only (connect, agents.list); the CLI ran --version and skills list --agent
    assert.ok(h.gw.calls.filter((c) => !['connect', 'agents.list', 'sessions.list', 'cron.list', 'channels.status', 'sessions.subscribe', 'sessions.messages.subscribe', 'sessions.groups.list', 'sessions.get', 'sessions.describe', 'sessions.usage', 'cron.runs'].includes(c.method)).length === 0);
  });
  it('human-readable, French by default and English with --lang en; the same verdict', async () => {
    const fr = await doctor(['--url', h.base], serverEnv(h)), en = await doctor(['--lang', 'en', '--url', h.base], serverEnv(h));
    noSecrets(fr); noSecrets(en);
    assert.match(fr.stdout, /^Agent Office · diagnostic · instance test$/m); assert.match(fr.stdout, /Passerelle joignable/); assert.match(fr.stdout, /Résultat : \d+ ok/);
    assert.match(en.stdout, /^Agent Office · doctor · instance test$/m); assert.match(en.stdout, /Gateway reachable/); assert.match(en.stdout, /Result: \d+ ok/);
    assert.equal(fr.status, en.status);
  });
  it('the proxy probe: forwarded headers from a trusted (loopback) peer are "trusted"; none → "none"', async () => {
    const plain = await fetch(h.base + '/healthz/proxy');
    assert.deepEqual(await plain.json(), { status: 'ok', request: { secure: false, forwarded: 'none' } });
    const fwd = await fetch(h.base + '/healthz/proxy', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } });
    assert.deepEqual(await fwd.json(), { status: 'ok', request: { secure: true, forwarded: 'trusted' } });
    assert.equal(fwd.headers.get('cache-control'), 'no-store');
  });
});

describe('G11 · runtime failures', () => {
  let h;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { gatewayToken: M.token, env: { OC_GATEWAY_TOKEN: M.token, PORTAL_SECRET: M.secret } });   // the harness logs in with its own password
  });
  after(async () => { if (h) await h.stop(); });
  const runtime = async (env, gwSetup) => {
    const restore = {}; if (gwSetup) gwSetup(h.gw, restore);
    try { const r = await doctor(['--json'], serverEnv(h, env)); noSecrets(r); return JSON.parse(r.stdout); } finally { Object.assign(h.gw, restore); }
  };

  it('a wrong token: unauthorized (failure, exit 2), and the token is not printed', async () => {
    const rep = await runtime({ OC_GATEWAY_TOKEN: 'PLANTED-WRONG-TOKEN-9f' });
    assert.equal(one(rep, 'runtime.gateway').status, 'fail'); assert.match(one(rep, 'runtime.gateway').key, /unauthorized/);
    assert.equal(rep.exitCode, 2); assert.ok(!JSON.stringify(rep).includes('PLANTED-WRONG-TOKEN-9f'));
  });
  it('nothing listening: refused', async () => {
    const rep = await runtime({ OC_GATEWAY_URL: 'ws://127.0.0.1:9' });
    assert.match(one(rep, 'runtime.gateway').key, /refused|unreachable/); assert.equal(one(rep, 'runtime.gateway').status, 'fail');
  });
  it('clock skew: 60 s → warning, 200 s → failure (the gateway refuses beyond 120 s)', async () => {
    let rep = await runtime({}, (gw, r) => { r.clockOffsetMs = gw.clockOffsetMs; gw.clockOffsetMs = 60000; });
    assert.equal(one(rep, 'runtime.clock').status, 'warn');
    rep = await runtime({}, (gw, r) => { r.clockOffsetMs = gw.clockOffsetMs; gw.clockOffsetMs = -200000; });
    assert.equal(one(rep, 'runtime.clock').status, 'fail'); assert.match(one(rep, 'runtime.clock').message, /200 s/);
  });
  it('an untested version warns; another protocol fails; a refused read is a scope failure', async () => {
    let rep = await runtime({}, (gw, r) => { r.hello = gw.hello; gw.hello = Object.assign({}, gw.hello, { server: { version: '2030.1.1' } }); });
    assert.equal(one(rep, 'runtime.protocol').status, 'warn'); assert.match(one(rep, 'runtime.protocol').message, /2030\.1\.1/);
    rep = await runtime({}, (gw, r) => { r.hello = gw.hello; gw.hello = Object.assign({}, gw.hello, { protocol: 5 }); });
    assert.equal(one(rep, 'runtime.protocol').status, 'fail');
    rep = await runtime({}, (gw, r) => { r.handlers = gw.handlers; gw.handlers = Object.assign({}, gw.handlers, { 'agents.list': () => ({ __error: { code: 'forbidden', message: 'missing scope: operator.read' } }) }); });
    assert.equal(one(rep, 'runtime.scope').status, 'fail');
  });
  it('the CLI: missing → warning; per-agent commands failing → failure; no primary → skipped', async () => {
    let rep = await runtime({ OC_BIN: path.join(h.tmp, 'no-openclaw') });
    assert.equal(one(rep, 'runtime.cli').status, 'warn'); assert.equal(byId(rep, 'runtime.agent').length, 0);
    rep = await runtime({ FAKE_OC_FAIL: 'skills list' });
    assert.equal(one(rep, 'runtime.agent').status, 'fail');
    rep = await runtime({}, (gw, r) => { r.handlers = gw.handlers; gw.handlers = Object.assign({}, gw.handlers, { 'agents.list': () => ({ agents: [] }) }); });
    assert.equal(one(rep, 'runtime.agent').status, 'skip');
  });
  it('--skip-runtime: no connection at all', async () => {
    const before = h.gw.calls.length;
    const r = await doctor(['--json', '--skip-runtime'], serverEnv(h));
    noSecrets(r);
    assert.equal(one(JSON.parse(r.stdout), 'runtime').status, 'skip'); assert.equal(h.gw.calls.filter((c) => c.method === 'connect').length, h.gw.calls.slice(0, before).filter((c) => c.method === 'connect').length);
  });
});

describe('G11 · configuration, files, data and store (no server)', () => {
  let home, HASH;
  before(async () => { home = tmp('ao-doc-'); HASH = await hashPassword('a-long-password-123'); });
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = (h, extra = {}) => Object.assign({ HOME: h, AO_ENV: 'test', AO_DATA_DIR: path.join(h, 'data'), OC_BIN: path.join(h, 'none') }, extra);

  it('nothing configured: setup mode (info), no token (warning), the data dir to be created; exit 1; nothing created', async () => {
    const h = fs.mkdtempSync(path.join(home, 'fresh-'));
    const r = await doctor(['--json', '--lang', 'en'], base(h));
    noSecrets(r);
    const rep = JSON.parse(r.stdout);
    assert.equal(one(rep, 'env.login').status, 'info'); assert.equal(one(rep, 'env.token').status, 'warn');
    assert.equal(one(rep, 'data.dir').status, 'info'); assert.equal(one(rep, 'data.instance').status, 'info');
    assert.equal(r.status, 1); assert.deepEqual(fs.readdirSync(h), [], 'read-only: nothing created');
  });
  it('an incomplete login, an invalid hash, a bad AO_ENV: failures that name the variable, never its value (exit 2)', async () => {
    const h = fs.mkdtempSync(path.join(home, 'bad-'));
    let r = await doctor(['--json'], base(h, { PORTAL_EMAIL: 'o@example.invalid', OC_GATEWAY_TOKEN: M.token }));
    noSecrets(r); let rep = JSON.parse(r.stdout);
    assert.equal(one(rep, 'env.login').status, 'fail'); assert.match(one(rep, 'env.login').message, /PORTAL_EMAIL/); assert.equal(one(rep, 'env.login').key, 'env.login.partial'); assert.equal(r.status, 2);
    const badHash = 'scrypt$' + M.key;
    r = await doctor(['--json'], base(h, { PORTAL_EMAIL: 'o@example.invalid', PORTAL_SECRET: M.secret, PORTAL_PASSWORD_HASH: badHash, OC_GATEWAY_TOKEN: M.token }));
    noSecrets(r, [badHash]); rep = JSON.parse(r.stdout);
    assert.deepEqual([one(rep, 'env.config').status, one(rep, 'env.config').params.variable], ['fail', 'PORTAL_PASSWORD_HASH']);
    r = await doctor(['--json'], base(h, { AO_ENV: 'qa-' + M.key, PORTAL_EMAIL: 'o@example.invalid', PORTAL_SECRET: M.secret, PORTAL_PASSWORD_HASH: HASH, OC_GATEWAY_TOKEN: M.token }));
    noSecrets(r); assert.equal(one(JSON.parse(r.stdout), 'env.config').params.variable, 'AO_ENV');
    assert.ok(!r.stdout.includes(HASH), 'the hash is never printed');
  });
  it('config + secrets files: valid → ok, values from the file are not printed; open permissions are reported, not changed', async () => {
    const h = fs.mkdtempSync(path.join(home, 'files-'));
    const dir = path.join(h, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, instance: { name: 'Doc', locale: 'en', timeZone: 'UTC' }, owner: { displayName: 'Owner', email: 'owner@example.invalid' },
      runtime: { adapter: 'demo', demo: { seed: 3 } }, agents: { primary: null, looks: {} } }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, sessionSecret: M.fileSecret.repeat(3), passwordHash: HASH, runtimeToken: M.fileToken }), { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'secrets.json'), 0o644);
    const r = await doctor(['--json'], { HOME: h, AO_ENV: 'test', AO_DATA_DIR: path.join(h, 'data') });
    noSecrets(r, [HASH]);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.locale, 'en', 'the instance locale');
    assert.equal(one(rep, 'files.config').status, 'ok'); assert.equal(one(rep, 'env.login').status, 'ok'); assert.match(one(rep, 'env.login').message, /\(file\)/);
    assert.equal(one(rep, 'runtime.demo').status, 'info');
    const perms = byId(rep, 'files.perms'); assert.deepEqual(perms.map((c) => c.status), ['warn', 'warn']);
    assert.deepEqual(perms.map((c) => c.params.want).sort(), ['600', '700']);
    assert.equal(mode(path.join(dir, 'secrets.json')), 0o644, 'not fixed by the doctor'); assert.equal(mode(dir), 0o755);
  });
  it('an invalid config file: the field paths only (an undeclared, secret-looking key name is never printed)', async () => {
    const h = fs.mkdtempSync(path.join(home, 'inv-'));
    const dir = path.join(h, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const c = { version: 1, instance: { name: 'Doc', locale: 'fr', timeZone: 'UTC' }, owner: { displayName: 'O', email: 'o@example.invalid' }, runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: null, looks: {} } };
    c.instance[M.key + '.' + M.password] = 'x';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c), { mode: 0o600 });
    const r = await doctor(['--json'], { HOME: h, AO_ENV: 'test', AO_DATA_DIR: path.join(h, 'data') });
    noSecrets(r);
    const f = one(JSON.parse(r.stdout), 'files.config'); assert.equal(f.status, 'fail'); assert.match(f.message, /\$\.instance: 1 undeclared field/);
    assert.equal(r.status, 2);
  });
  it('the store: another instance\'s → failure; a newer schema → failure; an older one → info; damaged → failure', async () => {
    const h = fs.mkdtempSync(path.join(home, 'store-'));
    const data = path.join(h, 'data');
    openDatabase({ dir: data, instance: 'dev' }).close();
    const env = base(h, { PORTAL_EMAIL: 'o@example.invalid', PORTAL_SECRET: M.secret, PORTAL_PASSWORD_HASH: HASH, AO_RUNTIME: 'demo' });
    let rep = JSON.parse((await doctor(['--json'], env)).stdout);
    assert.equal(one(rep, 'data.instance').status, 'fail'); assert.match(one(rep, 'data.instance').message, /dev/);
    assert.deepEqual([one(rep, 'store.integrity').status, one(rep, 'store.schema').status], ['ok', 'ok']);
    const file = path.join(data, 'agent-office.sqlite');
    let db = new DatabaseSync(file); db.prepare("UPDATE store_meta SET value = 'test' WHERE key = 'instance'").run(); db.prepare('INSERT INTO schema_migrations VALUES (999, ?, 1)').run('future'); db.close();
    rep = JSON.parse((await doctor(['--json'], env)).stdout);
    assert.equal(one(rep, 'data.instance').status, 'ok'); assert.equal(one(rep, 'store.schema').status, 'fail');
    db = new DatabaseSync(file); db.prepare('DELETE FROM schema_migrations WHERE version >= 9').run(); db.close();
    rep = JSON.parse((await doctor(['--json'], env)).stdout);
    assert.equal(one(rep, 'store.schema').status, 'info'); assert.match(one(rep, 'store.schema').key, /older/);
    const before = fs.readFileSync(file);
    const bad = Buffer.from(before); bad.write('garbage!'.repeat(64), 4096); fs.writeFileSync(file, bad);
    for (const f of ['-wal', '-shm']) fs.rmSync(file + f, { force: true });
    rep = JSON.parse((await doctor(['--json'], env)).stdout);
    assert.equal(byId(rep, 'store.integrity')[0].status, 'fail');
    assert.deepEqual(fs.readFileSync(file), bad, 'the doctor wrote nothing');
  });
  it('usage errors exit 64; --help exits 0', async () => {
    assert.equal((await doctor(['--lang', 'de'], base(home))).status, 64);
    assert.equal((await doctor(['--frobnicate'], base(home))).status, 64);
    assert.equal((await doctor(['--url', 'ftp://x'], base(home))).status, 64);
    const help = await doctor(['--help'], base(home)); assert.equal(help.status, 0); assert.match(help.stdout, /usage: agent-office doctor/);
  });
});

describe('G11 · the public URL behind a proxy (stubbed HTTPS responses)', () => {
  const stub = (routes) => async (url) => {
    const p = new URL(url).pathname; const r = routes[p];
    if (!r) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(r.body || {}), { status: r.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, r.headers || {}) });
  };
  const run = (routes, env = {}) => runDoctor({ env: Object.assign({ HOME: os.tmpdir(), AO_ENV: 'test', AO_DATA_DIR: path.join(os.tmpdir(), 'ao-doc-none'), AO_RUNTIME: 'demo' }, env),
    url: 'https://ao.example.invalid/some/path', skipRuntime: true, fetchImpl: stub(routes), locale: 'en' });
  const now = new Date().toUTCString();

  it('HTTPS, HSTS, the API under /backend, a trusted proxy, AO_PUBLIC_URL matching: all ok', async () => {
    const rep = await run({ '/': { headers: { 'strict-transport-security': 'max-age=63072000', date: now } }, '/backend/healthz': { body: { status: 'ok' } },
      '/backend/healthz/proxy': { body: { status: 'ok', request: { secure: true, forwarded: 'trusted' } } } }, { AO_PUBLIC_URL: 'https://ao.example.invalid' });
    for (const id of ['url.reach', 'url.tls', 'url.hsts', 'url.clock', 'url.api', 'url.proxy', 'url.public']) assert.equal(one(rep, id).status, 'ok', id + ': ' + one(rep, id).message);
    assert.match(one(rep, 'url.api').message, /https:\/\/ao\.example\.invalid\/backend/);
  });
  it('the server sees plain HTTP behind HTTPS → warning; ignored forwarded headers → warning; AO_PUBLIC_URL unset or different → warning', async () => {
    let rep = await run({ '/': {}, '/backend/healthz': { body: { status: 'ok' } }, '/backend/healthz/proxy': { body: { status: 'ok', request: { secure: false, forwarded: 'untrusted' } } } });
    assert.match(one(rep, 'url.proxy').key, /insecure/); assert.equal(one(rep, 'url.public').status, 'warn'); assert.match(one(rep, 'url.public').key, /unset/);
    assert.equal(one(rep, 'url.hsts').status, 'info');
    rep = await run({ '/': {}, '/healthz': { body: { status: 'ok' } }, '/healthz/proxy': { body: { status: 'ok', request: { secure: true, forwarded: 'untrusted' } } } }, { AO_PUBLIC_URL: 'https://other.example.invalid' });
    assert.match(one(rep, 'url.proxy').key, /untrusted/); assert.match(one(rep, 'url.public').key, /mismatch/); assert.match(one(rep, 'url.api').message, /invalid\/$/);
  });
  it('a clock 5 minutes off the public server → warning; no API anywhere → failure; an older server → proxy check skipped', async () => {
    let rep = await run({ '/': { headers: { date: new Date(Date.now() - 300000).toUTCString() } }, '/backend/healthz': { body: { status: 'ok' } } });
    assert.equal(one(rep, 'url.clock').status, 'warn'); assert.equal(one(rep, 'url.proxy').status, 'skip');
    rep = await run({ '/': {} });
    assert.equal(one(rep, 'url.api').status, 'fail'); assert.equal(rep.exitCode, 2);
  });
  it('proxyView: forwarded headers from an untrusted peer are "untrusted"', () => {
    const req = (headers, trusted) => ({ headers, secure: false, socket: { remoteAddress: '198.51.100.7' }, app: { get: () => () => trusted } });
    assert.deepEqual(proxyView(req({ 'x-forwarded-for': '203.0.113.1' }, false)), { secure: false, forwarded: 'untrusted' });
    assert.deepEqual(proxyView(req({ forwarded: 'for=203.0.113.1' }, true)), { secure: false, forwarded: 'trusted' });
    assert.deepEqual(proxyView(req({}, true)), { secure: false, forwarded: 'none' });
  });
});

describe('G11 · the output filter is a second guard', () => {
  it('a message that would contain a secret value is redacted (text and json)', async () => {
    const rep = await runDoctor({ env: { HOME: os.tmpdir(), AO_ENV: 'test', AO_DATA_DIR: path.join(os.tmpdir(), M.secret), PORTAL_SECRET: M.secret, AO_RUNTIME: 'demo' }, skipRuntime: true, locale: 'en' });
    const text = renderText(rep);
    assert.ok(!text.includes(M.secret)); assert.match(text, /\[redacted\]/);
    assert.ok(!JSON.stringify(rep.checks).includes(M.secret));
  });
});

describe('R32-03 · usage and env-file errors never echo a value', () => {
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-doc32-')); });
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = () => ({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data'), AO_RUNTIME: 'demo', EXTRA_CREDENTIAL: M.token });

  it('a credential pasted as an unknown argument: exit 64, its position only', async () => {
    for (const args of [[M.token], ['--json', M.token], ['--json', '--' + M.key]]) {
      const r = await doctor(args, env());
      assert.equal(r.status, 64); noSecrets(r);
      assert.match(r.stderr, /unknown (argument|option) #\d/);
    }
    assert.match((await doctor(['--frobnicate'], env())).stderr, /unknown option #1 \(--frobnicate\)/, 'a plain option name is shown');
  });
  it('malformed env-file lines: reported by line number (and key name when it is a valid name), never a value', async () => {
    const f = path.join(home, 'ao.env');
    fs.writeFileSync(f, ['# comment', 'PORTAL_EMAIL=o@example.invalid', M.secret, `BAD KEY=${M.password}`, `export =${M.fileToken}`, `OK_KEY=${M.fileSecret}`, `9BAD=${M.urlPass}`].join('\n'));
    const r = await doctor(['--json', '--lang', 'en', '--env-file', f], env());
    noSecrets(r);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(rep.checks.filter((c) => c.id === 'env.file').map((c) => [c.params.line, c.params.key]), [[3, null], [4, null], [5, null], [7, null]]);
    assert.match(rep.checks.find((c) => c.id === 'env.file').message, /line 3/);
  });
});

describe('R33 · no argument value is ever echoed, whatever its shape (review-33)', () => {
  let home;
  // lowercase letters and dashes: the shape of an option name, the hardest case
  const TOK = 'plantedtoken-qzxv-wkjm';
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-doc33-'));
    const dir = path.join(home, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: 'x', runtimeToken: M.fileToken }), { mode: 0o600 });
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = () => ({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data'), AO_RUNTIME: 'demo', OC_GATEWAY_TOKEN: TOK, PORTAL_SECRET: M.secret });
  const shapes = (v) => [[v], [`--${v}`], [`-${v}`], [`--token=${v}`], ['--token', v], ['--x', v], [`--json=${v}`], [`--lang=${v}`], ['--lang', v],
    ['--url', v], ['--url', `https://${v}.example.invalid`], ['--api-base', v], ['--timeout', v], ['--config', v], ['--data', v], ['--env-file', v], ['--json', '--', v]];

  it('the configured token, a file secret and a session secret, in every argument shape: never in stdout or stderr', async () => {
    for (const v of [TOK, M.fileToken, M.secret]) {
      for (const args of shapes(v)) {
        const r = await doctorAfterDashDash(args, env());
        for (const m of [TOK, M.fileToken, M.secret]) {
          assert.ok(!r.stdout.includes(m) && !r.stderr.includes(m), `${JSON.stringify(args)} leaks ${m} (exit ${r.status}): ${(r.stderr + r.stdout).slice(0, 200)}`);
        }
      }
    }
  });
  it('Node itself (not our code) prints a missing --env-file path given after the script, unless started with `--` (pinned: the bin\'s shebang should pass `--`)', async () => {
    const missing = path.join(home, 'no-such-env-file');
    const plain = await doctor(['--env-file', missing], env());
    assert.equal(plain.status, 9, 'node exits before the script runs'); assert.match(plain.stderr, /^(\S*\/)?node: .*: not found/);
    const dashed = await doctorAfterDashDash(['--env-file', missing], env());
    assert.equal(dashed.status, 64); assert.ok(!dashed.stderr.includes(missing), 'our own error names no path');
  });
  it('an unknown option is named (before any "="), a positional argument by position only', async () => {
    let r = await doctor(['--frobnicate=1'], env());
    assert.equal(r.status, 64); assert.match(r.stderr, /unknown option #1 \(--frobnicate\)/);
    r = await doctor(['--json', 'stray'], env());
    assert.equal(r.status, 64); assert.match(r.stderr, /unknown argument #2/); assert.doesNotMatch(r.stderr, /stray/);
  });
});
