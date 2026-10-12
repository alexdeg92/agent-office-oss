'use strict';
/*
 * Sessions + live activity → OfficeOccupant[] (data-model.md §4). Pure; the caller supplies time.
 * Stations are placeholder uids ('desk-1'…'desk-7', matching today's 7 desks) until the office
 * layout store lands (S14b), when they come from the active layout.
 *
 * S3.1 (R2-08):
 *   - a session that FAILED within ERROR_WINDOW_MS stays on stage in state 'error' (main included);
 *     a recent failure takes precedence over live activity recorded before it;
 *   - dashboard / explicit / ACP sessions add no occupant of their own: their live activity and
 *     running state are attributed to their owning agent's occupant (the main agent today).
 * S4.1 (R6-05): states follow the 2026.9.8 run-state rule only. A running occupant is 'working'
 * (activityFor may supply a finer event-sourced kind, which no current protocol sends); main is
 * 'working' while its own, internal, conversation, or delegated child sessions run. Scheduled and heartbeat rows never
 * determine the agent's state.
 */
// G3b: canonical roles (ADR-001 §4.2); the 2.x projection maps them back (primary → main, scheduled → cron, …)
const ROLE_OF = { primary: 'primary', subagent: 'subagent', scheduled: 'scheduled', 'conversation-direct': 'direct', 'conversation-group': 'group', conversation: 'conversation' };
const INTERNAL = new Set(['dashboard', 'explicit', 'acp']);
const STATIONS = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6', 'desk-7'];
const ERROR_WINDOW_MS = 60 * 1000;
// Completed conversations and delegated runs have a short return window. The
// longer project-agent window below controls only the aggregate agent row.
const DEFAULT_SESSION_PRESENCE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_PRESENCE_WINDOW_MS = 60 * 60 * 1000;
const { executionState } = require('../execution-state');
const runOf = (s, now) => executionState(s?.run, now);
const isVerifiedTerminal = (s, now) => {
  const run = runOf(s, now);
  return run.level === 'verified' && ['succeeded', 'failed'].includes(run.status);
};
const currentActivityFor = (s, now, activityFor) => {
  return isVerifiedTerminal(s, now) ? null : activityFor(s.key);
};
// One canonical eligibility rule for state and execution evidence. Heartbeats
// and scheduled work are useful records, but never describe an agent's presence.
const isStateEvidenceSession = (s) => !!s && !s.class.heartbeatOf && s.class.kind !== 'scheduled';

function isOnStageSession(s, now, activityFor = () => null, presenceWindowMs = DEFAULT_SESSION_PRESENCE_WINDOW_MS) {
  if (!s || !s.class || s.class.heartbeatOf || !s.interactive) return false;
  const run = runOf(s, now);
  if (run.status === 'running') return true;
  if (recentlyFailed(s, now)) return true;
  if (currentActivityFor(s, now, activityFor)) return true;
  // A recently completed interactive turn is waiting for the next user input.
  // Verified terminal success stays visibly idle for the same bounded window,
  // but its older activity cannot make it look active again. History remains
  // available to Journaux after the session naturally leaves the stage.
  const at = s.updatedAt;
  const recentIdle = run.status === 'idle' && run.level !== 'unknown';
  const recentSuccess = run.status === 'succeeded' && run.level === 'verified';
  return s.class.kind !== 'scheduled' && (recentIdle || recentSuccess) && Number.isSafeInteger(at)
    && at <= now && now - at <= presenceWindowMs;
}

// A runtime/project agent represents a workspace, not each conversation or
// completed child session. It remains on stage while any owned session has
// current run/activity evidence, or while its most recent owned session activity
// is within the configurable project-agent window. Individual conversation/subagent rows
// continue to use isOnStageSession's short window.
function isProjectAgentOnStage(sessions, now, activityFor = () => null, presenceWindowMs = DEFAULT_AGENT_PRESENCE_WINDOW_MS) {
  // `interactive` is adapter-specific: Claude Code marks its ordinary project
  // transcripts false and reserves true for spawned subagents. Agent ownership
  // plus the canonical session class is the portable signal here.
  const eligible = (Array.isArray(sessions) ? sessions : []).filter(isStateEvidenceSession);
  // A live delegated child keeps its project-agent aggregate seated. Its old
  // completed history does not extend the aggregate's quiet window below.
  if (eligible.some(s => runOf(s, now).status === 'running' || currentActivityFor(s, now, activityFor))) return true;
  const owned = eligible.filter(s => s.class.kind !== 'subagent');
  const latest = owned.reduce((max, s) => Number.isSafeInteger(s.updatedAt) && s.updatedAt <= now ? Math.max(max, s.updatedAt) : max, -1);
  return latest >= 0 && now - latest <= presenceWindowMs;
}

// The occupant a session belongs to (same identity deriveOccupants uses); null if it has no occupant.
function occupantIdOf(s) {
  if (!s || !s.class) return null;
  if (s.class.kind === 'primary' || INTERNAL.has(s.class.kind)) return 'primary';
  const role = ROLE_OF[s.class.kind];
  if (!role) return null;
  return role + ':' + (s.class.subagentId || s.class.cronJobId || s.class.interlocutorId || s.key);
}

