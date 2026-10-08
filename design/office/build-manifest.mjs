// Rebuilds design/office/manifest.example.json from design/assets/anchors.json (the artist's truth).
// Run after an art delivery:  node design/office/build-manifest.mjs
// Hand-tuned values (seats, stacks, labels, swatches, pending notes) live here, not in the JSON.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeLandmarks } from '../../public/v2/office/landmarks.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const ANCHORS = JSON.parse(readFileSync(root + 'assets/anchors.json', 'utf8'));
const A = ANCHORS.assets;
const REG = ANCHORS.stationRegistration ?? {};
const P = (rel) => 'assets/' + rel;
const size = (rel) => ({ w: A[rel].canvas[0], h: A[rel].canvas[1] });
const anchor = (rel) => { const a = A[rel]; if (!a) throw new Error('no anchor ' + rel); return { x: a.anchor[0], y: a.anchor[1] }; };
const has = (rel) => !!A[rel] && existsSync(root + 'assets/' + rel);
const POSES = ['idle', 'working', 'thinking', 'talking', 'walking', 'walking-se', 'celebrating', 'sleeping', 'alert'];
// Batch 6 (BRIEF, facing and desk behaviour): seated with the back to the camera, swivels, sofa, back walks.
const SEATED_POSES = ['seated-ne', 'working-ne', 'reading-ne', 'thinking-ne', 'sleeping-ne', 'seated-swivel', 'seated-turn-sw',
  'seated-wave-sw', 'seated-talking-sw', 'seated-celebrating-sw', 'seated-alert-sw', 'sofa-sit-sw', 'sofa-sleep-sw', 'walking-ne', 'walking-nw'];
const FRAME_MS = 350;
const poseSet = (dir) => Object.fromEntries(POSES.filter((p) => has(`${dir}/${p}.png`)).map((p) => [p, P(`${dir}/${p}.png`)]));
// A Batch 6 pose is <pose>.png, or a frame loop <pose>.1.png, <pose>.2.png, …; it carries its own
// anchor/canvas when they differ from the character's (seat anchors).
const frameFile = (dir, p, n) => [`${dir}/${p}-${n}.png`, `${dir}/${p}.${n}.png`].find(has);
const seatedEntry = (dir, p, base) => {
  const frames = [];
  for (let n = 1; n <= 9 && frameFile(dir, p, n); n++) frames.push(frameFile(dir, p, n));
  const first = frames[0] ?? (has(`${dir}/${p}.png`) ? `${dir}/${p}.png` : null);
  if (!first) return null;
  const a = A[first];
  const extra = {};
  if (a.anchor && (a.anchor[0] !== base.anchor.x || a.anchor[1] !== base.anchor.y)) extra.anchor = { x: a.anchor[0], y: a.anchor[1] };
  if (a.canvas && (a.canvas[0] !== base.canvas.w || a.canvas[1] !== base.canvas.h)) extra.canvas = { w: a.canvas[0], h: a.canvas[1] };
  // Seated poses are placed by their hip contact on the seat (stationRegistration seatFormula).
  if (a.seatAnchor) extra.seatAnchor = { x: a.seatAnchor[0], y: a.seatAnchor[1] };
  if (frames.length > 1) return { frames: frames.map(P), frameMs: a.frameMs ?? FRAME_MS, ...extra };
  return Object.keys(extra).length ? { image: P(first), ...extra } : P(first);
};
const withSeated = (dir, set, base) => {
  for (const p of SEATED_POSES) { const e = seatedEntry(dir, p, base); if (e) set[p] = e; }
  return set;
};
const CHAR_BASE = { anchor: { x: 96, y: 276 }, canvas: { w: 192, h: 288 } };
// Contract v2: head landmarks per pose image (anchors.json `landmarks`), normalised for the manifest.
const landmarkSet = (dir) => {
  const out = {};
  for (const p of [...POSES, ...SEATED_POSES]) {
    const file = has(`${dir}/${p}.png`) ? `${dir}/${p}.png` : frameFile(dir, p, 1);
    const lm = normalizeLandmarks(A[file]?.landmarks ?? A[file]?.headLandmarks);
    if (lm) out[p] = lm;
  }
  return Object.keys(out).length ? out : undefined;
};
// Contract v2: two-layer accessories, <pose>.back.png / <pose>.front.png per character (or character/variant).
const layerSet = (dir) => {
  const out = {};
  const pair = (base) => {
    const back = has(`${base}.back.png`) ? P(`${base}.back.png`) : undefined;
    const front = has(`${base}.front.png`) ? P(`${base}.front.png`) : undefined;
    return back || front ? { ...(back && { back }), ...(front && { front }) } : null;
  };
  for (const p of [...POSES, ...SEATED_POSES]) {
    const one = pair(`${dir}/${p}`);
    if (one) { out[p] = one; continue; }
    // Frame poses (working-ne-1..3): per-frame layers that swap with the body frames.
    const frames = [];
    for (let n = 1; n <= 9; n++) { const f = pair(`${dir}/${p}-${n}`); if (!f) break; frames.push(f); }
    if (frames.length) out[p] = { ...frames[0], ...(frames.length > 1 && { frames }) };
  }
  return Object.keys(out).length ? out : undefined;
};
const missing = (dir) => POSES.filter((p) => !has(`${dir}/${p}.png`)).map((p) => P(`${dir}/${p}.png`));

