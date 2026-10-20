'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfiguredOrchestrators } = require('../../src/sources/configured-orchestrators');
const { createEngine } = require('../../src/engine');

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

test('configured Herdr and team adapters feed canonical engine rows while keeping exact refs private', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-engine-team-source-'));
  const engine = createEngine(); t.after(() => engine.close());
  try {
    for (const directory of ['members', 'tasks', 'inbox']) await fs.mkdir(path.join(root, directory));
    const member = { id: 'member:11111111-1111-4111-8111-111111111111', name: 'builder', role: 'builder', runtime: 'codex',
      herdrPane: 'pane-builder', session: { source: 'herdr:codex', kind: 'agent_session', value: 'shared-session' }, spawnedBy: null };
    await fs.writeFile(path.join(root, 'members', 'builder.json'), JSON.stringify(member), { mode: 0o600 });
    const source = createConfiguredOrchestrators({ engine, env: { HOME: '/tmp/fixture', PATH: '' }, binaryPath: '/fixture/bin/herdr',
      hostId: 'host_fixture', teamRoot: root, now: () => Date.now(),
      runtimeIdentityAgents: hostId => [{ id: 'runtime-agent', hostId, runtimeKind: 'codex', sessionRef: 'shared-session' }],
      runtimeIdentitySessions: () => [{ agentId: 'runtime-agent', runtimeKind: 'codex', sessionRef: 'shared-session', sessionKey: 'runtime-session-key' }],
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
    const privateRefs = engine.orchestrationSourcePrivateRefs('agent-team-pm');
    assert.equal(privateRefs[member.id].sessionRef, 'shared-session');
    assert.equal(privateRefs[member.id].memberId, member.id);
    assert.equal(JSON.stringify(engine.orchestrationProjectionSnapshot()).includes('shared-session'), false);
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
