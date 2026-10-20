'use strict';
// Journaux: Page<LogRowVM> and SessionVM (api.md §3.6). Pure builders over canonical sessions and transcripts.
// Labels preserve declared session/project names. Runtime-neutral observed activity supplements verified run state.
const { project2x: P2 } = require('../project2x');   // G3a: the 2.x wire values (ADR §12.6); G5: or project3x (the `P` param)
// G5: { runtimeKind } in 3.0 (right after `kind`), nothing in 2.x (the hook returns undefined)
const runtimeKindOf = (P, s) => { const rk = P.runtimeKind(s.class.kind); return rk === undefined ? {} : { runtimeKind: rk }; };

const LIMIT_DEFAULT = 50, LIMIT_MAX = 200;
const { parseId } = require('../../../runtime-ids');
const { projectEvents, participantsOf } = require('../../../engine/model/sender');
const { messageCountOf } = require('../../../projects/session-summary');
const { redactText } = require('../../../security/redact-text');
const { executionState } = require('../../../engine/execution-state');
const { createHash } = require('node:crypto');
const { normalizeTranscriptEvents } = require('../../../engine/model/transcript');
const executionVM = (run, activity = null, now = Date.now()) => {
  let e = executionState(run, now);
  if (e.level === 'unknown' && activity?.kind === 'working') e = { ...e, level: 'observed', observedAt: activity.since ?? null, expiresAt: activity.expiresAt ?? null };
  return { status: e.status, evidence: { level: e.level, observedAt: e.observedAt, expiresAt: e.expiresAt } };
};

/**
 * A session's title as a LabelRef (Q03-A01): generated parts are label keys (sessionTitle.*), so the UI shows them in
 * its own language; genuine names (a flow's, an interlocutor's, an explicit session's) travel as raw params.
 * @param {object} s canonical Session
 * @param {{ interlocutorName?: (id) => string|null, flowName?: (jobId) => string|null, agentName?: (id) => string|null }} names
 */
function sessionTitle(s, names = {}) {
  const c = s.class;
  // Unknown people use the same localized fallback on every runtime/channel; their opaque IDs never substitute for a
  // person's name. T-0058 (security-155): EVERY dynamic title value (names, flow names, explicit session names) goes
  // through the shared redactor, and a title is never a raw-key fragment; an empty result is « Session sans titre ».
  const untitled = { key: 'sessionTitle.untitled' };
  const clean = (v, maxLength = 120) => (v == null ? null : redactText(String(v), { maxLength }));
  const named = (name) => { const n = clean(name); return n ? { key: 'sessionTitle.named', params: { name: n } } : untitled; };
  // a session's own canonical title (adapter displayName, then summary); never its raw key
  const own = () => { for (const v of [s.displayName, s.summary]) { const x = v && v !== s.key ? clean(v) : null; if (x) return x; } return null; };
  let t;
  switch (c.kind) {
    case 'primary': t = { key: 'sessionTitle.main' }; break;
    case 'subagent': t = { key: 'sessionTitle.subagent', params: { id: String(parseId(c.subagentId, 'agent')?.local || c.subagentId || '').slice(0, 4) } }; break;
    case 'scheduled': { const n = names.flowName && c.cronJobId ? names.flowName(c.cronJobId) : null; const name = clean(n); t = name ? { key: 'sessionTitle.cronNamed', params: { name } } : { key: 'sessionTitle.cron' }; break; }
    case 'conversation-direct': { const n = (names.interlocutorName && c.interlocutorId ? names.interlocutorName(c.interlocutorId) : null) || names.senderName?.(s); t = n ? named(n) : { key: 'sessionTitle.user', params: { id: '' } }; break; }
    // a group shows its name from the adapter/enricher; otherwise « Groupe sans nom » and its platform, never an id
    case 'conversation-group': { const n = (names.interlocutorName && c.interlocutorId ? names.interlocutorName(c.interlocutorId) : null) || own(); const platform = c.channel || (/^([a-z][a-z0-9]*)-/.exec(c.interlocutorId || '') || [])[1];
      t = n ? named(n) : platform ? { key: 'sessionTitle.groupUnnamed', params: { platform: { key: 'channel.' + platform } } } : { key: 'sessionTitle.groupUnnamedPlain' }; break; }
    case 'dashboard': t = { key: 'sessionTitle.dashboard' }; break;
    case 'explicit': { const n = own(), id = n ? null : clean(c.explicitKey, 64); t = n ? named(n) : id ? { key: 'sessionTitle.explicit', params: { id } } : untitled; break; }
    case 'acp': { const n = own(); t = n ? named(n) : { key: 'sessionTitle.acp' }; break; }
    case 'conversation': { const n = own() || names.agentLabel?.(c.agentId) || names.agentName?.(c.agentId); t = n ? named(n) : untitled; break; }
    default: { const n = own(); t = n ? named(n) : untitled; }
  }
  return c.heartbeatOf ? { key: 'sessionTitle.heartbeat', params: { title: t } } : t;
}

