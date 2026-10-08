'use strict';
/*
 * Packaged first run (projects-39). Not part of `npm test` (that glob is test/**).
 * CI runs it after `docker build -t agent-office:ci`.
 *
 * Two entry points, each with a clean environment (no inherited PORTAL_* or OC_GATEWAY_TOKEN):
 *   - the image's default `start` (UI at /, API at /backend), --network host so the
 *     in-process fake gateway on 127.0.0.1 is the container's 127.0.0.1
 *   - `npm install -g` of the staged tarball, then `agent-office start`
 * Against a fake OpenClaw gateway and test/bin/openclaw. The one-time code is read from
 * the process log. Then check, discover, and PUT (owner password). configured, login,
 * setup writes 403 locked, a restart stays configured, secrets.json is 0600 in a 0700
 * directory. A second boot with login env set starts locked and writes nothing.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { loadScenario, makeFakeGateway, FIXTURES_DIR } = require('../test/helpers/scenario');
const { waitFor, makeIdentity } = require('../test/helpers/harness');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
const { stagePackage } = require('./release-tools');

const ROOT = path.resolve(__dirname, '..');
const IMAGE = process.env.IMAGE || 'agent-office:ci';
const TOKEN = 'runtime-token-only-the-gateway-knows';
const OWNER_EMAIL = 'owner@example.invalid';
const OWNER_PASSWORD = 'owner-password-1';
const PRESET_EMAIL = 'preset@example.invalid';
const PRESET_PASSWORD = 'preset-password-1';
const PRESET_SECRET = 'preset-session-secret-value-0123456789';
const CODE_RE = /One-time setup code: (AO-[A-Z2-9]{4}-[A-Z2-9]{4})/g;

const sc = loadScenario('foreign-instance');
const leftovers = { containers: new Set(), children: new Set(), dirs: new Set() };

function redact(text) {
  return String(text)
    .replace(/AO-[A-Z2-9]{4}-[A-Z2-9]{4}/g, 'AO-REDACTED')
    .split(TOKEN).join('[token]')
    .split(OWNER_PASSWORD).join('[password]')
    .split(PRESET_PASSWORD).join('[password]')
    .split(PRESET_SECRET).join('[secret]');
}

function codesIn(text) {
  return [...String(text).matchAll(CODE_RE)].map((m) => m[1]);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...opts });
}

async function call(base, method, p, body, cookie) {
  const headers = { accept: 'application/json', 'x-ao-request': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const raw = set.find((c) => c.startsWith('taco_sess='));
  const cookieOut = raw ? raw.split(';')[0] : null;
  return { status: res.status, json, cookie: cookieOut };
}

async function waitMeta(base, configured) {
  return waitFor(async () => {
    try {
      const r = await call(base, 'GET', '/api/v2/meta');
      if (r.status === 200 && r.json && r.json.data && r.json.data.instance && r.json.data.instance.configured === configured) return r;
    } catch { /* not listening yet */ }
    return null;
  }, { timeoutMs: 30000, what: `meta configured=${configured}` });
}

function saveBody(code, gatewayUrl) {
  return {
    setupCode: code,
    instance: { name: 'Bureau de Camille', locale: 'en', timeZone: 'Europe/Paris' },
    owner: { displayName: 'Camille', email: OWNER_EMAIL, password: OWNER_PASSWORD },
    runtime: { adapter: 'openclaw', gatewayUrl },
    agents: { primary: 'atlas', looks: { atlas: { character: 'timmy', variant: null, accessories: ['headphones'] } } },
  };
}

async function assertLocked(base) {
  for (const [method, p] of [['POST', '/api/v2/setup/check'], ['POST', '/api/v2/setup/discover'], ['PUT', '/api/v2/setup']]) {
    const r = await call(base, method, p, saveBody('AO-AAAA-AAAA', 'ws://127.0.0.1:9'));
    assert.equal(r.status, 403, p);
    assert.deepEqual(r.json.error.details, [{ issue: 'locked' }], p);
  }
}

