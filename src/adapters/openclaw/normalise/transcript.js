'use strict';
/*
 * sessions.get messages → Transcript (data-model.md §2.1). Same pairing and clipping rules as the v1
 * buildTrace(), extended with the part types seen live: system messages, thinking, observation;
 * openai_responses_terminal / agent parts are metadata and are not shown.
 */
const TOOL_KIND = [[/web_search|search/, 'search'], [/fetch|web/, 'web'], [/browser/, 'browser'], [/exec|bash|shell/, 'exec'],
  [/read|file/, 'file-read'], [/write|edit/, 'file-write'], [/memory/, 'memory'], [/discord|message/, 'message'], [/image/, 'image']];
const toolKind = (n) => { n = String(n || '').toLowerCase(); for (const [re, k] of TOOL_KIND) if (re.test(n)) return k; return 'other'; };
const { resolveSender, stripEnvelope, delegatedSender } = require('../sender');
const { participantsOf, nameOf } = require('../../../engine/model/sender');
const STOP = new Set(['stop', 'toolUse', 'error']);

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false }; }
function textOf(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).filter((x) => typeof x === 'string' && x).join('\n');
  if (typeof c === 'object') return typeof c.text === 'string' ? c.text : typeof c.content === 'string' ? c.content : '';
  return String(c);
}

