'use strict';

const { assertCanRead, allowsPrincipal } = require('../security/orchestrator-team-resources');
const { createReportRefIssuer } = require('../security/report-refs');
const { countOfficePopulation } = require('./office-population');
const { redactText, redactChatIdentity } = require('../security/redact-text');
const { executionState } = require('../engine/execution-state');
const { tagTeamMember, teamMemberId, teamMemberAliases } = require('./v2/vm/office-placement-identity');
const { projectOfficeRoster } = require('./v2/vm/office-roster');
const { DEFAULT_AGENT_PRESENCE_WINDOW_MS, isStateEvidenceSession } = require('../engine/derive/occupants');

const reportRefs = createReportRefIssuer();
const HOST_EXECUTION = Object.freeze({ working: 'running', idle: 'idle', waiting: 'idle', done: 'succeeded', blocked: 'failed' });
const RICH_ACTIVE_STATES = new Set(['thinking', 'researching', 'writing', 'executing', 'calling', 'waiting', 'blocked']);

function refreshOfficePopulation(office) {
  const population = countOfficePopulation(office.occupants);
  const unknownActivity = office.occupants.some(row => row?.state === 'unknown');
  const kpis = Array.isArray(office.kpis) ? office.kpis.map(row => {
    if (row.id === 'active') return { ...row, value: unknownActivity ? null : population.active,
      sub: unknownActivity ? { key: 'kpi.stateUnknown' } : population.active === 0 ? row.sub : { key: 'kpi.onStage', params: { n: population.onStage } } };
    if (row.id === 'subagents') return { ...row, value: population.subagents, sub: null };
    return row;
  }) : office.kpis;
  return { ...office, kpis };
}

function executionForHost(host, observedAt) {
  const freshObservation = Number.isSafeInteger(host?.observedAt) && Number.isSafeInteger(host?.staleAfter)
    && host.staleAfter > host.observedAt && (!Number.isSafeInteger(observedAt) || host.staleAfter > observedAt);
  const status = freshObservation ? HOST_EXECUTION[host.status] : null;
  if (!status) return { status: 'unknown', evidence: { level: 'unknown', observedAt: null, expiresAt: null } };
  return { status, evidence: { level: 'verified', observedAt: host.observedAt, expiresAt: host.staleAfter } };
}

function freshExecution(execution, now, state) {
  const evidence = execution?.evidence;
  return state !== 'unknown' && !!evidence && evidence.level !== 'unknown' && Number.isSafeInteger(evidence.observedAt)
    && (!Number.isSafeInteger(evidence.expiresAt) || evidence.expiresAt > now);
}

function memberPresence(host, runtimeOccupant, now, tracker = null, occupantId = null) {
  const hostExecution = executionForHost(host, now);
  const runtimeExecution = runtimeOccupant?.execution;
  const runtimeIsFresh = freshExecution(runtimeExecution, now, runtimeOccupant?.state);
  const hostIsNewer = hostExecution.evidence.level === 'verified'
    && (!runtimeIsFresh || hostExecution.evidence.observedAt >= runtimeExecution.evidence.observedAt);
  if (hostIsNewer) {
    const state = host?.status === 'blocked' ? 'blocked'
      : hostExecution.status === 'running' && runtimeIsFresh && RICH_ACTIVE_STATES.has(runtimeOccupant?.state)
        ? runtimeOccupant.state
        : hostExecution.status === 'running' ? 'working' : hostExecution.status === 'failed' ? 'error'
      : host?.status === 'waiting' ? 'waiting'
      : hostExecution.status === 'succeeded' || hostExecution.status === 'idle' ? 'idle' : 'unknown';
    const stateSince = typeof occupantId === 'string' && Number.isSafeInteger(host.observedAt)
      ? tracker?.hostStateSince?.(occupantId, state, host.observedAt) ?? host.observedAt : host.observedAt;
    return { execution: hostExecution, state, stateSince };
  }
  if (freshExecution(runtimeExecution, now, runtimeOccupant?.state)) {
    const since = Number.isSafeInteger(runtimeOccupant.stateSince) ? runtimeOccupant.stateSince : runtimeExecution.evidence.observedAt;
    return { execution: runtimeExecution, state: runtimeOccupant.state,
      stateSince: typeof occupantId === 'string' ? tracker?.hostStateSince?.(occupantId, runtimeOccupant.state, since) ?? since : since };
  }
  if (typeof occupantId === 'string' && Number.isSafeInteger(now)) tracker?.hostStateSince?.(occupantId, 'unknown', now);
  const stateSince = Number.isSafeInteger(runtimeOccupant?.stateSince) ? runtimeOccupant.stateSince
    : Number.isSafeInteger(host?.observedAt) ? host.observedAt : now;
  return { execution: hostExecution, state: 'unknown', stateSince };
}

function memberPresenceWithGrace(host, runtimeOccupant, now, tracker, memberId, stateId) {
  const presence = memberPresence(host, runtimeOccupant, now, tracker, stateId);
  if (host) {
    if (presence.state !== 'unknown') tracker?.memberHostPresence?.(memberId, presence, now);
    return presence;
  }
  if (presence.state !== 'unknown') {
    tracker?.memberHostPresence?.(memberId, presence, now);
    return presence;
  }
  return tracker?.memberHostPresence?.(memberId, null, now) || presence;
}

