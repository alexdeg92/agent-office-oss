'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectSnapshot } = require('../../src/adapters/agent-team-pm/store-reader');

const selectedRoot = process.env.AO_TEST_TEAM_STORE_COPY || null;
test('selected real-store copy accepts null reviewers and isolates malformed tasks without reading inbox/', { skip: !selectedRoot }, async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-selected-team-copy-'));
  const madeReadOnly = [];
  try {
    for (const directory of ['members', 'tasks']) {
      const sourceDir = path.join(selectedRoot, directory);
      const targetDir = path.join(copy, directory);
      fs.mkdirSync(targetDir, { mode: 0o700 });
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const source = path.join(sourceDir, entry.name), target = path.join(targetDir, entry.name);
        const stat = fs.lstatSync(source);
        assert.equal(stat.isSymbolicLink(), false, 'selected copy only includes regular files');
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o400); madeReadOnly.push(target);
      }
      fs.chmodSync(targetDir, 0o500); madeReadOnly.push(targetDir);
    }
    fs.chmodSync(copy, 0o500); madeReadOnly.push(copy);
    const snapshot = projectSnapshot({ root: copy, now: () => Date.UTC(2026, 9, 11, 12) });
    const sourceTaskCount = fs.readdirSync(path.join(copy, 'tasks')).filter(name => /^T-[A-Za-z0-9][A-Za-z0-9-]{0,39}\.json$/.test(name)).length;
    assert.equal(snapshot.team.status, 'active');
    assert.ok(snapshot.members.length > 0, 'selected stable member records were projected');
    assert.ok(snapshot.tasks.length > 0, 'valid real tasks survive null reviewer verdicts');
    assert.ok(snapshot.reviews.some(review => review.verdict === 'pending'), 'null reviewer verdicts remain pending in the board projection');
    assert.equal(snapshot.tasks.length + snapshot.diagnostics.skippedTaskCount, sourceTaskCount,
      'each regular task file is either projected or counted as skipped');
    assert.equal(Object.hasOwn(snapshot.diagnostics, 'skippedTaskCount'), true);
  } finally {
    for (const p of madeReadOnly.reverse()) { try { fs.chmodSync(p, p === copy || ['members', 'tasks'].includes(path.basename(p)) ? 0o700 : 0o600); } catch {} }
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
