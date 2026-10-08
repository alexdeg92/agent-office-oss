'use strict';
// Sessions → Interlocutors (data-model.md §8). Stats are always derived, never stored.
// Heartbeat variants are background wake-ups, not conversations: they don't count.
function deriveInterlocutors(sessions) {
  const by = new Map();
  for (const s of sessions) {
    const id = s.class.interlocutorId;
    if (!id || s.class.heartbeatOf) continue;
    let i = by.get(id);
    if (!i) {
      // G3b: any family. kind = '<family>-user' | '<family>-room' ('discord-channel' kept for Discord, §12.5); `snowflake`
      // is the opaque id after the first ':' (a Discord snowflake for Discord)
      const cut = id.indexOf(':');
      i = { id, kind: id.slice(0, cut), family: id.slice(0, id.lastIndexOf('-', cut)), snowflake: id.slice(cut + 1),
        stats: { sessionCount: 0, totalTokens: 0, firstSeenAt: null, lastSeenAt: null }, primarySessionKey: null, sessionKeys: [] };
      by.set(id, i);
    }
    i.stats.sessionCount++; i.stats.totalTokens += s.usage.total; i.sessionKeys.push(s.key);
    const at = s.updatedAt;
    if (at && (i.stats.lastSeenAt == null || at >= i.stats.lastSeenAt)) { i.stats.lastSeenAt = at; i.primarySessionKey = s.key; }
    if (at && (i.stats.firstSeenAt == null || at < i.stats.firstSeenAt)) i.stats.firstSeenAt = at;
    if (!i.primarySessionKey) i.primarySessionKey = s.key;
  }
  return [...by.values()].sort((a, b) => (b.stats.lastSeenAt || 0) - (a.stats.lastSeenAt || 0) || a.id.localeCompare(b.id));
}

module.exports = { deriveInterlocutors };