const F = (id, label, category, placement, extra = {}) => {
  const rel = `Office/furniture/${id}.png`;
  const a = A[rel];
  const o = { id, label, category, placement };
  if (a.footprint) o.footprint = a.footprint;
  if (a.walkable) o.walkable = true;
  o.image = P(rel);
  o.anchor = anchor(rel);
  o.size = size(rel);
  return Object.assign(o, extra);
};

// ---- Character families delivered in batches (artist-10: family B, capsule assistants) ----
// A family joins `characters` only when every variant has the full base pose set AND every accessory has its v2
// layer pair for every look and pose: joining earlier would make accessoriesV2 incomplete, which turns the
// deprecated v1 overlays back on for every look. Until then it is reported in `families` (in flux) and `pending`.
const BASE_POSES = [...POSES, 'working-ne-1', 'working-ne-2', 'working-ne-3', 'thinking-ne', 'reading-ne', 'seated-turn-sw', 'sofa-sit-sw'];
const FAMILIES = [
  { id: 'family-b', label: 'Capsule', dir: 'Characters/family-b',
    variants: [['pearl', 'Perle', '#E6E1D7'], ['moss', 'Mousse', '#7F9970'], ['clay', 'Argile', '#C27C5E'], ['slate', 'Ardoise', '#69737F']] },
];
const ACC_IDS = ['headphones', 'cap', 'glasses', 'scarf', 'badge'];
function familyStatus(f) {
  const base = f.variants.flatMap(([v]) => BASE_POSES.map((p) => `${f.dir}/${v}/${p}.png`));
  const baseMissing = base.filter((rel) => !has(rel));
  const layers = f.variants.flatMap(([v]) => BASE_POSES.flatMap((p) => ACC_IDS.map((a) => `Characters/accessories/${a}/${f.id}/${v}/${p}`)));
  // A pose's pair may be one blank layer (rear badges): either file counts.
  const layersMissing = layers.filter((b) => !has(`${b}.back.png`) && !has(`${b}.front.png`));
  return { base: { covered: base.length - baseMissing.length, total: base.length }, accessories: { covered: layers.length - layersMissing.length, total: layers.length },
    complete: !baseMissing.length && !layersMissing.length };
}
const FAMILY_STATUS = Object.fromEntries(FAMILIES.map((f) => [f.id, familyStatus(f)]));
const familyCharacter = (f) => {
  const first = `${f.dir}/${f.variants[0][0]}`;
  return {
    id: f.id, label: f.label, role: 'subagent', family: f.id,
    canvas: { w: 192, h: 288 }, anchor: anchor(`${first}/idle.png`), scale: 0.85, scaleBaked: true,
    head: { y: Math.round(A[`${first}/idle.png`]?.headLandmarks?.headBox?.[1] ?? 95) },
    poses: withSeated(first, poseSet(first), CHAR_BASE), landmarks: landmarkSet(first),
    variants: f.variants.map(([v, lbl, sw]) => {
      const dir = `${f.dir}/${v}`;
      return { id: v, label: lbl, swatch: sw, poses: withSeated(dir, poseSet(dir), CHAR_BASE), landmarks: landmarkSet(dir),
        gearFree: true, defaultAccessories: A[`${dir}/idle.png`]?.defaultAccessories ?? [] };
    }),
  };
};
const READY_FAMILIES = FAMILIES.filter((f) => FAMILY_STATUS[f.id].complete);
const SHIPPED_CHARACTERS = new Set(['timmy', 'subagent', ...READY_FAMILIES.map((f) => f.id)]);

