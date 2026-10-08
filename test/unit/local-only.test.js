'use strict';
// R8-03 (S6.2): capture-derived files can't be written outside test/fixtures/local or test/golden/local,
// whatever flag or file name is used. These tests TRY (no live gateway: every attempt is refused before it).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertLocal, LOCAL_FIXTURES, LOCAL_GOLDEN, ROOT } = require('../../scripts/lib/local-roots');
const { goldenFile } = require('../helpers/golden');

const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
// committed files under d (symlinks and local/ excluded: the test's own escape link points back here)
function listing(d, rel = '') {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && !(rel === '' && e.name === 'local'))
    .flatMap((e) => (e.isDirectory() ? listing(path.join(d, e.name), rel + e.name + '/') : [rel + e.name])).sort();
}

describe('local-only capture outputs (R8-03)', () => {
  let createdLocal = false;
  const escape = path.join(LOCAL_FIXTURES, '_escape-test');
  before(() => {
    if (!fs.existsSync(LOCAL_FIXTURES)) { fs.mkdirSync(LOCAL_FIXTURES, { recursive: true }); createdLocal = true; }
    fs.rmSync(escape, { force: true, recursive: true });
    fs.symlinkSync(path.join(ROOT, 'test', 'fixtures'), escape);       // local/_escape-test → the committed fixtures
  });
  after(() => { fs.rmSync(escape, { force: true, recursive: true }); void createdLocal; });   // symlink to a directory; recursive unlinks it and does not follow it. an empty, ignored local/ is left in place (parallel tests share it)

  it('re-redaction refuses every root outside test/fixtures/local and writes nothing', () => {
    const committed = path.join(ROOT, 'test', 'fixtures');
    const before = listing(committed);
    const reviewerExport = path.join(ROOT, 'reviewer-capture-export');
    for (const dir of [committed, reviewerExport, escape, os.tmpdir(), path.join(LOCAL_FIXTURES, '..')]) {
      const r = run('re-redact-fixtures.js', ['--scenario', 'private-run', '--fixtures', dir]);
      assert.equal(r.status, 2, dir + ': ' + r.stderr);
      assert.match(r.stderr, /refusing/);
    }
    assert.equal(fs.existsSync(reviewerExport), false);
    assert.deepEqual(listing(committed), before);
  });

  it('the capture script refuses --out outside test/fixtures/local before connecting to anything', () => {
    for (const out of ['test/fixtures', 'docs', os.tmpdir(), path.relative(ROOT, escape), 'test/fixtures/local/../../fixtures']) {
      const r = run('capture-fixtures.js', ['--label', 'private-run', '--out', out]);
      assert.equal(r.status, 2, out + ': ' + r.stderr);
      assert.match(r.stderr, /refusing/);
    }
  });

  it('assertLocal: names with .., symlinked escapes and the repository are refused; local paths pass', () => {
    for (const bad of [path.join(LOCAL_FIXTURES, '..', 'x.json'), path.join(escape, 'gw', 'x.json'), path.join(ROOT, 'test', 'golden', 'g', 'private-run', 'x.json'), path.join(ROOT, 'x.json')]) {
      assert.throws(() => assertLocal(bad), /refusing/, bad);
    }
    assert.doesNotThrow(() => assertLocal(path.join(LOCAL_FIXTURES, 'gw', 'rpc', 'private-run.json')));
    assert.doesNotThrow(() => assertLocal(path.join(LOCAL_GOLDEN, 'v1-routes', 'private-run', 'x.json')));
  });

  it('goldens route by provenance: only committed synthetic scenarios get committed goldens', () => {
    assert.ok(goldenFile('v1-routes', 'private-run', 'x').startsWith(LOCAL_GOLDEN + path.sep), 'unknown name → local');
    assert.ok(goldenFile('v1-routes', 'capture-20261005', 'x').startsWith(LOCAL_GOLDEN + path.sep));
    assert.ok(!goldenFile('v1-routes', 'synthetic-basic', 'x').startsWith(LOCAL_GOLDEN));
  });
});
