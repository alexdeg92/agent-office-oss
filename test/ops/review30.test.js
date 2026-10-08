'use strict';
// review-30 (P2 ×3, restore): R30-01 a setup-mode server holds the data-dir lock too (restore and a second server are
// refused); R30-02 a failed restore leaves the store (and its WAL), config and secrets byte-identical; R30-03 a payload
// whose digest matches but which is not a valid config / secrets file is refused (backup, inspection and restore).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../../src/security/password');
const { openDatabase } = require('../../src/store/db');
const { backup, inspectBackup } = require('../../src/ops/backup');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'packaging', 'bin', 'agent-office.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cliAsync = (args, env) => new Promise((resolve) => {   // async: a server under test may be in this process's harness
  const c = spawn(process.execPath, [BIN, ...args], { env: Object.assign({ PATH: process.env.PATH }, env) });
  let stdout = '', stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.once('exit', (status) => resolve({ status, stdout, stderr }));
});
const cli = (args, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env) });
const CONFIG = { version: 1, instance: { name: 'R30', locale: 'en', timeZone: 'UTC' }, owner: { displayName: 'Owner', email: 'owner@example.invalid' },
  runtime: { adapter: 'demo', demo: { seed: 2 } }, agents: { primary: null, looks: {} } };
let HASH;
before(async () => { HASH = await hashPassword('a-long-password-123'); });
const SECRETS = () => ({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: HASH, runtimeToken: 'tok-r30' });

// a backup of a fresh `instance` store, with config + secrets payloads
async function makeBackup(dir, instance, { config = JSON.stringify(CONFIG), secrets = JSON.stringify(SECRETS()) } = {}) {
  const data = path.join(dir, 'src-data'), cfgDir = path.join(dir, 'src-cfg');
  openDatabase({ dir: data, instance }).close();
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), config, { mode: 0o600 }); fs.writeFileSync(path.join(cfgDir, 'secrets.json'), secrets, { mode: 0o600 });
  const out = path.join(dir, 'b-' + crypto.randomBytes(3).toString('hex') + '.sqlite');
  await backup({ dataDir: data, paths: { file: path.join(cfgDir, 'config.json'), secrets: path.join(cfgDir, 'secrets.json') }, out, includeSecrets: true });
  return out;
}
// rewrite a backup's payload and its digest (the digest then MATCHES the bytes)
function tamper(file, key, text) {
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE ao_backup SET value = ? WHERE key = ?').run(text, key); db.prepare('UPDATE ao_backup SET value = ? WHERE key = ?').run(sha(text), key + 'Sha256'); } finally { db.close(); }
}
const snapshot = (files) => Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? (fs.statSync(f).isDirectory() ? 'dir' : sha(fs.readFileSync(f))) : null]));

describe('R30-01 · a setup-mode server owns its data dir too', () => {
  let h, bk;
  before(async () => {
    h = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { AO_ENV: 'test' } });
    bk = await makeBackup(fs.mkdtempSync(path.join(h.tmp, 'bk-')), 'test');
  });
  after(async () => { if (h) await h.stop(); });
  it('restore while setup is being served: refused (exit 1), nothing written', async () => {
    const env = { HOME: h.tmp, AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data') };
    const r = await cliAsync(['restore', bk], env);
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /a server is running on this data directory/);
    assert.ok(!fs.existsSync(path.join(h.tmp, 'data', 'agent-office.sqlite')), 'no store published');
    assert.ok(!fs.existsSync(path.join(h.tmp, '.config', 'agent-office', 'config.json')), 'no config published');
    assert.equal((await fetch(h.base + '/healthz')).status, 200);
  });
  it('a second server on the same data dir refuses to start (setup mode)', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, HOME: h.tmp, AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), PORT: '0' } });
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /another server is using this data directory/);
  });
});

