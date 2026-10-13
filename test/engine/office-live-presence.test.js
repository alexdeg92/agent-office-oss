'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { buildLogsPage } = require('../../src/api/v2/vm/logs');
const { deriveOccupants, DEFAULT_SESSION_PRESENCE_WINDOW_MS, DEFAULT_AGENT_PRESENCE_WINDOW_MS, isProjectAgentOnStage } = require('../../src/engine/derive/occupants');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');
const t0117Capture = require('../fixtures/t0117-redacted-office-capture.json');

const NOW = Date.UTC(2026, 9, 12, 0, 0);
const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
const olderThanDefault = NOW - DEFAULT_AGENT_PRESENCE_WINDOW_MS - 1;
function session(key, { agentId = 'project-agent', status = 'idle', level = 'observed', updatedAt = twoHoursAgo,
  classKind = 'conversation', expiresAt = null, interactive = true } = {}) {
  return { key, sessionId: key, class: { kind: classKind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null,
    background: false, rawClassification: null }, displayName: key, summary: null, projectLabel: null, model: null, provider: null,
    usage: { total: 0, input: null, output: null }, updatedAt, run: { status, endReason: null,
      evidence: level === 'verified' ? 'status-field' : level === 'observed' ? 'live-activity' : 'none', evidenceLevel: level,
      observedAt: updatedAt, expiresAt, startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null,
      lastRunId: null, lastError: null }, costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null,
    messageCount: null, interactive, group: null };
}

test('live turns and short completed-session waits create session desks; older transcript history stays in logs', () => {
  const closedClaudePane = session('claude:closed-herdr-pane', { updatedAt: olderThanDefault });
  const archivedCodex = session('codex:archived-project', { updatedAt: olderThanDefault });
  const recentCodex = session('codex:recent-project', { updatedAt: NOW - 10 * 60 * 1000 });
  const recentWait = session('claude:recent-wait', { updatedAt: NOW - 2 * 60 * 1000 });
  const completedDiscord = session('discord:completed-chat', { updatedAt: NOW - 16 * 60 * 1000, channel: 'discord' });
  const completedDelegate = session('codex:completed-child', { classKind: 'subagent', updatedAt: NOW - 16 * 60 * 1000 });
  const activeTranscript = session('codex:active-turn', { status: 'running', updatedAt: twoHoursAgo, expiresAt: NOW + 30_000 });
  const rows = [closedClaudePane, archivedCodex, recentCodex, recentWait, completedDiscord, completedDelegate, activeTranscript];
  const activity = () => null;

  const ids = deriveOccupants({ sessions: rows, activityFor: activity, gwConnected: true, now: NOW }).map(row => row.sessionKey);
  assert.equal(ids.includes(closedClaudePane.key), false, 'a closed Herdr pane with only old transcript history leaves the stage');
  assert.equal(ids.includes(archivedCodex.key), false, 'a project transcript older than the project-agent window does not create a desk');
  assert.equal(ids.includes(recentCodex.key), true, 'a recent project session remains available as an idle office occupant');
  assert.equal(ids.includes(recentWait.key), true, 'a recent completed interactive turn is briefly waiting for input');
  assert.equal(ids.includes(completedDiscord.key), false, 'a completed Discord conversation leaves after the short return window');
  assert.equal(ids.includes(completedDelegate.key), false, 'a completed delegated session uses the same short return window');
  assert.equal(ids.includes(activeTranscript.key), true, 'verified/observed running evidence remains on stage even with an old file timestamp');

  const journal = buildLogsPage(rows, { offset: 0, limit: 50, now: NOW }, {}, project3x);
  assert.ok(journal.items.some(row => row.id === archivedCodex.key), 'history remains available in Journaux');
});

