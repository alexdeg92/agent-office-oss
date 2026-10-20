'use strict';
/*
 * Portal password hashing (PM audit (A), BRIEF 2026-10-06): scrypt, stored as
 *   scrypt:<N>:<r>:<p>:<salt base64url>:<key base64url>
 * (':' separators: the value survives being sourced by a shell or read by systemd/Docker env files, unlike '$').
 * Verification derives the key with the stored parameters and compares with crypto.timingSafeEqual.
 */
const crypto = require('crypto');

const DEFAULT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, saltLen: 16 };
const MAXMEM = 128 * 1024 * 1024;
// exactly a 16-byte salt and a 32-byte key: scrypt's shorter outputs are PREFIXES of longer ones, so a truncated
// stored key must never be accepted (it would verify against fewer bytes)
const FORMAT = /^scrypt:(\d{4,8}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/;

const derive = (password, salt, { N, r, p, keyLen }) => new Promise((resolve, reject) =>
  crypto.scrypt(String(password).normalize('NFC'), salt, keyLen, { N, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));

async function hashPassword(password, opts = {}) {
  const o = Object.assign({}, DEFAULT, opts);
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) throw new Error('password: 1 to 1024 characters');
  const salt = crypto.randomBytes(o.saltLen);
  const key = await derive(password, salt, o);
  return ['scrypt', o.N, o.r, o.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

// Boot migration helper: server startup is synchronous today. Keep the same
// scrypt format/costs as hashPassword; callers persist only this derived value.
function hashPasswordSync(password, opts = {}) {
  const o = Object.assign({}, DEFAULT, opts);
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) throw new Error('password: 1 to 1024 characters');
  const salt = crypto.randomBytes(o.saltLen);
  const key = crypto.scryptSync(String(password).normalize('NFC'), salt, o.keyLen, { N:o.N, r:o.r, p:o.p, maxmem:MAXMEM });
  return ['scrypt', o.N, o.r, o.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

const parse = (stored) => {
  const m = FORMAT.exec(String(stored || ''));
  if (!m) return null;
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  // R16-10 (R17a): sane, runnable costs only: N a power of two in [2^14, 2^16], r in [8, 32], p in [1, 4], within memory
  if ((N & (N - 1)) !== 0 || N < 2 ** 14 || N > 2 ** 16 || r < 8 || r > 32 || p < 1 || p > 4) return null;
  // R16-10: only costs the verifier can actually run (scrypt needs about 128·N·r bytes, under MAXMEM)
  if (128 * N * r * (1 + 1 / 16) > MAXMEM) return null;
  const salt = Buffer.from(m[4], 'base64url'), key = Buffer.from(m[5], 'base64url');
  if (salt.length !== DEFAULT.saltLen || key.length !== DEFAULT.keyLen) return null;
  return { N, r, p, salt, key };
};
const isHash = (stored) => parse(stored) !== null;

// → true | false. Never throws; a malformed hash verifies nothing.
async function verifyPassword(password, stored) {
  const h = parse(stored);
  if (!h || typeof password !== 'string' || password.length > 1024) return false;
  try {
    const key = await derive(password, h.salt, { N: h.N, r: h.r, p: h.p, keyLen: h.key.length });
    return key.length === h.key.length && crypto.timingSafeEqual(key, h.key);
  } catch (_) { return false; }
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, isHash, DEFAULT };
