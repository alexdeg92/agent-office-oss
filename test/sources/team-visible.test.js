'use strict';
// The agent-team-pm skill's team must reach Office on a default install: discovery under the usual
// project folder, a repository label, and members joined to their herdr panes as the skill writes them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { configuredAllowRoots, discoverTeamStoreRoots } = require('../../src/sources/team-store-discovery');
const { createConfiguredOrchestrators } = require('../../src/sources/configured-orchestrators');
const { createOrchestratorTeamSnapshots } = require('../../src/sources/orchestrator-team-snapshots');
const { createHerdrReader } = require('../../src/adapters/herdr/reader');
const { createTeamStoreReader } = require('../../src/adapters/agent-team-pm/store-reader');
const { createEngine } = require('../../src/engine');

const memberId = n => 'member:' + n.repeat(32);
// Exactly what the team skill writes: the lead registered implicitly as a bare spawner record,
// workers with their herdr pane, `claude` runtime and herdr `id` session kind; codex has no session.
const skillMembers = () => [
  { id: memberId('a'), name: 'pm', registered: '2026-11-10T15:45:30' },
  { id: memberId('b'), name: 'backend', role: 'backend', runtime: 'claude', herdrPane: 'w9:p3', session: { source: 'herdr:claude', kind: 'id', value: 'session-backend' }, spawnedBy: memberId('a') },
  { id: memberId('c'), name: 'ui', role: 'frontend', runtime: 'cursor', herdrPane: 'w9:p4', session: { source: 'herdr:cursor', kind: 'id', value: 'session-ui' }, spawnedBy: memberId('a') },
  { id: memberId('d'), name: 'investigator', role: 'investigator', runtime: 'codex', herdrPane: 'w9:p5', spawnedBy: memberId('a') },
];
const herdrPanes = (extra = []) => [
  { pane_id: 'w9:p2', agent: 'claude', name: 'pm', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'session-pm' } },
  { pane_id: 'w9:p3', agent: 'claude', name: 'backend', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'session-backend' } },
  { pane_id: 'w9:p4', agent: 'cursor', name: 'ui', agent_status: 'done', agent_session: { agent: 'cursor', kind: 'id', source: 'herdr:cursor', value: 'session-ui' } },
  { pane_id: 'w9:p5', agent: 'codex', name: 'investigator', agent_status: 'working' },
  ...extra,
];
const herdrOutput = panes => ({ stdout: Buffer.from(JSON.stringify({ id: 1, result: { type: 'agent_list', agents: panes } })) });
async function writeStore(store, members = skillMembers()) {
  for (const dir of ['members', 'tasks', 'inbox']) await fs.mkdir(path.join(store, dir), { recursive: true });
  for (const { file, ...member } of members) await fs.writeFile(path.join(store, 'members', (file || member.name) + '.json'), JSON.stringify(member));
}

