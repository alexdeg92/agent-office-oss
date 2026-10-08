'use strict';
// Store ids (storage.md §5): prefix + '_' + base32(10 random bytes) → 16 chars.
const crypto = require('crypto');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function mintId(prefix) {
  const bytes = crypto.randomBytes(10);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return prefix + '_' + out;
}
module.exports = { mintId };
