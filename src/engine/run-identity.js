'use strict';

// A runtime may omit a run id on one observation and include it on another.
// Match conservatively so a representation change does not look like a new run.
function sameRun(left, right) {
  const a = left?.run || left || {}, b = right?.run || right || {};
  const aId = a.lastRunId, bId = b.lastRunId;
  if (aId && bId) return aId === bId;
  const aStart = a.startedAt, bStart = b.startedAt;
  if (Number.isInteger(aStart) && Number.isInteger(bStart)) return aStart === bStart;
  return true; // missing identity evidence cannot prove a new run
}

function runIdentityOf(session) {
  const run = session?.run || session || {};
  return { lastRunId: run.lastRunId || null, startedAt: Number.isInteger(run.startedAt) ? run.startedAt : null };
}

function resolveRunIdentity(previous, observation) {
  const known = previous ? runIdentityOf(previous) : null;
  const observed = runIdentityOf(observation);
  if (!known || !sameRun(known, observed)) return { same: false, identity: observed };
  return {
    same: true,
    // Keep stronger known evidence through an observation that omits it, so a later
    // distinct ID can still be recognized as a new run after that gap.
    identity: {
      lastRunId: known.lastRunId || observed.lastRunId,
      startedAt: known.startedAt ?? observed.startedAt,
    },
  };
}

module.exports = { sameRun, runIdentityOf, resolveRunIdentity };