// The office projection is identity-preserving when the caller lacks the
// optional host grant. Host rows are only an annotation on an exact link.
function projectOfficeOccupant(occupant, hostAgent, identityLink, principal, { sourceEnabled = false, agentId = occupant?.id, parentOccupantId = null, observedAt = null, tracker = null, placementOnly = false } = {}) {
  if (!sourceEnabled || (!placementOnly && (!principal || !can(principal, 'orchestrators')))) return { ...occupant };
  if (!hostAgent || !identityLink || identityLink.confidence !== 'exact'
    || !['shared-runtime-session-ref', 'explicit-runtime-identity'].includes(identityLink.evidence)
    || identityLink.agentId !== agentId || identityLink.hostAgentId !== hostAgent.id
    || !['primary', 'delegate', 'unknown'].includes(hostAgent.role)
    || !['working', 'blocked', 'done', 'idle', 'waiting', 'unknown'].includes(hostAgent.status)) return { ...occupant };
  const presence = Number.isSafeInteger(observedAt) ? memberPresence(hostAgent, occupant, observedAt, tracker, hostAgent.id) : null;
  return { ...occupant, ...(presence || {}),
    hostAgentId: hostAgent.id, hostRole: hostAgent.role, hostStatus: hostAgent.status,
    ...((placementOnly || can(principal, 'teams')) && typeof parentOccupantId === 'string' && parentOccupantId !== occupant.id ? { parentId: parentOccupantId } : {}) };
}

