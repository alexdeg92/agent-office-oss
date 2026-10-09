'use strict';
const core = require('../../engine/model/sender');
const { classifySession } = require('./classify/session-kind');
// Only runtime-generated leading envelopes are consumed. Quoted metadata in the message body stays prose.
function envelope(text) {
  let rest = String(text || ''), sender = {}, conversation = {}, channel = null;
  for (;;) {
    const m = rest.match(/^\s*(Conversation info|Sender|Chat history since last reply|Replied message) \(untrusted(?:, for context)? metadata(?:, for context)?\):\s*```(?:json)?\s*([\s\S]*?)```\s*/i);
    if (m) {
      let data; try { data = JSON.parse(m[2]); } catch { break; }
      if (m[1].toLowerCase() === 'sender' && data && typeof data === 'object') sender = data;
      if (m[1].toLowerCase() === 'conversation info' && data && typeof data === 'object') conversation = data;
      rest = rest.slice(m[0].length);
      continue;
    }
    const legacy = rest.match(/^\s*\[(Discord|Telegram|WhatsApp|Slack|Signal|Matrix)\s+([^\]\n]*)\]\s*/i);
    if (!legacy) break;
    channel = legacy[1].toLowerCase();
    const from = legacy[2].match(/(?:\bfrom\s+|^)(.+?)(?:\s+(?:id[:=]|\()?([\w+.-]+)\)?)(?:\s+\d{4}-.*)?$/i);
    if (from) sender = { ...sender, name: sender.name || from[1], id: sender.id || from[2] };
    rest = rest.slice(legacy[0].length);
  }
  // Message-id suffix added to channel messages by the runtime.
  rest = rest.replace(/\n\[message_id:\s*[^\]\n]+\]\s*$/, '');
  return { text: rest.trim(), sender, conversation, channel };
}
const stripEnvelope = (text) => envelope(text).text;
const nonblank = (v) => typeof v === 'string' && v.trim() && v.length <= 512 ? v.trim() : null;
// These are per-message producer facts, distinct from session participants and owner flags.
function structuredSender(raw, ctx = {}) {
  if (raw.role !== 'user' || raw.display === false || (raw.provenance?.kind && raw.provenance.kind !== 'external_user')) return null;
  const meta = raw.__openclaw;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const identity = meta.senderIdentity;
  const id = nonblank(meta.senderId);
  if (!id || (identity && (identity.id !== id || !['observation', 'remote', 'profile'].includes(identity.type)))) return null;
  const channel = ctx.session?.class?.channel || ctx.channel || null;
  if (identity?.pluginId && channel && identity.pluginId !== channel) return null;
  const sourceChannel = identity?.pluginId || channel;
  if (sourceChannel !== null && (typeof sourceChannel !== 'string' || !sourceChannel.trim() || sourceChannel.length > 128)) return null;
  return { kind: identity?.senderKind === 'bot' ? 'agent' : 'human',
    id: identity?.type === 'profile' ? `openclaw-profile:${id}` : `${sourceChannel || 'local'}-user:${id}`,
    name: core.nameOf(meta.senderName, meta.senderUsername), runtime: 'openclaw', channel: sourceChannel, avatarHint: null };
}
function messageKey(raw) {
  const a = raw.idempotencyKey, b = raw.__openclaw?.idempotencyKey;
  if (a && b && a !== b) return null;
  const key = a || b;
  if (typeof key === 'string' && key.trim() && key.length <= 1012) return 'idempotency:' + key;
  const id = raw.__openclaw?.id;
  return typeof id === 'string' && id.trim() && id.length <= 1000 ? 'message:' + id : null;
}
function resolveSender(raw, ctx = {}) {
  const c = ctx.session?.class || classifySession(ctx.sessionKey || '') || {};
  const parsed = envelope(ctx.text ?? (typeof raw.content === 'string' ? raw.content : ''));
  const channel = c.channel || ctx.channel || raw.channel || parsed.channel || null;
  const baseCtx = { ...ctx, channel, runtime: 'openclaw' };
  const isOperator = c.kind === 'dashboard' || ['portal-chat', 'agent-office'].includes(c.explicitKey);
  const source = raw.provenance?.kind;
  if (raw.role === 'user' && (c.kind === 'scheduled' || source === 'internal_system' || source === 'system'))
    return { ...core.resolveSender({ role: 'system' }, baseCtx), id: 'system:' + (c.cronJobId || 'runtime') };
  if (raw.role === 'user' && (c.kind === 'subagent' || source === 'inter_session')) {
    const key = raw.provenance?.sourceSessionKey;
    const session = key && ctx.sessionOf?.(key);
    const cls = session?.class || (key ? classifySession(key) : null);
    if (key && (cls?.kind === 'subagent' || ctx.delegatedLabels?.has(key))) return delegatedSender(key, baseCtx);
    // Parent/task inputs are agents too, but are not child participants of their own conversation.
    const primary = cls?.agentId ? ctx.agentOf?.(cls.agentId) || (ctx.agent?.id === 'agent:' + cls.agentId ? ctx.agent : { id: 'agent:' + cls.agentId })
      : c.kind === 'subagent' ? ctx.parentAgent : ctx.agent;
    const sender = core.resolveSender({ role: 'assistant' }, { ...baseCtx, agent: primary });
    if (!primary && c.kind === 'subagent') sender.id = 'agent:parent';
    return core.knownSender(sender, baseCtx);
  }
  if (raw.role === 'assistant' && c.kind === 'subagent' && ctx.sessionKey) return delegatedSender(ctx.sessionKey, baseCtx);
  if (raw.role !== 'user') return core.resolveSender(raw, baseCtx);
  if (isOperator) return core.resolveSender(raw, baseCtx);
  const explicit = structuredSender(raw, baseCtx);
  if (explicit) return core.knownSender(explicit, baseCtx);
  if (raw.display !== false && (!source || source === 'external_user')) {
    const key = messageKey(raw);
    const captured = key && ctx.capturedSender?.(ctx.sessionKey, key);
    if (captured && (!channel || captured.channel === channel)) return core.knownSender(captured, baseCtx);
  }
  const info = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const meta = parsed.sender, conv = parsed.conversation, nested = conv.sender && typeof conv.sender === 'object' ? conv.sender : {};
  const id = raw.senderId || info.id || info.senderId || meta.id || meta.sender_id || conv.sender_id || nested.id || (c.kind === 'conversation-direct' ? c.interlocutorId : null);
  const name = core.nameOf(raw.displayName, info.displayName, meta.displayName, meta.display_name, raw.senderName, info.name, meta.name, conv.sender_name,
    nested.name, raw.username, info.username, meta.username, nested.username, conv.sender, raw.senderLabel, meta.label);
  return core.knownSender({ kind: 'human', id: id ? (String(id).startsWith(`${channel}-user:`) ? String(id) : `${channel || 'local'}-user:${id}`) : `human:unknown:${ctx.sessionKey || 'local'}`,
    name, channel, runtime: 'openclaw', avatarHint: null }, baseCtx);
}
function delegatedSender(key, ctx) {
  const label = core.nameOf(ctx.delegatedLabels?.get(key));
  return core.knownSender({ kind: 'agent', id: key, name: label, runtime: 'openclaw', channel: ctx.channel || null,
    avatarHint: null, delegation: { sessionKey: key, label } }, ctx);
}
module.exports = { resolveSender, stripEnvelope, envelope, structuredSender, messageKey, delegatedSender };
