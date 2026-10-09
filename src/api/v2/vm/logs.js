'use strict';
// Journaux: Page<LogRowVM> and SessionVM (api.md §3.6). Pure builders over canonical sessions and transcripts.
// Labels are French display strings; the agent is never named here (platform direction: the UI names it from MetaVM).
const { project2x: P2 } = require('../project2x');   // G3a: the 2.x wire values (ADR §12.6); G5: or project3x (the `P` param)
// G5: { runtimeKind } in 3.0 (right after `kind`), nothing in 2.x (the hook returns undefined)
const runtimeKindOf = (P, s) => { const rk = P.runtimeKind(s.class.kind); return rk === undefined ? {} : { runtimeKind: rk }; };

const LIMIT_DEFAULT = 50, LIMIT_MAX = 200;
const tail = (s, n) => String(s || '').slice(-n);
const { projectEvents, participantsOf } = require('../../../engine/model/sender');
const { messageCountOf } = require('../../../projects/session-summary');

/**
 * A session's title as a LabelRef (Q03-A01): generated parts are label keys (sessionTitle.*), so the UI shows them in
 * its own language; genuine names (a flow's, an interlocutor's, an explicit session's) travel as raw params.
 * @param {object} s canonical Session
 * @param {{ interlocutorName?: (id) => string|null, flowName?: (jobId) => string|null }} names
 */
function sessionTitle(s, names = {}) {
  const c = s.class;
  // Room titles may identify the room by a bounded ID. Unknown people use the same localized
  // fallback on every runtime/channel; their opaque IDs never substitute for a person's name.
  const idOf = (iid) => { if (!iid) return ''; if (/^discord-(user|channel):/.test(iid)) return tail(iid, 6); return tail(iid.slice(iid.indexOf(':') + 1), 24); };
  const named = (name) => ({ key: 'sessionTitle.named', params: { name } });
  let t;
  switch (c.kind) {
    case 'primary': t = { key: 'sessionTitle.main' }; break;
    case 'subagent': t = { key: 'sessionTitle.subagent', params: { id: String(c.subagentId || '').slice(0, 4) } }; break;
    case 'scheduled': { const n = names.flowName && c.cronJobId ? names.flowName(c.cronJobId) : null; t = n ? { key: 'sessionTitle.cronNamed', params: { name: n } } : { key: 'sessionTitle.cron' }; break; }
    case 'conversation-direct': { const n = (names.interlocutorName && c.interlocutorId ? names.interlocutorName(c.interlocutorId) : null) || names.senderName?.(s); t = n ? named(n) : { key: 'sessionTitle.user', params: { id: '' } }; break; }
    case 'conversation-group': { const n = names.interlocutorName && c.interlocutorId ? names.interlocutorName(c.interlocutorId) : null; t = n ? named(n) : { key: 'sessionTitle.channel', params: { id: idOf(c.interlocutorId) } }; break; }
    case 'dashboard': t = { key: 'sessionTitle.dashboard' }; break;
    case 'explicit': t = s.displayName ? named(s.displayName) : { key: 'sessionTitle.explicit', params: { id: c.explicitKey || tail(s.key, 12) } }; break;
    case 'acp': t = s.displayName ? named(s.displayName) : { key: 'sessionTitle.acp' }; break;
    default: t = named(s.displayName || s.key);
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

function rowVM(s, names, P = P2) {
  return Object.assign({ id: s.key, kind: P.sessionKind(s.class.kind) }, runtimeKindOf(P, s), { channel: P.channelId(s.class.channel), label: sessionLabel(s, names), title: sessionTitle(s, names),
    model: s.model ? s.model.id : null, modelProvider: s.model ? s.model.provider : s.provider,
    tokens: s.usage.total, updatedAt: s.updatedAt, live: s.run.status === 'running', heartbeat: !!s.class.heartbeatOf });
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
  return { kind, heartbeat: q.heartbeat === 'include', offset, limit };
}

// Order: updatedAt desc (unknown last), then id. Heartbeats hidden unless asked for (2.1).
function buildLogsPage(sessions, { kind = null, heartbeat = false, offset = 0, limit = LIMIT_DEFAULT } = {}, names = {}, P = P2) {
  const rows = sessions.filter((s) => (heartbeat || !s.class.heartbeatOf) && (!kind || P.sessionKindsIn(kind).includes(s.class.kind)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  const items = rows.slice(offset, offset + limit).map((s) => rowVM(s, names, P));
  return { items, nextCursor: offset + limit < rows.length ? encodeCursor(offset + limit) : null };
}

// The topic id a logs query belongs to (first page only; api.md §3 table)
function logsTopicOf({ kind, heartbeat }) {
  const q = []; if (heartbeat) q.push('heartbeat=include'); if (kind) q.push('kind=' + encodeURIComponent(kind));
  return q.length ? 'logs?' + q.join('&') : 'logs';
}

/**
 * @param {object} s           canonical Session (null → not found)
 * @param {object|null} t      canonical Transcript (null before the first read: empty window)
 */
// traceState (R16-07): 'fresh' (the last transcript read succeeded), 'stale' (it failed, or none yet: the last good
// trace is shown), 'unavailable' (the runtime has no transcript capability). Never an empty "success".
function buildSessionVM(s, t, names = {}, traceState = t ? 'fresh' : 'stale', P = P2) {
  if (!s) return null;
  const context = names.senderContext?.(s) || {};
  const events = projectEvents(t?.events, context);
  const participants = participantsOf([
    ...projectEvents((t?.participants || []).map((senderInfo) => ({ senderInfo })), context), ...events,
    ...projectEvents((names.delegatedSessions?.(s) || []).map((child) => ({ senderInfo: {
      kind: 'agent', id: child.key, name: null, runtime: context.runtime || 'generic', channel: s.class.channel || null,
      avatarHint: null, delegation: { sessionKey: child.key, label: child.label || child.displayName || child.goal?.objective || null },
    } })), context),
  ]);
  return Object.assign({ key: s.key, label: sessionLabel(s, names), title: sessionTitle(s, names), kind: P.sessionKind(s.class.kind) }, runtimeKindOf(P, s), {
    model: s.model ? s.model.id : null, modelProvider: s.model ? s.model.provider : s.provider,
    tokens: s.usage.total, updatedAt: s.updatedAt, cwd: s.cwd,
    run: { status: s.run.status, endReason: s.run.endReason },
    messageCount: messageCountOf(s, t, names.conversationMessageCount?.(s.key)),
    window: t ? { from: t.window.from, to: t.window.to } : { from: 0, to: 0 },
    toolCount: events.filter((e) => e.kind === 'tool').length,
    traceState,
    participants: participants.filter((p) => !p.delegation),
    subagents: participants.filter((p) => p.kind === 'agent' && p.delegation),
    events,
  });
}

module.exports = { buildLogsPage, buildSessionVM, parseLogsQuery, logsTopicOf, sessionLabel, sessionTitle, LIMIT_DEFAULT, LIMIT_MAX };
