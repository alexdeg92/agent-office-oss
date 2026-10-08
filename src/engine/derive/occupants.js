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
 * 'working' while its own, its internal, or (office-dev-22) its conversation / scheduled sessions run, never because
 * sub-agents (helpers) exist.
 */
// G3b: canonical roles (ADR-001 §4.2); the 2.x projection maps them back (primary → main, scheduled → cron, …)
const ROLE_OF = { primary: 'primary', subagent: 'subagent', scheduled: 'scheduled', 'conversation-direct': 'direct', 'conversation-group': 'group', conversation: 'conversation' };
const INTERNAL = new Set(['dashboard', 'explicit', 'acp']);
const STATIONS = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6', 'desk-7'];
const ERROR_WINDOW_MS = 60 * 1000;

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
function deriveOccupants({ sessions, activityFor = () => null, gwConnected, now, mainKey }) {
  const main = sessions.find((s) => s.class.kind === 'primary' && !s.class.heartbeatOf && (!mainKey || s.key === mainKey)) || null;
  const mainAgent = (main && main.class.agentId) || 'main';

  // internal sessions of the main agent, newest first: their activity/running state belongs to main
  const internal = sessions.filter((s) => INTERNAL.has(s.class.kind) && !s.class.heartbeatOf && s.class.agentId === mainAgent)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const internalLive = internal.map((s) => activityFor(s.key)).find(Boolean) || null;
  const internalRunning = internal.some((s) => s.run.status === 'running');
  // office-dev-22: the agent does the work of its conversations and scheduled runs. While a direct message, a group
  // channel, a conversation or a scheduled task of the main agent (same agentId) runs, the main agent is 'working'
  // (its live activity kind if any); the person or the task keeps its own occupant (a visitor / the task).
  const owned = sessions.filter((s) => !s.class.heartbeatOf && s.class.agentId === mainAgent
    && ['conversation-direct', 'conversation-group', 'conversation', 'scheduled'].includes(s.class.kind))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const ownedLive = owned.map((s) => activityFor(s.key)).find(Boolean) || null;
  const ownedRunning = owned.some((s) => s.run.status === 'running');

  const occupants = [{ id: 'primary', role: 'primary', sessionKey: main ? main.key : (mainKey || null), session: main }];
  const seen = new Set();
  const candidates = sessions.filter((s) => s.interactive && ROLE_OF[s.class.kind] && ROLE_OF[s.class.kind] !== 'primary'
    && (s.run.status === 'running' || activityFor(s.key) || recentlyFailed(s, now)))
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
    const live = (s ? activityFor(s.key) : null) || (o.role === 'primary' ? internalLive || ownedLive : null);
    let state;
    if (!gwConnected) state = 'offline';
    else if (recentlyFailed(s, now)) state = 'error';
    else if (live) state = live;
    else if (o.role === 'primary') state = (s && s.run.status === 'running') || internalRunning || ownedRunning ? 'working' : 'idle';
    else state = s && s.run.status === 'running' ? 'working' : 'idle';
    return { id: o.id, role: o.role, sessionKey: o.sessionKey, state, stationUid: STATIONS[i], order: i,
      tokens: s ? s.usage.total : 0, lastSeenAt: s ? s.updatedAt : null };
  });
}

module.exports = { deriveOccupants, occupantIdOf, ROLE_OF, STATIONS, ERROR_WINDOW_MS };