test('completed session presence is bounded and configurable independently from project-agent presence', () => {
  const recent = session('session:recent', { updatedAt: NOW - 10 * 60 * 1000 });
  const expiredByDefault = session('session:older', { updatedAt: NOW - DEFAULT_SESSION_PRESENCE_WINDOW_MS - 1 });
  const custom = session('session:custom-window', { updatedAt: NOW - 20 * 60 * 1000 });
  const derive = (rows, presenceWindowMs) => deriveOccupants({ sessions: rows, activityFor: () => null, gwConnected: true, now: NOW, presenceWindowMs });

  assert.ok(derive([recent]).some(row => row.sessionKey === recent.key));
  assert.ok(!derive([expiredByDefault]).some(row => row.sessionKey === expiredByDefault.key));
  assert.ok(derive([custom], 30 * 60 * 1000).some(row => row.sessionKey === custom.key));
  assert.equal(DEFAULT_SESSION_PRESENCE_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_AGENT_PRESENCE_WINDOW_MS, 60 * 60 * 1000);
  const recentProjectSession = session('project-agent:recent-session', { updatedAt: NOW - 30 * 60 * 1000 });
  assert.equal(derive([recentProjectSession]).some(row => row.sessionKey === recentProjectSession.key), false,
    'the completed conversation is not extended by the project-agent window');
  assert.equal(isProjectAgentOnStage([recentProjectSession], NOW), true,
    'the aggregate runtime/project agent remains seated within the separate one-hour window');
  const recentClaudeProject = session('claude:recent-project', { updatedAt: NOW - 30 * 60 * 1000, interactive: false });
  assert.equal(isProjectAgentOnStage([recentClaudeProject], NOW), true,
    'recent normal Claude Code project sessions remain eligible even though that adapter marks them non-interactive');
  const runningClaudeProject = session('claude:running-project', { status: 'running', updatedAt: twoHoursAgo, interactive: false });
  assert.equal(isProjectAgentOnStage([runningClaudeProject], NOW), true,
    'current Claude Code run evidence keeps the project agent seated beyond the quiet window');
  const twoHourProjectSession = session('project-agent:old-session', { updatedAt: NOW - 2 * 60 * 60 * 1000 });
  assert.equal(isProjectAgentOnStage([twoHourProjectSession], NOW), false,
    'agents active earlier today still leave after the default one-hour quiet window');
  assert.equal(isProjectAgentOnStage([twoHourProjectSession], NOW, () => null, 3 * 60 * 60 * 1000), true,
    'an instance can deliberately extend the bounded project-agent quiet window');
  assert.equal(isProjectAgentOnStage([session('project-agent:stale', { updatedAt: olderThanDefault })], NOW), false,
    'a stale project agent without live activity leaves');
  assert.equal(isProjectAgentOnStage([session('project-agent:live-old', { status: 'running', updatedAt: NOW - 2 * 60 * 60 * 1000 })], NOW), true,
    'current run evidence keeps a project agent seated beyond the quiet window');
  assert.equal(isProjectAgentOnStage([session('project-agent:child', { classKind: 'subagent', updatedAt: NOW - 5 * 60 * 1000 })], NOW), false,
    'a child-session history does not create a second aggregate project-agent row');
  const staleParent = session('project-agent:old-parent', { updatedAt: twoHoursAgo });
  const liveChild = session('project-agent:live-child', { classKind: 'subagent', status: 'running', updatedAt: NOW });
  assert.equal(isProjectAgentOnStage([staleParent, liveChild], NOW), true,
    'a live child run keeps its stale parent project-agent row seated');
  const activeChild = session('project-agent:active-child', { classKind: 'subagent', updatedAt: twoHoursAgo });
  assert.equal(isProjectAgentOnStage([staleParent, activeChild], NOW, key => key === activeChild.key ? 'thinking' : null), true,
    'current child activity also keeps its stale parent project-agent row seated');
  const finishedChildHistory = session('project-agent:finished-child', { classKind: 'subagent', updatedAt: NOW - 5 * 60 * 1000 });
  assert.equal(isProjectAgentOnStage([staleParent, finishedChildHistory], NOW), false,
    'completed child history does not extend an otherwise stale parent project-agent quiet window');
});

