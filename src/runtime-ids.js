'use strict';
// ADR-001 §13.4: native identities never become a core parsing grammar.
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENTITIES = new Set(['agent', 'session', 'flow', 'run', 'event', 'tool', 'sender', 'skill', 'channel']);
const fail = () => Object.assign(new Error('invalid runtime identity'), { code: 'EIDENTITY' });
const validNativeId = local => typeof local === 'string' && !!local && Buffer.byteLength(local) <= 4096
  && !/[\u0000-\u001f\u007f]/.test(local) && Buffer.from(local, 'utf8').toString('utf8') === local;
function scopedId(runtime, entity, local) {
  if (!INSTANCE_ID.test(runtime) || !ENTITIES.has(entity) || !validNativeId(local)) throw fail();
  return `rt:${runtime}:${entity}:${Buffer.from(local, 'utf8').toString('base64url')}`;
}
function parseId(value, entity = null) {
  if (typeof value !== 'string') return null;
  const match = /^rt:([a-z][a-z0-9-]{0,31}):([a-z]+):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || !ENTITIES.has(match[2]) || entity && match[2] !== entity || match[3].length > 5462) return null;
  const local = Buffer.from(match[3], 'base64url').toString('utf8');
  try { if (scopedId(match[1], match[2], local) !== value) return null; } catch { return null; }
  return { runtime: match[1], entity: match[2], local };
}
module.exports = { scopedId, parseId, validNativeId, INSTANCE_ID };
