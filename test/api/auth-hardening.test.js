'use strict';
// PM audit (A), go-live gate: scrypt hash, constant-time verification, login throttling, JSON-only login, audit.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword, isHash } = require('../../src/security/password');
const { createLoginThrottle, IP_FREE } = require('../../src/security/login-throttle');
const { loadScenario } = require('../helpers/scenario');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');

const ROOT = path.join(__dirname, '..', '..');
const sc = loadScenario('synthetic-basic');
const login = (h, body, headers = { 'content-type': 'application/json' }, extra = {}) => fetch(h.base + '/api/login', { method: 'POST', headers: Object.assign({}, headers, extra),
  body: typeof body === 'string' ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), retryAfter: r.headers.get('retry-after'), cookie: r.headers.get('set-cookie') }));
const auditRows = (h) => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true }); try { return db.prepare("SELECT outcome, detail, actor_json FROM audit_log WHERE command = 'auth.login' ORDER BY id").all().map((r) => ({ ...r })); } finally { db.close(); } };

describe('auth · the password hash', () => {
  it('scrypt hash: verifies the right password, refuses others and malformed hashes, salts each hash', async () => {
    const a = await hashPassword('correct horse battery'), b = await hashPassword('correct horse battery');
    assert.match(a, /^scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/); assert.notEqual(a, b, 'a fresh salt each time');
    assert.ok(!a.includes('$'), 'no $ (safe to source from a shell)');
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse batterz', a), false);
    for (const bad of ['', 'plain', a.replace('scrypt', 'bcrypt'), 'scrypt:3:8:1:aaaaaaaaaaaaaaaaaaaaaa:' + 'b'.repeat(43), 'scrypt:2097152:8:1:' + 'a'.repeat(22) + ':' + 'b'.repeat(43)]) {
      assert.equal(await verifyPassword('correct horse battery', bad), false, bad.slice(0, 20)); assert.equal(isHash(bad), false, bad.slice(0, 20));
    }
    assert.equal(await verifyPassword('correct horse battery', a.slice(0, -4)), false, 'a truncated key never verifies (scrypt outputs are prefixes)');
    assert.equal(isHash(a.slice(0, -4)), false);
  });

  it('the hash-password script prints only a hash (piped input), refuses short passwords', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hash-password.js')], { input: 'un mot de passe assez long\n', encoding: 'utf8' });
    assert.equal(r.status, 0); assert.match(r.stdout.trim(), /^scrypt:/); assert.ok(!r.stdout.includes('assez long') && !r.stderr.includes('assez long'));
    assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hash-password.js')], { input: 'court\n', encoding: 'utf8' }).status, 1);
  });

  it('config: an invalid hash refuses to boot; a hash alone is enough; plaintext still accepted', () => {
    const boot = (extra) => spawnSync(process.execPath, ['-e', "require('./src/config').loadConfig(); console.log('ok')"], { cwd: ROOT, encoding: 'utf8',
      env: Object.assign({ PATH: process.env.PATH, HOME: '/tmp', AO_ENV: 'test', AO_DATA_DIR: '/tmp/ao-auth-cfg', PORTAL_EMAIL: 'a@b.c', PORTAL_SECRET: 's' }, extra) });
    assert.equal(boot({ PORTAL_PASSWORD_HASH: 'nope' }).status, 1);
    assert.equal(boot({}).status, 1, 'no password at all');
    assert.equal(boot({ PORTAL_PASSWORD_HASH: 'scrypt:32768:8:1:' + 'a'.repeat(22) + ':' + 'b'.repeat(43) }).stdout.trim(), 'ok');
    assert.equal(boot({ PORTAL_PASSWORD: 'p' }).stdout.trim(), 'ok');
  });
});

