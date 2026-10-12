// Manifest indexing and image resolution (design/office/manifest.schema.json). Pure; no DOM.

export const SLOT_ORDER = ['body', 'neck', 'face', 'head', 'badge'];

export function indexManifest(m) {
  const by = (arr) => new Map((arr ?? []).map((o) => [o.id, o]));
  const accessories = by((m.accessories ?? []).map(a => ({ ...a, layers: { ...a.layers } })));
  return {
    manifest: m,
    proj: m.projection,
    rooms: by(m.rooms),
    furniture: by(m.furniture),
    characters: by([...(m.characters ?? []), ...(m.characterPacks?.packs ?? [])]),
    accessories,
    themes: by(m.themes),
  };
}

/** Manifest paths are relative to design/ ("assets/Office/…"); the app serves them under assetBase. */
export function assetUrl(path, assetBase) {
  return assetBase.replace(/\/?$/, '/') + path;
}

/** Furniture image for an orientation, trying theme variants in order ('sw@night', 'sw@on', …). */
export function furnitureImage(f, orientation = 'sw', variants = []) {
  for (const v of variants) {
    const p = f.images?.[`${orientation}@${v}`];
    if (p) return p;
  }
  if (orientation !== 'sw' && f.images?.[orientation]) return f.images[orientation];
  return f.image;
}

/** Image path for a station part, with an optional variant ('on'). */
export function partImage(part, variant) {
  if (typeof part === 'string') return part;
  return (variant && part.variants?.[variant]) || part.image;
}

const POSE_FALLBACK = {
  'walking-se': 'walking', walking: 'idle', talking: 'idle', celebrating: 'idle', alert: 'idle', sleeping: 'idle', thinking: 'idle', working: 'idle',
  // Walking away from the camera (BRIEF, facing): back views when delivered, else the front walks.
  'walking-ne': 'walking-se', 'walking-nw': 'walking',
  // Seated at the desk, back to the camera (Batch 6). Only reached when the look has the seated set (seatModeFor).
  // Batch 6 has no seated-ne / sleeping-ne: they resolve to working-ne (the scene shows its first frame, still).
  'reading-ne': 'working-ne', 'thinking-ne': 'working-ne', 'sleeping-ne': 'seated-ne', 'seated-ne': 'working-ne', 'working-ne': 'idle',
  // Swivelled toward the camera while seated.
  'seated-wave-sw': 'seated-turn-sw', 'seated-celebrating-sw': 'seated-turn-sw', 'seated-alert-sw': 'seated-turn-sw', 'seated-talking-sw': 'seated-turn-sw', 'seated-turn-sw': 'idle',
  'sofa-sleep-sw': 'sofa-sit-sw', 'sofa-sit-sw': 'idle',
  // Standing toward the right (meeting scene, left spot): until talking-se / idle-se exist, the SE walk.
  'talking-se': 'idle-se', 'idle-se': 'walking-se',
};

/** Poses facing away from the camera (NE family); a seated swivel crosses between families. */
export const isBackPose = (pose) => /-ne$|-nw$/.test(pose);

/** Pass-through for data:/blob: URLs (demo placeholders), else prefix the asset base. */
export function resolveUrl(path, assetBase) {
  return /^(data|blob):/.test(path) ? path : assetUrl(path, assetBase);
}

/**
 * Pose entry for a character look; falls back (walking-se → walking → idle, working-ne → seated-ne …)
 * so missing art never blanks a character. A pose entry is a path, or an object
 * { image | frames[], frameMs?, anchor?, canvas? } (frame loops, per-pose seat anchors).
 * @returns {{ pose, path, frames: string[]|null, frameMs: number, anchor, canvas }}
 */
export function poseImage(character, variantId, pose) {
  const variant = variantId ? character.variants?.find((v) => v.id === variantId) : null;
  for (let p = pose; p; p = POSE_FALLBACK[p]) {
    const entry = variant?.poses?.[p] ?? character.poses?.[p];
    if (entry) return poseEntry(character, p, entry);
  }
  return poseEntry(character, 'idle', character.poses.idle);
}

/** The sofa frame has a real sitting silhouette; reuse it when the desk swivels toward the viewer.
 * Resolve accessories against that frame too, so gear stays registered to the seated body. */
export function deskPoseImage(character, variantId, pose) {
  const seated = /^seated-.*-sw$/.test(pose) && hasPose(character, variantId, 'sofa-sit-sw');
  return poseImage(character, variantId, seated ? 'sofa-sit-sw' : pose);
}

function poseEntry(character, pose, entry) {
  if (typeof entry === 'string') return { pose, path: entry, frames: null, frameMs: 0, anchor: character.anchor, canvas: character.canvas, seatAnchor: null };
  const frames = entry.frames?.length ? entry.frames : null;
  return {
    pose,
    path: entry.image ?? frames[0],
    frames: frames && frames.length > 1 ? frames : null,
    frameMs: entry.frameMs ?? 350,
    anchor: entry.anchor ?? character.anchor,
    canvas: entry.canvas ?? character.canvas,
    seatAnchor: entry.seatAnchor ?? null,
    frameSeatAnchors: entry.frameSeatAnchors ?? null,
    handAnchor: entry.handAnchor ?? null,
    fxAnchor: entry.fxAnchor ?? null,
  };
}

