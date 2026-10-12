'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const safeFs = require('../../src/ops/safe-fs');

async function fixture(fn) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-safe-read-many-'));
  try { return await fn(root); } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}
function snapshots(root, nested) {
  return [{ root, parents: safeFs.capture(root).chain }, { root: nested, parents: safeFs.capture(nested).chain }];
}

test('readMany reuses pinned parent checks, returns bounded byte counts, and does not mutate files', async () => fixture(async root => {
  const tasks = path.join(root, 'tasks'); await fs.promises.mkdir(tasks);
  const a = path.join(tasks, 'T-0001.json'), b = path.join(tasks, 'T-0002.json');
  await fs.promises.writeFile(a, '{"id":"T-0001"}', { mode: 0o600 });
  await fs.promises.writeFile(b, '{"id":"T-0002"}', { mode: 0o600 });
  const before = [fs.statSync(a).mtimeMs, fs.statSync(b).mtimeMs];
  const result = safeFs.readMany([{ file: a, maxBytes: 128 }, { file: b, maxBytes: 128 }],
    { roots: [root], rootSnapshots: snapshots(root, tasks), maxBytesTotal: 256 });
  assert.deepEqual(result.map(row => row.text), ['{"id":"T-0001"}', '{"id":"T-0002"}']);
  assert.deepEqual(result.map(row => row.bytes), [Buffer.byteLength(result[0].text), Buffer.byteLength(result[1].text)]);
  assert.deepEqual([fs.statSync(a).mtimeMs, fs.statSync(b).mtimeMs], before);
  assert.deepEqual(safeFs.readMany([], { roots: [root], maxBytesTotal: 0 }), []);
}));

test('readMany rejects symlink leaves, path escapes, and aggregate byte overflow', async () => fixture(async root => {
  const tasks = path.join(root, 'tasks'), outside = path.join(root, 'outside');
  await fs.promises.mkdir(tasks); await fs.promises.mkdir(outside);
  const secret = path.join(outside, 'secret.json'); await fs.promises.writeFile(secret, 'synthetic outside canary');
  const linked = path.join(tasks, 'T-0001.json'); await fs.promises.symlink(secret, linked);
  assert.throws(() => safeFs.readMany([{ file: linked, maxBytes: 128 }], { roots: [root], rootSnapshots: snapshots(root, tasks), maxBytesTotal: 128 }),
    e => e.code === 'EUNSAFEPATH');
  assert.throws(() => safeFs.readMany([{ file: secret, maxBytes: 128 }], { roots: [tasks], rootSnapshots: snapshots(root, tasks), maxBytesTotal: 128 }),
    e => e.code === 'EUNSAFEPATH');
  await fs.promises.unlink(linked); await fs.promises.writeFile(linked, 'too many bytes');
  assert.throws(() => safeFs.readMany([{ file: linked, maxBytes: 128 }], { roots: [root], rootSnapshots: snapshots(root, tasks), maxBytesTotal: 2 }),
    e => e.code === 'EFSBOUND');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic outside canary');
}));
