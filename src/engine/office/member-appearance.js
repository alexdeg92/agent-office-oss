'use strict';

const crypto = require('node:crypto');

function choicesFor(index) {
  const characters = [...(index?.manifest?.characters || []), ...(index?.manifest?.characterPacks?.packs || [])]
    .filter(row => row && row.role !== 'main' && index.characters?.has?.(row.id))
    .slice().sort((a, b) => a.id.localeCompare(b.id));
  return characters.flatMap(character => {
    const definition = index.characters.get(character.id);
    const variants = (definition.variants || []).slice().sort((a, b) => a.id.localeCompare(b.id));
    return variants.length ? variants.map(variant => ({ character, definition, variant: variant.id }))
      : [{ character, definition, variant: null }];
  });
}

const lookKey = look => look && typeof look.character === 'string'
  ? `${look.character}/${look.variant || ''}` : null;
function preferredIndex(id, length) {
  return crypto.createHash('sha256').update(`team-member:${id}`).digest().readUInt32BE(0) % length;
}
function orderKey(id) { return crypto.createHash('sha256').update(id).digest('hex'); }
const memberOrderKey = orderKey;
function makeLook(choice) {
  const { character, definition, variant } = choice;
  const accessories = variant ? (definition.variants.find(row => row.id === variant)?.defaultAccessories || definition.defaultAccessories || [])
    : (definition.defaultAccessories || []);
  return { character: character.id, variant, accessories: [...accessories] };
}

// Allocate a whole registered-member set. Existing assignments are retained;
// this means adding/removing a member cannot reshuffle the faces already shown.
// New members are processed by a stable ID hash, probe from their preferred
// choice, and only reuse a choice once every available one is occupied.
function allocateMemberAppearances(memberIds, index, { existing = {}, reservedLooks = [], primaryLook = null } = {}) {
  const choices = choicesFor(index);
  if (!choices.length) return new Map();
  const ids = [...new Set((memberIds || []).filter(id => typeof id === 'string' && id.length > 0))]
    .sort((a, b) => orderKey(a).localeCompare(orderKey(b)) || a.localeCompare(b));
  const reserved = new Set(reservedLooks.map(lookKey).filter(Boolean));
  const primaryKey = lookKey(primaryLook);
  const chosen = new Map(), usage = new Map();
  const pending = [];
  for (const id of ids) {
    const saved = existing instanceof Map ? existing.get(id) : existing[id];
    const key = lookKey(saved);
    if (key && key !== primaryKey && choices.some(choice => `${choice.character.id}/${choice.variant || ''}` === key)
      && !reserved.has(key) && !usage.has(key)) {
      chosen.set(id, saved);
      usage.set(key, 1);
    } else pending.push(id);
  }
  const probeOrder = id => {
    const start = preferredIndex(id, choices.length);
    return Array.from({ length: choices.length }, (_, offset) => choices[(start + offset) % choices.length]);
  };
  for (const id of pending) {
    const order = probeOrder(id);
    // Avoid other occupants' looks when the team pool has room. If every
    // non-primary choice is reserved on the floor, still emit a valid look;
    // reuse is then spread evenly instead of producing a schema-invalid null.
    const nonPrimary = order.filter(choice => `${choice.character.id}/${choice.variant || ''}` !== primaryKey);
    const unreserved = nonPrimary.filter(choice => !reserved.has(`${choice.character.id}/${choice.variant || ''}`));
    // Floor reservations may be relaxed under pressure, but the actual owner
    // look is never eligible for a team member.
    const eligible = unreserved.length ? unreserved : nonPrimary;
    if (!eligible.length) continue;
    const free = eligible.find(choice => !reserved.has(`${choice.character.id}/${choice.variant || ''}`)
      && !usage.has(`${choice.character.id}/${choice.variant || ''}`));
    // If the pool is smaller than the team, spread reuse evenly. Stable probe
    // order breaks ties so the same input set always produces the same result.
    const choice = free || eligible
      .sort((a, b) => (usage.get(`${a.character.id}/${a.variant || ''}`) || 0)
        - (usage.get(`${b.character.id}/${b.variant || ''}`) || 0))[0];
    const look = makeLook(choice), key = lookKey(look);
    chosen.set(id, look);
    usage.set(key, (usage.get(key) || 0) + 1);
  }
  return chosen;
}

function memberAppearance(memberId, index, options = {}) {
  if (typeof memberId !== 'string' || !memberId || !index) return null;
  const result = allocateMemberAppearances([memberId], index, options).get(memberId);
  return result ? { look: result, automaticLook: result } : null;
}

module.exports = { memberAppearance, allocateMemberAppearances, lookKey, memberOrderKey };
