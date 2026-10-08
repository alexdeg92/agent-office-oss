'use strict';
/*
 * Default-deny sanitising for everything the engine exposes about bad input (R1-01, engine.md §5.3).
 * Nothing from an untrusted payload reaches an issue, a source status or /api/data-quality unless it
 * passes one of these allowlists:
 *   - type names              'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | '[secret]'
 *   - field names             identifier-shaped: /^[A-Za-z_][A-Za-z0-9_]{0,47}$/, no 5+ digit run → else '<key>'
 *   - protocol tokens         /^[a-z][a-z0-9_.-]{0,31}$/, no 4+ digit run → else '<redacted>'; used ONLY for
 *                             gateway event names in channel ids (needed to know which events are unknown)
 *   - session-key words       a fixed grammar vocabulary → else '<seg>'
 *   - OpenClaw versions       /^\d{4}\.\d{1,2}\.\d{1,3}$/
 *   - error text              mapped to a fixed category ('timeout', 'not-connected', …) → never the message
 * Samples are value-free type skeletons; counts and lengths are the only numbers.
 */
const SECRET_KEY_RE = /(token|secret|password|passwd|api_?key|authorization|cookie|credentials?|signature|nonce|private_?key(_?pem)?|key_?pem)$/i;
const TYPE_NAMES = new Set(['string', 'number', 'boolean', 'null', 'object', 'array', 'undefined', '[secret]', '<key>', '<redacted>', '<seg>']);
const KEY_WORDS = new Set(['agent', 'main', 'subagent', 'cron', 'dashboard', 'acp', 'explicit', 'discord', 'whatsapp', 'wechat', 'openclaw-weixin',
  'telegram', 'slack', 'signal', 'direct', 'dm', 'channel', 'group', 'thread', 'slash', 'heartbeat', 'portal-chat']);
const ERROR_CATEGORIES = [
  [/timed? ?out|timeout|ETIMEDOUT/i, 'timeout'], [/not connected/i, 'not-connected'], [/socket closed|ECONNRESET|EPIPE/i, 'connection-closed'],
  [/ECONNREFUSED/i, 'connection-refused'], [/unknown method/i, 'unknown-method'], [/ENOENT|not found/i, 'not-found'],
  [/EACCES|EPERM|permission/i, 'permission-denied'], [/not (valid )?json|invalid json|unexpected token/i, 'invalid-json'],
  [/not readable/i, 'unreadable'], [/requires --agent|pass --agent/i, 'missing-agent'],
];

const safeFieldName = (k) => (typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(k) && !/\d{5,}/.test(k) ? k : '<key>');
const safeToken = (v) => (typeof v === 'string' && /^[a-z][a-z0-9_.-]{0,31}$/.test(v) && !/\d{4,}/.test(v) ? v : '<redacted>');
const safeVersion = (v) => (typeof v === 'string' && /^\d{4}\.\d{1,2}\.\d{1,3}$/.test(v) ? v : v == null ? null : '<redacted>');
const errorCategory = (msg) => { const m = String(msg == null ? '' : msg); for (const [re, c] of ERROR_CATEGORIES) if (re.test(m)) return c; return 'error'; };

// DSL paths: '$.sessions[].updatedAt', '$.channels.*' — every name segment through safeFieldName.
function safePath(p) {
  if (p == null) return null;
  return String(p).split('.').map((seg, i) => {
    if (i === 0 && seg === '$') return seg;
    const arr = seg.endsWith('[]'), name = arr ? seg.slice(0, -2) : seg;
    return (name === '*' || name === '' ? name : safeFieldName(name)) + (arr ? '[]' : '');
  }).join('.');
}

// 'agent:main:discord:channel:<number>' — grammar words kept, everything else masked.
function safeKeyShape(key) {
  return String(key || '').split(':').map((x) => (KEY_WORDS.has(x) || x === '<number>' || x === '<uuid>' || x === '<seg>' ? x : /^\d+$/.test(x) ? '<number>' : /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x) ? '<uuid>' : '<seg>')).join(':');
}

// Type skeleton of a value: keys → safe field names, leaves → type names. Depth-limited.
function shapeOf(v, depth = 2) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth - 1), `…${v.length}`] : [];
  if (typeof v !== 'object') return typeof v;
  if (depth <= 0) return 'object';
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const key = safeFieldName(k);
    const val = SECRET_KEY_RE.test(k) ? '[secret]' : shapeOf(x, depth - 1);
    Object.defineProperty(out, key in out ? key + '#' + Object.keys(out).length : key, { value: val, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// Value at a DSL path, following the first element of arrays. Uses own properties only.
function atPath(root, path) {
  let cur = root;
  for (const part of String(path || '$').replace(/^\$\.?/, '').split('.').filter(Boolean)) {
    const name = part.replace(/\[\]$/g, '');
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = name === '*' ? Object.values(cur)[0] : Object.prototype.hasOwnProperty.call(cur, name) ? cur[name] : undefined;
    if (/\[\]$/.test(part)) cur = Array.isArray(cur) ? cur[0] : undefined;
  }
  return cur;
}

// The parent object of the offending field, as a type skeleton (≤ 4 KB).
function sampleFor(root, path) {
  const parentPath = String(path || '$').replace(/(\.[^.]*|\[\])$/, '') || '$';
  let sample = shapeOf(atPath(root, parentPath), 2);
  if (JSON.stringify(sample || null).length > 4096) sample = shapeOf(atPath(root, parentPath), 1);
  return JSON.stringify(sample || null).length > 4096 ? '<too large>' : sample;
}

// Final gate for any sample object: strings must be type names, '…N' counts or safe tokens.
function sanitizeSample(x, depth = 0) {
  if (x == null || typeof x === 'boolean') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') return TYPE_NAMES.has(x) || /^…\d+$/.test(x) || x === '<too large>' ? x : '<redacted>';   // never a value
  if (depth > 6) return 'object';
  if (Array.isArray(x)) return x.slice(0, 4).map((y) => sanitizeSample(y, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(x)) Object.defineProperty(out, /^[A-Za-z_][A-Za-z0-9_]{0,47}(#\d+)?$/.test(k) && !/\d{5,}/.test(k.split('#')[0]) ? k : '<key>',
    { value: sanitizeSample(v, depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}

module.exports = { shapeOf, atPath, sampleFor, sanitizeSample, safeFieldName, safeToken, safeVersion, safePath, safeKeyShape, errorCategory, ERROR_CATEGORIES, SECRET_KEY_RE, KEY_WORDS };
