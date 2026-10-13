'use strict';
/*
 * OfficeVM (api.md §3.2, §3.13). Who is on stage comes from the engine (deriveOccupants: run state, data-model §4);
 * look, roleLabel and ruleId come from the engine-owned layout rules; room placement is finalized after canonical rows.
 * Until the layout store lands (S14b) the active layout is the shipped default (design/office/layout.example.json)
 * with layoutRevision 0.
 */
const path = require('path');
const fs = require('fs');
const { deriveOccupants, isStateEvidenceSession, currentActivityFor, isOnStageSession, isProjectAgentOnStage,
  DEFAULT_SESSION_PRESENCE_WINDOW_MS, DEFAULT_AGENT_PRESENCE_WINDOW_MS } = require('../../../engine/derive/occupants');
const { scheduleVM } = require('./flows');
const { redactText, isRawChatIdentity, redactChatIdentity } = require('../../../security/redact-text');
const { executionState } = require('../../../engine/execution-state');
const { project2x: P2 } = require('../project2x');   // G3a: the 2.x wire values (ADR §12.6); G5: or project3x (the `P` param)
const { countOfficePopulation } = require('../../office-population');
const { projectOfficeRoster, projectOfficePlacement } = require('./office-roster');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const JOURNAL_MAX = 14, QUEUE_MAX = 8;
const CHAT_SESSION_KINDS = new Set(['conversation', 'conversation-direct', 'conversation-group']);

// The default layout and the asset manifest, loaded once (both are shipped files, not user data).
let defaults = null;
function officeDefaults() {
  if (defaults) return defaults;
  const rules = require('../../../engine/office/layout-rules.js');
  const assets = require(path.join(ROOT, 'public', 'v2', 'office', 'assets.js'));
  // The source files (design/office, office-dev's), else the synced copy (public/v2/bureau/office, built by sync-design).
  const shipped = (name) => {
    for (const dir of [path.join(ROOT, 'design', 'office'), path.join(ROOT, 'public', 'v2', 'bureau', 'office')]) {
      const f = path.join(dir, name); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    throw new Error('office default file missing: ' + name);
  };
  const layout = shipped('layout.example.json');
  const manifest = shipped('manifest.example.json');
  defaults = { rules, layout, manifest, index: assets.indexManifest(manifest), revision: 0 };
  return defaults;
}

// stateSince: when each occupant entered its current state (kept across builds; forgotten when it leaves).
function createStateTracker() {
  const seen = new Map();   // occupantId → { state, since }
  const hostSeen = new Map(); // stable host observation state across poll refreshes
  const memberHostSeen = new Map(); // memberId → last known host presence during a short source-row gap
  const visitsByVersion = new Map(); // contract version → conversation id → last safe row retained for the visit lease
  const relocations = new Map(); // occupantId → stable backend-selected activity/scene travel
  return {
    relocations,
    since(id, state, now) {
      const p = seen.get(id);
      if (p && p.state === state) return p.since;
      seen.set(id, { state, since: now });
      return now;
    },
    hostStateSince(id, state, observedAt) {
      const previous = hostSeen.get(id);
      if (previous?.state === state) return previous.since;
      hostSeen.set(id, { state, since: observedAt });
      return observedAt;
    },
    memberHostPresence(id, presence, now, graceMs = 30_000) {
      if (typeof id !== 'string' || !id || !Number.isSafeInteger(now)) return null;
      if (presence && presence.state !== 'unknown' && presence.execution?.evidence?.level !== 'unknown') {
        const evidence = presence.execution.evidence;
        const graceUntil = Math.min(now + graceMs,
          Number.isSafeInteger(evidence.expiresAt) ? evidence.expiresAt : Number.MAX_SAFE_INTEGER);
        if (graceUntil <= now) return null;
        const previous = memberHostSeen.get(id);
        const current = previous?.state === presence.state && now <= previous.graceUntil
          ? { ...presence, stateSince: previous.stateSince } : presence;
        memberHostSeen.set(id, {
          state: current.state, stateSince: current.stateSince,
          execution: { status: presence.execution.status, evidence: {
            level: 'observed', observedAt: evidence.observedAt ?? now,
            expiresAt: graceUntil,
          } },
          graceUntil,
        });
        return current;
      }
      const last = memberHostSeen.get(id);
      if (!last) return null;
      if (now > last.graceUntil) { memberHostSeen.delete(id); return null; }
      return { state: last.state, stateSince: last.stateSince, execution: last.execution };
    },
    keepMemberHostPresence(ids, now, maxEntries = 2000) {
      const keep = new Set(ids);
      for (const [id, row] of memberHostSeen) {
        if (!keep.has(id) || Number.isSafeInteger(now) && now > row.graceUntil) memberHostSeen.delete(id);
      }
      while (memberHostSeen.size > maxEntries) {
        const oldest = [...memberHostSeen].sort((a, b) => a[1].graceUntil - b[1].graceUntil)[0];
        if (!oldest) break;
        memberHostSeen.delete(oldest[0]);
      }
    },
    keepHostStates(ids) { const keep = new Set(ids); for (const id of hostSeen.keys()) if (!keep.has(id)) hostSeen.delete(id); },
    keep(ids) { for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id); },
    visitRows(rows, now, version) {
      if (!visitsByVersion.has(version)) visitsByVersion.set(version, new Map());
      return projectVisitRows(rows, visitsByVersion.get(version), now);
    },
  };
}

