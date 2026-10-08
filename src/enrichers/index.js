'use strict';
/*
 * Enricher registry (ADR-001 §14.2, G7): what can be learnt about an interlocutor beyond its id (names, avatars, room
 * details). Enrichers are SELECTED by the instance config (`enrichers`, AO_ENRICHERS; default ['discord']); an id whose
 * family no selected enricher resolves is 'unresolvable'. The core sees InterlocutorProfile values only.
 */
const ENRICHERS = { discord: () => require('./discord').definition };
const DEFAULT_ENRICHERS = ['discord'];

const definitionOf = (id) => { if (!Object.prototype.hasOwnProperty.call(ENRICHERS, id)) throw new Error('unknown enricher: ' + id); return ENRICHERS[id](); };
// 'discord-user:1' → 'discord'; 'telegram-room:x' → 'telegram'
const familyOf = (iid) => { const head = String(iid).slice(0, Math.max(0, String(iid).indexOf(':'))); return head.slice(0, head.lastIndexOf('-')); };
const prefixOf = (iid) => String(iid).slice(0, Math.max(0, String(iid).indexOf(':')));

/** Every registered enricher's stored-profile schemas and id patterns (the cache validates all rows, selected or not). */
function cacheSchemas() {
  const profiles = {}, owners = [];
  for (const id of Object.keys(ENRICHERS)) { const d = definitionOf(id); Object.assign(profiles, d.cacheProfiles); owners.push({ families: d.families, ids: d.cacheIds }); }
  return { profiles, owners };
}

/**
 * @param {object} o
 * @param {string[]} o.ids      the selected enricher ids
 * @param {object}   o.deps     { secret(name), cache, now, log }
 */
function createEnrichment({ ids = DEFAULT_ENRICHERS, deps = {} } = {}) {
  const list = ids.map((id) => { const def = definitionOf(id); return { def, inst: def.create(deps) }; });
  const forId = (iid) => list.find((e) => e.def.families.includes(familyOf(iid))) || null;
  return {
    ids: ids.slice(),
    handles: (iid) => !!forId(iid),
    peek(iid) { const e = forId(iid); return e ? e.inst.peek(iid) : { resolution: 'unresolvable', profile: null }; },
    resolve(iid) { const e = forId(iid); return e ? e.inst.resolve(iid) : Promise.resolve(); },
    /** background resolution of every id seen; → true if any enricher ran */
    async resolveAll(allIds) {
      let ran = false;
      for (const e of list) { const mine = allIds.filter((x) => e.def.families.includes(familyOf(x))); if (mine.length && (await e.inst.resolveAll(mine))) ran = true; }
      return ran;
    },
    onChange(fn) { for (const e of list) e.inst.onChange(fn); },
    // a display name for titles (users: display name or username; rooms: name), or null
    nameOf(iid) { const { profile: p } = this.peek(iid); return p ? p.displayName || p.username || p.name || null : null; },
  };
}

module.exports = { createEnrichment, cacheSchemas, familyOf, prefixOf, ENRICHER_IDS: Object.keys(ENRICHERS), DEFAULT_ENRICHERS };