// R6-10: known metadata parts are deliberately ignored (data-model §2.1); any other unknown part type or
// role raises enum.unmapped (path only, never the value), so new content can't vanish silently.
const METADATA_PARTS = new Set(['openai_responses_terminal', 'agent']);
const ROLES = new Set(['system', 'user', 'assistant', 'toolResult', 'tool']);
const jsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
// Pair successful spawn results with their own call before windowing/clipping. Labels never come
// from a different call or from prose that merely mentions a spawn.
function delegatedLabelsOf(messages) {
  const calls = new Map(), labels = new Map();
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) {
    if (!p || !['toolCall', 'tool_use', 'toolUse'].includes(p.type) || (p.name || p.toolName) !== 'sessions_spawn') continue;
    const id = p.toolCallId || p.id || p.toolUseId || p.tool_use_id;
    const args = jsonObject(p.input || p.args || p.arguments || p.parameters || p.params);
    if (id) calls.set(id, nameOf(args?.label, args?.taskName, args?.task));
  }
  for (const m of messages) if (['toolResult', 'tool'].includes(m.role) && !m.isError) {
    const first = Array.isArray(m.content) ? m.content[0] : null;
    const id = m.toolCallId || first?.toolCallId || first?.toolUseId || first?.id;
    if (!calls.has(id)) continue;
    const result = jsonObject(m.details) || jsonObject(textOf(m.content));
    const key = result?.childSessionKey;
    if (typeof key === 'string' && key.trim() && !['error', 'forbidden', 'rejected'].includes(result.status)) labels.set(key, calls.get(id) || labels.get(key) || null);
  }
  return labels;
}
const RESULT_BLOCK = /Child task[^:\n]*:\s*<prompt-data>([\s\S]*?)<\/prompt-data>\s*status:\s*([^\s<]+)\s*Child result[^:\n]*:\s*<prompt-data>([\s\S]*?)<\/prompt-data>/gi;
function resultStatus(value, failed = false) {
  if (failed) return 'failed';
  const status = String(value || '').trim().toLowerCase();
  if (['ok', 'complete', 'completed', 'success', 'succeeded', 'done'].includes(status)) return 'completed';
  if (['failed', 'failure', 'error', 'rejected'].includes(status)) return 'failed';
  if (['running', 'working', 'in_progress'].includes(status)) return 'running';
  return 'unknown';
}
function childForLabel(label, context, sourceKey = null) {
  const isChild = key => {
    const session = key && context.sessionOf?.(key);
    return !!key && (session?.class?.kind === 'subagent' || context.delegatedLabels?.has(key));
  };
  if (isChild(sourceKey)) return sourceKey;
  const matches = [...(context.delegatedLabels || [])].filter(([key, value]) => isChild(key)
    && (key === label || value === label)).map(([key]) => key);
  return matches.length === 1 ? matches[0] : null;
}
// Only adapter-confirmed internal provenance is eligible. A user who types the
// same marker text remains a human message. Results are split before the event
// enters the runtime-neutral model, so core and clients see no native envelope.
function delegatedResults(message, { at, sessionKey, messageIndex, eventId, context }) {
  const provenance = message?.provenance;
  if (!provenance || !['inter_session', 'internal_system', 'system'].includes(provenance.kind)) return null;
  const sourceKey = typeof provenance.sourceSessionKey === 'string' ? provenance.sourceSessionKey : null;
  const isCurrentChild = context.session?.class?.kind === 'subagent';
  const raw = textOf(message.content);
  const batch = [];
  if (/^\s*\[Subagent Context\]/i.test(raw) && /Child completion results:/i.test(raw)) {
    RESULT_BLOCK.lastIndex = 0;
    let match;
    while ((match = RESULT_BLOCK.exec(raw))) batch.push({ label: nameOf(match[1]), nativeStatus: match[2], body: match[3].trim() });
  }
  if (batch.length) {
    return batch.map((row, index) => {
      const childKey = childForLabel(row.label, context, batch.length === 1 ? sourceKey : null);
      const senderInfo = childKey ? delegatedSender(childKey, context) : {
        kind: 'agent', id: `agent:unresolved-delegate:${eventId(messageIndex, index)}`, name: row.label, runtime: context.runtime || 'generic',
        channel: context.session?.class?.channel || null, avatarHint: null,
      };
      const body = clip(row.body, 8000);
      return { id: eventId(messageIndex, index), kind: 'subagent-result', at, senderInfo,
        title: (row.label || senderInfo.delegation?.label || null)?.slice(0, 120), status: resultStatus(row.nativeStatus, message.isError === true),
        body: body.text, text: body.text, truncated: body.truncated };
    });
  }
  // A single ordinary inter-session completion is still an agent result. Do not
  // reinterpret prompt/context sent into a child's own transcript as a result.
  const childKey = provenance.kind === 'inter_session' && !isCurrentChild
    ? childForLabel(sourceKey, context, sourceKey) : null;
  if (!childKey) return null;
  const body = clip(raw.replace(/^\s*\[Subagent Context\][^\n]*(?:\n|$)/i, '').trim(), 8000);
  const senderInfo = delegatedSender(childKey, context);
  return [{ id: eventId(messageIndex, 0), kind: 'subagent-result', at, senderInfo,
    title: nameOf(context.delegatedLabels?.get(childKey), senderInfo.name)?.slice(0, 120) || null, status: resultStatus(null, message.isError === true),
    body: body.text, text: body.text, truncated: body.truncated }];
}
// Seen in captures, content not rendered yet (data-model §2.1): known, deliberately skipped, not drift.
const METADATA_ROLES = new Set(['custom', 'operator']);

