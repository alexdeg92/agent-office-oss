'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commands, buildProjectVM, discovery } = require('../../src/projects');
const { main } = require('../../scripts/projects-discover');
const { AT, repository } = require('./helpers');
const repoList = require('./fixtures/github/repo-list.json');

const DAY = discovery.DAY_MS;
const session = (name, at) => ({
  name,
  slug: name,
  lastActivityAt: at,
  ref: { by: 'keys', sessionKeys: [`agent:main:${name}`] },
});

describe('project discovery', () => {
  it('merges a workspace clone and a similarly named session into the github repo', () => {
    const candidates = discovery.proposeCandidates({
      now: AT,
      owners: ['alexdeg92'],
      github: [
        { owner: 'alexdeg92', repo: 'demo', name: 'demo', description: 'Site web du client Acme', topics: ['personal'], pushedAt: new Date(AT - 2 * DAY).toISOString() },
        { owner: 'other', repo: 'secret', name: 'secret', pushedAt: new Date(AT).toISOString() },
      ],
      workspaces: [
        { path: 'sites/demo', remote: 'git@github.com:alexdeg92/demo.git', lastCommitAt: AT - DAY },
        { path: 'notes', remote: null, lastCommitAt: AT - 40 * DAY },
      ],
      sessionGroups: [
        session('Demo', AT - 3 * DAY),
        session('Autre chose', AT - DAY),
      ],
    });
    const demo = candidates.find((c) => c.key === 'gh:alexdeg92/demo');
    assert.equal(candidates.some((c) => c.key.includes('secret')), false);
    assert.equal(demo.status, 'in-progress');
    assert.equal(demo.confidence, 'high');
    assert.match(demo.reason, /14 derniers jours/);
    assert.equal(demo.statusBecause, 'recent-activity');
    assert.deepEqual(demo.merged.sort(), ['remote-url', 'session-slug']);
    assert.equal(demo.sources.length, 3);
    assert.deepEqual(demo.labels.map((l) => l.key).sort(), ['client', 'perso', 'site-web']);
    const notes = candidates.find((c) => c.key === 'ws:notes');
    assert.equal(notes.status, 'todo');
    assert.equal(notes.confidence, 'medium');
    assert.equal(notes.statusBecause, 'stale');
    const other = candidates.find((c) => c.name === 'Autre chose');
    assert.equal(other.sources[0].kind, 'sessionGroup');
    const ambiguous = discovery.proposeCandidates({
      now: AT,
      owners: ['alexdeg92'],
      github: [
        { owner: 'alexdeg92', repo: 'demo', name: 'demo', pushedAt: new Date(AT).toISOString() },
        { owner: 'alexdeg92', repo: 'demo-web', name: 'demo-web', pushedAt: new Date(AT).toISOString() },
      ],
      sessionGroups: [session('Demo', AT)],
    });
    assert.equal(ambiguous.filter((c) => c.sources.some((s) => s.kind === 'sessionGroup' && c.sources.some((s2) => s2.kind === 'github'))).length, 0);
  });

  it('suggests À faire for a long silence, Livré only for an archived repo, and Idée when nothing happened', () => {
    const rows = discovery.proposeCandidates({
      now: AT,
      owners: ['alexdeg92'],
      github: [
        { owner: 'alexdeg92', repo: 'ancient', name: 'ancient', pushedAt: new Date(AT - 200 * DAY).toISOString() },
        { owner: 'alexdeg92', repo: 'boxed', name: 'boxed', archived: true, pushedAt: new Date(AT - DAY).toISOString() },
        { owner: 'alexdeg92', repo: 'empty', name: 'empty' },
      ],
    });
    const ancient = rows.find((c) => c.name === 'ancient');
    assert.equal(ancient.status, 'todo');
    assert.equal(ancient.confidence, 'low');
    assert.match(ancient.reason, /sans signe de livraison/);
    assert.equal(rows.find((c) => c.name === 'boxed').status, 'shipped');
    assert.equal(rows.find((c) => c.name === 'boxed').statusBecause, 'github-archived');
    assert.equal(rows.find((c) => c.name === 'empty').status, 'idea');
    assert.equal(rows.find((c) => c.name === 'empty').confidence, 'low');
  });

  it('reads a recorded gh repo list and workspace git output without a live call', async () => {
    const calls = [];
    const exec = async (argv) => {
      calls.push(argv);
      if (argv[0] === 'gh') return { code: 0, stdout: `hint\n${JSON.stringify(repoList)}`, stderr: 'ghp_SECRET' };
      if (argv[3] === 'remote') return { code: 0, stdout: 'https://github.com/alexdeg92/demo.git\n', stderr: '' };
      if (argv[3] === 'log') return { code: 0, stdout: '2026-09-28T12:00:00Z\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'nope' };
    };
    const github = await discovery.collectGithubRepos({ exec, owner: 'alexdeg92' });
    assert.equal(github[0].topics[0], 'personal');
    assert.equal(JSON.stringify(github).includes('ghp_SECRET'), false);
    const folders = await discovery.collectWorkspaceFolders({
      root: '/work/agent',
      exec,
      listDirs: async () => ['sites/demo', '../secrets'],
    });
    assert.deepEqual(folders.map((f) => f.path), ['sites/demo']);
    assert.equal(folders[0].remote, 'https://github.com/alexdeg92/demo.git');
    assert.equal(calls.some((argv) => argv.join(' ').includes('../secrets')), false);
    const listed = discovery.proposeCandidates({ now: AT, owners: ['alexdeg92'], github, workspaces: folders });
    assert.equal(listed.find((c) => c.key === 'gh:alexdeg92/demo').sources.some((s) => s.kind === 'workspace'), true);
    assert.equal(listed.find((c) => c.name === 'old-tool').status, 'shipped');
  });

  it('strips userinfo before a workspace remote is stored or printed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-disc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-disc-out-'));
    fs.mkdirSync(path.join(root, 'demo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(outside, '.git'));
    fs.mkdirSync(path.join(root, 'escaped'));
    fs.writeFileSync(path.join(root, 'escaped', '.git'), `gitdir: ${path.join(outside, '.git')}\n`);
    const secret = 'https://synthetic-user:synthetic-password@example.invalid/demo.git';
    const seen = [];
    const exec = async (argv) => {
      seen.push(argv[2]);
      if (argv[3] === 'remote') return { code: 0, stdout: `${secret}?token=synthetic-password\n`, stderr: '' };
      return { code: 0, stdout: '2026-09-28T12:00:00Z\n', stderr: '' };
    };
    const folders = await discovery.collectWorkspaceFolders({
      root,
      exec,
      listDirs: async () => ['demo', 'escaped'],
    });
    assert.deepEqual(folders.map((f) => f.path), ['demo']);
    assert.equal(JSON.stringify(folders).includes('synthetic-password'), false);
    assert.equal(JSON.stringify(folders).includes('synthetic-user'), false);
    assert.equal(seen.some((dir) => String(dir).includes('escaped')), false);
    const candidates = discovery.proposeCandidates({ now: AT, workspaces: folders });
    const printed = `${discovery.formatTable(candidates)}\n${JSON.stringify(candidates)}`;
    assert.equal(printed.includes('synthetic-password'), false);
    assert.equal(printed.includes('synthetic-user'), false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('imports accepted candidates as Owner and skips a repo that is already on the board', () => {
    const repo = repository();
    const candidates = discovery.proposeCandidates({
      now: AT,
      owners: ['alexdeg92'],
      github: [{
        owner: 'alexdeg92', repo: 'demo', name: 'demo',
        description: 'Site web du client', pushedAt: new Date(AT - 2 * DAY).toISOString(),
      }],
      workspaces: [{ path: 'sites/demo', remote: 'https://github.com/alexdeg92/demo', lastCommitAt: AT - 2 * DAY }],
    });
    const first = commands.importCandidates(repo, { candidates, actor: 'owner', at: AT });
    assert.equal(first.result.skipped.length, 0);
    const project = repo.getProject(first.result.created[0].id);
    assert.equal(project.status, 'in-progress');
    assert.equal(project.lastActivityAt, AT - 2 * DAY);
    assert.equal(project.createdAt, AT);
    assert.equal(project.sources.length, 2);
    assert.equal(project.flags.some((f) => f.kind === 'label' && f.key === 'client'), true);
    assert.equal(project.flags.some((f) => f.kind === 'label' && f.key === 'site-web'), true);
    const created = repo.getHistory(project.id).events.find((e) => e.kind === 'project-created');
    assert.equal(created.actor.personId, 'per_alexowner000000');
    const notice = buildProjectVM(project, [], { persons: repo.listPersons() });
    assert.equal(notice.repo.state, 'pending');
    assert.equal(notice.repo.defaultBranch, null);
    assert.equal(Object.hasOwn(notice, 'repoNotice'), false);
    assert.equal(notice.repo.image.kind, 'monogram');
    assert.equal(notice.repo.image.url, null);
    assert.deepEqual(notice.sources.find((s) => s.kind === 'github').ref, { owner: 'alexdeg92', repo: 'demo' });
    assert.equal(project.repo, null);
    assert.equal(project.repoStatus.state, 'pending');
    const again = commands.importCandidates(repo, { candidates, keys: [candidates[0].key, 'missing'], at: AT });
    assert.equal(again.result.created.length, 0);
    assert.deepEqual(again.result.skipped.map((s) => s.reason).sort(), ['exists', 'unknown']);
    assert.equal(repo.listProjects().length, 1);
  });

  it('lets Timmy append a history event and refuses a status event on that path', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const noted = commands.appendHistory(repo, {
      id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, at: AT + 5,
      kind: 'agent-action', action: 'commented', note: 'Je m’en occupe.', subjectPersonId: null,
      dedupeKey: 'note:1',
    });
    assert.equal(noted.revision, 1);
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'agent-action' && e.actor.kind === 'agent'));
    commands.appendHistory(repo, {
      id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, at: AT + 6, kind: 'agent-action', action: 'commented', note: 'encore', dedupeKey: 'note:1',
    });
    assert.equal(repo.getHistory(project.id).events.filter((e) => e.dedupeKey === 'note:1').length, 1);
    assert.throws(() => commands.appendHistory(repo, {
      id: project.id, expectedRevision: 1, actor: { kind: 'agent', agentId: 'main' }, kind: 'status', at: AT,
    }), (e) => e.status === 400);
    const moved = commands.setStatus(repo, {
      id: project.id, expectedRevision: noted.revision, status: 'in-review', actor: { kind: 'agent', agentId: 'main' }, at: AT + 7,
    });
    assert.equal(moved.status, 'in-review');
    assert.equal(repo.getHistory(project.id).events.find((e) => e.kind === 'status').actor.kind, 'agent');
  });

  it('records a person override and a feature-flag change only when the set changes', () => {
    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const guest = repo.upsertPerson({ id: 'per_guest0000000001', kind: 'human', name: 'Guest', avatarUrl: null, links: {} });
    const added = commands.setPersonOverride(repo, {
      id: project.id, expectedRevision: 1, personId: guest.id, role: 'Client', actor: 'owner', at: AT + 1,
    });
    assert.ok(repo.getHistory(project.id).events.some((e) => e.kind === 'people-override' && e.role === 'Client' && e.hidden === false));
    const flagged = commands.replaceFeatureFlags(repo, {
      id: project.id, expectedRevision: added.revision, actor: 'system', component: 'engine', at: AT + 2,
      features: [{ key: 'projets.board', state: 'on', foundIn: { path: 'src/flags.js', line: 4 } }],
    });
    const event = repo.getHistory(project.id).events.find((e) => e.kind === 'flags-updated');
    assert.equal(event.actor.component, 'engine');
    assert.deepEqual(event.flags, [{ key: 'projets.board', state: 'on' }]);
    const again = commands.replaceFeatureFlags(repo, {
      id: project.id, expectedRevision: flagged.revision, actor: 'system', component: 'engine', at: AT + 3,
      features: [{ key: 'projets.board', state: 'on', foundIn: { path: 'src/flags.js', line: 4 } }],
    });
    assert.equal(again.revision, flagged.revision);
    assert.equal(repo.getHistory(project.id).events.filter((e) => e.kind === 'flags-updated').length, 1);
  });

  it('folds worktrees, ignores tool folders, and keeps unmatched session groups', () => {
    const candidates = discovery.proposeCandidates({
      now: AT,
      owners: ['alexdeg92'],
      github: [
        { owner: 'alexdeg92', repo: 'pivot', name: 'pivot', pushedAt: new Date(AT - 2 * DAY).toISOString() },
      ],
      workspaces: [
        { path: 'pivot', remote: 'git@github.com:alexdeg92/pivot.git', lastCommitAt: AT - 2 * DAY },
        { path: 'pivot-billing', remote: null, lastCommitAt: AT - DAY },
        { path: 'Clover-KDS', remote: 'https://gitlab.example/clover.git', lastCommitAt: AT - 3 * DAY },
        { path: 'Clover-KDS-wip', remote: 'https://gitlab.example/clover.git', lastCommitAt: AT - 4 * DAY },
        { path: 'cursor', remote: null, lastCommitAt: AT },
        { path: 'tools/codex', remote: null, lastCommitAt: AT },
      ],
      sessionGroups: [
        { name: 'Facturation', sessions: [{ key: 'agent:main:facturation', updatedAt: AT - DAY }], lastActivityAt: AT - DAY },
        { name: 'Notes internes', slug: 'notes-internes' },
      ],
    });
    const pivot = candidates.find((c) => c.key === 'gh:alexdeg92/pivot');
    assert.deepEqual(pivot.sources.filter((s) => s.kind === 'workspace').map((s) => s.ref.path).sort(), ['pivot', 'pivot-billing']);
    assert.ok(pivot.merged.includes('name-prefix'));
    const clover = candidates.find((c) => c.sources.some((s) => s.kind === 'workspace' && s.ref.path === 'Clover-KDS'));
    assert.equal(clover.sources.filter((s) => s.kind === 'workspace').length, 2);
    assert.equal(candidates.some((c) => c.sources.some((s) => s.kind === 'workspace' && /cursor|codex/.test(s.ref.path))), false);
    const billing = candidates.find((c) => c.name === 'Facturation');
    assert.equal(billing.sources[0].kind, 'sessionGroup');
    assert.deepEqual(billing.sources[0].ref, { by: 'group', groupId: 'Facturation', name: 'Facturation' });
    assert.equal(billing.key, 'sg:group:Facturation');
    assert.equal(candidates.some((c) => c.name === 'Notes internes'), true);
    const { buildCandidatesVM } = require('../../src/projects');
    const vm = buildCandidatesVM(candidates, { scannedAt: AT });
    assert.equal(vm.scannedAt, AT);
    const pivotVm = vm.candidates.find((c) => c.key === pivot.key);
    assert.equal(pivotVm.id, pivot.key);
    assert.equal(pivotVm.suggestedStatus, pivot.status);
    assert.equal(pivotVm.sources.some((s) => s.label === 'alexdeg92/pivot'), true);
    assert.deepEqual(pivotVm.sources.find((s) => s.kind === 'github').ref, { owner: 'alexdeg92', repo: 'pivot' });
    const repo = repository();
    const imported = commands.importCandidates(repo, {
      candidates, keys: [pivot.key], at: AT,
      overrides: { [pivot.key]: { name: 'Pivot', status: 'in-review', labels: ['client'] } },
    });
    const importedProject = repo.getProject(imported.result.created[0].id);
    assert.equal(importedProject.name, 'Pivot');
    assert.equal(importedProject.status, 'in-review');
    assert.equal(importedProject.flags.some((f) => f.kind === 'label' && f.key === 'client'), true);
  });

  it('lists git folders under a root and prints a dry run without writing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-discover-'));
    fs.mkdirSync(path.join(root, 'demo'));
    fs.mkdirSync(path.join(root, 'demo', '.git'));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'));
    fs.mkdirSync(path.join(root, 'cursor', '.git'), { recursive: true });
    assert.deepEqual(discovery.listGitDirs(root), ['demo']);
    fs.rmSync(root, { recursive: true, force: true });

    const script = fs.readFileSync(path.join(__dirname, '../../scripts/projects-discover.js'), 'utf8');
    assert.equal(script.includes('writeFile'), false);
    assert.equal(script.includes('importCandidates'), false);
    assert.equal(script.includes('openclaw'), false);
    const stderr = [];
    const code = await main([], { stdout: { write() {} }, stderr: { write(s) { stderr.push(s); } } });
    assert.equal(code, 1);
    assert.match(stderr.join(''), /Lecture seule/);
    const table = discovery.formatTable([
      {
        name: 'demo', status: 'in-progress', confidence: 'high', reason: 'Activité dans les 14 derniers jours.',
        labels: [{ label: 'site web' }],
        sources: [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } }],
      },
      {
        name: 'ancien', status: 'todo', confidence: 'low', reason: 'Aucune activité connue.',
        sources: [{ kind: 'workspace', ref: { path: 'notes' } }],
      },
      {
        name: 'calibre', status: 'todo', confidence: 'medium', reason: 'Pas d’activité récente.',
        sources: [],
      },
    ]);
    assert.match(table, /En cours/);
    assert.match(table, /haute/);
    assert.match(table, /moyenne/);
    assert.match(table, /faible/);
    assert.doesNotMatch(table, /\b(low|medium|high)\b/);
    assert.match(table, /14 derniers jours/);
    assert.match(table, /alexdeg92\/demo/);
    const printed = {
      confidence: discovery.confidenceText('low'),
    };
    assert.equal(printed.confidence, 'faible');
  });
});