async function assertLogin(base, email, password) {
  const login = await call(base, 'POST', '/api/login', { email, password });
  assert.equal(login.status, 200);
  assert.equal(login.json.email, email);
  assert.ok(login.cookie && login.cookie.startsWith('taco_sess='));
  const me = await call(base, 'GET', '/api/me', undefined, login.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.json.email, email);
}

function assertNoSecrets(text) {
  assert.equal(text.includes(TOKEN), false, 'gateway token in the log');
  assert.equal(text.includes(OWNER_PASSWORD), false, 'owner password in the log');
  assert.equal(text.includes(PRESET_PASSWORD), false, 'preset password in the log');
  assert.equal(text.includes(PRESET_SECRET), false, 'session secret in the log');
}

async function freshSetup(base, gatewayUrl, readLogs) {
  const found = await waitFor(async () => {
    const foundCodes = codesIn(readLogs());
    return foundCodes.length ? foundCodes[0] : null;
  }, { timeoutMs: 30000, what: 'one-time setup code in the log' }).catch((err) => {
    err.message += '\n--- log ---\n' + redact(readLogs()).slice(-2000);
    throw err;
  });
  assert.match(found, /^AO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await waitMeta(base, false);

  const check = await call(base, 'POST', '/api/v2/setup/check', {
    setupCode: found, runtime: { adapter: 'openclaw', gatewayUrl, token: TOKEN },
  });
  assert.equal(check.status, 200, redact(JSON.stringify(check.json)));
  assert.equal(check.json.data.result.ok, true);
  assert.equal(check.json.data.result.status, 'connected');

  const discover = await call(base, 'POST', '/api/v2/setup/discover', {
    setupCode: found, runtime: { adapter: 'openclaw', gatewayUrl },
  });
  assert.equal(discover.status, 200, redact(JSON.stringify(discover.json)));
  assert.ok(discover.json.data.result.agents.some((a) => a.id === 'atlas' && a.isPrimary === true));

  const put = await call(base, 'PUT', '/api/v2/setup', saveBody(found, gatewayUrl));
  assert.equal(put.status, 200, redact(JSON.stringify(put.json)));
  assert.equal(put.json.data.result.configured, true);
  await waitMeta(base, true);
  await assertLogin(base, OWNER_EMAIL, OWNER_PASSWORD);
  await assertLocked(base);
  return found;
}

describe('packaged first run', () => {
  let gw;
  let identity;
  let work;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-first-run-'));
    leftovers.dirs.add(work);
    identity = makeIdentity(work);
    fs.chmodSync(identity, 0o644);
    gw = makeFakeGateway(sc);
    gw.token = TOKEN;
    await gw.start();
  });

  after(async () => {
    for (const name of leftovers.containers) run('docker', ['rm', '-f', name]);
    for (const child of leftovers.children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (gw) await gw.stop();
    for (const dir of leftovers.dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('docker image: first run, restart, then env creds start locked', async () => {
    const inspected = run('docker', ['image', 'inspect', IMAGE]);
    assert.equal(inspected.status, 0, `docker image ${IMAGE} is missing; build it before this test`);
    const openclaw = path.join(work, 'openclaw');
    fs.copyFileSync(path.join(ROOT, 'test', 'bin', 'openclaw'), openclaw);
    fs.chmodSync(openclaw, 0o755);

    const start = async (creds) => {
      const port = await freePort();
      const name = `ao-fr-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      leftovers.containers.add(name);
      const args = [
        'run', '-d', '--name', name, '--network', 'host',
        '-v', `${identity}:/opt/ao-test/device.json:ro`,
        '-v', `${openclaw}:/opt/ao-test/openclaw:ro`,
        '-v', `${FIXTURES_DIR}:/opt/ao-test/fixtures:ro`,
        '-e', 'AO_ENV=dev',
        '-e', 'HOST=127.0.0.1',
        '-e', `PORT=${port}`,
        '-e', 'OC_IDENTITY=/opt/ao-test/device.json',
        '-e', 'OC_BIN=/opt/ao-test/openclaw',
        '-e', 'OC_STATE_DB=/tmp/ao-missing.sqlite',
        '-e', 'FAKE_OC_SCENARIO=foreign-instance',
        '-e', 'FAKE_OC_FIXTURES=/opt/ao-test/fixtures',
        '-e', 'HOME=/home/ao',
        '-e', 'OC_HOME=/home/ao',
      ];
      if (creds) {
        args.push(
          '-e', `PORTAL_EMAIL=${PRESET_EMAIL}`,
          '-e', `PORTAL_PASSWORD=${PRESET_PASSWORD}`,
          '-e', `PORTAL_SECRET=${PRESET_SECRET}`,
          '-e', `OC_GATEWAY_TOKEN=${TOKEN}`,
          '-e', `OC_GATEWAY_URL=${gw.url}`,
        );
      }
      args.push(IMAGE, 'start');
      const started = run('docker', args);
      if (started.status !== 0) throw new Error(redact(`${args.join(' ')}\n${started.stderr}`));
      return { name, base: `http://127.0.0.1:${port}/backend` };
    };
    const logsOf = (proc) => {
      const out = run('docker', ['logs', proc.name]);
      return `${out.stdout || ''}${out.stderr || ''}`;
    };
    const stop = async (proc) => {
      run('docker', ['rm', '-f', proc.name]);
      leftovers.containers.delete(proc.name);
    };

    const proc = await start(false);
    try {
      await freshSetup(proc.base, gw.url, () => logsOf(proc));
      const modes = run('docker', ['exec', proc.name, 'stat', '-c', '%a %n', '/config/secrets.json', '/config']);
      assert.equal(modes.status, 0, redact(modes.stderr));
      const lines = modes.stdout.trim().split('\n');
      assert.deepEqual(lines, ['600 /config/secrets.json', '700 /config']);
      assertNoSecrets(logsOf(proc));
      assert.equal(codesIn(logsOf(proc)).length, 1);

      const restarted = run('docker', ['restart', proc.name]);
      assert.equal(restarted.status, 0, redact(restarted.stderr));
      await waitMeta(proc.base, true);
      await assertLogin(proc.base, OWNER_EMAIL, OWNER_PASSWORD);
      await assertLocked(proc.base);
      assert.equal(codesIn(logsOf(proc)).length, 1, 'a restart must not open setup again');
      assertNoSecrets(logsOf(proc));
    } finally {
      await stop(proc);
    }

    const preset = await start(true);
    try {
      await waitMeta(preset.base, true);
      assert.equal(codesIn(logsOf(preset)).length, 0, 'env creds must not print a setup code');
      await assertLocked(preset.base);
      await assertLogin(preset.base, PRESET_EMAIL, PRESET_PASSWORD);
      const absent = run('docker', ['exec', preset.name, 'sh', '-c', 'test ! -e /config/secrets.json && test ! -e /config/config.json']);
      assert.equal(absent.status, 0, 'env creds must not write config files');
      assertNoSecrets(logsOf(preset));
    } finally {
      await stop(preset);
    }
  });

  it('npm-installed CLI: first run, restart, then env creds start locked', async () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stage-'));
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prefix-'));
    leftovers.dirs.add(stage);
    leftovers.dirs.add(prefix);
    stagePackage(ROOT, stage);
    const packed = run('npm', ['pack', '--pack-destination', stage], { cwd: stage });
    assert.equal(packed.status, 0, redact(packed.stderr));
    const tarball = path.join(stage, `alexdeg92-agent-office-${require(path.join(ROOT, 'package.json')).version}.tgz`);
    assert.equal(fs.existsSync(tarball), true, 'npm pack did not write the tarball');
    const installed = run('npm', ['install', '-g', '--prefix', prefix, tarball]);
    assert.equal(installed.status, 0, redact(installed.stderr));
    const bin = path.join(prefix, 'bin', 'agent-office');
    assert.equal(fs.existsSync(bin), true);

    const homeFor = () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-home-'));
      leftovers.dirs.add(home);
      return home;
    };
    const start = async (creds, reuse) => {
      const home = reuse ? reuse.home : homeFor();
      const port = await freePort();
      const data = path.join(home, 'data');
      const config = path.join(home, 'instance', 'config.json');
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        LANG: 'C.UTF-8',
        TMPDIR: home,
        AO_ENV: 'dev',
        OC_IDENTITY: identity,
        OC_BIN: path.join(ROOT, 'test', 'bin', 'openclaw'),
        OC_STATE_DB: path.join(home, 'missing.sqlite'),
        OC_HOME: home,
        FAKE_OC_SCENARIO: 'foreign-instance',
        FAKE_OC_FIXTURES: FIXTURES_DIR,
      };
      if (creds) {
        env.PORTAL_EMAIL = PRESET_EMAIL;
        env.PORTAL_PASSWORD = PRESET_PASSWORD;
        env.PORTAL_SECRET = PRESET_SECRET;
        env.OC_GATEWAY_TOKEN = TOKEN;
        env.OC_GATEWAY_URL = gw.url;
      }
      const child = spawn(bin, ['start', '--host', '127.0.0.1', '--port', String(port), '--config', config, '--data', data], {
        env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      leftovers.children.add(child);
      let text = '';
      child.stdout.on('data', (buf) => { text += buf; });
      child.stderr.on('data', (buf) => { text += buf; });
      child.on('exit', () => leftovers.children.delete(child));
      return {
        child,
        home,
        config,
        base: `http://127.0.0.1:${port}/backend`,
        logs: () => text,
      };
    };
    const stop = (proc) => new Promise((resolve) => {
      if (!proc.child || proc.child.exitCode != null || proc.child.signalCode != null) {
        leftovers.children.delete(proc.child);
        return resolve();
      }
      const timer = setTimeout(() => {
        try { process.kill(-proc.child.pid, 'SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 8000);
      proc.child.once('exit', () => { clearTimeout(timer); leftovers.children.delete(proc.child); resolve(); });
      try { process.kill(-proc.child.pid, 'SIGTERM'); } catch { proc.child.kill('SIGTERM'); }
    });

    const proc = await start(false);
    try {
      await freshSetup(proc.base, gw.url, proc.logs);
      const secrets = path.join(path.dirname(proc.config), 'secrets.json');
      assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(secrets)).mode & 0o777, 0o700);
      assertNoSecrets(proc.logs());
      assert.equal(codesIn(proc.logs()).length, 1);
      await stop(proc);

      const restarted = await start(false, proc);
      try {
        await waitMeta(restarted.base, true);
        await assertLogin(restarted.base, OWNER_EMAIL, OWNER_PASSWORD);
        await assertLocked(restarted.base);
        assert.equal(codesIn(restarted.logs()).length, 0, 'a restart must not open setup again');
        assertNoSecrets(restarted.logs());
      } finally {
        await stop(restarted);
      }
    } finally {
      if (proc.child && proc.child.exitCode == null) await stop(proc);
    }

    const preset = await start(true);
    try {
      await waitMeta(preset.base, true);
      assert.equal(codesIn(preset.logs()).length, 0, 'env creds must not print a setup code');
      await assertLocked(preset.base);
      await assertLogin(preset.base, PRESET_EMAIL, PRESET_PASSWORD);
      assert.equal(fs.existsSync(path.join(path.dirname(preset.config), 'secrets.json')), false);
      assert.equal(fs.existsSync(preset.config), false);
      assertNoSecrets(preset.logs());
    } finally {
      await stop(preset);
    }
  });
});