// Registered team members can be represented in the office even when their
// runtime connector is temporarily absent. The member→pane join has already
// been made from the private exact Herdr pane reference by the source joiner.
// Reuse an existing runtime occupant only through an exact identity link;
// otherwise the opaque team member ID is the single office identity.
function projectOfficeTeamOccupants(office, snapshot, principal, { sourceEnabled = false, runtimeAgents = [], primaryAgentId = null, runtimeIdentitySessions = [], runtimeSessions = [], canReadSessions = false, version = 3, tracker = null, placementOnly = false, agentPresenceWindowMs = DEFAULT_AGENT_PRESENCE_WINDOW_MS } = {}) {
  if (!sourceEnabled || (!placementOnly && (!principal || !can(principal, 'orchestrators'))) ||
      !office || !Array.isArray(office.occupants) || !snapshot) return office;
  const mayReadTeam = placementOnly || can(principal, 'teams');
  const hosts = new Map((snapshot.agents || []).filter(row => row?.id).map(row => [row.id, row]));
  tracker?.keepHostStates?.([...hosts.keys()]);
  const links = new Map();
  const ambiguousLinks = new Set();
  for (const link of snapshot.identityLinks || []) {
    if (!link || link.confidence !== 'exact' || !['shared-runtime-session-ref', 'explicit-runtime-identity'].includes(link.evidence) ||
        typeof link.hostAgentId !== 'string' || typeof link.agentId !== 'string') continue;
    if (links.has(link.hostAgentId)) ambiguousLinks.add(link.hostAgentId);
    else links.set(link.hostAgentId, link);
  }
  for (const id of ambiguousLinks) links.delete(id);
  const agentsById = new Map((Array.isArray(runtimeAgents) ? runtimeAgents : []).filter(row => row?.id).map(row => [row.id, row]));
  const identitySessionsByKey = new Map();
  for (const row of Array.isArray(runtimeIdentitySessions) ? runtimeIdentitySessions : []) {
    if (!row || typeof row.sessionKey !== 'string' || typeof row.runtimeKind !== 'string' || typeof row.sessionRef !== 'string') continue;
    const rows = identitySessionsByKey.get(row.sessionKey) || [];
    rows.push(row); identitySessionsByKey.set(row.sessionKey, rows);
  }
  const sessionsByKey = new Map((Array.isArray(runtimeSessions) ? runtimeSessions : []).filter(row => row?.key).map(row => [row.key, row]));
  const identityMatchesRef = (identity, ref) => identity?.runtimeKind === ref?.runtimeKind && identity?.sessionRef === ref?.sessionRef;
  // The source joiner records a private ref only after resolving a unique exact
  // runtime match. That private match remains valid when the Herdr process is
  // unavailable and cannot provide a host-scoped identity list.
  for (const ref of Object.values(snapshot.privateMemberSessionRefs || {})) {
    if (!ref || typeof ref.sessionKey !== 'string' || typeof ref.runtimeKind !== 'string' || typeof ref.sessionRef !== 'string') continue;
    const rows = identitySessionsByKey.get(ref.sessionKey) || [];
    if (rows.some(row => identityMatchesRef(row, ref))) continue;
    const session = sessionsByKey.get(ref.sessionKey);
    rows.push({ ...ref, ...(session?.class?.agentId ? { agentId: session.class.agentId } : {}) });
    identitySessionsByKey.set(ref.sessionKey, rows);
  }
  const onStageSessionKeys = new Set(office.occupants.map(row => row?.sessionKey).filter(value => typeof value === 'string' && value));
  const sessionKeysByAgent = new Map();
  for (const session of sessionsByKey.values()) if (onStageSessionKeys.has(session.key) && session.class?.kind === 'conversation' && session.class.agentId) {
    const keys = sessionKeysByAgent.get(session.class.agentId) || new Set(); keys.add(session.key); sessionKeysByAgent.set(session.class.agentId, keys);
  }
  // Presence for a project aggregate is derived from all of its available
  // session rows, not only the individually seated conversations. The engine
  // may retain old transcript rows in its bounded registry; the agent window
  // below decides whether any residual sibling still represents a presence.
  for (const session of sessionsByKey.values()) if (session.class?.agentId) {
    const keys = sessionKeysByAgent.get(session.class.agentId) || new Set(); keys.add(session.key); sessionKeysByAgent.set(session.class.agentId, keys);
  }
  // Project-level runtime occupants can outlive their individual recent
  // conversation rows. Their selected main session is still an exact private
  // identity candidate, so include it when deciding whether the aggregate is
  // fully represented by registered members.
  for (const occupant of office.occupants) {
    if (occupant?.role !== 'agent' || typeof occupant.sessionKey !== 'string' || !occupant.sessionKey || !occupant.id?.startsWith('agent:')) continue;
    const agentId = occupant.id.slice('agent:'.length);
    const keys = sessionKeysByAgent.get(agentId) || new Set(); keys.add(occupant.sessionKey); sessionKeysByAgent.set(agentId, keys);
  }
  const memberSessionIdentities = Object.values(snapshot.privateMemberSessionRefs || {}).filter(ref => ref
    && typeof ref.runtimeKind === 'string' && typeof ref.sessionRef === 'string' && typeof ref.sessionKey === 'string');
  const memberSessionKeysByAgent = new Map();
  for (const ref of memberSessionIdentities) {
    const identities = (identitySessionsByKey.get(ref.sessionKey) || []).filter(identity => identityMatchesRef(identity, ref));
    const currentAgentId = sessionsByKey.get(ref.sessionKey)?.class?.agentId;
    const agentId = currentAgentId || identities.find(identity => typeof identity.agentId === 'string')?.agentId || ref.agentId;
    if (typeof agentId !== 'string' || !agentId) continue;
    const keys = memberSessionKeysByAgent.get(agentId) || new Set(); keys.add(ref.sessionKey); memberSessionKeysByAgent.set(agentId, keys);
    const assigned = sessionKeysByAgent.get(agentId) || new Set(); assigned.add(ref.sessionKey); sessionKeysByAgent.set(agentId, assigned);
  }
  agentPresenceWindowMs = Number.isSafeInteger(agentPresenceWindowMs)
    ? Math.max(60_000, Math.min(86_400_000, agentPresenceWindowMs)) : DEFAULT_AGENT_PRESENCE_WINDOW_MS;
  const now = Number.isSafeInteger(snapshot.observedAt) ? snapshot.observedAt : Date.now();
  const occupantsBySessionKey = new Map();
  for (const occupant of office.occupants) if (typeof occupant?.sessionKey === 'string' && occupant.sessionKey) {
    const bucket = occupantsBySessionKey.get(occupant.sessionKey) || [];
    bucket.push(occupant); occupantsBySessionKey.set(occupant.sessionKey, bucket);
  }
  const projectAgentResiduals = new Map();
  const absorbedAgents = new Set();
  for (const [id, keys] of sessionKeysByAgent) {
    const covered = memberSessionKeysByAgent.get(id);
    if (!covered?.size || agentsById.get(id)?.isPrimary) continue;
    const residual = [...keys].filter(key => !covered.has(key)).map(key => {
      const session = sessionsByKey.get(key);
      const occupant = (occupantsBySessionKey?.get(key) || []).find(row => row.role !== 'agent') || null;
      if (session && !isStateEvidenceSession(session)) return null;
      const updatedAt = Number.isSafeInteger(session?.updatedAt) ? session.updatedAt : occupant?.lastSeenAt;
      const run = session && executionState(session.run, now);
      const live = run?.status === 'running' || occupant?.state === 'working';
      const fresh = session?.class?.kind !== 'subagent' && Number.isSafeInteger(updatedAt)
        && updatedAt <= now && now - updatedAt <= agentPresenceWindowMs;
      return { key, session, occupant, updatedAt, live, fresh };
    }).filter(row => row && (row.live || row.fresh)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!residual.length) {
      absorbedAgents.add(id);
      projectAgentResiduals.set(id, null);
      continue;
    }
    // State and its supporting session/evidence must come from the same row.
    // A live older sibling outranks a newer idle transcript when deciding the
    // aggregate state; otherwise the aggregate could say Working while
    // pointing at verified Idle (or Unknown) evidence from another session.
    const liveResiduals = residual.filter(row => row.live);
    const selected = (liveResiduals.length ? liveResiduals : residual)[0];
    projectAgentResiduals.set(id, { ...selected, state: liveResiduals.length ? 'working' : 'idle' });
  }
  const existing = new Map(office.occupants.map(row => [row.id, row]));
  const occupantForMember = new Map();
  const selectedMembers = [];
  const seenHostRefs = new Map();
  const registryMembers = Array.isArray(snapshot.members) ? snapshot.members : [];
  tracker?.keepMemberHostPresence?.(registryMembers.map(member => member?.id).filter(id => typeof id === 'string'), snapshot.observedAt);
  const teamMembers = mayReadTeam ? registryMembers : [];
  // A project-level runtime agent can aggregate several native sessions. It is
  // safe to reuse that generic row for a member only when exactly one distinct
  // private session identity resolves to the agent; otherwise each member
  // needs its own occupant identity.
  const memberRefsByAgent = new Map();
  for (const member of teamMembers) {
    const ref = snapshot.privateMemberSessionRefs?.[member?.id];
    if (!ref || typeof ref.runtimeKind !== 'string' || typeof ref.sessionRef !== 'string' || typeof ref.sessionKey !== 'string') continue;
    const identities = identitySessionsByKey.get(ref.sessionKey) || [];
    const currentAgentId = sessionsByKey.get(ref.sessionKey)?.class?.agentId;
    const agentIds = new Set(currentAgentId ? [currentAgentId] : [ref.agentId, ...identities.filter(identity => identityMatchesRef(identity, ref)).map(identity => identity.agentId)]
      .filter(id => typeof id === 'string' && id));
    if (agentIds.size !== 1) continue;
    const agentId = [...agentIds][0];
    const refs = memberRefsByAgent.get(agentId) || new Set();
    refs.add(JSON.stringify([ref.runtimeKind, ref.sessionRef]));
    memberRefsByAgent.set(agentId, refs);
  }
  const memberIdsByHost = new Map();
  const memberRefsByHostAgent = new Map();
  for (const member of teamMembers) {
    const hostId = member?.hostAgentId;
    if (typeof hostId !== 'string') continue;
    const memberIds = memberIdsByHost.get(hostId) || new Set();
    memberIds.add(member.id);
    memberIdsByHost.set(hostId, memberIds);
    const ref = snapshot.privateMemberSessionRefs?.[member.id];
    if (!ref || typeof ref.runtimeKind !== 'string' || typeof ref.sessionRef !== 'string' || typeof ref.sessionKey !== 'string') continue;
    const identities = identitySessionsByKey.get(ref.sessionKey) || [];
    const currentAgentId = sessionsByKey.get(ref.sessionKey)?.class?.agentId;
    const agentIds = new Set(currentAgentId ? [currentAgentId] : [ref.agentId, ...identities.filter(identity => identityMatchesRef(identity, ref)).map(identity => identity.agentId)]
      .filter(id => typeof id === 'string' && id));
    for (const agentId of agentIds) {
      const byAgent = memberRefsByHostAgent.get(hostId) || new Map();
      const refs = byAgent.get(agentId) || new Set();
      refs.add(JSON.stringify([ref.runtimeKind, ref.sessionRef]));
      byAgent.set(agentId, refs);
      memberRefsByHostAgent.set(hostId, byAgent);
    }
  }
  const membersWithChildren = new Set(teamMembers.map(member => member?.parentMemberId).filter(Boolean));
  const roleKindFor = member => member?.roleKind === 'lead' || member?.roleKind === 'member'
    ? member.roleKind : member?.parentMemberId ? 'member' : membersWithChildren.has(member?.id) ? 'lead' : 'unknown';
  const leadMembers = teamMembers.filter(member => roleKindFor(member) === 'lead');
  const leadMember = leadMembers.length === 1 ? leadMembers[0] : null;
  for (const member of teamMembers) {
    const hostId = member?.hostAgentId;
    const exactSessionKey = snapshot.privateMemberSessionKeys?.[member.id];
    const exactSessionIdentity = snapshot.privateMemberSessionRefs?.[member.id] || null;
    const runtimeSession = exactSessionKey ? sessionsByKey.get(exactSessionKey) || null : null;
    const candidateHost = hostId && hosts.get(hostId);
    const memberRefKey = exactSessionIdentity ? JSON.stringify([exactSessionIdentity.runtimeKind, exactSessionIdentity.sessionRef]) : null;
    const paneRefs = seenHostRefs.get(hostId) || new Set();
    const seenRef = memberRefKey || null;
    // Duplicate records for one exact member/pane are one source row. Distinct
    // refs on a reused pane remain separate, but status is assigned only to the
    // member identified by the exact host↔runtime link.
    if (candidateHost && paneRefs.has(seenRef)) continue;
    if (candidateHost) { paneRefs.add(seenRef); seenHostRefs.set(hostId, paneRefs); }
    const exactSessionIdentities = exactSessionIdentity
      ? (identitySessionsByKey.get(exactSessionKey) || []).filter(identity => identityMatchesRef(identity, exactSessionIdentity)) : [];
    // Project grouping may change as a resumed session's latest cwd changes.
    // The current canonical session owns that grouping; the private reference
    // supplies identity only and its cached agentId can be from the prior cwd.
    const sessionAgentId = runtimeSession?.class?.agentId || exactSessionIdentities.find(identity => identity.agentId)?.agentId
      || exactSessionIdentity?.agentId || null;
    const hostIdentity = hostId ? links.get(hostId) : null;
    const identityMatchesMember = !!hostIdentity && !!sessionAgentId && hostIdentity.agentId === sessionAgentId;
    const paneHasMultipleMembers = (memberIdsByHost.get(hostId)?.size || 0) > 1;
    // A project agent may represent multiple native sessions. A project-level
    // pane link cannot distinguish two such members sharing one pane; keep
    // each session's own runtime/grace state until a native host ref exists.
    const paneHasAmbiguousNativeIdentity = hostIdentity
      && (memberRefsByHostAgent.get(hostId)?.get(hostIdentity.agentId)?.size || 0) > 1;
    const host = candidateHost && (hostIdentity
      ? identityMatchesMember && !paneHasAmbiguousNativeIdentity : !paneHasMultipleMembers) ? candidateHost : null;
    const sessionMatches = exactSessionKey ? occupantsBySessionKey.get(exactSessionKey) || [] : [];
    const roleKind = roleKindFor(member);
    const inferredParentAmbiguous = roleKind === 'member' && !member.parentMemberId && leadMembers.length !== 1;
    const parentMemberId = member.parentMemberId || (roleKind === 'member' && leadMember?.id !== member.id ? leadMember?.id : null);
    // Limited Office VMs deliberately omit session keys. A unique exact
    // Herdr↔runtime link still identifies the runtime agent row, and lets the
    // team projection rename/fold that same agent without exposing its private
    // session reference. If both private paths exist, they must agree.
    const linkedAgentId = exactSessionIdentity && sessionAgentId
      ? (!hostIdentity || hostIdentity.confidence === 'exact' && hostIdentity.agentId === sessionAgentId ? sessionAgentId : null)
      : !exactSessionIdentity && hostIdentity?.confidence === 'exact' ? hostIdentity.agentId : null;
    const hasUniqueMemberIdentity = !exactSessionIdentity || (memberRefsByAgent.get(linkedAgentId)?.size || 0) <= 1
      && !projectAgentResiduals.get(linkedAgentId);
    const linkedAgentOccupant = linkedAgentId && hasUniqueMemberIdentity && agentsById.has(linkedAgentId)
      ? office.occupants.find(row => row.id === 'agent:' + linkedAgentId && row.role === 'agent') || null : null;
    const primaryMainSessionKey = typeof primaryAgentId === 'string' ? agentsById.get(primaryAgentId)?.mainSessionKey : null;
    const primaryMainHasExactIdentity = typeof primaryMainSessionKey === 'string' && (identitySessionsByKey.get(primaryMainSessionKey) || [])
      .some(identity => identity.agentId === primaryAgentId && identityMatchesRef(identity, exactSessionIdentity));
    // The same logical agent can own several native sessions. Fold a registered
    // team lead into the instance primary only when the lead's private native
    // ref is the exact ref attached to that primary agent's main session.
    const primaryOwnsLeadSession = roleKind === 'lead' && exactSessionIdentity && typeof primaryAgentId === 'string'
      && typeof primaryMainSessionKey === 'string' && primaryMainHasExactIdentity;
    const matchingSessionOccupants = exactSessionIdentity
      ? sessionMatches.filter(row => {
        if (row.role === 'primary' || row.role === 'main') return primaryOwnsLeadSession;
        const occupantAgentId = typeof row.id === 'string' && row.id.startsWith('agent:') ? row.id.slice('agent:'.length) : null;
        return exactSessionIdentities.some(identity => !occupantAgentId || identity.agentId === occupantAgentId)
          || !occupantAgentId && row.sessionKey === exactSessionKey;
      })
      : sessionMatches;
    const runtimeOccupant = (primaryOwnsLeadSession
      ? matchingSessionOccupants.find(row => row.role === 'primary' || row.role === 'main') : null)
      || matchingSessionOccupants.find(row => row.role !== 'agent' && row.role !== 'primary' && row.role !== 'main')
      || (!projectAgentResiduals.get(sessionAgentId) && matchingSessionOccupants.find(row => row.role === 'agent' && row.sessionKey === exactSessionKey))
      || linkedAgentOccupant
      || (runtimeSession && canReadSessions ? (() => {
        const run = executionState(runtimeSession.run), state = run.status === 'running' ? 'working'
          : ['succeeded', 'failed'].includes(run.status) ? 'idle' : 'unknown';
        const project = runtimeSession.projectLabel || (runtimeSession.cwd ? runtimeSession.cwd.split(/[\\/]/).filter(Boolean).at(-1) : null);
        return { id: canReadSessions ? exactSessionKey : 'team-member:' + member.id, role: 'conversation',
          ...(canReadSessions ? { sessionKey: exactSessionKey } : {}), state,
          execution: { status: run.status, evidence: { level: run.level, observedAt: run.observedAt, expiresAt: run.expiresAt } },
          ...(canReadSessions ? { tokens: runtimeSession.usage?.total || 0, lastSeenAt: runtimeSession.updatedAt || null,
            summary: runtimeSession.summary || '', ...(typeof runtimeSession.model?.id === 'string' ? { model: runtimeSession.model.id } : {}), ...(project ? { project } : {}),
            ...(runtimeSession.tokensKnown === true ? { tokensKnown: true } : {}), ...(runtimeSession.run?.startedAt ? { startedAt: runtimeSession.run.startedAt } : {}) } : {}) };
      })() : null);
    // A lead may intentionally share the instance's primary session. Preserve
    // the primary row's canonical identity, but prefer the exact transcript
    // occupant for richer, session-scoped activity evidence.
    const activityOccupant = primaryOwnsLeadSession
      ? matchingSessionOccupants.find(row => row !== runtimeOccupant && row.sessionKey === exactSessionKey
        && row.role !== 'agent' && row.role !== 'primary' && row.role !== 'main') || runtimeOccupant
      : runtimeOccupant;
    const canonicalPrimary = primaryOwnsLeadSession
      ? office.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary')) || null : null;
    const id = canonicalPrimary?.id || runtimeOccupant?.id || 'team-member:' + member.id;
    occupantForMember.set(member.id, id);
    selectedMembers.push({ member, host, id, roleKind, parentMemberId, inferredParentAmbiguous, runtimeOccupant, activityOccupant, canonicalPrimary,
      exactSessionKey, exactSessionIdentity, hostIdentity, matchingSessionOccupants, runtimeSession });
  }
  const templ = office.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary')) || office.occupants[0] || null;
  if (!templ) return office;
  const additions = [];
  const updates = new Map();
  const consumed = new Set();
  for (const { member, host, id, roleKind, parentMemberId, inferredParentAmbiguous, runtimeOccupant, activityOccupant, canonicalPrimary,
    exactSessionKey, exactSessionIdentity, hostIdentity, matchingSessionOccupants, runtimeSession } of selectedMembers) {
    const safeMemberName = redactChatIdentity(member.name, { role: 'conversation', maxLength: 120 }) || 'Agent';
    const runtimeSessionName = canReadSessions && runtimeSession?.summarySource === 'runtime'
      ? redactChatIdentity(runtimeSession.displayName, { role: 'conversation', maxLength: 120 }) : null;
    const parentId = parentMemberId ? occupantForMember.get(parentMemberId) : null;
    const sessionAgentId = runtimeSession?.class?.agentId || exactSessionIdentity?.agentId || hostIdentity?.agentId;
    if (sessionAgentId && absorbedAgents.has(sessionAgentId) && id !== 'agent:' + sessionAgentId) consumed.add('agent:' + sessionAgentId);
    const sourceOccupant = runtimeOccupant || canonicalPrimary;
    if (sourceOccupant && existing.has(id)) {
      for (const duplicate of matchingSessionOccupants) if (duplicate.id !== id) {
        const duplicateAgentId = duplicate.id.startsWith('agent:') ? duplicate.id.slice('agent:'.length) : null;
        if (duplicate.role === 'agent' && duplicateAgentId && !absorbedAgents.has(duplicateAgentId)) continue;
        consumed.add(duplicate.id);
      }
      // Prefer whichever verified observation is newer: a live pane extends
      // old terminal history, while a newer runtime run remains authoritative.
      const presence = memberPresenceWithGrace(host, canReadSessions ? activityOccupant : null,
        snapshot.observedAt, tracker, member.id, host?.id || id);
      // The registered team graph is authoritative for team members. In
      // particular, explicitly clear a runtime parent on the team lead and
      // replace a child session's project-agent/OpenClaw parent with its
      // registered lead occupant.
      const { id: _runtimeId, summary: _privateSummary, parentId: _runtimeParentId, visitPhase: _runtimeVisitPhase, ...runtimeFields } = sourceOccupant;
      const safeRuntimeOccupant = canReadSessions ? runtimeFields : (() => {
        const { sessionKey: _sessionKey, tokens: _tokens, lastSeenAt: _lastSeenAt, model: _model, project: _project,
          runtime: _runtime, tokensKnown: _tokensKnown, startedAt: _startedAt, lastActivityAt: _lastActivityAt, ...safe } = runtimeFields;
        return { ...safe, sessionKey: null, tokens: 0, lastSeenAt: null };
      })();
      const displayIdentity = canonicalPrimary;
      const displayName = runtimeSessionName || (displayIdentity ? displayIdentity.name : safeMemberName) || safeMemberName;
      updates.set(id, { ...safeRuntimeOccupant, id,
        ...(displayIdentity ? { name: displayName, title: { key: 'sessionTitle.named', params: { name: displayName } },
          look: displayIdentity.look, ...(displayIdentity.automaticLook ? { automaticLook: displayIdentity.automaticLook } : {}), ruleId: displayIdentity.ruleId } : {}),
        ...presence,
        // A team lead is not necessarily the instance's primary agent. Preserve
        // primary/main only when this exact session was folded into that row;
        // distinct orchestrator leads are ordinary agent roots.
        role: displayIdentity ? (version === 2 ? 'main' : 'primary') : roleKind === 'lead' ? 'agent' : 'subagent',
        ...(!displayIdentity ? { name: displayName, title: { key: 'sessionTitle.named', params: { name: displayName } } } : {}),
        roleLabel: { key: 'occupantRole.' + (displayIdentity ? (version === 2 ? 'main' : 'primary') : roleKind === 'lead' ? 'agent' : 'subagent') },
        ...(version === 3 && host ? { hostAgentId: host.id, hostRole: host.role, hostStatus: host.status } : {}),
        parentId: parentId && parentId !== id ? parentId : null, parentAmbiguous: inferredParentAmbiguous,
        teamId: mayReadTeam ? snapshot.team?.id || null : null });
      continue;
    }
    // A host-only/team lead must not create a second primary in the OfficeVM.
    const canonicalRole = roleKind === 'lead' ? 'agent' : 'subagent';
    const role = canonicalRole;
    const presence = memberPresenceWithGrace(host, canReadSessions ? activityOccupant : null,
      snapshot.observedAt, tracker, member.id, host?.id || id);
    const execution = presence.execution;
    additions.push({ id, role, name: safeMemberName, title: { key: 'sessionTitle.named', params: { name: safeMemberName } },
      roleLabel: { key: 'occupantRole.' + role },
      stationUid: null, look: templ.look, ...(templ.automaticLook ? { automaticLook: templ.automaticLook } : {}), ruleId: templ.ruleId,
      destination: null, sessionKey: canReadSessions ? runtimeOccupant?.sessionKey || null : null,
      tokens: canReadSessions ? runtimeOccupant?.tokens || 0 : 0, lastSeenAt: canReadSessions ? runtimeOccupant?.lastSeenAt || host?.observedAt || snapshot.observedAt : host?.observedAt || snapshot.observedAt,
      ...(canReadSessions && runtimeOccupant?.model ? { model: runtimeOccupant.model } : {}),
      ...(canReadSessions && runtimeOccupant?.project ? { project: runtimeOccupant.project } : {}),
      ...(canReadSessions && runtimeOccupant?.runtime ? { runtime: runtimeOccupant.runtime } : {}),
      ...(canReadSessions && runtimeOccupant?.tokensKnown ? { tokensKnown: true } : {}),
      ...(canReadSessions && runtimeOccupant?.startedAt ? { startedAt: runtimeOccupant.startedAt } : {}),
      ...(canReadSessions && runtimeOccupant?.lastActivityAt ? { lastActivityAt: runtimeOccupant.lastActivityAt } : {}),
      execution, state: presence.state, stateSince: presence.stateSince,
      ...(version === 3 && host ? { hostAgentId: host.id, hostRole: host.role, hostStatus: host.status } : {}),
      parentId: parentId && parentId !== id ? parentId : null, parentAmbiguous: inferredParentAmbiguous,
      teamId: mayReadTeam ? snapshot.team?.id || null : null });
  }
  // A fresh, exact runtime↔pane identity link is live process presence even if
  // transcript evidence has gone quiet. Use it only for host-authorized office
  // projections; names alone and stale pane rows never create occupants.
  const representedHosts = new Set(selectedMembers.map(row => row.host?.id).filter(Boolean));
  const representedOccupants = new Set([...existing.keys(), ...updates.keys(), ...additions.map(row => row.id)]);
  for (const host of snapshot.agents || []) {
    if (!host || representedHosts.has(host.id) || !Number.isSafeInteger(snapshot.observedAt) || !Number.isSafeInteger(host.observedAt)
      || !Number.isSafeInteger(host.staleAfter) || host.observedAt > snapshot.observedAt || host.staleAfter <= snapshot.observedAt) continue;
    const link = links.get(host.id), agent = link && agentsById.get(link.agentId);
    if (!agent || agent.isPrimary) continue;
    const id = 'agent:' + agent.id;
    if (representedOccupants.has(id)) continue;
    const execution = executionForHost(host, snapshot.observedAt);
    const role = agent.spawnedBy ? 'subagent' : 'agent';
    const name = redactText(agent.displayName || agent.name || host.name || 'Agent', { maxLength: 120 }) || 'Agent';
    const state = execution.status === 'running' ? 'working' : execution.status === 'failed' ? 'error'
      : execution.status === 'succeeded' || execution.status === 'idle' ? 'idle' : 'unknown';
    const stateSince = tracker?.hostStateSince?.(host.id, state, host.observedAt) ?? host.observedAt;
    additions.push({ id, role, name, title: { key: 'sessionTitle.named', params: { name } }, roleLabel: { key: 'occupantRole.' + role },
      state, stateSince, stationUid: null, look: templ.look, ...(templ.automaticLook ? { automaticLook: templ.automaticLook } : {}),
      ruleId: templ.ruleId, destination: null, sessionKey: null, tokens: 0, lastSeenAt: host.observedAt,
      execution, ...(version === 3 ? { hostAgentId: host.id, hostRole: host.role, hostStatus: host.status } : {}) });
    representedOccupants.add(id);
  }
  // A project aggregate is a summary of its still-unclaimed sessions. Team
  // sessions are removed from that residual set above; old residual history
  // must neither keep the project row on stage nor make its state unknown.
  for (const [agentId, residual] of projectAgentResiduals) {
    const id = 'agent:' + agentId;
    if (!residual) { consumed.add(id); continue; }
    const current = existing.get(id);
    if (!current || updates.has(id)) continue;
    const run = residual.session ? executionState(residual.session.run, now) : null;
    const updated = { ...current, sessionKey: residual.key, state: residual.state,
      stateSince: residual.updatedAt ?? residual.occupant?.stateSince ?? snapshot.observedAt,
      lastSeenAt: residual.updatedAt ?? current.lastSeenAt,
      ...(residual.session?.usage ? { tokens: residual.session.usage.total || 0 } : {}),
    };
    if (residual.state === 'working') {
      const witness = run?.status === 'running' ? run : residual.occupant?.execution || null;
      if (witness?.status === 'running') updated.execution = witness === run
        ? { status: run.status, evidence: { level: run.level, observedAt: run.observedAt, expiresAt: run.expiresAt } }
        : witness;
      else delete updated.execution;
    } else if (run) updated.execution = { status: run.status, evidence: { level: run.level, observedAt: run.observedAt, expiresAt: run.expiresAt } };
    updates.set(id, updated);
  }
  if (!additions.length && !updates.size && !consumed.size) {
    tagProjectedTeamMembers(office.occupants, selectedMembers);
    return office;
  }
  const occupants = [...office.occupants.filter(row => !consumed.has(row.id) || updates.has(row.id)).map(row => updates.get(row.id) || row), ...additions];
  const result = projectOfficeRoster(refreshOfficePopulation({ ...office, occupants }));
  tagProjectedTeamMembers(result.occupants, selectedMembers);
  return result;
}

