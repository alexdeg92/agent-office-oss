'use strict';

const { validation } = require('./errors');
const { OWNER_ACTOR_SHORT } = require('./constants');

/**
 * Command actor. `owner` resolves to the configured owner Person, `{ kind: 'agent', agentId }` is an agent Person
 * (the primary comes from the engine resolver), `system` is a component. History stores an ActorRef
 * with `personId` (data-model.md). The command shorthand `'timmy'` is refused. A stored `'timmy'`
 * is mapped on read by `mapLegacyActors` and is not rewritten.
 */
function resolveActor(actor, { ownerPersonId, component, persons = [] } = {}) {
  if (actor && typeof actor === 'object' && actor.kind === 'agent' && actor.agentId && !actor.personId) {
    const person = persons.find((item) => item && item.kind === 'agent' && item.links && item.links.agentId === actor.agentId && !item.links.subagentId);
    if (!person) throw validation('error.project.agent-unknown', 'actor', 'agent-unknown');
    return { kind: 'agent', personId: person.id };
  }
  if (actor === 'timmy') throw validation('error.project.actor-invalid', 'actor', 'actor-invalid');
  if (OWNER_ACTOR_SHORT.includes(actor)) {
    if (!ownerPersonId) throw validation('Aucune personne propriétaire.', 'actor');
    return { kind: 'human', personId: ownerPersonId };
  }
  if (actor === 'system') {
    return { kind: 'system', component: component || 'risk-monitor' };
  }
  if (actor && typeof actor === 'object') return actor;
  throw validation('Acteur invalide.', 'actor');
}

const LEGACY_ACTOR_KEYS = new Set(['actor', 'addedBy', 'author', 'by']);

function mapLegacyActors(value, personId) {
  if (Array.isArray(value)) return value.map((item) => mapLegacyActors(item, personId));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_ACTOR_KEYS.has(key) && child === 'timmy' && personId) out[key] = { kind: 'agent', personId };
    else out[key] = mapLegacyActors(child, personId);
  }
  return out;
}

function actorKey(actor) {
  if (!actor) return '';
  if (actor.kind === 'system') return `system:${actor.component}`;
  return `${actor.kind}:${actor.personId}`;
}

module.exports = { resolveActor, actorKey, mapLegacyActors };
