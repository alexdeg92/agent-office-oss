'use strict';
// A test that writes into a running server's store must wait on the server's write lock, not fail (flaky foreign-instance
// token test, PM after 593f970). Deterministic: another PROCESS holds a real write lock for 300 ms.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../src/store/db');
const { createTokensRepo } = require('../../src/store/repos/tokens');
const { withStoreDb } = require('../helpers/harness');

function holdLock(file, ms) {   // → resolves once the child holds BEGIN IMMEDIATE; it commits after `ms`
  const child = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(file)});
db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms});db.exec('COMMIT');db.close();`]);
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

describe('a test write into the live store waits for the server\'s lock', () => {
  it('without a busy timeout it fails (the flake); withStoreDb waits and succeeds', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-busy-'));
    try {
      openDatabase({ dir: d, instance: 'test' }).close();
      const file = path.join(d, 'agent-office.sqlite');
      let child = await holdLock(file, 300);
      const bare = new DatabaseSync(file);
      try { assert.throws(() => createTokensRepo(bare).create({ agentId: 'atlas' }), /database is locked/); } finally { bare.close(); }
      await new Promise((r) => child.once('exit', r));
      child = await holdLock(file, 300);
      const t0 = Date.now();
      const token = withStoreDb(file, (db) => createTokensRepo(db).create({ agentId: 'atlas' }).token);
      assert.ok(token && Date.now() - t0 >= 150, 'it waited for the lock, then wrote');
      await new Promise((r) => child.once('exit', r));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
