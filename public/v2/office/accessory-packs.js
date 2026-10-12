// Shared art contract. Fitting records are authored in source-canvas coordinates.
export const ACCESSORY_BUDGETS = Object.freeze({ metadata: 262144, sprite: 32768, thumbnail: 8192, pack: 1048576 });
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const slug = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x);
const key = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}(\/[a-z][a-z0-9-]{0,63})?$/.test(x);
const finite = x => Number.isFinite(x) && Math.abs(x) <= 512;
const point = x => Array.isArray(x) && x.length === 2 && x.every(finite);
const size = x => point(x) && x.every(n => Number.isInteger(n) && n > 0 && n <= 160);
export const accessoryPath = x => typeof x === 'string' && /^[a-z][a-z0-9-]*\.webp$/.test(x);
export function checkAccessoryPack(pack, { id = pack?.id, metadataBytes = new TextEncoder().encode(JSON.stringify(pack)).length } = {}) {
  const errors = [], check = (ok, msg) => { if (!ok) errors.push(msg); };
  if (!object(pack)) return { ok: false, errors: ['accessory pack must be an object'] };
  check(metadataBytes <= ACCESSORY_BUDGETS.metadata, 'accessory metadata exceeds budget');
  check(pack.schemaVersion === 1 && pack.contract === 'bureau-accessory-v1' && pack.artScale === 2 && JSON.stringify(pack.canvas) === '[192,288]', 'accessory contract/canvas invalid');
  check(slug(pack.id) && pack.id === id && typeof pack.license === 'string' && pack.license.length > 0, 'accessory identity/license invalid');
  if (!Array.isArray(pack.items) || pack.items.length < 1 || pack.items.length > 15) return { ok: false, errors: [...errors, 'accessory items must contain 1..15 items'] };
  const ids = new Set();
  for (const a of pack.items) {
    if (!object(a)) { errors.push('accessory item must be an object'); continue; }
    check(slug(a.id) && !ids.has(a.id), 'accessory id invalid/duplicate'); ids.add(a.id);
    check(['fr','en'].every(l => typeof a.names?.[l] === 'string' && a.names[l].trim().length > 0 && a.names[l].length <= 100), 'accessory names invalid');
    check(['head','neck','face'].includes(a.slot), 'accessory slot invalid');
    check(accessoryPath(a.thumbnail) && size(a.thumbnailSize) && a.thumbnailSize.every(n => n <= 64), 'accessory thumbnail invalid');
    check(['head','neck','eye','ears'].includes(a.fit?.kind) && Number.isFinite(a.fit.width) && a.fit.width > 0 && a.fit.width <= 1.2 && Number.isFinite(a.fit.offset) && Math.abs(a.fit.offset) <= .5 && typeof a.fit.hideRear === 'boolean', 'accessory fit invalid');
    for (const d of ['sw','se','ne','nw']) {
      const v = a.views?.[d];
      check(size(v?.size) && point(v?.origin) && v.origin.every((n,i) => n >= 0 && n <= v.size[i]) && Number.isFinite(v?.metricWidth) && v.metricWidth > 0 && v.metricWidth <= v.size[0] && accessoryPath(v?.day) && accessoryPath(v?.night), 'accessory view invalid: ' + a.id + '/' + d);
      if (a.fit?.kind === 'ears') check(Array.isArray(v?.pieces) && v.pieces.length === 2 && v.pieces.every(p => Array.isArray(p.rect) && p.rect.length === 4 && p.rect.every(Number.isInteger) && p.rect[0] >= 0 && p.rect[1] >= 0 && p.rect[2] > 0 && p.rect[3] > 0 && p.rect[0] + p.rect[2] <= v.size[0] && p.rect[1] + p.rect[3] <= v.size[1] && point(p.origin) && p.origin.every((n,i) => n >= 0 && n <= p.rect[i+2])), 'earring pieces invalid');
    }
  }
  check(object(pack.fits) && Object.keys(pack.fits).length > 0 && Object.keys(pack.fits).length <= 256, 'accessory fitting ledger invalid');
  let frames = 0;
  for (const [model,poses] of Object.entries(pack.fits ?? {})) {
    check(key(model) && object(poses) && Object.keys(poses).length <= 96, 'accessory model/poses invalid');
    for (const [pose,records] of Object.entries(poses ?? {})) {
      check(slug(pose) && Array.isArray(records) && records.length >= 1 && records.length <= 3, 'accessory pose records invalid');
      if (!Array.isArray(records)) continue;
      for (const r of records) {
        frames++;
        check(Array.isArray(r) && r.length === 21 && [0,1,2,3].includes(r[0]) && r.every((n,i) => (i >= 9 && i <= 12 && n === null) || finite(n)) && r[3] > 0 && r[3] <= 192 && r[4] > 0 && r[4] <= 288 && r[1]+r[3] > 0 && r[1] < 192 && r[2]+r[4] > 0 && r[2] < 288, 'accessory anchor record invalid');
      }
    }
  }
  check(frames <= 16384, 'accessory fitting count exceeds budget');
  return { ok: !errors.length, errors };
}
export function accessoryDescriptors(pack, base) {
  const supportedModels = [...new Set(Object.keys(pack.fits).map(k => k.split('/')[0]))];
  return pack.items.map(a => ({ id: a.id, label: a.names.fr, names: a.names, slot: a.slot, images: {},
    thumbnail: base + a.thumbnail, packId: pack.id, packManifest: base + 'manifest.json', supportedModels }));
}

// One source uses a positive uniform scale; rotations come from authored views.
export function accessoryPlacement(item, record) {
  const [direction,x,y,w,h,hx,,nx,ny] = record, rear = direction > 1;
  const view = item.views[['sw','se','ne','nw'][direction]];
  if (rear && item.fit.hideRear) return { view, pieces: [] };
  const pieces = [], make = (origin, dest, scale, layer, rect = null, split = null) => {
    // Preserve the entire source silhouette within its body canvas.
    const sw = rect?.[2] ?? view.size[0], sh = rect?.[3] ?? view.size[1];
    scale = Math.min(scale, origin[0] ? dest[0]/origin[0] : Infinity, origin[1] ? dest[1]/origin[1] : Infinity,
      sw > origin[0] ? (192-dest[0])/(sw-origin[0]) : Infinity, sh > origin[1] ? (288-dest[1])/(sh-origin[1]) : Infinity);
    if (scale > 0) pieces.push({ origin, dest, scale, layer, rect, split });
  };
  if (item.fit.kind === 'ears') {
    view.pieces.forEach((p,i) => make(p.origin, record.slice(13+i*2,15+i*2), w*item.fit.width/p.rect[2], i === (direction === 0 || direction === 3 ? 0 : 1) ? 'front' : 'back', p.rect));
  } else {
    let dest = [hx,y+h*item.fit.offset], width = w*item.fit.width;
    if (item.fit.kind === 'neck') dest = [nx,ny];
    if (item.fit.kind === 'eye') {
      if (record[9] === null) return { view, pieces };
      const i = direction === 1 ? 11 : 9;
      dest = record.slice(i,i+2); width = Math.hypot(record[11]-record[9],record[12]-record[10])*item.fit.width;
    }
    make(view.origin,dest,width/view.metricWidth,rear ? 'back' : 'front',null,item.fit.kind === 'head' ? .64 : null);
  }
  return { view, pieces };
}