function tagProjectedTeamMembers(rows, selectedMembers) {
  const byAlias = new Map();
  for (const selected of selectedMembers) for (const alias of memberAliases(selected)) if (alias) byAlias.set(alias, selected);
  for (const row of rows) {
    const selected = byAlias.get(row.id);
    if (selected) tagTeamMember(row, selected.member.id, memberAliases(selected));
  }
}

function memberAliases(selected) {
  const { runtimeOccupant, canonicalPrimary, matchingSessionOccupants, exactSessionKey, id } = selected;
  return [id, exactSessionKey, runtimeOccupant?.id, canonicalPrimary?.id, ...(matchingSessionOccupants || []).map(row => row.id)];
}

// Private geometry input for the shared OfficeVM placement. It intentionally
// ignores viewer grants, then returns only fields required to allocate floors
// and seats. Callers must never serialize this projection as an OfficeVM.
function projectOfficeTeamPlacementPopulation(office, snapshot, options = {}) {
  if (!office || !Array.isArray(office.occupants) || !snapshot) return office?.occupants || [];
  const { runtimeAgents = [], tracker = null, version = 3 } = options;
  const agents = new Map(runtimeAgents.filter(row => row?.id).map(row => [row.id, row]));
  const hosts = new Map((snapshot.agents || []).filter(row => row?.id).map(row => [row.id, row]));
  const occupantForSession = sessionKey => office.occupants.find(row => row.sessionKey === sessionKey)?.id || null;
  const linksByAgent = new Map();
  for (const link of snapshot.identityLinks || []) {
    if (link?.confidence !== 'exact' || !['shared-runtime-session-ref', 'explicit-runtime-identity'].includes(link.evidence)) continue;
    const bucket = linksByAgent.get(link.agentId) || []; bucket.push(link); linksByAgent.set(link.agentId, bucket);
  }
  const annotated = { ...office, occupants: office.occupants.map(row => {
    const runtimeAgent = row.role === (version === 2 ? 'main' : 'primary') ? runtimeAgents.find(item => item?.isPrimary)
      : runtimeAgents.find(item => row.id === 'agent:' + item.id);
    const matching = runtimeAgent ? linksByAgent.get(runtimeAgent.id) || [] : [];
    if (matching.length !== 1) return row;
    const link = matching[0], host = hosts.get(link.hostAgentId);
    const lineage = host?.spawnedBy;
    const parentOccupantId = lineage ? occupantForSession(lineage.sessionKey)
      || (lineage.agentId && (agents.get(lineage.agentId)?.isPrimary ? (version === 2 ? 'main' : 'primary') : 'agent:' + lineage.agentId)) : null;
    return projectOfficeOccupant(row, host, link, null, { sourceEnabled: true, placementOnly: true, tracker,
      agentId: runtimeAgent.id, parentOccupantId, observedAt: snapshot.observedAt });
  }) };
  const projected = projectOfficeTeamOccupants(annotated, snapshot, null, { ...options, sourceEnabled: true,
    canReadSessions: true, placementOnly: true });
  return projected.occupants.map(row => tagTeamMember({ id: row.id, role: row.role, parentId: row.parentId || null,
    teamId: row.teamId || null, state: row.state, stateSince: row.stateSince, gone: row.gone === true, visitPhase: row.visitPhase || null,
    stationUid: row.stationUid ?? null, homeFloor: row.homeFloor ?? null }, teamMemberId(row), teamMemberAliases(row)));
}