const VISIT_LINGER_MS = 60_000, PERSON_TURN_MS = 12_000, MEETING_TURNS = 2;
const VISITOR_ROLES = new Set(['direct', 'group', 'conversation', 'dm', 'channel']);
function refreshRetainedExecution(row, now) {
  const prior = row.execution, evidence = prior?.evidence;
  if (!prior || !evidence) return row;
  const current = executionState({ status: prior.status, evidenceLevel: evidence.level,
    observedAt: evidence.observedAt, expiresAt: evidence.expiresAt }, now);
  if (current.status === prior.status && current.level === evidence.level) return row;
  const updated = { ...row, execution: { status: current.status,
    evidence: { level: current.level, observedAt: current.observedAt, expiresAt: current.expiresAt } } };
  if (evidence.level === 'observed' && current.level === 'unknown') {
    updated.state = 'unknown';
    updated.visitStateLabel = { key: 'agentState.unknown' };
  }
  return updated;
}
function projectVisitRows(rows, visits, now) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const host = rows.find(row => row.role === 'primary' || row.role === 'main') || null;
  if (!host) {
    visits.clear();
    return { occupants: rows.map(({ visitPendingAt, visitUntilAt, ...row }) => row), visitIntent: undefined };
  }
  const liveVisitors = [];
  const retained = new Set();
  const lastAt = row => Math.max(row?.exchanges?.lastAt || 0, row?.lastActivityAt || 0, row?.stateSince || 0);
  for (const row of rows) {
    if (!VISITOR_ROLES.has(row.role)) continue;
    const active = !['idle', 'offline', 'unknown'].includes(row.state);
    const pendingAt = row.visitPendingAt || 0;
    const phase = active ? (pendingAt > (row.exchanges?.lastAt || 0) && now - pendingAt < PERSON_TURN_MS ? 'person' : 'agent')
      : now - lastAt(row) < VISIT_LINGER_MS ? 'linger' : null;
    if (!phase) { visits.delete(row.id); continue; }
    const visitor = { ...row, stationUid: null, visitPhase: phase, visitOnStage: true };
    if (phase === 'person') visitor.visitUntilAt = pendingAt + PERSON_TURN_MS;
    else if (phase === 'linger') visitor.visitUntilAt = lastAt(row) + VISIT_LINGER_MS;
    delete visitor.visitPendingAt;
    visitor.visitStateLabel = visitor.stateLabel || { key: `agentState.${visitor.state}` };
    const prior = visits.get(row.id);
    const lastActivityAt = active ? now : Math.max(lastAt(row), prior?.lastActivityAt || 0);
    visits.set(row.id, { row: visitor, lastActivityAt }); retained.add(row.id); liveVisitors.push(visitor);
  }
  for (const [id, saved] of visits) {
    if (retained.has(id) || byId.has(id) || !VISITOR_ROLES.has(saved.row.role)) continue;
    const old = refreshRetainedExecution(saved.row, now), until = saved.lastActivityAt + VISIT_LINGER_MS;
    if (now >= until || !host) { visits.delete(id); continue; }
    const linger = { ...old, stationUid: null, visitUntilAt: until,
      visitPhase: 'linger', visitOnStage: true, visitStateLabel: old.visitStateLabel || old.stateLabel || { key: `agentState.${old.state}` } };
    retained.add(id); liveVisitors.push(linger);
  }
  const visible = rows.filter(row => !VISITOR_ROLES.has(row.role)).map(({ visitPendingAt, visitUntilAt, ...row }) => row)
    .concat(liveVisitors.map(({ visitPendingAt, visitUntilAt, ...row }) => row));
  const groups = liveVisitors.filter(row => row.role === 'group');
  const turns = row => row.exchanges?.recent || 0;
  const meeting = liveVisitors.length > 1 || groups.length > 0 || liveVisitors.some(row => turns(row) >= MEETING_TURNS);
  const talker = liveVisitors.find(row => row.visitPhase === 'person');
  const talking = liveVisitors.some(row => row.visitPhase !== 'linger');
  const until = liveVisitors.flatMap(row => [row.visitUntilAt,
    row.execution?.evidence?.level === 'observed' ? row.execution.evidence.expiresAt : null])
    .filter(value => Number.isFinite(value) && value > now);
  return { occupants: visible, visitIntent: { hostId: host.id, desk: meeting ? [] : liveVisitors.map(row => row.id),
    meeting: meeting ? [host.id, ...liveVisitors.map(row => row.id)] : [], talking, speaker: talker?.id || (talking ? host.id : null),
    until: until.length ? Math.min(...until) : null, visitors: liveVisitors.map(row => ({ id: row.id, phase: row.visitPhase, stateLabel: row.visitStateLabel, onStage: row.visitOnStage })) } };
}