// The French rendering of the title (the 2.x `label` string; the UI prefers `title`)
const FR = require('../../../i18n/fr').LABELS;
function renderFr(ref) {
  const t = FR[ref.key] || ref.key;
  return t.replace(/\{(\w+)\}/g, (_, k) => { const v = ref.params ? ref.params[k] : null; return v == null ? '' : typeof v === 'object' ? renderFr(v) : String(v); });
}
const sessionLabel = (s, names = {}) => renderFr(sessionTitle(s, names));

// T-0058: which connector and which agent a row came from (canonical, adapter-declared), and whether tokens are known
const connectorOf = (s, names) => { const c = names.connectorOf?.(s.key); return c ? { id: c.id, adapter: c.adapter, name: c.name, mark: c.mark } : null; };
const agentOf = (s, names) => { const id = s.class.agentId; if (!id) return null; const name = names.agentLabel?.(id); return name ? { id, name } : null; };
const tokensKnown = (s) => (typeof s.tokensKnown === 'boolean' ? s.tokensKnown : s.usage.total > 0);
function rowVM(s, names, P = P2, now = Date.now()) {
  return Object.assign({ id: s.key, kind: P.sessionKind(s.class.kind) }, runtimeKindOf(P, s), { channel: P.channelId(s.class.channel), label: sessionLabel(s, names), title: sessionTitle(s, names),
    model: s.model ? s.model.id : null, modelProvider: s.model ? s.model.provider : s.provider,
    tokens: s.usage.total, tokensKnown: tokensKnown(s), updatedAt: s.updatedAt, live: executionState(s.run, now).status === 'running' || names.activity?.(s.key)?.kind === 'working', heartbeat: !!s.class.heartbeatOf,
    execution: executionVM(s.run, names.activity?.(s.key), now),
    connector: connectorOf(s, names), agent: agentOf(s, names) });
}

const encodeCursor = (o) => Buffer.from(JSON.stringify({ o })).toString('base64url');
function decodeCursor(c) {
  if (c == null || c === '') return 0;
  try { const v = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); if (Number.isInteger(v.o) && v.o >= 0) return v.o; } catch (_) { /* invalid */ }
  return null;
}

/**
 * Query → { kind, heartbeat, offset, limit } or { error: { field, issue } }.
 * kind: a SessionKind; heartbeat: 'include' or absent; cursor: opaque; limit: 1..200.
 */
function parseLogsQuery(q = {}, P = P2) {
  const kind = q.kind == null || q.kind === '' ? null : String(q.kind);
  if (kind && !P.SESSION_KINDS.includes(kind)) return { error: { field: 'kind', issue: 'invalid' } };   // a SessionKind of the caller's contract
  if (q.heartbeat != null && q.heartbeat !== '' && q.heartbeat !== 'include') return { error: { field: 'heartbeat', issue: 'invalid' } };
  const offset = decodeCursor(q.cursor);
  if (offset === null) return { error: { field: 'cursor', issue: 'invalid' } };
  let limit = LIMIT_DEFAULT;
  if (q.limit != null && q.limit !== '') { limit = Number(q.limit); if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) return { error: { field: 'limit', issue: 'invalid' } }; }
  // T-0058: connector (instance id) and agent (agent id) filters: opaque bounded strings, matched exactly
  const opaque = (v) => (v == null || v === '' ? null : String(v).length <= 512 ? String(v) : undefined);
  const connector = opaque(q.connector), agent = opaque(q.agent);
  if (connector === undefined) return { error: { field: 'connector', issue: 'invalid' } };
  if (agent === undefined) return { error: { field: 'agent', issue: 'invalid' } };
  return { kind, heartbeat: q.heartbeat === 'include', connector, agent, offset, limit };
}

