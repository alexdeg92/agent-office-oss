'use strict';
// agents.list → Agent[] (data-model.md §1).
function normaliseAgents(v) {
  return v.agents.map((a) => {
    const primary = typeof a.model === 'string' ? a.model : a.model && a.model.primary ? a.model.primary : null;
    return {
      id: a.id,
      name: a.name || a.id,
      workspace: a.workspace || null,
      model: primary ? { primary, provider: primary.includes('/') ? primary.split('/')[0] : null } : null,
      fallbackModels: a.model && typeof a.model === 'object' && Array.isArray(a.model.fallbacks) ? a.model.fallbacks.slice() : [],
      // G3a (ADR §12.2): the runtime's own default only; no 'main' guess (the core resolver decides without one)
      isPrimary: !!v.defaultId && a.id === v.defaultId,
      mainSessionKey: !!v.defaultId && a.id === v.defaultId ? v.mainKey || null : null,
    };
  });
}
module.exports = { normaliseAgents };
