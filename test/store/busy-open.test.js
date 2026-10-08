'use strict';
// A quick restart: the previous process checkpoints its WAL while closing the store, holding the lock, just as the
// next process opens it. Opening must wait for the lock (busy timeout set BEFORE the WAL pragma) instead of failing
// with "database is locked" (seen as a flaky boot in server-store.test.js; 40/40 failures before the fix in a stress run).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openStore } = require('../../src/store');
const { inspectExisting } = require('../../src/store/db');

const STORE = path.join(__dirname, '..', '..', 'src', 'store');

describe('store · open while the previous process is closing', () => {
  it('waits for the closing checkpoint instead of failing at boot (2 rounds)', async () => {
    for (let round = 0; round < 2; round++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-busy-'));
      try {
        openStore({ dir, instance: 'test', ownerName: 'x', log: () => {} }).close();
        // The "previous process": writes enough to make its closing checkpoint take a while, then closes.
        const prev = spawn(process.execPath, ['-e', `
          const { openStore } = require(${JSON.stringify(STORE)});
          const s = openStore({ dir: ${JSON.stringify(dir)}, instance: 'test', ownerName: 'x', log: () => {} });
          s.db.exec('CREATE TABLE junk (x BLOB)');
          const st = s.db.prepare('INSERT INTO junk VALUES (randomblob(4096))');
          for (let k = 0; k < 800; k++) st.run();
          process.stdout.write('closing\\n');
          s.close();
        `], { stdio: ['ignore', 'pipe', 'inherit'] });
        await new Promise((resolve, reject) => {
          prev.stdout.on('data', (d) => { if (String(d).includes('closing')) resolve(); });
          prev.once('exit', (code) => reject(new Error('previous process exited early: ' + code)));
        });
        const store = openStore({ dir, instance: 'test', ownerName: 'x', log: () => {} });   // threw "database is locked" before the fix
        assert.equal(store.version >= 1, true);
        store.close();
        await new Promise((r) => (prev.exitCode !== null ? r() : prev.once('exit', r)));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

// architect-53: the pre-open inspection (instance and schema, before any mutation) never reads a file another process is
// writing without SQLite's locks. With `immutable=1` it read torn pages during a checkpoint: "database disk image is
// malformed" (72 in 347k reads under this loop; failed once in a full suite). Now 0, and every read is correct.
describe('store · the pre-open inspection under a continuous checkpoint loop', () => {
  it('zero errors and the right facts for 4 s while another process writes and checkpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-inspect-'));
    try {
      openStore({ dir, instance: 'test', ownerName: 'x', log: () => {} }).close();
      const file = path.join(dir, 'agent-office.sqlite');
      const writer = spawn(process.execPath, ['-e', `
        const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 5000 });
        db.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE junk (x BLOB)');
        const ins = db.prepare('INSERT INTO junk VALUES (randomblob(4096))'), del = db.prepare('DELETE FROM junk');
        process.stdout.write('go\\n');
        const end = Date.now() + 4000;
        // write, checkpoint (pages copied into the main file), and every few rounds close and reopen (no -shm meanwhile)
        for (let n = 0; Date.now() < end; n++) {
          db.exec('BEGIN'); for (let k = 0; k < 200; k++) ins.run(); db.exec('COMMIT'); del.run(); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        db.close();`], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((r) => writer.stdout.once('data', r));
      let reads = 0; const errors = {}, wrong = [];
      while (writer.exitCode === null) {
        for (let i = 0; i < 20; i++) {
          try { const f = inspectExisting(file); reads++; if (!f || f.instance !== 'test' || f.version < 9) wrong.push(f); } catch (e) { errors[e.message] = (errors[e.message] || 0) + 1; }
        }
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(reads > 1000, 'enough reads raced the checkpoints: ' + reads);
      assert.deepEqual(errors, {}); assert.deepEqual(wrong, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
