'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const safe = require('../../src/ops/safe-fs');
const { openDatabase, MIGRATIONS_DIR } = require('../../src/store/db');
const { acquireDirLock, SERVER_LOCK } = require('../../src/ops/lock');
const ROOT = path.resolve(__dirname, '../..');
const uid = process.getuid(), gid = process.getgid();
const identities = (extra = '', primary = '') => ({
  passwd: `operator:x:${uid}:${gid}::/synthetic/home:/bin/false\n` + primary,
  group: `operator:x:${gid}:${extra}\n`, nsswitch: 'passwd: files\ngroup: files\n',
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-existing-install-'));
  const home = path.join(root, 'home'), local = path.join(home, '.local'), share = path.join(local, 'share');
  const data = path.join(share, 'agent-office'), migrations = path.join(root, 'old-migrations');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o750); fs.chmodSync(local, 0o700); fs.chmodSync(share, 0o700);
  fs.mkdirSync(migrations, { mode: 0o700 });
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => Number(f.slice(0, 3)) <= 6)) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(migrations, file));
  openDatabase({ dir: data, instance: 'production', migrationsDir: migrations }).close();
  fs.mkdirSync(path.join(data, 'backups'), { mode: 0o700 });
  fs.mkdirSync(path.join(data, 'integrations'), { mode: 0o775 }); fs.chmodSync(path.join(data, 'integrations'), 0o775);
  fs.mkdirSync(path.join(data, 'project-covers'), { mode: 0o700 });
  const live = new DatabaseSync(path.join(data, 'agent-office.sqlite'));
  live.exec('PRAGMA journal_mode=WAL; CREATE TABLE install_marker(x); INSERT INTO install_marker VALUES (42)');
  fs.chmodSync(local, 0o775);
  return { root, home, local, share, data, live, close() { live.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function inject(records) { if (safe.setIdentityFixture) safe.setIdentityFixture(records); }
test('T-0013: existing install boots API-only through a release cwd symlink with private-group 0775 ancestor', async () => {
  const f = fixture(); let child;
  try {
    const releases = path.join(f.root, 'releases'); fs.mkdirSync(releases); fs.symlinkSync(ROOT, path.join(releases, 'current'));
    const entry = path.join(f.root, 'boot.cjs');
    fs.writeFileSync(entry, `const safe=require(${JSON.stringify(path.join(ROOT, 'src/ops/safe-fs'))}); if(safe.setIdentityFixture) safe.setIdentityFixture(${JSON.stringify(identities())}); require(${JSON.stringify(path.join(ROOT, 'server.js'))});`);
    child = spawn(process.execPath, [entry], { cwd: path.join(releases, 'current'), env: {
      HOME: f.home, PATH: path.join(ROOT, 'test/bin') + ':' + path.dirname(process.execPath), NODE_OPTIONS: '', NODE_TEST_CONTEXT: 'fixture',
      AO_ENV: 'production', AO_DATA_DIR: f.data, AO_API_ONLY: '1', AO_RUNTIME: 'demo', AO_ENRICHERS: '', AO_PROJECTS_DISCOVERY: '0',
      PORT: '0', HOST: '127.0.0.1', PORTAL_EMAIL: 'owner@example.invalid', PORTAL_PASSWORD: 'synthetic-password', PORTAL_SECRET: 's'.repeat(48),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error('boot timed out: ' + output)), 15000);
      const poll = setInterval(() => { if (/AO_READY .*"mode":"app"/.test(output)) done(); }, 20);
      const exit = code => done(new Error('boot exited ' + code + ': ' + output)); child.once('exit', exit);
      function done(error) { clearTimeout(timeout); clearInterval(poll); child.removeListener('exit', exit); error ? reject(error) : resolve(); }
    });
    assert.ok(!output.includes('store unavailable'), output);
    assert.ok(fs.existsSync(path.join(f.data, SERVER_LOCK)));
    const backup = fs.readdirSync(path.join(f.data, 'backups')).find(n => /premigrate-v006/.test(n)); assert.ok(backup);
    const db = new DatabaseSync(path.join(f.data, 'backups', backup), { readOnly: true });
    try { assert.equal(db.prepare('SELECT x FROM install_marker').get().x, 42); assert.equal(db.prepare('SELECT max(version) v FROM schema_migrations').get().v, 6); } finally { db.close(); }
    assert.equal(fs.statSync(f.local).mode & 0o777, 0o775); assert.equal(fs.statSync(path.join(f.data, 'integrations')).mode & 0o777, 0o775);
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    f.close();
  }
});
test('T-0013: WAL, lock journal and directory entry churn do not change directory identity', () => {
  const f = fixture(); inject(identities()); const release = acquireDirLock(f.data, SERVER_LOCK);
  try {
    const pinned = safe.capture(f.data).chain;
    const journal = path.join(f.data, 'synthetic-journal'); fs.writeFileSync(journal, 'synthetic'); fs.unlinkSync(journal);
    safe.verifyTrusted(pinned);
    const h = openDatabase({ dir: f.data, instance: 'production', backupHook: (phase) => { if (phase === 'store-backup:sqlite-copy') { fs.writeFileSync(journal, 'churn'); fs.unlinkSync(journal); } } });
    try { assert.ok(fs.existsSync(h.backup())); } finally { h.close(); }
  } finally { release(); inject(null); f.close(); }
});
for (const [kind, records] of [
  ['supplementary member', identities('other')],
  ['another primary member', identities('', `other:x:${uid + 1234}:${gid}::/synthetic/other:/bin/false\n`)],
  ['systemd userdb supplementary member', { ...identities(), nsswitch: 'passwd: files systemd\ngroup: files systemd\n', userdbChecked: true, userdb: [{ name: 'other:operator.membership', text: '' }] }],
  ['systemd userdb primary member', { ...identities(), nsswitch: 'passwd: files systemd\ngroup: files systemd\n', userdbChecked: true, userdb: [{ name: 'other.user', text: JSON.stringify({ userName: 'other', uid: uid + 1234, gid }) }] }],
  ['external identity provider', { ...identities(), nsswitch: 'passwd: files sss\ngroup: files ldap\n' }],
]) test(`T-0013: shared or unproven group (${kind}) is refused with actionable path details`, () => {
  const f = fixture(); inject(records);
  try {
    const check = error => {
      assert.equal(error.code, 'EUNSAFEPATH'); assert.ok(error.message.includes(f.local));
      assert.match(error.message, /0775/); assert.match(error.message, /owner=.*group=/);
      assert.match(error.message, /private group|membership/); assert.ok(error.message.includes('chmod g-w ')); return true;
    };
    assert.throws(() => safe.verifyTrusted(safe.capture(f.data).chain), check);
    assert.throws(() => safe.mutate(path.join(f.data, 'refused.json'), { type: 'write', trusted: true, text: 'must not publish' }), check);
    assert.equal(fs.existsSync(path.join(f.data, 'refused.json')), false);
    assert.equal(fs.readdirSync(path.join(f.data, 'backups')).length, 0);
  } finally { inject(null); f.close(); }
});
test('T-0013: immediate artifact parent stays private even for a proven private group', () => {
  const f = fixture(); inject(identities());
  try {
    fs.chmodSync(path.join(f.data, 'backups'), 0o775);
    assert.throws(() => safe.verifyTrusted(safe.capture(path.join(f.data, 'backups')).chain), error => {
      assert.equal(error.code, 'EUNSAFEPATH'); assert.match(error.message, /artifact parent.*private/); return true;
    });
  } finally { inject(null); f.close(); }
});

test('T-0013: Ubuntu files systemd private group is proven without any host identity probing', () => {
  const f = fixture(); inject({ ...identities(), nsswitch: 'passwd: files systemd\ngroup: files systemd\n', userdbChecked: true, userdb: [] });
  try {
    // Identity inputs are fixtures all the way through the spawned writer.
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) { if (typeof file === 'string' && /^\/(etc|run|usr)\//.test(file)) throw new Error('host identity probe forbidden'); return original.call(this, file, ...args); };
    try { safe.verifyTrusted(safe.capture(f.data).chain); } finally { fs.readFileSync = original; }
    const h = openDatabase({ dir: f.data, instance: 'production' });
    try { assert.ok(fs.existsSync(h.backup())); } finally { h.close(); }
  } finally { inject(null); f.close(); }
});
for (const boundary of ['local', 'share']) for (const phase of ['sqlite-copy', 'sqlite', 'publish']) {
  test(`T-0013: admitted private-group ancestor replacement (${boundary}, ${phase}) preserves outside files`, () => {
    const f = fixture(); inject(identities()); let attack = false, reached = false;
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
    const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'outside synthetic sentinel', { mode: 0o640 });
    const h = openDatabase({ dir: f.data, instance: 'production', backupHook(step) {
      if (attack && !reached && step === 'store-backup:' + phase) {
        reached = true; fs.renameSync(f[boundary], f[boundary] + '.held'); fs.symlinkSync(outside, f[boundary]);
      }
    } });
    try {
      attack = true;
      assert.throws(() => h.backup(), { code: 'EUNSAFEPATH' }); assert.equal(reached, true);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside synthetic sentinel');
      assert.equal(fs.statSync(sentinel).mode & 0o777, 0o640);
      assert.deepEqual(fs.readdirSync(outside), ['sentinel']); assert.ok(fs.lstatSync(f[boundary]).isSymbolicLink());
    } finally { h.close(); inject(null); f.close(); }
  });
}

test('T-0013: a test writer without identity fixtures refuses private-group admission instead of probing the host', () => {
  const f = fixture(); inject(null);
  try {
    assert.throws(() => safe.mutate(path.join(f.data, 'no-host-probe.json'), { type: 'write', trusted: true, text: 'synthetic' }), error => {
      assert.equal(error.code, 'EUNSAFEPATH'); assert.match(error.message, /membership cannot be proven/); return true;
    });
    assert.equal(fs.existsSync(path.join(f.data, 'no-host-probe.json')), false);
  } finally { f.close(); }
});
