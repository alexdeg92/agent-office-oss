'use strict';
// Cursor chat meta.json profile. Shapes only — never reads store.db blob payloads.
const path = require('node:path');
const PROFILE = 'cursor-meta-v1';
const MAX_TITLE = 240, MAX_CWD = 4096;
const META_KEYS = new Set(['schemaVersion', 'createdAtMs', 'updatedAtMs', 'hasConversation', 'title', 'cwd']);
function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.length > MAX_CWD || /[\x00-\x1f\x7f]/.test(cwd)) return null;
  const api = path.posix.isAbsolute(cwd) ? path.posix : path.win32.isAbsolute(cwd) ? path.win32 : null;
  const name = api?.basename(cwd);
  return name && !['.', '..'].includes(name) && name.length <= 128 ? name : null;
}
function extras(record, counters) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  for (const key of Object.keys(record)) if (!META_KEYS.has(key)) counters.unknownKeys = (counters.unknownKeys || 0) + 1;
}
function parseMeta(raw, { sessionId, workspaceHash, counters = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { counters.malformedMeta = (counters.malformedMeta || 0) + 1; return null; }
  extras(raw, counters);
  const cwd = typeof raw.cwd === 'string' && raw.cwd.length <= MAX_CWD ? raw.cwd : null;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : null;
  const createdAt = Number.isSafeInteger(raw.createdAtMs) && raw.createdAtMs >= 0 ? raw.createdAtMs : null;
  const updatedAt = Number.isSafeInteger(raw.updatedAtMs) && raw.updatedAtMs >= 0 ? raw.updatedAtMs : createdAt;
  return {
    sessionId: typeof sessionId === 'string' && sessionId.length <= 128 ? sessionId : null,
    workspaceHash: typeof workspaceHash === 'string' && workspaceHash.length <= 64 ? workspaceHash : null,
    cwd, projectName: projectName(cwd), title, createdAt, updatedAt,
    hasConversation: raw.hasConversation === true,
    schemaVersion: Number.isSafeInteger(raw.schemaVersion) ? raw.schemaVersion : null,
    model: null, recognized: true,
  };
}
module.exports = { PROFILE, parseMeta, projectName, MAX_TITLE, META_KEYS };
