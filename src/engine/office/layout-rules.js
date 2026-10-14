'use strict';
// Authoritative backend layout validation, station allocation and owner appearance rules.
const { footprintFor, footprintTiles } = require('./geometry.js');
const { buildGrid, findPath, nearestWalkable } = require('./pathfind.js');
const SLOT_ORDER = ['body', 'neck', 'face', 'head', 'badge'];

const MAX_ITEMS = 40;
const NAME_MAX = 24;
const ROLE_MAX = 32;
const MAX_ACCESSORIES = 5;
const ROLES = ['main', 'agent', 'subagent', 'cron', 'dm', 'channel'];
/**
 * Station kinds an occupant can call home (auto allocation and explicit `station`), in allocation
 * order: every desk, then every lounge (contract 2.0, data-model §12). Others are destinations only.
 */
const HOME_KINDS = ['desk', 'lounge'];
/** O8: seen-agent presence. Default when the layout says nothing; 0 turns it off; at most a day. */
const PRESENCE_DEFAULT_MINUTES = 30;
const PRESENCE_MAX_MINUTES = 1440;
const presenceMinutes = (layout) => (Number.isInteger(layout?.presence?.seenMinutes) ? layout.presence.seenMinutes : PRESENCE_DEFAULT_MINUTES);

const UID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const key = (t) => `${t.x},${t.y}`;

// ---------- geometry of placed items ----------

/** Tiles an item occupies for collisions: footprint plus station `blocks`. Decals and wall items: none. */
function collisionTiles(item, f) {
  if (!f || f.placement !== 'floor' || item.wall != null) return [];
  const tiles = footprintTiles(item.x, item.y, footprintFor(f.footprint, item.orientation));
  for (const b of f.station?.blocks ?? []) tiles.push({ x: item.x + b.x, y: item.y + b.y });
  return tiles;
}

/** Footprint tiles (what the editor ghost draws), decals included. */
function footprintOf(item, f) {
  if (!f?.footprint || item.wall != null) return [];
  return footprintTiles(item.x, item.y, footprintFor(f.footprint, item.orientation));
}

function wallSpan(item, f) {
  return { from: item.offset, to: item.offset + (f.wall?.length ?? 1) };
}

function wallLength(room, side) {
  return side === 'right' ? room.cols : room.rows;
}

/** Tile a character must reach to use a station: the seated seat when the station has one, else the standing seat. */
function seatTile(item, f) {
  const s = f.station.seated?.seat ?? f.station.seat;
  return { x: Math.floor(item.x + s.x), y: Math.floor(item.y + s.y) };
}

function roomOf(layout, index) {
  return index.rooms.get(layout.room) ?? index.manifest.rooms[0];
}

/** Elevator threshold and a reserved aisle to the room entrance, shared by placement and travel. */
function elevatorAccess(layout, index) {
  const asset = index.furniture.get('elevator-door');
  if (!asset) return null;
  const room = roomOf(layout, index);
  const door = layout.items.find(i => i.asset === asset.id) ?? { wall: asset.wall.side, offset: 0 };
  if (!Number.isInteger(door.offset) || door.offset < 0 || door.offset + asset.wall.length > wallLength(room, door.wall)) return null;
  const along = Math.floor(door.offset + asset.wall.length / 2);
  const cell = door.wall === 'left' ? { x: 0, y: along } : { x: along, y: 0 };
  const entrance = room.entrance ?? { x: 0, y: room.rows - 1 };
  const tiles = [];
  for (let y = Math.min(cell.y, entrance.y); y <= Math.max(cell.y, entrance.y); y++) tiles.push({ x: cell.x, y });
  for (let x = Math.min(cell.x, entrance.x); x <= Math.max(cell.x, entrance.x); x++) tiles.push({ x, y: entrance.y });
  return { cell, tiles };
}

// ---------- names and messages (French by default; the browser installs the active locale) ----------

