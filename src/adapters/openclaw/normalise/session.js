'use strict';
// Validated raw session row → canonical Session (data-model.md §2–3).
const { classifySession } = require('../classify/session-kind');
const { RUN_STATUS } = require('../classify/enums');

const INTERACTIVE = new Set(['subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'dashboard', 'explicit']);   // G3b canonical kinds
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// RunState from the row. Live activity is time-dependent and is applied at read time, not here.
// The status is ALWAYS checked against the table (own properties only, R2-03), even when a gateway
// flag decides the state, so an unknown status is reported whatever the precedence.
// → { run, unmappedStatus? }
function runStateOf(r) {
  const base = { startedAt: r.startedAt || null, endedAt: r.endedAt || null, hasActiveSubagentRun: r.hasActiveSubagentRun === true,
    runtimeMs: Number.isInteger(r.runtimeMs) ? r.runtimeMs : null, lastRunId: r.lastRunId || null, lastError: r.lastRunError || null };
  const raw = r.status != null ? String(r.status) : undefined;
  const mapped = raw !== undefined && own(RUN_STATUS, raw) ? RUN_STATUS[raw] : undefined;
  const unmappedStatus = raw !== undefined && !mapped ? raw : undefined;
  if (r.hasActiveRun === true || r.hasActiveSubagentRun === true) return { run: Object.assign(base, { status: 'running', endReason: null, evidence: 'gateway-flag' }), unmappedStatus };
  if (mapped) return { run: Object.assign(base, { status: mapped.status, endReason: mapped.endReason, evidence: 'status-field' }) };
  if (r.startedAt && !r.endedAt) return { run: Object.assign(base, { status: 'running', endReason: null, evidence: 'start-without-end' }), unmappedStatus };
  return { run: Object.assign(base, { status: 'idle', endReason: null, evidence: 'none' }), unmappedStatus };
}

// 2.1 (PM): the session's working directory: raw workspaceDir, else spawnedCwd. Normalised: absolute POSIX paths
// only, dot segments resolved, no trailing '/', no control characters; anything else is null.
function cwdOf(r) {
  const raw = typeof r.workspaceDir === 'string' && r.workspaceDir.trim() ? r.workspaceDir : typeof r.spawnedCwd === 'string' ? r.spawnedCwd : null;
  if (raw == null) return null;
  const t = raw.trim();
  if (!t.startsWith('/') || /[\u0000-\u001f\u007f]/.test(t)) return null;
  const n = require('path').posix.normalize(t);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

// a short display text (trimmed, at most 200 code points), else null
function textOf(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? [...t].slice(0, 200).join('') : null;
}
function goalOf(g) {
  if (!g || typeof g !== 'object' || typeof g.objective !== 'string') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return { objective: g.objective, status: typeof g.status === 'string' ? g.status : 'unknown', tokensUsed: n(g.tokensUsed), tokenBudget: n(g.tokenBudget) };
}

/**
 * @param r raw row (list, or list merged with a description)
 * @param [opts.baseRow] raw row of the base session when r is a heartbeat variant (R2-04)
 */
function normaliseSession(r, opts = {}) {
  const cls = classifySession(r.key, r, { baseRow: opts.baseRow });
  const { run, unmappedStatus } = runStateOf(r);
  const session = {
    key: r.key,
    sessionId: r.sessionId || null,
    class: cls,
    displayName: r.displayName || null,
    // model requires an id (R2-07); a provider without a model is kept on its own
    model: r.model ? { id: r.model, provider: r.modelProvider || null } : null,
    provider: r.modelProvider || null,
    usage: { total: r.totalTokens || 0, input: Number.isInteger(r.inputTokens) ? r.inputTokens : null, output: Number.isInteger(r.outputTokens) ? r.outputTokens : null },
    updatedAt: r.updatedAt || null,
    run,
    costUsd: typeof r.estimatedCostUsd === 'number' ? r.estimatedCostUsd : null,
    parentKey: r.parentSessionKey || r.spawnedBy || null,
    childKeys: Array.isArray(r.childSessions) ? r.childSessions.slice() : [],
    goal: goalOf(r.goal),
    cwd: cwdOf(r),
    // top-level messageCount if the gateway sends one, else the context-budget count (2026.9.8 rows carry only that)
    messageCount: Number.isInteger(r.messageCount) ? r.messageCount : r.contextBudgetStatus && Number.isInteger(r.contextBudgetStatus.messageCount) ? r.contextBudgetStatus.messageCount : null,
    interactive: INTERACTIVE.has(cls.kind) && !cls.heartbeatOf,
    group: typeof r.category === 'string' && r.category.trim() ? r.category.trim() : null,   // S7b: session-group membership
    channelName: textOf(r.groupChannel),   // architect-54: project inference ('#PIVOT-2735')
    label: textOf(r.label),
  };
  return { session, unmappedStatus };
}

module.exports = { normaliseSession, runStateOf, INTERACTIVE };