const recentlyFailed = (s, now) => !!s && s.run.status === 'failed' && !!s.run.endedAt && now - s.run.endedAt < ERROR_WINDOW_MS;

/**
 * @param {object} p
 * @param {Array}  p.sessions        canonical sessions
 * @param {(key:string)=>string|null} p.activityFor  live ActivityKind for a session key, or null
 * @param {boolean} p.gwConnected
 * @param {number} p.now
 * @param {string} [p.mainKey]       agents.list mainKey, if known
 */
function deriveOccupants({ sessions, activityFor = () => null, gwConnected, now, mainKey, primaryAgentId,
  presenceWindowMs = DEFAULT_SESSION_PRESENCE_WINDOW_MS }) {
  // Transcript-only runtimes may identify a main session through the primary
  // agent catalog while classifying that conversation generically. Honor that
  // explicit adapter link so its canonical run evidence drives the primary
  // occupant just like an OpenClaw `primary` session.
  const eligibleMain = isStateEvidenceSession;
  const main = sessions.find((s) => s.class.kind === 'primary' && !s.class.heartbeatOf && (!mainKey || s.key === mainKey))
    || (mainKey ? sessions.find(s => s.key === mainKey && eligibleMain(s)) : null)
    || sessions.filter(s => eligibleMain(s) && ['primary', 'conversation', 'conversation-direct', 'conversation-group'].includes(s.class.kind)
      && s.class.agentId === primaryAgentId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key))[0]
    || null;
  const mainAgent = primaryAgentId || (main && main.class.agentId) || 'main';

  // internal sessions of the main agent, newest first: their activity/running state belongs to main
  const internal = sessions.filter((s) => INTERNAL.has(s.class.kind) && !s.class.heartbeatOf && s.class.agentId === mainAgent)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const internalLive = internal.map((s) => currentActivityFor(s, now, activityFor)).find(Boolean) || null;
  const internalRunning = internal.some((s) => runOf(s, now).status === 'running');
  // office-dev-22: while one of the primary agent's conversations runs, the agent is 'working'
  // (its live activity kind if any); the person keeps their own occupant. Scheduled runs are not agent evidence.
  const owned = sessions.filter((s) => !s.class.heartbeatOf && s.class.agentId === mainAgent
    && ['conversation-direct', 'conversation-group', 'conversation'].includes(s.class.kind))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const ownedLive = owned.map((s) => currentActivityFor(s, now, activityFor)).find(Boolean) || null;
  const ownedRunning = owned.some((s) => runOf(s, now).status === 'running');
  const subagentsRunning = sessions.some((s) => {
    if (!isStateEvidenceSession(s) || s.class.kind !== 'subagent' || s.class.agentId !== mainAgent) return false;
    const run = runOf(s, now);
    const terminal = run.level === 'verified' && ['succeeded', 'failed'].includes(run.status);
    return !terminal && run.status !== 'failed' && (run.status === 'running' || currentActivityFor(s, now, activityFor));
  });

  const occupants = [{ id: 'primary', role: 'primary', sessionKey: main ? main.key : (mainKey || null), session: main }];
  const seen = new Set();
  const candidates = sessions.filter((s) => ROLE_OF[s.class.kind] && ROLE_OF[s.class.kind] !== 'primary'
    && isOnStageSession(s, now, activityFor, presenceWindowMs))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  for (const s of candidates) {
    const role = ROLE_OF[s.class.kind];
    const subjectId = s.class.subagentId || s.class.cronJobId || s.class.interlocutorId || s.key;
    const id = occupantIdOf(s) || role + ':' + subjectId;
    if (seen.has(id)) continue; seen.add(id);
    occupants.push({ id, role, sessionKey: s.key, session: s });
    if (occupants.length >= STATIONS.length) break;
  }

  return occupants.map((o, i) => {
    const s = o.session;
    const live = (s ? currentActivityFor(s, now, activityFor) : null) || (o.role === 'primary' ? internalLive || ownedLive : null);
    let state;
    const run = runOf(s, now);
    if (!gwConnected) state = 'offline';
    else if (recentlyFailed(s, now)) state = 'error';
    else if (live) state = live;
    else if (o.role === 'primary') {
      const running = run.status === 'running' || internalRunning || ownedRunning || subagentsRunning;
      state = running ? 'working' : run.status === 'idle' || run.level === 'verified' && ['succeeded', 'failed'].includes(run.status) ? 'idle' : 'unknown';
    } else {
      state = run.status === 'running' ? 'working' : run.status === 'idle' || run.level === 'verified' && ['succeeded', 'failed'].includes(run.status) ? 'idle' : 'unknown';
    }
    return { id: o.id, role: o.role, sessionKey: o.sessionKey, state, stationUid: STATIONS[i], order: i,
      tokens: s ? s.usage.total : 0, lastSeenAt: s ? s.updatedAt : null };
  });
}

module.exports = { deriveOccupants, occupantIdOf, ROLE_OF, STATIONS, ERROR_WINDOW_MS, DEFAULT_SESSION_PRESENCE_WINDOW_MS, DEFAULT_AGENT_PRESENCE_WINDOW_MS,
  isStateEvidenceSession, currentActivityFor, isVerifiedTerminal, isOnStageSession, isProjectAgentOnStage };
