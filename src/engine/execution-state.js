'use strict';

// Project confidence independently of transport health. Older canonical adapters are
// interpreted conservatively while they adopt the explicit evidence fields.
function executionState(run, now = Date.now()) {
  if (!run) return { status: 'unknown', level: 'unknown', observedAt: null, expiresAt: null };
  let level = run.evidenceLevel;
  if (!level) level = run.evidence === 'status-field' || run.evidence === 'gateway-flag' ? 'verified'
    : run.evidence === 'start-without-end' || run.evidence === 'live-activity' ? 'observed' : 'unknown';
  let status = level === 'unknown' ? 'unknown' : run.status || 'unknown';
  if (level === 'observed' && Number.isInteger(run.expiresAt) && run.expiresAt <= now) { status = 'unknown'; level = 'unknown'; }
  return { status, level, observedAt: Number.isInteger(run.observedAt) ? run.observedAt : null,
    expiresAt: Number.isInteger(run.expiresAt) ? run.expiresAt : null };
}

module.exports = { executionState };
