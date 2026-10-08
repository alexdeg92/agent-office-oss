'use strict';
// PM after architect-38: no test may ever open a real data dir (~/.local/share/agent-office*): under the test runner (or
// for the 'test' instance) a store outside os.tmpdir() is refused BEFORE anything is created.
// PM after architect-46: independent of where the checkout lives (a worktree under /tmp included). The "outside" base is
// an EXISTING directory outside the temp dir (the home directory, else the filesystem root); every case is refused before
// creating anything, so nothing is ever written there.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { openDatabase } = require('../../src/store/db');
const { identityOf } = require('../../src/config');
const { withStoreDb } = require('../helpers/harness');

const TMP = identityOf(os.tmpdir());
const outside = (p) => { const r = identityOf(p); return r !== TMP && !r.startsWith(TMP + path.sep); };
const BASE = [os.homedir(), path.parse(TMP).root].find((p) => { try { return fs.statSync(p).isDirectory() && outside(p); } catch (_) { return false; } }) || null;
const skip = BASE ? false : 'no existing directory outside os.tmpdir() to probe';
const probe = () => path.join(BASE, '.ao-test-dir-guard-' + crypto.randomBytes(6).toString('hex'));   // never created

describe('tests can only open stores under the temp dir', () => {
  it('the runner sets NODE_TEST_CONTEXT (the guard\'s signal)', () => assert.ok(process.env.NODE_TEST_CONTEXT));
  it('openDatabase refuses a data dir outside os.tmpdir(), creating nothing', { skip }, () => {
    const p = probe();
    assert.throws(() => openDatabase({ dir: p, instance: 'dev' }), (e) => e.code === 'ETESTDIR');
    assert.equal(fs.existsSync(p), false, 'nothing created');
    assert.throws(() => openDatabase({ dir: path.join(os.homedir(), '.local', 'share', 'agent-office'), instance: 'production' }),
      (e) => e.code === 'ETESTDIR' || !outside(os.homedir()));
  });
  it('a symlink under the temp dir pointing outside it is refused too', { skip }, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guard-'));
    try {
      fs.symlinkSync(BASE, path.join(d, 'link'));   // to an existing outside directory: nothing is created there
      assert.throws(() => openDatabase({ dir: path.join(d, 'link', '.ao-never'), instance: 'test' }), (e) => e.code === 'ETESTDIR');
      assert.equal(fs.existsSync(path.join(BASE, '.ao-never')), false);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('the harness helper refuses a store file outside the temp dir', { skip }, () => {
    const p = probe();
    assert.throws(() => withStoreDb(path.join(p, 'agent-office.sqlite'), () => {}), (e) => e.code === 'ETESTDIR');
    assert.equal(fs.existsSync(p), false);
  });
  it('a temp-dir store still opens', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guard-ok-'));
    try { openDatabase({ dir: path.join(d, 'data'), instance: 'test' }).close(); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
