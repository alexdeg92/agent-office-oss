'use strict';

// Population facts are derived from the same authorized occupant collection
// that is rendered in the office. Runtime-only facts (runs, tokens, host load)
// remain owned by their provider projections.
function countOfficePopulation(occupants) {
  const rows = Array.isArray(occupants) ? occupants : [];
  return {
    onStage: rows.length,
    active: rows.filter(row => row?.state !== 'idle' && row?.state !== 'offline').length,
    subagents: rows.filter(row => row?.role === 'subagent').length,
  };
}

module.exports = { countOfficePopulation };
