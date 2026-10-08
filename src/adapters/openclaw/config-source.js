'use strict';
// Reads ~/.openclaw/openclaw.json (read-only) as a RawEnvelope body for the engine.
// The engine keeps only the projection (src/adapters/openclaw/schemas/config.v1.js); the rest never leaves here.
const fs = require('fs');

function readOpenclawConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { kind: 'error', message: 'openclaw.json not readable (' + e.code + ')' }; }
  try { return { kind: 'json', value: JSON.parse(text) }; } catch (_) { return { kind: 'error', message: 'openclaw.json is not valid JSON' }; }
}

module.exports = { readOpenclawConfig };