// Batch 6 desk composition, from anchors.json stationRegistration['desk-ne'] (authoritative).
function deskSeated() {
  const reg = REG['desk-ne'];
  const chairRel = reg?.chair ?? 'Office/furniture/chair@ne.png';
  if (!reg || !has(chairRel)) return undefined;
  const [cx, cy] = reg.chairOriginTileOffset;
  const chair = A[chairRel];
  const turnRel = 'Office/furniture/chair.png';
  // Reuse each chair bitmap for two DOM layers. Only the near armrest crosses the occupant;
  // the backrest, cushion and wheelbase stay behind, just like the sofa composition.
  const armrest = [[66, 38], [91, 29], [95, 32], [95, 36], [74, 47], [66, 46]];
  const turnArmrest = [[56, 48], [80, 40], [86, 43], [86, 48], [62, 55], [55, 53]];
  const at = { x: cx, y: cy };
  const back = { image: P(chairRel), anchor: anchor(chairRel), size: size(chairRel), at, seatAnchor: { x: chair.seatAnchor[0], y: chair.seatAnchor[1] } };
  const turn = { image: P(turnRel), anchor: anchor(turnRel), size: size(turnRel), at, seatAnchor: { x: A[turnRel].seatAnchor[0], y: A[turnRel].seatAnchor[1] } };
  const parts = {
    chair: back,
    'chair-front': { ...back, clip: armrest },
    'chair-turn': turn,
    'chair-turn-front': { ...turn, clip: turnArmrest },
  };
  if (has('Office/furniture/keyboard.png')) {
    parts.keyboard = {
      image: P('Office/furniture/keyboard.png'),
      // Only the characters this manifest ships (a family still being delivered adds its offset in anchors first).
      offsetByCharacter: Object.fromEntries(Object.entries(reg.keyboardOffsetByCharacter ?? {}).filter(([k]) => SHIPPED_CHARACTERS.has(k)).map(([k, [x, y]]) => [k, { x, y }])),
    };
  }
  return {
    // Grid point under the chair (ring, depth while arriving); the image is placed by seatFrom.
    seat: { x: cx + 0.5, y: cy + 0.5 },
    facing: 'ne',
    seatFrom: 'chair',
    stack: ['desk', 'monitor', 'keyboard', 'chair', 'character', 'chair-front'],
    // Timmy's rear desk art is larger than his sofa sitting frame. The scale applies to
    // the entire pose (body and accessories) about the hip contact, never to the feet.
    scaleByCharacter: { timmy: 0.85 },
    turned: { seatFrom: 'chair-turn', stack: ['desk', 'monitor', 'keyboard', 'chair-turn', 'character', 'chair-turn-front'] },
    parts,
  };
}

