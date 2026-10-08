'use strict';
// G8 · `agent-office backup | restore` (operations.md §2), through the real CLI, against a real server's store.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../../src/security/password');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const BIN = path.join(__dirname, '..', '..', 'packaging', 'bin', 'agent-office.js');
const MARK = 'SECRET-RUNTIME-TOKEN-MARKER-7f3a';
const mode = (p) => fs.statSync(p).mode & 0o777;
const cli = (args, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env) });
const meta = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return Object.fromEntries(db.prepare('SELECT key, value FROM ao_backup').all().map((r) => [r.key, r.value])); } finally { db.close(); } };

describe('G8 · backup and restore', () => {
  let h, env, out;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { prepare: async (tmp) => {
      const dir = path.join(tmp, '.config', 'agent-office'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, instance: { name: 'Backup test', locale: 'en', timeZone: 'UTC' },
        owner: { displayName: 'Owner', email: 'owner@example.invalid' }, runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:9' } }, agents: { primary: null, looks: {} } }), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: await hashPassword('x'.repeat(12)), runtimeToken: MARK }), { mode: 0o600 });
    } });
    env = { HOME: h.tmp, AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data') };
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bk-'));
  });
  after(async () => { if (h) await h.stop(); fs.rmSync(out, { recursive: true, force: true }); });

  it('backup while the server runs: one 0600 file, verified, with the config and NO secret by default', () => {
    const r = cli(['backup', path.join(out, 'a.sqlite')], env);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /backup ok: instance test, schema v\d+, config, no secrets/);
    assert.equal(mode(path.join(out, 'a.sqlite')), 0o600);
    const m = meta(path.join(out, 'a.sqlite'));
    assert.deepEqual([m.format, m.instance, m.secrets], ['1', 'test', undefined]); assert.match(m.config, /Backup test/);
    assert.ok(!fs.readFileSync(path.join(out, 'a.sqlite')).includes(MARK), 'no secret bytes in the file');
    assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK));
  });
  it('--include-secrets embeds them (0600 file); an existing file needs --force', () => {
    const f = path.join(out, 'b.sqlite');
    assert.equal(cli(['backup', f, '--include-secrets'], env).status, 0);
    assert.equal(mode(f), 0o600); assert.match(meta(f).secrets, new RegExp(MARK));
    const again = cli(['backup', f], env);
    assert.equal(again.status, 1); assert.match(again.stderr, /refused: the backup file exists/);
    assert.equal(cli(['backup', f, '--force', '--include-secrets'], env).status, 0);
  });
  it('restore is refused while the server runs (exit 1, nothing changed)', () => {
    const before = fs.statSync(path.join(env.AO_DATA_DIR, 'agent-office.sqlite')).mtimeMs;
    const r = cli(['restore', path.join(out, 'a.sqlite')], env);
    assert.equal(r.status, 1); assert.match(r.stderr, /a server is running on this data directory/);
    assert.equal(fs.statSync(path.join(env.AO_DATA_DIR, 'agent-office.sqlite')).mtimeMs, before);
  });
  it('a damaged or foreign file is refused; so is another instance\'s backup', () => {
    const junk = path.join(out, 'junk.sqlite'); fs.writeFileSync(junk, 'not sqlite');
    const fresh = { HOME: out, AO_ENV: 'test', AO_DATA_DIR: path.join(out, 'fresh-a') };
    assert.equal(cli(['restore', junk], fresh).status, 1);
    const tampered = path.join(out, 't.sqlite'); fs.copyFileSync(path.join(out, 'b.sqlite'), tampered);
    { const db = new DatabaseSync(tampered); db.prepare("UPDATE ao_backup SET value = value || ' ' WHERE key = 'secrets'").run(); db.close(); }
    const t = cli(['restore', tampered], fresh); assert.equal(t.status, 1); assert.match(t.stderr, /secrets payload is damaged/);
    const other = cli(['restore', path.join(out, 'a.sqlite')], { HOME: out, AO_ENV: 'staging', AO_DATA_DIR: path.join(out, 'fresh-b') });
    assert.equal(other.status, 1); assert.match(other.stderr, /the backup is of the test instance, not staging/);
  });
  it('restore into an empty instance: the store (no ao_backup, no secret bytes), and the config + secrets written 0600', () => {
    const home = fs.mkdtempSync(path.join(out, 'home-'));
    const target = { HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data') };
    const r = cli(['restore', path.join(out, 'b.sqlite')], target);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /restore ok: instance test, schema v\d+, config written, secrets written/);
    const live = path.join(target.AO_DATA_DIR, 'agent-office.sqlite');
    const db = new DatabaseSync(live, { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ao_backup'").get().n, 0); } finally { db.close(); }
    assert.ok(!fs.readFileSync(live).includes(MARK), 'no secret bytes in the live store (dropped and vacuumed)');
    const cfgDir = path.join(home, '.config', 'agent-office');
    for (const f of ['config.json', 'secrets.json']) assert.equal(mode(path.join(cfgDir, f)), 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, 'secrets.json'), 'utf8')).runtimeToken, MARK);
    // a second restore over an existing store keeps the previous one, and keeps the existing config files (no --force)
    const again = cli(['restore', path.join(out, 'a.sqlite')], target);
    assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /previous store kept in backups\/, config kept/);
    assert.ok(fs.readdirSync(path.join(target.AO_DATA_DIR, 'backups')).some((f) => /^agent-office-prerestore-\d+\.sqlite$/.test(f)));
  });
  it('a second server on the same data dir refuses to start', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], { encoding: 'utf8', timeout: 20000,
      env: Object.assign({ PATH: process.env.PATH, PORTAL_EMAIL: 'a@example.invalid', PORTAL_SECRET: 's'.repeat(40), PORTAL_PASSWORD: 'x', PORT: '0' }, env) });
    assert.equal(r.status, 1); assert.match(r.stderr, /another server is using this data directory/);
  });
});
