'use strict';

// Canonical run evidence shared by transcript-backed adapters. An unfinished
// turn is working only while its last transcript event is recent; after that
// the current file snapshot proves no fresh work is happening. Explicit
// completion stays idle regardless of age.
const RECENCY_MS = 30_000;

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

module.exports = { RECENCY_MS, runFromTranscript, unknownRun, chooseTailsByAgent };
