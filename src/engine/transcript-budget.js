'use strict';
// Shared by adapter windows and admitted engine windows. No transcript content
// is retained here, only accounted bytes and eviction callbacks.
const MAX_BYTES = 32 * 1024 * 1024;
const entries = new Map(); let bytes = 0;
function release(key) { const row = entries.get(key); if (row) { bytes -= row.size; entries.delete(key); } }
function reserve(key, size, drop) {
  release(key); entries.set(key, { size, drop }); bytes += size;
  while (bytes > MAX_BYTES) { const oldest = entries.keys().next().value, row = entries.get(oldest); release(oldest); row.drop(); }
}
module.exports = { reserve, release, bytes: () => bytes, MAX_BYTES };
