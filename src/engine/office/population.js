'use strict';

// Population facts are derived from the same authorized occupant collection
// that is rendered in the office. Runtime-only facts (runs, tokens, host load)
// remain owned by their provider projections.
function countOfficePopulation(occupants) {
  const rows = Array.isArray(occupants) ? occupants : [];
  // Conversation occupants may temporarily be rendered as visiting people.
  // They belong to the office roster, but are not agents for agent KPIs.
  const agents = rows.filter(row => !row?.visitPhase);
  return {
    onStage: agents.length,
    active: agents.filter(row => row?.state !== 'idle' && row?.state !== 'offline').length,
    subagents: agents.filter(row => row?.role === 'subagent').length,
  };
}

module.exports = { countOfficePopulation };
