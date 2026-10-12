'use strict';
// ChatVM (api.md §3.3). The conversation is the portal chat session's transcript (user and assistant events), plus
// failed turns (role 'error', kept in memory) and, while a turn is pending, the message just sent.
const { projectEvents, resolveSender, knownSender } = require('../../../engine/model/sender');
const MAX = 50;

/**
 * @param {object} p
 * @param {string} p.sessionKey
 * @param {object|null} p.transcript   canonical Transcript of the chat session
 * @param {object|null} p.pending      { turnId, since, text }
 * @param {Array} p.errors             [{ id, at, text }]
 */
function buildChatVM({ sessionKey, transcript, pending, errors = [], local = [], senderContext = {} }) {
  const msgs = [];
  for (const e of projectEvents(transcript?.events, senderContext)) {
    if (e.kind === 'user') msgs.push({ id: e.id, role: 'user', at: e.at, text: e.text, senderInfo: e.senderInfo, meta: null });
    else if (e.kind === 'assistant') msgs.push({ id: e.id, role: 'assistant', at: e.at, text: e.text, senderInfo: e.senderInfo, meta: { model: e.model, tokens: e.outputTokens, durationMs: null } });
  }
  for (const x of errors) msgs.push({ id: x.id, role: 'error', at: x.at, text: x.text, meta: null });
  // R15-03: messages of finished turns (the sent text, the reply) until the transcript itself shows them
  const transcriptMessages = msgs.slice();
  const claimed = new Set();
  const inTranscript = m => {
    const echo = transcriptMessages.find(t => !claimed.has(t.id) && t.role === m.role && t.text === m.text && t.at >= m.since - 1000);
    if (!echo) return false;
    claimed.add(echo.id);
    // The portal knows who accepted these recent turns even when the runtime omits human identity.
    if (m.senderInfo) echo.senderInfo = m.senderInfo;
    return true;
  };
  for (const m of local) if (!inTranscript(m)) msgs.push({ id: m.id, role: m.role, at: m.at, text: m.text, meta: m.meta, senderInfo: m.senderInfo });
  // the message being answered, until the transcript has it
  if (pending && !inTranscript({ ...pending, role: 'user' })) {
    msgs.push({ id: 'pending_' + pending.turnId, role: 'user', at: pending.since, text: pending.text, senderInfo: pending.senderInfo, meta: null });
  }
  for (const m of msgs) m.senderInfo = knownSender(m.senderInfo || resolveSender({ role: m.role === 'error' ? 'system' : m.role }, senderContext), senderContext);
  msgs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { sessionKey, turnPending: pending ? { turnId: pending.turnId, since: pending.since } : null, messages: msgs.slice(-MAX) };
}

module.exports = { buildChatVM, MAX };
