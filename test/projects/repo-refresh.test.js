'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGithubSource } = require('../../src/projects/sources/github');
const { createRepoRefresh, REPO_FRESH_MS, SCREENSHOT_FRESH_MS } = require('../../src/projects/repo-refresh');
const { commands, buildProjectVM, monogramAccent } = require('../../src/projects');
const { thumbOf } = require('../../src/projects/vm');
const { compareShape, loadExample } = require('../helpers/contract-shape');
const { AT, repository } = require('./helpers');

const repoJson = require('./fixtures/github/repo.json');
const commitsJson = require('./fixtures/github/commits.json');
const runsFailure = require('./fixtures/github/runs-failure.json');
const runsSuccess = require('./fixtures/github/runs-success.json');

function ghExec(payloads) {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv);
    if (payloads.fail) return { code: 1, stdout: '', stderr: payloads.fail };
    const endpoint = argv[2];
    if (endpoint.includes('/commits?')) return { code: 0, stdout: JSON.stringify(payloads.commits || commitsJson), stderr: '' };
    if (endpoint.includes('/actions/runs?')) return { code: 0, stdout: JSON.stringify(payloads.runs || runsFailure), stderr: '' };
    return { code: 0, stdout: JSON.stringify(payloads.repo || repoJson), stderr: '' };
  };
  return { exec, calls };
}

function linked(exec) {
  const repo = repository();
  const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
  commands.linkSource(repo, {
    id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
    source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
  });
  const source = createGithubSource({ exec });
  const cache = createRepoRefresh({ source, now: () => AT });
  return { repo, project, cache };
}