test('a verified terminal run fences its older still-live transcript lease from working state', () => {
  const succeededChild = session('subagent:finished', { classKind: 'subagent', status: 'succeeded', level: 'verified',
    updatedAt: NOW - 5 * 60 * 1000, expiresAt: NOW + 30_000 });
  const activity = key => key === succeededChild.key ? 'working' : null;
  const projected = deriveOccupants({ sessions: [succeededChild], activityFor: activity, gwConnected: true, now: NOW });
  assert.deepEqual(projected.map(row => row.sessionKey), [null, succeededChild.key], 'recent completion remains available during the short return window');
  assert.equal(projected[1].state, 'idle', 'terminal completion fences the earlier activity lease instead of appearing working');
});

test('unconfigured transcript agents leave the roster while configured and primary agents stay inactive', () => {
  const primary = session('runtime:main', { agentId: 'primary-agent', status: 'idle', level: 'verified', updatedAt: twoHoursAgo, classKind: 'primary' });
  const closedProject = session('runtime:closed-project', { agentId: 'closed-project', updatedAt: olderThanDefault });
  const recentProject = session('runtime:recent-project', { agentId: 'recent-project', updatedAt: NOW - 30 * 60 * 1000 });
  const configured = session('runtime:configured-agent', { agentId: 'configured-agent', updatedAt: twoHoursAgo });
  const sessions = [primary, closedProject, recentProject, configured];
  const agents = [
    { id: 'primary-agent', name: 'Primary', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: primary.key },
    { id: 'closed-project', name: 'Archived project', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: closedProject.key },
    { id: 'recent-project', name: 'Recent project', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: recentProject.key },
    { id: 'configured-agent', name: 'Configured agent', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: configured.key },
  ];
  const makeEngine = (sessionRows, agentRows) => ({ sessions: () => sessionRows, agents: () => agentRows, primaryAgent: () => agentRows[0], session: key => sessionRows.find(row => row.key === key) || null,
    gateway: () => ({ connected: true, since: NOW - 1000 }), runtimeFor: () => ({ connected: true, name: 'Transcript adapter' }),
    activity: () => null, agentPresence: () => true, cronJobs: () => [], host: () => null, liveEvents: () => [], transcript: () => null });
  const configuredAgents = { 'configured-agent': 'Configured helper' };
  const build = engine => buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), configuredAgents,
    canReadSessions: true, actorOf: actor => actor, P: project3x });
  const office = build(makeEngine(sessions, agents));
  const withoutArchive = build(makeEngine(sessions.filter(row => row !== closedProject), agents.filter(row => row !== agents[1])));

  assert.ok(office.occupants.some(row => row.id === 'primary' && row.state === 'idle'), 'primary remains visible and inactive');
  assert.ok(!office.occupants.some(row => row.id === 'agent:closed-project'), 'adapter-wide transcript discovery does not keep an archived project on stage');
  assert.ok(office.occupants.some(row => row.id === 'agent:recent-project'), 'recent project agents remain seated across adapters');
  assert.equal(office.occupants.some(row => row.sessionKey === recentProject.key && row.role !== 'agent'), false,
    'the 30-minute project-agent row remains while its completed session occupant uses the shorter window');
  assert.ok(office.occupants.some(row => row.id === 'agent:configured-agent' && row.state === 'idle'), 'configured agents remain visible while inactive');
  assert.equal(office.occupants.length, withoutArchive.occupants.length, 'the archived project does not inflate the rendered office population');
  assert.equal(office.kpis.find(row => row.id === 'active').value, 0, 'population KPIs count only on-stage occupants');
});

