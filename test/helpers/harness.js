'use strict';
/*
 * Boots the real server.js as a child process against a FakeGateway + fake CLI, with a frozen clock,
 * a throwaway HOME and test-only credentials. Nothing here can reach the live gateway, the real
 * openclaw binary, ~/.openclaw or systemd:
 *   - OC_GATEWAY_URL → the FakeGateway on 127.0.0.1:<random>
 *   - OC_BIN         → test/bin/openclaw
 *   - OC_IDENTITY    → a freshly generated ed25519 identity in a temp dir
 *   - OC_CONFIG      → the scenario's synthetic config (or an empty one)
 *   - HOME           → the temp dir; PATH starts with test/bin (fake df, fake systemctl)
 *   - the environment is built from scratch (no inherited PORTAL_* or OC_* values)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { FIXTURES_DIR, makeFakeGateway } = require('./scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.resolve(__dirname, '..', 'bin');
const TEST_EMAIL = 'test@example.invalid';
const TEST_PASSWORD = 'test-password';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function makeIdentity(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = { deviceId: 'test-device-' + crypto.randomBytes(4).toString('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const f = path.join(dir, 'device.json'); fs.writeFileSync(f, JSON.stringify(id)); return f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 10000, intervalMs = 50, what = 'condition' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}` + (last instanceof Error ? ': ' + last.message : ''));
}

/**
 * @param {object} sc scenario manifest
 * @param {object} [opts] { env: extra env, handlers: extra FakeGateway handlers, readonly: bool, failCli: 'cron run,…' }
 */
