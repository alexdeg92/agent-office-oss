'use strict';
// agents.list → Agent[] (data-model.md §1).
const { redactText } = require('../../../security/redact-text');
const { normaliseLineage } = require('../../../engine/model/lineage');
function normaliseAgents(v, settings = null) {
  const byId = new Map((settings?.list || []).map((entry) => [entry.id, entry]));
  return v.agents.map((a) => {
    const primary = typeof a.model === 'string' ? a.model : a.model && a.model.primary ? a.model.primary : null;
    const configured = byId.get(a.id);
    const explicit = typeof configured?.model === 'string' ? configured.model.trim() : configured?.model?.primary?.trim();
    // The gateway returns resolved defaults too; model presence alone proves no per-agent override.
    const modelSource = a.modelSource || (settings ? (explicit ? 'explicit' : 'inherited') : null);
    const reportedRuntime = a.agentRuntime?.id;
    const externalRuntime = reportedRuntime && !['openclaw', 'embedded'].includes(reportedRuntime) ? reportedRuntime : null;
    const selectedRuntime = externalRuntime || (configured?.runtime?.type === 'acp'
      ? configured.runtime.acp?.agent || 'ACP'
      : reportedRuntime || configured?.agentRuntime?.id || settings?.defaults?.agentRuntime?.id || null);
    // Native execution uses the model; external identifiers are open, adapter-reported harness names.
    const runtime = selectedRuntime === 'openclaw' || selectedRuntime === 'embedded' ? null : selectedRuntime;
    return {
      id: a.id,
      spawnedBy: normaliseLineage(a.spawnedBy),
      name: a.name || a.id,
      displayName: redactText(a.displayName || a.name || null, { maxLength: 120 }),
      summary: redactText(a.description || a.role || configured?.description || configured?.role || null),
      workspace: a.workspace || null,
      model: primary ? { primary, provider: primary.includes('/') ? primary.split('/')[0] : null } : null,
      modelSource, runtime,
      fallbackModels: a.model && typeof a.model === 'object' && Array.isArray(a.model.fallbacks) ? a.model.fallbacks.slice() : [],
      // G3a (ADR §12.2): the runtime's own default only; no 'main' guess (the core resolver decides without one)
      isPrimary: !!v.defaultId && a.id === v.defaultId,
      mainSessionKey: !!v.defaultId && a.id === v.defaultId ? v.mainKey || null : null,
    };
  });
}
module.exports = { normaliseAgents };