describe('auth · login throttle', () => {
  it('per IP: free attempts, then exponential lockouts; a success resets; global backoff for distributed guessing', () => {
    let t = 0;
    const th = createLoginThrottle({ now: () => t });
    for (let i = 0; i < IP_FREE; i++) { assert.equal(th.check('1.2.3.4').ok, true); th.failure('1.2.3.4'); }
    assert.equal(th.check('1.2.3.4').ok, true, `${IP_FREE} failures are free`);
    th.failure('1.2.3.4');
    const lock1 = th.check('1.2.3.4'); assert.deepEqual([lock1.ok, lock1.scope, lock1.retryAfterSec], [false, 'ip', 2]);
    assert.equal(th.check('5.6.7.8').ok, true, 'another IP is not locked');
    t += 2000; th.failure('1.2.3.4');
    assert.equal(th.check('1.2.3.4').retryAfterSec, 4, 'doubles');
    t += 4000; th.success('1.2.3.4'); assert.equal(th.check('1.2.3.4').ok, true);
    const g = createLoginThrottle({ now: () => t });
    for (let i = 0; i < 21; i++) g.failure('10.0.0.' + i);
    const lockG = g.check('9.9.9.9'); assert.deepEqual([lockG.ok, lockG.scope], [false, 'global']);
  });
});

describe('auth · the login route (real server)', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('JSON only: a form or a text body → 415; a JSON login works (case-insensitive e-mail)', async () => {
    assert.equal((await login(h, 'email=x&password=y', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await login(h, '{"email":"x"}', { 'content-type': 'text/plain' })).status, 415);
    const ok = await login(h, { email: TEST_EMAIL.toUpperCase(), password: TEST_PASSWORD });
    assert.equal(ok.status, 200); assert.match(ok.cookie, /^taco_sess=/);
  });

  it('wrong e-mail and wrong password are the same 401; past the free attempts → 429 with Retry-After; audited', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.7' };   // the harness talks over loopback: a trusted proxy
    const a = await login(h, { email: 'nobody@example.invalid', password: TEST_PASSWORD }, undefined, ip);
    const b = await login(h, { email: TEST_EMAIL, password: 'wrong' }, undefined, ip);
    assert.deepEqual([a.status, a.json], [b.status, b.json]); assert.equal(a.status, 401);
    for (let i = 0; i < IP_FREE - 1; i++) await login(h, { email: TEST_EMAIL, password: 'wrong' }, undefined, ip);
    const locked = await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD }, undefined, ip);
    assert.equal(locked.status, 429, 'even the right password waits'); assert.ok(Number(locked.retryAfter) >= 1);
    const other = await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD }, undefined, { 'x-forwarded-for': '203.0.113.8' });
    assert.equal(other.status, 200, 'another client is not locked out');
    const rows = auditRows(h);
    assert.ok(rows.some((r) => r.outcome === 'rejected' && r.detail === 'invalid-credentials' && JSON.parse(r.actor_json).kind === 'anonymous'));
    assert.ok(rows.some((r) => r.outcome === 'rejected' && r.detail === 'throttled-ip'));
    // (a form login is now refused by the CSRF guard, R15-01, before the login's own JSON check: still 415)
    assert.ok(rows.some((r) => r.outcome === 'ok' && JSON.parse(r.actor_json).kind === 'human'));
    assert.ok(!JSON.stringify(rows).includes('wrong') && !JSON.stringify(rows).includes(TEST_PASSWORD));
  });
});

describe('auth · a hashed password on the real server', () => {
  let h;
  before(async () => {
    // no plaintext in the env at all: only the hash (the harness logs in with TEST_PASSWORD)
    h = await startServer(sc, { env: { PORTAL_PASSWORD: '', PORTAL_PASSWORD_HASH: await hashPassword(TEST_PASSWORD) } });
  });
  after(async () => { if (h) await h.stop(); });
  it('logs in against the hash; anything else is refused', async () => {
    assert.equal((await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD })).status, 200);
    assert.equal((await login(h, { email: TEST_EMAIL, password: TEST_PASSWORD + ' ' })).status, 401);
    assert.equal((await login(h, { email: TEST_EMAIL })).status, 401, 'no password field');
  });
});
