'use strict';
/*
 * S7b: the read views on the adapter interface (api.md §3.2–3.7): office, flows (+ detail), logs, sessions, access,
 * interlocutors, skills (+ detail), each with its topic. Builders are pure (vm/*); this module wires them to the engine,
 * and pulls on-demand data through engine.request (typed reads, ADR-001 §12.4): a flow's runs, a session's transcript,
 * a skill's info. No VM reads a raw channel.
 */
const { ApiError, invalid } = require('./errors');
const { defaultAutoAdd } = require('../../adapters');
const { buildFlowListVM, buildFlowDetailVM, RUNS_MAX } = require('./vm/flows');
const { buildSkillListVM, buildSkillDetailVM } = require('./vm/skills');
const { buildLogsPage, buildSessionVM, parseLogsQuery, logsTopicOf, LIMIT_DEFAULT } = require('./vm/logs');
const { buildAccessVM, buildInterlocutorVM } = require('./vm/access');
const { buildOfficeVM, createStateTracker, officeDefaults } = require('./vm/office');
const { DEFAULT_SESSION_PRESENCE_WINDOW_MS, DEFAULT_AGENT_PRESENCE_WINDOW_MS } = require('../../engine/derive/occupants');
const { projectionFor } = require('./project3x');
const { isInterlocutorId, cpLength, OCCUPANT_ID_MAX } = require('../../engine/model/kinds');
const { every } = require('../../ops/timescale');
const Pof = (req) => projectionFor(req.apiVersion);   // G5: the request's contract projection

const LIVE_PULL_MS = 5000;          // transcripts of running sessions and open flow details, while subscribed
const STALE_MS = 30000;             // an on-demand read older than this is refreshed on GET
const sessionPresenceWindow = () => {
  const value = Number(process.env.AGENT_OFFICE_SESSION_PRESENCE_WINDOW_MS);
  return Number.isSafeInteger(value) && value >= 60_000 && value <= 86_400_000 ? value : DEFAULT_SESSION_PRESENCE_WINDOW_MS;
};
const agentPresenceWindow = () => {
  const value = Number(process.env.AGENT_OFFICE_AGENT_PRESENCE_WINDOW_MS);
  return Number.isSafeInteger(value) && value >= 60_000 && value <= 86_400_000 ? value : DEFAULT_AGENT_PRESENCE_WINDOW_MS;
};

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const {resolveWireId}=require('./runtime-projection');
const { redactText } = require('../../security/redact-text');
const {parseId}=require('../../runtime-ids');

// agent-identity-1 (security-112, critic-164): summaries, models, projects, timing, exchanges, the journal and session
// KPIs come from sessions and transcripts. A caller without the sessions read grant (`sessionsReadable({ session,
// principal })`, fail-closed) reads the office through OFFICE_LIMITED, on HTTP and SSE alike, with its own cache.
const OFFICE_LIMITED = 'office?view=limited';
const officeTopicFor = (caller, sessionsReadable, id = 'office') =>
  (id === 'office' || id.startsWith('office?')) && !sessionsReadable({ session: caller?.session || null, principal: caller?.principal || null }) ? OFFICE_LIMITED : id;
const decodeKey = (k) => { try { return decodeURIComponent(k); } catch (_) { return null; } };

/**
 * @param {object} p
 * @param {object} p.r         the /api/v2 router
 * @param {object} p.engine
 * @param {object} p.topics
 * @param {object} p.store     (persons for journal actors), may be null
 * @param {object} p.runtime   adapter runtime (skillDoc), may be null
 * @param {object} p.enrichment the selected enrichers (src/enrichers: peek, resolve, nameOf, onChange), may be null
 * @param {Function} p.authed, p.ok
 */
