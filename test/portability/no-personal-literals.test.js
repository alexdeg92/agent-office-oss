'use strict';
/*
 * ADR-001 §12.8: no personal literal in src/**, public/v2/** or the committed tests and fixtures, except for exact,
 * token-specific allowances (personal-literals.allow.json, each with a reason and its owner). The mutation self-test
 * proves the guard can't hide a regression: in a temp copy of the tree, a personal literal injected on an ALREADY
 * ALLOWED line, and one injected into a VM builder, must make this lint AND the foreign-instance test fail.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { scan, check, TOKENS, loadAllow } = require('./personal-literals');

const ROOT = path.resolve(__dirname, '..', '..');
const ALLOW = loadAllow();
const TIMMY = TOKENS[3];
const OWNER = ['al', 'ex'].join('');

describe('portability · no personal literals (ADR-001 §12.8)', () => {
  it('every occurrence has an exact allowance with a reason; no allowance is stale', () => {
    for (const a of ALLOW) assert.ok(a.reason && !/TODO/.test(a.reason) && a.count >= 1, JSON.stringify(a));
    const { unallowed, stale } = check(ROOT, ALLOW);
    assert.deepEqual(unallowed.map((x) => `${x.file}: ${x.token} ×${x.count} (allowed ${x.allowed}): ${x.line.slice(0, 120)}`), []);
    assert.deepEqual(stale.map((a) => `${a.file}: ${a.token}: ${a.line.slice(0, 120)}`), [], 'remove allowances whose occurrence is gone');
  });

  it('allowances are per occurrence: a second token on an allowed line, or a new line, is caught (unit)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lint-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'a.js'), `const who = '${TIMMY}';\n`);
      const allow = scan(tmp).map((x) => Object.assign(x, { reason: 'unit' }));
      assert.deepEqual(check(tmp, allow).unallowed, []);
      fs.writeFileSync(path.join(tmp, 'src', 'a.js'), `const who = '${TIMMY}'; const kpi = '${TIMMY} au repos';\n`);
      assert.equal(check(tmp, allow).unallowed.length, 1, 'same line, one more token');
      fs.writeFileSync(path.join(tmp, 'src', 'a.js'), `const who = '${TIMMY}';\nconst kpi = '${TIMMY} au repos';\n`);
      assert.equal(check(tmp, allow).unallowed.length, 1, 'a new line');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('R20-07: only the two gitignored local roots are skipped; a directory named local anywhere else is scanned', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lint-local-'));
    try {
      const put = (rel) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), `'${TIMMY}'\n`); };
      put('src/local/a.js'); put('public/v2/pages/local/b.js'); put('test/api/local/c.json');
      put('test/fixtures/local/captured.json'); put('test/golden/local/real.json');   // never committed: not scanned
      assert.deepEqual(scan(tmp).map((x) => x.file).sort(), ['public/v2/pages/local/b.js', 'src/local/a.js', 'test/api/local/c.json']);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('mutation self-test: an injected literal fails the lint AND the foreign-instance test', { skip: process.env.AO_IN_COPY === '1' && 'already inside the copy', timeout: 240000 }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mut-'));
    try {
      const copy = path.join(tmp, 'checkout');
      const SKIP = [path.join(ROOT, 'test', 'fixtures', 'local'), path.join(ROOT, 'test', 'golden', 'local'), path.join(ROOT, 'design')];
      fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) && !SKIP.includes(path.resolve(src)) });
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
      // 1. on a line that already has an allowance (v1 legacy): an extra token on it
      const allowed = ALLOW.find((a) => a.file.startsWith('src/') && a.file.endsWith('.js') && a.line.endsWith(';'));
      assert.ok(allowed, 'an allowed src line to mutate');
      const f1 = path.join(copy, allowed.file);
      fs.writeFileSync(f1, fs.readFileSync(f1, 'utf8').replace(allowed.line, `${allowed.line} const _m = '${TIMMY} au repos'; const _a = '${OWNER}';`));
      // 2. in a VM builder: the office KPI says the home agent's name
      const f2 = path.join(copy, 'src', 'api', 'v2', 'vm', 'office.js');
      const office = fs.readFileSync(f2, 'utf8');
      const mutated = office.replace("if (o.role === 'primary') return primaryName || 'Agent principal';", `if (o.role === 'primary') return '${TIMMY} au repos';`);
      assert.notEqual(mutated, office, 'the VM builder mutation applies');
      fs.writeFileSync(f2, mutated);
      const run = (file) => spawnSync(process.execPath, ['--test', file], { cwd: copy, encoding: 'utf8', timeout: 200000,
        env: Object.assign(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))), { AO_IN_COPY: '1', UPDATE_GOLDEN: '' }) });
      const lint = run('test/portability/no-personal-literals.test.js');
      assert.notEqual(lint.status, 0, 'the lint must fail on the mutated tree');
      assert.match(lint.stdout, new RegExp(allowed.file.replace(/[/.]/g, '\\$&')), 'the lint names the mutated allowed line');
      assert.match(lint.stdout, /src\/api\/v2\/vm\/office\.js/, 'the lint names the VM builder');
      const e2e = run('test/portability/foreign-instance.test.js');
      assert.notEqual(e2e.status, 0, 'the foreign-instance test must fail on the mutated tree');
      assert.match(e2e.stdout, /✖/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
