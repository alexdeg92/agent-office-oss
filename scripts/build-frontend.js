#!/usr/bin/env node
'use strict';
// Prepare a release AFTER all source/contract/design edits, before testing or copying it.
// The stamp covers copied examples and generated schemas, so it must be written last.
//   node scripts/build-frontend.js
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT: UI_ROOT, buildId, writePreloads } = require('./first-load');
const ROOT = path.join(__dirname, '..');

function buildFrontend(root = ROOT) {
  for (const script of ['sync-design.js', 'build-vm-schemas.js', 'build-character-pack-contract.js', 'build-identity-themes.js']) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status})`);
  }
  const ui = root === ROOT ? UI_ROOT : path.join(root, 'public', 'v2');
  const changed = writePreloads(ui);
  const version = buildId(ui);
  console.log(`frontend build ${version}; ${changed.length ? 'stamped ' + changed.join(', ') : 'stamp up to date'}`);
  return version;
}

if (require.main === module) {
  try { buildFrontend(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { buildFrontend };
