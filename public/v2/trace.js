import { senderKey, senderName } from './sender.js';
// Pure helpers for the session transcript (Trace README): TraceEvent[] (data-model §2.1, transcript order) →
// the tree (turns with their tool calls) and the waterfall rows. Presentational grouping only; no data is derived.

/**
 * buildTree(events) → nodes, in order:
 *   { type: 'human',  event }                          a user message
 *   { type: 'system', event }                          a system note
 *   { type: 'agent',  event | null, thinking: [], notes: [], tools: [] }
 *     one per assistant message: the thinking just before it, then its tool calls and observations until the next message.
 *     event is null when tools or thinking arrive without an assistant message (e.g. a live turn in progress).
 */
export function buildTree(events) {
  const nodes = [];
  let pending = [];   // thinking waiting for its assistant message
  const lastAgent = () => { const n = nodes[nodes.length - 1]; return n && n.type === 'agent' ? n : null; };
  const openAgent = () => { const n = { type: 'agent', event: null, thinking: pending, notes: [], tools: [] }; pending = []; nodes.push(n); return n; };
  for (const e of events || []) {
    switch (e && e.kind) {
      case 'user': {
        if (pending.length) openAgent();
        const previous = nodes.at(-1), key = senderKey(e);
        if (previous?.type === 'human' && key && key === senderKey(previous.event)) previous.events.push(e);
        else nodes.push({ type: 'human', event: e, events: [e] });
        break;
      }
      case 'system': nodes.push({ type: 'system', event: e }); break;
      case 'thinking': pending.push(e); break;
      case 'assistant': { const n = { type: 'agent', event: e, thinking: pending, notes: [], tools: [] }; pending = []; nodes.push(n); break; }
      case 'tool': (lastAgent() && !pending.length ? lastAgent() : openAgent()).tools.push(e); break;
      case 'observation': (lastAgent() || openAgent()).notes.push(e); break;
      default: break;
    }
  }
  if (pending.length) openAgent();
  return nodes;
}

const LABEL = { user: 'Message', assistant: 'Réponse', thinking: 'Réflexion', observation: 'Observation', system: 'Système' };

/**
 * waterfall(events) → { t0, t1, totalMs, rows: [{ key, label, kind: 'human'|'agent'|'tool'|'error', start, len, durMs }] }
 * start/len are percentages of [t0, t1]. A tool lasts its durationMs; any other event lasts until the next one.
 * Timestamps can step backwards in a transcript, so each start is clamped to t0 and lengths to ≥ 0.
 */
export function waterfall(events) {
  const list = (events || []).filter((e) => e && Number.isFinite(e.at));
  if (!list.length) return { t0: null, t1: null, totalMs: 0, rows: [] };
  const ends = list.map((e, i) => {
    if (e.kind === 'tool' && Number.isFinite(e.durationMs)) return e.at + e.durationMs;
    const next = list[i + 1];
    return next ? Math.max(e.at, next.at) : e.at;
  });
  const t0 = Math.min(...list.map((e) => e.at));
  const t1 = Math.max(t0 + 1, ...ends);
  const span = t1 - t0;
  const rows = list.map((e, i) => {
    const durMs = Math.max(0, ends[i] - e.at);
    const kind = e.kind === 'user' ? 'human' : e.kind === 'tool' ? (e.isError ? 'error' : 'tool')
      : e.kind === 'assistant' && e.stopReason === 'error' ? 'error' : 'agent';
    const label = e.kind === 'tool' ? e.name : e.kind === 'user' ? senderName(e, LABEL.user) : LABEL[e.kind] || e.kind;
    return { event: e, key: e.id || `${i}:${e.kind}:${e.at}`, label, kind, toolKind: e.kind === 'tool' ? e.toolKind : null,
      start: ((e.at - t0) / span) * 100, len: (durMs / span) * 100, durMs: e.kind === 'tool' ? e.durationMs ?? null : durMs };
  });
  return { t0, t1, totalMs: span, rows };
}
