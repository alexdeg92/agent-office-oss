'use strict';
/*
 * T-0062: canonical lineage. `spawnedBy` names WHO CREATED an agent or a session: the spawner agent (`agentId`) and/or
 * the exact spawning session (`sessionKey`). One hop only (a chain is followed by the reader); it is not a supervisor
 * or work-delegation link. Any adapter or orchestrator source may fill it; the engine and the UI stay generic.
 *   via    open vocabulary the source declares: 'subagent-tool' (a model's sub-agent tool), 'orchestrator' (a pane or
 *          team member launched by a PM), 'runtime' (a native sub-session API), …
 *   label  optional role or task title, at most 120 code points, always through the shared redactor
 * Ids: a native id of the same runtime instance is scoped like every other id by the multi-runtime facade; a
 * cross-runtime spawner is given as an already-canonical scoped id (rt:<instance>:<kind>:…) and is passed through.
 * null (or absent; engine entities materialize it as null): no known spawner. A source never guesses one.
 */
const s = require('../../schema');
const { redactText } = require('../../security/redact-text');
const { parseId, scopedId } = require('../../runtime-ids');

const ID_MAX = 16532;   // the longest scoped identity topics.js admits
const Lineage = s.object({
  agentId: s.string().min(1).max(ID_MAX).nullable(),
  sessionKey: s.string().min(1).max(ID_MAX).nullable(),
  via: s.string().min(1).max(64).refine((v) => /^[a-z][a-z0-9-]*$/.test(v), 'lowercase vocabulary word'),
  label: s.string().max(120).nullable(),
}, { extra: 'reject' }).refine((v) => !!(v.agentId || v.sessionKey), 'a spawner agent or session is required');

/**
 * A source value → a valid Lineage, or null (no known spawner, or an unusable value). Never throws.
 * @param {object} [opts.scope] { instance } — scope native ids to this runtime instance (multi-runtime facade)
 */
function normaliseLineage(value, { scope = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = (v, kind) => {
    if (typeof v !== 'string' || !v || v.length > ID_MAX) return null;
    return scope && !parseId(v, kind) ? scopedId(scope.instance, kind, v) : v;
  };
  const agentId = ref(value.agentId, 'agent'), sessionKey = ref(value.sessionKey, 'session');
  if (!agentId && !sessionKey) return null;
  const via = typeof value.via === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.via) ? value.via : 'runtime';
  return { agentId, sessionKey, via, label: typeof value.label === 'string' ? redactText(value.label, { maxLength: 120 }) : null };
}

module.exports = { Lineage, normaliseLineage };
