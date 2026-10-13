'use strict';

// Server-only lineage carried between the team projection and placement. Symbol
// metadata survives object spreads in the OfficeVM pipeline but is ignored by
// JSON serialization and every public schema.
const TEAM_MEMBER_ID = Symbol('office-placement.team-member-id');
const TEAM_MEMBER_ALIASES = Symbol('office-placement.team-member-aliases');

function tagTeamMember(row, memberId, aliases = []) {
  if (row && typeof memberId === 'string' && memberId) {
    Object.defineProperty(row, TEAM_MEMBER_ID, { value: memberId, enumerable: true, configurable: true });
    const prior = row[TEAM_MEMBER_ALIASES] || [];
    Object.defineProperty(row, TEAM_MEMBER_ALIASES, { value: [...new Set([...prior, ...aliases].filter(value => typeof value === 'string' && value))],
      enumerable: true, configurable: true });
  }
  return row;
}

function teamMemberId(row) { return row?.[TEAM_MEMBER_ID] || null; }
function teamMemberAliases(row) { return row?.[TEAM_MEMBER_ALIASES] || []; }

module.exports = { tagTeamMember, teamMemberId, teamMemberAliases };
