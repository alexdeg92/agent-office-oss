'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commands, scanFeatureFlags, buildProjectVM } = require('../../src/projects');
const { parseFlagText, MAX_FLAG_BYTES } = require('../../src/projects/flags');
const { repoFromPayloads } = require('../../src/projects/sources/github');
const { AT, repository } = require('./helpers');

const repoJson = require('./fixtures/github/repo.json');
const commitsJson = require('./fixtures/github/commits.json');
const runsSuccess = require('./fixtures/github/runs-success.json');

const FIXTURE = path.join(__dirname, 'fixtures', 'flags');
const SECRETS = [
  'FLAG_SECRET_DO_NOT_STORE',
  'db-secret-value',
  'ghp_should_not_store',
  'do-not-keep',
  'config-secret-value',
  'unleash-secret-value',
  'secret-state',
  'ld-variation-secret',
  'symlink-secret-value',
  'dir-symlink-secret',
];

function tracingFs() {
  const calls = [];
  const wrap = (op, fn) => (p) => {
    calls.push({ op, p: String(p) });
    return fn(p);
  };
  return {
    calls,
    lstat: wrap('lstat', (p) => fs.lstatSync(p)),
    realpath: wrap('realpath', (p) => fs.realpathSync(p)),
    readdir: wrap('readdir', (p) => fs.readdirSync(p)),
    readFile: wrap('read', (p) => fs.readFileSync(p, 'utf8')),
  };
}

function link(repo, sources) {
  const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
  let revision = 1;
  for (const source of sources) {
    commands.linkSource(repo, {
      id: project.id, expectedRevision: revision, actor: 'owner', at: AT, source,
    });
    revision += 1;
  }
  return project.id;
}

function flagEvents(repo, id) {
  return repo.getHistory(id, { limit: 100 }).events.filter((event) => event.kind === 'flags-updated');
}

function statesOf(flags) {
  return Object.fromEntries(flags.map((flag) => [flag.key, flag.state]));
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
}

function relFromApi(api) {
  const pathOnly = String(api).split('?')[0];
  const marker = '/contents/';
  const at = pathOnly.indexOf(marker);
  if (at < 0) return '';
  return pathOnly.slice(at + marker.length).split('/').map((part) => decodeURIComponent(part)).join('/');
}

function githubExec(state) {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv.slice());
    const api = argv[2];
    if (state.mode === 'rate') return { code: 1, stdout: '', stderr: 'HTTP 429 rate limit exceeded' };
    const rel = relFromApi(api);
    if (state.mode === 'bad' && rel === 'flags.json') {
      const content = Buffer.from('{', 'utf8').toString('base64');
      return { code: 0, stdout: JSON.stringify({ type: 'file', encoding: 'base64', content }), stderr: '' };
    }
    if (rel === 'config') {
      return {
        code: 0,
        stdout: JSON.stringify([
          { type: 'file', name: 'app.json', path: 'config/app.json' },
          { type: 'file', name: 'secrets.json', path: 'config/secrets.json' },
          { type: 'symlink', name: 'link.json', path: 'config/link.json' },
          { type: 'dir', name: 'nested', path: 'config/nested' },
        ]),
        stderr: '',
      };
    }
    if (!Object.prototype.hasOwnProperty.call(state.files, rel)) {
      return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    const raw = Buffer.from(state.files[rel], 'utf8').toString('base64');
    const wrapped = raw.replace(/(.{8})/g, '$1\n');
    return {
      code: 0,
      stdout: `noise\n${JSON.stringify({ type: 'file', encoding: 'base64', content: wrapped })}`,
      stderr: '',
    };
  };
  return { exec, calls };
}

