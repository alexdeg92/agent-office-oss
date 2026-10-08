// First-run setup, « characters » step (O5): the pure model behind setup-characters.js. A look is the same plain
// object the layout rules and OccupantVM use: { character, variant: string|null, accessories: string[] }.
// Every choice comes from the manifest: a character family the manifest ships (family B, …) is offered with no code
// change. No DOM, no i18n: the component localizes.
import { defaultAccessoriesFor, sortAccessories } from './layout-rules.js';
import { accessoryLayers } from './assets.js';

/** Characters in manifest order, with their variants (an empty list when the character has none). */
export function characterChoices(index) {
  return [...index.characters.values()].map((c) => ({ id: c.id, role: c.role ?? null, label: c.label, variants: (c.variants ?? []).map((v) => ({ id: v.id, label: v.label, swatch: v.swatch ?? null })) }));
}

/** Accessories grouped by slot, in manifest order: [[slot, [accessory…]]…] (slots without accessories omitted). */
export function accessorySlots(index) {
  const out = new Map();
  for (const a of index.accessories.values()) { if (!out.has(a.slot)) out.set(a.slot, []); out.get(a.slot).push(a); }
  return [...out.entries()];
}

/**
 * The default look of the `i`-th agent: the primary agent takes the first character meant for the main role; the others
 * rotate through every variant of the characters meant for other agents (so each one is told apart), in manifest order.
 */
export function defaultLook(index, agent, i = 0) {
  const chars = [...index.characters.values()];
  if (!chars.length) return null;
  const pick = (c, v) => ({ character: c.id, variant: v ?? null, accessories: [...defaultAccessoriesFor(index, c.id, v ?? null)] });
  if (agent.primary) {
    const main = chars.find((c) => c.role === 'main') ?? chars[0];
    return pick(main, main.variants?.[0]?.id);
  }
  const others = chars.filter((c) => c.role !== 'main');
  const pool = (others.length ? others : chars).flatMap((c) => (c.variants?.length ? c.variants.map((v) => [c, v.id]) : [[c, null]]));
  const [c, v] = pool[i % pool.length];
  return pick(c, v);
}

/** A valid look: unknown character → the default; a variant that doesn't exist → the first; accessories known, one per slot. */
export function normalizeLook(index, look, fallback) {
  const c = look && index.characters.get(look.character);
  if (!c) return fallback;
  const variants = c.variants ?? [];
  const variant = variants.length ? (variants.some((v) => v.id === look.variant) ? look.variant : variants[0].id) : null;
  const seen = new Set();
  const accessories = (Array.isArray(look.accessories) ? look.accessories : defaultAccessoriesFor(index, c.id, variant)).filter((id) => {
    const a = index.accessories.get(id);
    if (!a || seen.has(a.slot)) return false;
    seen.add(a.slot);
    return true;
  });
  return { character: c.id, variant, accessories: sortAccessories(index, accessories) };
}

/** Looks for every agent: the given value where valid, else the default. Agents order = list order. */
export function initialLooks(index, agents, value = {}) {
  let k = 0;
  return Object.fromEntries(agents.map((a) => {
    const def = defaultLook(index, a, a.primary ? 0 : k++);
    return [a.id, normalizeLook(index, value?.[a.id], def)];
  }));
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Another character: its first variant and that variant's default gear. */
export function withCharacter(index, look, characterId) {
  const c = index.characters.get(characterId);
  if (!c || c.id === look.character) return look;
  const variant = c.variants?.[0]?.id ?? null;
  return { character: c.id, variant, accessories: [...defaultAccessoriesFor(index, c.id, variant)] };
}

/** Another colour: gear left at the old colour's defaults follows the new colour's defaults; chosen gear is kept. */
export function withVariant(index, look, variantId) {
  const c = index.characters.get(look.character);
  if (!c?.variants?.some((v) => v.id === variantId) || variantId === look.variant) return look;
  const wasDefault = sameSet(look.accessories, defaultAccessoriesFor(index, c.id, look.variant));
  return { ...look, variant: variantId, accessories: wasDefault ? [...defaultAccessoriesFor(index, c.id, variantId)] : look.accessories };
}

/** Wear or remove an accessory; one per slot (the one it replaces is returned for the announcement). */
export function withAccessory(index, look, id) {
  const a = index.accessories.get(id);
  if (!a) return { look, replaced: null, added: false };
  if (look.accessories.includes(id)) return { look: { ...look, accessories: look.accessories.filter((x) => x !== id) }, replaced: null, added: false };
  const replaced = look.accessories.find((x) => index.accessories.get(x)?.slot === a.slot) ?? null;
  const next = look.accessories.filter((x) => x !== replaced).concat(id);
  return { look: { ...look, accessories: sortAccessories(index, next) }, replaced, added: true };
}

/** Is the accessory drawn for this look yet (v2 layers for its idle pose)? Undrawn gear is still saved. */
export function accessoryDrawn(index, look, id) {
  const layers = accessoryLayers(index, look.character, [id], 'idle', look.variant, { legacy: false });
  return layers.back.length + layers.front.length > 0;
}

/** The step's result: a plain { agentId → look } object for the agents given (copies, safe to store). */
export function result(looks, agents) {
  return Object.fromEntries(agents.map((a) => [a.id, { character: looks[a.id].character, variant: looks[a.id].variant, accessories: [...looks[a.id].accessories] }]));
}
