'use strict';
const { adapterById, ADAPTER_IDS, defaultAutoAdd, settingsBrand } = require('../adapters');
const { parseId, scopedId, validNativeId } = require('../runtime-ids');
// Settings field controls use scalar text values; keep canonical array options in config/runtime data
// and serialize chip/textarea values as newline-delimited text for the browser contract.
const fieldValue = value => Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('\n') : value;
function runtimeRows({ config, cfg, engine, detections, checks, field, label, store }) {
  return require('./runtime-detections').runtimeDetections({ config, cfg, detections }).map(({ entry: r, detection: d, name }) => {
    const A = ADAPTER_IDS.includes(r.adapter) ? adapterById(r.adapter) : null, S = A?.setup.settings;
    const child = cfg.runtimeInstances?.find(i => i.id === r.id)?.cfg;
    const values = S ? child ? S.values(child) : S.detectedValues(d || {}) : {};
    const connection = engine.runtimes?.().find(i => i.id === r.id), checked = checks.get(r.id);
    const status = !S ? 'unsupported' : checked?.status || (!r.enabled ? 'not-configured' : connection?.connected ? 'connected' : 'unreachable');
    const defaultEnabled=defaultAutoAdd(r.adapter),policy=store?.runtimeAutoAdd?.get(r.id,defaultEnabled) || {enabled:defaultEnabled,managed:false};
    return { id: r.id, adapter: r.adapter, enabled: r.enabled, candidate: !!r.candidate, name: r.name || A?.setup.name || d?.name || name || r.adapter, brand: settingsBrand(r.adapter), optional:!!S?.optional,
      autoAdd: { enabled:policy.enabled, defaultEnabled, managed:!!policy.managed },
      supported: !!S, selected: r.enabled, ...require('./detection-state').detectionView(d, S?.optional && r.enabled),
      checkedPaths: d?.checkedPaths || [], fields: S?.fields || [], values: Object.fromEntries((S?.fields || []).map(f => [f.id,
        { ...field(f.writeOnly ? null : fieldValue(values[f.id] ?? null), r.id === 'legacy' ? S.envKeys[f.id] : null, !r.candidate), ...(f.writeOnly ? { tokenSet: !!values[f.id] || !!(r.candidate && d?.connection?.tokenSet) } : {}) }])),
      connection: { status, protocol: checked?.protocol ?? connection?.protocol ?? null, latencyMs: checked?.latencyMs ?? null, checkedAt: checked?.checkedAt ?? null } };
  });
}
function agentRows({ config, cfg, engine, detections = [], store = null, now = Date.now() }) {
  const rows = new Map(), primary = engine.primaryAgent()?.id ?? cfg.primaryAgent;
  const policyFor = runtime => store?.runtimeAutoAdd?.get(runtime,defaultAutoAdd(config.runtimes.find(r=>r.id===runtime)?.adapter)) || {enabled:false,added:[],excluded:[]};
  for (const { entry: r, detection } of require('./runtime-detections').runtimeDetections({ config, cfg, detections })) for (const a of detection?.agents || []) {
    if (!validNativeId(a?.id)) { engine.quarantine.record({channel:'vm.v3.settings',code:'shape.invalid',severity:'error',path:'$.agents[].id'}); continue; }
    const key = scopedId(r.id, 'agent', a.id); rows.set(key, { ...a, id:key, runtime:r.id, agentId:a.id });
  }
  for (const a of engine.detectedAgents?.() || engine.agents()) {
    const parsed = parseId(a.id, 'agent');
    if (parsed) rows.set(a.id, { ...a, ...rows.get(a.id), runtime: parsed.runtime, agentId: parsed.local });
  }
  for (const r of config.runtimes) { const policy=policyFor(r.id);for (const id of new Set([...Object.keys(config.agents.names?.[r.id] || {}), ...(config.agents.configured?.[r.id] || []),...policy.added.map(x=>x.id)])) {
    const key = scopedId(r.id, 'agent', id); if (!rows.has(key)) rows.set(key, { id: key, runtime: r.id, agentId: id, name: null });
  } }
  return [...rows.values()].map(a => {
    const names = config.agents.names?.[a.runtime] || {}, configuredIds = config.agents.configured?.[a.runtime];
    const policy=policyFor(a.runtime),added=policy.added.find(x=>x.id===a.agentId);
    const configured = (configuredIds ? configuredIds.includes(a.agentId) : Object.hasOwn(names, a.agentId) || a.id === primary)
      || !!added || policy.enabled && !policy.excluded.includes(a.agentId);
    const kind = config.runtimes.find(r => r.id === a.runtime)?.adapter;
    const A = ADAPTER_IDS.includes(kind) ? adapterById(kind) : null;
    return { id: a.id, runtime: a.runtime, agentId: a.agentId, name: Object.hasOwn(names, a.agentId) ? names[a.agentId] : a.name || null,
      detectedName: a.name || null, nameSource: a.nameSource || (a.name ? 'runtime' : null), configured, hidden: (config.agents.hidden?.[a.runtime] || []).includes(a.agentId)||policy.excluded.includes(a.agentId),
      autoAddedAt:added?.at??null,isNew:!!added&&store.runtimeAutoAdd.isNew(policy,a.agentId,now),
      isPrimary: a.id === primary, model: a.model?.primary || null,
      lookRoute: configured ? '/boutique?onglet=personnages&agent=' + encodeURIComponent(a.id === primary ? 'primary' : 'agent:' + a.id) : null,
      integrations: A?.projectTag ? [{ id: 'projet', status: 'missing' }] : [] };
  });
}
module.exports = { runtimeRows, agentRows };