/** True when the look (variant, else base) has this exact pose (no fallback). */
export function hasPose(character, variantId, pose) {
  const variant = variantId ? character.variants?.find((v) => v.id === variantId) : null;
  return !!(variant?.poses?.[pose] ?? character.poses?.[pose]);
}

/**
 * How an occupant uses a station (BRIEF, facing and desk behaviour):
 * 'desk'  seated with the back to the camera (needs working-ne + seated-turn-sw and a station.seated block);
 * 'sofa'  sitting on the sofa (needs sofa-sit-sw and station.seated);
 * 'stand' v1 interim: standing in front, facing the camera.
 */
export function seatModeFor(character, variantId, station) {
  if (!station?.seated) return 'stand';
  if (station.kind === 'desk' && hasPose(character, variantId, 'working-ne') && hasPose(character, variantId, 'seated-turn-sw')) return 'desk';
  if (station.kind === 'lounge' && hasPose(character, variantId, 'sofa-sit-sw')) return 'sofa';
  return 'stand';
}

/**
 * Accessory layers for a look and pose, in slot order, at most one accessory per slot.
 * Contract v2 (BRIEF decisions log): each accessory has a `back` layer (drawn behind the character)
 * and a `front` layer (drawn over it), looked up in `layers["<character>/<variant>"]`, then
 * `layers["<character>"]`. Until an accessory has v2 layers for that pose, its legacy single-layer
 * overlay (`images[character][pose]`, deprecated) is used as a front layer unless `legacy: false`.
 * A pose with neither shows nothing.
 * @returns {{ back: {id,slot,path}[], front: {id,slot,path,legacy?:true}[] }}
 */
export function accessoryLayers(index, characterId, accessoryIds, pose, variantId = null, { legacy = true, mode = 'day' } = {}) {
  const seen = new Set();
  const back = [];
  const front = [];
  const list = (accessoryIds ?? []).map((id) => index.accessories.get(id)).filter(Boolean);
  list.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  for (const a of list) {
    if (seen.has(a.slot)) continue;
    const registered = (variantId && a.layers?.[`${characterId}/${variantId}`]?.[pose]) || a.layers?.[characterId]?.[pose];
    const v2 = registered?.modes ? registered.modes[mode] : registered;
    if (v2 && (v2.back || v2.front)) {
      seen.add(a.slot);
      // frames: per-frame paths aligned with the body frames (working-ne typing loop); null = static.
      const fr = (k) => (v2.frames ? v2.frames.map((f) => f[k] ?? null) : null);
      if (v2.back) back.push({ id: a.id, slot: a.slot, path: v2.back, frames: fr('back') });
      if (v2.front) front.push({ id: a.id, slot: a.slot, path: v2.front, frames: fr('front') });
      continue;
    }
    const path = legacy ? a.images?.[characterId]?.[pose] : null;
    if (!path) continue;
    seen.add(a.slot);
    front.push({ id: a.id, slot: a.slot, path, legacy: true });
  }
  return { back, front };
}

/** Flat list (back layers first, then front), kept for callers that only need the paths. */
export function accessoryImages(index, characterId, accessoryIds, pose, variantId = null, opts = {}) {
  const { back, front } = accessoryLayers(index, characterId, accessoryIds, pose, variantId, opts);
  return [...back, ...front];
}

/**
 * Head landmarks of a pose (image px on the pose canvas), from the variant, then the character.
 * Shape: { headCentre:{x,y}, headBox:{x,y,w,h}, tilt, earLeft:{x,y}, earRight:{x,y},
 *          eyeLine:{a:{x,y}, b:{x,y}}, neck:{x,y}, chest:{x,y} } — any field may be missing.
 */
export function landmarksFor(character, variantId, pose) {
  const v = variantId ? character.variants?.find((x) => x.id === variantId) : null;
  const base = pose === 'walking-se' ? 'walking' : pose;
  return v?.landmarks?.[pose] ?? character.landmarks?.[pose] ?? v?.landmarks?.[base] ?? character.landmarks?.[base] ?? null;
}

/** Image-px y of the top of the head for marker placement: landmark head box, else the manifest's `head.y`. */
export function headTopY(character, variantId, pose) {
  const lm = landmarksFor(character, variantId, pose);
  if (lm?.headBox) return lm.headBox.y;
  return character.head?.y ?? 40;
}

/** Render scale for a character: baked sub-agent scale is already in the pixels. */
export function renderScale(character) {
  return character.scaleBaked ? 1 : (character.scale ?? 1);
}

/** Theme object with base-theme inheritance (season themes extend day/night). */
export function themeFor(index, id) {
  const t = index.themes.get(id) ?? index.themes.values().next().value;
  if (!t.base) return t;
  const base = index.themes.get(t.base) ?? {};
  return { ...base, ...t, light: t.light ?? base.light, furnitureVariants: t.furnitureVariants ?? base.furnitureVariants };
}

export function roomImage(room, theme) {
  return room.images[theme.room ?? theme.id] ?? room.images[theme.base] ?? Object.values(room.images)[0];
}