// Order: updatedAt desc (unknown last), then id. Heartbeats hidden unless asked for (2.1).
// T-0058: `facets` lists every connector and agent present (before the connector/agent filters), for the filter menus.
function buildLogsPage(sessions, { kind = null, heartbeat = false, connector = null, agent = null, offset = 0, limit = LIMIT_DEFAULT, now = Date.now() } = {}, names = {}, P = P2) {
  const visible = sessions.filter((s) => (heartbeat || !s.class.heartbeatOf) && (!kind || P.sessionKindsIn(kind).includes(s.class.kind)));
  const connectors = new Map(), agents = new Map();
  for (const s of visible) {
    const c = connectorOf(s, names), a = agentOf(s, names);
    if (c) connectors.set(c.id, { ...c, count: (connectors.get(c.id)?.count || 0) + 1 });
    if (a) agents.set(a.id, { ...a, connectorId: c ? c.id : null, count: (agents.get(a.id)?.count || 0) + 1 });
  }
  const rows = visible.filter((s) => (!connector || connectorOf(s, names)?.id === connector) && (!agent || s.class.agentId === agent))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const items = rows.slice(offset, offset + limit).map((s) => rowVM(s, names, P, now));
  const byName = (x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id);
  return { items, nextCursor: offset + limit < rows.length ? encodeCursor(offset + limit) : null,
    facets: { connectors: [...connectors.values()].sort(byName), agents: [...agents.values()].sort(byName) } };
}

// The topic id a logs query belongs to (first page only; api.md §3 table)
function logsTopicOf({ kind, heartbeat, connector = null, agent = null }) {
  // query keys sorted (topics.js canonical id)
  const q = []; if (agent) q.push('agent=' + encodeURIComponent(agent)); if (connector) q.push('connector=' + encodeURIComponent(connector));
  if (heartbeat) q.push('heartbeat=include'); if (kind) q.push('kind=' + encodeURIComponent(kind));
  return q.length ? 'logs?' + q.join('&') : 'logs';
}

/**
 * @param {object} s           canonical Session (null → not found)
 * @param {object|null} t      canonical Transcript (null before the first read: empty window)
 */
