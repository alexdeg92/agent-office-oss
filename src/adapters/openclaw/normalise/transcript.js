'use strict';
/*
 * sessions.get messages → Transcript (data-model.md §2.1). Same pairing and clipping rules as the v1
 * buildTrace(), extended with the part types seen live: system messages, thinking, observation;
 * openai_responses_terminal / agent parts are metadata and are not shown.
 */
const TOOL_KIND = [[/web_search|search/, 'search'], [/fetch|web/, 'web'], [/browser/, 'browser'], [/exec|bash|shell/, 'exec'],
  [/read|file/, 'file-read'], [/write|edit/, 'file-write'], [/memory/, 'memory'], [/discord|message/, 'message'], [/image/, 'image']];
const toolKind = (n) => { n = String(n || '').toLowerCase(); for (const [re, k] of TOOL_KIND) if (re.test(n)) return k; return 'other'; };
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
// Seen in captures, content not rendered yet (data-model §2.1): known, deliberately skipped, not drift.
const METADATA_ROLES = new Set(['custom', 'operator']);

function normaliseTranscript(sessionKey, v, fetchedAt, window = 120, issue = () => {}) {
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
    if (m.role === 'system') { const c = clip(textOf(m.content), 8000); events.push({ id: evId(mi, 0), kind: 'system', at, text: c.text, truncated: c.truncated }); return; }
    if (m.role === 'user') { const c = clip(textOf(m.content), 8000); events.push({ id: evId(mi, 0), kind: 'user', at, sender: m.senderName || m.senderLabel || null, text: c.text, truncated: c.truncated }); return; }
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
  return { sessionKey, fetchedAt, messageCount: all.length, window: { from: all.length - msgs.length, to: all.length }, events };
}

module.exports = { normaliseTranscript, toolKind };
