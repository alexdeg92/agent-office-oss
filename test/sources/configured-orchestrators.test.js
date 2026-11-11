'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfiguredOrchestrators } = require('../../src/sources/configured-orchestrators');
const { discoverTeamStoreRoots, MAX_TEAM_STORES } = require('../../src/sources/team-store-discovery');
const { createMultiTeamStoreReader } = require('../../src/sources/multi-team-store-reader');
const { createEngine } = require('../../src/engine');
const { teamProjects } = require('../../src/projects/orchestrator-teams');

test('Herdr source check and activation use only injected fixture I/O and keep correlation refs private', async () => {
  let calls = 0; const now = Date.parse('2026-10-10T20:00:00Z');
  const source = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: '/fixture/bin/herdr', hostId: 'host_fixture',
    runtimeIdentityAgents: hostId => [{ id: 'runtime-main', hostId, runtimeKind: 'claude-code', sessionRef: 'private-session-ref' }],
    run: async (binary, argv) => {
      calls++;
      assert.equal(binary, '/fixture/bin/herdr'); assert.deepEqual(argv, ['agent', 'list']);
      return { stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: [{ pane_id: 'pane-1', agent: 'claude-code',
        name: 'Scribe', agent_status: 'working', agent_session: { value: 'private-session-ref' } }] } })) };
    },
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {}, now: () => now,
  });
  try {
    assert.equal(source.hasHerdr, false, 'presence alone does not activate an unverified source');
    assert.deepEqual(source.herdrCheck, { status: 'not-checked', checkedAt: null });
    assert.deepEqual(await source.checkHerdr(), { found: true, status: 'available', agentCount: 1 });
    assert.equal(source.herdrCheck.status, 'available');
    assert.equal(source.herdrCheck.checkedAt, now);
    assert.equal(calls, 1);
    await source.configureHerdr(true);
    source.start();
    await new Promise(resolve => setImmediate(resolve));
    const snapshot = source.getSnapshot();
    assert.equal(source.hasHerdr, true);
    assert.equal(snapshot.identityLinks.length, 1);
    assert.equal(snapshot.identityLinks[0].agentId, 'runtime-main');
    const publicJson = JSON.stringify(snapshot);
    assert.equal(publicJson.includes('private-session-ref'), false);
    assert.equal(publicJson.includes('agent_session'), false);
    assert.equal(publicJson.includes('/fixture/bin/herdr'), false);
  } finally { source.close(); }
});

test('detected Herdr starts by default, reports poll status, and respects an explicit opt-out', async () => {
  let calls=0,fail=false;const at=Date.parse('2026-10-12T00:00:00Z');
  const options={env:{HOME:'/tmp/fixture',PATH:''},binaryPath:'/fixture/bin/herdr',now:()=>at,
    run:async()=>{calls++;if(fail)throw Error('synthetic read failure');return {stdout:Buffer.from('{"id":"fixture","result":{"type":"ok","agents":[]}}')};}};
  const automatic=createConfiguredOrchestrators(options),disabled=createConfiguredOrchestrators({...options,enabled:false});
  try{
    assert.equal(automatic.active,false);assert.equal(automatic.sourceEnabled,false);assert.equal(disabled.active,false);assert.equal(calls,0,'construction does not run the CLI');
    await automatic.refresh();assert.equal(calls,1);assert.deepEqual(automatic.herdrCheck,{status:'available',checkedAt:at});
    assert.equal(automatic.active,true);assert.equal(automatic.sourceEnabled,true,'a valid response activates the declared default');
    fail=true;await automatic.refresh();assert.deepEqual(automatic.herdrCheck,{status:'stale',checkedAt:at},'poll failures replace the healthy card evidence');fail=false;
    await disabled.checkHerdr();assert.equal(disabled.active,false,'a one-shot test never overrides opt-out');
    await automatic.configureHerdr(false);assert.equal(automatic.active,false);
    const rebooted=createConfiguredOrchestrators({...options,enabled:false});
    try{assert.equal(rebooted.active,false);}finally{rebooted.close();}
  }finally{automatic.close();disabled.close();}
});

