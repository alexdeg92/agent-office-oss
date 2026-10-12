// Pure first-sight selection used by the durable server allocator.
import { canonicalRuleId, canonicalRole } from './layout-rules.js';
export function appearanceIdentity(raw) {
  const colon = raw.indexOf(':');
  const role = colon > 0 && canonicalRole(raw.slice(0, colon));
  // Normalize vocabulary even for long native IDs outside the seen inventory bound.
  const id = canonicalRuleId(raw) ?? (role ? role + raw.slice(colon) : raw);
  return id.startsWith('subagent:') ? 'agent:' + id.slice(9) : id;
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function appearanceHash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function installedFamilies(index) {
  const groups = new Map();
  for (const c of index.characters.values()) {
    const family = c.family ?? c.id;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(c);
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([id, characters]) => ({ id, characters: characters.sort((a, b) => compare(a.id, b.id)) }));
}
export function supportedAccessories(index, character, variant) {
  const c = index.characters.get(character);
  if (!c) return [];
  return [...index.accessories.values()].filter(a => {
    if (c.accessorySupport) return c.accessorySupport[a.id]?.supported === true;
    const layers = a.layers?.[`${character}/${variant}`] ?? a.layers?.[character];
    return !!(layers?.idle?.front || layers?.idle?.back);
  }).map(a => a.id).sort(compare);
}
/** A new identity chooses a least-used family. Existing assignments are never passed here. */
export function chooseAutomaticLook(index, id, usage = new Map(), { primary = false } = {}) {
  const families = installedFamilies(index);
  const min = Math.min(...families.map(f => usage.get(f.id) ?? 0));
  const eligible = families.filter(f => (usage.get(f.id) ?? 0) === min);
  eligible.sort((a, b) => appearanceHash(id + '/family/' + a.id) - appearanceHash(id + '/family/' + b.id) || compare(a.id, b.id));
  const family = eligible[0];
  if (!family) throw new Error('no installed character family');
  const roleChoices = family.characters.filter(c => primary ? c.role === 'main' : c.role !== 'main');
  const characters = roleChoices.length ? roleChoices : family.characters;
  const ch = characters[appearanceHash(id + '/character') % characters.length];
  const variants = [...(ch.variants ?? [])].sort((a, b) => compare(a.id, b.id));
  const variant = variants.length ? variants[appearanceHash(id + '/variant') % variants.length].id : null;
  const gear = supportedAccessories(index, ch.id, variant);
  const accessories = gear.length && appearanceHash(id + '/gear-on') % 3 !== 0 ? [gear[appearanceHash(id + '/gear') % gear.length]] : [];
  return { family: family.id, look: { character: ch.id, variant, accessories } };
}
