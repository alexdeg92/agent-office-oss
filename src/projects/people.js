'use strict';

const { FLAG_SORT } = require('./constants');

function matchPerson(persons, hint) {
  if (!hint || !hint.emailHash) return null;
  return persons.find((p) => p.links && p.links.gitEmailHash === hint.emailHash) || null;
}

function discordSnowflake(interlocutorId) {
  const m = /^discord-user:(\d{17,20})$/.exec(interlocutorId || '');
  return m ? m[1] : null;
}

function personSort(a, b, persons, { primaryAgentId = 'main', locale = 'fr' } = {}) {
  const kindOrder = { human: 0, agent: 1, git: 2 };
  const pa = persons.get(a.personId);
  const pb = persons.get(b.personId);
  const ka = kindOrder[pa && pa.kind] ?? 9;
  const kb = kindOrder[pb && pb.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  const rank = (person) => (person && person.links && person.links.agentId === primaryAgentId && !person.links.subagentId ? 0 : 1);
  const aPrimary = rank(pa);
  const bPrimary = rank(pb);
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;
  return (pa && pa.name || '').localeCompare(pb && pb.name || '', locale);
}

/**
 * Derived membership plus manual overrides. A git author whose email hash
 * matches a human is that human (data-model.md §9.5).
 */
function derivePeople({
  persons = [], authors = [], sessions = [], overrides = [], liveStates = {},
  primaryAgentId = 'main', locale = 'fr',
} = {}) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const counts = new Map();
  const derived = new Set();

  for (const hint of authors) {
    const person = matchPerson(persons, hint);
    if (!person) continue;
    derived.add(person.id);
    counts.set(person.id, (counts.get(person.id) || 0) + 1);
  }

  for (const session of sessions) {
    const cls = session.class || {};
    if (cls.agentId) {
      const agent = persons.find((p) => p.kind === 'agent'
        && p.links && p.links.agentId === cls.agentId
        && (cls.subagentId ? p.links.subagentId === cls.subagentId : !p.links.subagentId));
      if (agent) derived.add(agent.id);
    }
    const snow = discordSnowflake(cls.interlocutorId);
    if (snow) {
      const human = persons.find((p) => p.links && p.links.discordUserId === snow);
      if (human) derived.add(human.id);
    }
  }

  const hidden = new Set();
  const roles = new Map();
  const manual = new Set();
  for (const ov of overrides) {
    if (!byId.has(ov.personId)) continue;
    if (ov.hidden) hidden.add(ov.personId);
    if (ov.role) roles.set(ov.personId, ov.role);
    if (ov.added) manual.add(ov.personId);
  }

  const ids = new Set([...derived, ...manual]);
  const people = [];
  for (const personId of ids) {
    if (hidden.has(personId)) continue;
    const person = byId.get(personId);
    people.push({
      personId,
      role: roles.get(personId) || null,
      origin: derived.has(personId) ? 'derived' : 'manual',
      liveState: person.kind === 'agent' ? (liveStates[personId] ?? null) : null,
      commitCount: counts.has(personId) ? counts.get(personId) : (person.kind === 'git' ? 0 : null),
    });
  }
  people.sort((a, b) => personSort(a, b, byId, { primaryAgentId, locale }));
  return people;
}

function sortFlags(flags) {
  return flags.slice().sort((a, b) => (FLAG_SORT[a.kind] - FLAG_SORT[b.kind]) || String(a.key).localeCompare(String(b.key)));
}

module.exports = { derivePeople, matchPerson, sortFlags, discordSnowflake };