/** French texts of every reason and message (the server's validation errors stay French, by code). */
const RULES_FR = {
  'placement-kind.wall': 'Se pose sur un mur', 'placement-kind.floor': 'Se pose au sol',
  'wrong-wall.left': 'Se pose sur le mur de gauche', 'wrong-wall.right': 'Se pose sur le mur de droite',
  'outside.wall': 'Hors du mur', outside: 'Hors de la pièce',
  occupied: 'Occupé par {item}', blocks: 'Bloque l’accès au {item}', 'unreachable.self': 'Ce poste serait inaccessible',
  orientation: 'Une seule orientation disponible', 'unknown-asset': 'Élément inconnu',
  'elevator-access': 'Cet emplacement est réservé à l’ascenseur et à son accès.',
  'err.unknown-room': 'Pièce inconnue : {room}', 'err.manifest-version': 'Disposition créée pour une version plus récente des illustrations',
  'err.too-many': '{max} éléments au maximum', 'err.uid': 'Identifiant invalide : {uid}', 'err.duplicate-uid': 'Identifiant en double : {uid}',
  'err.unknown-asset': 'Élément inconnu : {asset}', 'err.placement': '{item} : {reason}',
  'err.unreachable': '{item} n’est pas accessible depuis l’entrée', 'err.no-desk': 'Il faut au moins un poste de travail',
  'err.agent-id': 'Identifiant d’agent invalide : {id}', 'err.duplicate-agent': 'Règle en double : {who}',
  'err.match': '{who} : le type ne correspond pas à l’identifiant', 'err.unknown-character': '{who} : personnage inconnu',
  'err.unknown-variant': '{who} : couleur inconnue', 'err.default-station': '{who} : les règles par défaut utilisent « Automatique »',
  'err.missing-station': 'Le poste choisi pour {who} n’existe plus', 'err.station-kind': '{who} : seuls un poste de travail ou un canapé peuvent être attribués',
  'err.station-taken': '{item} est déjà attribué à {who}', 'err.default-name': '{who} : pas de nom fixe pour une règle par défaut',
  'err.accessories': '{who} : {max} accessoires au maximum', 'err.unknown-accessory': '{who} : accessoire inconnu ({id})',
  'err.slot-conflict': '{who} : un seul accessoire par emplacement', 'err.name-too-long': '{who} : nom de {max} caractères au maximum',
  'err.role-too-long': '{who} : rôle de {max} caractères au maximum', 'err.no-main': 'Il manque la règle de l’agent principal',
  'err.no-default': 'Il manque la règle « Nouveaux sous-agents »', 'err.theme': 'Thème fixe inconnu', 'err.theme-id': 'Thème inconnu : {id}',
  'err.season': 'Saison inconnue : {id}', 'err.presence': 'Durée de présence invalide (de 0 à {max} minutes)', 'err.theme-time': 'Heures de nuit invalides', 'err.theme-time-same': 'Le début et la fin de la nuit doivent différer',
  // keyed by canonical (3.0) rule id; a 2.x id is looked up through canonicalRuleId
  'who.primary': 'l’agent principal', 'who.*subagent': 'Nouveaux sous-agents', 'who.*scheduled': 'Tâches planifiées', 'who.*direct': 'Conversations privées', 'who.*group': 'Salons', 'who.*conversation': 'Conversations',
  deskOf: 'Poste de {name}', deskOfInner: 'poste de {name}',
};
const fill = (tpl, params = {}) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
const FR_TEXT = { msg: (key, params) => fill(RULES_FR[key] ?? key, params), label: (obj) => obj?.label ?? obj?.id ?? '' };
let text = FR_TEXT;
/** Installs the UI locale's texts: { msg(key, params), label(manifestEntry, kind) }. Omitted → French. */
function setRuleText(t) { text = t ? { ...FR_TEXT, ...t } : FR_TEXT; }
const T = (key, params) => text.msg(key, params);