// traceState (R16-07): 'fresh' (the last transcript read succeeded), 'stale' (it failed, or none yet: the last good
// trace is shown), 'unavailable' (the runtime has no transcript capability). Never an empty "success".
function repairRowIdentity(path, row) {
  if (path === 'participants') return [row?.kind || null, row?.runtime || null, row?.channel || null];
  if (path === 'subagents') return [row?.kind || null, row?.runtime || null, row?.channel || null,
    row?.delegation?.sessionKey || null];
  if (path === 'events') {
    const sender = row?.senderInfo || {};
    return [row?.kind || null, Number.isSafeInteger(row?.at) ? row.at : null,
      sender.kind || null, sender.id || null, sender.runtime || null, sender.channel || null];
  }
  return [row?.kind || null, row?.runtime || null, row?.channel || null];
}
function stableRepairId(path, scope, priorId, identity, occurrence, suffix = 0) {
  const digest = createHash('sha256').update(JSON.stringify([path, scope, priorId, identity, occurrence, suffix])).digest('hex');
  return path === 'events' ? 'msg:' + digest + ':0' : 'repair:' + digest;
}
function repairSessionCollections(vm, onRepair = () => {}) {
  const repair = (path, rows, { distinctDelegations = false } = {}) => {
    if (!Array.isArray(rows)) return rows;
    const out = [], byId = new Map(), occurrences = new Map();
    // Later original IDs are reserved too, otherwise a repaired row can steal
    // one and make the distinct later row disappear in projectEvents/schema.
    const used = new Set(rows.map(row => row && typeof row.id === 'string' ? row.id : null).filter(Boolean));
    let count = 0;
    for (const row of rows) {
      const id = row && typeof row.id === 'string' ? row.id : null;
      if (!id) { out.push(row); continue; }
      const index = byId.get(id);
      if (index === undefined) { byId.set(id, out.length); used.add(id); out.push(row); continue; }
      const prior = out[index];
      if (JSON.stringify(prior) === JSON.stringify(row)) { count++; continue; }
      const identity = repairRowIdentity(path, row);
      const occurrenceKey = JSON.stringify([id, identity]);
      const occurrence = occurrences.get(occurrenceKey) || 1;
      occurrences.set(occurrenceKey, occurrence + 1);
      const nextUniqueId = () => {
        let suffix = 0, repaired;
        do { repaired = stableRepairId(path, vm.key, id, identity, occurrence, suffix++); } while (used.has(repaired));
        used.add(repaired); return repaired;
      };
      if (distinctDelegations && row.delegation?.sessionKey && prior.delegation?.sessionKey !== row.delegation.sessionKey) {
        out.push({ ...row, id: nextUniqueId() }); count++; continue;
      }
      if (path === 'events') {
        out.push({ ...row, id: nextUniqueId() }); count++; continue;
      }
      // Distinct provider identities may legitimately share a display id.
      // Keep both without exposing the conflicting source identity in a key.
      out.push({ ...row, id: nextUniqueId() }); count++;
    }
    if (count) onRepair(path, count);
    return out;
  };
  return { ...vm,
    participants: repair('participants', vm.participants),
    subagents: repair('subagents', vm.subagents, { distinctDelegations: true }),
    events: repair('events', vm.events),
  };
}

function buildSessionVM(s, t, names = {}, traceState = t ? 'fresh' : 'stale', P = P2, now = Date.now(), onRepair = () => {}) {
  if (!s) return null;
  const normalized = normalizeTranscriptEvents(t, s.key);
  if (normalized.repaired) onRepair('events', normalized.repaired);
  t = normalized.transcript;
  const context = names.senderContext?.(s) || {};
  const events = projectEvents(t?.events, context);
  const participants = participantsOf([
    ...projectEvents((t?.participants || []).map((senderInfo) => ({ senderInfo })), context), ...events,
    ...projectEvents((names.delegatedSessions?.(s) || []).map((child) => ({ senderInfo: {
      kind: 'agent', id: child.key, name: null, runtime: context.runtime || 'generic', channel: s.class.channel || null,
      avatarHint: null, delegation: { sessionKey: child.key, label: child.label || child.displayName || child.goal?.objective || null },
    } })), context),
  ]);
  const vm = Object.assign({ key: s.key, label: sessionLabel(s, names), title: sessionTitle(s, names), kind: P.sessionKind(s.class.kind) }, runtimeKindOf(P, s), {
    model: s.model ? s.model.id : null, modelProvider: s.model ? s.model.provider : s.provider,
    tokens: s.usage.total, updatedAt: s.updatedAt, cwd: s.cwd,
    run: { ...executionVM(s.run, names.activity?.(s.key), now), endReason: s.run.endReason },
    messageCount: messageCountOf(s, t, names.conversationMessageCount?.(s.key)),
    window: t ? { from: t.window.from, to: t.window.to } : { from: 0, to: 0 },
    toolCount: events.filter((e) => e.kind === 'tool').length,
    traceState,
    participants: participants.filter((p) => !p.delegation),
    subagents: participants.filter((p) => p.kind === 'agent' && p.delegation),
    events,
  });
  return repairSessionCollections(vm, onRepair);
}

module.exports = { buildLogsPage, buildSessionVM, repairSessionCollections, parseLogsQuery, logsTopicOf, sessionLabel, sessionTitle, executionVM, LIMIT_DEFAULT, LIMIT_MAX };
