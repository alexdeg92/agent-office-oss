'use strict';
/*
 * S7b: the read views on the adapter interface (api.md §3.2–3.7): office, flows (+ detail), logs, sessions, access,
 * interlocutors, skills (+ detail), each with its topic. Builders are pure (vm/*); this module wires them to the engine,
 * and pulls on-demand data through engine.request (typed reads, ADR-001 §12.4): a flow's runs, a session's transcript,
 * a skill's info. No VM reads a raw channel.
 */
const { ApiError, invalid } = require('./errors');
const { buildFlowListVM, buildFlowDetailVM, RUNS_MAX } = require('./vm/flows');
const { buildSkillListVM, buildSkillDetailVM } = require('./vm/skills');
const { buildLogsPage, buildSessionVM, parseLogsQuery, logsTopicOf, LIMIT_DEFAULT } = require('./vm/logs');
const { buildAccessVM, buildInterlocutorVM } = require('./vm/access');
const { buildOfficeVM, createStateTracker, officeDefaults } = require('./vm/office');
const { projectionFor } = require('./project3x');
const { isInterlocutorId, cpLength, OCCUPANT_ID_MAX } = require('../../engine/model/kinds');
const { every } = require('../../ops/timescale');
const Pof = (req) => projectionFor(req.apiVersion);   // G5: the request's contract projection

