'use strict';
// T-0073 P0 (2026-10-11): a bare `node --test` ran test/helpers/detection-worker-child.cjs directly with the REAL HOME
// and overwrote ~/.openclaw/openclaw.json. Every non-test script under test/ must refuse to run as a process unless its
// parent gave it a scratch HOME (test/helpers/scratch-home.cjs). This test runs each one directly, the way a bare
// `node --test` would, against a real-looking fake home, and proves it exits non-zero without writing anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { scratchHomeOk } = require('../helpers/scratch-home.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = /\.(c|m)?js$/, TEST = /\.test\.(c|m)?js$/;
function nonTestScripts(dir = path.join(ROOT, 'test'), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') nonTestScripts(p, out); }
    else if (SCRIPT.test(e.name) && !TEST.test(e.name)) out.push(p);
  }
  return out.sort();
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir); return out;
}
const gitStatus = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).stdout;
function fakeHome(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-real-looking-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home', 'operator');
  for (const [rel, body] of [['.openclaw/openclaw.json', '{"sentinel":"real-looking config, must stay untouched"}\n'], ['.claude/settings.json', '{}\n'], ['.codex/config.toml', '# sentinel\n']]) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), body);
  }
  return home;
}
const run = (file, env) => spawnSync(process.execPath, [file], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000 });

// Browser-evaluation snippets (run inside test/office/harness.html, never by Node): Node cannot even parse them
// (top-level await outside a module), so they execute nothing. Listed explicitly so a syntax error never passes for a guard.
const BROWSER_ONLY = new Set(['test/office/perf/frame-budget.js', 'test/office/perf/frame-budget-crowd.js']);
const GUARD_CALL = /scratch-home\.cjs['"]\)?\.(requireScratchHome|refuseEntry)\(|scratchHome\.(requireScratchHome|refuseEntry)\(|^refuseEntry\(__filename\);$/m;

test('every non-test script under test/ calls the scratch-HOME guard (static)', () => {
  const missing = nonTestScripts().map(f => path.relative(ROOT, f)).filter(rel => !BROWSER_ONLY.has(rel) && !GUARD_CALL.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(missing, [], 'scripts without a guard call');
});

test('every non-test script under test/ refuses to run directly against a real-looking HOME: exit 78, its own refusal line, nothing written', (t) => {
  const home = fakeHome(t), before = snapshot(home), repo = gitStatus(), scripts = nonTestScripts();
  assert.ok(scripts.length >= 30, 'the scan finds the helper scripts');
  for (const rel of BROWSER_ONLY) assert.ok(scripts.includes(path.join(ROOT, rel)), rel + ' still exists (update BROWSER_ONLY)');
  const wrong = [];
  for (const file of scripts) {
    const rel = path.relative(ROOT, file), r = run(file, { HOME: home });
    if (BROWSER_ONLY.has(rel)) {
      // parse failure before any statement runs: exit 1 with a SyntaxError about the top-level await
      if (r.status !== 1 || !/SyntaxError/.test(r.stderr) || !/await/.test(r.stderr)) wrong.push(`${rel}: expected a parse-time SyntaxError, got status ${r.status}`);
    } else if (r.status !== 78 || !r.stderr.includes(`refusing to run ${rel}:`)) {
      wrong.push(`${rel}: status ${r.status}${r.error ? ' ' + r.error.code : ''}, stderr ${JSON.stringify(r.stderr.slice(0, 160))}`);
    }
  }
  assert.deepEqual(wrong, [], 'scripts that did not refuse through the guard');
  assert.deepEqual(snapshot(home), before, 'nothing was written under the real-looking HOME');
  assert.equal(gitStatus(), repo, 'nothing was written into the repository');
});

test('spawned children refuse a missing, mismatched or non-temporary scratch marker; accept their parent\'s scratch HOME', (t) => {
  const home = fakeHome(t), before = snapshot(home);
  const child = path.join(ROOT, 'test/helpers/detection-worker-child.cjs');
  // a HOME outside the temp directory (inside the checkout) is refused even with a matching marker — unless the checkout
  // itself lives under the temp directory (an isolated archive copy), where that case cannot be built
  const repoInTmp = fs.realpathSync(ROOT).startsWith(fs.realpathSync(os.tmpdir()) + path.sep);
  const outside = fs.mkdtempSync(path.join(ROOT, '.not-tmp-home-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const env of [{ HOME: home }, { HOME: home, AO_TEST_SCRATCH_HOME: home + '-other' }, ...(repoInTmp ? [] : [{ HOME: outside, AO_TEST_SCRATCH_HOME: outside }])]) {
    const r = run(child, env);
    assert.equal(r.status, 78, JSON.stringify({ env, stderr: r.stderr }));
    assert.match(r.stderr, /refusing to run test\/helpers\/detection-worker-child\.cjs/);
  }
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written in a non-temporary HOME');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-scratch-')); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.equal(scratchHomeOk({ HOME: scratch, AO_TEST_SCRATCH_HOME: scratch }), true);
  assert.equal(scratchHomeOk({ HOME: os.tmpdir(), AO_TEST_SCRATCH_HOME: os.tmpdir() }), false, 'the temp root itself is not a scratch home');
  { const account = os.userInfo().homedir; assert.equal(scratchHomeOk({ HOME: account, AO_TEST_SCRATCH_HOME: account }), false, 'never the account home'); }
});