test('missing Herdr cannot be enabled and check does not fall back to the host PATH', async () => {
  const source = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: false });
  try {
    assert.deepEqual(await source.checkHerdr(), { found: false, status: 'not-detected', agentCount: 0 });
    assert.deepEqual(await source.configureHerdr(true), { enabled: false, reason: 'not-detected' });
    assert.equal(source.hasHerdr, false);
  } finally { source.close(); }
});

test('an installed but unresponsive source stays off, then activates automatically after recovery', async () => {
  let at=Date.parse('2026-10-12T00:00:00Z'),responding=false;
  const source=createConfiguredOrchestrators({env:{HOME:'/tmp/fixture',PATH:''},binaryPath:'/fixture/bin/herdr',now:()=>at,
    run:async()=>{if(!responding)throw Error('synthetic unavailable');return {stdout:Buffer.from('{"id":"fixture","result":{"type":"ok","agents":[]}}')};}});
  try{
    await source.refresh();assert.equal(source.detected,true);assert.equal(source.sourceEnabled,false);assert.equal(source.hasHerdr,false);
    assert.equal(source.herdrCheck.status,'unavailable');
    at+=2000;responding=true;await source.refresh();
    assert.equal(source.sourceEnabled,true);assert.equal(source.hasHerdr,true,'no owner toggle was needed after recovery');
  }finally{source.close();}
});

test('systemd-style Herdr source accepts an explicit executable path and never falls back when it is invalid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-herdr-bin-'));
  const bin = path.join(root, 'herdr');
  try {
    await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    let selectedBinary = null;
    const source = createConfiguredOrchestrators({ env: { AO_HERDR_BIN: bin, PATH: '' }, run: async binaryPath => {
      selectedBinary = binaryPath;
      return { stdout: Buffer.from('{"id":"x","result":{"type":"ok","agents":[]}}') };
    } });
    const invalid = createConfiguredOrchestrators({ env: { AO_HERDR_BIN: path.join(root, 'missing'), PATH: root }, run: async () => {
      throw new Error('invalid explicit path must not fall back to PATH');
    } });
    try {
      assert.equal(source.detected, true);
      assert.deepEqual(await source.checkHerdr(), { found: true, status: 'available', agentCount: 0 });
      assert.equal(selectedBinary, bin, 'only the explicitly selected executable reaches the adapter');
      assert.equal(invalid.detected, false, 'an invalid explicit path disables Herdr discovery rather than searching PATH');
      assert.deepEqual(await invalid.checkHerdr(), { found: false, status: 'not-detected', agentCount: 0 });
      assert.deepEqual(invalid.herdrCheck.status, 'not-detected');
    } finally { source.close(); invalid.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('agent-team-pm is opt-in through an explicit absolute root and reads its stable member record read-only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-configured-team-root-'));
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.mkdir(path.join(root, directory));
    const record = { id: 'member:11111111-1111-4111-8111-111111111111', name: 'pm', role: 'pm', runtime: 'claude-code', herdrPane: 'pane-pm',
      session: { source: 'herdr:claude', kind: 'agent_session', value: 'private-fixture-session' }, spawnedBy: null };
    const memberFile = path.join(root, 'members', 'pm.json');
    await fs.writeFile(memberFile, JSON.stringify(record), { mode: 0o600 });
    const before = await fs.readFile(memberFile, 'utf8');
    const absent = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: false, now: () => Date.now() });
    try { assert.equal(absent.hasTeamStore, false, 'no implicit home-directory discovery'); } finally { absent.close(); }
    const source = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: false, teamRoot: root });
    try {
      assert.equal(source.hasTeamStore, true);
      await source.refresh();
      assert.equal(source.getSnapshot().members[0].id, record.id);
      assert.equal(JSON.stringify(source.getSnapshot()).includes('private-fixture-session'), false);
      assert.equal(await fs.readFile(memberFile, 'utf8'), before, 'the source reader does not write to the selected root');
    } finally { source.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('discovers a bounded team store per Herdr pane cwd under allowed roots and retains the explicit extra root', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-home-'));
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-extra-'));
  const optionExtra = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-option-extra-'));
  const repos = ['office', 'kildare'].map(name => path.join(home, 'dev', name));
  const roots = [...repos.map(repo => path.join(repo, '.git', 'team')), path.join(extra, 'env-team'), path.join(optionExtra, 'option-team')];
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  try {
    for (let index = 0; index < roots.length; index++) {
      await fs.mkdir(path.join(roots[index], 'members'), { recursive: true });
      await fs.mkdir(path.join(roots[index], 'tasks'), { recursive: true });
      await fs.writeFile(path.join(roots[index], 'members', `member-${index}.json`), JSON.stringify({
        id: `member:${ids[index]}`, name: `member-${index}`, role: 'member', runtime: 'codex', herdrPane: `pane-${index}`,
      }), { mode: 0o600 });
    }
    for (const repo of repos) await fs.mkdir(path.join(repo, 'packages', 'app'), { recursive: true });
    const panes = repos.map((repo, index) => ({ pane_id: `pane-${index}`, agent: 'codex', name: `Worker ${index}`,
      agent_status: 'working', cwd: path.join(repo, 'packages', 'app') }));
    const source = createConfiguredOrchestrators({ env: { HOME: home, PATH: '', AO_TEAM_STORE_ROOT: roots[2] }, teamRoot: roots[3], enabled: true,
      binaryPath: '/fixture/herdr', run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: panes } })) }) });
    t.after(() => source.close());
    await source.refresh();
    const snapshot = source.getSnapshot();
    assert.equal(source.hasTeamStore, true);
    assert.deepEqual(snapshot.teams.map(team => team.label).sort(), ['kildare', 'office', 'Team', 'Team'].sort());
    assert.deepEqual(snapshot.members.map(member => member.name).sort(), ['member-0', 'member-1', 'member-2', 'member-3']);
    assert.equal(teamProjects(snapshot, {}).length, 4, 'each valid store projects as its own team project');
    assert.equal(JSON.stringify(snapshot).includes(path.join(home, 'dev')), false, 'pane working paths stay private');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(extra, { recursive: true, force: true });
    await fs.rm(optionExtra, { recursive: true, force: true });
  }
});

