'use strict';
/*
 * Channel grammars (ADR-001 §14.1, G7): how a channel family names its interlocutors. Static and always on, so an
 * interlocutor id is data, never config (disabling an enricher never changes an id). Adapters ask this registry; they
 * never import a channel package. A family without a grammar uses the generic one.
 */
const OPAQUE = /^[^\u0000-\u001f\u007f]{1,128}$/u;   // R26-01: code points

// generic: '<family>-user:<peer>' for a direct conversation, '<family>-room:<peer>' for a group; none for an unknown scope
const generic = (family) => ({
  family,
  interlocutorIdOf: ({ kind, peer }) => {
    if (!OPAQUE.test(String(peer))) return null;
    if (kind === 'conversation-direct') return family + '-user:' + peer;
    if (kind === 'conversation-group') return family + '-room:' + peer;
    return null;
  },
});

const GRAMMARS = { discord: () => require('./discord') };

function grammarOf(family) {
  return Object.prototype.hasOwnProperty.call(GRAMMARS, family) ? GRAMMARS[family]() : generic(family);
}
/** → the interlocutor id of a conversation on `channel`, or null */
const interlocutorIdOf = (channel, c) => (channel ? grammarOf(channel).interlocutorIdOf(c) : null);

module.exports = { interlocutorIdOf, grammarOf, CHANNEL_GRAMMARS: Object.keys(GRAMMARS) };
