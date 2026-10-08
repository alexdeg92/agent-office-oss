'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { linkProjectActivity, commands } = require('../../src/projects');
const { AT, repository } = require('./helpers');

const SNOW = '10000078901234567';
const CHANNEL = '10000078901234568';

function session(overrides = {}) {
  const cls = overrides.class || {};
  const usage = overrides.usage || {};
  const run = overrides.run || {};
  return {
    key: overrides.key || `agent:main:discord:user:${SNOW}:chat`,
    sessionId: null,
    class: {
      kind: 'chat-direct',
      ruleId: 'chat',
      agentId: 'main',
      channel: 'discord',
      heartbeatOf: null,
      background: false,
      rawClassification: null,
      interlocutorId: `discord-user:${SNOW}`,
      ...cls,
    },
    displayName: overrides.displayName ?? null,
    model: null,
    provider: null,
    usage: { total: 10, input: 4, output: 6, ...usage },
    updatedAt: overrides.updatedAt === undefined ? AT : overrides.updatedAt,
    run: {
      status: 'idle',
      endReason: null,
      evidence: 'none',
      startedAt: null,
      endedAt: null,
      hasActiveSubagentRun: false,
      runtimeMs: null,
      lastRunId: null,
      lastError: null,
      ...run,
    },
    costUsd: null,
    parentKey: null,
    childKeys: [],
    goal: overrides.goal === undefined ? null : overrides.goal,
    interactive: true,
    cwd: overrides.cwd === undefined ? null : overrides.cwd,
    messageCount: overrides.messageCount === undefined ? null : overrides.messageCount,
  };
}

function project(id, sources, extra = {}) {
  return {
    id,
    archivedAt: null,
    lastActivityAt: AT,
    sources,
    flags: [],
    repo: null,
    ...extra,
  };
}

function goal(objective) {
  return { objective, status: 'active', tokensUsed: null, tokenBudget: null };
}

function cronRun(overrides = {}) {
  return {
    id: 'daily@1',
    jobId: 'daily',
    sessionKey: null,
    at: AT + 10,
    action: null,
    status: 'succeeded',
    completionStatus: null,
    durationMs: 1500,
    nextRunAt: null,
    model: null,
    usage: null,
    delivery: { status: null, delivered: null, channel: null },
    summary: '',
    error: null,
    ...overrides,
  };
}

function keysOf(result, id) {
  return (result.byProject[id].history || []).map((event) => event.dedupeKey);
}

