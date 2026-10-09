'use strict';
// Runtime-neutral identity. Names are display data; never derive them from opaque IDs.
const s = require('../../schema');
const Sender = s.object({
  kind: s.enumOf(['human', 'agent', 'system', 'tool']), id: s.string().min(1),
  name: s.string().nullable(), runtime: s.string().min(1),
  channel: s.string().nullable(), avatarHint: s.string().nullable(),
  delegation: s.object({ sessionKey: s.string().min(1), label: s.string().nullable() }, { extra: 'reject' }).nullable().optional(),
}, { extra: 'reject' });
const Participant = Sender;
const nameOf = (...names) => names.find((n) => typeof n === 'string' && n.trim() && !/^\+?\d[\d\s()-]{5,}$/.test(n.trim()) && !/^(?:[a-z]+-(?:user|room|channel):|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$|<@!?\d+>)/.test(n.trim()))?.trim().slice(0, 120) || null;

function resolveSender(raw, ctx = {}) {
  if (raw.senderInfo) return knownSender(raw.senderInfo, ctx);
  const runtime = ctx.runtime || 'generic', channel = ctx.channel || null;
  const role = raw.role || raw.kind;
  const kind = role === 'user' || role === 'operator' ? 'human' : role === 'tool' || role === 'toolResult' ? 'tool'
    : role === 'system' ? 'system' : 'agent';
  const person = kind === 'human' ? ctx.operator : kind === 'agent' ? ctx.agent : null;
  return { kind, id: person?.id || `${kind}:${kind === 'tool' ? raw.name || raw.toolName || 'tool' : kind === 'human' ? 'unknown:' + (ctx.sessionKey || 'local') : kind}`,
    name: nameOf(person?.name, kind === 'tool' ? raw.name || raw.toolName : null), runtime, channel, avatarHint: person?.avatarUrl || null };
}
const stripEnvelope = (text) => String(text || ''); // CLI harness default: no runtime envelope.
const senderKey = (sender) => sender ? sender.delegation ? `${sender.runtime}:agent:${sender.delegation.sessionKey}`
  : `${sender.runtime}:${sender.channel || ''}:${sender.kind}:${sender.id}` : null;
function knownSender(sender, ctx = {}) {
  if (!sender) return sender;
  if (sender.delegation == null && Object.hasOwn(sender, 'delegation')) {
    const { delegation, ...identity } = sender;
    sender = identity; // Canonical entities fill optional fields with null; wire optionals stay absent.
  }
  // Canonical session relationships, not runtime key grammars, identify delegated agents.
  const session = sender.kind === 'agent' ? ctx.sessionOf?.(sender.delegation?.sessionKey || sender.id) : null;
  const delegation = sender.delegation || (session?.class.kind === 'subagent' ? { sessionKey: session.key, label: null } : null);
  if (delegation) {
    const label = nameOf(session?.label, delegation.label, session?.displayName, session?.goal?.objective, sender.name);
    return { ...sender, name: label, delegation: { ...delegation, label } };
  }
  const people = ctx.people || [];
  const person = people.find((p) => p.id === sender.id || p.identities?.some((i) => i.channel === sender.channel && i.id === sender.id)
    || (sender.kind === 'agent' && p.links?.agentId && sender.id === `agent:${p.links.agentId}`));
  return { ...sender, name: nameOf(person?.name, ctx.nameOf?.(sender.id), sender.name), avatarHint: person?.avatarUrl || (person ? 'person:' + person.id : null) || ctx.avatarOf?.(sender.id) || sender.avatarHint || null };
}
function projectEvents(events, ctx = {}) {
  return (events || []).map((e) => {
    const senderInfo = knownSender(e.senderInfo || resolveSender({ ...e, role: e.kind }, ctx), ctx);
    return { ...e, senderInfo, ...(e.kind === 'user' ? { sender: senderInfo.name || nameOf(e.sender) } : {}) };
  });
}
function participantsOf(events) {
  const people = new Map();
  for (const e of events || []) {
    const p = e.senderInfo;
    if (!p || !['human', 'agent'].includes(p.kind)) continue;
    const key = senderKey(p), old = people.get(key);
    people.set(key, old ? { ...old, ...p, name: p.name || old.name, avatarHint: p.avatarHint || old.avatarHint,
      ...(old.delegation || p.delegation ? { delegation: { ...(old.delegation || p.delegation), label: p.delegation?.label || old.delegation?.label || null } } : {}) } : p);
  }
  return [...people.values()];
}
module.exports = { Sender, Participant, nameOf, resolveSender, stripEnvelope, knownSender, projectEvents, participantsOf, senderKey };