test('persisted names and auto-added catalog identities do not keep stale project agents on stage', () => {
  const primary = session('runtime:main', { agentId: 'primary-agent', status: 'idle', level: 'verified', updatedAt: NOW, classKind: 'primary' });
  const staleRows = t0117Capture.staleProjectAggregates;
  const staleIds = staleRows.map(row => row.id);
  const staleSessions = staleRows.filter(row => row.sessionKeyPresent).map((row, index) => session(`runtime:old-project-session-${index}`,
    { agentId: row.id, updatedAt: twoHoursAgo }));
  const agents = [
    { id: 'primary-agent', name: 'Primary', isPrimary: true, mainSessionKey: primary.key },
    ...staleIds.map(id => ({ id, name: `Historical project ${id}`, isPrimary: false, mainSessionKey: null })),
  ];
  const engine = { sessions: () => [primary, ...staleSessions], agents: () => agents, configuredAgentIds: () => staleIds,
    autoAddedAgentIds: () => staleIds, detectedAgents: () => agents.slice(1), primaryAgent: () => agents[0],
    session: key => [primary, ...staleSessions].find(row => row.key === key) || null, gateway: () => ({ connected: true, since: NOW - 1000 }),
    runtimeFor: () => ({ connected: true, name: 'Codex' }), activity: () => null, agentPresence: () => true,
    cronJobs: () => [], host: () => null, liveEvents: () => [], transcript: () => null };
  const office = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), configuredAgents: Object.fromEntries(staleIds.map(id => [id, `Saved ${id}`])),
    canReadSessions: true, P: project3x });
  assert.deepEqual(office.occupants.map(row => row.id), ['primary'], 'identity names and catalog persistence do not imply current presence');
  assert.equal(office.occupants.filter(row => row.role === 'agent').length, t0117Capture.expected.staleProjectAggregateCount);
  assert.equal(t0117Capture.expected.primaryCount, 1);
  assert.equal(t0117Capture.expected.teamMemberCount, 5, 'the fixture retains PM plus five member presence as the live acceptance context');
  assert.equal(office.kpis.find(row => row.id === 'active').value, 0);
  staleSessions[0].updatedAt = NOW - 30 * 60 * 1000;
  assert.ok(buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), configuredAgents: Object.fromEntries(staleIds.map(id => [id, `Saved ${id}`])),
    canReadSessions: true, P: project3x }).occupants.some(row => row.id === `agent:${staleIds[0]}`),
  'a fresh session still seats its auto-added project aggregate');
});

test('a live child keeps its old project-agent parent in both OfficeVM contracts', () => {
  const primary = session('runtime:main', { agentId: 'primary-agent', status: 'idle', level: 'verified', updatedAt: twoHoursAgo, classKind: 'primary' });
  const oldParent = session('runtime:project-parent', { agentId: 'coding-agent', updatedAt: twoHoursAgo, interactive: false });
  const liveChild = session('runtime:project-child', { agentId: 'coding-agent', classKind: 'subagent', status: 'running',
    updatedAt: NOW, expiresAt: NOW + 30_000 });
  liveChild.spawnedBy = { agentId: 'coding-agent', sessionKey: oldParent.key, via: 'subagent-tool', label: null };
  const sessions = [primary, oldParent, liveChild];
  const agents = [
    { id: 'primary-agent', name: 'Primary', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: primary.key },
    { id: 'coding-agent', name: 'Coding agent', displayName: null, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: oldParent.key },
  ];
  const engine = { sessions: () => sessions, agents: () => agents, primaryAgent: () => agents[0], session: key => sessions.find(row => row.key === key) || null,
    gateway: () => ({ connected: true, since: NOW - 1000 }), runtimeFor: () => ({ connected: true, name: 'Synthetic runtime' }), activity: () => null,
    agentPresence: () => true, cronJobs: () => [], host: () => null, liveEvents: () => [], transcript: () => null };

  for (const P of [project2x, project3x]) {
    const office = buildOfficeVM({ engine, now: NOW, tracker: createStateTracker(), configuredAgents: {}, canReadSessions: true, P });
    const project = office.occupants.find(row => row.id === 'agent:coding-agent');
    const child = office.occupants.find(row => row.sessionKey === liveChild.key && row.role === 'subagent');
    assert.ok(project, 'the aggregate project agent remains in the roster while its child is running');
    assert.equal(project.state, 'working');
    assert.ok(child, 'the running child remains in the roster');
    assert.equal(child.parentId, project.id, `the child links to the aggregate project agent when its parent session is stale (${P === project2x ? 'v2' : 'v3'}: ${JSON.stringify({ project, child })})`);
  }
});
