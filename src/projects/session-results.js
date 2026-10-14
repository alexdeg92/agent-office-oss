'use strict';
// Canonical transcript helpers. Tool outputs may wrap JSON in code-mode output/value envelopes.
const { parseId } = require('../runtime-ids');
const { senderKey } = require('../engine/model/sender');
function canonicalEventId(id) {
  const scoped = parseId(id, 'event');
  if (!scoped) return id;
  try {
    const identity = JSON.parse(scoped.local);
    // Multi-runtime event ids wrap the native session identity and event id.
    // Unwrap only this closed pair shape; never guess the index of other ids.
    return Array.isArray(identity) && identity.length === 2 && typeof identity[0] === 'string' && typeof identity[1] === 'string'
      ? identity[1] : null;
  } catch { return null; }
}
const indexOf = (e) => { const m = /^ev:(\d+):/.exec(canonicalEventId(e.id || '') || ''); return m ? Number(m[1]) : null; };
function childKeys(events) {
  const keys = new Set();
  function visit(v, depth = 0) {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') { try { visit(JSON.parse(v), depth + 1); } catch (_) { /* plain text */ } return; }
    if (typeof v !== 'object') return;
    if (typeof v.childSessionKey === 'string' && v.childSessionKey.length <= 200) keys.add(v.childSessionKey);
    for (const x of Object.values(v)) visit(x, depth + 1);
  }
  for (const e of events) if (e.kind === 'tool' && !e.isError) visit(e.output);
  return [...keys];
}
function completionResults(events) {
  const out = [], seen = new Set();
  for (const e of events) {
    if (e?.kind === 'subagent-result') {
      if (e.status && e.status !== 'completed') continue;
      const text = typeof e.body === 'string' ? e.body.trim() : typeof e.text === 'string' ? e.text.trim() : '';
      if (!text || typeof e.id !== 'string' || !e.id) continue;
      const identity = `${e.id}\u0000subagent-result\u0000${senderKey(e.senderInfo) || ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push({ id: e.id, kind: e.kind, senderInfo: e.senderInfo || null, text, at: e.at });
      continue;
    }
    if (!['user', 'system'].includes(e.kind) || !/\[Subagent Context\]/.test(e.text || '')) continue;
    const re = /Child result[^\n]*:\s*<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/g;
    let resultIndex = 0;
    for (const m of e.text.matchAll(re)) {
      const index = resultIndex++;
      if (!m[1].trim()) continue;
      const id = String(e.id || 'event') + ':' + index;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, text: m[1].trim(), at: e.at });
    }
  }
  return out;
}
function isFinal(e, events) {
  const position = indexOf(e);
  return e.kind === 'assistant' && e.text && (e.stopReason === 'stop' || e.stopReason == null) &&
    (position == null || !events.some((x) => x.kind === 'tool' && indexOf(x) === position));
}
const finalText = (t) => { const events = t?.events || []; return events.findLast((e) => isFinal(e, events))?.text || ''; };
module.exports = { indexOf, childKeys, completionResults, isFinal, finalText };