const LIVE_PULL_MS = 5000;          // transcripts of running sessions and open flow details, while subscribed
const STALE_MS = 30000;             // an on-demand read older than this is refreshed on GET

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
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
function mountViews({ r, engine, topics, store, runtime, enrichment = null, authed, ok, isSubscribed = () => false, now = () => Date.now() }) {
  // G7 (ADR-001 §14.2): interlocutor profiles come from the selected enrichers (InterlocutorProfile, cached only)
  const peek = enrichment ? (id) => enrichment.peek(id) : () => ({ resolution: 'unresolvable', profile: null });
  const names = {
    conversationMessageCount: (key) => engine.conversationMessageCount?.(key),
    interlocutorName: (id) => (enrichment ? enrichment.nameOf(id) : null),
    flowName: (jobId) => { const j = engine.cronJobs().find((x) => x.id === jobId); return j ? j.name : null; },
  };
  const actorOf = (ref) => {
    if (!ref || ref.kind === 'system') return { kind: 'system', name: 'Système' };
    const p = store ? store.persons.list().find((x) => x.id === ref.personId) : null;
    return p ? { id: p.id, kind: p.kind, name: p.name, avatarUrl: p.avatarUrl || null, state: null } : { kind: 'system', name: 'Système' };
  };
  const tracker = createStateTracker();
  const primaryAgentId = () => { const a = engine.primaryAgent(); return a ? a.id : null; };   // G3a: the one resolver
  const pendingRestart = new Set();   // S7c: skills toggled since the gateway last (re)connected
  engine.on('change', (c) => { if (c && c.channel === 'gateway.connection' && engine.gateway().connected) pendingRestart.clear(); });

  const notFound = () => { throw new ApiError('not_found'); };
  const job = (id) => engine.cronJobs().find((j) => j.id === id) || null;
  const skill = (name) => engine.skills().find((s) => s.name === name) || null;

  // S14b: the ACTIVE stored layout (seeded from the shipped default) styles the occupants; its revision is layoutRevision.
  // The occupants seen feed LayoutVM.agentsSeen (at most once a minute per occupant set).
  let seenAt = 0, seenSig = '';
  const activeLayout = () => {
    const off = officeDefaults();
    if (!store || !store.office) return off;
    const l = store.office.active(() => off.layout);
    return Object.assign({}, off, { layout: l.data, revision: l.revision });
  };
  topics.define('office', { build: (_, P) => {
    const vm = buildOfficeVM({ engine, now: now(), tracker, names, actorOf, layout: activeLayout(), P });
    // R22-04: the inventory of occupants seen is kept whatever contract built the office, in CANONICAL (3.0) form;
    // LayoutVM serves it per version. A change refreshes the layout topic (its agentsSeen).
    if (store && store.office) {
      const lr = officeDefaults().rules;
      const all = vm.occupants.map((o) => ({ id: lr.canonicalRuleId(o.id) || o.id, role: lr.canonicalRole(o.role) || o.role, name: o.name }));
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
  topics.define('flow', { params: 'path', build: ({ key }, P) => buildFlowDetailVM(job(key), engine.cronRuns(key), (engine.primaryAgent() || {}).id || null, P) || notFound() });
  topics.define('logs', { params: ['kind', 'heartbeat'], build: (q, P) => {
    const p = parseLogsQuery(q, P); if (p.error) throw invalid(p.error.field, p.error.issue);
    return buildLogsPage(engine.sessions(), Object.assign(p, { offset: 0 }), names, P);
  } });
  const traceStates = new Map();   // R16-07: session key → the last transcript read's outcome
  const traceStateOf = (out) => (out.ok ? 'fresh' : out.category === 'capability-unavailable' ? 'unavailable' : 'stale');
  // architect-55: the trace never shows what the adapter declares hidden (the project-tag call)
  const hidden = runtime && runtime.definition && typeof runtime.definition.hiddenTraceEvent === 'function' ? runtime.definition.hiddenTraceEvent : null;
  const shown = (t) => (t && hidden && t.events.some(hidden) ? Object.assign({}, t, { events: t.events.filter((e) => !hidden(e)) }) : t);
  topics.define('session', { params: 'path', build: ({ key }, P) => buildSessionVM(engine.session(key), shown(engine.transcript(key)), names,
    traceStates.get(key) || (engine.transcript(key) ? 'fresh' : 'stale'), P) || notFound() });
  topics.define('access', { build: (_, P) => buildAccessVM({ agents: engine.agents(), sessions: engine.sessions(), config: engine.config(), peek, primaryId: primaryAgentId(), P }) });
  topics.define('interlocutor', { params: 'path', build: ({ key }, P) => buildInterlocutorVM(key, { sessions: engine.sessions(), config: engine.config(), peek, P }) || notFound() });
  topics.define('skills', { build: () => buildSkillListVM(engine.skills()) });
  topics.define('skill', { params: 'path', build: ({ key }) => {
    const info = engine.skillInfo(key);
    const doc = runtime && runtime.skillDoc && info ? runtime.skillDoc(info.filePath) : { markdown: '' };
    return buildSkillDetailVM(skill(key), info, doc, pendingRestart.has(key)) || notFound();
  } });

  // ---- on-demand reads ---------------------------------------------------------------------------------------
  // R14-07: → the ReadOutcome ({ ok } | { ok:false, category }); only a SUCCESS is remembered (a failure is retried at
  // once). A failed read keeps the last good value in the engine, whose source state marks the response stale.
  const lastPull = new Map();   // 'op#key' → ms of the last successful read
  async function pull(op, key, opts, { force = false } = {}) {
    const k = op + '#' + key;
    if (!force && lastPull.has(k) && now() - lastPull.get(k) < STALE_MS) return { ok: true, cached: true };
    const res = await engine.request(op, key, opts);
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
  const send = (res, id) => { const t = topics.current(id, res.req.apiVersion); if (!t) throw new ApiError('not_found'); ok(res, t.vm, { id: t.id, rev: t.rev }); };

  r.get('/views/office', authed, (req, res) => send(res, 'office'));
  r.get('/views/flows', authed, (req, res) => send(res, 'flows'));
  r.get('/views/flows/:jobId', authed, async (req, res) => {
    const id = req.params.jobId;
    if (!FLOW_ID.test(id)) throw invalid('jobId', 'invalid-id');
    if (!job(id)) throw new ApiError('not_found');
    settle(await pull('flowRuns', id, { limit: RUNS_MAX }, { force: true }), !!engine.cronRuns(id));
    send(res, topicOf('flow', id));
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
    const key = req.params.key;
    if (!key || !engine.session(key)) throw new ApiError('not_found');
    // the session row IS the view's data; a failed or unavailable transcript read leaves the trace as it was (or
    // empty), and the response carries the failed source in meta.stale (R14-07)
    await pull('transcript', key, { full: true }, { force: true });
    send(res, topicOf('session', key));
  });
  r.get('/views/access', authed, (req, res) => send(res, 'access'));
  r.get('/views/interlocutors/:id', authed, async (req, res) => {
    const id = req.params.id;
    // which interlocutors exist on the wire is the projection's rule (2.x: Discord's only; 3.0 D5: any channel's)
    if (!id || !isInterlocutorId(id) || !Pof(req).interlocutorVisible(id)) throw new ApiError('not_found');
    // the profile is fetched on demand (cached afterwards); a failed lookup still answers, with resolution 'failed'
    if (enrichment && enrichment.handles(id) && peek(id).resolution === 'pending') {
      try { await enrichment.resolve(id); } catch (_) { /* stays pending */ }
    }
    topics.invalidateIds([topicOf('interlocutor', id)]);   // R14-09: a built topic is rebuilt with what the enricher now knows
    send(res, topicOf('interlocutor', id));
  });
  r.get('/views/skills', authed, (req, res) => send(res, 'skills'));
  r.get('/views/skills/:name', authed, async (req, res) => {
    const name = req.params.name;
    if (!SKILL_NAME.test(name) || !skill(name)) throw new ApiError('not_found');
    settle(await pull('skillInfo', name, { agentId: primaryAgentId() || undefined }), !!engine.skillInfo(name));
    send(res, topicOf('skill', name));
  });

  // While a flow detail or a running session's trace is SUBSCRIBED (R14-08: a GET alone starts nothing), keep it fresh.
  const ticker = setInterval(() => {
    for (const id of topics.ids('flow').filter(isSubscribed)) { const key = decodeKey(id.slice(5)); if (key) pull('flowRuns', key, { limit: RUNS_MAX }, { force: true }).catch(() => {}); }
    for (const id of topics.ids('session').filter(isSubscribed)) {
      const key = decodeKey(id.slice(8)); const s = key ? engine.session(key) : null;
      const t = key ? engine.transcript(key) : null;
      if (s && (s.run.status === 'running' || (t && s.updatedAt && s.updatedAt > t.fetchedAt))) {
        pull('transcript', key, {}, { force: true }).catch(() => {});
      }
    }
  }, every(LIVE_PULL_MS));
  if (ticker.unref) ticker.unref();
  // R14-18: a fired flow (the engine's canonical LiveEvent, whatever adapter produced it) refreshes its runs at once
  engine.on('live', (e) => {
    if (!e || e.kind !== 'cron.fired' || !e.cronJobId) return;
    if (isSubscribed(topicOf('flow', e.cronJobId))) pull('flowRuns', e.cronJobId, { limit: RUNS_MAX }, { force: true }).catch(() => {});
  });
  // R14-09: an enrichment result (on demand or background) refreshes every projection that shows names
  if (enrichment) {
    enrichment.onChange(() => { for (const n of ['interlocutor', 'access', 'logs', 'session', 'office']) topics.invalidate(n); });
  }

  return { pendingRestart, close: () => clearInterval(ticker), pull, actorOf };
}

module.exports = { mountViews };
