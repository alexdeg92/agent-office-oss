'use strict';
/*
 * OfficeVM (api.md §3.2, §3.13). Who is on stage comes from the engine (deriveOccupants: run state, data-model §4);
 * look, roleLabel, ruleId and stations come from the active layout through office-dev's resolver
 * (public/v2/office/layout-rules.js, "the one implementation", shared with the editor; R3-16).
 * Until the layout store lands (S14b) the active layout is the shipped default (design/office/layout.example.json)
 * with layoutRevision 0.
 */
const path = require('path');
const fs = require('fs');
const { deriveOccupants } = require('../../../engine/derive/occupants');
const { scheduleVM } = require('./flows');
const { sessionLabel, sessionTitle } = require('./logs');
const { project2x: P2 } = require('../project2x');   // G3a: the 2.x wire values (ADR §12.6); G5: or project3x (the `P` param)

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const JOURNAL_MAX = 14, QUEUE_MAX = 8;

// The default layout and the asset manifest, loaded once (both are shipped files, not user data).
let defaults = null;
function officeDefaults() {
  if (defaults) return defaults;
  const rules = require(path.join(ROOT, 'public', 'v2', 'office', 'layout-rules.js'));
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
  return {
    since(id, state, now) {
      const p = seen.get(id);
      if (p && p.state === state) return p.since;
      seen.set(id, { state, since: now });
      return now;
    },
    keep(ids) { for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id); },
  };
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

