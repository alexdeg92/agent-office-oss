'use strict';
// Runtime adapter registry (ADR-001 §3). The core asks for an adapter by id; it never imports adapter
// internals. One adapter per instance in 3.0 (PM decision on ADR-001 Q2); G4 picks it from the instance config.
// G6: `demo` synthesises a small team with no runtime at all (src/adapters/demo; ADR-001 §13)
const ADAPTERS = { openclaw: () => require('./openclaw'), demo: () => require('./demo'), 'claude-code': () => require('./claude-code'), codex: () => require('./codex') };
const ORCHESTRATOR_SOURCES = { herdr: () => require('./herdr'), 'agent-team-pm': () => require('./agent-team-pm') };

function adapterById(id) {
  const load = Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id] : null;
  if (!load) throw new Error('unknown runtime adapter: ' + id);
  return load();
}
const defaultAdapter = () => adapterById('openclaw');
function settingsCapabilities(id) {
  try { return adapterById(id).setup?.capabilities || {}; } catch { return {}; }
}
// Adapter-declared display metadata for runtime kinds emitted by orchestrators.
// The canonical team projection can brand harness-specific kinds without knowing
// provider names or maintaining a second provider registry.
function runtimePresentationFor(kind) {
  if (typeof kind !== 'string' || !kind) return null;
  for (const id of Object.keys(ADAPTERS)) {
    const adapter = adapterById(id), declaration = adapter.definition?.runtimePresentation;
    const alias = (declaration?.aliases || []).find(row => row.id === kind);
    if (kind !== id && !alias) continue;
    const label = declaration?.label || { key: 'team.runtime.other' };
    const mark = adapter.definition?.mark || adapter.setup?.capabilities?.brand || null;
    return Object.freeze({ runtime: id, label, qualifier: alias?.qualifier || null, brand: mark ? Object.freeze({
      mark: mark.mark || mark.monogram || 'R', color: mark.color || '#596579', foreground: mark.foreground || '#ffffff',
      providerName: mark.providerName || adapter.definition?.name || 'Runtime',
      ...(mark.logo ? { logo: mark.logo } : {}), ...(mark.logoDark ? { logoDark: mark.logoDark } : {}),
    }) : null });
  }
  return null;
}
const defaultAutoAdd = id => settingsCapabilities(id).autoAddDefault === true;
const settingsBrand = id => settingsCapabilities(id).brand || null;

const detectRuntimes = ctx => require('./detection').detectRuntimes(ctx);

// Host and team sources implement the same read-only source interface used by the engine.
// Callers select a declared source adapter here rather than reaching into provider internals.
function orchestratorSourceAdapter(id, options) {
  const load=Object.prototype.hasOwnProperty.call(ORCHESTRATOR_SOURCES,id)?ORCHESTRATOR_SOURCES[id]:null;
  if(!load)throw new Error('unknown orchestrator source adapter: '+id);
  return load().createSource(options);
}
function orchestratorSourceCapabilities(id) {
  const load=Object.prototype.hasOwnProperty.call(ORCHESTRATOR_SOURCES,id)?ORCHESTRATOR_SOURCES[id]:null;
  return load?.().setup?.capabilities || {};
}
const defaultSourceEnable=id=>orchestratorSourceCapabilities(id).autoEnableDefault===true;
const sourceBrand=id=>orchestratorSourceCapabilities(id).brand || null;
function detectOrchestratorSource(id,options) {
  const load=Object.prototype.hasOwnProperty.call(ORCHESTRATOR_SOURCES,id)?ORCHESTRATOR_SOURCES[id]:null;
  return load?.().detectSource?.(options) || null;
}

module.exports = { detectRuntimes, adapterById, defaultAdapter, settingsCapabilities, defaultAutoAdd, settingsBrand,
  orchestratorSourceAdapter, orchestratorSourceCapabilities, defaultSourceEnable, sourceBrand, detectOrchestratorSource,
  runtimePresentationFor, ADAPTER_IDS: Object.keys(ADAPTERS) };