// Sofa seats (image px on sofa.png): the first is the lounge seat.
function sofaSeated() {
  const seats = A['Office/furniture/sofa.png']?.seatAnchors;
  const first = seats && Object.values(seats)[0];
  if (!first) return { seat: { x: 1.4, y: 0.55 }, facing: 'sw', stack: ['sofa', 'character'] };
  return { seat: { x: 1.4, y: 0.55 }, facing: 'sw', stack: ['sofa', 'character'], seatPoint: { x: first[0], y: first[1] } };
}

const furniture = [
  F('desk', 'Poste de travail', 'poste', 'floor', {
    station: {
      kind: 'desk',
      seat: { x: 1.1, y: 1.45 },
      facing: 'sw',
      stack: ['desk', 'monitor', 'chair', 'character'],
      parts: {
        chair: { image: P('Office/furniture/chair.png'), anchor: anchor('Office/furniture/chair.png'), size: size('Office/furniture/chair.png'), at: { x: 0, y: 1 } },
        monitor: { image: P('Office/furniture/monitor.png'), variants: { on: P('Office/furniture/monitor@on.png') } },
      },
      blocks: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      screen: { x: 171, y: 78 },
      // Batch 6: seated on the camera side, back to the camera, facing the monitor. Used for looks that
      // have seated-ne + seated-turn-sw; others keep the v1 standing composition above.
      seated: deskSeated(),
    },
    pending: ['desk-se (orientation se)'],
  }),
  F('chair', 'Chaise', 'assise', 'floor'),
  F('sofa', 'Canapé', 'assise', 'floor', { station: { kind: 'lounge', seat: { x: 1.4, y: 1.3 }, facing: 'sw', stack: ['sofa', 'character'], seated: sofaSeated() } }),
  F('rug', 'Tapis', 'sol', 'decal'),
  F('plant-large', 'Grande plante', 'plante', 'floor'),
  F('plant-small', 'Petite plante', 'plante', 'floor'),
  F('shelf', 'Bibliothèque', 'rangement', 'floor', {
    station: { kind: 'reading', seat: { x: 1, y: 1.5 }, facing: 'sw' },
    pending: ['shelf-se (orientation se)'],
  }),
  F('coffee-machine', 'Machine à café', 'equipement', 'floor', {
    station: { kind: 'coffee', seat: { x: 0.5, y: 1.5 }, facing: 'sw' },
    pending: ['coffee-machine-se (orientation se)'],
  }),
  F('server-rack', 'Baie serveur', 'equipement', 'floor', { station: { kind: 'server', seat: { x: -0.5, y: 0.5 }, facing: 'sw' } }),
  F('meeting-table', 'Table de réunion', 'poste', 'floor', {
    station: {
      kind: 'meeting', seat: { x: 2.5, y: 1 }, facing: 'sw',
      // Delegation scene (api-proposal §6): two standing spots in front of the table on one screen row
      // (equal x + y), the screen-left one facing SE and the screen-right one facing SW, so the two face
      // each other with the delivered front-facing art. Hand-tuned until the artist registers seats.
      seats: [{ x: 0.4, y: 2.6, facing: 'se' }, { x: 2.3, y: 0.7, facing: 'sw' }],
    },
    pending: ['talking-se (standing, facing SE) for the meeting scene: walking-se stands in until then'],
  }),
  F('lamp', 'Lampadaire', 'deco', 'floor', { layerBias: 0.1, images: { 'sw@on': P('Office/furniture/lamp@on.png') } }),
  F('whiteboard', 'Tableau blanc', 'mur', 'wall', { wall: { side: 'right', length: 2, elevation: 48 } }),
  F('window', 'Fenêtre', 'mur', 'wall', {
    wall: { side: 'left', length: 2, elevation: 40 },
    images: { 'sw@night': P('Office/furniture/window@night.png') },
  }),
];

