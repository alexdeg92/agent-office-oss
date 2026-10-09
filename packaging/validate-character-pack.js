#!/usr/bin/env node
'use strict';
// Offline Phase 1 pack gate. No runtime imports and no dependency on live office manifests.
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./character-pack-contract.json');
const { readPackFile, readPackManifest } = require('./character-pack-read');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = v => Array.isArray(v) ? v : [];
const slug = v => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const point = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
const names = v => object(v) && nonempty(v.fr) && nonempty(v.en);

function webpSize(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP'
      || buf.readUInt32LE(4) + 8 !== buf.length) return null;
  let size = null;
  let image = false;
  for (let offset = 12; offset + 8 <= buf.length;) {
    const kind = buf.toString('ascii', offset, offset + 4);
    const bytes = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + bytes > buf.length) return null;
    if (kind === 'ANIM' || kind === 'ANMF') return null; // Animation is the explicit frame list.
    if (kind === 'VP8X' && bytes >= 10) size = [buf.readUIntLE(start + 4, 3) + 1, buf.readUIntLE(start + 7, 3) + 1];
    if (kind === 'VP8L' && bytes >= 5 && buf[start] === 0x2f) {
      const bits = buf.readUInt32LE(start + 1);
      size ??= [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      image = true;
    }
    if (kind === 'VP8 ' && bytes >= 10 && buf.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      size ??= [buf.readUInt16LE(start + 6) & 0x3fff, buf.readUInt16LE(start + 8) & 0x3fff];
      image = true;
    }
    offset = start + bytes + (bytes % 2);
  }
  return image ? size : null;
}

function validateCharacterPack(manifest, root) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  if (!object(manifest)) return { ok: false, errors: ['manifest must be an object'], bytes: 0, variants: [] };
  const p = manifest;
  const manifestBytes = Buffer.byteLength(JSON.stringify(p));
  if (manifestBytes > contract.budgets.manifestBytes) return { ok: false, errors: ['manifest exceeds metadata budget'], bytes: manifestBytes, variants: [] };
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
  const rootReal = fs.realpathSync(root);
  const allAssets = new Map();
  function asset(file, label, maxBytes, expectedCanvas, variantAssets) {
    if (typeof file !== 'string' || !/^[a-zA-Z0-9_./-]+\.webp$/.test(file)
        || file.startsWith('/') || file.split('/').some(part => ['..', '.', ''].includes(part))) {
      errors.push(`${label}: pack-relative .webp path required`); return;
    }
    try {
      const absolute = fs.realpathSync(path.resolve(rootReal, file));
      if (!absolute.startsWith(rootReal + path.sep)) throw new Error('path escapes pack');
      const buffer = readPackFile(absolute, maxBytes, `exceeds ${maxBytes} bytes`);
      const size = webpSize(buffer);
      check(size && JSON.stringify(size) === JSON.stringify(expectedCanvas), `${label}: invalid WebP or wrong dimensions`);
      allAssets.set(absolute, buffer.length);
      variantAssets.set(absolute, buffer.length);
    } catch (e) { errors.push(`${label}: ${e.code ?? e.message}`); }
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
    const variantAssets = new Map();
    asset(v.thumbnail, `${prefix}/thumbnail`, contract.budgets.thumbnailBytes, [96, 144], variantAssets);
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
      asset(f.image, label, contract.budgets.frameBytes, contract.canvas, variantAssets);
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
          for (const side of ['back', 'front']) asset(reg[side], `${label}/${aid}/${side}`, contract.budgets.layerBytes, contract.canvas, variantAssets);
        }
      }
    }
    const bytes = [...variantAssets.values()].reduce((a, b) => a + b, 0);
    check(bytes <= contract.budgets.variantBytes, `${prefix}: exceeds variant budget ${contract.budgets.variantBytes}`);
    totals.push({ id: v.id, frames: frames.length, bytes });
  }
  const assetBytes = [...allAssets.values()].reduce((a, b) => a + b, 0);
  const bytes = assetBytes + manifestBytes;
  check(bytes <= contract.budgets.packBytes, `pack exceeds ${contract.budgets.packBytes} bytes`);
  return { ok: errors.length === 0, errors, bytes, variants: totals };
}

function main(argv) {
  if (argv.length !== 1) { console.error('usage: node packaging/validate-character-pack.js <pack-directory-or-manifest.json>'); return 2; }
  try {
    const input = path.resolve(argv[0]);
    const manifestPath = fs.statSync(input).isDirectory() ? path.join(input, 'manifest.json') : input;
    const { pack, metadataBytes: fileBytes } = readPackManifest(manifestPath);
    const result = validateCharacterPack(pack, path.dirname(manifestPath));
    // Include authored whitespace when validating a real delivery.
    result.bytes += fileBytes - Buffer.byteLength(JSON.stringify(pack));
    if (fileBytes > contract.budgets.manifestBytes) result.errors.push('manifest file exceeds metadata budget');
    if (result.bytes > contract.budgets.packBytes) result.errors.push('pack file bytes exceed total budget');
    result.ok = result.errors.length === 0;
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch (e) { console.error(`character-pack: ${e.message}`); return 1; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { validateCharacterPack, webpSize, contract, main };
