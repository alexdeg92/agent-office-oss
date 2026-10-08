'use strict';
// architect-56 · `agent-office integrations status|install|uninstall` through the real bin and the fake openclaw CLI.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'packaging', 'bin', 'agent-office.js');
const ORIGINAL = '# AGENTS\n\nRègles maison.\n';
let home, ws, ws2;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-integ-cli-'));
  ws = path.join(home, 'ws-main'); ws2 = path.join(home, 'ws-other');
  for (const w of [ws, ws2]) { fs.mkdirSync(w); fs.writeFileSync(path.join(w, 'AGENTS.md'), ORIGINAL); }
});
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = (extra = {}) => Object.assign({ PATH: process.env.PATH, HOME: home, AO_ENV: 'test', OC_BIN: path.join(ROOT, 'test', 'bin', 'openclaw'),
  FAKE_OC_AGENTS: JSON.stringify([{ id: 'main', workspace: ws, isDefault: true }, { id: 'other', workspace: ws2, isDefault: false }]) }, extra);
const cli = (args, extra) => spawnSync(process.execPath, ['--', BIN, 'integrations', ...args], { encoding: 'utf8', env: env(extra) });
const json = (r) => JSON.parse(r.stdout);

describe('agent-office integrations', () => {
  it('status: the primary agent by default; absent → exit 1 (something to do); FR by default, EN on request', () => {
    const r = cli(['status']);
    assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /étiquette projet/); assert.match(r.stdout, /- main: absente/);
    assert.doesNotMatch(r.stdout, /other/);
    assert.match(cli(['status', '--lang', 'en']).stdout, /- main: absent/);
  });
  it('install --dry-run writes nothing; install writes; a second install has nothing to do; --json is machine-readable', () => {
    const dry = cli(['install', '--dry-run']);
    assert.equal(dry.status, 0); assert.match(dry.stdout, /simulation/); assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), ORIGINAL);
    const r = json(cli(['install', '--json']));
    assert.deepEqual([r.exitCode, r.agents[0].agentId, r.agents[0].status, r.agents[0].done, r.agents[0].execPolicy], [0, 'main', 'installed', ['skill', 'block'], 'full']);
    assert.match(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /agent-office:projet:debut/);
    assert.deepEqual(json(cli(['install', '--json'])).agents[0].done, []);
    assert.equal(cli(['status']).status, 0, 'installed → exit 0');
  });
  it('--agent and --all; an unknown agent is a usage error (64)', () => {
    assert.equal(json(cli(['status', '--all', '--json'])).agents.length, 2);
    assert.equal(json(cli(['status', '--agent', 'other', '--json'])).agents[0].status, 'absent');
    assert.equal(cli(['status', '--agent', 'nobody']).status, 64);
  });
  it('uninstall removes it all: AGENTS.md byte-identical to before, the skill gone', () => {
    const r = cli(['uninstall']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), ORIGINAL);
    assert.ok(!fs.existsSync(path.join(ws, 'skills', 'projet')));
  });
  it('opt-out refuses install (exit 1); a read-only instance never writes; another adapter has nothing here', () => {
    assert.equal(cli(['install'], { AO_INTEGRATIONS: 'none' }).status, 1);
    const ro = cli(['install'], { PORTAL_READONLY: '1' });
    assert.equal(ro.status, 1); assert.match(ro.stdout, /lecture seule/);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), ORIGINAL);
    assert.match(cli(['status'], { AO_RUNTIME: 'demo' }).stdout, /propre à OpenClaw/);
  });
  it('the exec policy is reported when it would prompt (and never changed)', () => {
    cli(['install']);
    const r = cli(['status', '--lang', 'en'], { FAKE_OC_EXEC_MODE: 'allowlist' });
    assert.match(r.stdout, /asks for approval/);
    cli(['uninstall']);
  });
});
