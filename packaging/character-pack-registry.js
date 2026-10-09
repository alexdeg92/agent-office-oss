'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateCharacterPack, contract } = require('./validate-character-pack');
const { readPackManifest } = require('./character-pack-read');
const { packDescriptor } = require('../public/v2/office/character-packs');
const { checkPackShape, SURPRISE_FRAMES } = require('../public/v2/office/character-pack-shape');
function validateIntegratedPack(pack, root) {
  const result = validateCharacterPack(pack, root);
  result.errors = [...new Set([...result.errors, ...checkPackShape(pack).errors])];
  result.ok = result.errors.length === 0;
  return result;
}
function buildCharacterRegistry(root, include = null) {
  const packs = [], errors = [], found = new Set();
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || (include && !include.includes(e.name))) continue;
    const manifest = path.join(root, e.name, 'manifest.json');
    if (!fs.existsSync(manifest)) continue;
    found.add(e.name);
    try {
      const { pack, metadataBytes } = readPackManifest(manifest);
      const shape = checkPackShape(pack, {id:e.name, metadataBytes});
      if (!shape.ok) { errors.push({id:e.name,errors:shape.errors});continue; }
      const valid = validateIntegratedPack(pack, path.dirname(manifest));
      if (!valid.ok) { errors.push({ id: e.name, errors: valid.errors }); continue; }
      if (pack.id !== e.name) throw Error('pack directory/id mismatch: ' + e.name);
      if (['timmy', 'subagent', 'family-b'].includes(pack.id) || packs.some(p => p.id === pack.id)) throw Error('duplicate/reserved pack id: ' + pack.id);
      if (metadataBytes > contract.budgets.manifestBytes) throw Error('pack metadata too large: ' + e.name);
      const deliveryBytes = valid.bytes + metadataBytes - Buffer.byteLength(JSON.stringify(pack));
      if (deliveryBytes > contract.budgets.packBytes) throw Error('pack delivery too large: ' + e.name);
      packs.push(packDescriptor(pack, 'assets/Characters/' + pack.id + '/'));
    } catch (error) {
      errors.push({ id: e.name, errors: [error.message] });
    }
  }
  if (include) {
    for (const id of new Set(include)) if (!found.has(id)) errors.push({ id, errors: ['enabled pack manifest missing'] });
    if (new Set(include).size !== include.length) errors.push({ id: null, errors: ['duplicate enabled pack id'] });
  }
  return { schemaVersion: 1, packs, pending: errors };
}
function requireEnabledCharacterRegistry(root, include) {
  const registry = buildCharacterRegistry(root, include);
  if (registry.pending.length) throw Error('enabled character packs failed: ' + registry.pending.map(p => p.id + ': ' + p.errors.join('; ')).join('\n'));
  return registry;
}
module.exports = { buildCharacterRegistry, requireEnabledCharacterRegistry, validateIntegratedPack, SURPRISE_FRAMES };
