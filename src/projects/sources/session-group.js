'use strict';

const { parseSessionGroupRef } = require('./refs');

function matchSessions(ref, sessions) {
  const parsed = parseSessionGroupRef(ref);
  const list = Array.isArray(sessions) ? sessions : [];
  if (parsed.by === 'group') {
    return list.filter((s) => s && s.group === parsed.groupId);
  }
  if (parsed.by === 'interlocutor') {
    return list.filter((s) => s && s.class && s.class.interlocutorId === parsed.interlocutorId);
  }
  const keys = new Set(parsed.sessionKeys);
  return list.filter((s) => s && keys.has(s.key));
}

/**
 * Session groups have no I/O. The input is canonical sessions (or the subset
 * the engine already matched to a group).
 */
function createSessionGroupSource() {
  return {
    kind: 'sessionGroup',
    parseRef(input) {
      const ref = parseSessionGroupRef(input && (input.ref || input));
      return { kind: 'sessionGroup', ref };
    },
    fetch(ref, ctx = {}) {
      const matched = matchSessions(ref, ctx.sessions);
      return {
        ref: parseSessionGroupRef(ref),
        sessionCount: matched.length,
        sessions: matched.map((s) => ({
          key: s.key,
          updatedAt: s.updatedAt ?? null,
          class: {
            kind: s.class && s.class.kind || null,
            agentId: s.class && s.class.agentId || null,
            subagentId: s.class && s.class.subagentId || null,
            interlocutorId: s.class && s.class.interlocutorId || null,
          },
          usage: s.usage ? { total: s.usage.total ?? 0 } : null,
        })),
      };
    },
  };
}

function createManualSource() {
  return {
    kind: 'manual',
    parseRef() {
      return { kind: 'manual', ref: null };
    },
    fetch() {
      return { kind: 'manual', ref: null };
    },
  };
}

module.exports = { createSessionGroupSource, createManualSource, matchSessions };