describe('repo cache refresh', () => {
  it('writes meta, commit history and ci-red through the repository, and keeps the project VM shape', async () => {
    const { exec, calls } = ghExec({
      repo: { ...repoJson, archived: true, homepage: 'https://demo.example', topics: ['site-web'] },
      runs: runsFailure,
    });
    const { repo, project, cache } = linked(exec);
    const first = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(first.status, 'ok');
    assert.equal(calls.length, 3);
    const stored = repo.getProject(project.id);
    assert.equal(stored.repo.defaultBranch, 'main');
    assert.equal(stored.repo.archived, true);
    assert.equal(stored.repo.homepage, 'https://demo.example');
    assert.deepEqual(stored.repo.topics, ['site-web']);
    assert.equal(stored.repo.ci.state, 'failing');
    assert.equal(stored.flags.some((f) => f.kind === 'risk' && f.key === 'ci-red' && f.clearedAt == null), true);
    const commits = repo.getHistory(project.id).events.filter((e) => e.kind === 'commit');
    assert.deepEqual(commits.map((e) => e.dedupeKey).sort(), [
      'commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'commit:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    const vm = buildProjectVM(stored, repo.getHistory(project.id).events, { persons: [] });
    const example = loadExample('project-vm').data;
    assert.deepEqual(compareShape(example.repo, vm.repo), []);
    assert.equal(vm.thumb.kind, 'opengraph');
    assert.equal(vm.thumb.accent, monogramAccent(project.id));
    assert.equal('tint' in vm.thumb, false);
    assert.equal(vm.repo.ci.state, 'failing');
    assert.equal('archived' in vm.repo, false);
    assert.deepEqual(vm.repo.image, {
      kind: vm.thumb.kind, url: vm.thumb.url, initials: vm.thumb.initials, accent: vm.thumb.accent,
    });

    const again = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + 60 * 1000 });
    assert.equal(again.status, 'fresh');
    assert.equal(calls.length, 3);
    assert.equal(repo.getHistory(project.id).events.filter((e) => e.kind === 'commit').length, 2);

    const { exec: passExec, calls: passCalls } = ghExec({ runs: runsSuccess });
    const passing = createRepoRefresh({ source: createGithubSource({ exec: passExec }), now: () => AT });
    const cleared = await passing.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + REPO_FRESH_MS });
    assert.equal(cleared.status, 'ok');
    assert.equal(passCalls.length, 3);
    const after = repo.getProject(project.id);
    assert.equal(after.repo.ci.state, 'passing');
    assert.equal(after.flags.some((f) => f.kind === 'risk' && f.key === 'ci-red' && f.clearedAt == null), false);
    assert.equal(repo.getHistory(project.id).events.filter((e) => e.kind === 'commit').length, 2);
  });

  it('backs off after a gh error or a rate limit, and runs one fetch per repo', async () => {
    const { exec, calls } = ghExec({ fail: 'HTTP 429: API rate limit exceeded for ghp_SECRETVALUE' });
    const { repo, project, cache } = linked(exec);
    const failed = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(failed.status, 'error');
    assert.equal(failed.category, 'rate-limited');
    assert.equal(calls.length, 1);
    const status = repo.getProject(project.id).repoStatus;
    assert.equal(status.state, 'error');
    assert.equal(status.lastError, 'rate-limited');
    assert.equal(JSON.stringify(repo.getProject(project.id)).includes('ghp_SECRETVALUE'), false);

    const soon = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + 2 * 60 * 1000 });
    assert.equal(soon.status, 'backoff');
    assert.equal(calls.length, 1);
    const later = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + 15 * 60 * 1000 });
    assert.equal(later.status, 'error');
    assert.equal(calls.length, 2);
  });

  it('retries a generic gh error after one minute', async () => {
    const { exec, calls } = ghExec({ fail: 'HTTP 500' });
    const { repo, cache } = linked(exec);
    const failed = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(failed.category, 'error');
    const early = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + 59 * 1000 });
    assert.equal(early.status, 'backoff');
    assert.equal(calls.length, 1);
    const retry = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + 60 * 1000 });
    assert.equal(retry.status, 'error');
    assert.equal(calls.length, 2);
  });

  it('runs one fetch per repo while the first is in flight', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let n = 0;
    const flight = linked(async (argv) => {
      n += 1;
      if (n === 1) await held;
      const endpoint = argv[2];
      if (endpoint.includes('/commits?')) return { code: 0, stdout: JSON.stringify(commitsJson), stderr: '' };
      if (endpoint.includes('/actions/runs?')) return { code: 0, stdout: JSON.stringify(runsSuccess), stderr: '' };
      return { code: 0, stdout: JSON.stringify(repoJson), stderr: '' };
    });
    const one = flight.cache.refresh(flight.repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    const two = flight.cache.refresh(flight.repo, { owner: 'Alexdeg92', name: 'Demo', at: AT });
    assert.equal(n, 1);
    assert.equal(one, two);
    release();
    const both = await Promise.all([one, two]);
    assert.equal(both[0].status, 'ok');
    assert.equal(n, 3);
  });

  it('paints a monogram from the project name and id when there is no image', () => {
    const id = 'prj_coverpick00001';
    const thumb = thumbOf({ id, name: 'Portail', repo: null });
    assert.equal(thumb.kind, 'monogram');
    assert.equal(thumb.url, null);
    assert.equal(thumb.initials, 'PO');
    assert.equal(thumb.accent, monogramAccent(id));
    assert.equal(monogramAccent(id), monogramAccent(id));
    const seen = new Set(['prj_a', 'prj_b', 'prj_c', 'prj_d', 'prj_e', 'prj_f', 'prj_g', 'prj_h'].map(monogramAccent));
    assert.ok(seen.size >= 2);
  });

  it('captures a public homepage and refuses private or non-https hosts', async () => {
    const shots = [];
    const capture = async (input) => {
      shots.push(input);
      return { url: 'https://shots.example/demo.png' };
    };
    const resolve = async () => ['93.184.216.34'];
    const { exec } = ghExec({
      repo: { ...repoJson, homepage: 'https://demo.example/home' },
    });
    const { repo, project } = linked(exec);
    const cache = createRepoRefresh({
      source: createGithubSource({ exec }),
      capture, resolve, now: () => AT,
    });
    const first = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(first.status, 'ok');
    assert.equal(shots[0].url, 'https://demo.example/home');
    assert.equal(shots[0].width, 1200);
    assert.equal(shots[0].height, 630);
    assert.equal(shots[0].timeoutMs, 10 * 1000);
    assert.equal(shots[0].maxBytes, 2 * 1024 * 1024);
    assert.equal(repo.getProject(project.id).repo.image.kind, 'screenshot');
    assert.equal(repo.getProject(project.id).repo.image.url, 'https://shots.example/demo.png');

    const again = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + REPO_FRESH_MS });
    assert.equal(again.status, 'ok');
    assert.equal(shots.length, 1);

    const later = await cache.refresh(repo, { owner: 'alexdeg92', name: 'demo', at: AT + REPO_FRESH_MS + SCREENSHOT_FRESH_MS });
    assert.equal(later.status, 'ok');
    assert.equal(shots.length, 2);

    const blocked = [
      'http://demo.example',
      'https://localhost/admin',
      'https://127.0.0.1/',
      'https://10.1.2.3/x',
      'https://192.168.0.8/',
      'https://172.16.0.1/',
      'https://100.64.0.1/',
      'https://169.254.169.254/',
      'https://[::1]/',
      'https://printer.local/status',
      'https://db.internal/admin',
    ];
    for (const homepage of blocked) {
      const calls = [];
      const { exec: blockedExec } = ghExec({ repo: { ...repoJson, homepage } });
      const row = linked(blockedExec);
      const refresher = createRepoRefresh({
        source: createGithubSource({ exec: blockedExec }),
        capture: async (input) => { calls.push(input); return { url: 'https://shots.example/nope.png' }; },
        resolve,
        now: () => AT,
      });
      await refresher.refresh(row.repo, { owner: 'alexdeg92', name: 'demo', at: AT });
      assert.equal(calls.length, 0, homepage);
      assert.equal(row.repo.getProject(row.project.id).repo.image.kind, 'opengraph', homepage);
    }

    const privateName = [];
    const { exec: dnsExec } = ghExec({ repo: { ...repoJson, homepage: 'https://internal.example' } });
    const dnsRow = linked(dnsExec);
    const dnsRefresh = createRepoRefresh({
      source: createGithubSource({ exec: dnsExec }),
      capture: async () => { privateName.push(1); return { url: 'https://shots.example/nope.png' }; },
      resolve: async () => ['10.0.0.5'],
      now: () => AT,
    });
    await dnsRefresh.refresh(dnsRow.repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(privateName.length, 0);
    assert.equal(dnsRow.repo.getProject(dnsRow.project.id).repo.image.kind, 'opengraph');

    const leaked = [];
    const { exec: credExec } = ghExec({ repo: { ...repoJson, homepage: 'https://user:secret@demo.example/home' } });
    const credRow = linked(credExec);
    const credRefresh = createRepoRefresh({
      source: createGithubSource({ exec: credExec }),
      capture: async (input) => { leaked.push(input); return { url: 'https://shots.example/demo.png' }; },
      resolve,
      now: () => AT,
    });
    await credRefresh.refresh(credRow.repo, { owner: 'alexdeg92', name: 'demo', at: AT });
    assert.equal(leaked.length, 1);
    assert.equal(leaked[0].url.includes('secret'), false);
    assert.equal(leaked[0].url.includes('user'), false);
    assert.equal(credRow.repo.getProject(credRow.project.id).repo.homepage.includes('secret'), false);
  });
});
