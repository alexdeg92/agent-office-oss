// Pure metadata gate shared by offline integration and the browser; no filesystem or raster fetches.
import { contract } from '../generated/character-pack-contract.js';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = v => Array.isArray(v) ? v : [];
const slug = v => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const point = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
const names = v => object(v) && nonempty(v.fr) && nonempty(v.en);

export const SURPRISE_FRAMES = ['egg-hide-sw', 'egg-curl-low-sw', 'egg-curl-high-sw', 'egg-bench-low-sw', 'egg-bench-high-sw',
  'egg-wipe-sw', 'egg-light-sw', 'egg-smoke-sw', 'egg-crush-sw', 'egg-shake-sw'];
const contacts = { gym: ['entry', 'mat', 'bench', 'benchFloor'], smoke: ['entry', 'covered'] };
const fields = new Set(['poses', 'point', 'anchor', 'approach', 'loopMs', 'ms', 'fx', 'weather', 'label']);
function checkBaseShape(manifest, metadataBytes) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  if (!object(manifest)) return { ok: false, errors: ['manifest must be an object'], bytes: 0, variants: [] };
  const p = manifest;
  check(p.schemaVersion === 1, 'schemaVersion must be 1');
  check(p.contract === contract.id, `contract must be ${contract.id}`);
  check(slug(p.id), 'id must be a lowercase slug');
  check(names(p.names), 'names.fr and names.en are required');
  check(nonempty(p.license), 'license is required for an open/custom pack');
  check(JSON.stringify(p.canvas) === JSON.stringify(contract.canvas), 'canvas must be [192,288]');
  check(p.artScale === 2 && p.scale === 1, 'artScale=2 and scale=1; bake model size at export');
  check(['walks', 'floats', 'rolls'].includes(p.locomotion?.type), 'locomotion.type must be walks, floats or rolls');
  check(Number.isFinite(p.locomotion?.hoverPx) && p.locomotion.hoverPx >= 0 && p.locomotion.hoverPx <= 24, 'locomotion.hoverPx must be 0..24 authored px');
  check(p.locomotion?.type === 'floats' || p.locomotion?.hoverPx === 0, 'only floats may have hoverPx');
  for (const seat of ['desk', 'sofa']) {
    check(p.seats?.[seat]?.supported === true, `seats.${seat}.supported must be true`);
    check(['sit', 'perch', 'park', 'compress', 'hover-dock'].includes(p.seats?.[seat]?.mode), `seats.${seat}.mode is required`);
  }
  const accessories = object(p.accessories) ? p.accessories : {};
  for (const id of new Set([...contract.accessories, ...Object.keys(accessories)])) {
    const a = accessories[id];
    check(slug(id) && typeof a?.supported === 'boolean', `accessories.${id}: explicit supported flag required`);
    if (a?.supported === false) check(nonempty(a.reason), `accessories.${id}: unsupported reason required`);
  }
  function asset(file, label) {
    check(typeof file === 'string' && /^[a-zA-Z0-9_./-]+\.webp$/.test(file)
      && !file.startsWith('/') && !file.split('/').some(part => ['..', '.', ''].includes(part)), `${label}: pack-relative .webp path required`);
  }
  const variants = list(p.variants);
  check(variants.length > 0, 'at least one variant is required');
  const seenVariants = new Set();
  const totals = [];
  for (const v of variants) {
    if (!object(v)) { errors.push('variant must be an object'); continue; }
    const prefix = `variant ${v.id}`;
    check(slug(v.id) && !seenVariants.has(v.id), `${prefix}: valid unique id required`);
    seenVariants.add(v.id);
    check(names(v.names), `${prefix}: names.fr and names.en required`);
    check(typeof v.swatch === 'string' && /^#[0-9a-f]{6}$/i.test(v.swatch), `${prefix}: #RRGGBB swatch required`);
    asset(v.thumbnail, `${prefix}/thumbnail`);
    const frames = list(v.frames);
    const frameMap = new Map();
    for (const f of frames) {
      if (!object(f)) { errors.push(`${prefix}: frame must be an object`); continue; }
      check(slug(f.id) && !frameMap.has(f.id), `${prefix}/${f.id}: valid unique frame id required`);
      frameMap.set(f.id, f);
    }
    for (const requirement of contract.frames) {
      check(frameMap.has(requirement.id), `${prefix}: missing frame ${requirement.id}`);
    }
    for (const [id, f] of frameMap) {
      const label = `${prefix}/${id}`;
      const required = contract.frames.find(r => r.id === id);
      check(['sw', 'se', 'ne', 'nw'].includes(f.facing), `${label}: facing required`);
      if (required) check(f.facing === required.facing, `${label}: facing must be ${required.facing}`);
      check(typeof f.seated === 'boolean', `${label}: seated flag required`);
      if (required) check(f.seated === required.seated, `${label}: seated must be ${required.seated}`);
      asset(f.image, label);
      const a = f.anchors ?? {};
      for (const name of ['ground', 'hip', 'handLeft', 'handRight', 'head', 'earLeft', 'earRight', 'neck', 'chest']) {
        check(point(a[name]), `${label}: anchors.${name} must be a finite [x,y]`);
      }
      check(a.ground?.[1] === 276, `${label}: ground y must remain 276, including floats/rolls`);
      check(Number.isFinite(a.tilt), `${label}: finite head tilt required`);
      const eyes = a.eyes;
      check(['visible', 'occluded'].includes(eyes?.visibility), `${label}: eyes.visibility required`);
      check(eyes?.visibility === 'occluded' ? eyes.line === null : Array.isArray(eyes?.line) && eyes.line.length === 2 && eyes.line.every(point), `${label}: eyes.line must match visibility`);
      if (['ne', 'nw'].includes(f.facing)) check(eyes?.visibility === 'occluded', `${label}: rear eyes must be occluded`);
      if (required?.fx) check(point(a.fx), `${label}: painted-surface FX anchor required`);
      if (required?.heldProp) check(f.heldProp === required.heldProp, `${label}: heldProp must be ${required.heldProp}`);
      const gear = object(f.accessories) ? f.accessories : {};
      for (const aid of Object.keys(gear)) check(accessories[aid]?.supported === true, `${label}/${aid}: layer for undeclared/unsupported accessory`);
      for (const [aid, support] of Object.entries(accessories)) {
        if (support?.supported !== true) continue;
        const reg = gear[aid];
        check(object(reg), `${label}/${aid}: registration missing`);
        if (!object(reg)) continue;
        check(reg.body === id && reg.facing === f.facing, `${label}/${aid}: body/facing mismatch`);
        check(point(reg.anchor) && JSON.stringify(reg.anchor) === JSON.stringify(a.ground), `${label}/${aid}: body ground registration mismatch`);
        check(typeof reg.occluded === 'boolean', `${label}/${aid}: occlusion flag required`);
        if (['ne', 'nw'].includes(f.facing) && ['glasses', 'badge'].includes(aid)) check(reg.occluded === true, `${label}/${aid}: rear front-only gear must be occluded`);
        if (['cap', 'headphones'].includes(aid)) {
          const m = reg.matrix;
          check(reg.sourceFacing === f.facing && reg.mirrored === false, `${label}/${aid}: dedicated same-facing source; no reflection`);
          check(Array.isArray(m) && m.length === 6 && m.every(Number.isFinite) && m[0] * m[4] - m[1] * m[3] > 0, `${label}/${aid}: positive affine transform required`);
        }
        if (reg.occluded === true) {
          check(reg.front === null && reg.back === null, `${label}/${aid}: occluded layers must be null`);
        } else {
          for (const side of ['back', 'front']) asset(reg[side], `${label}/${aid}/${side}`);
        }
      }
    }
    totals.push({id:v.id,frames:frames.length});
  }
  check(metadataBytes <= contract.budgets.manifestBytes, 'manifest exceeds metadata budget');
  return { ok: errors.length === 0, errors, bytes: metadataBytes, variants: totals };
}
export function checkPackShape(pack, {id, metadataBytes} = {}) {
  metadataBytes ??= new TextEncoder().encode(JSON.stringify(pack) ?? '').length;
  if (metadataBytes > contract.budgets.manifestBytes) return {ok:false,errors:['manifest exceeds metadata budget'],bytes:metadataBytes,variants:[]};
  const result=checkBaseShape(pack, metadataBytes);
  if(id !== undefined && pack?.id !== id) result.errors.push('character pack identity mismatch');
  if (!Array.isArray(pack?.variants)) return {...result,ok:false};
  for (const id of contract.accessories) if (pack.accessories?.[id]?.supported !== true) result.errors.push(`final delivery must support ${id}`);
  for (const v of pack.variants) {
    const frames = new Map((Array.isArray(v?.frames) ? v.frames : []).map(f => [f?.id, f]));
    for (const f of frames.values()) {
      const b = f?.anchors?.headBox;
      if ((b !== undefined || SURPRISE_FRAMES.includes(f?.id)) && (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1])) result.errors.push(`${v?.id}/${f?.id}: valid headBox required`);
    }
    for (const id of SURPRISE_FRAMES) {
      const f = frames.get(id);
      if (!f) result.errors.push(`${v?.id}: missing final 26b frame ${id}`);
      else if (f.facing !== 'sw') result.errors.push(`${v?.id}/${id}: surprise must face sw`);
    }
  }
  const substitutes = pack.substitutes ?? {};
  if (!substitutes || typeof substitutes !== 'object' || Array.isArray(substitutes)) result.errors.push('substitutes must be an object');
  for (const [key, step] of Object.entries(substitutes)) {
    if (!/^(gym\.(enter|curls|bench|wipe|leave)|smoke\.(enter|light|smoke|drop|crush|shake|leave))$/.test(key)) result.errors.push(`unknown substitute step ${key}`);
    if (!step || typeof step !== 'object' || Array.isArray(step)) { result.errors.push(`${key}: substitute must be an object`); continue; }
    for (const field of Object.keys(step)) if (!fields.has(field)) result.errors.push(`${key}: unknown field ${field}`);
    if (!Array.isArray(step?.poses) || !step.poses.length) result.errors.push(`${key}: substitute poses required`);
    const room = key.split('.')[0];
    for (const field of ['point', 'approach']) if (step[field] !== undefined && !contacts[room]?.includes(step[field])) result.errors.push(`${key}: invalid ${field}`);
    if (step.anchor !== undefined && !['ground', 'seat'].includes(step.anchor)) result.errors.push(`${key}: invalid anchor`);
    for (const field of ['ms', 'loopMs']) if (step[field] !== undefined && (!Number.isFinite(step[field]) || step[field] < 100 || step[field] > 60000)) result.errors.push(`${key}: invalid ${field}`);
    if (step.fx !== undefined && ![null, 'sweat', 'ember', 'smoke', 'drop', 'crush'].includes(step.fx)) result.errors.push(`${key}: invalid fx`);
    if (step.weather !== undefined && step.weather !== 'rain') result.errors.push(`${key}: invalid weather`);
    if (step.label !== undefined && !['fr', 'en'].every(lang => typeof step.label?.[lang] === 'string' && step.label[lang].trim())) result.errors.push(`${key}: label.fr/en required`);
    for (const v of pack.variants) for (const pose of Array.isArray(step.poses) ? step.poses : []) if (!v?.frames?.some(f => f?.id === pose) && pose !== 'working-ne') result.errors.push(`${v?.id}/${key}: missing substitute ${pose}`);
    if (key === 'gym.bench' && pack.locomotion?.type === 'floats' && (step.point !== 'benchFloor' || step.anchor !== 'ground')) result.errors.push('hover press must attach ground at benchFloor');
  }
  if (pack.locomotion?.type === 'floats') for (const key of ['gym.bench', 'smoke.crush']) if (!substitutes[key]) result.errors.push(`floaters must declare ${key} substitute`);
  if (pack.locomotion?.type === 'rolls' && !substitutes['smoke.crush']) result.errors.push('rollers must declare smoke.crush substitute');
  result.ok = result.errors.length === 0;
  return result;
}
