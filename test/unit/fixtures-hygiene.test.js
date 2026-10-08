'use strict';
// Every committed fixture must be a well-formed envelope, every scenario must reference existing
// files, and nothing in test/fixtures may look like real data (same scanner as the capture script).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FIXTURES_DIR, listScenarios } = require('../helpers/scenario');
const { scanLeaks } = require('../../scripts/lib/fixture-redact');

// Parallel tests create and remove throwaway folders under local/: a file or folder that vanishes mid-walk is skipped.
function walk(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter((e) => !e.isSymbolicLink()).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const readIfThere = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
const all = fs.existsSync(FIXTURES_DIR) ? walk(FIXTURES_DIR) : [];

describe('fixtures hygiene', () => {
  it('contain no real-looking ids, emails, tokens, keys or home paths', () => {
    const leaks = all.flatMap((f) => scanLeaks(readIfThere(f), path.relative(FIXTURES_DIR, f)));
    assert.deepEqual(leaks, []);
  });

  it('are well-formed envelopes', () => {
    for (const f of all.filter((x) => x.endsWith('.json') && !/[/\\](scenarios|config)[/\\]/.test(x))) {
      const text = readIfThere(f); if (!text) continue;
      const j = JSON.parse(text);
      const rel = path.relative(FIXTURES_DIR, f);
      assert.ok(j.$fixture && typeof j.$fixture.channel === 'string' && typeof j.$fixture.source === 'string', rel + ': $fixture');
      assert.ok(['json', 'text', 'error'].includes(j.body && j.body.kind), rel + ': body.kind');
    }
  });

  it('scenarios reference existing files', () => {
    for (const sc of listScenarios()) {
      const refs = [];
      const collect = (v) => { if (typeof v === 'string' && /\.(json|md)$/.test(v)) refs.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
      collect({ config: sc.config, rpc: sc.rpc, events: sc.events, cli: sc.cli, host: sc.host });
      for (const r of refs) assert.ok(fs.existsSync(path.join(sc.fixturesDir, r)), `${sc.name}: missing ${r}`);
      assert.ok(Number.isInteger(sc.now) && sc.now > 1.5e12, `${sc.name}: now`);
    }
  });
});

// PM decision on review-06: captured real-data fixtures and their goldens are local-only. Everything git
// would commit (tracked files + untracked files not ignored) must be free of capture-derived files.
describe('committed tree: no capture-derived file', () => {
  const { execFileSync } = require('child_process');
  const ROOT = path.resolve(__dirname, '..', '..');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  let inGit = true; try { git('rev-parse', '--is-inside-work-tree'); } catch (_) { inGit = false; }

  it('test/fixtures/local/ and test/golden/local/ are gitignored', { skip: !inGit && 'not a git checkout' }, () => {
    for (const p of ['test/fixtures/local/scenarios/x.json', 'test/golden/local/v1-routes/x/y.json']) {
      assert.doesNotThrow(() => git('check-ignore', '-q', p), p + ' must be ignored');
    }
  });

  it('no committable file is a capture, a capture golden, or carries capture provenance (whole tree, R8-03)', { skip: !inGit && 'not a git checkout' }, () => {
    const files = (git('ls-files', '-z') + git('ls-files', '-z', '--others', '--exclude-standard')).split('\0').filter(Boolean);
    const synthetic = new Set(fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'scenarios')).filter((f) => f.endsWith('.json'))
      .filter((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'scenarios', f), 'utf8')).origin === 'synthetic').map((f) => f.slice(0, -5)));
    const bad = [];
    for (const f of files) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      if (/^test\/(fixtures|golden)\/local\//.test(f)) { bad.push(f + ' (local dir)'); continue; }
      if (/(^|\/)capture-\d/.test(f)) { bad.push(f + ' (capture name)'); continue; }
      // a committed golden must belong to a committed synthetic scenario (provenance, not the name)
      const g = f.match(/^test\/golden\/[^/]+\/([^/]+)\//);
      if (g && !synthetic.has(g[1])) { bad.push(f + ' (golden of a non-synthetic scenario)'); continue; }
      if (f.endsWith('.json') && !f.startsWith('node_modules/')) {
        let j; try { j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { continue; }
        if (j && ((j.$fixture && j.$fixture.origin === 'capture') || j.origin === 'capture')) bad.push(f + ' (origin: capture)');
      }
    }
    assert.deepEqual(bad, []);
  });

});
