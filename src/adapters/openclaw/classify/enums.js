'use strict';
// Raw → canonical enum tables (engine.md §6.3). A miss yields 'enum.unmapped' and a fallback.

// Session run status (capture-20261005: done, complete, failed, active, killed, timeout, budget_limited).
const RUN_STATUS = {
  active: { status: 'running', endReason: null },
  running: { status: 'running', endReason: null },
  done: { status: 'succeeded', endReason: null },
  complete: { status: 'succeeded', endReason: null },
  failed: { status: 'failed', endReason: 'error' },
  timeout: { status: 'failed', endReason: 'timeout' },
  killed: { status: 'failed', endReason: 'killed' },
  budget_limited: { status: 'failed', endReason: 'budget-limited' },
};

module.exports = { RUN_STATUS };
