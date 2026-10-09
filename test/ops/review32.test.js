'use strict';
// review-32 R32-01 (P1) and the rest of R30-02: a restore never destroys every copy of a store. Failures are injected
// into the swap's renames and the cleanup's unlinks (restore's `ops.beforeOperation` seam). Whatever fails, the advertised final
// state is true, and at least one complete, intact store survives: the new one verified in place, or the previous one.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../../src/security/password');
const { openDatabase } = require('../../src/store/db');
const { backup, restore } = require('../../src/ops/backup');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CONFIG = (name) => JSON.stringify({ version: 1, instance: { name, locale: 'en', timeZone: 'UTC' }, owner: { displayName: 'O', email: 'o@example.invalid' },
  runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: null, looks: {} } });
let HASH;
before(async () => { HASH = await hashPassword('a-long-password-123'); });
const SECRETS = (tok) => JSON.stringify({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: HASH, runtimeToken: tok });

// an fs whose renameSync/rmSync throw EIO once, for the call matching `when(op, path)`
function faulty(when) {
  let fired = 0;
  return { beforeOperation(kind, from, to) {
    const op = kind === 'remove' ? 'rmSync' : 'renameSync';
    if (!fired && when(op, String(from), String(to))) { fired++; throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); }
  }, get fired() { return fired; } };
}
// a store file's facts, from a private copy (with its WAL): intact, and which store it is (the target has r32_marker)
function facts(file) {
  if (!fs.existsSync(file)) return null;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r32-probe-'));
  try {
    fs.copyFileSync(file, path.join(d, 'x.sqlite')); if (fs.existsSync(file + '-wal')) fs.copyFileSync(file + '-wal', path.join(d, 'x.sqlite-wal'));
    const db = new DatabaseSync(path.join(d, 'x.sqlite'));
    try {
      return { intact: Object.values(db.prepare('PRAGMA integrity_check').get())[0] === 'ok',
        previous: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'r32_marker'").get() };
    } finally { db.close(); }
  } catch (_) { return { intact: false }; } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

describe('R32-01 · a restore never destroys every copy of a store', () => {
  let root, bk;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r32-'));
    const src = path.join(root, 'src'), cfg = path.join(root, 'src-cfg');
    openDatabase({ dir: src, instance: 'test' }).close();
    fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cfg, 'config.json'), CONFIG('Backup')); fs.writeFileSync(path.join(cfg, 'secrets.json'), SECRETS('tok-backup'));
    bk = path.join(root, 'b.sqlite');
    await backup({ dataDir: src, paths: { file: path.join(cfg, 'config.json'), secrets: path.join(cfg, 'secrets.json') }, out: bk, includeSecrets: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  // a fresh target: a store with a marker row left in its WAL, plus config and secrets
  function target() {
    const t = fs.mkdtempSync(path.join(root, 't-')), data = path.join(t, 'data'), cfg = path.join(t, 'cfg');
    openDatabase({ dir: data, instance: 'test' }).close();
    const live = path.join(data, 'agent-office.sqlite');
    const w = spawnSync(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(live)});
      db.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE r32_marker (x); INSERT INTO r32_marker VALUES (1)'); process.exit(0);`]);
    assert.equal(w.status, 0);
    fs.mkdirSync(cfg, { mode: 0o700 });
    fs.writeFileSync(path.join(cfg, 'config.json'), CONFIG('Target'), { mode: 0o600 }); fs.writeFileSync(path.join(cfg, 'secrets.json'), SECRETS('tok-target'), { mode: 0o600 });
    const paths = { file: path.join(cfg, 'config.json'), secrets: path.join(cfg, 'secrets.json') };
    const files = [live, live + '-wal', paths.file, paths.secrets];
    return { data, live, paths, snap: () => Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? sha(fs.readFileSync(f)) : null])),
      prerestores: () => (fs.existsSync(path.join(data, 'backups')) ? fs.readdirSync(path.join(data, 'backups')).filter((f) => /prerestore/.test(f)).map((f) => path.join(data, 'backups', f)) : []),
      leftovers: () => fs.readdirSync(data).concat(fs.readdirSync(cfg)).filter((f) => /\.rollback-/.test(f)) };
  }
  const run = (t, fsx) => restore({ dataDir: t.data, paths: t.paths, file: bk, instance: 'test', force: true, ops: fsx });

  for (const [name, when] of [
    ['the FIRST moved-aside file (the previous store)', (op, p) => op === 'rmSync' && /\.agent-office\.sqlite\.rollback-/.test(p)],
    ['a LATER moved-aside file (config.json)', (op, p) => op === 'rmSync' && /\.config\.json\.rollback-/.test(p)],
  ]) {
    it(`cleanup fails deleting ${name}: the restore is committed (the new store verified in place), the pre-restore copy is kept, and the leftovers are reported truthfully`, async () => {
      const t = target();
      const fsx = faulty(when);
      const r = await run(t, fsx);
      assert.equal(fsx.fired, 1, 'the failure was injected');
      assert.equal(r.ok, true);
      assert.deepEqual(facts(t.live), { intact: true, previous: false }, 'the new store is live and intact');
      assert.equal(JSON.parse(fs.readFileSync(t.paths.file, 'utf8')).instance.name, 'Backup');
      const pre = t.prerestores(); assert.equal(pre.length, 1, 'the pre-restore copy is kept');
      assert.deepEqual(facts(pre[0]), { intact: true, previous: true }, 'and it is the complete previous store');
      assert.deepEqual(r.leftovers, t.leftovers(), 'the reported leftovers are exactly the ones on disk');
      assert.equal(r.leftovers.length, 1);
    });
  }

  it('the swap fails (a rename): everything is rolled back byte for byte, the pre-restore copy removed, "nothing changed" is true', async () => {
    const t = target(); const before = t.snap();
    const fsx = faulty((op, p) => op === 'renameSync' && /config\.json$/.test(p) && !/rollback/.test(p) && /\.tmp$/.test(String(p)) === false);
    await assert.rejects(run(t, fsx), (e) => e.code === 'failed' && /nothing changed/.test(e.reason));
    assert.equal(fsx.fired, 1);
    assert.deepEqual(t.snap(), before); assert.deepEqual(t.prerestores(), []); assert.deepEqual(t.leftovers(), []);
  });

  it('the swap fails AND a rollback rename fails: the pre-restore copy is kept and the previous store survives intact somewhere; the error says so', async () => {
    const t = target();
    let n = 0;
    const fsx = { beforeOperation: (kind, a, b) => {
      if (kind === 'place' && /config\.json$/.test(String(b)) && n === 0) { n++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
      if (kind === 'rollback' && /\.agent-office\.sqlite\.rollback-/.test(String(a)) && n === 1) { n++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
    } };
    await assert.rejects(run(t, fsx), (e) => e.code === 'failed' && /could not be rolled back completely/.test(e.reason));
    assert.equal(n, 2);
    const pre = t.prerestores(); assert.equal(pre.length, 1, 'the pre-restore copy is kept when the rollback is incomplete');
    assert.deepEqual(facts(pre[0]), { intact: true, previous: true });
    assert.ok(t.leftovers().some((f) => /\.agent-office\.sqlite\.rollback-/.test(f)), 'the moved-aside previous store is kept too');
  });
});
