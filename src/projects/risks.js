'use strict';

const { RISK_SEVERITY, STALE_AFTER_DAYS } = require('./constants');

const DAY_MS = 24 * 60 * 60 * 1000;

function isFailing(item) {
  if (!item || !Number.isInteger(item.at)) return false;
  if (item.health === 'ok' || item.health === 'never-run') return false;
  if (item.health === 'failing') return true;
  return item.status === 'failed';
}

function jobKey(item) {
  if (item.jobId != null && String(item.jobId) !== '') return `job:${item.jobId}`;
  if (item.runId != null && String(item.runId) !== '') return `run:${item.runId}`;
  return `at:${item.at}`;
}

/** Latest run of each job. A newer success drops that job’s older failure. */
function latestPerJob(items) {
  const byJob = new Map();
  for (const item of items || []) {
    if (!item || !Number.isInteger(item.at)) continue;
    const id = jobKey(item);
    const prev = byJob.get(id);
    if (!prev || item.at >= prev.at) byJob.set(id, item);
  }
  return [...byJob.values()];
}

function newestFailure(items) {
  let best = null;
  for (const item of latestPerJob(items)) {
    if (!isFailing(item)) continue;
    if (!best || item.at > best.at) best = item;
  }
  return best;
}

function evidenceOf(kind, ref, at) {
  return { kind, ref: String(ref), at };
}

/**
 * Pure risk monitor. `blocked` is manual and never raised or cleared here.
 * An auto risk clears when its latest signal for that job is gone. A newer
 * piece of evidence after an ack un-acks an automatic flag. A manual-origin
 * flag is never raised over, refreshed, or un-acked.
 *
 * @param {object} input
 * @param {number} input.now
 * @param {number} input.lastActivityAt
 * @param {{jobId?: string, runId?: string, status?: string, health?: string, at?: number}[]} [input.flows]
 * @param {{jobId?: string, runId?: string, status?: string, health?: string, at?: number}[]} [input.crons]
 * @param {{state?: string, at?: number|null, url?: string|null}|null} [input.ci]
 * @param {number} [input.staleDays]
 * @param {object[]} [input.current] stored risk flags
 */
function evaluateRisks(input) {
  const now = input.now;
  const staleDays = input.staleDays ?? STALE_AFTER_DAYS;
  const current = new Map((input.current || []).filter((f) => f.kind === 'risk').map((f) => [f.key, f]));
  const desired = new Map();

  const flow = newestFailure(input.flows);
  if (flow) {
    desired.set('flow-failing', {
      severity: RISK_SEVERITY['flow-failing'],
      evidence: evidenceOf('cron-run', flow.runId || flow.jobId, flow.at),
    });
  }
  const cron = newestFailure(input.crons);
  if (cron) {
    desired.set('cron-failing', {
      severity: RISK_SEVERITY['cron-failing'],
      evidence: evidenceOf('cron-run', cron.runId || cron.jobId, cron.at),
    });
  }
  if (input.ci && input.ci.state === 'failing' && Number.isInteger(input.ci.at)) {
    desired.set('ci-red', {
      severity: RISK_SEVERITY['ci-red'],
      evidence: evidenceOf('ci', input.ci.url || 'ci', input.ci.at),
    });
  }
  const idleFor = now - input.lastActivityAt;
  if (Number.isInteger(input.lastActivityAt) && idleFor >= staleDays * DAY_MS) {
    desired.set('stale', {
      severity: RISK_SEVERITY.stale,
      staleDays,
      evidence: evidenceOf('inactivity', input.lastActivityAt, input.lastActivityAt),
    });
  }

  const raise = [];
  const clear = [];
  const refresh = [];

  for (const [key, want] of desired) {
    const flag = current.get(key);
    if (flag && flag.origin === 'manual') continue;
    const active = flag && flag.clearedAt == null;
    if (!active) {
      raise.push({
        key,
        severity: want.severity,
        origin: 'auto',
        evidence: want.evidence,
        staleDays: want.staleDays ?? null,
      });
      continue;
    }
    const evidenceChanged = JSON.stringify(flag.evidence) !== JSON.stringify(want.evidence);
    const unack = Boolean(flag.ack) && evidenceChanged && want.evidence.at > flag.ack.at;
    if (evidenceChanged || unack) refresh.push({ key, evidence: want.evidence, unack, staleDays: want.staleDays ?? null });
  }

  for (const [key, flag] of current) {
    if (key === 'blocked') continue;
    if (flag.origin === 'manual') continue;
    if (flag.clearedAt != null) continue;
    if (!desired.has(key)) clear.push(key);
  }

  return { raise, clear, refresh };
}

module.exports = { evaluateRisks, isFailing, DAY_MS };