test('adapter-neutral project directory hints discover roots without Herdr and deduplicate worktrees by common dir', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-runtime-hints-'));
  const common = path.join(home, 'dev', 'shared', '.git');
  const worktrees = ['claude-worktree', 'codex-worktree'].map(name => path.join(home, 'dev', name));
  const team = path.join(common, 'team');
  try {
    await fs.mkdir(path.join(team, 'members'), { recursive: true });
    await fs.mkdir(path.join(team, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(team, 'team.json'), JSON.stringify({ name: 'Platform Crew' }), { mode: 0o600 });
    const member = { id: 'member:88888888-8888-4888-8888-888888888888', name: 'engineer', role: 'member', runtime: 'claude-code' };
    await fs.writeFile(path.join(team, 'members', 'engineer.json'), JSON.stringify(member), { mode: 0o600 });
    for (let index = 0; index < worktrees.length; index++) {
      const repo = worktrees[index], gitdir = path.join(common, 'worktrees', String(index));
      await fs.mkdir(path.join(repo, 'src'), { recursive: true });
      await fs.mkdir(gitdir, { recursive: true });
      await fs.writeFile(path.join(repo, '.git'), `gitdir: ${path.relative(repo, gitdir)}\n`);
      await fs.writeFile(path.join(gitdir, 'commondir'), '../..\n');
    }
    const source = createConfiguredOrchestrators({ env: { HOME: home, PATH: '' }, binaryPath: false,
      projectDirectoryHints: () => [
        { cwd: path.join(worktrees[0], 'src'), adapter: 'claude-code' },
        { cwd: path.join(worktrees[1], 'src'), adapter: 'codex' },
      ] });
    t.after(() => source.close());
    assert.equal(source.hasHerdr, false, 'discovery is independent of Herdr activation');
    await source.refresh();
    assert.equal(source.getSnapshot().teams.length, 1, 'two worktrees with one Git common dir create one team project');
    assert.equal(source.getSnapshot().teams[0].label, 'Platform Crew', 'a validated store label takes precedence over a repository basename');
    assert.equal(source.getSnapshot().members.length, 1);
    const serialized = JSON.stringify(source.getSnapshot());
    assert.equal(serialized.includes(home), false);
    assert.equal(serialized.includes('claude-worktree'), false);
    assert.equal(serialized.includes('codex-worktree'), false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('team-store discovery rejects pane cwd and git-common-dir symlink escapes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-allow-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-outside-'));
  const linkedRepo = path.join(root, 'dev', 'linked');
  const validRepo = path.join(root, 'dev', 'valid');
  const outsideRepo = path.join(outside, 'repo');
  try {
    await fs.mkdir(linkedRepo, { recursive: true });
    await fs.mkdir(path.join(validRepo, '.git', 'team', 'members'), { recursive: true });
    await fs.mkdir(path.join(validRepo, '.git', 'team', 'tasks'), { recursive: true });
    await fs.writeFile(path.join(validRepo, '.git', 'team', 'members', 'inside.json'), JSON.stringify({
      id: 'member:55555555-5555-4555-8555-555555555555', name: 'inside', role: 'member', runtime: 'codex', herdrPane: 'valid-pane',
    }), { mode: 0o600 });
    await fs.mkdir(path.join(outsideRepo, '.git', 'team', 'members'), { recursive: true });
    await fs.mkdir(path.join(outsideRepo, '.git', 'team', 'tasks'), { recursive: true });
    await fs.writeFile(path.join(outsideRepo, '.git', 'team', 'members', 'escape.json'), JSON.stringify({
      id: 'member:44444444-4444-4444-8444-444444444444', name: 'outside', role: 'member', runtime: 'codex', herdrPane: 'escape-pane',
    }), { mode: 0o600 });
    await fs.symlink(outsideRepo, path.join(root, 'linked-cwd'));
    await fs.mkdir(path.join(linkedRepo, '.git'), { recursive: true });
    await fs.symlink(path.join(outsideRepo, '.git', 'team'), path.join(linkedRepo, '.git', 'team'));
    const panes = [
      { pane_id: 'valid-pane', agent: 'codex', name: 'Valid', agent_status: 'working', cwd: validRepo },
      { pane_id: 'cwd-escape', agent: 'codex', name: 'Cwd escape', agent_status: 'working', cwd: path.join(root, 'linked-cwd') },
      { pane_id: 'store-escape', agent: 'codex', name: 'Store escape', agent_status: 'working', cwd: linkedRepo },
    ];
    const source = createConfiguredOrchestrators({ env: { HOME: root, PATH: '' }, enabled: true, binaryPath: '/fixture/herdr',
      run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: panes } })) }) });
    t.after(() => source.close());
    await source.refresh();
    assert.equal(source.hasTeamStore, true);
    assert.deepEqual(source.getSnapshot().members.map(member => member.name), ['inside']);
    assert.equal(JSON.stringify(source.getSnapshot()).includes('outside'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('team-store discovery bounds project-directory and store scans', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-bounds-'));
  try {
    const projectDirectories = [];
    for (let index = 0; index < MAX_TEAM_STORES + 2; index++) {
      const repo = path.join(home, 'dev', `repo-${index}`);
      const cwd = path.join(repo, 'src');
      await fs.mkdir(path.join(repo, '.git', 'team'), { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      projectDirectories.push(cwd);
    }
    const result = discoverTeamStoreRoots({ projectDirectories, env: { HOME: home } });
    assert.equal(result.stores.length, MAX_TEAM_STORES);
    assert.equal(result.truncatedStoreCount, 2);
    const truncated = discoverTeamStoreRoots({ projectDirectories: Array(140).fill(projectDirectories[0]), env: { HOME: home } });
    assert.equal(truncated.scannedDirectoryCount, 1);
    assert.equal(truncated.truncatedDirectoryCount, 12);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('team-store discovery resolves a worktree git common directory within the allowlist', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-discovery-worktree-'));
  try {
    const common = path.join(home, 'dev', 'shared', '.git');
    const gitdir = path.join(common, 'worktrees', 'worker');
    const worktree = path.join(home, 'dev', 'worker');
    const cwd = path.join(worktree, 'src');
    const store = path.join(common, 'team');
    await fs.mkdir(store, { recursive: true });
    await fs.mkdir(gitdir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, gitdir)}\n`);
    await fs.writeFile(path.join(gitdir, 'commondir'), path.relative(gitdir, common));
    const result = discoverTeamStoreRoots({ projectDirectories: [cwd], env: { HOME: home } });
    assert.equal(result.stores.length, 1);
    assert.equal(result.stores[0].root, store);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('team-store metadata reads stay bounded when .git, commondir, or team.json grows after open', async () => {
  for (const targetKind of ['.git', 'commondir', 'team.json']) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-metadata-growth-'));
    try {
      const repo = path.join(home, 'dev', 'repo');
      const cwd = path.join(repo, 'src');
      const common = path.join(home, 'dev', 'shared', '.git');
      const gitdir = path.join(common, 'worktrees', 'repo');
      const team = path.join(common, 'team');
      await fs.mkdir(cwd, { recursive: true });
      let target;
      if (targetKind === '.git') {
        await fs.mkdir(path.join(common, 'team'), { recursive: true });
        await fs.mkdir(gitdir, { recursive: true });
        target = path.join(repo, '.git');
        await fs.writeFile(target, `gitdir: ${path.relative(repo, gitdir)}\n`);
      } else if (targetKind === 'commondir') {
        await fs.mkdir(team, { recursive: true });
        await fs.mkdir(gitdir, { recursive: true });
        await fs.writeFile(path.join(repo, '.git'), `gitdir: ${path.relative(repo, gitdir)}\n`);
        target = path.join(gitdir, 'commondir');
        await fs.writeFile(target, path.relative(gitdir, common));
      } else {
        await fs.mkdir(path.join(repo, '.git', 'team'), { recursive: true });
        target = path.join(repo, '.git', 'team', 'team.json');
        await fs.writeFile(target, JSON.stringify({ name: 'Should Not Be Read' }));
      }

      let grown = false;
      const fdPaths = new Map();
      const fdBytes = new Map();
      const fsx = new Proxy(fsSync, { get(object, property) {
        if (property === 'openSync') return (...args) => {
          const fd = object.openSync(...args);
          fdPaths.set(fd, args[0]);
          fdBytes.set(fd, 0);
          return fd;
        };
        if (property === 'closeSync') return fd => { fdPaths.delete(fd); fdBytes.delete(fd); return object.closeSync(fd); };
        if (property === 'readSync') return (fd, buffer, offset, length, position) => {
          assert.ok(length <= 1024, 'metadata reads use fixed-size bounded chunks');
          if (fdPaths.get(fd) === target && !grown) {
            grown = true;
            object.appendFileSync(target, 'x'.repeat(5000));
          }
          const count = object.readSync(fd, buffer, offset, length, position);
          fdBytes.set(fd, fdBytes.get(fd) + count);
          assert.ok(fdBytes.get(fd) <= 4097, 'at most limit+1 bytes are read from a metadata descriptor');
          return count;
        };
        if (property === 'readFileSync') return filename => {
          assert.notEqual(filename, target, 'metadata must not use an unbounded readFileSync');
          return object.readFileSync(filename);
        };
        const value = object[property];
        return typeof value === 'function' ? value.bind(object) : value;
      } });

      const result = discoverTeamStoreRoots({ projectDirectories: [cwd], env: { HOME: home }, fsx });
      assert.equal(grown, true, `${targetKind} was appended after the descriptor was pinned`);
      if (targetKind === 'team.json') {
        assert.equal(result.stores.length, 1);
        assert.notEqual(result.stores[0].label, 'Should Not Be Read');
      } else assert.equal(result.stores.length, 0, `${targetKind} overflow is rejected`);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  }
});

test('multi-store reader isolates a failing store from successful siblings', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-team-store-isolation-'));
  try {
    const roots = ['healthy', 'unavailable'].map(name => path.join(home, 'dev', name));
    const cwds = [];
    for (const root of roots) {
      await fs.mkdir(path.join(root, '.git', 'team'), { recursive: true });
      cwds.push(root);
    }
    const reader = createMultiTeamStoreReader({ env: { HOME: home }, getProjectDirectories: () => cwds,
      createReader: ({ label }) => ({ refresh: async () => {
        if (label === 'unavailable') throw new Error('private path must not escape');
        return { team: { id: 'team-healthy', label, status: 'active' }, members: [], tasks: [], reviews: [], messages: [] };
      } }) });
    const snapshot = await reader.refresh();
    assert.deepEqual(snapshot.teams.map(team => team.label), ['healthy']);
    assert.equal(snapshot.diagnostics.storeErrorCount, 1);
    reader.close();
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('configured Herdr and team adapters feed canonical engine rows while keeping exact refs private', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-engine-team-source-'));
  const engine = createEngine(); t.after(() => engine.close());
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.mkdir(path.join(root, directory));
    const member = { id: 'member:11111111-1111-4111-8111-111111111111', name: 'builder', role: 'builder', runtime: 'codex',
      herdrPane: 'pane-builder', session: { source: 'herdr:codex', kind: 'agent_session', value: 'shared-session' }, spawnedBy: null };
    await fs.writeFile(path.join(root, 'members', 'builder.json'), JSON.stringify(member), { mode: 0o600 });
    let runtimeSessionRef = 'shared-session';
    const source = createConfiguredOrchestrators({ engine, env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: '/fixture/bin/herdr',
      hostId: 'host_fixture', teamRoot: root, now: () => Date.now(),
      runtimeIdentityAgents: hostId => [{ id: 'runtime-agent', hostId, runtimeKind: 'codex', sessionRef: 'shared-session' }],
      runtimeIdentitySessions: () => [{ agentId: 'runtime-agent', runtimeKind: 'codex', sessionRef: runtimeSessionRef, sessionKey: 'runtime-session-key' }],
      run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: [{ pane_id: 'pane-builder',
        agent: 'codex', name: 'Builder', agent_status: 'working', agent_session: { value: 'shared-session' } }] } })) }),
    });
    t.after(() => source.close());
    await source.refresh();
    const canonical = engine.orchestrationSnapshot();
    assert.equal(canonical.hostAgents.length, 1);
    assert.equal(canonical.members.length, 1);
    assert.equal(canonical.members[0].hostAgentId, canonical.hostAgents[0].id);
    assert.equal(engine.orchestrationSourceStatus().find(row => row.id === 'herdr').status, 'available');
    assert.equal(engine.orchestrationSourceStatus().find(row => row.id === 'agent-team-pm').status, 'available');
    const joined = source.getSnapshot();
    const projection = engine.orchestrationProjectionSnapshot();
    assert.equal(projection.identityRevisions.herdr, joined.runtimeIdentityRevision,
      'the canonical host generation records the exact runtime-identity snapshot used during admission');
    assert.equal(projection.identityRevisions['agent-team-pm'], joined.runtimeIdentityRevision,
      'the team generation records the shared identity snapshot used for member refs and lineage');
    const privateRefs = engine.orchestrationSourcePrivateRefs('agent-team-pm');
    assert.equal(privateRefs[member.id].sessionRef, 'shared-session');
    assert.equal(privateRefs[member.id].memberId, member.id);
    assert.equal(JSON.stringify(projection).includes('shared-session'), false);
    assert.equal(JSON.stringify(projection).includes('identityRevisions'), false);
    const beforeChange = source.getSnapshot();
    const beforeIdentityRevision = projection.identityRevisions.herdr;
    runtimeSessionRef = 'changed-session-ref';
    const compatibilityAfterIdentityChange = source.getSnapshot();
    assert.ok(compatibilityAfterIdentityChange.runtimeIdentityRevision > beforeIdentityRevision,
      'runtime identity changes are detected even without a Herdr or team-store poll');
    assert.equal(compatibilityAfterIdentityChange.hostRevision, beforeChange.hostRevision);
    assert.equal(compatibilityAfterIdentityChange.teamRevision, beforeChange.teamRevision);
    await new Promise(resolve => setImmediate(resolve));
    const caughtUp = engine.orchestrationProjectionSnapshot();
    assert.equal(caughtUp.identityRevisions.herdr, compatibilityAfterIdentityChange.runtimeIdentityRevision,
      'the identity-change notification re-admits the matching generation without advancing source poll revisions');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('team-store-only admission records runtime identity generations with Herdr disabled', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-engine-team-only-identity-'));
  const engine = createEngine(); t.after(() => engine.close());
  try {
    await fs.mkdir(path.join(root, 'members'));
    const member = { id: 'member:22222222-2222-4222-8222-222222222222', name: 'engineer', role: 'member',
      runtime: 'claude-code', herdrPane: null,
      session: { source: 'claude-code', kind: 'agent_session', value: 'session-a' }, spawnedBy: null };
    await fs.writeFile(path.join(root, 'members', 'engineer.json'), JSON.stringify(member), { mode: 0o600 });
    let sessionRef = 'session-a';
    const source = createConfiguredOrchestrators({ engine, env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: false,
      teamRoot: root, now: () => Date.now(),
      runtimeIdentitySessions: () => [{ agentId: 'runtime-agent', runtimeKind: 'claude-code',
        sessionRef, sessionKey: 'runtime-session-key' }] });
    t.after(() => source.close());
    assert.equal(source.hasHerdr, false);
    await source.refresh();
    const firstSnapshot = source.getSnapshot();
    const first = engine.orchestrationProjectionSnapshot();
    assert.equal(first.identityRevisions.herdr, undefined);
    assert.equal(first.identityRevisions['agent-team-pm'], firstSnapshot.runtimeIdentityRevision);
    const teamRevision = first.sourceRevisions['agent-team-pm'];

    sessionRef = 'session-b';
    const changedSnapshot = source.getSnapshot();
    await new Promise(resolve => setImmediate(resolve));
    const caughtUp = engine.orchestrationProjectionSnapshot();
    assert.ok(changedSnapshot.runtimeIdentityRevision > firstSnapshot.runtimeIdentityRevision);
    assert.equal(caughtUp.sourceRevisions['agent-team-pm'], teamRevision,
      'identity re-admission does not pretend a team-store poll occurred');
    assert.equal(caughtUp.identityRevisions['agent-team-pm'], changedSnapshot.runtimeIdentityRevision,
      'the team-only source catches up to the same identity generation used by compatibility projection');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('relative PATH matches and relative explicit paths are ignored without aborting startup', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ao-herdr-relative-'));
  const bin=path.join(root,'herdr'),relative=path.relative(process.cwd(),root);
  try{
    await fs.writeFile(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
    for(const env of [{HOME:root,PATH:relative},{HOME:root,PATH:root,AO_HERDR_BIN:path.join(relative,'herdr')}]){
      const source=createConfiguredOrchestrators({env,run:async()=>{throw Error('a rejected path must never execute');}});
      try{assert.equal(source.detected,false);assert.equal(source.sourceEnabled,false);assert.equal(source.hasHerdr,false);}finally{source.close();}
    }
    let selected;
    const source=createConfiguredOrchestrators({env:{HOME:root,PATH:relative+path.delimiter+root},run:async binary=>{
      selected=binary;return {stdout:Buffer.from('{"id":"fixture","result":{"type":"ok","agents":[]}}')};}});
    try{await source.refresh();assert.equal(source.sourceEnabled,true);assert.equal(selected,bin,'lookup continues to a valid absolute PATH entry');}finally{source.close();}
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('team inbox metadata is off by default and only read with explicit environment opt-in', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-configured-inbox-'));
  const outside = path.join(path.dirname(root), path.basename(root) + '-outside');
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.mkdir(path.join(root, directory));
    await fs.rm(path.join(root, 'inbox'), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'inbox'));
    const disabled = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '', AO_TEAM_STORE_READ_INBOX: '1' }, readInbox: false, binaryPath: false, teamRoot: root });
    const enabled = createConfiguredOrchestrators({ env: { HOME: '/tmp/fixture', PATH: '', AO_TEAM_STORE_READ_INBOX: '1' }, binaryPath: false, teamRoot: root });
    try {
      await Promise.all([disabled.refresh(), enabled.refresh()]);
      assert.equal(disabled.getSnapshot().team.status, 'active', 'explicit false overrides the environment opt-in without inspecting inbox/');
      assert.equal(enabled.getSnapshot().team, null, 'explicit owner opt-in attempts inbox/ and rejects its unsafe symlink');
    } finally { disabled.close(); enabled.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
