'use strict';
// ChatVM (api.md §3.3). The conversation is the portal chat session's transcript (user and assistant events), plus
// failed turns (role 'error', kept in memory) and, while a turn is pending, the message just sent.
const { projectEvents, resolveSender, knownSender, senderKey } = require('../../../engine/model/sender');
const MAX = 50;

/**
 * @param {object} p
 * @param {string} p.sessionKey
 * @param {object|null} p.transcript   canonical Transcript of the chat session
 * @param {object|null} p.pending      { turnId, since, text }
 * @param {Array} p.errors             [{ id, at, text }]
 */
function buildChatVM({ sessionKey, transcript, pending, errors = [], local = [], senderContext = {}, avatarFor = () => null }) {
  const msgs = [];
  const avatar = sender => {
    if (!sender || sender.kind !== 'agent') return null;
    try {
      const look = avatarFor(sender);
      return look && typeof look.character === 'string' && Array.isArray(look.accessories)
        ? { character: look.character, variant: look.variant ?? null, accessories: [...look.accessories] } : null;
    } catch (_) { return null; }
  };
  const message = ({ id, kind = 'message', role, at, text = '', senderInfo = null, meta = null,
    title = null, status = null, collapsedByDefault = false }) => ({ id, kind, role, at, text, body: { text }, title, status,
    statusLabel: status ? { key: `chat.result.status.${status}` } : null, collapsedByDefault,
    avatar: avatar(senderInfo), ...(senderInfo ? { senderInfo } : {}), meta });
  for (const e of projectEvents(transcript?.events, senderContext)) {
    if (e.kind === 'user') msgs.push(message({ id: e.id, role: 'user', at: e.at, text: e.text, senderInfo: e.senderInfo }));
    else if (e.kind === 'assistant') msgs.push(message({ id: e.id, role: 'assistant', at: e.at, text: e.text, senderInfo: e.senderInfo,
      meta: { model: e.model, tokens: e.outputTokens, durationMs: null } }));
    else if (e.kind === 'subagent-result') msgs.push(message({ id: e.id, kind: 'subagent-result', role: 'assistant', at: e.at,
      text: e.body, senderInfo: e.senderInfo, title: e.title, status: e.status, collapsedByDefault: true }));
  }
  for (const x of errors) msgs.push(message({ id: x.id, role: 'error', at: x.at, text: x.text,
    senderInfo: resolveSender({ role: 'assistant' }, senderContext) }));
  // R15-03: messages of finished turns (the sent text, the reply) until the transcript itself shows them
  const transcriptMessages = msgs.slice();
  const claimed = new Set();
  const inTranscript = m => {
    // Successful command-buffer assistant replies are produced by the selected primary agent. The
    // command result has no provider sender metadata, so resolve that canonical author just as we
    // do when projecting the buffered row below. Keep the sender equality check: a delegated
    // assistant event must never consume the primary's local echo (or vice versa).
    const localSenderInfo = m.senderInfo || (m.role === 'assistant'
      ? resolveSender({ role: 'assistant' }, senderContext) : null);
    const localSender = senderKey(localSenderInfo);
    const echo = transcriptMessages.find(t => !claimed.has(t.id) && t.kind === 'message' && t.role === m.role &&
      senderKey(t.senderInfo) === localSender && t.text === m.text && t.at >= m.since - 1000);
    if (!echo) return false;
    claimed.add(echo.id);
    // The portal knows who accepted these recent turns even when the runtime omits human identity.
    if (m.senderInfo) echo.senderInfo = m.senderInfo;
    return true;
  };
  for (const m of local) if (!inTranscript(m)) msgs.push(message({ id: m.id, role: m.role, at: m.at, text: m.text, meta: m.meta,
    senderInfo: m.senderInfo || (m.role === 'assistant' ? resolveSender({ role: 'assistant' }, senderContext) : null) }));
  // the message being answered, until the transcript has it
  if (pending && !inTranscript({ ...pending, role: 'user' })) {
    msgs.push(message({ id: 'pending_' + pending.turnId, role: 'user', at: pending.since, text: pending.text, senderInfo: pending.senderInfo }));
  }
  for (const m of msgs) m.senderInfo = knownSender(m.senderInfo || resolveSender({ role: m.role === 'error' ? 'system' : m.role }, senderContext), senderContext);
  msgs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { sessionKey, turnPending: pending ? { turnId: pending.turnId, since: pending.since } : null, messages: msgs.slice(-MAX) };
}

module.exports = { buildChatVM, MAX };