function projectOrchestrators(snapshot, principal, { sourceEnabled = false, runtimeAgents = [] } = {}) {
  assertCanRead(principal, 'orchestrators');
  if (!sourceEnabled) return { hosts: [], orchestrators: [], agents: [], revision: null };
  // IdentityLink is the only authority for connecting a Herdr pane to a runtime
  // occupant. Never reconcile here from names (or accept a partial/ambiguous link).
  const agentsById = new Map((Array.isArray(runtimeAgents) ? runtimeAgents : [])
    .filter(agent => agent && typeof agent.id === 'string').map(agent => [agent.id, agent]));
  const exactLinks = new Map();
  for (const link of snapshot.identityLinks || []) {
    if (!link || link.confidence !== 'exact'
      || !['shared-runtime-session-ref', 'explicit-runtime-identity'].includes(link.evidence)
      || typeof link.hostAgentId !== 'string' || typeof link.agentId !== 'string'
      || !agentsById.has(link.agentId)) continue;
    const ids = exactLinks.get(link.hostAgentId) || new Set();
    ids.add(link.agentId);
    exactLinks.set(link.hostAgentId, ids);
  }
  const linkedHosts = new Set([...exactLinks].filter(([, ids]) => ids.size === 1).map(([hostAgentId]) => hostAgentId));
  // A registered host observation is replaced by the team/office projection
  // only for callers who can read that replacement. Host-only readers retain
  // the same safe Herdr row projection as any unregistered observation.
  const registeredPanes = can(principal, 'teams')
    ? new Set((snapshot.members || []).map(member => member?.hostAgentId).filter(id => typeof id === 'string'))
    : new Set();
  return {
    hosts: (snapshot.hosts || []).map((x) => ({ id: x.id, label: x.label, platform: x.platform, status: x.status, observedAt: x.observedAt })),
    orchestrators: (snapshot.orchestrators || []).map((x) => ({ id: x.id, hostId: x.hostId, kind: x.kind, label: x.label, sourceStatus: x.sourceStatus, observedAt: x.observedAt })),
    agents: (snapshot.agents || []).filter(x => !linkedHosts.has(x.id) && !registeredPanes.has(x.id)).map((x) => {
      const linked = exactLinks.get(x.id);
      const linkedAgentId = linked?.size === 1 ? linked.values().next().value : null;
      const runtimeAgent = linkedAgentId ? agentsById.get(linkedAgentId) : null;
      // This opaque occupant reference lets an authorized client annotate an
      // existing office occupant. It does not add a person to OfficeVM3.
      const linkedOccupantId = runtimeAgent ? (runtimeAgent.isPrimary ? 'primary' : 'agent:' + runtimeAgent.id) : null;
      return { id: x.id, hostId: x.hostId, orchestratorId: x.orchestratorId, name: x.name,
        runtimeKind: x.runtimeKind, role: x.role, status: x.status, observedAt: x.observedAt, staleAfter: x.staleAfter,
        ...(linkedOccupantId ? { linkedOccupantId } : {}) };
    }),
    revision: snapshot.revision, hostRevision: snapshot.hostRevision, teamRevision: snapshot.teamRevision, observedAt: snapshot.observedAt,
  };
}