const subDirs = ['sage', 'ochre', 'teal'];
const swatch = { sage: '#A8C090', ochre: '#D8A860', teal: '#609090' };
const label = { sage: 'Sauge', ochre: 'Ocre', teal: 'Sarcelle' };

const DEFAULT_GEAR = { sage: [], teal: ['glasses'], ochre: ['cap'] };

const ACC = [
  ['headphones', 'Casque d’écoute', 'head'],
  ['cap', 'Casquette', 'head'],
  ['glasses', 'Lunettes', 'face'],
  ['scarf', 'Foulard', 'neck'],
  ['badge', 'Badge', 'badge'],
];

const manifest = {
  version: 2,
  projection: { kind: 'dimetric-2:1', tileWidth: 96, tileHeight: 48, artScale: 2, wallHeight: 144 },
  pending: [
    'Batch 5b (accessory contract v2): back/front accessory layers per pose and per character/variant, and head landmarks per pose in anchors.json',
    'Seasons hiver / automne: furniture variants (sw@hiver, sw@automne) and decor props (themes[].extras)',
    'Seated idle/sleep poses at the desk (seated-ne, sleeping-ne): idle and offline hold the first typing frame until then',
    'Batch 3: sub-agent portraits (characters.subagent.variants[].portrait)',
    'Night variants beyond window@night and lamp@on (e.g. shelf/plant night tints) if the artist adds them: add images["sw@night"] on the item; the renderer picks them up with no code change',
    ...FAMILIES.filter((f) => !FAMILY_STATUS[f.id].complete).map((f) => `Character family ${f.id} (artist-10): base ${FAMILY_STATUS[f.id].base.covered}/${FAMILY_STATUS[f.id].base.total}, accessory layers ${FAMILY_STATUS[f.id].accessories.covered}/${FAMILY_STATUS[f.id].accessories.total}; joins characters when both are complete`),
  ],
  rooms: [{
    id: 'bureau', label: 'Bureau principal', cols: 12, rows: 10,
    anchor: anchor('Office/room/day.png'),
    size: size('Office/room/day.png'),
    entrance: { x: 6, y: 9 },
    images: { day: P('Office/room/day.png'), night: P('Office/room/night.png') },
  }],
  furniture,
  characters: [
    {
      id: 'timmy', label: 'Robot principal', role: 'main', family: 'bureau-bot',
      canvas: { w: 192, h: 288 }, anchor: anchor('Characters/timmy/idle.png'), scale: 1,
      head: { y: 63 },
      poses: withSeated('Characters/timmy', poseSet('Characters/timmy'), CHAR_BASE),
      landmarks: landmarkSet('Characters/timmy'),
      portrait: P('Characters/timmy/portrait.png'),
    },
    {
      id: 'subagent', label: 'Sous-agent', role: 'subagent', family: 'bureau-bot',
      canvas: { w: 192, h: 288 }, anchor: anchor('Characters/subagent/sage/idle.png'), scale: 0.85, scaleBaked: true,
      head: { y: 95 },
      poses: withSeated('Characters/subagent/sage', poseSet('Characters/subagent/sage'), CHAR_BASE),
      landmarks: landmarkSet('Characters/subagent/sage'),
      variants: subDirs.map((v) => {
        const dir = `Characters/subagent/${v}`;
        // Default gear is data (BRIEF, artist-05): applied only once the variant's sprites are gear-free,
        // which the artist flags with `gearFree: true` on the variant's idle entry in anchors.json.
        const gearFree = A[`${dir}/idle.png`]?.gearFree === true;
        const defaults = A[`${dir}/idle.png`]?.defaultAccessories ?? DEFAULT_GEAR[v];
        return {
          id: v, label: label[v], swatch: swatch[v], poses: withSeated(dir, poseSet(dir), CHAR_BASE), landmarks: landmarkSet(dir),
          ...(gearFree && { gearFree: true, defaultAccessories: defaults }),
        };
      }),
      pending: subDirs.map((v) => P(`Characters/subagent/${v}/portrait.png`)),
    },
    ...READY_FAMILIES.map(familyCharacter),
  ],
  // Delivery coverage of each batched character family (in flux; diagnostics only).
  families: FAMILY_STATUS,
  accessories: ACC.map(([id, lbl, slot]) => ({
    id, label: lbl, slot,
    // v1 single-layer overlays: fallback until Batch 5b (contract v2) delivers back/front layers.
    images: Object.fromEntries(['timmy', 'subagent'].map((k) => [k, poseSet(`Characters/accessories/${id}/${k}`)]).filter(([, v]) => Object.keys(v).length)),
    legacy: true,
    layers: Object.fromEntries(['timmy', 'subagent', ...subDirs.map((v) => `subagent/${v}`), ...READY_FAMILIES.flatMap((f) => f.variants.map(([v]) => `${f.id}/${v}`))]
      .map((k) => [k, layerSet(`Characters/accessories/${id}/${k}`)]).filter(([, v]) => v)),
    pending: [`Batch 5b: assets/Characters/accessories/${id}/{timmy,subagent/<variant>}/<pose>.{back,front}.png`],
  })),
  themes: [
    { id: 'day', label: 'Jour', kind: 'day' },
    {
      id: 'night', label: 'Nuit', kind: 'night',
      room: 'night',
      light: { image: P('Office/light/night.png'), blend: 'multiply', opacity: A['Office/light/night.png'].opacity },
      furnitureVariants: ['night', 'on'],
      monitors: 'on',
    },
    // Seasons (scaffold, O4): layered on top of the resolved day/night theme. Art pending: add
    // furniture images keyed "sw@hiver" / "sw@automne" and decor props in `extras` ({asset, x, y} or
    // {asset, wall, offset}); renderers need no change.
    { id: 'hiver', label: 'Hiver', kind: 'season', furnitureVariants: ['hiver'], extras: [] },
    { id: 'automne', label: 'Automne', kind: 'season', furnitureVariants: ['automne'], extras: [] },
  ],
};
// Batch 5b coverage: every look × delivered pose × accessory must have a v2 layer pair. When complete,
// renderers stop drawing the deprecated v1 overlays by default (scene.legacyAccessories).
{
  const missingV2 = [];
  let total = 0;
  for (const c of manifest.characters) {
    const looks = c.variants?.length ? c.variants.map((v) => [`${c.id}/${v.id}`, v.poses]) : [[c.id, c.poses]];
    for (const [key, poses] of looks) {
      for (const pose of Object.keys(poses)) {
        for (const a of manifest.accessories) {
          total++;
          const has2 = a.layers?.[key]?.[pose] ?? a.layers?.[c.id]?.[pose];
          if (!has2) missingV2.push(`${a.id}:${key}:${pose}`);
        }
      }
    }
  }
  manifest.accessoriesV2 = { complete: missingV2.length === 0, covered: total - missingV2.length, total };
}
/** The manifest built from the art on disk right now (pure: importing this module writes nothing). */
export { manifest };

/** Sections that move while an art batch is being delivered (5b): tests tolerate a lag there. */
export const IN_FLUX = ['accessories', 'accessoriesV2', 'pending', 'families'];

// CLI: write atomically (temp + rename) so a concurrent test never reads a half-written manifest.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = root + 'office/manifest.example.json';
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(tmp, out);
  console.log('ok', furniture.length, 'furniture;', `5b ${manifest.accessoriesV2.covered}/${manifest.accessoriesV2.total};`,
    Object.entries(FAMILY_STATUS).map(([id, s]) => `${id} base ${s.base.covered}/${s.base.total} layers ${s.accessories.covered}/${s.accessories.total}${s.complete ? ' (shipped)' : ''}`).join('; '));
}