test('default team-store allow roots cover the usual capitalised project folder under HOME', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-visible-roots-'));
  try {
    await fs.mkdir(path.join(home, 'Dev'));
    await fs.mkdir(path.join(home, 'Documents'));
    const roots = configuredAllowRoots({ HOME: home });
    assert.deepEqual(roots, [await fs.realpath(path.join(home, 'Dev'))], 'only existing conventional project folders, never HOME itself or other folders');
    assert.deepEqual(configuredAllowRoots({ HOME: home, AO_TEAM_STORE_ALLOW_ROOTS: '' }), [], 'an explicit empty setting still disables discovery');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('a store found through any worktree is labelled after its repository', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-visible-label-'));
  try {
    const repo = path.join(home, 'Dev', 'agent-office'), common = path.join(repo, '.git');
    await writeStore(path.join(common, 'team'));
    const worktree = path.join(home, 'Dev', 'agent-office-fix-error-messages'), gitdir = path.join(common, 'worktrees', 'agent-office-fix-error-messages');
    await fs.mkdir(gitdir, { recursive: true }); await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    await fs.writeFile(path.join(gitdir, 'commondir'), '../..\n');
    const result = discoverTeamStoreRoots({ projectDirectories: [worktree, repo], env: { HOME: home } });
    assert.deepEqual(result.stores.map(store => store.label), ['agent-office']);
    const bare = path.join(home, 'Dev', 'mirror.git'), bareWorktree = path.join(home, 'Dev', 'mirror-work'), bareGitdir = path.join(bare, 'worktrees', 'work');
    await fs.mkdir(path.join(bare, 'team'), { recursive: true }); await fs.mkdir(bareGitdir, { recursive: true }); await fs.mkdir(bareWorktree, { recursive: true });
    await fs.writeFile(path.join(bareWorktree, '.git'), `gitdir: ${bareGitdir}\n`);
    await fs.writeFile(path.join(bareGitdir, 'commondir'), '../..\n');
    assert.deepEqual(discoverTeamStoreRoots({ projectDirectories: [bareWorktree], env: { HOME: home } }).stores.map(store => store.label), ['mirror']);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

async function joined(t, panes, members = skillMembers()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-visible-join-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeStore(root, members);
  const herdr = createHerdrReader({ binaryPath: '/fixture/bin/herdr', hostId: 'host_fixture', orchestratorId: 'orchestrator_fixture', platform: 'linux',
    env: {}, supportsStableSessionRef: true, run: async () => herdrOutput(panes) });
  const snapshots = createOrchestratorTeamSnapshots({ herdr, teamStore: createTeamStoreReader({ root, label: 'agent-office' }) });
  await snapshots.refresh();
  return Object.fromEntries(snapshots.getSnapshot().members.map(member => [member.name, member]));
}

test('every member the skill registered joins its herdr pane, including the lead written without pane metadata', async t => {
  const members = await joined(t, herdrPanes());
  assert.deepEqual(Object.keys(members).sort(), ['backend', 'investigator', 'pm', 'ui']);
  for (const name of Object.keys(members)) assert.equal(typeof members[name].hostAgentId, 'string', name + ' is linked to its pane');
  assert.equal(members.backend.sessionStatus, 'known');
  assert.equal(members.pm.sessionStatus, 'unknown', 'a name join never claims a recorded session');
});

test('the name join stays off when the name is ambiguous among panes or members', async t => {
  const twoPanes = await joined(t, herdrPanes([{ pane_id: 'w7:p1', agent: 'claude', name: 'pm', agent_status: 'idle' }]));
  assert.equal(twoPanes.pm.hostAgentId, null, 'another workspace pane with the same name');
  const twoMembers = await joined(t, herdrPanes(), [...skillMembers(), { file: 'pm-copy', id: memberId('e'), name: 'pm', registered: '2026-11-10T15:45:30' }]);
  assert.ok(Object.values(twoMembers).every(member => member.name !== 'pm' || member.hostAgentId === null));
  const recorded = await joined(t, herdrPanes(), skillMembers().map(member => member.name === 'pm'
    ? { ...member, session: { source: 'herdr:claude', kind: 'id', value: 'session-elsewhere' } } : member));
  assert.equal(recorded.pm.hostAgentId, null, 'a recorded session that matches no pane is not overridden by the name');
});

test('team and herdr sources are registered again when the runtime controller replaces its engine', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-visible-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeStore(root);
  const first = createEngine(), second = createEngine();
  let current = first;
  // The runtime controller exposes one stable proxy over whichever engine is current.
  const engine = new Proxy({}, { get: (_, key) => { const value = current[key]; return typeof value === 'function' ? value.bind(current) : value; } });
  const source = createConfiguredOrchestrators({ engine, env: { HOME: root, PATH: '' }, binaryPath: '/fixture/bin/herdr', enabled: true, hostId: 'host_fixture',
    teamRoot: root, run: async () => herdrOutput(herdrPanes()), setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
  t.after(() => { source.close(); first.close?.(); second.close?.(); });
  const admitted = async () => {
    await source.refresh(); await new Promise(resolve => setImmediate(resolve));
    return current.orchestrationProjectionSnapshot()?.members?.length || 0;
  };
  assert.equal(await admitted(), 4);
  current = second;
  assert.equal(await admitted(), 4, 'the new engine receives the team without a restart');
});

test('a codex member with the session herdr recorded merges with its codex connector session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-visible-codex-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // After the skill enriches members, codex workers carry herdr's `id` session, which is the rollout session_meta id.
  await writeStore(root, skillMembers().map(member => member.name === 'investigator'
    ? { ...member, session: { source: 'herdr:codex', kind: 'id', value: 'session-investigator' } } : member));
  const panes = herdrPanes().map(pane => pane.name === 'investigator'
    ? { ...pane, agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 'session-investigator' } } : pane);
  const herdr = createHerdrReader({ binaryPath: '/fixture/bin/herdr', hostId: 'host_fixture', orchestratorId: 'orchestrator_fixture', platform: 'linux',
    env: {}, supportsStableSessionRef: true, run: async () => herdrOutput(panes) });
  const sessions = [{ id: 'rt:codex:session:k1', sessionKey: 'rt:codex:session:k1', agentId: 'rt:codex:agent:project-1', hostId: 'host_fixture', runtimeKind: 'codex', sessionRef: 'session-investigator' }];
  const snapshots = createOrchestratorTeamSnapshots({ herdr, teamStore: createTeamStoreReader({ root, label: 'agent-office' }), runtimeIdentitySessions: () => sessions });
  await snapshots.refresh();
  const snapshot = snapshots.getSnapshot(), investigator = snapshot.members.find(member => member.name === 'investigator');
  assert.equal(investigator.sessionStatus, 'known');
  assert.equal(snapshot.privateMemberSessionKeys[investigator.id], 'rt:codex:session:k1');
  assert.equal(snapshot.privateMemberSessionRefs[investigator.id].agentId, 'rt:codex:agent:project-1', 'the codex connector agent is claimed by the member');
});
