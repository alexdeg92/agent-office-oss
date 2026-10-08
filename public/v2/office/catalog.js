// The Boutique's catalog (office-dev-21): manifest + layout draft + agents' looks → tabs and items with their badges.
// Everything comes from the manifest (no list of item ids here; a new asset or character family shows up by itself).
// Everything is free, so no prices. Pure: no DOM, no strings (boutique.js localizes); tested in test/office/catalog.test.js.
import { withCharacter, withVariant, withAccessory, accessoryDrawn } from './setup-looks.js';

export const TABS = ['mobilier', 'decoration', 'personnages', 'couleurs', 'accessoires', 'themes'];
/** Manifest furniture category → tab. A category not listed here (a future one) goes to Décoration. */
const CATEGORY_TAB = { poste: 'mobilier', assise: 'mobilier', rangement: 'mobilier', equipement: 'mobilier', plante: 'decoration', deco: 'decoration', sol: 'decoration', mur: 'decoration' };
export const tabOfCategory = (cat) => CATEGORY_TAB[cat] ?? 'decoration';
export const isLookTab = (tab) => tab === 'personnages' || tab === 'couleurs' || tab === 'accessoires';
export const isPlaceTab = (tab) => tab === 'mobilier' || tab === 'decoration';

/** Furniture of a tab, in manifest order: { id, f, category, placement, count } (count = copies in the office). */
export function furnitureItems(index, layout, tab) {
  const counts = new Map();
  for (const it of layout.items) counts.set(it.asset, (counts.get(it.asset) ?? 0) + 1);
  return [...index.furniture.values()].filter((f) => tabOfCategory(f.category) === tab)
    .map((f) => ({ id: f.id, f, category: f.category ?? null, placement: f.placement ?? 'floor', count: counts.get(f.id) ?? 0 }));
}

/** Rows (agents) whose look satisfies `test`, for « porté par … » badges (default rules excluded: they aren't people). */
const wornBy = (rows, looks, test) => rows.filter((r) => !r.isDefault && looks[r.id] && test(looks[r.id])).map((r) => r.id);

/**
 * Characters (Personnages), grouped by family in manifest order. Each: { id, family, label, look } where `look` is the
 * chosen agent's look with that character (its first colour and default gear), and `on` when the agent has it.
 */
export function characterItems(index, look, rows, looks) {
  return [...index.characters.values()].map((c) => ({ id: c.id, family: c.family ?? c.id, c, look: c.id === look.character ? look : withCharacter(index, look, c.id),
    on: c.id === look.character, wornBy: wornBy(rows, looks, (l) => l.character === c.id) }));
}

/** Colours (Couleurs) of the chosen agent's character: { id, v, swatch, look, on, wornBy }. None → an empty list. */
export function colourItems(index, look, rows, looks) {
  const c = index.characters.get(look.character);
  return (c?.variants ?? []).map((v) => ({ id: v.id, v, swatch: v.swatch ?? null, look: withVariant(index, look, v.id), on: v.id === look.variant,
    wornBy: wornBy(rows, looks, (l) => l.character === c.id && l.variant === v.id) }));
}

/**
 * Accessories for the chosen agent: { id, a, slot, look (with it worn, or without it when it is worn), on, drawn,
 * replaces, wornBy }. `drawn` is false when the art for this character/colour doesn't exist yet (still saved).
 */
export function accessoryItems(index, look, rows, looks) {
  return [...index.accessories.values()].map((a) => {
    const on = look.accessories.includes(a.id);
    const w = withAccessory(index, look, a.id);
    const worn = on ? look : w.look;
    return { id: a.id, a, slot: a.slot, look: worn, toggled: w.look, on, replaces: on ? null : w.replaced, drawn: accessoryDrawn(index, worn, a.id),
      wornBy: wornBy(rows, looks, (l) => l.accessories.includes(a.id)) };
  });
}

/** Theme choices: modes, then the manifest's seasons (themes of kind « season »). */
export function themeChoices(index) {
  const seasons = [...(index.themes?.values?.() ?? [])].filter((t) => t.kind === 'season').map((t) => ({ id: t.id, t }));
  return { modes: ['auto', 'day', 'night'], seasons };
}

/** Items in the office for one asset, in layout order (placement mode « déplacer » picks among them). */
export const placedOf = (layout, asset) => layout.items.filter((it) => it.asset === asset);
