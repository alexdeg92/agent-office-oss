'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../src/store/db');
const { backup, restore } = require('../../src/ops/backup');
const safe = require('../../src/ops/safe-fs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-artifact-security-'));
  const data = path.join(root, 'data'), output = path.join(root, 'output'), outside = path.join(root, 'outside');
  fs.mkdirSync(output, { mode: 0o700 }); fs.mkdirSync(outside, { mode: 0o700 });
  openDatabase({ dir: data, instance: 'test' }).close();
  const sentinel = path.join(outside, 'sentinel.sqlite'), db = new DatabaseSync(sentinel);
  db.exec('CREATE TABLE outside_marker(x); INSERT INTO outside_marker VALUES (42)'); db.close(); fs.chmodSync(sentinel, 0o640);
  return { root, data, output, outside, sentinel, out: path.join(output, 'backup.sqlite'), bytes: fs.readFileSync(sentinel),
    untouched() { assert.deepEqual(fs.readFileSync(sentinel), this.bytes); assert.equal(fs.statSync(sentinel).mode & 0o777, 0o640); },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const refused = e => e.code === 'refused' || e.code === 'failed';
for (const phase of ['directory', 'sqlite-copy', 'sqlite', 'publish']) for (const replacement of ['leaf', 'parent']) {
  test(`S08-01: ${replacement} replacement at backup ${phase} is confined and preserved`, async () => {
    const f = fixture(); let attack = false, entry;
    const open = fs.openSync;
    const swap = (directory, file) => {
      if (attack) return; attack = true;
      if (replacement === 'parent') { fs.renameSync(directory, directory + '.held'); fs.symlinkSync(f.outside, directory); entry = directory; }
      else { if (fs.existsSync(file)) fs.unlinkSync(file); fs.symlinkSync(f.sentinel, file); entry = file; }
    };
    try {
      // The audited implementation has no hooks: swap its real exclusive temp
      // before SQLite reopens it. The fixed implementation uses the stage seam.
      fs.openSync = (file, ...args) => {
        const fd = open(file, ...args);
        if (typeof file === 'string' && file.startsWith(f.output + path.sep) && /\.tmp$/.test(file)) swap(path.dirname(file), file);
        return fd;
      };
      await assert.rejects(backup({ dataDir: f.data, out: f.out, hook: (step, ctx) => {
        if (step === 'backup:' + phase) swap(ctx.directory, ctx.file || path.join(ctx.directory, 'artifact.sqlite'));
      } }), refused);
      assert.equal(attack, true); f.untouched();
      assert.ok(fs.lstatSync(entry).isSymbolicLink(), 'cleanup preserves a foreign replacement entry');
      assert.deepEqual(fs.readdirSync(f.outside), ['sentinel.sqlite']);
    } finally { fs.openSync = open; f.close(); }
  });
}
test('S08-01: a non-force destination created after admission is preserved', async () => {
  const f = fixture(), open = fs.openSync; let attack = false;
  const create = () => { if (!attack) { attack = true; fs.writeFileSync(f.out, 'Concurrent destination'); } };
  try {
    fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (typeof file === 'string' && /\.tmp$/.test(file) && file.startsWith(f.output)) create(); return fd; };
    await assert.rejects(backup({ dataDir: f.data, out: f.out, hook: step => { if (step === 'backup:publish') create(); } }), refused);
    assert.equal(attack, true); assert.equal(fs.readFileSync(f.out, 'utf8'), 'Concurrent destination'); f.untouched();
  } finally { fs.openSync = open; f.close(); }
});
test('S07-03: publication never chmods a replacement destination by pathname', async () => {
  const f = fixture(), rename = fs.renameSync; let attack = false;
  const replace = () => { if (!attack) { attack = true; fs.unlinkSync(f.out); fs.symlinkSync(f.sentinel, f.out); } };
  try {
    fs.renameSync = (from, to) => { const result = rename(from, to); if (to === f.out) replace(); return result; };
    await backup({ dataDir: f.data, out: f.out, hook: step => { if (step === 'backup:published') replace(); } });
    assert.equal(attack, true); f.untouched(); assert.ok(fs.lstatSync(f.out).isSymbolicLink());
  } finally { fs.renameSync = rename; f.close(); }
});
for (const location of ['destination', 'ancestor']) test(`S08-01: a shared ${location} is refused before staging`, async () => {
  const f = fixture();
  try {
    let out = f.out;
    if (location === 'ancestor') { const child = path.join(f.output, 'private'); fs.mkdirSync(child, { mode: 0o700 }); out = path.join(child, 'backup.sqlite'); }
    fs.chmodSync(f.output, 0o777);
    await assert.rejects(backup({ dataDir: f.data, out }), refused);
    assert.equal(fs.existsSync(out), false); f.untouched();
  } finally { f.close(); }
});
test('S08-01: explicit force replaces a reviewed regular file; linked destinations are refused', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.out, 'Old backup');
    await backup({ dataDir: f.data, out: f.out, force: true });
    assert.equal(fs.statSync(f.out).mode & 0o777, 0o600);
    const db = new DatabaseSync(f.out, { readOnly: true }); try { assert.equal(db.prepare("SELECT value FROM ao_backup WHERE key='format'").get().value, '1'); } finally { db.close(); }
    fs.unlinkSync(f.out); fs.symlinkSync(f.sentinel, f.out);
    await assert.rejects(backup({ dataDir: f.data, out: f.out, force: true }), refused); f.untouched();
  } finally { f.close(); }
});
test('S08-01: SQLite output is 0600 before and throughout automatic backup writes', () => {
  const f = fixture(); let seen = false; const prepare = DatabaseSync.prototype.prepare, oldMask = process.umask(0);
  try {
    DatabaseSync.prototype.prepare = function(query) {
      const statement = prepare.call(this, query);
      if (query === 'VACUUM INTO ?') {
        const run = statement.run.bind(statement);
        statement.run = file => { const result = run(file); seen = true; assert.equal(fs.statSync(file).mode & 0o777, 0o600); return result; };
      }
      return statement;
    };
    const store = openDatabase({ dir: f.data, instance: 'test', backupHook: (step, ctx) => {
      if (step === 'store-backup:sqlite-copy' || step === 'store-backup:sqlite') { seen = true; assert.equal(fs.statSync(ctx.file).mode & 0o777, 0o600); assert.equal(fs.statSync(ctx.directory).mode & 0o777, 0o700); }
    } });
    try { const out = store.backup(); assert.equal(fs.statSync(out).mode & 0o777, 0o600); assert.equal(seen, true); } finally { store.close(); }
  } finally { process.umask(oldMask); DatabaseSync.prototype.prepare = prepare; f.close(); }
});
for (const phase of ['copy', 'sqlite', 'publish']) for (const replacement of ['leaf', 'parent']) {
  test(`S08-01: restore ${replacement} replacement before ${phase} preserves the live store`, async () => {
    const f = fixture(), target = path.join(f.root, 'target'); let entry;
    try {
      await backup({ dataDir: f.data, out: f.out }); openDatabase({ dir: target, instance: 'test' }).close();
      const live = path.join(target, 'agent-office.sqlite'), before = fs.readFileSync(live);
      await assert.rejects(restore({ dataDir: target, file: f.out, instance: 'test', hook: (step, ctx) => {
        if (step === 'restore-store:' + phase && !entry) {
          if (replacement === 'leaf') { entry = ctx.file; fs.unlinkSync(entry); fs.symlinkSync(f.sentinel, entry); }
          else { entry = ctx.directory; fs.renameSync(entry, entry + '.held'); fs.symlinkSync(f.outside, entry); }
        }
      } }), refused);
      assert.ok(entry); assert.deepEqual(fs.readFileSync(live), before); f.untouched(); assert.ok(fs.lstatSync(entry).isSymbolicLink());
      assert.deepEqual(fs.readdirSync(f.outside), ['sentinel.sqlite']);
    } finally { f.close(); }
  });
}
test('S08-01: rollback preserves a concurrent destination and a complete previous store', async () => {
  const f = fixture(), target = path.join(f.root, 'target'), live = path.join(target, 'agent-office.sqlite'); let changed = false;
  const replace = () => { if (!changed) { changed = true; fs.unlinkSync(live); fs.writeFileSync(live, 'Concurrent owner file'); throw Object.assign(Error('injected'), { code: 'EIO' }); } };
  try {
    await backup({ dataDir: f.data, out: f.out }); const db = openDatabase({ dir: target, instance: 'test' }); db.db.exec('CREATE TABLE previous_marker(x)'); db.close();
    await assert.rejects(restore({ dataDir: target, file: f.out, instance: 'test', hook: step => { if (step === 'restore:store') replace(); }, ops: {
      fs: { rmSync: fs.rmSync, renameSync: (from, to) => { fs.renameSync(from, to); if (to === live && !changed) replace(); } },
    } }), /could not be rolled back completely/);
    assert.equal(changed, true); assert.equal(fs.readFileSync(live, 'utf8'), 'Concurrent owner file'); f.untouched();
    const pre = fs.readdirSync(path.join(target, 'backups')).find(name => /prerestore/.test(name));
    const old = new DatabaseSync(path.join(target, 'backups', pre), { readOnly: true });
    try { assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE name='previous_marker'").get()); } finally { old.close(); }
  } finally { f.close(); }
});
for (const replacement of ['leaf', 'parent']) test(`S08-01: automatic backup ${replacement} failure retains the previous daily backup`, () => {
  const f = fixture(); let attack = false, entry;
  const store = openDatabase({ dir: f.data, instance: 'test', backupHook: (step, ctx) => {
    if (attack && step === 'store-backup:sqlite-copy') {
      if (replacement === 'leaf') { entry = ctx.file; fs.unlinkSync(entry); fs.symlinkSync(f.sentinel, entry); }
      else { entry = ctx.directory; fs.renameSync(entry, entry + '.held'); fs.symlinkSync(f.outside, entry); }
    }
  } });
  try {
    const out = store.backup(), before = fs.readFileSync(out); attack = true;
    assert.throws(() => store.backup(), { code: 'EUNSAFEPATH' });
    assert.deepEqual(fs.readFileSync(out), before); assert.ok(fs.lstatSync(entry).isSymbolicLink()); f.untouched();
  } finally { store.close(); f.close(); }
});
test('S08-01: restore cleanup retains a replacement entry and a complete previous store', async () => {
  const f = fixture(), target = path.join(f.root, 'target'); let entry;
  const replace = file => { if (!entry && /\.agent-office\.sqlite\.rollback-/.test(file)) { entry = file; fs.unlinkSync(file); fs.symlinkSync(f.sentinel, file); } };
  try {
    await backup({ dataDir: f.data, out: f.out }); const store = openDatabase({ dir: target, instance: 'test' }); store.db.exec('CREATE TABLE previous_marker(x)'); store.close();
    const result = await restore({ dataDir: target, file: f.out, instance: 'test', ops: {
      beforeOperation: (op, file) => { if (op === 'remove') replace(file); },
      fs: { renameSync: fs.renameSync, rmSync: (file, options) => { replace(file); return fs.rmSync(file, options); } },
    } });
    assert.ok(entry); f.untouched(); assert.ok(fs.lstatSync(entry).isSymbolicLink()); assert.deepEqual(result.leftovers, [path.basename(entry)]);
    const pre = fs.readdirSync(path.join(target, 'backups')).find(name => /prerestore/.test(name));
    const db = new DatabaseSync(path.join(target, 'backups', pre), { readOnly: true });
    try { assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='previous_marker'").get()); } finally { db.close(); }
  } finally { f.close(); }
});
test('S08-01: failed restore cleanup preserves a replacement payload directory', async () => {
  const f = fixture(), target = path.join(f.root, 'target'), directory = path.join(f.root, 'new-config');
  const source = path.join(f.output, 'config.json'), file = path.join(directory, 'config.json');
  const rmdir = fs.rmdirSync; let replaced = false;
  const replace = () => { if (!replaced) { replaced = true; fs.renameSync(directory, directory + '.held'); fs.mkdirSync(directory, { mode: 0o700 }); } };
  try {
    fs.writeFileSync(source, JSON.stringify({ version: 1, instance: { name: 'Synthetic', locale: 'en', timeZone: 'UTC' },
      owner: { displayName: 'Owner', email: 'owner@example.invalid' }, runtime: { adapter: 'demo', demo: { seed: 2 } }, agents: { primary: null, looks: {} } }));
    await backup({ dataDir: f.data, out: f.out, paths: { file: source } });
    openDatabase({ dir: target, instance: 'test' }).close();
    const live = path.join(target, 'agent-office.sqlite'), before = fs.readFileSync(live);
    fs.rmdirSync = (dir, ...args) => { if (dir === directory) replace(); return rmdir(dir, ...args); };
    await assert.rejects(restore({ dataDir: target, file: f.out, instance: 'test', paths: { file }, inject: 'staged',
      hook: step => { if (step === 'restore:staged') replace(); } }), refused);
    assert.equal(replaced, true); assert.ok(fs.existsSync(directory), 'another directory inode is never removed');
    assert.deepEqual(fs.readFileSync(live), before); f.untouched();
  } finally { fs.rmdirSync = rmdir; f.close(); }
});
test('S07-01: a trusted alias is resolved once; link or target replacement is refused', () => {
  const f = fixture(), alias = path.join(f.root, 'system-alias'), target = path.join(f.root, 'canonical'); fs.mkdirSync(target); fs.symlinkSync(target, alias);
  let calls = 0; const fsx = Object.create(fs); fsx.realpathSync = file => { calls++; return fs.realpathSync(file); };
  try {
    const map = safe.canonicalizer([alias], fsx);
    assert.equal(map(path.join(alias, 'workspace/SKILL.md')), path.join(target, 'workspace/SKILL.md'));
    assert.equal(map(path.join(alias, 'data/backup.sqlite')), path.join(target, 'data/backup.sqlite')); assert.equal(calls, 1);
    fs.renameSync(target, target + '.held'); fs.mkdirSync(target);
    assert.throws(() => map(path.join(alias, 'data/backup.sqlite')), { code: 'EUNSAFEPATH' });
    fs.rmdirSync(target); fs.renameSync(target + '.held', target);
    fs.unlinkSync(alias); fs.symlinkSync(f.outside, alias);
    assert.throws(() => map(path.join(alias, 'data/backup.sqlite')), { code: 'EUNSAFEPATH' }); f.untouched();
  } finally { f.close(); }
});
