'use strict';
// One severity/fix projection for every Settings consumer. Instance association
// belongs to runtime-detections; this builder never matches or invents sources.
const label = (key, params) => ({ key: 'settings.' + key, ...(params ? {params} : {}) });
function declaredFix(kind, id, target = {}, params = {}, options = {}) {
  return { id: kind + ':' + id, kind, target: { runtime: target.runtime ?? null, agentId: target.agentId ?? null, integration: target.integration ?? null },
    label: label('fix.' + kind, params), detail: kind === 'runtime.enable' ? label('fix.runtime.enableDetail') : null,
    automatic: false, requiresInput: true, requiresConsent: false, requiresReauth: !['agent.configure','client.reload'].includes(kind), requiresRestart: false, ...options };
}
function diagnostics({ runtimes, agents, orchestrator = null, permissionOk, stale, restartRequired, readonly }) {
  const rows = runtimes.filter(r => r.selected || r.found || !r.candidate).map(r => {
    const healthy = r.connection.status === 'connected', limited = r.connection.status === 'capacity-limited';
    // A newly discovered connector is evidence for the owner, not a failing
    // configured connection. Its setup controls live in Connexion; adding a
    // warning/fix here duplicates that onboarding and makes the notice noisy.
    const discoveredCandidate = r.candidate && r.found;
    const discoveredUnsupported = discoveredCandidate && !r.supported;
    const enable = !r.candidate && !r.enabled;
    return { id: 'runtime:' + r.id,
      level: !r.supported || discoveredCandidate ? 'info' : healthy ? 'ok' : limited ? 'warning' : r.selected ? 'error' : r.found ? 'warning' : 'info',
      label: label(discoveredCandidate ? (discoveredUnsupported ? 'diagnostic.unsupported' : 'diagnostic.detected') : 'diagnostic.' + r.connection.status, {runtime:r.name}),
      detail: discoveredCandidate ? label(discoveredUnsupported ? 'diagnostic.unsupportedDetail' : 'diagnostic.detectedDetail') : r.connection.protocol !== null ? label('diagnostic.protocol', {protocol:r.connection.protocol,latencyMs:r.connection.latencyMs ?? 0}) : null,
      section: r.supported ? 'connection' : 'runtimes',
      fix: !r.supported || discoveredCandidate || healthy ? null : declaredFix(enable ? 'runtime.enable' : 'runtime.configure', r.id, {runtime:r.id}, {runtimeName:r.name},
        enable ? {requiresInput:false,requiresConsent:true} : {}) };
  });
  const runtimeById = new Map(runtimes.map(runtime => [runtime.id, runtime]));
  const discoveredByConnector = new Map();
  for (const a of agents) {
    // A detected but deliberately unconfigured/auto-excluded agent is useful
    // inventory, not a broken setting. Report the inventory once per connector.
    if (!a.configured) {
      if (a.hidden) continue;
      // Group by runtime instance, not adapter id: each count must navigate to
      // the same inventory slice it describes when an adapter has instances.
      const runtime = runtimeById.get(a.runtime), connector = a.runtime;
      const group = discoveredByConnector.get(connector) || { count:0, name:runtime?.name || connector };
      group.count++;
      discoveredByConnector.set(connector,group);
      continue;
    }
    const issue = a.configured && a.integrations.find(i => i.status !== 'installed');
    const kind = issue && ({missing:'integration.install',outdated:'integration.update',modified:'integration.review'})[issue.status];
    rows.push({ id: 'agent:' + a.id, level: issue?.status === 'unsupported' ? 'info' : !a.configured || issue ? 'warning' : 'ok',
      label: label(issue ? 'diagnostic.integration.' + issue.status : a.configured ? 'diagnostic.agentConfigured' : 'diagnostic.agentFound', {agent:a.name || a.agentId}),
      detail: issue ? label('diagnostic.integrationDetail.' + issue.status, {integration:issue.id}) : null, section: a.configured ? 'integrations' : 'runtimes',
      fix: kind ? declaredFix(kind,a.id+':'+issue.id,{runtime:a.runtime,agentId:a.agentId,integration:issue.id},{agentName:a.name || a.agentId,integration:issue.id},
        {automatic:kind !== 'integration.review',requiresInput:kind === 'integration.review'}) : null });
  }
  for (const [connector,group] of discoveredByConnector) rows.push({id:'detected-agents:'+connector,level:'info',
    label:label(group.count===1?'diagnostic.detectedAgent':'diagnostic.detectedAgents',{n:group.count,runtime:group.name}),detail:null,section:'runtimes',fix:null});
  if (orchestrator?.detected && !orchestrator.enabled) rows.push({ id:'orchestrator:detected', level:'info',
    label:label('diagnostic.orchestratorDetected',{source:orchestrator.label || 'orchestrator'}), detail:null, section:'connection', fix:null });
  rows.push({ id:'permissions',level:permissionOk?'ok':'error',label:label(permissionOk?'diagnostic.privateFiles':'diagnostic.permissions'),detail:null,section:'diagnostic',fix:null },
    { id:'build',level:stale?'warning':'ok',label:label(stale?'diagnostic.staleBuild':'diagnostic.currentBuild'),detail:null,section:'diagnostic',fix:stale?declaredFix('client.reload','build'):null },
    { id:'restart',level:restartRequired?'warning':'ok',label:label(restartRequired?'diagnostic.restartRequired':'diagnostic.runningConfig'),detail:null,section:'instance',fix:restartRequired?declaredFix('instance.restart','restart',{}, {},{requiresRestart:true}):null });
  return readonly ? rows.map(row=>({...row,fix:null})) : rows;
}
module.exports = { diagnostics };