// G3b: derived roles are canonical (primary, scheduled, direct, group, conversation); the layout rules still speak 2.x
// (until layout-rules accepts both vocabularies, ADR §12.6), so they get the projected role.

/**
 * @param {object} p
 * @param {object} p.engine           the engine (sessions, session, activity, gateway, agents, cronJobs, host, liveEvents)
 * @param {number} p.now
 * @param {object} p.tracker          createStateTracker()
 * @param {object} p.names            { interlocutorName(id), flowName(jobId) }
 * @param {(ref) => object} p.actorOf ActorRef → ActorVM
 * @param {object} [p.layout]         { rules, layout, index, revision } (default: the shipped default layout)
 */
// architect-55 (office-dev-22 §3) · OccupantVM.exchanges for conversation occupants: an exchange is a message from the
// person answered by the agent before their next message, timed at the reply. `recent` counts those within
// EXCHANGE_WINDOW_MS (the office's visit window, public/v2/office/visits.js); `lastAt` is the newest. Omitted when no
// transcript is known (the client keeps its own count) or there was no exchange.
const EXCHANGE_WINDOW_MS = 10 * 60 * 1000;
const CONVERSATION_ROLES = new Set(['direct', 'group', 'conversation']);
function exchangesOf(transcript, now, windowMs = EXCHANGE_WINDOW_MS) {
  if (!transcript || !Array.isArray(transcript.events)) return null;
  const at = [];
  let waiting = false;
  for (const e of transcript.events) {
    if (e.kind === 'user') waiting = true;
    else if (e.kind === 'assistant' && waiting && Number.isInteger(e.at) && e.at > 0) { at.push(e.at); waiting = false; }
  }
  if (!at.length) return null;
  return { recent: at.filter((t) => t <= now && now - t <= windowMs).length, windowMs, lastAt: Math.max(...at) };
}

