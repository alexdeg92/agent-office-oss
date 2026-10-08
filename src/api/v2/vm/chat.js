'use strict';
// ChatVM (api.md §3.3). The conversation is the portal chat session's transcript (user and assistant events), plus
// failed turns (role 'error', kept in memory) and, while a turn is pending, the message just sent.
const MAX = 50;

/**
 * @param {object} p
 * @param {string} p.sessionKey
 * @param {object|null} p.transcript   canonical Transcript of the chat session
 * @param {object|null} p.pending      { turnId, since, text }
 * @param {Array} p.errors             [{ id, at, text }]
 */
function buildChatVM({ sessionKey, transcript, pending, errors = [], local = [] }) {
  const msgs = [];
  for (const e of transcript ? transcript.events : []) {
    if (e.kind === 'user') msgs.push({ id: e.id, role: 'user', at: e.at, text: e.text, meta: null });
    else if (e.kind === 'assistant') msgs.push({ id: e.id, role: 'assistant', at: e.at, text: e.text, meta: { model: e.model, tokens: e.outputTokens, durationMs: null } });
  }
  for (const x of errors) msgs.push({ id: x.id, role: 'error', at: x.at, text: x.text, meta: null });
  // R15-03: messages of finished turns (the sent text, the reply) until the transcript itself shows them
  const inTranscript = (m) => msgs.some((t) => t.role === m.role && t.text === m.text && t.at >= m.since - 1000);
  for (const m of local) if (!inTranscript(m)) msgs.push({ id: m.id, role: m.role, at: m.at, text: m.text, meta: m.meta });
  // the message being answered, until the transcript has it
  if (pending && !msgs.some((m) => m.role === 'user' && m.at >= pending.since - 1000 && m.text === pending.text)) {
    msgs.push({ id: 'pending_' + pending.turnId, role: 'user', at: pending.since, text: pending.text, meta: null });
  }
  msgs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { sessionKey, turnPending: pending ? { turnId: pending.turnId, since: pending.since } : null, messages: msgs.slice(-MAX) };
}

module.exports = { buildChatVM, MAX };
