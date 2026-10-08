// Contract 3.0 for the mock (G5, api-v3.md D1–D8): the 2.5 mock's view models projected to 3.0, the way the server's
// one canonical core serves both versions. Every function is idempotent (a 3.0 value passes through unchanged), so
// a VM built for a topic and then returned by a GET can be projected twice. Invented data only.
// The office (D3) and its layout (D4) are office-dev's mock (office/mock-office.js), told the version by mock/server.js.

const KIND = { main: 'primary', cron: 'scheduled', 'chat-direct': 'conversation-direct', 'chat-group': 'conversation-group', dashboard: 'internal', acp: 'internal', explicit: 'internal' };
const RUNTIME_KINDS = ['dashboard', 'acp', 'explicit'];
const INTERLOCUTOR = { 'discord-user': 'user', 'discord-channel': 'room' };

/** D2: a 2.x session kind → 3.0 (subagent, unrecognized and every 3.0 kind unchanged). */
export const sessionKind = (k) => KIND[k] || k;
/** D2: the runtime's own kind of an internal session, else null. */
export const runtimeKind = (k, current = null) => (RUNTIME_KINDS.includes(k) ? k : current ?? null);
/** D2/D6: a ChannelRef or null (2.x's `unrecognized` and `raw:` prefix are gone). */
export const channelRef = (c) => (c == null || c === 'unrecognized' ? null : String(c).replace(/^raw:/, ''));

/** 3.0 query values → the 2.5 mock's (D2 logs `kind`, D8 board `filter`). `internal` is filtered after projection. */
export function queryTo2x(params) {
  const q = new URLSearchParams(params);
  const back = { primary: 'main', scheduled: 'cron', 'conversation-direct': 'chat-direct', 'conversation-group': 'chat-group' };
  const kind = q.get('kind');
  if (kind === 'internal') q.delete('kind');
  else if (kind && back[kind]) q.set('kind', back[kind]);
  if (q.get('filter') === 'with-agent') { q.set('filter', 'with-timmy'); q.delete('agent'); }   // the 2.5 mock's name for the primary's projects
  return { query: q, internalOnly: kind === 'internal', agent: params && new URLSearchParams(params).get('agent') };
}

const logRow = (r) => ({ ...r, kind: sessionKind(r.kind), runtimeKind: runtimeKind(r.kind, r.runtimeKind), channel: channelRef(r.channel) });
const interlocutorRow = (i) => ({ ...i, kind: INTERLOCUTOR[i.kind] || i.kind, channel: i.channel || (String(i.id).split('-')[0]) });

const DROP_2X = /^(sessionKind\.(main|cron|chat-direct|chat-group|dashboard|acp|explicit)|occupantRole\.(main|cron|dm|channel)|interlocutorKind\.discord-(user|channel)|channel\.unrecognized)$/;
const LABELS_3 = {
  'sessionKind.primary': 'Principale', 'sessionKind.scheduled': 'Tâche planifiée', 'sessionKind.conversation-direct': 'Message direct',
  'sessionKind.conversation-group': 'Groupe', 'sessionKind.conversation': 'Conversation', 'sessionKind.internal': 'Interne',
  'runtimeKind.dashboard': 'Tableau de bord', 'runtimeKind.acp': 'Session ACP', 'runtimeKind.explicit': 'Session explicite',
  'occupantRole.primary': 'Agent principal', 'occupantRole.scheduled': 'Exécution planifiée', 'occupantRole.direct': 'Conversation privée',
  'occupantRole.group': 'Groupe', 'occupantRole.conversation': 'Conversation',
  'interlocutorKind.user': 'Personne', 'interlocutorKind.room': 'Salon',
  'channel.discord': 'Discord',
};
const CAPABILITIES = { sessions: true, transcripts: true, activity: 'run-state', flows: { read: true, write: true, schedules: ['cron', 'every', 'at'], multiAgent: false },
  skills: { read: true, toggle: true, detail: true }, channels: true, interlocutors: true, chat: true, restart: true, costs: true, subagents: true, sessionGroups: true, projectComments: true };

