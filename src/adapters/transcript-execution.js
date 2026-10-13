'use strict';

// Canonical run evidence shared by transcript-backed adapters. An unfinished
// turn is working only while its last transcript event is recent; after that
// the current file snapshot proves no fresh work is happening. Explicit
// completion stays idle regardless of age.
const RECENCY_MS = 30_000;
const DETAIL_RECENCY_MS = 10_000;
const WAITING_RECENCY_MS = 15 * 60_000;

// Adapters pass only an already-recognized event class and, for tool calls, its
// bounded tool name. Never copy arguments, paths, prompts or tool output into
// this result. The vocabulary is canonical and independent of a runtime.
const TOOL_KIND = new Map([
  ['read', 'researching'], ['grep', 'researching'], ['glob', 'researching'], ['search', 'researching'],
  ['websearch', 'researching'], ['web_search', 'researching'], ['webfetch', 'researching'], ['web_fetch', 'researching'],
  ['edit', 'writing'], ['write', 'writing'], ['notebookedit', 'writing'], ['apply_patch', 'writing'],
  ['bash', 'executing'], ['exec', 'executing'], ['exec_command', 'executing'], ['command', 'executing'],
  ['test', 'executing'], ['terminal', 'executing'],
]);
const ACTIVITY_KINDS = new Set(['thinking', 'researching', 'writing', 'executing', 'calling', 'waiting', 'blocked', 'working']);
function toolActivity(name) {
  if (typeof name !== 'string' || name.length > 128) return 'calling';
  return TOOL_KIND.get(name.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase()) || 'calling';
}
function transcriptActivity(kind, at, now = Date.now()) {
  const lease = kind === 'waiting' ? WAITING_RECENCY_MS : DETAIL_RECENCY_MS;
  if (!ACTIVITY_KINDS.has(kind) || !Number.isSafeInteger(at) || at < 0 || at > now || now - at >= lease) return null;
  return { kind, since: at, expiresAt: at + lease };
}

// Inspect only the final assistant wording to derive a boolean state signal;
// the text itself is never returned in activity or execution evidence.
function awaitingReplyText(value) {
  if (typeof value !== 'string' || value.length > 32768) return false;
  const text = value.trim();
  return /[?？]\s*["'’”)]*$/u.test(text)
    || /\b(?:await(?:ing)? (?:your|a|the) (?:reply|response|answer)|waiting for (?:your|a) (?:reply|response|answer)|let me know|please (?:reply|respond|confirm))\b/i.test(text)
    || /(?:en attente de votre réponse|dites[- ]moi|merci de répondre)/i.test(text);
}

// A bounded tail read must give every represented agent a chance before it
// spends the remaining budget on extra sessions from already-covered agents.
function chooseTailsByAgent(rows, limit) {
  const chosen = [], keys = new Set(), agents = new Set();
  for (const row of rows) {
    const agent = row.agentId || row.key;
    if (!agents.has(agent)) { agents.add(agent); keys.add(row.key); chosen.push(row); }
    if (chosen.length >= limit) return chosen;
  }
  for (const row of rows) if (!keys.has(row.key)) {
    keys.add(row.key); chosen.push(row);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

function runFromTranscript(observation, now = Date.now()) {
  const at = Number.isSafeInteger(observation?.at) && observation.at >= 0 ? observation.at : null;
  const status = observation?.status;
  if (!['running', 'idle'].includes(status) || at == null) return unknownRun();
  const fresh = at <= now && now - at < RECENCY_MS;
  if (status === 'running' && !fresh) return unknownRun();
  return {
    status, endReason: null, evidence: 'live-activity', evidenceLevel: 'observed',
    observedAt: at, expiresAt: status === 'running' ? at + RECENCY_MS : null, startedAt: status === 'running' ? at : null, endedAt: null,
    hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null,
  };
}

function unknownRun() {
  return { status: 'unknown', endReason: null, evidence: 'none', evidenceLevel: 'unknown', observedAt: null, expiresAt: null,
    startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null };
}

module.exports = { RECENCY_MS, DETAIL_RECENCY_MS, WAITING_RECENCY_MS, ACTIVITY_KINDS, toolActivity, transcriptActivity,
  awaitingReplyText, runFromTranscript, unknownRun, chooseTailsByAgent };
