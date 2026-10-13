'use strict';
/*
 * The ingestion engine. It receives the same raw inputs as the legacy runtime (shadow taps),
 * validates them against versioned schemas, normalises sessions to canonical types (S3) and records
 * every problem in the quarantine. Diagnostics are default-deny (R1-01, see redact.js).
 *
 *   RawEnvelope = { source, channel, receivedAt, context?: { key }, body, outcome? }
 *   body        = { kind: 'json', value } | { kind: 'text', value } | { kind: 'error', message, code? }
 *   outcome     = { ok, exitCode, stderr }   (CLI only: the process result, R1-05)
 */
const { EventEmitter } = require('events');
const { createQuarantine } = require('./quarantine');
const { errorCategory, safeVersion } = require('./redact');
const schemaDsl = require('../schema');
const { createSessionsRegistry } = require('./sessions-registry');
const { MAX_CANONICAL_SESSION_SNAPSHOT } = require('./session-limits');

// G2 (ADR-001): runtime specifics come from a runtime adapter (src/adapters/<id>); the engine dispatches on the
// adapter's routes (raw channel → canonical operation) and never imports adapter internals.
const { defaultAdapter } = require('../adapters');
const CORE_SCHEMAS = require('./schemas/core.v1');
const CORE_ROUTES = { 'host.metrics': { op: 'host' } };
const schemasOf = (adapter) => Object.assign({}, adapter.schemas, CORE_SCHEMAS);
const DEFAULT_SCHEMAS = schemasOf(defaultAdapter().definition);
const { activityOf } = require('./derive/activity');
const { executionState } = require('./execution-state');
const OBSERVED_ACTIVITY_KINDS = new Set(['thinking', 'researching', 'writing', 'executing', 'calling', 'waiting', 'blocked', 'working']);
const MAX_WAITING_ACTIVITY_MS = 15 * 60_000;
const { deriveHealth, THRESHOLDS } = require('./derive/health');
const { occupantIdOf } = require('./derive/occupants');
const lvlOf = (v, t) => (v == null ? null : v >= t.alert ? 'alert' : v >= t.warn ? 'warn' : 'ok');
const C = require('./model/canonical');
const { Session: SessionContract } = require('./model/session');
// PM audit (B): canonical values are stored as entity instances (frozen, validated, explicit nulls)
const M = require('../model');
const { resolvePrimaryAgent } = require('./derive/primary-agent');
const { createHealthChecks } = require('./health-checks');
const { resolveRunIdentity } = require('./run-identity');

// Vocabulary for the diagnostics privacy rule (quarantine.js): every field name declared by a raw or
// canonical schema, plus the '$.canonical.<type>' prefixes.
function declaredVocabulary(schemas) {
  const names = schemaDsl.declaredNames(Object.values(schemas).map((d) => d.schema).concat(Object.values(C), [SessionContract]));
  for (const t of ['canonical', 'agent', 'host', 'orchestrator', 'hostAgent', 'identityLink', 'team', 'teamMember', 'task', 'review', 'teamMessage',
    'cronJob', 'cronRun', 'skill', 'skillInfo', 'channel', 'transcript', 'config', 'session']) names.add(t);
  return names;
}

// Store tables whose rows are validated on read; an invalid row is reported as store.invalid on these (S5).
const STORE_CHANNELS = ['store.quarantine', 'store.interlocutor_cache', 'store.audit_log', 'store.office_agents_seen', 'store.runtime_aliases', 'config.primary',
  'core:vm.health', // legacy channel used by pre-canonical HealthVM validation reports
  // PM audit (B): a VM that failed its runtime check (vm/check.js); one channel per VM
  ...['meta', 'me', 'office', 'chat', 'flows', 'flow', 'access', 'interlocutor', 'logs', 'session', 'skills', 'skill', 'health', 'projects', 'project',
    'history', 'candidates', 'layout', 'prefs', 'settings'].flatMap((n) => ['vm.' + n, 'vm.v3.' + n])];   // G5: 'vm.v3.<name>' for contract 3.0
// G2 (§12.4): canonical ingestion. An adapter whose runtime already returns structured objects (and the fake core
// adapter in tests) hands the engine CANONICAL values; they're validated against the canonical contracts, not raw
// schemas, and recorded under the channel 'canonical.<op>'.
const CANONICAL_OPS = ['sessions.snapshot', 'sessions.upsert', 'agents', 'flows', 'flowRuns', 'skills', 'skillInfo', 'channels', 'transcript', 'config', 'hello', 'sessionGroups'];
const KEYED_OPS = new Set(['flowRuns', 'skillInfo', 'transcript']);
// Typed on-demand reads (§12.4): op → the capability that must be true, and where the canonical answer lives.
const READ_OPS = {
  transcript: { capable: (c) => !!c.transcripts },
  describeSession: { capable: (c) => !!c.sessions },
  flowRuns: { capable: (c) => !!(c.flows && c.flows.read) },
  skillInfo: { capable: (c) => !!(c.skills && c.skills.detail) },
  sessionGroups: { capable: (c) => !!c.sessionGroups },
};
const LIVE_EVENTS_MAX = 200;
const COALESCE_MS = 10 * 1000;
// Operations whose real change means "dashboard data changed" (drives the v1 SSE 'refresh'; S6 topics later).
const REFRESH_OPS = new Set(['agents', 'sessions.page', 'sessions.changed', 'flows', 'channels', 'skills', 'config', 'sessionGroups']);
// Test-facing override names (S4) → canonical normaliser names
const OVERRIDE_ALIASES = { cronJobs: 'flows', cronRuns: 'flowRuns' };

