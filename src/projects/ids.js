'use strict';

const crypto = require('node:crypto');

const ALPH = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. 10 bytes → 16 characters. */
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 31];
  return out;
}

function mint(prefix, randomBytes = crypto.randomBytes) {
  const body = base32(randomBytes(10));
  if (body.length !== 16) throw new Error('id entropy must be 10 bytes');
  return `${prefix}_${body}`;
}

module.exports = { base32, mint };