describe('feature flag scan', () => {
  it('stores booleans and drops every other value', () => {
    const json = parseFlagText('flags.json', '{"a":"true","b":true,"c":false,"d":1}', AT);
    assert.deepEqual(statesOf(json), { a: 'unknown', b: 'on', c: 'off', d: 'unknown' });
    for (const flag of json) {
      assert.deepEqual(Object.keys(flag).sort(), ['detectedAt', 'key', 'line', 'source', 'state']);
    }
    assert.deepEqual(parseFlagText('.env', 'FEATURE_LEAKED=true\nAPI_TOKEN=FLAG_SECRET_DO_NOT_STORE\n', AT), []);
    assert.equal(parseFlagText('.env.local', 'FEATURE_A=true\n', AT).length, 0);
    assert.deepEqual(
      statesOf(parseFlagText('.env.example', 'FEATURE_A=yes\nENABLE_B=on\nFF_C=TRUE # note\n', AT)),
      { FEATURE_A: 'unknown', ENABLE_B: 'unknown', FF_C: 'on' },
    );
    assert.equal(parseFlagText('.env.example', 'FF_C=true # note\n', AT)[0].line, 1);
    assert.deepEqual(parseFlagText('unleash.json', '{"apiKey":"unleash-secret-value"}', AT), []);
    assert.equal(parseFlagText('features.json', '{"plain":false}', AT)[0].state, 'off');
    assert.equal(parseFlagText('feature-flags.json', '{"featureFlags":{"nested":true},"other":false}', AT)[0].key, 'nested');
    assert.throws(() => parseFlagText('flags.json', '{', AT), (err) => err.code === 'flag-parse');
  });

  it('reads the fixture catalog and never opens a secret file', async () => {
    const envPath = path.join(FIXTURE, 'demo', '.env');
    fs.writeFileSync(envPath, 'FEATURE_LEAKED=true\nAPI_TOKEN=FLAG_SECRET_DO_NOT_STORE\n');
    const traced = tracingFs();
    const repo = repository();
    const id = link(repo, [{ kind: 'workspace', ref: { path: 'demo' } }]);
    try {
      const result = await scanFeatureFlags(repo, { id, root: FIXTURE, fs: traced, at: AT + 5000 });
      assert.equal(result.wrote, true);
      assert.deepEqual(statesOf(result.flags), {
        ENABLE_BETA: 'unknown',
        FEATURE_BILLING: 'on',
        FEATURE_NUM: 'unknown',
        FEATURE_OFF: 'off',
        FEATURE_QUOTED: 'on',
        FF_SEARCH: 'off',
        beta: 'unknown',
        billing: 'on',
        configFlag: 'off',
        count: 'unknown',
        darkMode: 'on',
        growthFlag: 'off',
        ldFileFlag: 'off',
        ldFlag: 'on',
        ldText: 'unknown',
        ldValue: 'off',
        note: 'unknown',
        ofFlag: 'on',
        ofText: 'unknown',
        search: 'off',
        smithFlag: 'off',
        textFlag: 'unknown',
        token: 'unknown',
        unleashFlag: 'on',
      });
      const billing = result.flags.find((flag) => flag.key === 'FEATURE_BILLING');
      assert.equal(billing.source, 'demo/.env.example');
      assert.equal(billing.line, 3);
      assert.equal(billing.detectedAt, AT + 5000);
      const jsonFlag = result.flags.find((flag) => flag.key === 'billing');
      assert.equal(jsonFlag.source, 'demo/flags.json');
      assert.equal(jsonFlag.line, null);
      const project = repo.getProject(id);
      const stored = project.flags.find((flag) => flag.key === 'billing');
      assert.equal(stored.kind, 'feature');
      assert.equal(stored.state, 'on');
      assert.equal(stored.foundIn.path, 'demo/flags.json');
      assert.equal(stored.foundIn.line, null);
      assert.equal(stored.scannedAt, AT + 5000);
      assert.equal(project.lastActivityAt, AT);
      const events = flagEvents(repo, id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].actor, { kind: 'system', component: 'engine' });
      assert.deepEqual(events[0].flags.map((flag) => flag.key), result.flags.map((flag) => flag.key));
      assertNoSecrets(result.flags);
      assertNoSecrets(events);
      assert.equal(JSON.stringify(project.flags).includes('FEATURE_LEAKED'), false);
      assert.equal(JSON.stringify(project.flags).includes('hiddenFlag'), false);
      const reads = traced.calls.filter((call) => call.op === 'read').map((call) => call.p);
      assert.equal(reads.some((p) => p.endsWith(`${path.sep}.env`)), false);
      assert.equal(reads.some((p) => p.endsWith(`${path.sep}secrets.json`)), false);
      assert.equal(reads.some((p) => p.endsWith(`${path.sep}.env.example`)), true);
      const vm = buildProjectVM(project, [], { persons: repo.listPersons() });
      assert.equal(vm.flags.find((flag) => flag.key === 'billing').kind, 'feature');
      assert.equal(vm.flags.find((flag) => flag.key === 'billing').state, 'on');
    } finally {
      fs.rmSync(envPath, { force: true });
    }
  });

  it('does not follow a symlink out of the workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-flags-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-flags-out-'));
    const traced = tracingFs();
    try {
      fs.mkdirSync(path.join(root, 'proj'));
      fs.writeFileSync(path.join(root, 'proj', '.env.example'), 'FEATURE_OK=true\n');
      fs.writeFileSync(path.join(outside, 'leak.json'), JSON.stringify({ evil: true, leak: 'symlink-secret-value' }));
      fs.symlinkSync(path.join(outside, 'leak.json'), path.join(root, 'proj', 'flags.json'));
      fs.mkdirSync(path.join(outside, 'cfg'));
      fs.writeFileSync(
        path.join(outside, 'cfg', 'app.json'),
        JSON.stringify({ featureFlags: { escaped: true }, password: 'dir-symlink-secret' }),
      );
      fs.symlinkSync(path.join(outside, 'cfg'), path.join(root, 'proj', 'config'));
      const repo = repository();
      const id = link(repo, [{ kind: 'workspace', ref: { path: 'proj' } }]);
      const result = await scanFeatureFlags(repo, { id, root, fs: traced, at: AT });
      assert.equal(result.wrote, true);
      assert.deepEqual(statesOf(result.flags), { FEATURE_OK: 'on' });
      assertNoSecrets(result.flags);
      for (const call of traced.calls) assert.equal(call.p.startsWith(outside), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prefers a boolean over unknown and keeps the earlier boolean', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-flags-pref-'));
    try {
      fs.mkdirSync(path.join(root, 'proj'));
      fs.writeFileSync(path.join(root, 'proj', 'flags.json'), JSON.stringify({ locked: true, shared: 'rollout' }));
      fs.writeFileSync(path.join(root, 'proj', 'package.json'), JSON.stringify({
        featureFlags: { locked: false, shared: true },
      }));
      const repo = repository();
      const id = link(repo, [{ kind: 'workspace', ref: { path: 'proj' } }]);
      const result = await scanFeatureFlags(repo, { id, root, fs: tracingFs(), at: AT });
      assert.deepEqual(statesOf(result.flags), { locked: 'on', shared: 'on' });
      assert.equal(JSON.stringify(result.flags).includes('rollout'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a flag file over 256 KiB and refuses invalid JSON without clearing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-flags-size-'));
    try {
      const dir = path.join(root, 'proj');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.env.example'), 'FEATURE_OK=true\n');
      fs.writeFileSync(path.join(dir, 'flags.json'), `{"keep":true,"pad":"${'x'.repeat(MAX_FLAG_BYTES)}"}`);
      const repo = repository();
      const id = link(repo, [{ kind: 'workspace', ref: { path: 'proj' } }]);
      const first = await scanFeatureFlags(repo, { id, root, fs: tracingFs(), at: AT });
      assert.deepEqual(statesOf(first.flags), { FEATURE_OK: 'on' });
      fs.writeFileSync(path.join(dir, 'flags.json'), '{');
      const second = await scanFeatureFlags(repo, { id, root, fs: tracingFs(), at: AT + 1 });
      assert.equal(second.wrote, false);
      assert.equal(repo.getProject(id).flags.find((flag) => flag.key === 'FEATURE_OK').state, 'on');
      assert.equal(flagEvents(repo, id).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans a GitHub repo through injected gh and records flags-updated', async () => {
    const state = {
      mode: 'ok',
      files: {
        '.env.example': 'FEATURE_BILLING=true\n',
        'flags.json': '{"billing":false,"beta":"rollout"}\n',
        '.env': 'FEATURE_LEAKED=true\nAPI_TOKEN=FLAG_SECRET_DO_NOT_STORE\n',
        'config/app.json': '{"featureFlags":{"configFlag":true}}',
        'config/secrets.json': '{"featureFlags":{"hiddenFlag":true},"password":"config-secret-value"}',
      },
    };
    const { exec, calls } = githubExec(state);
    const repo = repository();
    const id = link(repo, [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } }]);
    const built = repoFromPayloads({ meta: repoJson, commits: commitsJson, runs: runsSuccess, fetchedAt: AT });
    repo.putRepoCache({ owner: 'alexdeg92', name: 'demo', repo: built.repo, authors: built.authors });
    const result = await scanFeatureFlags(repo, { id, exec, at: AT + 5000 });
    assert.equal(result.wrote, true);
    assert.deepEqual(statesOf(result.flags), {
      FEATURE_BILLING: 'on',
      beta: 'unknown',
      billing: 'off',
      configFlag: 'on',
    });
    assert.equal(result.flags.find((flag) => flag.key === 'billing').source, 'alexdeg92/demo/flags.json');
    assertNoSecrets(result.flags);
    assert.equal(repo.getProject(id).lastActivityAt, AT);
    const events = flagEvents(repo, id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].actor, { kind: 'system', component: 'engine' });
    assert.deepEqual(events[0].flags, [
      { key: 'FEATURE_BILLING', state: 'on' },
      { key: 'beta', state: 'unknown' },
      { key: 'billing', state: 'off' },
      { key: 'configFlag', state: 'on' },
    ]);
    assert.equal(calls.length > 0, true);
    for (const argv of calls) {
      assert.deepEqual(argv.slice(0, 2), ['gh', 'api']);
      assert.equal(argv[2].includes('?ref=main'), true);
      const rel = relFromApi(argv[2]);
      assert.equal(rel === '.env' || rel.endsWith('/.env'), false);
      assert.equal(rel.endsWith('secrets.json'), false);
      assert.equal(rel.endsWith('link.json'), false);
      assert.equal(rel.includes('nested'), false);
    }
    const again = await scanFeatureFlags(repo, { id, exec, at: AT + 6000 });
    assert.equal(again.wrote, true);
    assert.equal(flagEvents(repo, id).length, 1);
    assert.equal(repo.getProject(id).flags.find((flag) => flag.key === 'FEATURE_BILLING').scannedAt, AT + 5000);
    state.files['.env.example'] = 'FEATURE_BILLING=false\n';
    const flipped = await scanFeatureFlags(repo, { id, exec, at: AT + 7000 });
    assert.equal(flipped.flags.find((flag) => flag.key === 'FEATURE_BILLING').state, 'off');
    assert.equal(flagEvents(repo, id).length, 2);
    assert.equal(repo.getProject(id).lastActivityAt, AT);
    state.mode = 'rate';
    const limited = await scanFeatureFlags(repo, { id, exec, at: AT + 8000 });
    assert.equal(limited.wrote, false);
    assert.equal(repo.getProject(id).flags.find((flag) => flag.key === 'FEATURE_BILLING').state, 'off');
    assert.equal(flagEvents(repo, id).length, 2);
    state.mode = 'bad';
    const broken = await scanFeatureFlags(repo, { id, exec, at: AT + 9000 });
    assert.equal(broken.wrote, false);
    assert.equal(repo.getProject(id).flags.find((flag) => flag.key === 'billing').state, 'off');
  });

  it('merges a workspace and a GitHub repo into one flags-updated event', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-flags-both-'));
    try {
      fs.mkdirSync(path.join(root, 'proj'));
      fs.writeFileSync(path.join(root, 'proj', '.env.example'), 'FEATURE_LOCAL=true\n');
      const { exec } = githubExec({
        mode: 'ok',
        files: { 'flags.json': '{"remoteFlag":true}' },
      });
      const repo = repository();
      const id = link(repo, [
        { kind: 'workspace', ref: { path: 'proj' } },
        { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
      ]);
      const result = await scanFeatureFlags(repo, { id, root, fs: tracingFs(), exec, at: AT + 5 });
      assert.deepEqual(statesOf(result.flags), { FEATURE_LOCAL: 'on', remoteFlag: 'on' });
      assert.equal(flagEvents(repo, id).length, 1);
      assert.equal(repo.getProject(id).lastActivityAt, AT);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
