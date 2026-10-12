// Décor packs keep raster and provenance metadata outside the initial office payload.
export const DECOR_BUDGETS = Object.freeze({ metadata: 32768, sprite: 65536, thumbnail: 8192, pack: 1048576 });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const slug = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v);
const names = v => object(v) && ['fr', 'en'].every(k => typeof v[k] === 'string' && v[k].trim().length > 0 && v[k].length <= 100);
const point = v => object(v) && Number.isFinite(v.x) && Number.isFinite(v.y);
const extent = v => object(v) && Number.isInteger(v.w) && Number.isInteger(v.h) && v.w > 0 && v.h > 0 && v.w <= 1024 && v.h <= 1024;
export const decorPath = v => typeof v === 'string' && /^[a-zA-Z0-9_@./-]+\.webp$/.test(v) && !v.startsWith('/') && !v.split('/').some(p => ['.', '..', ''].includes(p));
export function checkDecorPack(pack, { id = pack?.id, metadataBytes = new TextEncoder().encode(JSON.stringify(pack)).length } = {}) {
  const errors = [];
  const check = (ok, msg) => { if (!ok) errors.push(msg); };
  if (!object(pack)) return { ok: false, errors: ['decor pack must be an object'] };
  check(metadataBytes <= DECOR_BUDGETS.metadata, 'decor metadata exceeds budget');
  check(pack.schemaVersion === 1 && pack.contract === 'bureau-decor-v1' && pack.artScale === 2, 'decor contract/schema/artScale invalid');
  check(slug(pack.id) && pack.id === id && names(pack.names), 'decor pack identity/names invalid');
  check(typeof pack.license === 'string' && pack.license.length > 0, 'decor license required');
  check(pack.provenance?.tool === 'image_gen.imagegen' && typeof pack.provenance?.sources === 'string', 'decor provenance required');
  if (!Array.isArray(pack.items) || !pack.items.length || pack.items.length > 12) return { ok: false, errors: [...errors, 'decor items must contain 1..12 items'] };
  const ids = new Set();
  for (const f of pack.items) {
    if (!object(f)) { errors.push('decor item must be an object'); continue; }
    check(slug(f.id) && !ids.has(f.id) && names(f.names), 'decor item identity/names invalid'); ids.add(f.id);
    check(['poste', 'assise', 'rangement', 'deco', 'plante', 'equipement', 'mur', 'sol'].includes(f.category), f.id + ': invalid category');
    check(['floor', 'decal', 'wall'].includes(f.placement), f.id + ': invalid placement');
    check(extent(f.size) && point(f.anchor) && f.anchor.x >= 0 && f.anchor.y >= 0 && f.anchor.x <= f.size?.w && f.anchor.y <= f.size?.h, f.id + ': size/anchor invalid');
    check(Number.isFinite(f.layerBias) && Math.abs(f.layerBias) <= 1, f.id + ': layerBias required');
    check(decorPath(f.image) && decorPath(f.thumbnail) && extent(f.thumbnailSize) && f.thumbnailSize.w <= 144 && f.thumbnailSize.h <= 144, f.id + ': image/thumbnail invalid');
    check(Array.isArray(f.orientations) && f.orientations.length >= 1 && f.orientations.length <= 2 && f.orientations[0] === 'sw' && new Set(f.orientations).size === f.orientations.length && f.orientations.every(o => ['sw', 'se'].includes(o)), f.id + ': orientations invalid');
    if (f.placement === 'wall') check(['left', 'right'].includes(f.wall?.side) && Number.isInteger(f.wall?.length) && f.wall.length > 0 && f.wall.length <= 6 && Number.isFinite(f.wall?.elevation) && f.wall.elevation >= 0 && f.wall.elevation <= 144, f.id + ': wall invalid');
    else check(Number.isInteger(f.footprint?.w) && Number.isInteger(f.footprint?.d) && f.footprint.w > 0 && f.footprint.d > 0 && f.footprint.w <= 6 && f.footprint.d <= 6, f.id + ': footprint invalid');
    check(object(f.images) && decorPath(f.images?.['sw@night']), f.id + ': night image required');
    for (const [key, file] of Object.entries(f.images ?? {})) check(/^(sw|se)(@night)?$/.test(key) && decorPath(file), f.id + ': variant invalid');
    if (f.orientations?.includes('se')) check(decorPath(f.images?.se) && decorPath(f.images?.['se@night']), f.id + ': se variants required');
  }
  return { ok: !errors.length, errors };
}
export function decorDescriptors(pack, base) {
  return pack.items.map(f => ({ id: f.id, label: f.names.fr, names: f.names, category: f.category, placement: f.placement,
    ...(f.footprint && { footprint: f.footprint }), ...(f.wall && { wall: f.wall }), ...(f.walkable && { walkable: true }),
    anchor: f.anchor, size: f.size, layerBias: f.layerBias, orientations: f.orientations,
    image: base + f.thumbnail, thumbnail: base + f.thumbnail, packId: pack.id, packManifest: base + 'manifest.json' }));
}
export function installDecorPack(index, pack, base) {
  const expected = [...index.furniture.values()].filter(f => f.packId === pack.id);
  if (expected.length !== pack.items.length || expected.some(f => !pack.items.some(item => item.id === f.id))) throw Error('decor pack membership mismatch');
  const updates = pack.items.map(f => {
    const known = index.furniture.get(f.id);
    if (!known || known.packId !== pack.id || known.packManifest !== base + 'manifest.json') throw Error('decor pack item does not match enabled registry: ' + f.id);
    // Geometry is authoritative in the thin registry (also used by the server).
    const [descriptor] = decorDescriptors({ ...pack, items: [f] }, base);
    for (const key of ['names', 'category', 'placement', 'footprint', 'wall', 'walkable', 'anchor', 'size', 'layerBias', 'orientations']) {
      if (JSON.stringify(known[key]) !== JSON.stringify(descriptor[key])) throw Error('decor registry geometry mismatch: ' + f.id + '/' + key);
    }
    return { ...descriptor, packLoaded: true, image: base + f.image, images: Object.fromEntries(Object.entries(f.images).map(([k,v]) => [k,base + v])) };
  });
  // Validate the complete pack before any mutation; failures cannot partly install it.
  updates.forEach(f => index.furniture.set(f.id, f));
  return updates;
}