function projectTeamBoard(snapshot, principal, { sourceEnabled = false, runtimeBrands = [] } = {}) {
  assertCanRead(principal, 'teams');
  if (!sourceEnabled) return null;
  const canResolve = can(principal, 'teams.report.resolve');
  const brands = new Map((Array.isArray(runtimeBrands) ? runtimeBrands : []).filter(row => row && typeof row.id === 'string')
    .map(row => [row.id, row.brand || null]));
  return {
    team: { id: snapshot.team.id, label: snapshot.team.label, status: snapshot.team.status },
    members: (snapshot.members || []).map((m) => ({ id: m.id, name: m.name, roleKind: m.roleKind || 'unknown', roleLabel: m.roleLabel ?? null, status: m.status, runtimeKind: m.runtimeKind ?? null,
      ...(brands.has(m.runtimeKind) ? { brand: brands.get(m.runtimeKind) } : {}),
      hostAgentId: can(principal, 'orchestrators') ? m.hostAgentId ?? null : null,
      parentMemberId: m.parentMemberId ?? null,
      ...(can(principal, 'orchestrators') ? { sessionStatus: m.sessionStatus || 'unknown' } : {}),
      spawnedBy: can(principal, 'orchestrators') ? m.spawnedBy ?? null : null })),
    tasks: (snapshot.tasks || []).map((task) => ({
      id: task.id, title: task.title, state: task.state, priority: task.priority,
      ownerMemberId: task.ownerMemberId ?? null, reviewerMemberIds: [...(task.reviewerMemberIds || [])],
      createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null,
      reportPresent: !!task.reportPresent, briefPresent: !!task.briefPresent, messageCount: task.messageCount || 0,
      reviews: (snapshot.reviews || []).filter((review) => review.taskId === task.id).map((review) => ({
        id: review.id, reviewerMemberId: review.reviewerMemberId ?? null, verdict: review.verdict,
        createdAt: review.createdAt ?? null, reportPresent: !!review.reportPresent,
        ...(canResolve && reportRefs.isIssued(review.reportRef) ? { reportRef: { id: review.reportRef.id, displayName: { key: 'team.report' } } } : {}),
      })),
      ...(canResolve && reportRefs.isIssued(task.reportRef) ? { reportRef: { id: task.reportRef.id, displayName: { key: 'team.report' } } } : {}),
    })),
    diagnostics: (() => {
      const skippedTaskCount = Number.isSafeInteger(snapshot.diagnostics?.skippedTaskCount) && snapshot.diagnostics.skippedTaskCount > 0
        ? Math.min(5000, snapshot.diagnostics.skippedTaskCount) : 0;
      const skippedMemberCount = Number.isSafeInteger(snapshot.diagnostics?.skippedMemberCount) && snapshot.diagnostics.skippedMemberCount > 0
        ? Math.min(5000, snapshot.diagnostics.skippedMemberCount) : 0;
      const skippedCount = skippedTaskCount + skippedMemberCount;
      return { skippedTaskCount, skippedMemberCount, skippedCount,
        partialLabel: skippedCount ? { key: 'team.board.partial', params: { count: skippedCount } } : null,
        quality: skippedCount ? 'partial' : 'complete' };
    })(),
    revision: snapshot.revision,
  };
}

// The current production topic cache is server-wide. Never key a future
// principal-specific projection by source revision alone.
function projectionCacheKey({ principalId, permissionRevision, registryRevision, sourceId, sourceRevision }) {
  for (const [k, v] of Object.entries({ principalId, permissionRevision, registryRevision, sourceId, sourceRevision })) {
    if ((typeof v !== 'string' && !Number.isSafeInteger(v)) || String(v).length === 0) throw new TypeError(`invalid ${k}`);
  }
  return JSON.stringify([principalId, permissionRevision, registryRevision, sourceId, sourceRevision]);
}

function can(principal, resource) {
  return allowsPrincipal(principal, resource, 'read');
}

module.exports = { projectOfficeOccupant, projectOfficeTeamOccupants, projectOfficeTeamPlacementPopulation, projectOrchestrators, projectTeamBoard, projectionCacheKey,
  issueReportRef: () => reportRefs.issue(), refreshOfficePopulation };