async function startServer(sc, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-test-'));
  const fake = makeFakeGateway(sc, opts.handlers);
  if (opts.gatewayToken) fake.token = opts.gatewayToken;   // G4: the fake refuses any other runtime token
  if (opts.hello) fake.hello = Object.assign({}, fake.hello, opts.hello);   // S6.2: e.g. advertised events
  const gw = await fake.start();
  const port = await freePort();
  const cliLog = path.join(tmp, 'cli.jsonl'); fs.writeFileSync(cliLog, '');
  const config = sc.config ? path.join(sc.fixturesDir || FIXTURES_DIR, sc.config) : path.join(tmp, 'openclaw.json');
  if (!sc.config) fs.writeFileSync(config, '{}');
  const env = {
    // test/bin first so df and systemctl are the fakes. Node's directory next: the fake
    // openclaw is a `#!/usr/bin/env node` script, and GitHub's setup-node does not install
    // node into /usr/bin. Without this, skills list never starts and every server test times out.
    PATH: testServerPath(),
    HOME: tmp, TZ: 'America/Toronto', LANG: 'C.UTF-8',
    PORT: String(port), HOST: '127.0.0.1',
    OC_GATEWAY_URL: gw.url, OC_GATEWAY_TOKEN: 'test-gateway-token', OC_IDENTITY: makeIdentity(tmp), OC_STATE_DB: path.join(tmp, 'none.sqlite'),
    OC_CONFIG: config, OC_BIN: path.join(BIN, 'openclaw'),
    PORTAL_EMAIL: TEST_EMAIL, PORTAL_PASSWORD: TEST_PASSWORD, PORTAL_SECRET: crypto.randomBytes(16).toString('hex'),
    AO_ENV: 'test', AO_DATA_DIR: path.join(tmp, 'data'), AO_PROJECTS_DISCOVERY: '0',
    AO_PROJECTS_OWNERS: 'alexdeg92',
    AO_FAKE_NOW: String(sc.now), FAKE_OC_SCENARIO: sc.name, FAKE_OC_FIXTURES: sc.fixturesDir || FIXTURES_DIR, FAKE_OC_LOG: cliLog,
    NODE_OPTIONS: '',
  };
  if (opts.readonly) env.PORTAL_READONLY = '1';
  // G4: a fresh install: no login env and no runtime token (setup supplies them; HOME is a temp dir, so no config file)
  if (opts.setupMode || opts.loginEnv === false) for (const k of ['PORTAL_EMAIL', 'PORTAL_PASSWORD', 'PORTAL_SECRET', 'OC_GATEWAY_TOKEN']) delete env[k];
  if (opts.failCli) env.FAKE_OC_FAIL = opts.failCli;
  Object.assign(env, opts.env || {});
  if (opts.prepare) await opts.prepare(tmp, { env, gateway: gw });   // G4: e.g. a stored instance config under tmp/.config/agent-office

  // AO_SERVER_ENTRY (test-only): run another server file, e.g. the pre-S1 baseline when creating goldens.
  const entry = process.env.AO_SERVER_ENTRY ? path.resolve(ROOT, process.env.AO_SERVER_ENTRY) : path.join(ROOT, 'server.js');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'freeze-env.js'), entry], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (method, p, body) => {
    // like the UI's api.js: JSON bodies and the X-AO-Request marker (R15-01 CSRF guard)
    const r = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-ao-request': '1' }, cookie ? { cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const h = {
    sc, gw, port, base, tmp, child,
    secret: env.PORTAL_SECRET,   // test-only: lets auth tests forge expired/tampered cookies
    get output() { return output.split(ROOT).join('{{ROOT}}'); },
    get cookie() { return cookie; },          // S6: the raw `taco_sess=…` pair (SSE clients, revocation tests)
    set cookie(v) { cookie = v; },
    request,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b === undefined ? {} : b),
    patch: (p, b) => request('PATCH', p, b),
    cliCalls: () => fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv),
    async login() {
      const r = await request('POST', '/api/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
      if (r.status !== 200) throw new Error('login failed: ' + r.status);
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r;
    },
    async stop() {
      if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, sleep(2000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
      await gw.stop();
      // a CLI process the server started may still append to its log for a moment: retry (ENOTEMPTY seen once)
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };

  // G4: the configured app's readiness (also after setup hands over in-process)
  h.waitReady = async ({ login = true } = {}) => {
    await waitFor(() => /^AO_READY \{"mode":"app"/m.test(output), { timeoutMs: 30000, what: 'the AO_READY app line' });
    await waitFor(async () => (await fetch(base + '/api/me')).status === 401, { timeoutMs: 30000, what: 'the app answering' });   // 30 s like AO_READY (10 s flaked under full-suite load)
    if (login) await h.login();
  };
  // A test that writes into the RUNNING server's store (e.g. an agent token) opens it like the server does: with a busy
  // timeout. Without one, a write that meets the server's own write fails at once with SQLITE_BUSY ("database is
  // locked"): flaky under load (foreign-instance token test, PM after 593f970).
  h.withStore = (fn) => withStoreDb(path.join(tmp, 'data', 'agent-office.sqlite'), fn);
  h.setupCode = () => { const m = /One-time setup code: (AO-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output); return m ? m[1] : null; };
  if (opts.setupMode) {
    try {
      // structured readiness (PM after R22-03): the server's fixed AO_READY line, then the API answering; a timeout says
      // what was last seen, never a prose match
      let last = 'no response';
      await waitFor(() => /^AO_READY \{"mode":"setup"/m.test(output), { timeoutMs: 30000, what: 'the AO_READY setup line' });
      await waitFor(async () => { try { const r = await fetch(base + '/api/v2/meta'); last = 'HTTP ' + r.status; return r.status === 200; } catch (e) { last = e.code || e.message; return false; } },
        { timeoutMs: 10000, what: () => 'setup-mode meta (last: ' + last + ')' });
    } catch (e) { await h.stop(); e.message += '\n--- server output ---\n' + output.split(ROOT).join('{{ROOT}}'); throw e; }
    return h;
  }
  try {
    // Boot can exceed 10 s while the whole suite runs in parallel (browser tests included): seen once in 10 runs.
    await waitFor(() => /^AO_READY \{"mode":"app"/m.test(output), { timeoutMs: 30000, what: 'the AO_READY app line' });
    await waitFor(async () => (await fetch(base + '/api/me')).status === 401, { timeoutMs: 30000, what: 'the app answering' });   // 30 s like AO_READY (10 s flaked under full-suite load)
    await h.login();
    // the first full refresh is done: its four reads are fresh in the engine (S16 prep: an engine fact, so it holds with
    // or without v1; v1's summary.updatedAt is set by the same refresh)
    const FIRST = ['gw.rpc.agents.list', 'gw.rpc.cron.list', 'gw.rpc.sessions.list', 'gw.rpc.channels.status'];
    // G6: a demo runtime has no gateway reads; it is ready once its team is in the engine
    if (opts.demo || (opts.env && opts.env.AO_RUNTIME === 'demo')) await waitFor(async () => ((await h.get('/api/v2/views/logs')).json.data.items.length > 0), { what: 'the demo team' });
    else await waitFor(async () => {
      const r = await h.get('/api/v2/views/health');
      const gwSrc = r.json && r.json.data && r.json.data.sources.find((x) => x.id === 'gateway');
      return !!gwSrc && FIRST.every((c) => gwSrc.channels.some((x) => x.channel === c && (x.state === 'fresh' || x.lastErrorAt != null)));   // read, or failed
    }, { what: 'first gateway refresh' });
    // skills loaded from the fake CLI (or the list is known to be empty / failing); a demo runtime has no CLI
    if (!(opts.demo || (opts.env && opts.env.AO_RUNTIME === 'demo'))) await waitFor(async () => h.cliCalls().some((a) => a[0] === 'skills' && a[1] === 'list'), { what: 'skills list call' });
    await sleep(150);
  } catch (e) {
    await h.stop();
    e.message += '\n--- server output ---\n' + output.split(ROOT).join('{{ROOT}}');
    throw e;
  }
  return h;
}

const STORE_BUSY_MS = 10000;
function withStoreDb(file, fn) {
  require('../../src/store/db').assertTestSafeDir(path.dirname(file), 'test');   // never a real store
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { timeout: STORE_BUSY_MS });
  try { db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_MS}`); return fn(db); } finally { db.close(); }
}

function testServerPath() {
  return [BIN, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
}

module.exports = { startServer, waitFor, sleep, testServerPath, makeIdentity, withStoreDb, TEST_EMAIL, TEST_PASSWORD };