function pendingVisitAtOf(transcript) {
  if (!transcript || !Array.isArray(transcript.events)) return null;
  let waiting = false;
  for (const event of transcript.events) {
    if (event.kind === 'user') waiting = true;
    else if (event.kind === 'assistant') waiting = false;
  }
  const last = transcript.events.at(-1);
  return waiting && last?.kind === 'user' && Number.isInteger(last.at) && last.at > 0 ? last.at : null;
}

function buildOfficeVM({ engine, now, tracker, names = {}, actorOf, layout = officeDefaults(), configuredAgents = {}, canReadSessions = false, P = P2, assignLook,
  isNewAgent = () => false, presenceWindowMs = DEFAULT_SESSION_PRESENCE_WINDOW_MS, agentPresenceWindowMs = DEFAULT_AGENT_PRESENCE_WINDOW_MS }) {
  const gw = engine.gateway();
  const sessions = engine.sessions();
  const agents = engine.agents();
  // G3a: the one resolver (engine.primaryAgent); the agent row for its name and main session key
  const resolved0 = engine.primaryAgent ? engine.primaryAgent() : null;
  const primary = (resolved0 && agents.find((a) => a.id === resolved0.id)) || null;
  // agent-identity-1: titles can come from transcripts, so they need the sessions read grant and the shared redactor
  const titleOf = (v) => canReadSessions ? redactText(v, { maxLength: 120 }) : null;
  const primaryName = primary ? redactText(configuredAgents[primary.id] || primary.name || primary.id, { maxLength: 120 }) || 'Agent' : null;
  let derived = deriveOccupants({ sessions, activityFor: key => engine.activity?.(key)?.kind || null, gwConnected: primary && engine.runtimeFor ? !!engine.runtimeFor(primary.id)?.connected : gw.connected, now,
    primaryAgentId: primary?.id, mainKey: primary ? primary.mainSessionKey || undefined : undefined, presenceWindowMs });

  // Manual selections remain visible while idle. A saved display name or an
  // auto-added catalog identity is not presence: historical project folders
  // must leave the stage once their current sessions age out.
  const configuredIds = typeof engine.configuredAgentIds === 'function'
    ? new Set([...engine.configuredAgentIds(), ...Object.keys(configuredAgents)]) : new Set(Object.keys(configuredAgents));
  const autoAddedIds = new Set(typeof engine.autoAddedAgentIds === 'function' ? engine.autoAddedAgentIds() : []);
  const sourceAgentIds = typeof engine.detectedAgents === 'function'
    ? new Set((engine.detectedAgents() || []).map(agent => agent?.id).filter(id => typeof id === 'string')) : null;
  const hasName = id => Object.hasOwn(configuredAgents, id) && typeof configuredAgents[id] === 'string';
  for (const a of agents.filter(a => a.id !== primary?.id && (configuredIds.has(a.id) && !autoAddedIds.has(a.id)
    && (!sourceAgentIds || sourceAgentIds.has(a.id)) || isProjectAgentOnStage(
    sessions.filter(s => s.class.agentId === a.id), now, key => engine.activity?.(key)?.kind || null, agentPresenceWindowMs)))) {
    const id = 'agent:' + a.id;
    if (derived.some(o => o.id === id)) continue;
    const owned = sessions.filter(s => s.class.agentId === a.id && !s.class.heartbeatOf);
    const session = owned.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
    const sessionRun = executionState(session?.run, now);
    const recentOwnedSession = owned.some(row => Number.isSafeInteger(row.updatedAt) && row.updatedAt <= now
      && now - row.updatedAt <= agentPresenceWindowMs);
    derived.push({ id, role: 'agent', sessionKey: session?.key || null, state: !(engine.runtimeFor?.(a.id)?.connected ?? gw.connected) ? 'offline'
      : owned.some(s => executionState(s.run, now).status === 'running' || engine.activity?.(s.key)) ? 'working'
        : sessionRun.status === 'idle' || sessionRun.level === 'verified' && ['succeeded', 'failed'].includes(sessionRun.status) || recentOwnedSession ? 'idle' : 'unknown',
      tokens: session?.usage.total || 0, lastSeenAt: session?.updatedAt || null });
  }
  if (!canReadSessions) derived = derived.filter(o => o.role === 'primary' || o.role === 'agent');

  const sessionFor = o => o.sessionKey ? engine.session(o.sessionKey) : null;
  // The Bureau is a presence surface, not a transcript preview. Session
  // summaries, labels and objectives may contain prompts or chat messages, so
  // keep all such text in Logs and never put it in OfficeVM.
  const summaryFor = () => null;
  const projectNameFor = (s) => {
    const value = s?.projectLabel || s?.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || null;
    return value ? redactText(value, { maxLength: 120 }) : null;
  };
  const interlocutorName = s => {
    const id = s?.class?.interlocutorId;
    if (!id) return null;
    try {
      const value = titleOf(names.interlocutorName?.(id)) || null;
      return value && !isRawChatIdentity(value, { id, role: s?.class?.kind }) ? redactChatIdentity(value, { id, role: s?.class?.kind }) : null;
    } catch (_) { return null; }
  };
  const sessionFallbackName = s => {
    if (s?.class?.interlocutorId) return interlocutorName(s) || 'Conversation';
    const title = runtimeTitle(s);
    if (title) return title;
    const agent = s?.class?.agentId && agents.find(a => a.id === s.class.agentId);
    const agentName = titleOf(names.agentName?.(s?.class?.agentId)) || titleOf(configuredAgents[s?.class?.agentId]) || titleOf(agent?.name);
    const project = projectNameFor(s);
    const provider = titleOf(engine.runtimeFor?.(s?.key)?.name || s?.provider || s?.model?.provider);
    return agentName || project || provider || 'Conversation';
  };
  const runtimeTitle = s => s?.summarySource === 'runtime' ? titleOf(s.displayName) : null;
  const sourceName = (o) => {
    if (o.role === 'primary') return primaryName || 'Agent principal';
    if (o.role === 'agent' && hasName(o.id.slice(6))) return configuredAgents[o.id.slice(6)];
    if (o.role === 'agent') { const a = agents.find(a => a.id === o.id.slice(6)); return configuredAgents[a?.id] || a?.name || 'Agent'; }
    const s = sessionFor(o);
    if (o.role === 'scheduled' && s && s.class.cronJobId && names.flowName) return names.flowName(s.class.cronJobId) || 'Tâche planifiée';
    if (o.role === 'subagent') return runtimeTitle(s) || (s?.class.subagentId && names.agentName?.(s.class.subagentId)) || 'Sous-agent';
    if (CHAT_SESSION_KINDS.has(s?.class.kind) && !s.class.channel) return sessionFallbackName(s);
    if (CHAT_SESSION_KINDS.has(s?.class.kind)) return interlocutorName(s) || sessionFallbackName(s);
    // Session titles, summaries, labels, and goals are transcript-derived. The
    // office uses identity, project, and runtime labels only; Logs owns titles.
    return s ? runtimeTitle(s) || projectNameFor(s) || titleOf(engine.runtimeFor?.(s.key)?.name || s.provider || s.model?.provider) || 'Session'
      : ({ scheduled: 'Tâche planifiée', direct: 'Conversation', group: 'Conversation', conversation: 'Conversation' }[o.role] || 'Agent');
  };
  // Q03-A01: the occupant's title as a LabelRef (the UI's language); genuine names are raw params
  const named = (name) => ({ key: 'sessionTitle.named', params: { name } });
  const resolved = layout.rules.resolveOccupants(layout.layout, layout.index,
    // the layout rules speak 2.x until layout-rules.js takes both vocabularies (office-dev, ADR §12.6): always 2.x names here
    derived.map((o) => ({ id: P2.occupantId(o.id), role: P2.occupantRole(o.role), sourceName: sourceName(o),
      // The primary occupant exists even when agent discovery is unavailable.
      // Automatic-look storage rejects the layout sentinel `primary`; use a
      // stable agent identity until the runtime provides its real agent id.
      appearanceId: o.role === 'primary' ? 'agent:' + (primary?.id || 'main') : o.id })), { assignLook });

  const ids = new Set();
  const usedNames = new Map();
  // T-0062: an occupant's parent occupant, resolved generically and only for sessions readers, first match wins:
  // the session's parentKey (or a session listing it in childKeys), its spawnedBy session, the spawnedBy agent (session
  // first, then agent lineage), and finally, for a DM, a group or a conversation only, the agent that owns it (it sits
  // under that agent; a scheduled task does not). An agent never parents itself.
  const childOf = new Map();
  if (canReadSessions) for (const s of sessions) for (const k of s.childKeys || []) if (!childOf.has(k)) childOf.set(k, s.key);
  const bySession = new Map(), byAgent = new Map();
  for (const o of derived) {
    if (o.sessionKey && !bySession.has(o.sessionKey)) bySession.set(o.sessionKey, o.id);
    const agentId = o.role === 'primary' ? primary?.id : o.role === 'agent' ? o.id.slice(6) : null;
    if (agentId && !byAgent.has(agentId)) byAgent.set(agentId, o.id);
  }
  const parentOf = (o) => {
    if (!canReadSessions) return null;
    const s = sessionFor(o), a = o.role === 'agent' ? agents.find((x) => x.id === o.id.slice(6)) : o.role === 'primary' ? primary : null;
    const lineage = s?.spawnedBy || a?.spawnedBy || null;
    const ofSession = (key) => (key ? bySession.get(key) || byAgent.get(engine.session(key)?.class.agentId) : null);
    const owner = CONVERSATION_ROLES.has(o.role) && s?.class.agentId ? byAgent.get(s.class.agentId) : null;   // critic-237: never a scheduled task
    const p = ofSession(s?.parentKey || (s ? childOf.get(s.key) : null)) || ofSession(lineage?.sessionKey) || (lineage?.agentId ? byAgent.get(lineage.agentId) : null) || owner;
    return p && p !== o.id ? p : null;
  };
  const occupants = derived.map((o, i) => {
    const r = resolved[i];
    const session = sessionFor(o), summary = summaryFor(o), parent = parentOf(o);
    ids.add(o.id);
    // a layout rule's own name is user-authored (raw); otherwise the source title
    // every visible name passes the shared redactor too, whatever source (runtime config, layout rule) supplied it
    const baseName = redactText(r.name !== sourceName(o) ? r.name : sourceName(o), { maxLength: 120 }) || 'Agent';
    const folded = baseName.trim().toLocaleLowerCase('en');
    const duplicate = (usedNames.get(folded) || 0) + 1; usedNames.set(folded, duplicate);
    const labelName = duplicate === 1 ? baseName.slice(0, 32) : `${baseName.slice(0, 27)} · ${duplicate}`;
    const title = named(labelName);
    // A conversation-shaped backing session can belong to the primary or a named
    // configured agent. Only conversation occupants get the generic Session role;
    // preserve the owning agent's role in both contracts and read-limited views.
    const sessionKind = CONVERSATION_ROLES.has(o.role) && session?.class.kind === 'conversation' && !session.class.channel;
    const role = sessionKind ? (P.version === 3 ? 'session' : 'channel') : P.version === 3 ? o.role : P.occupantRole(r.role);
    const provider = sessionKind
      ? redactText(engine.runtimeFor?.(o.sessionKey)?.name || session.provider || session.model?.provider || 'Agent', { maxLength: 64 })
      : null;
    // The v2 wire aliases the enum value to `channel`, while the label keeps
    // the distinction needed by clients to treat a coding session as a session.
    const roleLabel = sessionKind ? { key: 'occupantRole.session', params: { provider } } : P.roleLabel(role, r.roleLabel);
    const ownerAgentId = o.role === 'primary' ? primary?.id : o.role === 'agent' ? o.id.slice(6) : null;
    const candidates = ownerAgentId
      ? sessions.filter(x => isStateEvidenceSession(x) && x.class.agentId === ownerAgentId)
      : session ? [session] : [];
    const evidence = candidates.map(x => ({ key: x.key, run: executionState(x.run, now), activity: currentActivityFor(x, now, key => engine.activity?.(key)) }));
    const verifiedRun = evidence.find(x => x.run.level === 'verified' && x.run.status === 'running');
    const observed = evidence.find(x => x.activity?.kind === 'working' || x.run.level === 'observed' && x.run.status === 'running');
    const observedKey = observed?.activity?.sessionKey || observed?.key;
    const terminalForObserved = observed && evidence.find(x => x.key === observedKey && x.run.level === 'verified'
      && ['succeeded', 'failed'].includes(x.run.status));
    let execution = verifiedRun?.run || terminalForObserved?.run || (observed ? { status: 'running', level: 'observed',
      observedAt: observed.activity?.since ?? observed.run.observedAt, expiresAt: observed.activity?.expiresAt ?? observed.run.expiresAt }
      : executionState(session?.run, now));
    // Observed evidence is a real presentation state when its lease is live; retain its
    // confidence level separately so the drawer can explain the source of that state.
    // Limited Office callers may see the permitted presentation state, but execution
    // evidence can disclose transcript observation times and lease duration.
    const executionVM = { status: canReadSessions ? execution.status : 'unknown', evidence: canReadSessions
      ? { level: execution.level, observedAt: execution.observedAt, expiresAt: execution.expiresAt }
      : { level: 'unknown', observedAt: null, expiresAt: null } };
    return { id: P.occupantId(o.id), role, name: labelName, title, roleLabel, state: o.state, stateSince: tracker.since(o.id, o.state, now),
      stationUid: r.stationUid, look: r.look, ...(r.automaticLook && { automaticLook: r.automaticLook }), ruleId: P.layoutRuleId(r.ruleId), destination: null, execution: executionVM,
      sessionKey: canReadSessions ? o.sessionKey : null, tokens: canReadSessions ? o.tokens : 0, lastSeenAt: canReadSessions ? o.lastSeenAt : null,
      ...(summary ? { summary } : {}), ...(canReadSessions && session?.model ? { model: session.model.id } : {}),
      ...(canReadSessions && (session?.projectLabel || session?.cwd) ? { project: projectNameFor(session) } : {}),
      ...(canReadSessions && o.sessionKey && engine.runtimeFor?.(o.sessionKey)?.name ? { runtime: engine.runtimeFor(o.sessionKey).name } : {}),
      ...(canReadSessions && session?.run?.startedAt ? { startedAt: session.run.startedAt } : {}),
      ...(canReadSessions && session?.updatedAt ? { lastActivityAt: session.updatedAt } : {}),
      ...(canReadSessions && session?.tokensKnown ? { tokensKnown: true } : {}),
      ...((o.role === 'agent' ? o.id.slice(6) : o.role === 'primary' ? primary?.id : null) &&
        isNewAgent(o.role === 'agent' ? o.id.slice(6) : primary?.id) ? { isNew: true } : {}),
      ...(parent ? { parentId: P.occupantId(parent) } : {}),
      ...(() => {
        const transcript = canReadSessions && CONVERSATION_ROLES.has(o.role) && o.sessionKey && engine.transcript ? engine.transcript(o.sessionKey) : null;
        const exchanges = exchangesOf(transcript, now), visitPendingAt = pendingVisitAtOf(transcript);
        return { ...(exchanges ? { exchanges } : {}), ...(visitPendingAt ? { visitPendingAt } : {}) };
      })() };
  });
  tracker.keep(ids);

  const population = countOfficePopulation(occupants);
  const unknownActivity = occupants.some((o) => o.state === 'unknown');
  const jobs = engine.cronJobs();
  const host = engine.host();
  // office-dev-19: the KPI counts the sub-agents present now (on stage: running, active or just failed), not every
  // sub-agent session the runtime still lists; the all-time count is the sub-line.
  const subagents = population.subagents;
  const kpis = [
    { id: 'active', label: { key: 'kpi.active' }, value: unknownActivity ? null : population.active, unit: 'count',
      // R14-16: « au repos » only when nobody is active (a sole working primary is not idle)
      sub: unknownActivity ? { key: 'kpi.stateUnknown' } : population.active === 0 ? { key: 'kpi.idle', params: { agent: primaryName || '' } } : { key: 'kpi.onStage', params: { n: population.onStage } } },
    { id: 'runs', label: { key: 'kpi.runs' }, value: canReadSessions ? sessions.filter((s) => executionState(s.run, now).status === 'running').length : null, unit: 'count', sub: null },
    { id: 'subagents', label: { key: 'kpi.subagents' }, value: canReadSessions ? subagents : null, unit: 'count', sub: null },
    { id: 'flows', label: { key: 'kpi.flows' }, value: jobs.filter((j) => j.enabled).length, unit: 'count', sub: { key: 'kpi.flowsTotal', params: { n: jobs.length } } },
    { id: 'tokens', label: { key: 'kpi.tokens' }, value: canReadSessions ? sessions.reduce((a, s) => a + s.usage.total, 0) : null, unit: 'tokens', sub: null },
    { id: 'cpu', label: { key: 'kpi.cpu' }, value: host ? Math.round(host.cpuPct) : null, unit: 'percent', sub: null },
  ];

  // the journal's {occupant} is the occupant's title (a nested LabelRef): the UI renders it in its language
  const occName = (e) => {
    const o = e.occupantId ? occupants.find((x) => x.id === P.occupantId(e.occupantId)) : null;
    if (o) return o.title;
    const s = e.sessionKey ? engine.session(e.sessionKey) : null;
    return s ? named('Session') : named('');
  };
  const journal = (canReadSessions ? engine.liveEvents().slice(0, JOURNAL_MAX) : []).map((e) => {
    const params = {};
    if (e.kind === 'cron.fired') params.job = (names.flowName && names.flowName(e.cronJobId)) || '';
    else if (/^(run|occupant)\.|^activity$/.test(e.kind)) params.occupant = occName(e);
    return { id: e.id, at: e.at, count: e.count, actor: actorOf(e.actor), text: Object.keys(params).length ? { key: 'liveEvent.' + P.liveKind(e.kind), params } : { key: 'liveEvent.' + P.liveKind(e.kind) }, kind: P.liveKind(e.kind), ...(P.version === 3 && e.occupantId ? { occupantId: P.occupantId(e.occupantId) } : {}), ...(P.version === 3 && e.activity ? { activity: e.activity } : {}) };
  });

  const queue = jobs.filter((j) => j.enabled)
    .sort((a, b) => (a.nextRunAt == null) - (b.nextRunAt == null) || (a.nextRunAt || 0) - (b.nextRunAt || 0) || a.id.localeCompare(b.id))
    .slice(0, QUEUE_MAX).map((j) => ({ id: j.id, name: j.name, schedule: scheduleVM(j.schedule).sentence }));

  // T-0062: a spawned occupant (a sub-agent or an agent with a parentId on stage) is listed right after its spawner, so
  // the roster reads as a team. Desks are already resolved; only the list order changes.
  const spawned = (o) => (o.role === 'subagent' || o.role === 'agent') && o.parentId && occupants.some((p) => p.id === o.parentId);
  const listed = [], placed = new Set();
  const place = (o) => { if (placed.has(o)) return; placed.add(o); listed.push(o); for (const c of occupants) if (spawned(c) && c.parentId === o.id) place(c); };
  for (const o of occupants) if (!spawned(o)) place(o);
  for (const o of occupants) place(o);
  const visitProjection = tracker.visitRows(listed, now, P.version);
  const roster = projectOfficeRoster({ connection: { gateway: gw.connected ? 'up' : 'down', since: gw.since }, kpis,
    occupants: visitProjection.occupants, visitIntent: visitProjection.visitIntent, journal, layoutRevision: layout.revision, queue });
  return projectOfficePlacement(roster, { layout: layout.layout, index: layout.index, projectOccupantId: P.occupantId, now, tracker });
}

module.exports = { buildOfficeVM, createStateTracker, officeDefaults, exchangesOf, EXCHANGE_WINDOW_MS };
