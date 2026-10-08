'use strict';
// Discord's channel grammar (ADR-001 §14.1): bare snowflakes only; a DM's partner is a user, a guild text channel
// (scope 'channel') is a room named 'discord-channel:' (its 2.x id); threads, slash commands and groups have none.
const SNOWFLAKE = /^\d{17,20}$/;
module.exports = {
  family: 'discord',
  interlocutorIdOf: ({ kind, scope, peer }) => {
    if (!SNOWFLAKE.test(String(peer))) return null;
    if (kind === 'conversation-direct') return 'discord-user:' + peer;
    return scope === 'channel' ? 'discord-channel:' + peer : null;
  },
};
