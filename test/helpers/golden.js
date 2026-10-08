'use strict';
/*
 * Golden files: test/golden/<group>/<scenario>/<name>.json, or test/golden/local/<group>/<scenario>/ for
 * a captured (local-only, gitignored) scenario: goldens derived from real data are never committed either.
 *   UPDATE_GOLDEN=1 npm test     → (re)writes goldens; review the git diff before committing
 *   otherwise                    → a missing golden fails with a hint, a different one fails with a diff
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const GOLDEN_DIR = path.resolve(__dirname, '..', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function slug(s) { return String(s).replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'root'; }

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const LOCAL_FIXTURES = path.join(FIXTURES, 'local');
// R8-03: provenance decides, not the file name. A golden is committed ONLY for a scenario whose manifest is in the
// committed test/fixtures/scenarios/ with origin 'synthetic'; anything else (a capture, an unknown or renamed
// scenario) goes to test/golden/local/, asserted local and git-ignored before writing.
const isCommittedSynthetic = (scenario) => {
  try { return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios', scenario + '.json'), 'utf8')).origin === 'synthetic'; } catch (_) { return false; }
};
const isLocal = (scenario) => !isCommittedSynthetic(scenario);
function goldenFile(group, scenario, name) { return path.join(GOLDEN_DIR, isLocal(scenario) ? 'local' : '', group, scenario, slug(name) + '.json'); }

// Absolute paths depend on where the checkout lives (worktree, staging snapshot, temp copy):
// replace them with placeholders so goldens are portable.
function normalisePaths(value) {
  const fix = (s) => s.split(LOCAL_FIXTURES).join('{{FIXTURES_DIR}}').split(FIXTURES).join('{{FIXTURES_DIR}}').split(ROOT).join('{{ROOT}}');
  if (typeof value === 'string') return fix(value);
  if (Array.isArray(value)) return value.map(normalisePaths);
  if (value && typeof value === 'object') { const o = {}; for (const [k, v] of Object.entries(value)) o[fix(k)] = normalisePaths(v); return o; }
  return value;
}

function matchGolden(group, scenario, name, actualRaw) {
  const actual = normalisePaths(actualRaw);
  const file = goldenFile(group, scenario, name);
  const text = JSON.stringify(actual, null, 2) + '\n';
  if (UPDATE) {
    if (isLocal(scenario)) require('../../scripts/lib/local-roots').assertLocal(file);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return;
  }
  if (!fs.existsSync(file)) assert.fail(`missing golden ${path.relative(process.cwd(), file)}; run UPDATE_GOLDEN=1 npm test and review the diff`);
  assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')), `golden mismatch: ${path.relative(process.cwd(), file)}`);
}

module.exports = { matchGolden, goldenFile, normalisePaths, GOLDEN_DIR, UPDATE };
