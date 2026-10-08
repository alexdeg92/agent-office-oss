'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGithubSource, repoFromPayloads } = require('../../src/projects/sources/github');
const { createWorkspaceSource, parseGitLog } = require('../../src/projects/sources/workspace');
const discovery = require('../../src/projects/discovery');
const { createSessionGroupSource, createManualSource } = require('../../src/projects/sources/session-group');
const { hashEmail } = require('../../src/projects/email');
const { commands } = require('../../src/projects');
const { AT, repository, Owner } = require('./helpers');

const repoJson = require('./fixtures/github/repo.json');
const commitsJson = require('./fixtures/github/commits.json');
const runsFailure = require('./fixtures/github/runs-failure.json');
const runsSuccess = require('./fixtures/github/runs-success.json');

function ghExec(payloads) {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv);
    const endpoint = argv[2];
    if (endpoint.includes('/commits?')) return { code: 0, stdout: 'prefix\n' + JSON.stringify(payloads.commits), stderr: '' };
    if (endpoint.includes('/actions/runs?')) return { code: 0, stdout: JSON.stringify(payloads.runs), stderr: '' };
    return { code: 0, stdout: JSON.stringify(payloads.repo), stderr: '' };
  };
  return { exec, calls };
}

describe('project sources', () => {
  it('reads a github repo through an injected gh exec and never keeps the email', async () => {
    const { exec, calls } = ghExec({ repo: repoJson, commits: commitsJson, runs: runsFailure });
    const source = createGithubSource({ exec });
    const snap = await source.fetch({ owner: 'alexdeg92', repo: 'demo' }, { fetchedAt: AT });
    assert.deepEqual(calls.map((c) => c[0]), ['gh', 'gh', 'gh']);
    assert.deepEqual(calls[0], ['gh', 'api', 'repos/alexdeg92/demo']);
    assert.equal(calls[1][2], 'repos/alexdeg92/demo/commits?sha=main&per_page=10');
    assert.equal(calls[2][2], 'repos/alexdeg92/demo/actions/runs?branch=main&per_page=1');
    assert.equal(snap.repo.defaultBranch, 'main');
    assert.equal(snap.repo.archived, false);
    assert.equal(snap.repo.homepage, null);
    assert.deepEqual(snap.repo.topics, []);
    assert.equal(snap.repo.image.kind, 'opengraph');
    assert.match(snap.repo.image.url, /^https:\/\/opengraph\.githubassets\.com\/[a-f0-9]{16}\/alexdeg92\/demo$/);
    assert.equal(snap.repo.ci.state, 'failing');
    assert.equal(snap.repo.commits[0].message, 'Fix the door');
    assert.equal(snap.authors[0].emailHash, hashEmail('ada@example.com'));
    const dumped = JSON.stringify(snap);
    assert.equal(dumped.includes('Ada@Example.com'), false);
    assert.equal(dumped.includes('example.com'), false);
    const passing = repoFromPayloads({ meta: repoJson, commits: commitsJson, runs: runsSuccess, fetchedAt: AT });
    assert.equal(passing.repo.ci.state, 'passing');
  });

  it('keeps CI on the default branch and prefers a custom social preview when gh returns one', () => {
    const other = repoFromPayloads({
      meta: repoJson,
      commits: [],
      runs: {
        workflow_runs: [{
          status: 'completed', conclusion: 'failure', head_branch: 'wip',
          html_url: 'https://github.com/alexdeg92/demo/actions/runs/9', updated_at: '2026-10-02T08:00:00Z',
        }],
      },
      fetchedAt: AT,
    });
    assert.equal(other.repo.ci.state, 'none');
    const preview = 'https://user:ghp_SECRETVALUE@repository-images.githubusercontent.com/abc.png';
    const custom = repoFromPayloads({
      meta: {
        ...repoJson,
        archived: true,
        homepage: 'http://insecure.example',
        topics: ['Personal', 'not a topic', 'site-web'],
        openGraphImageUrl: preview,
        node_id: 'R_1',
        updated_at: '2026-10-01T00:00:00Z',
      },
      commits: commitsJson,
      runs: runsFailure,
      fetchedAt: AT,
    });
    assert.equal(custom.repo.archived, true);
    assert.equal(custom.repo.homepage, null);
    assert.deepEqual(custom.repo.topics, ['personal', 'site-web']);
    assert.equal(custom.repo.image.url, 'https://repository-images.githubusercontent.com/abc.png');
    assert.equal(JSON.stringify(custom).includes('ghp_SECRETVALUE'), false);
    assert.equal(custom.repo.ci.state, 'failing');
  });

  it('does not leak gh stderr when the command fails', async () => {
    const source = createGithubSource({
      exec: async () => ({ code: 1, stdout: '', stderr: 'token ghp_SECRETVALUE' }),
    });
    await assert.rejects(() => source.fetch({ owner: 'alexdeg92', repo: 'demo' }), (e) => {
      assert.equal(e.code, 'upstream_failed');
      assert.equal(e.category, 'error');
      assert.equal(String(e.message).includes('ghp_SECRETVALUE'), false);
      assert.equal(JSON.stringify(e).includes('ghp_SECRETVALUE'), false);
      return true;
    });
  });

  it('reads workspace git metadata inside a root and refuses to leave it', async () => {
    const calls = [];
    const exec = async (argv) => {
      calls.push(argv);
      if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (argv[3] === 'log') {
        return {
          code: 0,
          stdout: `cccccccccccccccccccccccccccccccccccccccc\x1f2026-10-01T12:00:00Z\x1fAlex\x1fAda@Example.com\x1fFix\n`,
          stderr: '',
        };
      }
      return { code: 2, stdout: '', stderr: '' };
    };
    const source = createWorkspaceSource({ root: '/work/agent', exec });
    const snap = await source.fetch({ path: 'sites/demo' });
    assert.equal(calls[0][2], path.resolve('/work/agent', 'sites/demo'));
    assert.equal(snap.branch, 'main');
    assert.equal(snap.authors[0].emailHash, hashEmail('ada@example.com'));
    assert.equal(JSON.stringify(snap).includes('Ada@Example.com'), false);
    const boom = createWorkspaceSource({
      root: '/work/agent',
      exec: async () => { throw new Error('exec should not run'); },
    });
    await assert.rejects(() => boom.fetch({ path: '../secrets' }), (e) => e.code === 'validation_failed');
    await assert.rejects(() => boom.fetch({ path: '/etc/passwd' }), (e) => e.code === 'validation_failed');
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ws-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-out-'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const linked = createWorkspaceSource({
      root,
      exec: async () => { throw new Error('exec should not run'); },
    });
    await assert.rejects(() => linked.fetch({ path: 'escape' }), (e) => e.code === 'validation_failed');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    assert.equal(fs.readFileSync(path.join(__dirname, '../../src/projects/sources/workspace.js'), 'utf8').includes('child_process'), false);
  });

  it('matches session groups from canonical sessions and exposes a manual source', () => {
    const sessions = [
      { key: 'agent:main:a', updatedAt: AT, class: { kind: 'chat-direct', agentId: 'main', interlocutorId: 'discord-user:100000000000000001' }, usage: { total: 10 } },
      { key: 'agent:main:b', updatedAt: AT, class: { kind: 'main', agentId: 'main', interlocutorId: null } },
    ];
    const groups = createSessionGroupSource();
    const byPerson = groups.fetch(
      groups.parseRef({ by: 'interlocutor', interlocutorId: 'discord-user:100000000000000001' }).ref,
      { sessions },
    );
    assert.equal(byPerson.sessionCount, 1);
    assert.equal(byPerson.sessions[0].key, 'agent:main:a');
    const byKeys = groups.fetch({ by: 'keys', sessionKeys: ['agent:main:b', 'missing'] }, { sessions });
    assert.deepEqual(byKeys.sessions.map((s) => s.key), ['agent:main:b']);
    const manual = createManualSource();
    assert.deepEqual(manual.parseRef(), { kind: 'manual', ref: null });
    assert.equal(manual.fetch().kind, 'manual');
  });

  it('stores a fetched repo on the project without a live call', () => {
    const built = repoFromPayloads({ meta: repoJson, commits: commitsJson, runs: runsFailure, fetchedAt: AT });
    const owner = Owner({ gitEmailHash: hashEmail('ada@example.com') });
    const repo = repository({ persons: [owner, require('./helpers').timmy()] });
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: 1, actor: 'owner', at: AT,
      source: { kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } },
    });
    assert.equal(linked.repo, null);
    repo.putRepoCache({ owner: 'alexdeg92', name: 'demo', repo: built.repo, authors: built.authors });
    const hydrated = repo.getProject(project.id);
    assert.equal(hydrated.repo.ci.state, 'failing');
    assert.equal(hydrated.repo.commits[0].author.personId, owner.id);
    assert.equal(hydrated.people.some((p) => p.personId === owner.id && p.commitCount === 1), true);
    assert.equal(hydrated.people.some((p) => p.origin === 'derived' && p.personId !== owner.id), true);
  });

  it('does not read a repository whose git dir sits outside the workspace root', async () => {
    const os = require('node:os');
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-outer-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitdir-'));
    const root = path.join(outer, 'workspace');
    fs.mkdirSync(root);
    const folder = path.join(root, 'folder');
    fs.mkdirSync(folder);
    fs.mkdirSync(path.join(outside, '.git'));
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return {
        code: 0,
        stdout: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f2026-10-01T12:00:00Z\x1fAda\x1fada@example.com\x1fOUTSIDE_ROOT_MARKER\n`,
        stderr: '',
      };
    };
    const source = createWorkspaceSource({ root, exec });
    const refused = async (rel) => {
      calls = 0;
      await assert.rejects(() => source.fetch({ path: rel }), (e) => e.code === 'validation_failed');
      assert.equal(calls, 0);
    };
    await refused('folder');
    fs.writeFileSync(path.join(folder, '.git'), `gitdir: ${path.join(outside, '.git')}\n`);
    await refused('folder');
    fs.rmSync(path.join(folder, '.git'));
    fs.symlinkSync(path.join(outside, '.git'), path.join(folder, '.git'));
    await refused('folder');
    fs.symlinkSync(outside, path.join(root, 'link'));
    await refused('link/missing');

    const repoGit = path.join(root, 'repo', '.git');
    const wtGit = path.join(repoGit, 'worktrees', 'wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    fs.mkdirSync(path.join(root, 'wt'));
    fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${wtGit}\n`);
    const inside = await createWorkspaceSource({
      root,
      exec: async (argv) => {
        if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
        if (argv[3] === 'log') {
          return {
            code: 0,
            stdout: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1f2026-10-01T12:00:00Z\x1fAda\x1fada@example.com\x1fINSIDE_OK\n`,
            stderr: '',
          };
        }
        return { code: 2, stdout: '', stderr: '' };
      },
    }).fetch({ path: 'wt' });
    assert.equal(inside.commits[0].message, 'INSIDE_OK');
    assert.equal(JSON.stringify(inside).includes('OUTSIDE_ROOT_MARKER'), false);
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function markerExec() {
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return {
        code: 0,
        stdout: 'main\n',
        stderr: '',
      };
    };
    const leaking = async (argv) => {
      calls += 1;
      if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (argv[3] === 'log') {
        return {
          code: 0,
          stdout: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f2026-10-01T12:00:00Z\x1fAda\x1fada@example.com\x1fOUTSIDE_OBJECT_DATABASE_MARKER\n`,
          stderr: '',
        };
      }
      return { code: 2, stdout: '', stderr: '' };
    };
    return {
      leaking,
      exec,
      get calls() { return calls; },
      reset() { calls = 0; },
    };
  }

  async function refusesOutside(root, rel, exec) {
    let calls = 0;
    const source = createWorkspaceSource({
      root,
      exec: async (argv, env) => {
        calls += 1;
        return exec(argv, env);
      },
    });
    await assert.rejects(() => source.fetch({ path: rel }), (e) => e.code === 'validation_failed');
    assert.equal(calls, 0);
  }

  it('rejects an object alternates file that points outside the workspace', async () => {
    const os = require('node:os');
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-alt-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-alt-out-'));
    const root = path.join(outer, 'workspace');
    const outsideObjects = path.join(outside, 'objects');
    fs.mkdirSync(path.join(root, 'repo', '.git', 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(outsideObjects, 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repo', '.git', 'objects', 'info', 'alternates'), `${outsideObjects}\n`);
    const harness = markerExec();
    await refusesOutside(root, 'repo', harness.leaking);

    const nested = path.join(root, 'repo', '.git', 'objects', 'nested');
    fs.mkdirSync(path.join(nested, 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repo', '.git', 'objects', 'info', 'alternates'), `${nested}\n`);
    fs.writeFileSync(path.join(nested, 'info', 'alternates'), `${outsideObjects}\n`);
    await refusesOutside(root, 'repo', harness.leaking);
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a .git/objects symlink that points outside the workspace', async () => {
    const os = require('node:os');
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-obj-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-obj-out-'));
    const root = path.join(outer, 'workspace');
    const outsideObjects = path.join(outside, 'objects');
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(outsideObjects, { recursive: true });
    fs.symlinkSync(outsideObjects, path.join(root, 'repo', '.git', 'objects'));
    await refusesOutside(root, 'repo', markerExec().leaking);
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a commondir that points outside the workspace', async () => {
    const os = require('node:os');
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-common-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-common-out-'));
    const root = path.join(outer, 'workspace');
    const gitDir = path.join(root, 'repo', '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(outside, 'real-git'));
    fs.writeFileSync(path.join(outside, 'commondir'), '.\n');
    fs.symlinkSync(path.join(outside, 'commondir'), path.join(gitDir, 'commondir'));
    await refusesOutside(root, 'repo', markerExec().leaking);

    fs.unlinkSync(path.join(gitDir, 'commondir'));
    fs.writeFileSync(path.join(gitDir, 'commondir'), `${path.join(outside, 'real-git')}\n`);
    await refusesOutside(root, 'repo', markerExec().leaking);
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a worktree .git file whose common object database leaves the workspace', async () => {
    const os = require('node:os');
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wt-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wt-out-'));
    const root = path.join(outer, 'workspace');
    const outsideObjects = path.join(outside, 'objects');
    const repoGit = path.join(root, 'repo', '.git');
    const wtGit = path.join(repoGit, 'worktrees', 'wt');
    fs.mkdirSync(path.join(repoGit, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(wtGit, { recursive: true });
    fs.mkdirSync(outsideObjects, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(repoGit, 'objects', 'info', 'alternates'), `${outsideObjects}\n`);
    fs.mkdirSync(path.join(root, 'wt'));
    fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${wtGit}\n`);
    await refusesOutside(root, 'wt', markerExec().leaking);
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('scrubs GIT_OBJECT_DIRECTORY and GIT_ALTERNATE before the injected exec', async () => {
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-env-'));
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    const outside = path.join(root, '..', 'outside-objects');
    const keys = ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ALTERNATE'];
    const saved = {};
    for (const key of keys) saved[key] = process.env[key];
    process.env.GIT_OBJECT_DIRECTORY = outside;
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = outside;
    process.env.GIT_ALTERNATE = outside;
    process.env.AO_GIT_ENV_SENTINEL = 'keep';
    let seen = null;
    const exec = async (argv, env) => {
      seen = env;
      if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (argv[3] === 'log') {
        return {
          code: 0,
          stdout: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1f2026-10-01T12:00:00Z\x1fAda\x1fada@example.com\x1fINSIDE_OK\n`,
          stderr: '',
        };
      }
      return { code: 2, stdout: '', stderr: '' };
    };
    try {
      const snap = await createWorkspaceSource({ root, exec }).fetch({ path: 'repo' });
      assert.equal(snap.commits[0].message, 'INSIDE_OK');
      assert.ok(seen && typeof seen === 'object');
      assert.equal(seen.GIT_OBJECT_DIRECTORY, undefined);
      assert.equal(seen.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
      assert.equal(seen.GIT_ALTERNATE, undefined);
      assert.equal(seen.AO_GIT_ENV_SENTINEL, 'keep');
      let discovered = null;
      await discovery.collectWorkspaceFolders({
        root,
        exec: async (argv, env) => {
          discovered = env;
          if (argv[3] === 'remote') return { code: 2, stdout: '', stderr: '' };
          return { code: 0, stdout: '2026-10-01T12:00:00Z\n', stderr: '' };
        },
        listDirs: async () => ['repo'],
      });
      assert.equal(discovered.GIT_OBJECT_DIRECTORY, undefined);
      assert.equal(discovered.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
      assert.equal(discovered.GIT_ALTERNATE, undefined);
      assert.equal(discovered.AO_GIT_ENV_SENTINEL, 'keep');
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      delete process.env.AO_GIT_ENV_SENTINEL;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips userinfo from a remote and hides an executor error on that command', async () => {
    const secret = 'https://synthetic-user:synthetic-password@example.invalid/demo.git?token=synthetic-password';
    const ok = async (argv) => {
      if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (argv[3] === 'log') {
        return {
          code: 0,
          stdout: `cccccccccccccccccccccccccccccccccccccccc\x1f2026-10-01T12:00:00Z\x1fAlex\x1fada@example.com\x1fFix\n`,
          stderr: '',
        };
      }
      if (argv.includes('get-url')) return { code: 0, stdout: `${secret}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const snap = await createWorkspaceSource({ root: '/work/agent', exec: ok }).fetch({ path: 'sites/demo' });
    const dumped = JSON.stringify(snap);
    assert.equal(dumped.includes('synthetic-password'), false);
    assert.equal(dumped.includes('synthetic-user'), false);
    assert.equal(snap.remote, 'https://example.invalid/demo.git');

    const boom = async (argv) => {
      if (argv.includes('get-url')) throw new Error('synthetic-secret-on-exec-error');
      return ok(argv);
    };
    await assert.rejects(
      () => createWorkspaceSource({ root: '/work/agent', exec: boom }).fetch({ path: 'sites/demo' }),
      (e) => {
        assert.equal(e.code, 'upstream_failed');
        assert.equal(e.status, 502);
        assert.equal(String(e.message).includes('synthetic-secret'), false);
        assert.equal(JSON.stringify(e).includes('synthetic-secret'), false);
        return true;
      },
    );
    const missing = async (argv) => {
      if (argv.includes('get-url')) return { code: 2, stdout: '', stderr: 'no origin' };
      return ok(argv);
    };
    const noRemote = await createWorkspaceSource({ root: '/work/agent', exec: missing }).fetch({ path: 'sites/demo' });
    assert.equal(noRemote.remote, null);
  });

  it('hides an email address used as the author name', () => {
    const address = 'synthetic@example.invalid';
    const parsed = parseGitLog(
      `dddddddddddddddddddddddddddddddddddddddd\x1f2026-10-01T12:00:00Z\x1f${address}\x1f${address}\x1fFix`,
    );
    assert.equal(JSON.stringify(parsed).includes(address), false);
    assert.equal(parsed.commits[0].author.name, 'inconnu');
    assert.equal(parsed.authors[0].name, 'inconnu');
    assert.equal(parsed.authors[0].emailHash, hashEmail(address));
    const built = repoFromPayloads({
      meta: repoJson,
      commits: [{
        sha: 'e'.repeat(40),
        commit: {
          message: 'Hi',
          author: { name: address, email: address, date: '2026-10-01T12:00:00Z' },
        },
      }],
      runs: runsSuccess,
      fetchedAt: AT,
    });
    assert.equal(JSON.stringify(built).includes(address), false);
    assert.equal(built.authors[0].name, 'inconnu');
    assert.equal(built.authors[0].emailHash, hashEmail(address));
    const repo = repository();
    repo.putRepoCache({
      owner: 'alexdeg92',
      name: 'demo',
      repo: null,
      authors: [{ name: address, emailHash: hashEmail(address) }],
    });
    const person = repo.listPersons().find((p) => p.links && p.links.gitEmailHash === hashEmail(address));
    assert.equal(person.name, 'inconnu');
    assert.equal(JSON.stringify(repo.listPersons()).includes(address), false);
  });
});