function normaliseTranscript(sessionKey, v, fetchedAt, window = 120, issue = () => {}, context = {}) {
  const ctx = { ...context, sessionKey, delegatedLabels: delegatedLabelsOf(v.messages) };
  const all = v.messages, msgs = all.slice(-window);
  const results = {};
  for (const m of msgs) {
    if (m.role !== 'toolResult' && m.role !== 'tool') continue;
    const first = Array.isArray(m.content) ? m.content[0] : null;
    const id = m.toolCallId || (first && (first.toolCallId || first.toolUseId || first.id));
    if (id) results[id] = { isError: !!m.isError, at: m.timestamp || 0, output: textOf(m.content) };
  }
  const events = [];
  const base = all.length - msgs.length;
  // S7b (api.md 2.1 TraceEventVM.id): 'ev:<absolute message index>:<part index>', stable across fetches and windows
  const evId = (mi, pi) => 'ev:' + (base + mi) + ':' + pi;
  msgs.forEach((m, mi) => {
    const at = m.timestamp || 0;
    const childResults = delegatedResults(m, { at, sessionKey, messageIndex: mi, eventId: evId, context: ctx });
    if (childResults) { events.push(...childResults); return; }
    if (m.role === 'system') { const c = clip(textOf(m.content), 8000); events.push({ id: evId(mi, 0), kind: 'system', at, text: c.text, truncated: c.truncated }); return; }
    if (m.role === 'user') { const rawText = textOf(m.content);
      const senderInfo = resolveSender(m, { ...ctx, text: rawText });
      const c = clip(stripEnvelope(rawText), 8000); events.push({ id: evId(mi, 0), kind: senderInfo.kind === 'system' ? 'system' : 'user', at, ...(senderInfo.kind === 'system' ? {} : { sender: senderInfo.name }), senderInfo, text: c.text, truncated: c.truncated }); return; }
    if (METADATA_ROLES.has(m.role)) return;
    if (!ROLES.has(m.role)) { issue('enum.unmapped', 'warn', '$.messages[].role', 'value not in the table'); return; }
    if (m.role !== 'assistant') return;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }];
    const texts = [], extra = [];
    let textPart = null;
    parts.forEach((p, pi) => {
      if (!p) return;
      if (typeof p === 'string') { texts.push(p); if (textPart == null) textPart = pi; return; }
      if (p.type === 'text') { texts.push(p.text || ''); if (textPart == null) textPart = pi; return; }
      if (p.type === 'thinking') { const c = clip(p.thinking || p.text || '', 8000); extra.push({ id: evId(mi, pi), kind: 'thinking', at, text: c.text, truncated: c.truncated }); return; }
      if (p.type === 'observation') { const c = clip(p.text || textOf(p.content), 8000); extra.push({ id: evId(mi, pi), kind: 'observation', at, text: c.text, truncated: c.truncated }); return; }
      if (p.type === 'toolCall' || p.type === 'tool_use' || p.type === 'toolUse') {
        const id = p.toolCallId || p.id || p.toolUseId || p.tool_use_id || null;
        const input = p.input || p.args || p.arguments || p.parameters || p.params || null;
        const res = results[id] || {};
        const ci = clip(input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2), 4000);
        const co = clip(res.output || '', 6000);
        const name = p.name || p.toolName || 'outil';
        extra.push({ id: evId(mi, pi), kind: 'tool', at, callId: id, name, toolKind: toolKind(name), input: ci.text, output: co.text, isError: !!res.isError,
          durationMs: res.at && at ? Math.max(0, res.at - at) : null, truncated: ci.truncated || co.truncated });
        return;
      }
      if (!METADATA_PARTS.has(p.type)) issue('enum.unmapped', 'warn', '$.messages[].content[].type', 'value not in the table');
    });
    const txt = clip(texts.join('\n').trim(), 8000);
    if (txt.text || m.stopReason === 'error') {
      events.push({ id: evId(mi, textPart == null ? parts.length : textPart), kind: 'assistant', at, model: m.model || null, provider: m.provider || null,
        outputTokens: (m.usage && (m.usage.output_tokens || m.usage.output)) || null, text: txt.text, truncated: txt.truncated,
        stopReason: m.stopReason == null ? null : STOP.has(m.stopReason) ? m.stopReason : 'unrecognized', error: m.errorMessage || null });
    }
    events.push(...extra);
  });
  for (const event of events) if (!event.senderInfo) event.senderInfo = resolveSender({ role: event.kind === 'tool' ? 'tool' : event.kind === 'system' ? 'system' : 'assistant', name: event.name }, ctx);
  return { participants: participantsOf([
    ...all.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ senderInfo: resolveSender(m, { ...ctx, text: textOf(m.content) }) })),
    ...[...ctx.delegatedLabels.keys()].map((key) => ({ senderInfo: delegatedSender(key, { ...ctx, channel: ctx.session?.class.channel || null }) })),
  ]), sessionKey, fetchedAt, messageCount: all.length, window: { from: all.length - msgs.length, to: all.length }, events };
}

module.exports = { normaliseTranscript, toolKind };
