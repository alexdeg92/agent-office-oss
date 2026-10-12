// Session history tolerates older/incomplete LabelRefs and keeps route construction in the router.
import { label, has, t, msg, agentName } from '../i18n.js';
export function conversationDigest(events) {
  const messages = events.filter((e) => (e.kind === 'user' || e.kind === 'assistant') && e.text);
  const tools = events.filter((e) => e.kind === 'tool');
  const ask = messages.find((e) => e.kind === 'user');
  const replies = messages.filter((e) => e.kind === 'assistant');
  return { ask: ask ? { ...ask, text: ask.text.split('[Subagent Task]').at(-1).trim() } : null,
    result: replies.findLast((e) => e.text.trim().length >= 60) || replies.at(-1),
    tools: [...new Set(tools.map((e) => e.name))].slice(0, 4), steps: tools.length, messages: messages.slice(-4) };
}
export function completeRef(ref) {
  if (typeof ref === 'string') return !!ref.trim();
  if (!ref?.key || !has(ref.key)) return false;
  return [...String(t(ref.key)).matchAll(/\{(\w+)\}/g)].every((m) => ref.params?.[m[1]] != null && (typeof ref.params[m[1]] !== 'object' || completeRef(ref.params[m[1]])));
}
export function sessionRow(e) {
  const s = e.session || {}, params = e.text?.params || {};
  const raw = s.label || (typeof params.session === 'object' ? params.session : null);
  const who = completeRef(raw) ? label(raw) : e.actor?.name || agentName();
  const messages = Number.isInteger(s.messages) ? s.messages : Number.isInteger(params.messages) ? params.messages : null;
  const tokens = Number.isInteger(s.tokens) ? s.tokens : Number.isInteger(params.tokens) ? params.tokens : null;
  return { key: s.key || params.sessionKey || (typeof params.session === 'string' ? params.session : null), who,
    people: (s.people || []).map((p) => p.name).join(' · '), channel: s.channel || raw?.params?.channel || null,
    summary: s.summary || msg('project.history.session.empty'),
    messages: messages == null ? msg('project.history.messages.unknown') : msg('project.history.messages', { n: messages }),
    tokens: tokens == null ? null : msg('project.history.tokens', { n: tokens }) };
}

// Inputs can arrive in either order (GET, pagination, live updates); the control describes the rendered order.
export function historyItems(items, order='desc') {
  const sorted = [...items].sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
  return order === 'desc' ? sorted.reverse() : sorted;
}