describe('project activity linking', () => {
  it('links sessions by session group, explicit key, and cwd', () => {
    const chat = session({ key: 'chat-Owner' });
    const other = session({
      key: 'chat-other',
      class: { interlocutorId: `discord-user:${CHANNEL}`, agentId: 'main' },
    });
    const listed = session({ key: 'agent:main:explicit:portal', class: { interlocutorId: undefined, kind: 'explicit' } });
    const heartbeat = session({
      key: 'chat-Owner:heartbeat',
      class: { heartbeatOf: 'chat-Owner', background: true, interlocutorId: `discord-user:${SNOW}` },
    });
    const byCwd = session({
      key: 'cwd-only',
      cwd: '/home/example/dev/sites/demo',
      goal: goal('something else'),
      class: { interlocutorId: undefined, agentId: 'main' },
    });
    const result = linkProjectActivity({
      projects: [
        project('prj_discord', [{ kind: 'sessionGroup', ref: { by: 'interlocutor', interlocutorId: `discord-user:${SNOW}` } }]),
        project('prj_keys', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['agent:main:explicit:portal'] } }]),
        project('prj_explicit', []),
        project('prj_folder', [{ kind: 'workspace', ref: { path: 'sites/demo' } }]),
      ],
      sessions: [chat, other, listed, heartbeat, byCwd],
      links: [{ projectId: 'prj_explicit', sessionKey: 'chat-Owner' }],
      now: AT,
    });

    assert.deepEqual(keysOf(result, 'prj_discord'), [`session:chat-Owner@${AT}`]);
    assert.deepEqual(keysOf(result, 'prj_keys'), [`session:agent:main:explicit:portal@${AT}`]);
    assert.deepEqual(keysOf(result, 'prj_explicit'), [`session:chat-Owner@${AT}`]);
    assert.deepEqual(keysOf(result, 'prj_folder'), ['session:cwd-only@' + AT]);
    assert.equal(result.matches.some((match) => match.ref === heartbeat.key), false);
    assert.equal(result.byProject.prj_discord.history[0].messages, null);
    assert.equal(result.byProject.prj_discord.history[0].tokens, 10);
  });

  it('prefers cwd over the goal and keeps a real zero message count', () => {
    const elsewhere = session({
      key: 's-cwd',
      cwd: '/home/example/dev/sites/demo',
      goal: goal('please patch work/app'),
      messageCount: 0,
      class: { interlocutorId: undefined },
    });
    const goalOnly = session({
      key: 's-goal',
      cwd: null,
      goal: goal('please patch work/app'),
      class: { interlocutorId: undefined },
    });
    const result = linkProjectActivity({
      projects: [
        project('prj_demo', [{ kind: 'workspace', ref: { path: 'sites/demo' } }]),
        project('prj_app', [{ kind: 'workspace', ref: { path: 'work/app' } }]),
      ],
      sessions: [elsewhere, goalOnly],
      now: AT,
    });
    assert.deepEqual(keysOf(result, 'prj_demo'), [`session:s-cwd@${AT}`]);
    assert.equal(result.byProject.prj_demo.history[0].messages, 0);
    assert.deepEqual(keysOf(result, 'prj_app'), [`session:s-goal@${AT}`]);
    assert.equal(result.byProject.prj_app.history[0].messages, null);
  });

  it('matches a workspace folder in the goal, keeps distinct folders, and drops a shared path', () => {
    const demo = session({
      key: 's-demo',
      goal: goal('please patch sites/demo/src and leave sites/demo-extra'),
      class: { interlocutorId: undefined },
    });
    const both = session({
      key: 's-both',
      goal: goal('compare work/app with work/web'),
      class: { interlocutorId: undefined },
    });
    const shared = session({
      key: 's-shared',
      goal: goal('open notes/pad'),
      class: { interlocutorId: undefined },
    });
    const result = linkProjectActivity({
      projects: [
        project('prj_short', [{ kind: 'workspace', ref: { path: 'sites' } }]),
        project('prj_demo', [{ kind: 'workspace', ref: { path: 'sites/demo' } }]),
        project('prj_app', [{ kind: 'workspace', ref: { path: 'work/app' } }]),
        project('prj_web', [{ kind: 'workspace', ref: { path: 'work/web' } }]),
        project('prj_a', [{ kind: 'workspace', ref: { path: 'notes/pad' } }]),
        project('prj_b', [{ kind: 'workspace', ref: { path: 'notes/pad' } }]),
      ],
      sessions: [demo, both, shared],
      now: AT,
    });

    assert.deepEqual(keysOf(result, 'prj_demo'), [`session:s-demo@${AT}`]);
    assert.equal(result.byProject.prj_short.history.length, 0);
    assert.deepEqual(keysOf(result, 'prj_app'), [`session:s-both@${AT}`]);
    assert.deepEqual(keysOf(result, 'prj_web'), [`session:s-both@${AT}`]);
    assert.equal(result.byProject.prj_a.history.length, 0);
    assert.equal(result.byProject.prj_b.history.length, 0);
    const conflict = result.ambiguous.find((item) => item.ref === 's-shared');
    assert.deepEqual(conflict.projectIds, ['prj_a', 'prj_b']);
  });

  it('links commits from the GitHub source and an explicit sha', () => {
    const repo = {
      owner: 'alexdeg92',
      name: 'Demo',
      defaultBranch: 'main',
      commits: [{ sha: 'abc1234', at: AT + 5, author: { name: 'owner', personId: null }, message: 'Ship' }],
    };
    const result = linkProjectActivity({
      projects: [
        project('prj_demo', [{ kind: 'github', ref: { owner: 'AlexDeg92', repo: 'Demo' } }], { repo }),
        project('prj_other', [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'other' } }], {
          repo: { ...repo, name: 'other', commits: [] },
        }),
        project('prj_note', []),
      ],
      commits: [
        { owner: 'alexdeg92', name: 'other', sha: 'def5678', at: AT + 6, branch: 'dev' },
        { owner: 'alexdeg92', name: 'foreign', sha: 'fff9999', at: AT + 7, branch: 'main' },
      ],
      links: [{ projectId: 'prj_note', sha: 'abc1234' }],
      now: AT,
    });

    assert.deepEqual(result.byProject.prj_demo.ingest.commits, [{ sha: 'abc1234', branch: 'main', at: AT + 5 }]);
    assert.equal(result.byProject.prj_demo.history[0].dedupeKey, 'commit:abc1234');
    assert.deepEqual(result.byProject.prj_other.ingest.commits, [{ sha: 'def5678', branch: 'dev', at: AT + 6 }]);
    assert.equal(result.matches.some((match) => match.ref === 'fff9999'), false);
    assert.equal(result.byProject.prj_note.history[0].dedupeKey, 'commit:abc1234');
    assert.equal(result.byProject.prj_note.history[0].via, undefined);
  });

  it('does not guess when two active projects claim one repo', () => {
    const commit = { sha: 'abc1234', at: AT, author: { name: 'owner', personId: null }, message: 'x' };
    const repo = { owner: 'alexdeg92', name: 'demo', defaultBranch: 'main', commits: [commit] };
    const result = linkProjectActivity({
      projects: [
        project('prj_a', [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } }], { repo }),
        project('prj_b', [{ kind: 'github', ref: { owner: 'alexdeg92', repo: 'demo' } }], { repo }),
      ],
      now: AT,
    });
    assert.equal(result.byProject.prj_a.history.length, 0);
    assert.equal(result.byProject.prj_b.history.length, 0);
    assert.deepEqual(result.ambiguous[0].projectIds, ['prj_a', 'prj_b']);
  });

  it('turns linked cron jobs into flow runs and touching sessions into cron runs', () => {
    const chat = session({ key: 'chat-Owner', updatedAt: AT + 3 });
    const result = linkProjectActivity({
      projects: [
        project('prj_flow', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['chat-Owner'] } }]),
      ],
      sessions: [chat],
      cronJobs: [{ id: 'nightly', sessionKey: 'chat-Owner' }],
      cronRuns: [
        cronRun({ id: 'digest@1', jobId: 'digest', status: 'failed', at: AT + 1, durationMs: 20 }),
        cronRun({ id: 'digest@1', jobId: 'digest', status: 'running', at: AT + 2 }),
        cronRun({ id: 'nightly@1', jobId: 'nightly', status: 'succeeded', at: AT + 4, sessionKey: null }),
        cronRun({ id: 'odd@1', jobId: 'odd', status: 'unrecognized', at: AT + 5, sessionKey: 'chat-Owner' }),
      ],
      links: [{ projectId: 'prj_flow', jobId: 'digest' }],
      transcripts: [{
        sessionKey: 'chat-Owner', fetchedAt: AT, messageCount: 4,
        window: { from: 0, to: 4 }, events: [],
      }],
      now: AT + 9,
    });
    const bucket = result.byProject.prj_flow;
    assert.deepEqual(bucket.history.map((event) => event.dedupeKey), [
      `session:chat-Owner@${AT + 3}`,
      'cron-run:nightly@1',
    ]);
    assert.equal(bucket.history.some((event) => event.kind === 'flow-run'), false);
    assert.equal(bucket.history.find((event) => event.kind === 'session').messages, 4);
    assert.equal(bucket.riskInput.flows.some((item) => item.status === 'running'), true);
    assert.equal(bucket.riskInput.crons.map((item) => item.runId).includes('odd@1'), false);
    assert.deepEqual(bucket.riskPlan.raise.map((item) => item.key), []);
  });

  it('feeds evaluateRisks: a newer success clears, another failure stays, a manual flag stays', () => {
    const chat = session({ key: 'chat-Owner' });
    const manual = {
      kind: 'risk', key: 'cron-failing', origin: 'manual', severity: 'high',
      evidence: null, raisedAt: AT, clearedAt: null, ack: null,
    };
    const result = linkProjectActivity({
      projects: [
        project('prj_ok', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['chat-Owner'] } }]),
        project('prj_manual', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['chat-Owner'] } }], {
          flags: [manual],
        }),
      ],
      sessions: [chat],
      cronRuns: [
        cronRun({ id: 'a-old', jobId: 'a', status: 'failed', at: AT + 1, sessionKey: 'chat-Owner' }),
        cronRun({ id: 'a-new', jobId: 'a', status: 'succeeded', at: AT + 2, sessionKey: 'chat-Owner' }),
        cronRun({ id: 'b-bad', jobId: 'b', status: 'failed', at: AT + 3, sessionKey: 'chat-Owner' }),
      ],
      links: [{ projectId: 'prj_ok', jobId: 'digest' }],
      now: AT + 4,
    });
    assert.deepEqual(result.byProject.prj_ok.riskPlan.raise.map((item) => item.key), ['cron-failing']);
    assert.equal(result.byProject.prj_ok.riskPlan.raise[0].evidence.ref, 'b-bad');
    assert.deepEqual(result.byProject.prj_manual.riskPlan.raise, []);
    assert.deepEqual(result.byProject.prj_manual.riskPlan.clear, []);
  });

  it('raises flow-failing from an explicitly linked job', () => {
    const result = linkProjectActivity({
      projects: [project('prj_flow', [])],
      cronRuns: [cronRun({ id: 'digest@9', jobId: 'digest', status: 'failed', at: AT + 8 })],
      links: [{ projectId: 'prj_flow', jobId: 'digest' }],
      now: AT + 8,
    });
    const bucket = result.byProject.prj_flow;
    assert.equal(bucket.history[0].kind, 'flow-run');
    assert.equal(bucket.history[0].dedupeKey, 'flow-run:digest@9');
    assert.deepEqual(bucket.riskPlan.raise.map((item) => item.key), ['flow-failing']);
    assert.equal(bucket.riskInput.crons.length, 0);
  });

  it('suggests Timmy, subagents, and Discord humans from linked sessions', () => {
    const timmy = session({ key: 'agent:main:main', class: { agentId: 'main', interlocutorId: undefined, kind: 'explicit' } });
    const sub = session({
      key: 'agent:main:subagent:research',
      class: { agentId: 'main', subagentId: 'research', kind: 'subagent', interlocutorId: undefined },
    });
    const human = session({ key: 'chat-Owner' });
    const channel = session({
      key: 'chat-room',
      class: { interlocutorId: `discord-channel:${CHANNEL}`, agentId: 'main' },
    });
    const stranger = session({ key: 'stranger', class: { agentId: 'other', interlocutorId: `discord-user:${CHANNEL}` } });
    const result = linkProjectActivity({
      projects: [project('prj_one', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['agent:main:main', 'agent:main:subagent:research', 'chat-Owner', 'chat-room'] } }])],
      sessions: [timmy, sub, human, channel, stranger],
      agents: [{ id: 'main', name: 'Timmy', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'agent:main:main' }],
      now: AT,
    });
    assert.deepEqual(result.byProject.prj_one.people, [
      { kind: 'agent', name: 'Timmy', links: { agentId: 'main' }, sessionKeys: ['agent:main:main', 'chat-Owner', 'chat-room'] },
      { kind: 'agent', name: null, links: { agentId: 'main', subagentId: 'research' }, sessionKeys: ['agent:main:subagent:research'] },
      { kind: 'human', name: null, links: { discordUserId: SNOW }, sessionKeys: ['chat-Owner'] },
    ]);
  });

  it('keeps the same dedupe keys across a second pass and a restart-shaped copy', () => {
    const input = {
      projects: [project('prj_one', [{ kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['chat-Owner'] } }])],
      sessions: [session({ key: 'chat-Owner', updatedAt: AT + 4 })],
      cronRuns: [cronRun({ id: 'daily@4', jobId: 'daily', status: 'failed', sessionKey: 'chat-Owner', at: AT + 4 })],
      now: AT + 4,
    };
    const once = linkProjectActivity(input);
    const twice = linkProjectActivity(input);
    const restarted = linkProjectActivity(JSON.parse(JSON.stringify(input)));
    assert.deepEqual(twice, once);
    assert.deepEqual(restarted.byProject.prj_one.history, once.byProject.prj_one.history);
    const moved = linkProjectActivity({ ...input, sessions: [session({ key: 'chat-Owner', updatedAt: AT + 9 })] });
    assert.equal(moved.byProject.prj_one.history.some((event) => event.dedupeKey === `session:chat-Owner@${AT + 9}`), true);
    assert.equal(moved.byProject.prj_one.history.some((event) => event.dedupeKey === `session:chat-Owner@${AT + 4}`), false);
  });

  it('ingests the adapter output once when the same snapshot is applied twice', () => {
    const repo = repository();
    const created = commands.createProject(repo, { name: 'Portail', actor: 'owner', at: AT });
    const linked = commands.linkSource(repo, {
      id: created.id,
      expectedRevision: 1,
      actor: 'owner',
      at: AT,
      source: { kind: 'sessionGroup', ref: { by: 'keys', sessionKeys: ['chat-Owner'] } },
    });
    const result = linkProjectActivity({
      projects: [linked],
      sessions: [session({ key: 'chat-Owner', updatedAt: AT + 20, usage: { total: 8 } })],
      cronRuns: [cronRun({ id: 'daily@20', jobId: 'daily', status: 'failed', sessionKey: 'chat-Owner', at: AT + 30 })],
      now: AT + 30,
    });
    const payload = {
      id: created.id,
      actor: 'system',
      component: 'engine',
      ...result.byProject[created.id].ingest,
    };
    commands.ingestActivity(repo, payload);
    const again = commands.ingestActivity(repo, payload);
    assert.equal(again.revision, 2);
    const derived = repo.getHistory(created.id).events.filter((event) => event.kind === 'session' || event.kind === 'cron-run');
    assert.equal(derived.length, 2);
    assert.equal(derived.find((event) => event.kind === 'cron-run').dedupeKey, 'cron-run:daily@20');
    assert.equal(derived.find((event) => event.kind === 'session').dedupeKey, `session:chat-Owner@${AT + 20}`);
    assert.equal(repo.getProject(created.id).lastActivityAt, AT + 30);
  });

  it('skips archived projects and does not call the gateway', () => {
    const result = linkProjectActivity({
      projects: [project('prj_old', [{ kind: 'workspace', ref: { path: 'sites/demo' } }], { archivedAt: AT })],
      sessions: [session({ key: 's', goal: goal('sites/demo'), class: { interlocutorId: undefined } })],
      now: AT,
    });
    assert.equal(result.byProject.prj_old, undefined);
    const src = fs.readFileSync(path.join(__dirname, '../../src/projects/activity.js'), 'utf8');
    assert.equal(/require\([^)]*(child_process|gateway|openclaw|engine)/.test(src), false);
  });
});