function mountViews({ r, engine, topics, store, runtime, configuredAgents = {}, enrichment = null, orchestratorTeams = null,
  officePrincipalFor = () => null, officeTopicFor: scopedOfficeTopicFor = null, authed, ok, isSubscribed = () => false, sessionsReadable = () => false, now = () => Date.now(),
  presenceWindowMs = sessionPresenceWindow(), agentPresenceWindowMs = agentPresenceWindow() }) {
  // G7 (ADR-001 §14.2): interlocutor profiles come from the selected enrichers (InterlocutorProfile, cached only)
  const peek = enrichment ? (id) => enrichment.peek(id) : () => ({ resolution: 'unresolvable', profile: null });
  const names = {
    agentName: id => engine.agents().find(a=>a.id===id)?.name || null,
    // T-0058: the Journaux connector and agent columns (canonical: owning connector, agent display name, redacted)
    connectorOf: key => engine.connectorOf?.(key) || null,
    agentLabel: id => { const a = engine.agents().find(a => a.id === id); return a ? redactText(a.displayName || a.name || a.id, { maxLength: 120 }) : null; },
    activity: key => engine.activity?.(key),
    senderContext: (s) => ({ runtime: runtime?.definition?.id || 'generic', sessionKey: s.key, operator: s.class.kind === 'dashboard' || s.class.explicitKey === 'portal-chat' ? store?.owner : null,
      agent: (() => { const a = engine.agents().find((a) => a.id === s.class.agentId); return a ? { ...a, id: 'agent:' + a.id } : null; })(), people: store?.persons.senderPeople?.() || store?.persons.list() || [],
      sessionOf: (key) => engine.session(key),
      nameOf: (id) => enrichment?.nameOf(id), avatarOf: (id) => enrichment?.peek(id)?.profile?.avatarUrl }),
    conversationMessageCount: (key) => engine.conversationMessageCount?.(key),
    delegatedSessions: (s) => engine.sessions().filter((child) => child.class.kind === 'subagent' && (child.parentKey === s.key || s.childKeys?.includes(child.key))),
    interlocutorName: (id) => (enrichment ? enrichment.nameOf(id) : null),
    senderName: (s) => { const { projectEvents } = require('../../engine/model/sender'); return projectEvents(engine.transcript(s.key)?.events, names.senderContext(s)).find((e) => e.senderInfo?.kind === 'human' && e.senderInfo.name)?.senderInfo.name || null; },
    flowName: (jobId) => { const j = engine.cronJobs().find((x) => x.id === jobId); return j ? j.name : null; },
  };
  const actorOf = (ref) => {
    if (!ref || ref.kind === 'system') return { kind: 'system', name: 'Système' };
    const p = store ? store.persons.list().find((x) => x.id === ref.personId) : null;
    return p ? { id: p.id, kind: p.kind, name: p.name, avatarUrl: p.avatarUrl || null, state: null } : { kind: 'system', name: 'Système' };
  };
  const tracker = createStateTracker(), limitedTracker = createStateTracker();
  let visitExpiryTimer = null, visitExpiryAt = 0;
  const scheduleOfficeExpiry = (vm) => {
    const t = now();
    const visitAt = Number(vm?.visitIntent?.until);
    const idleMinutes = activeLayout().layout?.idleRelocationMinutes;
    const idleWindow = (Number.isInteger(idleMinutes) && idleMinutes >= 1 && idleMinutes <= 1440 ? idleMinutes : 15) * 60_000;
    const relocationAt = (vm?.occupants || []).filter(row => row.state === 'idle' && !row.activity && !row.visitPhase && Number.isFinite(row.stateSince))
      .map(row => row.stateSince + idleWindow).filter(at => at > t).sort((a, b) => a - b)[0];
    const at = [visitAt, relocationAt].filter(value => Number.isFinite(value) && value > t).sort((a, b) => a - b)[0];
    if (!at) return;
    if (visitExpiryTimer && visitExpiryAt <= at) return;
    clearTimeout(visitExpiryTimer);
    visitExpiryAt = at;
    visitExpiryTimer = setTimeout(() => {
      visitExpiryTimer = null; visitExpiryAt = 0;
      topics.invalidate('office');
      topics.invalidate('office-scope');
    }, Math.min(2 ** 31 - 1, Math.max(1, at - now() + 5)));
    visitExpiryTimer.unref?.();
  };
  const isNewAgent = id => {
    if(!store?.runtimeAutoAdd)return false;
    const parsed=parseId(id,'agent'),instances=engine.runtimes?.()||[],instance=parsed?.runtime|| (instances.length===1?instances[0].id:'legacy'),local=parsed?.local||id;
    const adapter=instances.find(row=>row.id===instance)?.adapter||engine.runtime?.().adapterId;
    const state=store.runtimeAutoAdd.get(instance,defaultAutoAdd(adapter));
    return store.runtimeAutoAdd.isNew(state,local,now());
  };
  const primaryAgentId = () => { const a = engine.primaryAgent(); return a ? a.id : null; };   // G3a: the one resolver
  const pendingRestart = new Set();   // S7c: skills toggled since the gateway last (re)connected
  engine.on('change', (c) => { if (c && c.channel === 'gateway.connection' && engine.gateway().connected) pendingRestart.clear(); });

  const notFound = () => { throw new ApiError('not_found'); };
  const legacyKey = (key,kind,version=3) => resolveWireId(engine,key,kind,version);
  const job = (id,version=3) => engine.cronJobs().find((j) => j.id === legacyKey(id,'flow',version)) || null;
  const skill = (name,version=3) => engine.skills().find((s) => s.name === legacyKey(name,'skill',version)) || null;

  // S14b: the ACTIVE stored layout (seeded from the shipped default) styles the occupants; its revision is layoutRevision.
  // The occupants seen feed LayoutVM.agentsSeen (at most once a minute per occupant set).
  let seenAt = 0, seenSig = '';
  const activeLayout = () => {
    const off = officeDefaults();
    if (!store || !store.office) return off;
    const l = store.office.active(() => off.layout);
    return Object.assign({}, off, { layout: l.data, revision: l.revision });
  };
  // agent-identity-1: `office` is the full projection; `office?view=limited` the one for callers without the sessions
  // read grant (names and states only, no transcript-derived field). HTTP and SSE pick it per session (OFFICE_LIMITED).
  const assignLook = store?.office?.automaticLook ? (id, index, opts) => store.office.automaticLook(id, index, opts) : undefined;
  const placementPopulationFor = (office, snapshot, P) => {
    if (!office || !snapshot || !(orchestratorTeams?.hasHerdr || orchestratorTeams?.hasTeamStore)) return office?.occupants || [];
    return require('../orchestrator-team-projection').projectOfficeTeamPlacementPopulation(office, snapshot, {
      runtimeAgents: engine.agents(), primaryAgentId: engine.primaryAgent()?.id || null,
      runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [], runtimeSessions: engine.sessions(),
      version: P.version, tracker, agentPresenceWindowMs,
    });
  };
  topics.define('office', { params: ['view'], build: (q, P) => {
    if (q.view === 'limited') {
      const vm = buildOfficeVM({ engine, now: now(), tracker: limitedTracker, names, actorOf, layout: activeLayout(), configuredAgents, canReadSessions: false, P, assignLook, presenceWindowMs, agentPresenceWindowMs });
      // A limited reader may be the first subscriber. Build the server-only
      // full population when no shared OfficeVM cache exists so placement does
      // not depend on who has visited the view first.
      const sharedOffice = topics.current('office', P.version)?.vm || buildOfficeVM({ engine, now: now(), tracker, names, actorOf,
        layout: activeLayout(), configuredAgents, canReadSessions: true, P, isNewAgent, presenceWindowMs, agentPresenceWindowMs });
      const { projectOfficePlacement } = require('./vm/office-roster');
      const placed = projectOfficePlacement(vm, { layout: activeLayout().layout, index: officeDefaults().index,
        projectOccupantId: P.occupantId, now: now(), tracker,
        planningOccupants: placementPopulationFor(sharedOffice, orchestratorTeams?.getSnapshot?.(), P) });
      scheduleOfficeExpiry(placed);
      return placed;
    }
    if (q.view !== undefined) notFound();
    const vm = buildOfficeVM({ engine, now: now(), tracker, names, actorOf, layout: activeLayout(), configuredAgents, canReadSessions: true, P, isNewAgent, assignLook, presenceWindowMs, agentPresenceWindowMs });
    scheduleOfficeExpiry(vm);
    // R22-04: the inventory of occupants seen is kept whatever contract built the office, in CANONICAL (3.0) form;
    // LayoutVM serves it per version. A change refreshes the layout topic (its agentsSeen).
    if (store && store.office) {
      const lr = officeDefaults().rules;
      const all = vm.occupants.map((o) => ({ id: lr.canonicalRuleId(o.id) || o.id, role: lr.canonicalRole(o.role) || o.role, name: o.name,
        ...(o.automaticLook && { automaticLook: o.automaticLook }) }));
      // PM after R26-01: an occupant whose id is too long to store stays on stage and in every view; only the inventory
      // leaves it out, with a warning (store.unindexed). Not retried: it can't fit.
      const seen = all.filter((o) => cpLength(o.id) <= OCCUPANT_ID_MAX);
      if (seen.length < all.length) {
        try { engine.quarantine.record({ code: 'store.unindexed', severity: 'warn', channel: 'store.office_agents_seen', path: '$.occupant_id', source: 'store' }); } catch (_) { /* never breaks a view */ }
      }
      const sig = seen.map((o) => o.id).join(',');
      if (sig !== seenSig || now() - seenAt > 60000) {
        const changed = sig !== seenSig;
        // R24-01 / R22-04: per-row writes; a refused row is never silent (a value-free issue) and the set is retried
        let out = null;
        try { out = store.office.seen(seen, now()); } catch (_) { out = { stored: 0, rejected: seen.length }; }
        if (out && out.rejected) {
          try { engine.quarantine.record({ code: 'shape.invalid', severity: 'warn', channel: 'store.office_agents_seen', path: '$.occupant_id', source: 'store' }); } catch (_) { /* never breaks a view */ }
        } else { seenSig = sig; seenAt = now(); }
        if (changed && out && out.stored) setImmediate(() => topics.invalidate('layout'));
      }
    }
    return vm;
  } });
  topics.define('flows', { build: () => buildFlowListVM(engine.cronJobs()) });
  topics.define('flow', { params: 'path', build: ({ key:wire }, P = projectionFor(2)) => {const key=legacyKey(wire,'flow',P.version);return buildFlowDetailVM(job(key), engine.cronRuns(key), (engine.primaryAgent() || {}).id || null, P) || notFound();} });
  topics.define('logs', { params: ['kind', 'heartbeat', 'connector', 'agent'], build: (q, P) => {
    const p = parseLogsQuery(q, P); if (p.error) throw invalid(p.error.field, p.error.issue);
    return buildLogsPage(engine.sessions(), Object.assign(p, { offset: 0, now: now() }), names, P);
  } });
  const traceStates = new Map();   // R16-07: session key → the last transcript read's outcome
  const traceStateOf = (out) => (out.ok ? 'fresh' : out.category === 'capability-unavailable' ? 'unavailable' : 'stale');
  // architect-55: the trace never shows what the adapter declares hidden (the project-tag call)
  const shown = t => { const hidden = (runtime?.definitionFor?.(t?.sessionKey) || runtime?.definition)?.hiddenTraceEvent; return t && hidden && t.events.some(hidden) ? { ...t, events: t.events.filter(e => !hidden(e)) } : t; };
  // The base office remains shared by the ordinary office cache. T-0045 adds
  // team/Herdr data only through a caller-specific topic identity.
  topics.define('office-scope', { params: 'path', permission: { resource: 'office', level: 'read' }, build: ({ key }, P) => {
    const office = topics.current('office', P.version)?.vm;
    if (!office) return office;
    const principal = officePrincipalFor(key), snapshot = orchestratorTeams?.getSnapshot?.();
    if (!principal) return office;
    // Only an administrator may learn that the locally detected orchestrator
    // source is available to activate. This is a hint, never an implicit opt-in.
    const activationHint = principal.role === 'admin' && orchestratorTeams?.detected === true && !orchestratorTeams?.hasHerdr
      ? { orchestratorActivationAvailable: true } : null;
    if (!snapshot || !(orchestratorTeams?.hasHerdr || orchestratorTeams?.hasTeamStore)) return activationHint ? { ...office, ...activationHint } : office;
    const { projectOfficeOccupant, projectOfficeTeamOccupants } = require('../orchestrator-team-projection');
    const agents = engine.agents(), links = snapshot.identityLinks || [];
    const rows = new Map((snapshot.agents || []).map(row => [row.id, row]));
    const occupantAgent = occupant => occupant.role === 'primary' ? engine.primaryAgent() : agents.find(agent => occupant.id === 'agent:' + agent.id);
    const occupantForAgent = agentId => {
      const agent = agents.find(row => row.id === agentId); if (!agent) return null;
      const native = agent.isPrimary ? 'primary' : 'agent:' + agent.id;
      const projected = Pof({ apiVersion: 3 }).occupantId(native);
      return office.occupants.some(row => row.id === projected) ? projected : null;
    };
    const occupantForSession = sessionKey => {
      if (!sessionKey) return null;
      const direct = office.occupants.find(row => row.sessionKey === sessionKey);
      if (direct) return direct.id;
      const session = engine.session(sessionKey);
      return session?.class?.agentId ? occupantForAgent(session.class.agentId) : null;
    };
    const annotated = { ...office, occupants: office.occupants.map(occupant => {
      if (P.version !== 3) return occupant;
      const agent = occupantAgent(occupant); if (!agent) return occupant;
      const matches = links.filter(link => link.agentId === agent.id && link.confidence === 'exact');
      if (matches.length !== 1) return occupant;
      const link = matches[0], host = rows.get(link.hostAgentId), lineage = host?.spawnedBy || null;
      const parentOccupantId = lineage ? occupantForSession(lineage.sessionKey) || occupantForAgent(lineage.agentId) : null;
      return projectOfficeOccupant(occupant, host, link, principal, { sourceEnabled: true, agentId: agent.id, parentOccupantId, observedAt: snapshot.observedAt, tracker });
    }) };
    const projected = projectOfficeTeamOccupants(annotated, snapshot, principal, { sourceEnabled: true, runtimeAgents: agents,
      primaryAgentId: engine.primaryAgent()?.id || null, runtimeIdentitySessions: engine.identitySessions?.(snapshot.agents?.[0]?.hostId) || [],
      runtimeSessions: engine.sessions(),
      canReadSessions: office.occupants.some(row => typeof row.sessionKey === 'string' && row.sessionKey), version: P.version, tracker, agentPresenceWindowMs });
    const { projectOfficeRoster, projectOfficePlacement } = require('./vm/office-roster');
    const roster = projectOfficeRoster(projected, { projectOccupantId: P.occupantId });
    const placed = projectOfficePlacement(roster, { layout: activeLayout().layout, index: officeDefaults().index, projectOccupantId: P.occupantId, now: now(), tracker,
      planningOccupants: placementPopulationFor(office, snapshot, P) });
    return activationHint ? { ...placed, ...activationHint } : placed;
  } });
  const officeTopic = req => {
    const ordinary = officeTopicFor(req, sessionsReadable);
    return ordinary === 'office' && scopedOfficeTopicFor ? scopedOfficeTopicFor(req) : ordinary;
  };
  topics.define('session', { params: 'path', build: ({ key:wire }, P = projectionFor(2)) => {const key=legacyKey(wire,'session',P.version);return buildSessionVM(engine.session(key), shown(engine.transcript(key)), names,
    traceStates.get(key) || (engine.transcript(key) ? 'fresh' : 'stale'), P, now()) || notFound();} });
  topics.define('access', { build: (_, P) => buildAccessVM({ agents: engine.agents(), sessions: engine.sessions(), config: engine.config(), peek, primaryId: primaryAgentId(), P }) });
  topics.define('interlocutor', { params: 'path', build: ({ key }, P) => buildInterlocutorVM(key, { sessions: engine.sessions(), config: engine.config(), peek, P }) || notFound() });
  topics.define('skills', { build: () => buildSkillListVM(engine.skills()) });
  topics.define('skill', { params: 'path', build: ({key:wire},P = projectionFor(2)) => {
    const key=legacyKey(wire,'skill',P.version);
    const info = engine.skillInfo(key);
    const doc = runtime && runtime.skillDoc && info ? runtime.skillDoc(info.filePath, key) : { markdown: '' };
    return buildSkillDetailVM(skill(key), info, doc, pendingRestart.has(key)) || notFound();
  } });

  // ---- on-demand reads ---------------------------------------------------------------------------------------
  // R14-07: → the ReadOutcome ({ ok } | { ok:false, category }); only a SUCCESS is remembered (a failure is retried at
  // once). A failed read keeps the last good value in the engine, whose source state marks the response stale.
  const lastPull = new Map();   // 'op#key' → ms of the last successful read
  async function pull(op, key, opts, { force = false, authorize = null } = {}) {
    const k = op + '#' + key;
    if (!force && lastPull.has(k) && now() - lastPull.get(k) < STALE_MS) return { ok: true, cached: true };
    const res = await require('../../security/dispatch-context').runAuthorized(authorize,()=>engine.request(op, key, opts));
    if (res.ok) lastPull.set(k, now()); else lastPull.delete(k);
    // R16-07 (R17a): EVERY transcript read (GET, ticker, the chat's shared pull) sets the session's traceState from its OWN outcome
    if (op === 'transcript') traceStates.set(key, traceStateOf(res));
    topics.invalidateIds([{ flowRuns: 'flow:', transcript: 'session:', skillInfo: 'skill:' }[op] + encodeURIComponent(key)]);
    return res;
  }
  // a read outcome at the route boundary: unavailable → 404; failed with nothing to show → 502; otherwise serve
  const settle = (out, hasData) => {
    if (out.ok) return;
    if (out.category === 'capability-unavailable') throw new ApiError('not_found');
    if (!hasData) throw new ApiError('upstream_failed', { details: [{ issue: String(out.category || 'error') }] });
  };
  const topicOf = (name, key) => name + ':' + encodeURIComponent(key);
  const send = (res, id, wire, projectionName = wire) => { const t = topics.current(id, res.req.apiVersion); if (!t) throw new ApiError('not_found'); ok(res, t.vm, { id: wire || t.id, rev: t.rev }, projectionName); };

  r.get('/views/office', authed, (req, res) => { const id = officeTopic(req); send(res, id, 'office', 'office'); });
  r.get('/views/flows', authed, (req, res) => send(res, 'flows'));
  r.get('/views/flows/:jobId', authed, async (req, res) => {
    const wire=req.params.jobId;
    if (!FLOW_ID.test(wire) && !require('../../runtime-ids').parseId(wire, 'flow')) throw invalid('jobId', 'invalid-id');
    const id=legacyKey(wire,'flow',req.apiVersion);
    if (!job(id)) throw new ApiError('not_found');
    // Runs are log-derived. A flow reader without logs never triggers that adapter read.
    if(!req.authorize||store.policy.can(req.user,'logs','read')) {
      req.authorize?.();
      const authorize = req.authorize ? () => { req.authorize(); if(!store.policy.can(req.user,'logs','read'))throw new ApiError('forbidden'); } : null;
      settle(await pull('flowRuns', id, { limit: RUNS_MAX }, { force: true, authorize }), !!engine.cronRuns(id));
    }
    send(res, topicOf('flow',wire));
  });
  r.get('/views/logs', authed, (req, res) => {
    const p = parseLogsQuery(req.query, Pof(req));
    if (p.error) throw invalid(p.error.field, p.error.issue);
    const page = buildLogsPage(engine.sessions(), p, names, Pof(req));
    // Only the first page at the default size is a topic (api.md §3: logs / logs?kind / logs?heartbeat); others are one-shot.
    if (p.offset > 0 || p.limit !== LIMIT_DEFAULT) return ok(res, page, null, 'logs');
    const t = topics.current(logsTopicOf(p), req.apiVersion);
    ok(res, t.vm, { id: t.id, rev: t.rev });
  });
  // R14-10: route params arrive decoded once (Express); topic ids are encoded with topicOf
  r.get('/views/sessions/:key', authed, async (req, res) => {
    const wire=req.params.key,key=legacyKey(wire,'session',req.apiVersion);
    if (!key || !engine.session(key)) throw new ApiError('not_found');
    // the session row IS the view's data; a failed or unavailable transcript read leaves the trace as it was (or
    // empty), and the response carries the failed source in meta.stale (R14-07)
    await pull('transcript', key, { full: true }, { force: true, authorize: req.authorize });
    req.authorize?.();
    const humans = (engine.transcript(key)?.participants || []).filter((p) => p.kind === 'human' && enrichment?.handles(p.id)).map((p) => p.id);
    if (humans.length) await enrichment.resolveAll(humans).catch(() => {});
    topics.invalidateIds([topicOf('session', key)]);
    send(res, topicOf('session',wire));
  });
  r.get('/views/access', authed, (req, res) => send(res, 'access'));
  r.get('/views/interlocutors/:id', authed, async (req, res) => {
    const id = req.params.id;
    // which interlocutors exist on the wire is the projection's rule (2.x: Discord's only; 3.0 D5: any channel's)
    if (!id || !isInterlocutorId(id) || !Pof(req).interlocutorVisible(id)) throw new ApiError('not_found');
    // the profile is fetched on demand (cached afterwards); a failed lookup still answers, with resolution 'failed'
    if (enrichment && enrichment.handles(id) && peek(id).resolution === 'pending') {
      req.authorize?.();
      try { await enrichment.resolve(id); } catch (_) { /* stays pending */ }
    }
    topics.invalidateIds([topicOf('interlocutor', id)]);   // R14-09: a built topic is rebuilt with what the enricher now knows
    send(res, topicOf('interlocutor', id));
  });
  r.get('/views/skills', authed, (req, res) => send(res, 'skills'));
  r.get('/views/skills/:name', authed, async (req, res) => {
    const wire=req.params.name;
    if (!SKILL_NAME.test(wire) && !require('../../runtime-ids').parseId(wire,'skill'))throw new ApiError('not_found');
    const name=legacyKey(wire,'skill',req.apiVersion);
    if (!skill(name))throw new ApiError('not_found');
    settle(await pull('skillInfo', name, { agentId: primaryAgentId() || undefined }, { authorize: req.authorize }), !!engine.skillInfo(name));
    send(res, topicOf('skill',wire));
  });

  // While a flow detail or a running session's trace is SUBSCRIBED (R14-08: a GET alone starts nothing), keep it fresh.
  const ticker = setInterval(() => {
    for(const version of [2,3]) {
      const registry=topics.of ? topics.of(version) : topics;
      for(const kind of ['flow','session'])for(const id of registry.ids(kind).filter(id=>isSubscribed(id,version))) {
        let key;try{key=legacyKey(decodeKey(id.slice(kind.length+1)),kind,version);}catch{continue;}
        if(!key)continue;
        if(kind==='flow'){pull('flowRuns',key,{limit:RUNS_MAX},{force:true}).catch(()=>{});continue;}
        const s=engine.session(key),t=engine.transcript(key);
        if(s && (s.run.status==='running' || (t && s.updatedAt && s.updatedAt>t.fetchedAt)))pull('transcript',key,{},{force:true}).catch(()=>{});
      }
    }
  }, every(LIVE_PULL_MS));
  if (ticker.unref) ticker.unref();
  // R14-18: a fired flow (the engine's canonical LiveEvent, whatever adapter produced it) refreshes its runs at once
  engine.on('live', (e) => {
    if (!e || e.kind !== 'cron.fired' || !e.cronJobId) return;
    const subscribed=[2,3].some(version=>{
      const registry=topics.of ? topics.of(version) : topics;
      return registry.ids('flow').some(id=>{
        if(!isSubscribed(id,version))return false;
        try{return legacyKey(decodeKey(id.slice(5)),'flow',version)===e.cronJobId;}catch{return false;}
      });
    });
    if (subscribed) pull('flowRuns', e.cronJobId, { limit: RUNS_MAX }, { force: true }).catch(() => {});
  });
  // R14-09: an enrichment result (on demand or background) refreshes every projection that shows names
  if (enrichment) {
    enrichment.onChange(() => { for (const n of ['interlocutor', 'access', 'logs', 'session', 'office']) topics.invalidate(n); });
  }

  return { pendingRestart, close: () => { clearInterval(ticker); clearTimeout(visitExpiryTimer); }, pull, actorOf };
}

module.exports = { OFFICE_LIMITED, officeTopicFor, mountViews };