// `normalise` is injectable so tests can prove the canonical goldens catch a corrupted normaliser.
// `overrides` replaces S4 normalisers by name (agents, cronJobs, cronRuns, skills, skillInfo, channels,
// transcript, config): tests use it to prove the canonical goldens catch a corrupted normaliser.
// A connector's mark as the adapter declares it; otherwise derive a contrast-safe monogram.
const { normaliseLineage } = require('./model/lineage');
function markOf(adapter) {
  const m = adapter.mark, ok = m && typeof m.monogram === 'string' && /^\S{1,3}$/.test(m.monogram) && /^#[0-9a-f]{6}$/i.test(m.color || '');
  if (ok) return { monogram: m.monogram, color: m.color.toLowerCase(), ...(typeof m.logo === 'string' ? { logo: m.logo } : {}), ...(typeof m.logoDark === 'string' ? { logoDark: m.logoDark } : {}), ...(typeof m.providerName === 'string' ? { providerName: m.providerName } : {}) };
  const name = String(adapter.name || adapter.id || '?');
  const monogram = (name.match(/[A-Za-z0-9]+/g) || ['?']).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  // a stable hue from the adapter id, dark enough that white text keeps ≥ 4.5:1 on every hue (WCAG AA)
  let h = 0; for (const c of String(adapter.id || name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360, l = 0.30, a = 0.5 * Math.min(l, 1 - l), f = (n) => { const k = (n + hue / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return { monogram, color: '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('') };
}

function createEngine({ adapter, schemas, now = () => Date.now(), normalise, overrides = {}, primary = null, agentNames = {}, hiddenAgents = [], configuredAgents = null, senderContext = () => ({}), runtimeId = null, onHealthAudit = () => {}, autoAddedAgents = [], excludedAgents = [], autoAddManaged = false, onAutoAddAgent = null } = {}) {
  adapter = adapter || defaultAdapter().definition;
  schemas = schemas || schemasOf(adapter);
  const N = Object.assign({}, adapter.normalise);
  for (const [k, fn] of Object.entries(overrides)) N[OVERRIDE_ALIASES[k] || k] = fn;
  const routeOf = (channel) => (Object.prototype.hasOwnProperty.call(adapter.routes, channel) ? adapter.routes[channel]
    : Object.prototype.hasOwnProperty.call(CORE_ROUTES, channel) ? CORE_ROUTES[channel] : null);
  const advertisedEvents = new Set();   // the runtime's own event vocabulary (OpenClaw: hello features.events)
  const declared = declaredVocabulary(schemas);
  const quarantine = createQuarantine({ now, vocab: { declared, channels: new Set(Object.keys(schemas).concat(STORE_CHANNELS, CANONICAL_OPS.map((op) => 'canonical.' + op))),
    events: () => advertisedEvents, eventPrefix: adapter.eventPrefix } });
  const registry = new Map();     // channel(+request key) → { value, at }
  // Adapter-private cross-source identifiers, keyed by canonical session key.
  // They are deliberately kept outside canonical entities and VM projections.
  const identitySessionRefs = new Map();
  const ev = new EventEmitter();
  let openclawVersion = null;

  // ---- source freshness, per channel (R1-03) ------------------------------------------------
  // A source is 'down' while its transport is down (gateway disconnected), else 'stale' if ANY of
  // its channels' last outcome was a failure, else 'fresh'. One channel's success never hides
  // another channel's failure.
  const sources = new Map();      // source → { down, channels: Map(channel → status) }
  const src = (id) => { if (!sources.has(id)) sources.set(id, { down: false, downReason: null, channels: new Map() }); return sources.get(id); };
  const chan = (sid, channel) => { const s = src(sid); if (!s.channels.has(channel)) s.channels.set(channel, { channel, state: 'fresh', lastOkAt: null, lastErrorAt: null, lastError: null }); return s.channels.get(channel); };
  const ok = (sid, channel) => { const c = chan(sid, channel); c.state = 'fresh'; c.lastOkAt = now(); };
  const fail = (sid, channel, category) => { const c = chan(sid, channel); c.state = 'stale'; c.lastErrorAt = now(); c.lastError = category; };
  // R6-12: a repeated identical state is not a change. Source state reaches the UI through checkStatus().
  // `reason` is a category ('not-connected' by default; 'not-configured' when the runtime has no identity/token, §12.1).
  function setSourceDown(sid, down, reason = 'not-connected') {
    const s = src(sid), r = down ? reason : null;
    if (s.down === !!down && s.downReason === r) return;
    s.down = !!down; s.downReason = r; checkStatus();
  }
  function sourceList() {
    return [...sources.entries()].map(([id, s]) => {
      const channels = [...s.channels.values()].map((c) => Object.assign({}, c)).sort((a, b) => a.channel.localeCompare(b.channel));
      const failing = channels.filter((c) => c.state === 'stale').sort((a, b) => b.lastErrorAt - a.lastErrorAt);
      return {
        id, state: s.down ? 'down' : failing.length ? 'stale' : 'fresh',
        lastOkAt: channels.reduce((m, c) => Math.max(m, c.lastOkAt || 0), 0) || null,
        lastErrorAt: channels.reduce((m, c) => Math.max(m, c.lastErrorAt || 0), 0) || null,
        lastError: s.down ? s.downReason : failing.length ? failing[0].lastError : null,
        channels,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---- canonical sessions (S3, S3.1: snapshots, descriptions, contract) ----------------------
  const validateIdentity = (type, item, rec) => {
    const issue = runtimeId && require('./runtime-identities').identityIssue(type, item);
    if (issue) rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical.' + type + issue });
    return !issue;
  };
  const reg = createSessionsRegistry({ now, normalise: normalise || N.session, classify: adapter.classifySession,
    validate: (item, rec) => validateIdentity('session', item, rec) });
  // ---- other canonical types (S4) -------------------------------------------------------------
  // Each hook normalises, then validates against the canonical contract (model/canonical.js); an
  // invalid object is quarantined under '$.canonical.<type>' and left out. A hook may return the value
  // the registry keeps instead of the validated raw payload (config: the projection, token as a Secret).
  const canon = { agents: [], cronJobs: [], skills: [], channels: [], config: null, host: null, sessionGroups: null,
    cronRuns: new Map(), skillInfo: new Map(), transcripts: new Map() };
  // architect-54: transcripts are kept for the views (at most TRANSCRIPTS_MAX, the least recently read go first: a view
  // reads a missing one again), and the adapter's project hints are taken from each one as it is admitted
  const TRANSCRIPTS_MAX = adapter.transcriptBounds?.sessions || 200, HINT_SESSIONS_MAX = 2000;
  // At most one generic transcript lease and one richer detail lease per session.
  // Retaining them separately lets a still-live lower-detail refresh take over
  // when its short-lived detail overlay expires.
  const observed = new Map();
  const OBSERVED_ACTIVITY_SESSIONS_MAX = 2000;
  let runExpiryTimer = null, runExpiryAt = null, engineClosed = false;
  const notifiedRunExpiries = new Map();
  const transcriptBudget = require('./transcript-budget'), transcriptKeys = new Map();
  const forgetTranscript = (key, { activity = false } = {}) => {
    canon.transcripts.delete(key); fullTranscripts.delete(key); conversationCounts.delete(key);
    lastJson.delete('canonical.transcript#' + key); outcomes.delete('transcript#' + key);
    registry.delete('canonical.transcript#' + key); if (activity) { observed.delete(key); scheduleRunExpiry(); }
    transcriptBudget.release(transcriptKeys.get(key)); transcriptKeys.delete(key);
  };
  function setObservedActivity(key, value) {
    const at = now();
    if (!reg.get(key) || !value || !OBSERVED_ACTIVITY_KINDS.has(value.kind) || value.source !== 'transcript' || !Number.isSafeInteger(value.since)
      || !Number.isSafeInteger(value.expiresAt) || value.since > at || value.expiresAt <= at || value.expiresAt <= value.since
      || value.expiresAt - value.since > (value.kind === 'waiting' ? MAX_WAITING_ACTIVITY_MS : 30000)) return false;
    const prior = observed.get(key) || { generic: null, detail: null };
    const next = { ...prior, [value.kind === 'working' ? 'generic' : 'detail']: { sessionKey: key, ...value } };
    observed.delete(key);
    observed.set(key, next);
    for (const [k, leases] of observed) {
      if (!reg.get(k)) { observed.delete(k); continue; }
      if (leases.generic?.expiresAt <= at) leases.generic = null;
      if (leases.detail?.expiresAt <= at) leases.detail = null;
      if (!leases.generic && !leases.detail) observed.delete(k);
    }
    while (observed.size > OBSERVED_ACTIVITY_SESSIONS_MAX) observed.delete(observed.keys().next().value);
    scheduleRunExpiry();
    ev.emit('change', { type: 'Activity' }); return true;
  }
  function clearObservedActivity(key) {
    if (!observed.delete(key)) return false;
    scheduleRunExpiry(); ev.emit('change', { type: 'Activity' }); return true;
  }
  function currentActivity(key) {
    const session = reg.get(key), verified = activityOf(session), leases = observed.get(key), run = executionState(session?.run, now());
    if (run.level === 'verified' && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (observed.delete(key)) scheduleRunExpiry();
      return null;
    }
    if (leases && !session) {
      observed.delete(key);
      scheduleRunExpiry();
      ev.emit('change', { type: 'Activity' });
    }
    const activeLeases = observed.get(key);
    const leaseExpired = !!activeLeases && (activeLeases.generic?.expiresAt <= now() || activeLeases.detail?.expiresAt <= now());
    if (activeLeases?.generic?.expiresAt <= now()) activeLeases.generic = null;
    if (activeLeases?.detail?.expiresAt <= now()) activeLeases.detail = null;
    if (activeLeases && !activeLeases.generic && !activeLeases.detail) observed.delete(key);
    if (leaseExpired) {
      scheduleRunExpiry(); ev.emit('change', { type: 'Activity' });
    }
    const live = observed.get(key);
    const genericRun = verified || (run.status === 'running' ? { sessionKey: key, kind: 'working', source: run.level === 'verified' ? 'run-state' : 'transcript',
      since: run.observedAt ?? session?.run?.startedAt ?? session?.updatedAt ?? null, expiresAt: run.expiresAt ?? null } : null);
    return live?.detail || live?.generic || genericRun;
  }
  function clearExpiredEvidence() {
    const at = now(); let changed = false;
    for (const [key, leases] of observed) {
      if (!reg.get(key)) { observed.delete(key); changed = true; continue; }
      if (leases.generic?.expiresAt <= at) { leases.generic = null; changed = true; }
      if (leases.detail?.expiresAt <= at) { leases.detail = null; changed = true; }
      if (!leases.generic && !leases.detail) { observed.delete(key); changed = true; }
    }
    const current = new Map(reg.list().map(row => [row.key, row.run]));
    for (const key of notifiedRunExpiries.keys()) if (!current.has(key) || current.get(key)?.evidenceLevel !== 'observed'
      || current.get(key)?.expiresAt !== notifiedRunExpiries.get(key)) notifiedRunExpiries.delete(key);
    for (const [key, run] of current) if (run.evidenceLevel === 'verified' && ['succeeded', 'failed', 'cancelled'].includes(run.status)
      && observed.delete(key)) changed = true;
    for (const [key, run] of current) if (run.evidenceLevel === 'observed' && Number.isSafeInteger(run.expiresAt)
      && run.expiresAt <= at && notifiedRunExpiries.get(key) !== run.expiresAt) {
      notifiedRunExpiries.set(key, run.expiresAt); changed = true;
    }
    if (changed) ev.emit('change', { type: 'Activity' });
    return changed;
  }
  // One timer covers canonical run and transcript-activity leases independently of source traffic.
  function scheduleRunExpiry(sessions = reg.list()) {
    let at = sessions.reduce((earliest, row) => row.run.evidenceLevel === 'observed' && Number.isSafeInteger(row.run.expiresAt)
      && row.run.expiresAt > now() ? Math.min(earliest, row.run.expiresAt) : earliest, Infinity);
    for (const leases of observed.values()) for (const value of [leases.generic, leases.detail])
      if (value?.expiresAt > now()) at = Math.min(at, value.expiresAt);
    if (at === runExpiryAt && runExpiryTimer) return;
    if (runExpiryTimer) clearTimeout(runExpiryTimer);
    runExpiryTimer = null; runExpiryAt = null;
    if (engineClosed || at === Infinity) return;
    runExpiryAt = at;
    runExpiryTimer = setTimeout(() => {
      runExpiryTimer = null; runExpiryAt = null;
      clearExpiredEvidence();
      scheduleRunExpiry();
    }, Math.max(0, at - now()));
    if (runExpiryTimer.unref) runExpiryTimer.unref();
  }
  const projectHints = new Map();   // sessionKey → [{ id, at, slug, status, statusIssue, note }]
  const fullTranscripts = new Set(); // opened conversations retain all turns until their cached transcript is evicted
  const conversationCounts = new Map(); // raw user/assistant counts before tail-window clipping; no tool results
  function keepTranscript(key, t) {
    canon.transcripts.delete(key); canon.transcripts.set(key, t);
    const bytes = () => [...canon.transcripts.values()].reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0);
    while (canon.transcripts.size > TRANSCRIPTS_MAX || adapter.transcriptBounds?.bytes && bytes() > adapter.transcriptBounds.bytes) {
      const oldest = canon.transcripts.keys().next().value;
      forgetTranscript(oldest);
    }
    if (adapter.transcriptBounds && canon.transcripts.has(key)) {
      if (!transcriptKeys.has(key)) transcriptKeys.set(key, {});
      transcriptBudget.reserve(transcriptKeys.get(key), Buffer.byteLength(JSON.stringify(t)), () => forgetTranscript(key));
    }
    if (typeof adapter.projectHints !== 'function') return;
    let hints = []; try { hints = adapter.projectHints(t) || []; } catch (_) { hints = []; }
    if (!hints.length && !projectHints.has(key)) return;
    // merged, not replaced: a later window may no longer hold an older tag (event ids are stable per position)
    const byId = new Map((projectHints.get(key) || []).map((h) => [h.id, h]));
    const before = JSON.stringify([...byId.values()]);
    for (const h of hints) byId.set(h.id, h);
    // architect-56: a new tag must reach the projects now, not at their next periodic refresh (the scan runs AFTER the
    // refresh that a session change triggers, so without this a tag waited up to 10 minutes)
    if (JSON.stringify([...byId.values()]) !== before) setImmediate(() => ev.emit('change', { type: 'ProjectHint', key }));
    projectHints.delete(key);
    projectHints.set(key, [...byId.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-20));
    while (projectHints.size > HINT_SESSIONS_MAX) projectHints.delete(projectHints.keys().next().value);
  }
  const gateway = { connected: false, since: null, version: null };
  // G2 (§12.4): the runtime-neutral projection's extra facts (kept off `gateway`, whose shape the 2.x health derives from)
  const runtimeState = { protocol: null, notConfigured: null };
  const liveEvents = [];
  let liveSeq = 0;
  // LiveEvent (data-model §11), R6-06: every row carries the required nullable fields, is validated
  // against the contract, and rows with the same canonical identity within COALESCE_MS merge into one
  // (moved to the top, count + 1). Connection events never merge; display names never decide a merge.
  const identityOf = (e) => {
    if (e.kind === 'gateway.connected' || e.kind === 'gateway.disconnected') return null;
    if (e.kind === 'cron.fired') return 'cron|' + e.cronJobId;
    if (e.kind === 'activity') return 'activity|' + e.sessionKey + '|' + e.activity;
    return e.kind + '|' + (e.sessionKey || '') + '|' + (e.occupantId || '');
  };
  function pushLive(e) {
    const t = now();
    const row = Object.assign({ id: null, at: t, kind: e.kind, actor: e.actor, occupantId: null, sessionKey: null, count: 1 }, e);
    const id = identityOf(row);
    if (id) {
      const i = liveEvents.findIndex((x) => identityOf(x) === id && t - x.at <= COALESCE_MS);
      // entities are immutable: a coalesced event is a NEW LiveEvent (count + 1, now) replacing the old one
      if (i >= 0) { const [m] = liveEvents.splice(i, 1); const n = new M.LiveEvent(Object.assign(m.toJSON(), { count: m.count + 1, at: t })); liveEvents.unshift(n); ev.emit('live', n); return n; }
    }
    row.id = 'le_' + (++liveSeq);
    const entity = M.LiveEvent.from(row);
    if (!entity) { quarantine.record({ code: 'shape.invalid', severity: 'error', channel: '*', path: '$.canonical.liveEvent' }); return null; }
    liveEvents.unshift(entity); if (liveEvents.length > LIVE_EVENTS_MAX) liveEvents.pop();
    ev.emit('live', entity);
    return entity;
  }

  // Sessions: announce a change only when the canonical list actually changed (R6-12), and turn run
  // transitions into LiveEvents (R6-06). A session first seen already running after the initial
  // snapshot counts as a start; first sightings during the initial snapshot emit nothing.
  let sessionsJson = null;
  const runStatus = new Map();   // session key → { identity, status }; bounded to the current session inventory
  let sessionsSeeded = false;
  function afterSessions() {
    const list = reg.list();
    const currentKeys = new Set(list.map(x => x.key));
    for (const key of observed.keys()) if (!currentKeys.has(key)) observed.delete(key);
    for (const x of list) if (x.run.evidenceLevel === 'verified' && ['succeeded', 'failed', 'cancelled'].includes(x.run.status)) observed.delete(x.key);
    scheduleRunExpiry(list);
    for (const x of list) {
      const cur = x.run.status;
      const previous = runStatus.get(x.key);
      const resolved = resolveRunIdentity(previous?.identity, x);
      const prev = resolved.same ? previous.status : undefined;
      runStatus.set(x.key, { identity: resolved.identity, status: cur });
      if (prev === cur || (prev === undefined && !sessionsSeeded)) continue;
      const kind = cur === 'running' ? 'run.started' : prev === 'running' && cur === 'succeeded' ? 'run.succeeded' : prev === 'running' && cur === 'failed' ? 'run.failed' : null;
      if (kind) pushLive({ kind, actor: { kind: 'system', component: 'engine' }, sessionKey: x.key, occupantId: occupantIdOf(x) });
    }
    for (const key of runStatus.keys()) if (!currentKeys.has(key)) runStatus.delete(key);
    sessionsSeeded = true;
    const j = JSON.stringify(list);
    if (j !== sessionsJson) { sessionsJson = j; ev.emit('change', { type: 'Session' }); }
  }

  const issueFn = (rec) => (code, severity, path, detail, sample) => rec({ code, severity, path, detail, sample });
  // → the entity instance (frozen, explicit nulls), or null with the issues quarantined under '$.canonical.<type>'
  function admit(schema, typeName, item, rec) {
    // T-0062: lineage from any adapter is normalised here (redacted bounded label; an unusable one = no known spawner)
    if (item && typeof item === 'object' && item.spawnedBy != null) item = { ...item, spawnedBy: normaliseLineage(item.spawnedBy) };
    const E = M.entityOf(schema);
    if (!E) throw new Error('no entity class for ' + typeName);
    const value = E.from(item, (i) => rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical.' + typeName + i.path.slice(1), detail: i.detail }));
    return value && validateIdentity(typeName, value, rec) ? value : null;
  }
  const admitAll = (schema, typeName, list, rec) => list.map((x) => admit(schema, typeName, x, rec)).filter(Boolean);
  const admitSnapshot = (schema, typeName, list, rec, previous) => {
    const out = list.map(x => admit(schema,typeName,x,rec));
    return runtimeId && !out.every(Boolean) ? previous : out.filter(Boolean);
  };

  // Canonical operations (the adapter's routes map raw channels onto them; `x` is the route-prepared value).
  let rawAgents = [];
  let autoAdded = new Set(autoAddedAgents), excluded = excludedAgents, managedAutoAdd = autoAddManaged;
  const selectedAgents = () => new Set([...(configuredAgents || []), ...autoAdded]);
  function rememberDiscovered(rows) {
    if (!managedAutoAdd || typeof onAutoAddAgent !== 'function' || !Array.isArray(rows)) return;
    for (const row of rows) {
      const id=row?.id;
      if (typeof id!=='string' || hiddenAgents.includes(id) || excluded.includes(id) || (configuredAgents || []).includes(id) || autoAdded.has(id)) continue;
      try { if (onAutoAddAgent(id)) autoAdded.add(id); } catch { /* fail closed: the row remains outside the managed roster */ }
    }
  }
  function namedAgents(rows) {
    if (!Array.isArray(rows)) return rows;
    const all = rows.slice();
    const selected=selectedAgents();
    for (const id of selected) if (!all.some(a => a?.id === id)) all.push({ id, name: agentNames[id] || id, workspace: null, model: null, fallbackModels: [], isPrimary: id === primary, mainSessionKey: null });
    return all.filter(a => !hiddenAgents.includes(a?.id) && !excluded.includes(a?.id) && ((!configuredAgents && !managedAutoAdd) || selected.has(a?.id)))
      // agent-identity-1: the owner's name wins over any adapter-supplied display name (title, gateway name)
      .map(a => a && ({ ...a, hostObservations: Array.isArray(a.hostObservations) ? a.hostObservations : [],
        ...(Object.hasOwn(agentNames, a.id) && typeof agentNames[a.id] === 'string' ? { name: agentNames[a.id], displayName: agentNames[a.id] } : {}) }));
  }
  const ACCEPT = {
    'sessions.page': (x, rec, env, issues) => {
      const rowsDropped = issues.some((i) => i.code === 'shape.item-dropped');
      reg.acceptPage(x.page, x.offset, rec, { rowsDropped, acquisitionGeneration: env.context?.acquisitionGeneration, sourceOrder: env.context?.sourceOrder });
      afterSessions();
    },
    'sessions.describe': (row, rec, env) => { reg.acceptDescription(row, rec, { sourceOrder: env.context?.sourceOrder }); afterSessions(); },
    // S7b: a catalog-only event (key null) carries no session row
    'sessions.changed': (row, rec, env) => { if (!row.key) return; reg.acceptChanged(row, rec, { sourceOrder: env.context?.sourceOrder }); afterSessions(); },
    sessionGroups: (v, rec) => { canon.sessionGroups = admitSnapshot(C.SessionGroup, 'sessionGroup', N.sessionGroups(v), rec, canon.sessionGroups); },
    agents: (v, rec) => { const rows=N.agents(v);rememberDiscovered(rows);canon.agents = admitSnapshot(C.Agent, 'agent', namedAgents(rawAgents = rows), rec, canon.agents); updatePrimary(); },
    flows: (v, rec) => { canon.cronJobs = admitSnapshot(C.CronJob, 'cronJob', N.flows(v, issueFn(rec)), rec, canon.cronJobs); },
    flowRuns: (v, rec, env, issues, key) => {
      if (!key) return;
      canon.cronRuns.set(key, { fetchedAt: now(), runs: admitAll(C.CronRun, 'cronRun', N.flowRuns(v, key, issueFn(rec)), rec) });
    },
    skills: (v, rec) => { canon.skills = admitSnapshot(C.Skill, 'skill', N.skills(v, issueFn(rec)), rec, canon.skills); },
    skillInfo: (v, rec, env, issues, key) => {
      const info = N.skillInfo(v, issueFn(rec));
      const e = admit(C.SkillInfo, 'skillInfo', info, rec); if (e) canon.skillInfo.set(key, e);
    },
    channels: (v, rec) => { canon.channelsRaw = v; canon.channels = admitSnapshot(C.Channel, 'channel', N.channels(v, issueFn(rec), canon.config), rec, canon.channels); },
    transcript: (v, rec, env, issues, key) => {
      if (!key) return;
      const session = reg.get(key);
      const agentOf = (id) => { const a = canon.agents.find((a) => a.id === id); return a ? { ...a, id: 'agent:' + a.id } : null; };
      const context = { ...senderContext(), runtime: adapter.id || 'generic', sessionKey: key, session,
        agent: agentOf(session?.class.agentId), parentAgent: agentOf(reg.get(session?.parentKey)?.class.agentId), agentOf, sessionOf: (key) => reg.get(key) };
      const t = N.transcript(key, v, now(), fullTranscripts.has(key) ? Infinity : undefined, issueFn(rec), context);
      const e = admit(C.Transcript, 'transcript', t, rec);
      if (e) { conversationCounts.set(key, v.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length); keepTranscript(key, e); }
    },
    config: (v, rec) => {
      const c = admit(C.Config, 'config', N.config(v), rec);
      if (!c) return null;
      canon.config = c;
      // R6-13: channel policies join the config, so a config change re-derives the admitted channels
      // from the last good channel status (its issues were recorded when it arrived: none again here).
      if (canon.channelsRaw) { const quiet = () => {}; canon.channels = N.channels(canon.channelsRaw, quiet, c).map((x) => M.Channel.from(x)).filter(Boolean); }
      return c;
    },
    runtimeHealth: (v) => { canon.runtimeHealthRaw = v; },
    host: (v) => { canon.host = v; },
    // S6.1: one journal row per fire; job edits and run ends aren't fires
    flowEvent: (x) => { if (x.jobId && x.fired) pushLive({ kind: 'cron.fired', actor: { kind: 'system', component: 'scheduler' }, cronJobId: x.jobId }); },
    hello: (x) => {
      gateway.version = x.version;
      runtimeState.protocol = x.protocol;
      advertisedEvents.clear();
      for (const e of x.events) advertisedEvents.add(e);
    },
  };
  const lastJson = new Map();

  // Gateway transport state: freshness (R1-03), a LiveEvent, and a change.
  function setGatewayConnected(connected) {
    if (connected) runtimeState.notConfigured = null;
    setSourceDown('gateway', !connected, runtimeState.notConfigured ? 'not-configured' : 'not-connected');
    if (gateway.connected === !!connected) return;
    gateway.connected = !!connected; gateway.since = now();
    pushLive({ kind: connected ? 'gateway.connected' : 'gateway.disconnected', actor: { kind: 'system', component: 'engine' } });
    ev.emit('change', { channel: 'gateway.connection' });
  }

  // R6-08: material changes of derived health, source freshness or the quarantine's open set notify the
  // change-driven UI; timestamp-only bookkeeping (lastOkAt, counts, metric values within a level) doesn't.
  let statusJson = null;
  function statusDigest() {
    const h = engineHealth();
    const q = quarantine.counts();
    return JSON.stringify({ level: h.level, gw: h.gateway.connected, loop: !!(h.gateway.eventLoop && h.gateway.eventLoop.degraded),
      host: h.host ? [lvlOf(h.host.cpuPct, THRESHOLDS.cpu), lvlOf(h.host.mem.pct, THRESHOLDS.mem), h.host.disk ? lvlOf(h.host.disk.pct, THRESHOLDS.disk) : null] : null,
      cron: h.cron, sources: h.sources.map((x) => [x.id, x.state, x.lastError, x.channels.map((c) => [c.channel, c.state, c.lastError])]),
      open: q.open, qv: quarantine.version() });
  }
  function checkStatus() {
    const d = statusDigest();
    if (statusJson !== null && d !== statusJson) ev.emit('change', { type: 'Health' });
    statusJson = d;
  }

  function engineHealth() {
    const runtime = N.runtimeHealth({ healthEvent: canon.runtimeHealthRaw || null, channelsStatus: canon.channelsRaw || null });
    return deriveHealth({ now: now(), host: canon.host, runtime, gateway,
      cronJobs: canon.cronJobs, sources: sourceList(), quality: quarantine.counts() });
  }

  // §12.1: the runtime can't connect at all (no identity, no token). The API still serves; the source is down
  // with category 'not-configured' and runtime().state says so (G4's setup screen reads it).
  function setRuntimeNotConfigured(reason) {
    const r = typeof reason === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(reason) ? reason : 'not-configured';
    if (runtimeState.notConfigured === r) return;
    runtimeState.notConfigured = r;
    setSourceDown('gateway', true, 'not-configured');
    ev.emit('change', { channel: 'gateway.connection' });
  }
  // The one runtime projection VMs read (no VM reads a raw channel, §12.4).
  // T-0058: the connector that owns a session (one engine = one connector instance); adapter-declared mark
  function connectorOf() { return { id: runtimeId || 'legacy', adapter: adapter.id, name: adapter.name, mark: markOf(adapter) }; }
  function runtime() {
    return { adapterId: adapter.id, name: adapter.name, mark: markOf(adapter), gatewayLabel: adapter.gatewayLabel || adapter.name, gatewayLabels: adapter.gatewayLabels || null, version: gateway.version, protocol: runtimeState.protocol,
      state: runtimeState.notConfigured ? 'not-configured' : gateway.connected ? 'connected' : 'disconnected',
      reason: runtimeState.notConfigured, connected: gateway.connected, since: gateway.since,
      capabilities: typeof adapter.capabilities === 'function' ? adapter.capabilities() : {} };   // G5: MetaVM.runtime.capabilities (3.0)
  }
  const healthChecks = createHealthChecks({ adapterId: adapter.id || 'adapter', adapter,
    context: () => ({ adapterId: adapter.id || 'adapter', runtime: runtime(), sources: sourceList(), sessions: reg.list(), now: now() }), now,
    onChange: () => ev.emit('change', { type: 'HealthCheck' }), onAudit: onHealthAudit });
  const notifyHealth = () => ev.emit('change', { type: 'HealthCheck' });

  // ---- canonical ingestion (§12.4) -------------------------------------------------------------
  const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  // → every item as an entity, or null if ANY was refused (all-or-nothing, R13-03)
  const allAdmitted = (schema, typeName, list, rec) => { const out = list.map((x) => admit(schema, typeName, x, rec)); return out.every(Boolean) ? out : null; };
  const CANON = {
    // A complete snapshot (deletes what's absent) and a single upsert. Rows go through the registry with the
    // canonical input path, without applying the adapter's native normaliser again; the registry validates Session.
    // R13-03: rows are validated BEFORE the registry sees them. A rejected row is left out (its last good row stays) and
    // makes the snapshot incomplete, so no absence in it counts as deletion evidence.
    'sessions.snapshot': (list, rec) => {
      if (list.length > MAX_CANONICAL_SESSION_SNAPSHOT) {
        rec({ code: 'shape.invalid', severity: 'error', path: '$.sessions', detail: 'session inventory exceeds the supported limit' });
        return;
      }
      const good = list.map((row) => admit(SessionContract, 'session', row, rec)).filter(Boolean);
      reg.acceptPage({ sessions: good, hasMore: false, totalCount: list.length }, 0, rec, { rowsDropped: good.length !== list.length, canonical:true });
      afterSessions();
    },
    'sessions.upsert': (row, rec) => { const e = admit(SessionContract, 'session', row, rec); if (!e) return; reg.acceptChanged(e, rec, {canonical:true}); afterSessions(); },
    // Lists replace the previous one only when EVERY item is admitted (all-or-nothing: the last good list stays).
    agents: (v, rec) => { rememberDiscovered(v);const l = allAdmitted(C.Agent, 'agent', namedAgents(rawAgents = v), rec); if (l) { canon.agents = l; updatePrimary(); } },
    flows: (v, rec) => { const l = allAdmitted(C.CronJob, 'cronJob', v, rec); if (l) canon.cronJobs = l; },
    flowRuns: (v, rec, key) => { const l = allAdmitted(C.CronRun, 'cronRun', v, rec); if (l) canon.cronRuns.set(key, { fetchedAt: now(), runs: l }); },
    skills: (v, rec) => { const l = allAdmitted(C.Skill, 'skill', v, rec); if (l) canon.skills = l; },
    skillInfo: (v, rec, key) => { const e = admit(C.SkillInfo, 'skillInfo', v, rec); if (e) canon.skillInfo.set(key, e); },
    channels: (v, rec) => { const l = allAdmitted(C.Channel, 'channel', v, rec); if (l) canon.channels = l; },
    transcript: (v, rec, key) => { const e = admit(C.Transcript, 'transcript', v, rec); if (e) keepTranscript(key, e); },
    config: (v, rec) => { const e = admit(C.Config, 'config', v, rec); if (e) canon.config = e; },
    sessionGroups: (v, rec) => { const l = allAdmitted(C.SessionGroup, 'sessionGroup', v, rec); if (l) canon.sessionGroups = l; },
    hello: (v, rec) => {
      const okHello = v && (v.version === null || typeof v.version === 'string') && (v.protocol == null || Number.isInteger(v.protocol)) && (v.events === undefined || isStrList(v.events));
      if (!okHello) { rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical.hello' }); return; }
      ACCEPT.hello({ version: v.version, protocol: v.protocol == null ? null : v.protocol, events: v.events || [] });
    },
  };
  // → { ok, issues }. Same registry, quarantine, freshness and change path as ingest(); `source` is the adapter id.
  function ingestCanonical(op, value, { key } = {}) {
    if (!Object.prototype.hasOwnProperty.call(CANON, op)) throw new Error('ingestCanonical: unknown op ' + JSON.stringify(String(op)));
    const channel = 'canonical.' + op, source = adapter.id || 'runtime';
    const issues = [];
    const rec = (i) => { const { incrementCount = true, ...issue } = i; const full = Object.assign({ source, channel, openclawVersion, schema: null }, issue); quarantine.record(full, { increment: incrementCount }); issues.push(full); };
    const env = { source, channel, receivedAt: now(), context: { key } };
    const done = (okFlag) => { checkStatus(); ev.emit('ingested', { env, ok: okFlag, issues }); return { ok: okFlag, issues }; };
    const needsList = op === 'sessions.snapshot' || ['agents', 'flows', 'flowRuns', 'skills', 'channels', 'sessionGroups'].includes(op);
    if ((KEYED_OPS.has(op) && (typeof key !== 'string' || !key || runtimeId && !require('../runtime-ids').validNativeId(key))) || (needsList ? !Array.isArray(value) : (value == null || typeof value !== 'object'))) {
      rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical', detail: 'not a canonical value' });
      fail(source, channel, 'payload-rejected');
      recordOutcome(op, key, false, 'payload-rejected');
      return done(false);
    }
    try { CANON[op](value, rec, key); } catch (e) {
      rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical', detail: 'canonical ingestion failed' });
      fail(source, channel, 'payload-rejected');
      recordOutcome(op, key, false, 'payload-rejected');
      return done(false);
    }
    if (issues.some((i) => i.severity === 'error')) {
      fail(source, channel, 'payload-rejected');
      recordOutcome(op, key, false, 'payload-rejected');
      return done(false);
    }
    if (!issues.length) quarantine.markClean(channel);
    const regKey = channel + (key ? '#' + key : '');
    const j = require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if (lastJson.get(regKey) !== j) { lastJson.set(regKey, j); ev.emit('change', { channel }); }
    ok(source, channel);
    recordOutcome(op, key, true, null);
    return done(true);
  }

  // ---- typed on-demand reads (§12.4) ------------------------------------------------------------
  // R13-07: the outcome of the latest ingestion per (op, key), so a read whose answer was REJECTED reports a failure
  // (the last good value stays in the registry, but the read says it isn't current).
  let ingestSeq = 0;
  const outcomes = new Map();
  function recordOutcome(op, key, okFlag, category) { outcomes.set(op + '#' + (key || ''), { seq: ++ingestSeq, ok: okFlag, category }); }
  // read op → the ingestion ops its answer arrives through (raw adapter route, canonical op)
  const READ_INGEST = { transcript: ['transcript'], describeSession: ['sessions.describe', 'sessions.upsert'], flowRuns: ['flowRuns'],
    skillInfo: ['skillInfo'], sessionGroups: ['sessionGroups'] };
  let reads = {};
  function setReads(r) { reads = r && typeof r === 'object' ? r : {}; }
  const READ_VALUE = {
    transcript: (k) => canon.transcripts.get(k) || null,
    describeSession: (k) => reg.get(k),
    flowRuns: (k) => canon.cronRuns.get(k) || null,
    skillInfo: (k) => canon.skillInfo.get(k) || null,
    sessionGroups: () => sessionGroups(),
  };
  // S7b: the catalog with its members (display order). null until the runtime has answered once.
  function sessionGroups() {
    if (!canon.sessionGroups) return null;
    const members = new Map();
    for (const s of reg.list()) if (s.group) { if (!members.has(s.group)) members.set(s.group, []); members.get(s.group).push(s); }
    return canon.sessionGroups.map((g) => {
      const list = members.get(g.id) || [];
      return { id: g.id, name: g.name, position: g.position, sessionKeys: list.map((s) => s.key).sort(),
        lastActivityAt: list.reduce((m, s) => (s.updatedAt != null && (m == null || s.updatedAt > m) ? s.updatedAt : m), null) };
    });
  }
  // → { ok: true, value } | { ok: false, category }. 'capability-unavailable' when the adapter has no such read or
  // its capability is false (the API answers 404 not_found); 'not-configured' when the runtime can't connect.
  async function request(op, key, opts = {}) {
    const spec = Object.prototype.hasOwnProperty.call(READ_OPS, op) ? READ_OPS[op] : null;
    if (!spec) throw new Error('engine.request: unknown op ' + JSON.stringify(String(op)));
    const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : {};
    if (!spec.capable(caps || {}) || typeof reads[op] !== 'function') return { ok: false, category: 'capability-unavailable' };
    if (runtimeState.notConfigured) return { ok: false, category: 'not-configured' };
    if (op === 'transcript' && opts.full === true) fullTranscripts.add(key);
    let out;
    const before = ingestSeq;
    try { out = await reads[op](key, opts); } catch (e) { out = { ok: false, category: 'error' }; }
    if (!out || out.ok !== true) {
      if (op === 'transcript' && !canon.transcripts.has(key)) fullTranscripts.delete(key);
      return { ok: false, category: (out && typeof out.category === 'string' && out.category) || 'error' };
    }
    const k = op === 'sessionGroups' ? '' : key;
    const seen = READ_INGEST[op].map((o) => outcomes.get(o + '#' + (k || ''))).filter((x) => x && x.seq > before).sort((a, b) => b.seq - a.seq)[0];
    if (seen && !seen.ok) return { ok: false, category: seen.category || 'payload-rejected' };
    return { ok: true, value: READ_VALUE[op](key) };
  }

  // ---- the primary agent (ADR §12.2, G3a): one resolver for every consumer -------------------------------------
  let primaryState = { agentId: null, source: null };
  function updatePrimary() {
    const r = resolvePrimaryAgent(canon.agents, { primary });
    for (const i of r.issues) quarantine.record(Object.assign({ channel: 'config.primary' }, i));
    if (!r.issues.length) quarantine.markClean('config.primary');
    const before = primaryState.agentId;
    primaryState = { agentId: r.agentId, source: r.source };
    if (before && r.agentId && before !== r.agentId) {
      pushLive({ kind: 'agent.primary-changed', actor: { kind: 'system', component: 'engine' } });
      ev.emit('change', { type: 'Agent' });
    }
  }
  // → { id, name, source } | null
  function primaryAgent() {
    if (!primaryState.agentId) return null;
    const a = canon.agents.find((x) => x.id === primaryState.agentId);
    return a ? { id: a.id, name: a.name || a.id, source: primaryState.source } : null;
  }

  const ON_FAILURE = { 'sessions.page': () => reg.invalidateRun() };

  function setOpenclawVersion(v) { openclawVersion = typeof v === 'string' ? v : null; }

  // → { ok, value } | { ok:false, code, detail, sample }. Details are fixed phrases or error
  // categories; samples are structural (lengths, flags), never text.
  function decode(env) {
    const b = env.body || {};
    const o = env.outcome;
    if (o && o.ok === false) {
      // R1-05: a failed process is a failure even if stdout happens to parse
      const category = o.exitCode == null ? 'killed-or-timeout' : 'exit-' + Math.min(255, Math.max(0, o.exitCode));
      return { ok: false, code: 'cli.failed', category, detail: 'process failed (' + category + ')',
        sample: { exitCode: Number.isInteger(o.exitCode) ? o.exitCode : null, stderr: !!o.stderr, stdoutLength: b.kind === 'text' ? String(b.value || '').length : 0 } };
    }
    if (b.kind === 'json') return { ok: true, value: b.value };
    if (b.kind === 'error') { const category = errorCategory(b.message); return { ok: false, code: env.source === 'cli' ? 'cli.failed' : 'rpc.failed', category, detail: category }; }
    if (b.kind === 'text') {
      const t = String(b.value || ''); const i = t.indexOf('{');
      if (i < 0) return { ok: false, code: 'parse.failed', category: 'invalid-output', detail: 'no JSON object in output', sample: { length: t.length, hasBrace: false } };
      try {
        const v = JSON.parse(t.slice(i));
        if (v && v.ok === false) return { ok: false, code: 'cli.not-ok', category: 'not-ok', detail: 'ok:false (' + errorCategory(v.error || v.message) + ')' };
        return { ok: true, value: v };
      } catch (e) { return { ok: false, code: 'parse.failed', category: 'invalid-output', detail: 'invalid JSON after the first {', sample: { length: t.length, hasBrace: true, prefixLength: i } }; }
    }
    return { ok: false, code: 'parse.failed', category: 'invalid-output', detail: 'unknown body kind' };
  }

  // → { ok, value?, issues: Issue-like[] }
  function ingest(env) {
    const base = { source: env.source, channel: env.channel, openclawVersion };
    const def = Object.prototype.hasOwnProperty.call(schemas, env.channel) ? schemas[env.channel] : null;
    const route = routeOf(env.channel);
    const issues = [];
    const rec = (i) => { const { incrementCount = true, ...issue } = i; const full = Object.assign({}, base, { schema: def ? { id: def.id, version: def.version } : null }, issue); quarantine.record(full, { increment: incrementCount }); issues.push(full); };
    const done = (okFlag, value, category = 'payload-rejected') => {
      if (route) {
        const rejected = !okFlag || issues.some((i) => i.severity === 'error' && i.path && String(i.path).startsWith('$.canonical'));
        recordOutcome(route.op, (env.context && env.context.key) || '', !rejected, rejected ? (okFlag ? 'payload-rejected' : category) : null);
      }
      checkStatus(); ev.emit('ingested', { env, ok: okFlag, issues }); return okFlag ? { ok: true, value, issues } : { ok: false, issues };
    };

    if (!def) {
      if (adapter.eventPrefix && env.channel.startsWith(adapter.eventPrefix)) {
        rec({ code: 'event.unknown', severity: 'info', path: null });
      } else {
        rec({ code: 'schema.missing', severity: 'warn', path: null, detail: 'no schema for this channel' });
      }
      return done(false);
    }
    // R1-04: recorded on EVERY envelope while the running version is untested, so it stays open
    // (and the channel never counts as clean) until support changes.
    const untested = openclawVersion && Array.isArray(def.testedWith) && !def.testedWith.includes(openclawVersion);
    if (untested) rec({ code: 'version.untested', severity: 'warn', path: null, detail: `schema ${def.id}@${def.version} not tested with this OpenClaw version` });

    const d = decode(env);
    if (!d.ok) {
      rec({ code: d.code, severity: 'error', path: null, detail: d.detail, sample: d.sample || null });
      fail(env.source, env.channel, d.category);
      if (route && ON_FAILURE[route.op]) ON_FAILURE[route.op]();
      return done(false, undefined, d.category);
    }

    const r = schemaDsl.validate(def.schema, d.value);
    for (const i of r.issues) rec(i);
    if (!r.ok) { fail(env.source, env.channel, 'payload-rejected'); if (route && ON_FAILURE[route.op]) ON_FAILURE[route.op](); return done(false); }
    // A normaliser that throws on validated input is a bug: quarantine it, keep the last good value.
    let kept;
    try {
      if (route && ACCEPT[route.op]) {
        const key = route.key ? route.key(env, r.value) : null;
        kept = ACCEPT[route.op](route.prep ? route.prep(r.value, env) : r.value, rec, env, issues, key);
      }
    } catch (e) {
      rec({ code: 'shape.invalid', severity: 'error', path: '$.canonical', detail: 'normaliser failed' });
      fail(env.source, env.channel, 'payload-rejected');
      return done(false);
    }
    if (!issues.length) quarantine.markClean(env.channel);
    const regKey = env.channel + (env.context && env.context.key ? '#' + env.context.key : '');
    const stored = kept !== undefined ? kept : r.value;
    if (stored !== null) registry.set(regKey, { value: stored, at: env.receivedAt || now() });
    // only real changes are announced: a refresh that brings nothing new produces no traffic
    if (route && REFRESH_OPS.has(route.op)) {
      const j = JSON.stringify(stored);
      if (lastJson.get(regKey) !== j) { lastJson.set(regKey, j); ev.emit('change', { channel: env.channel }); }
    }
    if (runtimeId && issues.some(i=>i.severity==='error' && i.path?.startsWith('$.canonical'))) fail(env.source,env.channel,'payload-rejected');
    else ok(env.source, env.channel);
    return done(true, r.value);
  }

  return {
    ingest, ingestCanonical, setReads, request, setOpenclawVersion, setSourceDown, setGatewayConnected, setRuntimeNotConfigured, runtime, connectorOf, quarantine, on: ev.on.bind(ev), removeListener: ev.removeListener.bind(ev),
    // api.md §5.3: → the new state, null for an unknown id; throws code 'error-not-mutable' for an error issue
    setIssueMuted(fp, muted) { const st = quarantine.setMuted(fp, muted); checkStatus(); return st; },
    gateway: () => Object.assign({}, gateway),
    senderPeople: () => senderContext().people || [],
    agents: () => canon.agents,
    // Manual selection is distinct from adapter discovery and persisted auto-add.
    // Consumers may keep explicitly selected agents visible while idle without
    // treating every remembered/discovered identity as current presence.
    configuredAgentIds: () => [...new Set([...(Array.isArray(configuredAgents) ? configuredAgents : []), ...Object.keys(agentNames || {})])],
    autoAddedAgentIds: () => [...autoAdded],
    // Private reconciliation input for trusted local host adapters. Raw stable
    // runtime references never enter canonical Agent rows or public VMs.
    identityAgents: (hostId) => typeof hostId === 'string' ? canon.agents.filter(a => typeof a.mainSessionKey === 'string' && a.mainSessionKey)
      .map(a => ({ id: a.id, hostId, runtimeKind: adapter.id || 'generic', sessionRef: a.mainSessionKey })) : [],
    // Private adapter reconciliation input. Native session IDs never enter public canonical rows or VMs.
    identitySessions: (hostId) => {
      if (typeof hostId !== 'string') return [];
      const rows = reg.list().filter(s => !hiddenAgents.includes(s.class.agentId))
        .filter(s => s.class?.kind === 'conversation' && typeof s.sessionId === 'string' && s.sessionId);
      const byKey = new Map(rows.map(s => [s.key, s]));
      const keys = new Set([...identitySessionRefs.keys(), ...byKey.keys()]);
      return [...keys].flatMap(sessionKey => {
        const session = byKey.get(sessionKey), privateRef = identitySessionRefs.get(sessionKey);
        const sessionRef = privateRef?.sessionRef || session?.sessionId;
        if (!sessionRef) return [];
        return [{ id: sessionKey, sessionKey, ...(session?.class?.agentId || privateRef?.agentId ? { agentId: session?.class?.agentId || privateRef.agentId } : {}),
          hostId, runtimeKind: adapter.id || 'generic', sessionRef }];
      });
    },
    // Trusted adapters provide private stable source references for exact identity
    // reconciliation. The references never enter public canonical rows or VMs.
    setIdentitySessionRefs(rows = []) {
      const next = new Map();
      for (const row of rows) if (row && typeof row.sessionKey === 'string' && row.sessionKey && typeof row.sessionRef === 'string' && row.sessionRef && row.sessionRef.length <= 256) next.set(row.sessionKey, { sessionRef: row.sessionRef,
        ...(typeof row.agentId === 'string' && row.agentId ? { agentId: row.agentId } : {}) });
      identitySessionRefs.clear(); for (const [key, ref] of next) identitySessionRefs.set(key, ref);
      // Candidate references let private team/session joins find exact adapter
      // identities outside the public recent-session window. They carry no
      // transcript or public entity data.
      return true;
    },
    detectedAgents: () => rawAgents,
    updateAgents({ names = {}, hidden = [], primary: configuredPrimary = null, configured = null, autoAdded: autoAddedIds, excluded: excludedIds, manageAutoAdd }) {
      agentNames = names; hiddenAgents = hidden; primary = configuredPrimary; configuredAgents = configured;
      if (autoAddedIds !== undefined) autoAdded = new Set(autoAddedIds); if (excludedIds !== undefined) excluded = excludedIds;
      if (manageAutoAdd !== undefined) managedAutoAdd = manageAutoAdd;
      canon.agents = admitSnapshot(C.Agent, 'agent', namedAgents(rawAgents), i=>quarantine.record({channel:'canonical.agents',...i}), canon.agents);
      updatePrimary(); ev.emit('change', { type: 'Agent' });
    },
    primaryAgent,
    // more schema field names that issue paths may name (e.g. the VM schemas: their checks report schema paths, value-free)
    declareFields(names) { for (const n of names) declared.add(n); },
    cronJobs: () => canon.cronJobs,
    cronRuns: (jobId) => canon.cronRuns.get(jobId) || null,
    skills: () => canon.skills,
    skillInfo: (name) => canon.skillInfo.get(name) || null,
    channels: () => canon.channels,
    sessionGroups,
    transcript: (key) => canon.transcripts.get(key) || null,
    conversationMessageCount: (key) => conversationCounts.get(key) ?? null,
    // architect-54: the project hints the adapter found in the transcripts read so far, newest last per session
    projectHints: () => [...projectHints.entries()].flatMap(([sessionKey, list]) => list.map((h) => Object.assign({ sessionKey }, h))),
    config: () => canon.config,
    host: () => canon.host,
    liveEvents: () => liveEvents.slice(),
    health: engineHealth,
    healthChecks: healthChecks.list,
    runHealthRemedy: healthChecks.run,
    healthAudit: healthChecks.audit,
    startHealthLoop: healthChecks.start,
    notifyHealth,
    get openclawVersion() { return openclawVersion; },
    registryKeys: () => [...registry.keys()].sort(),
    latest: (channel, key) => registry.get(channel + (key ? '#' + key : '')),
    sources: sourceList,
    sessions: () => reg.list().filter(row => { const id=row.class.agentId,selected=selectedAgents();return !hiddenAgents.includes(id)&&!excluded.includes(id)&&((!configuredAgents&&!managedAutoAdd)||selected.has(id)); }),
    // Activity (data-model §3): run-state only on 2026.9.8 (R6-05).
    activity: currentActivity,
    activities: () => reg.list().map(row => currentActivity(row.key)).filter(Boolean),
    setObservedActivity,
    clearObservedActivity,
    agentPresence: () => adapter.presence === 'agents',
    forgetTranscript,
    close() { engineClosed = true; if (runExpiryTimer) clearTimeout(runExpiryTimer); runExpiryTimer = null; runExpiryAt = null;
      healthChecks.close(); for (const key of [...transcriptKeys.keys()]) forgetTranscript(key); observed.clear(); },
    expireObservedActivity() { const changed = clearExpiredEvidence(); scheduleRunExpiry(); return changed; },
    session: (key) => reg.get(key),
    sessionsMeta: () => reg.meta(),
    // Classification for any key: registry row when known; a heartbeat of a known base uses the base.
    classify: (key) => reg.classify(key),
    // Everything here is value-free by construction (quarantine.sanitize + categories + safe tokens).
    dataQuality() { return Object.assign({ openclawVersion: safeVersion(openclawVersion), sources: sourceList() }, quarantine.counts(), { issues: quarantine.list() }); },
  };
}

module.exports = { createEngine, DEFAULT_SCHEMAS, CORE_SCHEMAS, declaredFieldNames: () => declaredVocabulary(DEFAULT_SCHEMAS) };
