'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commands, discovery, linkProjectActivity } = require('../../src/projects');
const { createWorkspaceSource } = require('../../src/projects/sources/workspace');
const { AT, repository } = require('./helpers');

const ROOTS = [
  { id: 'team-a', path: '/srv/team-a' },
  { id: 'team-b', path: '/srv/team-b' },
];

function folder(rootId, rel) {
  return { rootId, path: rel, remote: null, lastCommitAt: AT };
}

describe('workspace root ids', () => {
  it('keeps path-only refs while the flag is off', () => {
    const candidates = discovery.proposeCandidates({
      now: AT,
      workspaces: [folder('team-a', 'app'), folder('team-b', 'app')],
    });
    assert.deepEqual(candidates.map((candidate) => candidate.key), ['ws:app', 'ws:app']);
    assert.deepEqual(candidates[0].sources[0].ref, { path: 'app' });
    assert.equal('rootId' in candidates[0].sources[0].ref, false);

    const repo = repository();
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: project.id, expectedRevision: project.revision, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { rootId: 'team-a', path: 'app' } },
    });
    const stored = repo.getProject(linked.id).sources.find((source) => source.kind === 'workspace');
    assert.deepEqual(stored.ref, { path: 'app' });
  });

  it('gives two checkouts of app different identities when the flag is on', () => {
    const candidates = discovery.proposeCandidates({
      now: AT,
      workspaceRootIds: true,
      workspaces: [folder('team-a', 'app'), folder('team-b', 'app')],
    });
    assert.deepEqual(candidates.map((candidate) => candidate.key).sort(), ['ws:team-a/app', 'ws:team-b/app']);
    assert.deepEqual(candidates.map((candidate) => candidate.sources[0].ref).sort((a, b) => a.rootId.localeCompare(b.rootId)), [
      { rootId: 'team-a', path: 'app' },
      { rootId: 'team-b', path: 'app' },
    ]);

    const repo = repository({ workspaceRootIds: true, workspaceRoots: ROOTS });
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const first = commands.linkSource(repo, {
      id: project.id, expectedRevision: project.revision, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { rootId: 'team-a', path: 'app' } },
    });
    const second = commands.linkSource(repo, {
      id: project.id, expectedRevision: first.revision, actor: 'owner', at: AT + 1,
      source: { kind: 'workspace', ref: { rootId: 'team-b', path: 'app' } },
    });
    const refs = repo.getProject(second.id).sources.map((source) => source.ref);
    assert.deepEqual(refs, [
      { rootId: 'team-a', path: 'app' },
      { rootId: 'team-b', path: 'app' },
    ]);
    assert.throws(() => commands.linkSource(repo, {
      id: project.id, expectedRevision: second.revision, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { path: 'app' } },
    }), (err) => err.details && err.details[0].issue === 'root-required');
  });

  it('maps a path-only ref onto the single configured root', () => {
    const repo = repository({
      workspaceRootIds: true,
      workspaceRoots: [{ id: 'team-a', path: '/srv/team-a' }],
    });
    const project = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    commands.linkSource(repo, {
      id: project.id, expectedRevision: project.revision, actor: 'owner', at: AT,
      source: { kind: 'workspace', ref: { path: 'app' } },
    });
    const stored = repo.getProject(project.id).sources[0];
    assert.deepEqual(stored.ref, { rootId: 'team-a', path: 'app' });
  });

  it('fetches under the selected root and does not read the other one', async () => {
    const calls = [];
    const exec = async (argv) => {
      calls.push(argv);
      if (argv[3] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (argv[3] === 'log') return { code: 0, stdout: '', stderr: '' };
      return { code: 2, stdout: '', stderr: '' };
    };
    const source = createWorkspaceSource({ workspaceRootIds: true, roots: ROOTS, exec });
    const snap = await source.fetch({ rootId: 'team-b', path: 'app' });
    assert.equal(calls[0][2], path.resolve('/srv/team-b', 'app'));
    assert.equal(snap.rootId, 'team-b');
    assert.equal(snap.path, 'app');
    const blocked = createWorkspaceSource({
      workspaceRootIds: true,
      roots: ROOTS,
      exec: async () => { throw new Error('exec should not run'); },
    });
    await assert.rejects(() => blocked.fetch({ rootId: 'team-a', path: '../team-b/app' }), (err) => err.code === 'validation_failed');
    await assert.rejects(() => blocked.fetch({ path: 'app' }), (err) => err.details && err.details[0].issue === 'root-required');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-out-'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const linked = createWorkspaceSource({
      workspaceRootIds: true,
      roots: [{ id: 'team-a', path: root }],
      exec: async () => { throw new Error('exec should not run'); },
    });
    await assert.rejects(() => linked.fetch({ path: 'escape' }), (err) => err.code === 'validation_failed');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('matches a session cwd to the root that contains it', () => {
    const projects = [
      { id: 'prj_a', archivedAt: null, lastActivityAt: AT, flags: [], repo: null, sources: [{ kind: 'workspace', ref: { rootId: 'team-a', path: 'app' } }] },
      { id: 'prj_b', archivedAt: null, lastActivityAt: AT, flags: [], repo: null, sources: [{ kind: 'workspace', ref: { rootId: 'team-b', path: 'app' } }] },
    ];
    const session = { key: 'cwd-app', updatedAt: AT, cwd: '/srv/team-a/app', usage: { total: 1 } };
    const linked = linkProjectActivity({ projects, sessions: [session], workspaceRoots: ROOTS, now: AT });
    assert.deepEqual(linked.matches.map((match) => match.projectId), ['prj_a']);
  });
});
