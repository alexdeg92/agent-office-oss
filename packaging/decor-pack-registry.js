'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readPackFile } = require('./character-pack-read');
const { webpSize } = require('./validate-character-pack');
const { DECOR_BUDGETS: B, checkDecorPack, decorDescriptors } = require('../public/v2/office/decor-packs');
function readDecorManifest(file) {
  const buffer = readPackFile(file, B.metadata, 'decor metadata exceeds budget');
  return { pack: JSON.parse(buffer.toString('utf8')), metadataBytes: buffer.length };
}
function validateDecorPack(pack, root, metadataBytes = Buffer.byteLength(JSON.stringify(pack))) {
  const shape = checkDecorPack(pack, { metadataBytes });
  if (!shape.ok) return { ...shape, bytes: metadataBytes };
  const errors = [], files = new Map(), rootReal = fs.realpathSync(root);
  function asset(file, size, limit) {
    try {
      const absolute = fs.realpathSync(path.resolve(rootReal, file));
      if (!absolute.startsWith(rootReal + path.sep)) throw Error('path escapes decor pack');
      const buffer = readPackFile(absolute, limit, 'decor raster exceeds budget');
      const dims = webpSize(buffer);
      if (!dims || dims[0] !== size.w || dims[1] !== size.h) throw Error('invalid WebP/dimensions');
      files.set(absolute, buffer.length);
    } catch (error) { errors.push(file + ': ' + error.message); }
  }
  for (const f of pack.items) {
    asset(f.thumbnail, f.thumbnailSize, B.thumbnail);
    for (const file of new Set([f.image, ...Object.values(f.images)])) asset(file, f.size, B.sprite);
  }
  const bytes = metadataBytes + [...files.values()].reduce((a,b) => a+b,0);
  if (bytes > B.pack) errors.push('decor pack exceeds total budget');
  return { ok: !errors.length, errors, bytes, files: files.size };
}
function requireDecorRegistry(root, enabled, reserved = []) {
  if (!Array.isArray(enabled) || enabled.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) || new Set(enabled).size !== enabled.length) throw Error('decor enabled list must contain unique pack ids');
  const items = [], seen = new Set(reserved);
  for (const id of enabled) {
    const dir = path.join(root, id), file = path.join(dir, 'manifest.json');
    const { pack, metadataBytes } = readDecorManifest(file);
    if (pack.id !== id) throw Error('decor pack directory/id mismatch');
    const valid = validateDecorPack(pack, dir, metadataBytes);
    if (!valid.ok) throw Error('decor pack ' + id + ': ' + valid.errors.join('; '));
    for (const item of decorDescriptors(pack, 'assets/Decor/' + id + '/')) {
      if (seen.has(item.id)) throw Error('duplicate/reserved decor item: ' + item.id);
      seen.add(item.id); items.push(item);
    }
  }
  return { schemaVersion: 1, items };
}
if (require.main === module) {
  try {
    const dir = path.resolve(process.argv[2]);
    const { pack, metadataBytes } = readDecorManifest(path.join(dir, 'manifest.json'));
    const result = validateDecorPack(pack, dir, metadataBytes);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
  } catch(error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { readDecorManifest, validateDecorPack, requireDecorRegistry };
