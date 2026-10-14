'use strict';
const { parseId } = require('../../runtime-ids');
function legacyId(value) {
  if (typeof value !== 'string') return value;
  const parsed = parseId(value);
  if (parsed?.runtime === 'legacy') {
    if (parsed.entity === 'event' || parsed.entity === 'tool') { try { const tuple = JSON.parse(parsed.local); if (Array.isArray(tuple) && tuple.length === 2) return parseId(tuple[1]) ? value : tuple[1]; } catch {} }
    // A scoped-looking native ID cannot also be a canonical ID on the wire.
    return parseId(parsed.local) ? value : parsed.local;
  }
  const cut = value.indexOf(':');
  if (cut > 0 && ['agent', 'subagent', 'scheduled', 'cron', 'conversation', 'occupant'].includes(value.slice(0, cut))) return value.slice(0, cut + 1) + legacyId(value.slice(cut + 1));
  return value;
}
// Only typed identity fields, never body/text, user labels or LabelRef params.
const FIELDS = new Set(['id', 'key', 'agentId', 'subagentId', 'sessionKey', 'sessionId', 'mainSessionKey', 'parentKey', 'heartbeatOf', 'jobId', 'cronJobId', 'runId', 'ruleId', 'callId', 'explicitKey',
  'occupantId', 'parentId', 'groupId', 'rootId']);
const ID_ARRAY_FIELDS = new Set(['childKeys', 'sessionKeys', 'occupantIds', 'mobileLabelIds', 'childIds', 'previewOccupantIds', 'conversationIds', 'peerIds']);
function projectLegacy(value, type) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => projectLegacy(v, type));
  const out = { ...value };
  for (const [key, field] of Object.entries(value)) {
    if (FIELDS.has(key)) out[key] = legacyId(field);
    else if (ID_ARRAY_FIELDS.has(key) && Array.isArray(field)) out[key] = field.map(legacyId);
    else if (key === 'name' && ['skills', 'skill'].includes(type)) out[key] = legacyId(field);
    else if (key !== 'params' && field && typeof field === 'object') out[key] = projectLegacy(field, type);
  }
  return out;
}
module.exports = { legacyId, projectLegacy };

// Resolve compatibility references before reads, writes and capability lookup.
// V3 is canonical. V2 raw aliases belong only to legacy; conflicting aliases
// remain refused after a partition is disabled/replaced in this generation.
function resolveWireId(engine,value,kind,version=3) {
  if(!engine.instances || typeof value!=='string')return value;
  const {scopedId}=require('../../runtime-ids'),parsed=parseId(value,kind);
  if(version===2 && parsed && engine.legacyAliasConflict?.(kind,value)) {
    const {ApiError}=require('./errors');throw new ApiError('conflict',{details:[{issue:'ambiguous-runtime-id'}]});
  }
  if(parsed)return value;
  try{return scopedId('legacy',kind,value);}catch{throw require('./errors').invalid('id','invalid-id');}
}
module.exports.resolveWireId=resolveWireId;