describe('R30-02 · a restore that fails leaves everything byte-identical', () => {
  let dir, bk, env, data, cfgDir, live;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r30b-'));
    bk = await makeBackup(dir, 'test');
    data = path.join(dir, 'data'); cfgDir = path.join(dir, 'home', '.config', 'agent-office'); live = path.join(data, 'agent-office.sqlite');
    // the target: an existing same-instance store with a row the backup lacks, left with a WAL (an unclean stop)
    openDatabase({ dir: data, instance: 'test' }).close();
    const w = spawnSync(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(live)});
      db.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE r30_marker (x TEXT); INSERT INTO r30_marker VALUES (1)'); process.exit(0);`], { encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.ok(fs.existsSync(live + '-wal') && fs.statSync(live + '-wal').size > 0, 'the target has a WAL');
    env = { HOME: path.join(dir, 'home'), AO_ENV: 'test', AO_DATA_DIR: data };
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const watched = () => [live, live + '-wal', live + '-shm', path.join(cfgDir, 'config.json'), path.join(cfgDir, 'secrets.json')];

  it('config.json is a directory (--force): refused or failed, and the store, WAL, config and secrets are unchanged', () => {
    fs.mkdirSync(path.join(cfgDir, 'config.json'));
    try {
      const before = snapshot(watched());
      const r = cli(['restore', bk, '--force'], env);
      assert.notEqual(r.status, 0, r.stdout); assert.equal(r.stdout, '');
      assert.deepEqual(snapshot(watched()), before);
      assert.deepEqual(fs.readdirSync(data).filter((f) => f.startsWith('.')).filter((f) => !f.startsWith('.server-lock')), [], 'no temporary left behind');
    } finally { fs.rmSync(path.join(cfgDir, 'config.json'), { recursive: true, force: true }); }
  });
  it('secrets.json is a directory (config publishable): the config is not published either', () => {
    fs.mkdirSync(path.join(cfgDir, 'secrets.json'));
    try {
      const before = snapshot(watched());
      const r = cli(['restore', bk, '--force'], env);
      assert.notEqual(r.status, 0);
      assert.deepEqual(snapshot(watched()), before);
      assert.ok(!fs.existsSync(path.join(cfgDir, 'config.json')));
    } finally { fs.rmSync(path.join(cfgDir, 'secrets.json'), { recursive: true, force: true }); }
  });
  it('a failure DURING the commit (after the store, the config or the secrets is in place) rolls everything back, byte for byte', async () => {
    const { restore } = require('../../src/ops/backup');
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(Object.assign({}, CONFIG, { instance: { name: 'Before', locale: 'fr', timeZone: 'UTC' } })), { mode: 0o600 });
    fs.writeFileSync(path.join(cfgDir, 'secrets.json'), JSON.stringify(SECRETS()), { mode: 0o600 });
    const paths = { file: path.join(cfgDir, 'config.json'), secrets: path.join(cfgDir, 'secrets.json') };
    for (const step of ['staged', 'store', 'config', 'secrets']) {
      const before = snapshot(watched());
      const backups = fs.existsSync(path.join(data, 'backups')) ? fs.readdirSync(path.join(data, 'backups')) : [];
      await assert.rejects(restore({ dataDir: data, paths, file: bk, instance: 'test', force: true, inject: step }), (e) => e.code === 'failed' && /nothing changed/.test(e.reason), step);
      assert.deepEqual(snapshot(watched()), before, step);
      assert.deepEqual(fs.readdirSync(data).filter((f) => f.startsWith('.') && !f.startsWith('.server-lock')), [], step + ': no temporary or rollback file');
      assert.deepEqual(fs.readdirSync(cfgDir).filter((f) => f.startsWith('.')), [], step);
      assert.deepEqual(fs.existsSync(path.join(data, 'backups')) ? fs.readdirSync(path.join(data, 'backups')) : [], backups, step + ': no pre-restore copy left');
    }
    fs.rmSync(path.join(cfgDir, 'config.json')); fs.rmSync(path.join(cfgDir, 'secrets.json'));
  });
  it('then a good restore succeeds (the same files, nothing in the way)', () => {
    const r = cli(['restore', bk, '--force'], env);
    assert.equal(r.status, 0, r.stderr);
    const db = new DatabaseSync(live, { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'r30_marker'").get().n, 0, 'the backup\'s store is live'); } finally { db.close(); }
    assert.ok(fs.readdirSync(path.join(data, 'backups')).some((f) => /prerestore/.test(f)), 'the previous store kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8')).instance.name, 'R30');
  });
});

describe('R30-03 · a matching digest is not validation', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r30c-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ['config', 'malformed JSON', '{"version": 1, "instance": '],
    ['config', 'valid JSON of the wrong shape', JSON.stringify({ version: 1, instance: { name: 'x' } })],
    ['secrets', 'malformed JSON', '{"version": 1, '],
    ['secrets', 'valid JSON of the wrong shape', JSON.stringify({ version: 1, sessionSecret: 'short' })],
  ];
  for (const [key, what, text] of cases) {
    it(`${key}: ${what} with a matching digest → refused at inspection and restore; nothing changes; no payload text in the error`, async () => {
      const bk = await makeBackup(fs.mkdtempSync(path.join(dir, 'c-')), 'test');
      tamper(bk, key, text);
      assert.throws(() => inspectBackup(bk), (e) => e.code === 'refused' && new RegExp(`the backup's ${key} payload is not a valid ${key} file`).test(e.reason));
      const home = fs.mkdtempSync(path.join(dir, 'home-'));
      const env = { HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data') };
      const r = cli(['restore', bk], env);
      assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`${key} payload is not a valid ${key} file`));
      assert.ok(!r.stderr.includes(text) && !r.stderr.includes('short'), 'value-free');
      assert.ok(!fs.existsSync(path.join(home, 'data', 'agent-office.sqlite')) && !fs.existsSync(path.join(home, '.config')));
    });
  }
  it('backup refuses to publish a damaged config file (exit 1, no backup file), value-free', async () => {
    const d = fs.mkdtempSync(path.join(dir, 'bk-'));
    await assert.rejects(makeBackup(d, 'test', { config: '{"version": 1, "owner": {"email": "leaky@example.invalid"' }), (e) => e.code === 'refused' && /config file is not valid/.test(e.reason) && !e.reason.includes('leaky'));
    assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.sqlite') || f.endsWith('.tmp')), []);
  });
});
