'use strict';

const { TeamMember, HostAgent } = require('../model');

// Joins the two read-only adapter snapshots without importing private source
// references into their public rows. Callers own reader lifecycle/configuration.
function createOrchestratorTeamSnapshots({ herdr = null, teamStore = null, now = () => Date.now(),
  runtimeIdentityAgents = () => [], runtimeIdentitySessions = () => [],
  identityResolver = require('../engine/orchestrator-identity').createOrchestratorIdentityResolver() } = {}) {
  let herdrReader = herdr, teamReader = teamStore, started = false;
  let revision = 0;
  let hostRevision = 0;
  let teamRevision = 0;
  let hostSnapshot = null;
  let teamSnapshot = null;
  const listeners = new Set();
  const publish = (kind, value) => {
    if (kind === 'host') { hostSnapshot = value; hostRevision++; }
    else { teamSnapshot = value; teamRevision++; }
    revision++;
    for (const listener of [...listeners]) { try { listener({ revision, kind }); } catch (_) { /* observers cannot break source ingestion */ } }
  };
  const get = () => {
    const h = hostSnapshot, t = teamSnapshot;
    // Raw Herdr references are consumed only by the private resolver. Keep them
    // out of the joined snapshot and all public projections.
    const sessionIdentities = typeof runtimeIdentitySessions === 'function' ? runtimeIdentitySessions() : [];
    const identityLinks = h && identityResolver ? identityResolver.reconcile({
      hosts: (h.agents || []).map(row => ({ row, sessionRef: h.privateIdentityRefs?.get(row.id) || null })),
      agents: [...(typeof runtimeIdentityAgents === 'function' ? runtimeIdentityAgents() : []),
        ...sessionIdentities.filter(row => row && typeof row.agentId === 'string').map(row => ({ ...row, id: row.agentId }))],
    }) : [];
    const hostByPane = new Map();
    const hostBySession = new Map();
    for (const host of h?.agents || []) {
      const pane = h.privatePaneRefs?.get(host.id);
      if (typeof pane === 'string' && !hostByPane.has(pane)) hostByPane.set(pane, host);
      const sessionRef = h.privateIdentityRefs?.get(host.id);
      if (typeof sessionRef === 'string' && sessionRef) {
        const key = JSON.stringify([host.runtimeKind, sessionRef]);
        const rows = hostBySession.get(key) || [];
        rows.push(host); hostBySession.set(key, rows);
      }
    }
    const linksByHost = new Map(identityLinks.map(link => [link.hostAgentId, link]));
    const sessions = sessionIdentities
      .filter(row => row && typeof row.sessionRef === 'string' && row.sessionRef && typeof row.sessionKey === 'string');
    const sessionRows = new Map();
    for (const row of sessions) {
      const matches = sessionRows.get(row.sessionRef) || [];
      matches.push(row); sessionRows.set(row.sessionRef, matches);
    }
    const memberRefs = t?.privateMemberRefs || {};
    const lineageFor = sourceMember => {
      const parentRef = sourceMember?.spawnedBy && memberRefs[sourceMember.spawnedBy];
      if (!parentRef) return null;
      const parentHost = parentRef.herdrPane ? hostByPane.get(parentRef.herdrPane) : null;
      const rawSessionRef = parentRef.session?.value || (parentHost && h.privateIdentityRefs?.get(parentHost.id));
      const exactSessions = rawSessionRef ? (sessionRows.get(rawSessionRef) || []).filter(row => row.runtimeKind === parentRef.runtime) : [];
      if (exactSessions.length === 1) return { agentId: null, sessionKey: exactSessions[0].sessionKey, via: 'orchestrator', label: null };
      const currentPaneSession = parentHost && h.privateIdentityRefs?.get(parentHost.id);
      if (parentRef.session?.value && parentRef.session.value !== currentPaneSession) return null;
      const link = parentHost && linksByHost.get(parentHost.id);
      if (link?.confidence === 'exact') return { agentId: link.agentId, sessionKey: null, via: 'orchestrator', label: null };
      return null;
    };
    const memberByPane = new Map();
    for (const [memberId, ref] of Object.entries(memberRefs)) {
      if (typeof ref.herdrPane !== 'string') continue;
      const bucket = memberByPane.get(ref.herdrPane) || [];
      bucket.push({ memberId, ref }); memberByPane.set(ref.herdrPane, bucket);
    }
    const memberSessionKeys = {};
    const memberSessionRefs = {};
    const canonicalMembers = (t?.members || []).map(member => {
      const sourceRows = Object.entries(memberRefs).filter(([id]) => member.id === id);
      const source = sourceRows.length === 1 ? sourceRows[0][1] : null;
      const recordedSession = source?.session?.value;
      const runtimeKind = source?.runtime === 'claude' ? 'claude-code' : source?.runtime;
      const sessionMatches = typeof recordedSession === 'string' && recordedSession
        ? hostBySession.get(JSON.stringify([runtimeKind, recordedSession])) || [] : [];
      const recordedRuntimeMatches = typeof recordedSession === 'string' && recordedSession
        ? (sessionRows.get(recordedSession) || []).filter(row => row.runtimeKind === runtimeKind) : [];
      const paneHost = source?.herdrPane ? hostByPane.get(source.herdrPane) : null;
      const paneSession = paneHost && h.privateIdentityRefs?.get(paneHost.id);
      const paneRuntimeMatches = paneHost && typeof paneSession === 'string' && paneSession
        ? (sessionRows.get(paneSession) || []).filter(row => row.runtimeKind === runtimeKind && row.hostId === paneHost.hostId) : [];
      const runtimeMatch = recordedRuntimeMatches.length === 1 ? recordedRuntimeMatches[0]
        : recordedRuntimeMatches.length === 0 && paneRuntimeMatches.length === 1 ? paneRuntimeMatches[0] : null;
      if (runtimeMatch) {
        memberSessionKeys[member.id] = runtimeMatch.sessionKey;
        memberSessionRefs[member.id] = Object.freeze({ runtimeKind: runtimeMatch.runtimeKind,
          sessionRef: runtimeMatch.sessionRef, sessionKey: runtimeMatch.sessionKey,
          ...(typeof runtimeMatch.agentId === 'string' ? { agentId: runtimeMatch.agentId } : {}) });
      }
      // A current pane reference preserves registered membership across a
      // restarted session; the stale session stays explicitly unknown. When
      // pane metadata is absent, only a unique exact runtime/session match can
      // link the member to a Herdr observation.
      const paneMatch = paneHost || (sessionMatches.length === 1 ? sessionMatches[0] : null);
      const observedSession = paneMatch ? h.privateIdentityRefs?.get(paneMatch.id) : null;
      const sessionStatus = typeof recordedSession === 'string' && recordedSession && recordedSession === observedSession ? 'known' : 'unknown';
      const spawnedBy = lineageFor(source);
      return TeamMember.from({ ...(member.toJSON?.() || member), hostAgentId: paneMatch?.id || member.hostAgentId || null, sessionStatus, spawnedBy });
    }).filter(Boolean);
    const linkedHostAgents = (h?.agents || []).map(agent => {
      const pane = h.privatePaneRefs?.get(agent.id), rows = typeof pane === 'string' ? memberByPane.get(pane) || [] : [];
      if (rows.length !== 1) return agent.toJSON ? agent.toJSON() : agent;
      const source = memberRefs[rows[0].memberId];
      const spawnedBy = lineageFor(source);
      return HostAgent.from({ ...(agent.toJSON ? agent.toJSON() : agent), spawnedBy }) || (agent.toJSON ? agent.toJSON() : agent);
    });
    const snapshot = {
      hosts: h?.host ? Object.freeze([{ id: h.host.id, label: h.host.label, platform: h.host.platform,
        status: h.host.sourceStatus, observedAt: h.host.observedAt }]) : Object.freeze([]),
      orchestrators: h?.orchestrator ? Object.freeze([{ id: h.orchestrator.id, hostId: h.orchestrator.hostId,
        kind: h.orchestrator.kind, label: h.orchestrator.label, sourceStatus: h.orchestrator.sourceStatus,
        observedAt: h.orchestrator.observedAt }]) : Object.freeze([]),
      agents: Object.freeze(linkedHostAgents),
      identityLinks: Object.freeze(identityLinks),
      team: t?.team || null,
      members: Object.freeze(canonicalMembers),
      tasks: Object.freeze([...(t?.tasks || [])].map(row => row.toJSON ? row.toJSON() : row)),
      reviews: Object.freeze([...(t?.reviews || [])].map(row => row.toJSON ? row.toJSON() : row)),
      diagnostics: Object.freeze({
        skippedTaskCount: Number.isSafeInteger(t?.diagnostics?.skippedTaskCount) && t.diagnostics.skippedTaskCount > 0
          ? Math.min(5000, t.diagnostics.skippedTaskCount) : 0,
        skippedMemberCount: Number.isSafeInteger(t?.diagnostics?.skippedMemberCount) && t.diagnostics.skippedMemberCount > 0
          ? Math.min(5000, t.diagnostics.skippedMemberCount) : 0,
      }),
      revision, hostRevision, teamRevision, observedAt: now(),
    };
    // Session keys are private projection inputs. Do not include them in the
    // enumerable/public source snapshot or canonical TeamMember rows.
    Object.defineProperty(snapshot, 'privateMemberSessionKeys', { enumerable: false, value: Object.freeze(memberSessionKeys) });
    Object.defineProperty(snapshot, 'privateMemberSessionRefs', { enumerable: false, value: Object.freeze(memberSessionRefs) });
    return Object.freeze(snapshot);
  };
  const start = () => {
    started = true;
    if (herdrReader?.start) herdrReader.start({ onSnapshot: value => publish('host', value) });
    if (teamReader?.start) teamReader.start({ onSnapshot: value => publish('team', value) });
  };
  const close = () => {
    started = false; herdrReader?.stop?.(); herdrReader?.close?.(); teamReader?.stop?.(); listeners.clear();
  };
  return Object.freeze({
    getSnapshot: get,
    refresh: async () => {
      const jobs = [];
      if (herdrReader?.refresh) jobs.push(herdrReader.refresh().then(value => publish('host', value)));
      if (teamReader?.refresh) jobs.push(teamReader.refresh().then(value => publish('team', value)));
      await Promise.all(jobs);
      return get();
    },
    start,
    setHerdr(reader) {
      herdrReader?.stop?.(); herdrReader?.close?.(); herdrReader = reader || null; hostSnapshot = null; hostRevision++; revision++;
      if (started && herdrReader?.start) herdrReader.start({ onSnapshot: value => publish('host', value) });
      for (const listener of [...listeners]) { try { listener({ revision, kind: 'host' }); } catch (_) { /* observers cannot break source ingestion */ } }
    },
    close,
    onChange(listener) { if (typeof listener !== 'function') throw new TypeError('listener required'); listeners.add(listener); return () => listeners.delete(listener); },
    get enabled() { return !!(herdrReader || teamReader); },
    get hasHerdr() { return !!herdrReader; },
    get hasTeamStore() { return !!teamReader; },
  });
}

module.exports = { createOrchestratorTeamSnapshots };
