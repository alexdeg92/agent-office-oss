'use strict';
// Canonical transcript helpers. Tool outputs may wrap JSON in code-mode output/value envelopes.
const indexOf = (e) => { const m = /^ev:(\d+):/.exec(e.id || ''); return m ? Number(m[1]) : null; };
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
  const out = [];
  for (const e of events) {
    if (!['user', 'system'].includes(e.kind) || !/\[Subagent Context\]/.test(e.text || '')) continue;
    const re = /Child result[^\n]*:\s*<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/g;
    for (const m of e.text.matchAll(re)) if (m[1].trim()) out.push({ id: e.id + ':' + out.length, text: m[1].trim(), at: e.at });
  }
  return out;
}
function isFinal(e, events) {
  return e.kind === 'assistant' && e.text && (e.stopReason === 'stop' || e.stopReason == null) &&
    !events.some((x) => x.kind === 'tool' && indexOf(x) === indexOf(e));
}
const finalText = (t) => { const events = t?.events || []; return events.findLast((e) => isFinal(e, events))?.text || ''; };
module.exports = { indexOf, childKeys, completionResults, isFinal, finalText };
