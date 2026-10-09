'use strict';
const fs = require('node:fs');
const { budgets } = require('./character-pack-contract.json');

// Inspect and read the same descriptor. Growth is bounded by the budget plus one
// probe byte, so a file cannot bypass admission by changing after fstat.
function readPackFile(file, maxBytes, message) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error('not a file');
    if (stat.size > maxBytes) throw Error(message);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) return buffer.subarray(0, bytes);
      bytes += count;
      if (bytes > maxBytes) throw Error(message);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readPackManifest(file) {
  const buffer = readPackFile(file, budgets.manifestBytes, 'manifest file exceeds metadata budget');
  let pack;
  try { pack = JSON.parse(buffer.toString('utf8')); }
  catch { throw Error('invalid manifest JSON'); }
  return { pack, metadataBytes: buffer.length };
}

module.exports = { readPackFile, readPackManifest };
