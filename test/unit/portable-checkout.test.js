'use strict';
// The suite must pass from any checkout location (worktree, staging snapshot, CI). Copy the tree to
// a temp dir and run the golden-based engine tests and a real-server suite there (v1's characterisation until S16);
// also forbid absolute paths in goldens.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { normalisePaths } = require('../helpers/golden');

const ROOT = path.resolve(__dirname, '..', '..');

describe('portable checkout', () => {
  it('goldens contain no absolute paths', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(ROOT, 'test', 'golden'))) {
      const t = fs.readFileSync(f, 'utf8');
      assert.ok(!normalisePaths(t).includes('{{ROOT}}') && !/\/home\/[a-z_][a-z0-9_-]*\//.test(t), path.relative(ROOT, f));
    }
  });

  it('golden root substitution respects path component boundaries', () => {
    assert.equal(normalisePaths(ROOT), '{{ROOT}}');
    assert.equal(normalisePaths(ROOT + path.sep + 'test' + path.sep + 'file'), '{{ROOT}}' + path.sep + 'test' + path.sep + 'file');
    assert.equal(normalisePaths(ROOT + 'space-atlas'), ROOT + 'space-atlas');
  });

  it('the engine goldens and the real server (v3) pass from a copy in a temp dir', { skip: process.env.AO_IN_COPY === '1' && 'already inside the copy' }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copy-'));
    try {
      const copy = path.join(tmp, 'checkout');
      // Skipped: .git, node_modules, and the gitignored local-only roots (captured real data never leaves the checkout;
      // parallel tests also create and delete transient entries there, e.g. local/_escape-test and local/_dryrun-*).
      const LOCAL_ONLY = [path.join(ROOT, 'test', 'fixtures', 'local'), path.join(ROOT, 'test', 'golden', 'local')];
      fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) && !LOCAL_ONLY.includes(path.resolve(src)) });
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
      const r = spawnSync(process.execPath, ['--test', 'test/engine/canonical-s4.test.js', 'test/engine/canonical-sessions.test.js', 'test/engine/shadow.test.js', 'test/engine/session-kind.test.js', 'test/api/v3.test.js'], {
        // NODE_TEST_CONTEXT would make the child report to this runner instead of printing a summary
        cwd: copy, encoding: 'utf8', timeout: 120000, env: Object.assign(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))), { AO_IN_COPY: '1', UPDATE_GOLDEN: '' }),
      });
      assert.equal(r.status, 0, (r.stdout || '').split('\n').filter((l) => /✖|Error|mismatch/.test(l)).slice(0, 20).join('\n'));
      assert.match(r.stdout, /ℹ fail 0/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