/** « Poste de <nom> » when an explicit agent rule names the desk, else the custom or manifest label. */
function itemName(layout, index, uid, { article = false } = {}) {
  const it = layout.items.find((i) => i.uid === uid);
  if (!it) return '';
  if (it.label) return it.label;
  const f = index.furniture.get(it.asset);
  const agent = layout.agents.find((a) => a.station === uid && a.name);
  if (f?.station?.kind === 'desk' && agent) return T(article ? 'deskOfInner' : 'deskOf', { name: agent.name });
  const label = f ? text.label(f, 'furniture') : it.asset;
  return article ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

// ---------- reachability ----------

/** uids of stations whose seat can't be reached from the room entrance. */
function unreachableStations(layout, index) {
  const room = roomOf(layout, index);
  const floor = layout.items.filter((i) => i.wall == null);
  const grid = buildGrid(room.cols, room.rows, floor, index.furniture);
  const e = room.entrance ?? { x: 0, y: room.rows - 1 };
  const start = nearestWalkable(grid, e.x, e.y);
  const bad = [];
  for (const it of floor) {
    const f = index.furniture.get(it.asset);
    if (!f?.station) continue;
    const s = seatTile(it, f);
    const inside = s.x >= 0 && s.y >= 0 && s.x < room.cols && s.y < room.rows;
    if (!start || !inside || !findPath(grid, start, s)) bad.push(it.uid);
  }
  return bad;
}

// ---------- placement check (editor ghost) ----------

/**
 * Can `cand` go there? cand = { uid?, asset, x, y, orientation? } or { uid?, asset, wall, offset }.
 * `uid` (moving an existing item) is ignored as an obstacle.
 * @returns {{ ok: boolean, code: string|null, reason: string|null, tiles: {x,y}[] }}
 */
function checkPlacement(layout, index, cand) {
  const room = roomOf(layout, index);
  const f = index.furniture.get(cand.asset);
  if (!f) return { ok: false, code: 'unknown-asset', reason: T('unknown-asset'), tiles: [] };
  const others = layout.items.filter((i) => i.uid !== cand.uid);
  const isWallCand = cand.wall != null;
  if ((f.placement === 'wall') !== isWallCand) return { ok: false, code: 'placement-kind', reason: T(f.placement === 'wall' ? 'placement-kind.wall' : 'placement-kind.floor'), tiles: [] };

  if (f.placement === 'wall') {
    const side = cand.wall;
    const span = wallSpan(cand, f);
    if (f.wall?.side && f.wall.side !== side) return { ok: false, code: 'wrong-wall', reason: T(`wrong-wall.${f.wall.side === 'left' ? 'left' : 'right'}`), tiles: [] };
    if (!Number.isInteger(cand.offset) || span.from < 0 || span.to > wallLength(room, side)) return { ok: false, code: 'outside', reason: T('outside.wall'), tiles: [] };
    for (const o of others) {
      if (o.wall !== side) continue;
      const of = index.furniture.get(o.asset);
      if (!of) continue;
      const os = wallSpan(o, of);
      if (span.from < os.to && os.from < span.to) return { ok: false, code: 'occupied', reason: T('occupied', { item: itemName(layout, index, o.uid, { article: true }) }), tiles: [] };
    }
    if (cand.asset === 'elevator-door') {
      const reserved = new Set(elevatorAccess({ ...layout, items: [...others, cand] }, index).tiles.map(key));
      if (others.some(o => collisionTiles(o, index.furniture.get(o.asset)).some(t => reserved.has(key(t))))) {
        return { ok: false, code: 'elevator-access', reason: T('elevator-access'), tiles: [] };
      }
    }
    return { ok: true, code: null, reason: null, tiles: [] };
  }

  const orientation = cand.orientation ?? 'sw';
  if (!(f.orientations ?? ['sw']).includes(orientation)) return { ok: false, code: 'orientation', reason: T('orientation'), tiles: [] };
  const tiles = footprintOf(cand, f);
  const coll = collisionTiles(cand, f);
  for (const t of [...tiles, ...coll]) {
    if (t.x < 0 || t.y < 0 || t.x >= room.cols || t.y >= room.rows) return { ok: false, code: 'outside', reason: T('outside'), tiles };
  }
  const reserved = new Set((elevatorAccess(layout, index)?.tiles ?? []).map(key));
  if ([...tiles, ...coll].some(t => reserved.has(key(t)))) return { ok: false, code: 'elevator-access', reason: T('elevator-access'), tiles };
  if (f.placement === 'decal') return { ok: true, code: null, reason: null, tiles };

  const occ = new Map();
  for (const o of others) for (const t of collisionTiles(o, index.furniture.get(o.asset))) occ.set(key(t), o.uid);
  for (const t of coll) {
    const hit = occ.get(key(t));
    if (hit) return { ok: false, code: 'occupied', reason: T('occupied', { item: itemName(layout, index, hit, { article: true }) }), tiles };
  }
  for (const o of others) {
    const of = index.furniture.get(o.asset);
    if (o.wall != null || !of?.station) continue;
    const s = seatTile(o, of);
    if (coll.some((t) => t.x === s.x && t.y === s.y)) return { ok: false, code: 'blocks', reason: T('blocks', { item: itemName(layout, index, o.uid, { article: true }) }), tiles };
  }
  const ghost = cand.uid ?? '__ghost__';
  const before = new Set(unreachableStations(layout, index));
  const next = { ...layout, items: [...others, { ...cand, uid: ghost }] };
  for (const uid of unreachableStations(next, index)) {
    if (uid === ghost) return { ok: false, code: 'unreachable', reason: T('unreachable.self'), tiles };
    if (!before.has(uid)) return { ok: false, code: 'blocks', reason: T('blocks', { item: itemName(layout, index, uid, { article: true }) }), tiles };
  }
  return { ok: true, code: null, reason: null, tiles };
}

// ---------- the semantic validator (save = PUT) ----------

// ---------- rule vocabularies (ADR-001 §12.6) ----------
// 2.x and 3.0 name the same roles differently; both are accepted everywhere, and compared in their canonical (3.0)
// form: main ≡ primary, cron ≡ scheduled, dm ≡ direct, channel ≡ group; subagent is unchanged; conversation is new
// in 3.0 (its default rule *conversation also styles direct and group occupants that have no rule of their own).
const CANON = { main: 'primary', primary: 'primary', cron: 'scheduled', scheduled: 'scheduled', dm: 'direct', direct: 'direct',
  channel: 'group', group: 'group', agent: 'agent', subagent: 'subagent', conversation: 'conversation' };
const LEGACY = { primary: 'main', agent: 'agent', scheduled: 'cron', direct: 'dm', group: 'channel', subagent: 'subagent' };   // 3.0 → 2.x (no 2.x name for conversation)
const CONVERSATION_ROLES = ['direct', 'group', 'conversation'];
/** A role in its canonical (3.0) form, or null when it isn't a role of either vocabulary. */
const canonicalRole = (role) => CANON[role] ?? null;
/** A rule id or OccupantId in canonical form: 'main' → 'primary', '*cron' → '*scheduled', 'dm:42' → 'direct:42'. */
function canonicalRuleId(id) {
  if (typeof id !== 'string') return null;
  if (id === 'main' || id === 'primary') return 'primary';
  if (id.startsWith('*')) { const r = CANON[id.slice(1)]; return r && r !== 'primary' ? `*${r}` : null; }
  const i = id.indexOf(':');
  if (i < 1) return null;
  const r = CANON[id.slice(0, i)];
  const subject=id.slice(i+1), scoped=/^rt:[a-z][a-z0-9-]{0,31}:(agent|session|flow):[A-Za-z0-9_-]{1,5462}$/.test(subject);
  return r && r !== 'primary' && (/^[^\s]{1,128}$/.test(subject) || scoped) ? `${r}:${subject}` : null;
}

/** Agent rule kinds: 'main' (the primary agent, under either name), an exact OccupantId ('subagent:<id>',
 *  'dm:<id>' / 'direct:<id>', …) or a default rule '*<role>'. Either vocabulary. */
function ruleKind(agentId) {
  const c = canonicalRuleId(agentId);
  if (!c) return null;
  if (c === 'primary') return 'main';
  return c.startsWith('*') ? 'default' : 'exact';
}

/** The role a rule applies to, canonical (3.0): 'primary', 'subagent', 'scheduled', 'direct', 'group', 'conversation'. */
function roleOfRule(rule) {
  const c = canonicalRuleId(rule.agentId);
  if (!c) return null;
  if (c === 'primary') return 'primary';
  return c.startsWith('*') ? c.slice(1) : c.split(':')[0];
}

/**
 * The layout with its rules written in one vocabulary: '3.0' (primary, *scheduled, direct:…) or '2.x' (main, *cron, dm:…).
 * Pure; ids, match kinds and nothing else change. A '*conversation' rule has no 2.x name and is kept as is.
 * The server normalises a layout to 3.0 on save with this, and serves it in the caller's contract version.
 */
function toVocabulary(layout, version = '3.0') {
  const to = (canon) => (version === '2.x' ? (canon === 'primary' ? 'main' : canon.replace(/^(\*?)([a-z]+)/, (m, star, r) => star + (LEGACY[r] ?? r))) : canon);
  return { ...layout, agents: layout.agents.map((a) => {
    const c = canonicalRuleId(a.agentId);
    if (!c) return a;
    const out = { ...a, agentId: to(c) };
    if (a.match && a.match.kind) out.match = { ...a.match, kind: version === '2.x' ? (LEGACY[canonicalRole(a.match.kind)] ?? a.match.kind) : (canonicalRole(a.match.kind) ?? a.match.kind) };
    return out;
  }) };
}

/**
 * Every rule a layout must satisfy to be saved (api-proposal.md §3). The JSON Schema only checks shape.
 * @returns {{ code: string, uid?: string, agentId?: string, message: string }[]} empty = valid
 */
function validateLayout(layout, index, { allowNoDesk = false } = {}) {
  const errors = [];
  const err = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const room = index.rooms.get(layout.room);
  if (!room) { err('unknown-room', T('err.unknown-room', { room: layout.room })); return errors; }
  if (layout.manifestVersion > index.manifest.version) err('manifest-version', T('err.manifest-version'));
  if (layout.items.length > MAX_ITEMS) err('too-many', T('err.too-many', { max: MAX_ITEMS }));

  // items
  const uids = new Set();
  for (const it of layout.items) {
    if (!UID_RE.test(it.uid ?? '')) err('uid', T('err.uid', { uid: it.uid }), { uid: it.uid });
    if (uids.has(it.uid)) err('duplicate-uid', T('err.duplicate-uid', { uid: it.uid }), { uid: it.uid });
    uids.add(it.uid);
    if (!index.furniture.has(it.asset)) { err('unknown-asset', T('err.unknown-asset', { asset: it.asset }), { uid: it.uid }); continue; }
    const c = checkPlacement({ ...layout, items: layout.items.filter((o) => o !== it) }, index, it);
    if (!c.ok && c.code !== 'blocks' && c.code !== 'unreachable') err(c.code, T('err.placement', { item: itemName(layout, index, it.uid), reason: c.reason }), { uid: it.uid });
  }
  for (const uid of unreachableStations(layout, index)) err('unreachable', T('err.unreachable', { item: itemName(layout, index, uid) }), { uid });
  if (!allowNoDesk && !layout.items.some((i) => i.wall == null && index.furniture.get(i.asset)?.station?.kind === 'desk')) err('no-desk', T('err.no-desk'));

  // agents
  const ids = new Set();
  const fixedDesks = new Map();
  for (const a of layout.agents) {
    const kind = ruleKind(a.agentId);
    const who = displayRule(a);
    if (!kind) { err('agent-id', T('err.agent-id', { id: a.agentId }), { agentId: a.agentId }); continue; }
    // Duplicates are compared canonically: 'main' and 'primary' are the same rule (ADR §12.6).
    const canon = canonicalRuleId(a.agentId);
    if (ids.has(canon)) err('duplicate-agent', T('err.duplicate-agent', { who }), { agentId: a.agentId });
    ids.add(canon);
    const role = roleOfRule(a);
    if (a.match && canonicalRole(a.match.kind) !== role) err('match', T('err.match', { who }), { agentId: a.agentId });
    const ch = index.characters.get(a.character);
    if (!ch) err('unknown-character', T('err.unknown-character', { who }), { agentId: a.agentId });
    else if (a.variant != null && !ch.variants?.some((v) => v.id === a.variant)) err('unknown-variant', T('err.unknown-variant', { who }), { agentId: a.agentId });
    const st = a.station ?? 'auto';
    if (st !== 'auto') {
      if (kind === 'default') err('default-station', T('err.default-station', { who }), { agentId: a.agentId });
      const item = layout.items.find((i) => i.uid === st);
      const sf = item && index.furniture.get(item.asset);
      if (!item || !sf?.station) err('missing-station', T('err.missing-station', { who }), { agentId: a.agentId });
      else if (!HOME_KINDS.includes(sf.station.kind)) err('station-kind', T('err.station-kind', { who }), { agentId: a.agentId });
      else if (fixedDesks.has(st)) err('station-taken', T('err.station-taken', { item: itemName(layout, index, st), who: fixedDesks.get(st) }), { agentId: a.agentId });
      else fixedDesks.set(st, who);
    }
    if (kind === 'default' && a.name) err('default-name', T('err.default-name', { who }), { agentId: a.agentId });
    if (a.accessories != null) {
      if (a.accessories.length > MAX_ACCESSORIES) err('accessories', T('err.accessories', { who, max: MAX_ACCESSORIES }), { agentId: a.agentId });
      const slots = new Set();
      for (const id of a.accessories) {
        const acc = index.accessories.get(id);
        if (!acc) { err('unknown-accessory', T('err.unknown-accessory', { who, id }), { agentId: a.agentId }); continue; }
        if (slots.has(acc.slot)) err('slot-conflict', T('err.slot-conflict', { who }), { agentId: a.agentId });
        slots.add(acc.slot);
      }
    }
    if ((a.name ?? '').length > NAME_MAX) err('name-too-long', T('err.name-too-long', { who, max: NAME_MAX }), { agentId: a.agentId });
    if ((a.role ?? '').length > ROLE_MAX) err('role-too-long', T('err.role-too-long', { who, max: ROLE_MAX }), { agentId: a.agentId });
  }
  if (!ids.has('primary')) err('no-main', T('err.no-main'));
  if (!ids.has('*subagent')) err('no-default', T('err.no-default'));

  // theme
  const t = layout.theme ?? {};
  const theme = (id) => index.themes.get(id);
  if (t.mode === 'fixed' && (!theme(t.fixed) || theme(t.fixed).kind === 'season')) err('theme', T('err.theme'));
  if (t.mode === 'auto') {
    if (!HHMM_RE.test(t.nightFrom ?? '19:00') || !HHMM_RE.test(t.nightTo ?? '07:00')) err('theme-time', T('err.theme-time'));
    else if ((t.nightFrom ?? '19:00') === (t.nightTo ?? '07:00')) err('theme-time', T('err.theme-time-same'));
    for (const k of ['day', 'night']) if (t[k] && !theme(t[k])) err('theme', T('err.theme-id', { id: t[k] }));
  }
  if (t.season != null && theme(t.season)?.kind !== 'season') err('theme', T('err.season', { id: t.season }));

  // presence (O8, 3.0): how long an agent seen recently stays at its desk after its last activity. Optional.
  if (layout.presence != null) {
    const m = layout.presence.seenMinutes;
    if (typeof layout.presence !== 'object' || !Number.isInteger(m) || m < 0 || m > PRESENCE_MAX_MINUTES) err('presence', T('err.presence', { max: PRESENCE_MAX_MINUTES }));
  }
  return errors;
}

function displayRule(a) {
  if (a.name) return a.name;
  const c = canonicalRuleId(a.agentId);
  return c && RULES_FR[`who.${c}`] != null ? T(`who.${c}`) : a.agentId;
}

/** Home stations in allocation order (desks in layout order, then lounges): their count is the seated capacity. */
function homeStations(layout, index) {
  const kindOf = (i) => (i.wall == null ? index.furniture.get(i.asset)?.station?.kind : null);
  return HOME_KINDS.flatMap((k) => layout.items.filter((i) => kindOf(i) === k).map((i) => i.uid));
}

// ---------- resolution (the server's OfficeVM uses the same algorithm) ----------

/** The rule styling an occupant: exact OccupantId, then '*<role>', then (conversation roles) '*conversation', then
 *  '*subagent'; the primary has no fallback. Ids and roles may use either vocabulary (ADR §12.6). */
function ruleFor(layout, occupantId, role) {
  const want = canonicalRuleId(occupantId);
  const r = canonicalRole(role) ?? role;
  const find = (id) => layout.agents.find((a) => canonicalRuleId(a.agentId) === id);
  if (r === 'primary' || want === 'primary') return (want && find(want)) ?? null;
  return (want && find(want)) ?? find(`*${r}`) ?? (CONVERSATION_ROLES.includes(r) ? find('*conversation') : null) ?? find('*subagent') ?? null;
}

/** Gear a variant wears by default (manifest variants[].defaultAccessories; gear-free sprites). */
function defaultAccessoriesFor(index, characterId, variantId) {
  const c = index.characters.get(characterId);
  const v = c?.variants?.find((x) => x.id === variantId);
  return v?.defaultAccessories ?? c?.defaultAccessories ?? [];
}

/** Untouched seeds use auto; owner edits use manual. */
function automaticAppearance(rule) {
  if (!rule) return true;
  if (rule.appearance != null) return rule.appearance === 'auto';
  const id = canonicalRuleId(rule.agentId);
  if (id === 'primary') return rule.character === 'timmy' && rule.variant == null && !rule.name && !rule.role
    && rule.accessories?.length === 1 && rule.accessories[0] === 'headphones';
  const seeded = { '*subagent': 'teal', '*scheduled': 'ochre', '*direct': 'sage', '*group': 'sage' };
  return Object.hasOwn(seeded, id) && rule.character === 'subagent' && rule.variant === seeded[id] && rule.accessories == null;
}

/** Resolve names, LabelRefs, saved/manual looks and home stations in roster order; null station means overflow. */
function resolveOccupants(layout, index, sources, { assignLook, stationAssignments = null, reservedStationUids = [] } = {}) {
  const seq = new Map();
  const out = sources.map((o) => {
    const r = ruleFor(layout, o.layoutRuleId || o.id, o.role);
    // Browsers reuse saved looks.
    const automaticLook = assignLook ? assignLook(o.appearanceId ?? o.id, index, { primary: canonicalRole(o.role) === 'primary' }) : o.automaticLook;
    const isPrimary = canonicalRole(o.role) === 'primary';
    const fallbackChar = isPrimary ? index.manifest.characters.find((c) => c.role === 'main') : index.manifest.characters.find((c) => c.role === 'subagent');
    const ch = (r && index.characters.get(r.character)) ?? fallbackChar ?? index.manifest.characters[0];
    let variant = r?.variant ?? null;
    if (r && ruleKind(r.agentId) === 'default' && ch.variants?.length) {
      // Default rules rotate through the variants, starting at the rule's variant, by order of appearance.
      const n = seq.get(r.agentId) ?? 0;
      seq.set(r.agentId, n + 1);
      const start = Math.max(0, ch.variants.findIndex((v) => v.id === r.variant));
      variant = ch.variants[(start + n) % ch.variants.length].id;
    }
    if (variant && !ch.variants?.some((v) => v.id === variant)) variant = null;
    // Omitted accessories = the variant's default gear; an explicit [] = none.
    const accessories = r?.accessories != null ? [...r.accessories] : [...defaultAccessoriesFor(index, ch.id, variant)];
    const exact = r && ruleKind(r.agentId) !== 'default';
    return {
      id: o.id, role: o.role,
      name: (exact && r.name) || o.sourceName,
      // A layout role text applies to the occupants its rule is for: a conversation that falls back to '*subagent' keeps
      // its own role label (« Interlocuteur »), not the sub-agents' text.
      roleLabel: r?.role && !(CONVERSATION_ROLES.includes(canonicalRole(o.role)) && canonicalRuleId(r.agentId) === '*subagent')
        ? { key: 'custom', params: { text: r.role } } : { key: `occupantRole.${o.role}` },
      ruleId: r?.agentId ?? null,
      look: automaticLook && automaticAppearance(r) ? automaticLook : { character: ch.id, variant, accessories },
      ...(automaticLook && { automaticLook }),
      stationUid: null,
      _explicitWant: exact && r.station && r.station !== 'auto' ? r.station : null,
      _savedWant: typeof stationAssignments?.[o.id] === 'string' ? stationAssignments[o.id] : null,
    };
  });
  // Owner-authored layout choices outrank private saved pins. Active pins then
  // outrank reservations for temporarily absent members, and only then do new
  // occupants take automatic seats. This keeps a returning teammate's seat
  // from being consumed during a short source outage.
  const desks = homeStations(layout, index);
  const taken = new Set();
  const sourceById = new Map(sources.map(row => [row.id, row]));
  const active = row => !['unknown', 'idle', 'offline'].includes(sourceById.get(row.id)?.state);
  const stationOrder = [...out].sort((a, b) => {
    const activeOrder = Number(active(b)) - Number(active(a));
    if (activeOrder) return activeOrder;
    if (!active(a)) {
      const idleSinceA = sourceById.get(a.id)?.stateSince;
      const idleSinceB = sourceById.get(b.id)?.stateSince;
      if (Number.isFinite(idleSinceA) && Number.isFinite(idleSinceB) && idleSinceA !== idleSinceB)
        return idleSinceB - idleSinceA; // Keep the most recently idle occupants seated first.
    }
    return (canonicalRuleId(a.id) ?? a.id).localeCompare(canonicalRuleId(b.id) ?? b.id);
  });
  const activeOrder = stationOrder.filter(active), inactiveOrder = stationOrder.filter(row => !active(row));
  const homeOwnerByStation = new Map();
  // Authored choices outrank saved claims. This keeps an idle row's stale pin
  // from becoming a competing home for a station explicitly assigned in the
  // layout. For duplicate saved homes, the most recently idle claimant wins.
  for (const o of stationOrder) if (typeof o._explicitWant === 'string' && desks.includes(o._explicitWant)
    && !homeOwnerByStation.has(o._explicitWant)) homeOwnerByStation.set(o._explicitWant, o.id);
  for (const o of inactiveOrder) if (typeof o._savedWant === 'string' && desks.includes(o._savedWant)
    && !homeOwnerByStation.has(o._savedWant)) homeOwnerByStation.set(o._savedWant, o.id);
  for (const o of activeOrder) if (typeof o._savedWant === 'string' && desks.includes(o._savedWant)
    && !homeOwnerByStation.has(o._savedWant)) homeOwnerByStation.set(o._savedWant, o.id);
  for (const field of ['_explicitWant', '_savedWant']) {
    for (const o of activeOrder) if (!o.stationUid && o[field] && desks.includes(o[field]) && !taken.has(o[field])
      && homeOwnerByStation.get(o[field]) === o.id) {
      o.stationUid = o[field]; taken.add(o[field]);
    }
  }
  // Keep an idle occupant's explicitly or privately assigned home station when
  // spare desks remain after every active occupant has a workstation. Under
  // genuine pressure active workers may borrow that station; `_homeWant`
  // below still preserves the owner's return target.
  let activeNeeds = activeOrder.filter(o => !o.stationUid).length;
  for (const field of ['_explicitWant', '_savedWant']) {
    for (const o of inactiveOrder) {
      if (o.stationUid || !o[field] || !desks.includes(o[field]) || taken.has(o[field])
        || homeOwnerByStation.get(o[field]) !== o.id) continue;
      const free = desks.reduce((count, uid) => count + Number(!taken.has(uid)), 0);
      if (free <= activeNeeds) continue;
      o.stationUid = o[field]; taken.add(o[field]);
    }
  }
  // Allocate working occupants before idle occupants' preferences/pins. If a
  // desk is scarce, active display states always retain a workstation.
  for (const o of activeOrder) if (!o.stationUid) {
    const d = desks.find(u => !taken.has(u));
    if (d) {
      o.stationUid = d; taken.add(d);
      if (homeOwnerByStation.has(d) && homeOwnerByStation.get(d) !== o.id) o._borrowedHome = true;
    }
  }
  for (const uid of [...new Set(reservedStationUids)].sort()) if (desks.includes(uid) && !taken.has(uid)) taken.add(uid);
  // Decide which idle/unknown occupants remain seated before honoring saved
  // preferences. Otherwise a lexically earlier old pin can consume the only
  // free desk and evict a more recently idle occupant, defeating longest-idle
  // relocation. The source state is the displayed canonical state; runtime
  // bookkeeping flags do not override it.
  const inactiveSurvivors = [...inactiveOrder.filter(o => o.stationUid),
    ...inactiveOrder.filter(o => !o.stationUid).slice(0, desks.filter(uid => !taken.has(uid)).length)];
  const survivingIds = new Set(inactiveSurvivors.map(o => o.id));
  for (const field of ['_explicitWant', '_savedWant']) {
    for (const o of inactiveSurvivors) if (!o.stationUid && o[field] && desks.includes(o[field]) && !taken.has(o[field])
      && homeOwnerByStation.get(o[field]) === o.id) {
      o.stationUid = o[field]; taken.add(o[field]);
    }
  }
  for (const o of inactiveSurvivors) {
    if (!o.stationUid) {
      const d = desks.find((u) => !taken.has(u));
      if (d) { o.stationUid = d; taken.add(d); }
    }
  }
  for (const o of inactiveOrder) {
    if (!survivingIds.has(o.id)) o.stationUid = null;
    const savedWant = typeof o._savedWant === 'string' && desks.includes(o._savedWant)
      && homeOwnerByStation.get(o._savedWant) === o.id ? o._savedWant : null;
    const explicitWant = typeof o._explicitWant === 'string' && homeOwnerByStation.get(o._explicitWant) === o.id ? o._explicitWant : null;
    o._homeWant = [explicitWant, savedWant].find(uid => typeof uid === 'string' && desks.includes(uid))
      || (o._borrowedHome ? null : o.stationUid);
    delete o._explicitWant;
    delete o._savedWant;
  }
  for (const o of activeOrder) {
    const savedWant = typeof o._savedWant === 'string' && desks.includes(o._savedWant)
      && homeOwnerByStation.get(o._savedWant) === o.id ? o._savedWant : null;
    const explicitWant = typeof o._explicitWant === 'string' && homeOwnerByStation.get(o._explicitWant) === o.id ? o._explicitWant : null;
    // A stale duplicate pin is only a preference. Once allocation gives this
    // active row another station, its physical/home target must follow the
    // station it actually owns; otherwise two occupants can render at one desk.
    o._homeWant = [explicitWant, savedWant].find(uid => typeof uid === 'string' && desks.includes(uid) && uid === o.stationUid)
      || (o._borrowedHome ? null : o.stationUid);
    delete o._explicitWant;
    delete o._savedWant;
  }
  return out;
}

/** Accessories in draw/slot order. */
function sortAccessories(index, ids) {
  return [...ids].sort((a, b) => SLOT_ORDER.indexOf(index.accessories.get(a)?.slot) - SLOT_ORDER.indexOf(index.accessories.get(b)?.slot));
}

module.exports = { MAX_ITEMS, NAME_MAX, ROLE_MAX, MAX_ACCESSORIES, ROLES, HOME_KINDS, PRESENCE_DEFAULT_MINUTES, PRESENCE_MAX_MINUTES, presenceMinutes, collisionTiles, footprintOf, wallSpan, wallLength, seatTile, roomOf, elevatorAccess, RULES_FR, setRuleText, itemName, unreachableStations, checkPlacement, canonicalRole, canonicalRuleId, ruleKind, roleOfRule, toVocabulary, validateLayout, homeStations, ruleFor, defaultAccessoriesFor, automaticAppearance, resolveOccupants, sortAccessories };
