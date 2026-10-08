'use strict';
// review-21 (G4 NO-GO) R21-01…05: each written to fail before its fix.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IC = require('../../src/instance-config');
const { hashPassword } = require('../../src/security/password');
const { loadScenario } = require('../helpers/scenario');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const mode = (p) => fs.statSync(p).mode & 0o777;
const CONFIG = { version: 1, instance: { name: 'Bureau', locale: 'en', timeZone: 'Europe/Paris' }, owner: { displayName: 'Camille', email: 'camille@example.invalid' },
  runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:9' } }, agents: { primary: 'atlas', looks: {} } };
let SECRETS;
before(async () => { SECRETS = { version: 1, sessionSecret: 's'.repeat(48), passwordHash: await hashPassword('a-long-password-123'), runtimeToken: 'tok' }; });

describe('R21-01 · loose permissions are fixed with a warning (owned) or refused (not owned); never silently accepted', () => {
  it('owned: a 0644 secrets.json in a 0755 directory and a 0755 data dir are fixed to 0600/0700, with a warning', () => {
    const d = tmpDir('ao-r21-perm-'), dir = path.join(d, 'cfg'), data = path.join(d, 'data');
    fs.mkdirSync(dir, { mode: 0o755 }); fs.mkdirSync(data, { mode: 0o755 }); fs.chmodSync(dir, 0o755); fs.chmodSync(data, 0o755);
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(SECRETS)); fs.chmodSync(path.join(dir, 'secrets.json'), 0o644);
    const warnings = [];
    try {
      IC.securePermissions({ paths: { file: path.join(dir, 'config.json'), secrets: path.join(dir, 'secrets.json') }, dataDir: data, warn: (m) => warnings.push(m) });
      assert.deepEqual([mode(path.join(dir, 'secrets.json')), mode(dir), mode(data)], [0o600, 0o700, 0o700]);
      assert.equal(warnings.length, 3, warnings.join('\n'));
      assert.ok(warnings.every((w) => /permissions/.test(w) && !w.includes('tok')));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('not owned (another uid): refuses, naming the path and the fix', () => {
    const d = tmpDir('ao-r21-own-');
    try {
      fs.writeFileSync(path.join(d, 'secrets.json'), '{}'); fs.chmodSync(path.join(d, 'secrets.json'), 0o644);
      const uid = (process.getuid ? process.getuid() : 1000) + 1;   // pretend the file is someone else's
      assert.throws(() => IC.securePermissions({ paths: { file: path.join(d, 'config.json'), secrets: path.join(d, 'secrets.json') }, dataDir: null, uid }),
        (e) => e.code === 'EPERMS' && /secrets\.json/.test(e.message) && /chmod 600/.test(e.message));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('the real server fixes them at startup and says so (config dir, secret file, data dir)', async () => {
    let h;
    try {
      h = await startServer(loadScenario('synthetic-basic'), { prepare: (tmp) => {
        const dir = path.join(tmp, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o755);
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG)); fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(SECRETS));
        fs.chmodSync(path.join(dir, 'secrets.json'), 0o644);
        fs.mkdirSync(path.join(tmp, 'data'), { mode: 0o755 }); fs.chmodSync(path.join(tmp, 'data'), 0o755);
      } });
      const dir = path.join(h.tmp, '.config', 'agent-office');
      assert.deepEqual([mode(path.join(dir, 'secrets.json')), mode(dir), mode(path.join(h.tmp, 'data'))], [0o600, 0o700, 0o700]);
      assert.match(h.output, /permissions/);
    } finally { if (h) await h.stop(); }
  });
});

describe('R21-02 · a startup diagnostic never prints an undeclared field name', () => {
  it('a count under the parent path only (R22-02: no key text and no types)', () => {
    const d = tmpDir('ao-r21-key-');
    try {
      const file = path.join(d, 'config.json');
      fs.writeFileSync(file, JSON.stringify(Object.assign({}, CONFIG, { instance: Object.assign({}, CONFIG.instance, { 'SECRET-MARKER-hunter2': 'x', other: 3 }) })));
      assert.throws(() => IC.readInstanceConfig({ AO_CONFIG: file, HOME: d }), (e) => {
        assert.ok(!e.message.includes('SECRET-MARKER') && !e.message.includes('hunter2') && !e.message.includes('other'), e.message);
        assert.match(e.message, /\$\.instance: 2 undeclared fields(;|$)/);
        return true;
      });
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('R21-03 · publication is recoverable and exclusive', () => {
  const pathsIn = (d) => ({ file: path.join(d, 'config.json'), secrets: path.join(d, 'secrets.json') });
  it('a crash after secrets.json, before the commit (config.json): setup stays open, and the next publication completes', () => {
    const d = tmpDir('ao-r21-crash-'), paths = pathsIn(d);
    const link = fs.linkSync;
    try {
      fs.linkSync = (a, b) => { if (b === paths.file) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return link(a, b); };
      assert.throws(() => IC.writeInstanceConfig(paths, CONFIG, SECRETS), /EIO/);
      fs.linkSync = link;
      assert.ok(fs.existsSync(paths.secrets) && !fs.existsSync(paths.file), 'the half-published state of the review');
      const files = IC.readInstanceConfig({ AO_CONFIG: paths.file, HOME: d });
      assert.equal(files.secrets, null, 'secrets without their commit are not read');
      assert.equal(IC.setupState({}, files), 'open', 'not stranded: setup can finish');
      IC.writeInstanceConfig(paths, CONFIG, Object.assign({}, SECRETS, { runtimeToken: 'second' }));
      assert.equal(JSON.parse(fs.readFileSync(paths.secrets, 'utf8')).runtimeToken, 'second');
      assert.equal(IC.setupState({}, IC.readInstanceConfig({ AO_CONFIG: paths.file, HOME: d })), 'locked');
      assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('.') && f !== '.publish-lock.sqlite'), [], 'no temporary file left (the lock database stays: R22-01)');
    } finally { fs.linkSync = link; fs.rmSync(d, { recursive: true, force: true }); }
  });
  // the live / dead publisher cases are cross-process now (R22-01: an OS lock): test/api/review22.test.js
  it('a committed configuration is never overwritten', () => {
    const d = tmpDir('ao-r21-excl-'), paths = pathsIn(d);
    try {
      IC.writeInstanceConfig(paths, CONFIG, SECRETS);
      const before = fs.readFileSync(paths.secrets, 'utf8');
      assert.throws(() => IC.writeInstanceConfig(paths, CONFIG, Object.assign({}, SECRETS, { runtimeToken: 'thief' })), (e) => e.code === 'EEXIST');
      assert.equal(fs.readFileSync(paths.secrets, 'utf8'), before, 'the winner\'s secrets are untouched');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

const save = (h, code, ip, extra = {}) => fetch(h.base + '/api/v2/setup', { method: 'PUT', headers: Object.assign({ 'content-type': 'application/json' }, ip ? { 'x-forwarded-for': ip } : {}),
  body: JSON.stringify(Object.assign({ setupCode: code, instance: { name: 'Bureau', locale: 'en', timeZone: 'Europe/Paris' },
    owner: { displayName: 'Camille', email: TEST_EMAIL, password: TEST_PASSWORD }, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url, token: 'tok' }, agents: { primary: 'atlas' } }, extra)) });

describe('R21-04 · the losing concurrent PUT gets its 403 before the handoff closes connections', () => {
  for (let i = 1; i <= 2; i++) {
    it(`two simultaneous valid saves → one 200 and one 403 {issue:'locked'} (run ${i})`, async () => {
      const h = await startServer(loadScenario('foreign-instance'), { setupMode: true });
      try {
        const code = h.setupCode();
        const out = await Promise.allSettled([save(h, code), save(h, code)]);
        const statuses = await Promise.all(out.map(async (r) => (r.status === 'fulfilled' ? [r.value.status, (await r.value.json()).error] : ['closed', r.reason && r.reason.message])));
        assert.deepEqual(statuses.map((x) => x[0]).sort(), [200, 403], JSON.stringify(statuses));
        assert.deepEqual(statuses.find((x) => x[0] === 403)[1].details, [{ issue: 'locked' }]);
      } finally { await h.stop(); }
    });
  }
});

describe('R21-05 · setup and login share one throttle; the setup 429 says Retry-After', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('foreign-instance'), { setupMode: true }); });
  after(async () => { if (h) await h.stop(); });
  it('six wrong codes lock the client (429 + Retry-After); after setup completes, that client\'s login is still locked', async () => {
    const X = '203.0.113.120';
    for (let i = 0; i < 6; i++) await save(h, 'AO-AAAA-AAAA', X);
    const locked = await save(h, h.setupCode(), X);
    assert.equal(locked.status, 429);
    assert.match(String(locked.headers.get('retry-after')), /^\d+$/);
    assert.equal((await save(h, h.setupCode(), '203.0.113.121')).status, 200, 'another client configures');
    await h.waitReady({ login: false });
    const login = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': X },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'wrong-password' }) });
    assert.equal(login.status, 429, 'the same throttle state carries over the in-process handoff');
  });
});
