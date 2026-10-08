'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'openclaw');
const run = (args, env = {}) => spawnSync(BIN, args, { env: Object.assign({ PATH: process.env.PATH, FAKE_OC_SCENARIO: 'synthetic-basic' }, env), encoding: 'utf8' });

describe('fake openclaw CLI', () => {
  it('answers skills list with the fixture text (prefix + JSON)', () => {
    const r = run(['skills', 'list', '--agent', 'main', '--json']);
    assert.equal(r.status, 0);
    const i = r.stdout.indexOf('{'); assert.ok(i > 0, 'has a text prefix');
    assert.ok(JSON.parse(r.stdout.slice(i)).skills.length >= 1);
  });
  it('mimics the multi-agent gotcha: no --agent → {ok:false}', () => {
    const r = run(['skills', 'list', '--json']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });
  it('resolves {{FIXTURES_DIR}} in skills info', () => {
    const r = run(['skills', 'info', 'weather', '--agent', 'main', '--json']);
    const info = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.ok(require('fs').existsSync(info.filePath), info.filePath);
  });
  it('logs write commands without doing anything, and can simulate failures', () => {
    assert.equal(run(['cron', 'enable', 'x']).stdout, 'ok\n');
    const f = run(['cron', 'run', 'x'], { FAKE_OC_FAIL: 'cron run' });
    assert.equal(f.status, 1); assert.match(f.stderr, /simulated failure/);
  });
  it('refuses unknown commands', () => { assert.equal(run(['gateway', 'restart']).status, 2); });
  it('the shebang runs when node is only beside the current binary, and the server PATH keeps the fakes first', () => {
    const { testServerPath } = require('../helpers/harness');
    const os = require('os');
    const parts = testServerPath().split(path.delimiter);
    assert.equal(parts[0], path.resolve(__dirname, '..', 'bin'));
    assert.ok(parts.includes(path.dirname(process.execPath)));
    const r = spawnSync(BIN, ['--version'], {
      encoding: 'utf8',
      env: { PATH: [parts[0], path.dirname(process.execPath), '/bin'].join(path.delimiter), HOME: os.tmpdir() },
    });
    assert.equal(r.status, 0, r.stderr || (r.error && r.error.message));
    assert.match(r.stdout, /OpenClaw /);
  });
  it('fake systemctl refuses everything', () => {
    assert.throws(() => execFileSync(path.resolve(__dirname, '..', 'bin', 'systemctl'), ['--user', 'restart', 'openclaw-gateway.service'], { stdio: 'pipe' }));
  });
});