/**
 * ?capacites=-chat,-flows.write,-restart: preview a smaller runtime (D1). Each '-path' turns a capability off,
 * '+path' back on; null without the hook (the full set).
 * R27-03: only the boolean capabilities of CAPABILITIES are toggles (an allowlist of dotted paths); anything else,
 * `__proto__`/`constructor`/`prototype` included, is ignored. The result is built from null-prototype objects and
 * written by own keys only, so a query can never reach Object.prototype.
 */
const nullCopy = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nullCopy(x)]))) : Array.isArray(v) ? [...v] : v);
const TOGGLES = new Set();
(function walk(o, prefix) { for (const [k, v] of Object.entries(o)) { if (typeof v === 'boolean') TOGGLES.add(prefix + k); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, prefix + k + '.'); } })(CAPABILITIES, '');
export function capabilitiesFrom(search) {
  const raw = new URLSearchParams(search || '').get('capacites');
  if (raw == null) return null;
  const caps = nullCopy(CAPABILITIES);
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const dotted = item.replace(/^[-+]/, '');
    if (!TOGGLES.has(dotted)) continue;
    const keys = dotted.split('.');
    let o = caps;
    for (const k of keys.slice(0, -1)) o = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null;
    if (o) o[keys.at(-1)] = !item.startsWith('-');
  }
  return caps;
}
/** D1: MetaVM 3.0. `capabilities` may be overridden (the ?capacites= hook) to preview a smaller runtime. */
export function meta(m, { capabilities = null } = {}) {
  const labels = Object.fromEntries(Object.entries(m.labels || {}).filter(([k]) => !DROP_2X.test(k)));
  Object.assign(labels, LABELS_3);
  if (m.primaryAgent) labels['agent.' + m.primaryAgent.id] = m.primaryAgent.name;
  const { channel, ...enums } = m.enums || {};
  return {
    ...m, apiVersion: 3, contractVersion: '3.0',
    runtime: { ...m.runtime, version: m.runtime.version ?? null, capabilities: capabilities || m.runtime.capabilities || CAPABILITIES },
    instance: { name: null, ...m.instance },
    locales: ['fr', 'en'],
    labels,
    enums: { ...enums, sessionKind: ['primary', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'internal', 'unrecognized'],
      occupantRole: ['primary', 'subagent', 'scheduled', 'direct', 'group', 'conversation'], interlocutorKind: ['user', 'room'] },
  };
}

/** Projects one VM by its schema name (vmcheck's names); unknown names pass through (same shape in 3.0). */
export function project(name, vm, { primaryId = null } = {}) {
  if (!vm || typeof vm !== 'object') return vm;
  switch (name) {
    case 'logs': return { ...vm, items: vm.items.map(logRow) };
    case 'session': return { ...vm, kind: sessionKind(vm.kind), runtimeKind: runtimeKind(vm.kind, vm.runtimeKind) };
    case 'access': return { ...vm, interlocutors: vm.interlocutors.map(interlocutorRow) };
    case 'interlocutor': return interlocutorRow(vm);
    case 'health': return Array.isArray(vm.channels) ? { ...vm, channels: vm.channels.map((c) => ({ ...c, id: channelRef(c.id) })) } : vm;
    case 'projects': {
      const filter = vm.filter === 'with-timmy' ? 'with-agent' : vm.filter;
      return { ...vm, filter, agent: filter === 'with-agent' ? vm.agent ?? primaryId : null };
    }
    case 'flow': {
      if (!vm.job) return vm;
      const { sessionTarget, wakeMode, ...job } = vm.job;
      const ext = sessionTarget !== undefined || wakeMode !== undefined ? { ...job.ext, openclaw: { sessionTarget: sessionTarget ?? null, wakeMode: wakeMode ?? null } } : job.ext;
      return { ...vm, job: { ...job, agentId: job.agentId || primaryId, ...(ext ? { ext } : {}) },
        runs: (vm.runs || []).map((r) => (r.delivery ? { ...r, delivery: { ...r.delivery, channel: channelRef(r.delivery.channel) } } : r)) };
    }
    default: return vm;
  }
}