function buildOfficeVM({ engine, now, tracker, names = {}, actorOf, layout = officeDefaults(), P = P2 }) {
  const gw = engine.gateway();
  const sessions = engine.sessions();
  const agents = engine.agents();
  // G3a: the one resolver (engine.primaryAgent); the agent row for its name and main session key
  const resolved0 = engine.primaryAgent ? engine.primaryAgent() : null;
  const primary = (resolved0 && agents.find((a) => a.id === resolved0.id)) || null;
  const primaryName = primary ? primary.name || primary.id : null;
  const derived = deriveOccupants({ sessions, activityFor: () => null, gwConnected: gw.connected, now,
    mainKey: primary ? primary.mainSessionKey || undefined : undefined });

  const sourceName = (o) => {
    if (o.role === 'primary') return primaryName || 'Agent principal';
    const s = o.sessionKey ? engine.session(o.sessionKey) : null;
    if (o.role === 'scheduled' && s && s.class.cronJobId && names.flowName) return names.flowName(s.class.cronJobId) || 'Tâche planifiée';
    return s ? sessionLabel(s, names) : o.id;
  };
  // Q03-A01: the occupant's title as a LabelRef (the UI's language); genuine names are raw params
  const named = (name) => ({ key: 'sessionTitle.named', params: { name } });
  const sourceTitle = (o) => {
    if (o.role === 'primary') return primaryName ? named(primaryName) : { key: 'occupantRole.' + P.occupantRole('primary') };
    const s = o.sessionKey ? engine.session(o.sessionKey) : null;
    if (o.role === 'scheduled' && s && s.class.cronJobId && names.flowName && names.flowName(s.class.cronJobId)) return named(names.flowName(s.class.cronJobId));
    return s ? sessionTitle(s, names) : named(o.id);
  };
  const resolved = layout.rules.resolveOccupants(layout.layout, layout.index,
    // the layout rules speak 2.x until layout-rules.js takes both vocabularies (office-dev, ADR §12.6): always 2.x names here
    derived.map((o) => ({ id: P2.occupantId(o.id), role: P2.occupantRole(o.role), sourceName: sourceName(o) })));

  const ids = new Set();
  const occupants = derived.map((o, i) => {
    const r = resolved[i];
    ids.add(o.id);
    // a layout rule's own name is user-authored (raw); otherwise the source title
    const title = r.name !== sourceName(o) ? named(r.name) : sourceTitle(o);
    const role = P.version === 3 ? o.role : P.occupantRole(r.role);
    return { id: P.occupantId(o.id), role, name: r.name, title, roleLabel: P.roleLabel(role, r.roleLabel), state: o.state, stateSince: tracker.since(o.id, o.state, now),
      stationUid: r.stationUid, look: r.look, ruleId: P.layoutRuleId(r.ruleId), destination: null,
      sessionKey: o.sessionKey, tokens: o.tokens, lastSeenAt: o.lastSeenAt,
      ...(() => { const x = CONVERSATION_ROLES.has(o.role) && o.sessionKey && engine.transcript ? exchangesOf(engine.transcript(o.sessionKey), now) : null; return x ? { exchanges: x } : {}; })() };
  });
  tracker.keep(ids);

  const busy = occupants.filter((o) => o.state !== 'idle' && o.state !== 'offline').length;
  const jobs = engine.cronJobs();
  const host = engine.host();
  // office-dev-19: the KPI counts the sub-agents present now (on stage: running, active or just failed), not every
  // sub-agent session the runtime still lists; the all-time count is the sub-line.
  const subagentsKnown = sessions.filter((s) => s.class.kind === 'subagent' && !s.class.heartbeatOf).length;
  const subagents = derived.filter((o) => o.role === 'subagent').length;
  const kpis = [
    { id: 'active', label: { key: 'kpi.active' }, value: busy, unit: 'count',
      // R14-16: « au repos » only when nobody is active (a sole working primary is not idle)
      sub: busy === 0 ? { key: 'kpi.idle', params: { agent: primaryName || '' } } : { key: 'kpi.onStage', params: { n: occupants.length } } },
    { id: 'runs', label: { key: 'kpi.runs' }, value: sessions.filter((s) => s.run.status === 'running').length, unit: 'count', sub: null },
    { id: 'subagents', label: { key: 'kpi.subagents' }, value: subagents, unit: 'count',
      sub: subagentsKnown > subagents ? { key: 'kpi.subagentsTotal', params: { n: subagentsKnown } } : null },
    { id: 'flows', label: { key: 'kpi.flows' }, value: jobs.filter((j) => j.enabled).length, unit: 'count', sub: { key: 'kpi.flowsTotal', params: { n: jobs.length } } },
    { id: 'tokens', label: { key: 'kpi.tokens' }, value: sessions.reduce((a, s) => a + s.usage.total, 0), unit: 'tokens', sub: null },
    { id: 'cpu', label: { key: 'kpi.cpu' }, value: host ? Math.round(host.cpuPct) : null, unit: 'percent', sub: null },
  ];

  // the journal's {occupant} is the occupant's title (a nested LabelRef): the UI renders it in its language
  const occName = (e) => {
    const o = e.occupantId ? occupants.find((x) => x.id === P.occupantId(e.occupantId)) : null;
    if (o) return o.title;
    const s = e.sessionKey ? engine.session(e.sessionKey) : null;
    return s ? sessionTitle(s, names) : named('');
  };
  const journal = engine.liveEvents().slice(0, JOURNAL_MAX).map((e) => {
    const params = {};
    if (e.kind === 'cron.fired') params.job = (names.flowName && names.flowName(e.cronJobId)) || '';
    else if (/^(run|occupant)\.|^activity$/.test(e.kind)) params.occupant = occName(e);
    return { id: e.id, at: e.at, count: e.count, actor: actorOf(e.actor), text: Object.keys(params).length ? { key: 'liveEvent.' + P.liveKind(e.kind), params } : { key: 'liveEvent.' + P.liveKind(e.kind) }, kind: P.liveKind(e.kind) };
  });

  const queue = jobs.filter((j) => j.enabled)
    .sort((a, b) => (a.nextRunAt == null) - (b.nextRunAt == null) || (a.nextRunAt || 0) - (b.nextRunAt || 0) || a.id.localeCompare(b.id))
    .slice(0, QUEUE_MAX).map((j) => ({ id: j.id, name: j.name, schedule: scheduleVM(j.schedule).sentence }));

  return { connection: { gateway: gw.connected ? 'up' : 'down', since: gw.since }, kpis, occupants, journal, layoutRevision: layout.revision, queue };
}

module.exports = { buildOfficeVM, createStateTracker, officeDefaults, exchangesOf, EXCHANGE_WINDOW_MS };
