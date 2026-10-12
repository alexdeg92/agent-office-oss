'use strict';
const { EventEmitter } = require('node:events');
const { adapterById, defaultAutoAdd } = require('./adapters');
const { createEngine } = require('./engine');
const { createMultiEngine } = require('./engine/multi');
const { scopedId, parseId } = require('./runtime-ids');
function closeSource(item) {
  item.fence?.();
  clearTimeout(item.startRetry); item.stopped = true;
  for (const target of [item.runtime, item.engine]) {
    try { Promise.resolve(target?.close?.()).catch(() => {}); } catch {}
  }
}
function createMultiRuntimeController({ cfg: initial, store, cliEnv, resolveAdapter = adapterById, timeoutMs = 5000, authorization = false }) {
  const resources=authorization?require('./security/adapter-resources').createAdapterResourceBinding({store,resolveAdapter}):null;
  let cfg = initial, current, startSources = null, sources = null;
  let healthAuditSeq = 0;
  const recordHealthAudit = entry => {
    try { store.audit.append({ at: entry.at, requestId: `health-${entry.at}-${++healthAuditSeq}`, actor: { kind: 'system', component: 'engine' },
      command: 'health.remedy', target: entry.actionId, outcome: entry.outcome === 'completed' ? 'ok' : 'failed', detail: entry.outcome === 'completed' ? null : entry.outcome }); } catch {}
  };
  const events = new EventEmitter(), forwards = [];
  const liveState = { rows: [], sequence: 0, compatAliases: store.runtimeAliases?.load() };
  const autoAddDefault = spec => defaultAutoAdd(spec.adapter);
  const autoAddState = spec => store.runtimeAutoAdd?.get(spec.id,autoAddDefault(spec)) || {enabled:autoAddDefault(spec),managed:false,added:[],excluded:[]};
  function updateAgents(item,spec) { const state=autoAddState(spec),managed=state.managed||autoAddDefault(spec);item.engine?.updateAgents({names:spec.cfg.agentNames,hidden:spec.cfg.hiddenAgents||[],configured:spec.cfg.configuredAgents??(managed?[]:null),primary:spec.cfg.primaryAgent,autoAdded:state.added.map(x=>x.id),excluded:state.excluded,manageAutoAdd:managed});return state; }
  const core = createEngine({ adapter: { id: 'core', schemas: {}, routes: {}, classifySession: () => ({ kind: 'unrecognized', agentId: null }), normalise: { session: row => ({session:row}), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) }, capabilities: () => ({}) } });
  const senderContext = () => ({ operator: store.owner, people: store.persons.senderPeople() });
  const facade = get => new Proxy({}, { get: (_, key) => {
    if (key === 'on') return events.on.bind(events);
    if (key === 'removeListener') return events.removeListener.bind(events);
    const value = get()?.[key]; return typeof value === 'function' ? value.bind(get()) : value;
  } });
  function prepare(next) {
    const resourceToken=resources?.prepare(next);
    const reused = new Set();
    const instances = next.runtimeInstances.map(spec => {
      const old = current?.instances.find(i => i.id === spec.id && i.enabled && i.adapter === spec.adapter && !i.failure);
      if (spec.enabled && old && JSON.stringify(old.config) === JSON.stringify(spec.config) && old.cfg.gatewayToken === spec.cfg.gatewayToken && old.cfg.gatewayUrl === spec.cfg.gatewayUrl) { reused.add(old); return old; }
      const item = { ...spec, engine: null, runtime: null, failure: null };
      if (!item.enabled) return item;
      try {
        const A = resolveAdapter(spec.adapter);
        const policy=autoAddState(spec),managed=policy.managed||autoAddDefault(spec),configured=spec.cfg.configuredAgents??(managed?[]:null);
        item.runtime = A.createRuntime(spec.cfg, { senderCaptures: require('./sender-captures-instance').scopedCaptures(store.senderCaptures, spec.id, spec.adapter), cliEnv });
        item.engine = createEngine({ adapter: item.runtime.definition || A.definition, runtimeId: spec.id, primary: spec.cfg.primaryAgent,
          onHealthAudit: recordHealthAudit,
          agentNames: spec.cfg.agentNames, hiddenAgents: spec.cfg.hiddenAgents || [], configuredAgents: configured,
          autoAddedAgents: policy.added.map(x => x.id), excludedAgents: policy.excluded, autoAddManaged: managed,
          onAutoAddAgent: id => { try { const result = store.runtimeAutoAdd?.autoAdd(spec.id, id, autoAddDefault(spec)); return ['added', 'already-added'].includes(result?.status); } catch { return false; } }, senderContext: () => {
            const context = senderContext(); return { ...context, people: context.people.filter(p => { const link = parseId(p.links?.agentId, 'agent'); return !link || link.runtime === spec.id; }).map(p => {
              const link = parseId(p.links?.agentId, 'agent'); return link ? { ...p, links: { ...p.links, agentId: link.local } } : p;
            }) };
          } });
        const bound = item.engine;
        // Closing a source fences every ingestion entry point, including late promises.
        let active = true;
        const tap = new Proxy(bound, { get: (target, key) => {
          if (['ingest', 'ingestCanonical', 'setGatewayConnected', 'setSourceDown', 'setObservedActivity'].includes(key)) return (...args) => active ? target[key]?.(...args) : { ok: false, category: 'source-replaced' };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        item.tap = tap; item.fence = () => { active = false; };
        item.runtime.attach(tap);
        updateAgents(item,spec);
      } catch {
        item.failure = 'upstream-failed'; closeSource(item);
      }
      return item;
    });
    const engine = createMultiEngine({ instances, primary: next.primaryAgent, timeoutMs, liveState, core,
      persistAliases: store.runtimeAliases ? (hashes, overflow) => store.runtimeAliases.remember(hashes, overflow) : null });
    const chosen = () => {
      const primary = parseId(engine.primaryAgent()?.id, 'agent');
      return instances.find(i => i.enabled && i.id === primary?.runtime) || instances.find(i => i.enabled && i.runtime && !i.failure);
    };
    const primaryInstance = () => {
      const primary = parseId(cfg.primaryAgent || current?.engine.primaryAgent()?.id, 'agent');
      return instances.find(i => i.enabled && !i.failure && i.id === primary?.runtime);
    };
    const capabilities = name => ({ agentTurn: c => c.chat, flowCreate: c => c.flows?.write,
      flowEdit: c => c.flows?.write, flowSetEnabled: c => c.flows?.write, flowRun: c => c.flows?.write,
      flowDelete: c => c.flows?.write, skillSetEnabled: c => c.skills?.toggle, restartGateway: c => c.restart })[name];
    const commands = new Proxy({}, { get: (_, name) => capabilities(name) ? async (...args) => {
      const kind = String(name).startsWith('flow') && name !== 'flowCreate' ? 'flow' : name === 'skillSetEnabled' ? 'skill' : 'agent';
      const key = typeof args[0] === 'string' ? args[0] : args[0]?.agentId;
      const eligible = instances.filter(i => i.enabled && !i.failure && capabilities(name)(i.engine?.runtime().capabilities || {}));
      const target = args[0]?.runtimeId;
      const owned = key ? engine.owner(key, kind) : { instance: target ? eligible.find(i => i.id === target) : eligible.length === 1 ? eligible[0] : null, local: null };
      const i = owned.instance;
      if (target && i?.id !== target) return {failed:'wrong-runtime',ok:false};
      if (name === 'agentTurn' && args[0]?.background && i !== primaryInstance()) return {failed:'wrong-runtime',ok:false};
      if (!i || i.failure || !capabilities(name)(i.engine.runtime().capabilities || {}) || typeof i.runtime.commands?.[name] !== 'function') return { failed: 'capability-unavailable', ok: false };
      if (cfg.readonly) return { failed: 'readonly', ok: false };
      if (name === 'agentTurn' && args[0]?.sessionRef) {
        const ref = args[0].sessionRef, parsed = parseId(ref, 'session');
        if (parsed && parsed.runtime !== i.id) return {failed:'wrong-runtime',ok:false};
        const prefix = 'agent:' + key + ':';
        args[0] = { ...args[0], sessionRef: parsed?.local || (ref.startsWith(prefix) ? 'agent:' + owned.local + ':' + ref.slice(prefix.length) : ref) };
      }
      if (typeof args[0] === 'string') args[0] = owned.local;
      else if (args[0]?.agentId) args[0] = { ...args[0], agentId: owned.local };
      if (name === 'agentTurn' && args[0]?.background) args[0] = { ...args[0],
        canDispatch: () => !cfg.readonly && !i.stopped && current?.instances.includes(i) && i === primaryInstance() };
      if (args[0]?.runtimeId) { args[0] = { ...args[0] }; delete args[0].runtimeId; }
      const result = await engine.bounded(i, () => i.runtime.commands[name](...args));
      try { return result?.jobId ? { ...result, jobId: scopedId(i.id, 'flow', result.jobId) } : result; }
      catch { i.engine.quarantine.record({channel:'canonical.flows',code:'shape.invalid',severity:'error',path:'$.canonical.cronJob.id'});return{ok:false,failed:'unavailable',category:'invalid-identity'}; }
    } : undefined });
    const runtime = {
      commands,
      definitionFor(key) { return engine.owner(key, parseId(key)?.entity || 'session').instance?.runtime.definition || {}; },
      get definition() {
        const selected = chosen();
        return { ...(selected?.runtime?.definition || {}), sessionKeyFor(agentId, ref) {
          const { instance: i, local } = engine.owner(agentId, 'agent');
          return i?.runtime.definition.sessionKeyFor ? scopedId(i.id, 'session', i.runtime.definition.sessionKeyFor(local, ref)) : null;
        } };
      },
      start(_, hooks = {}) {
        for (const i of instances) if (i.enabled && i.runtime && !i.failure) {
          i.hooks = hooks;
          if (!reused.has(i)) {
            const launch = async () => {
              if (i.stopped) return;
              const result = await engine.bounded(i, () => i.runtime.start(i.tap, { refreshed: () => i.hooks?.refreshed?.() }));
              // A timed-out start may still be running. Never stack another
              // uncooperative operation; replacing the source fences it.
              if (result?.ok === false && result.category !== 'timeout' && !i.stopped) {
                const delay=Math.min(30000,2000*2**Math.min(4,i.startFailures || 0));i.startFailures=(i.startFailures || 0)+1;
                i.startRetry=setTimeout(launch,delay);i.startRetry.unref?.();
              } else i.startFailures=0;
            };
            void launch();
          }
        }
      },
      refreshFlows: () => Promise.allSettled(instances.filter(i => i.enabled && !i.failure).map(i => engine.bounded(i, () => i.runtime.refreshFlows?.()))),
      refreshSkills: () => Promise.allSettled(instances.filter(i => i.enabled && !i.failure).map(i => engine.bounded(i, () => i.runtime.refreshSkills?.()))),
      skillDoc: (file, key) => (key ? engine.owner(key, 'skill').instance : chosen())?.runtime.skillDoc?.(file),
      get gw() { return chosen()?.runtime?.gw; },
      close(keep = new Set()) { for (const i of instances) if (!keep.has(i)) closeSource(i); engine.close(); },
    };
    return { cfg: next, instances, engine, runtime, reused, resourceToken };
  }
  function connect(value,bound=false) {
    if(resources&&!bound)resources.apply(value.resourceToken,value.cfg);
    for (const [e, name, fn] of forwards.splice(0)) e.removeListener(name, fn);
    current = value; cfg = value.cfg;
    for (const name of ['change', 'ingested', 'live']) {
      const fn = (...args) => events.emit(name, ...args); current.engine.on(name, fn); forwards.push([current.engine, name, fn]);
    }
    current.engine.quarantine.restore(store.quarantine.loadAll());
    for (const instance of [...current.instances, { engine: current.engine }]) instance.engine?.startHealthLoop?.();
    if (startSources) sources = startSources({ engine: current.engine, runtime: current.runtime });
  }
  current = prepare(cfg); connect(current);
  return { engine: facade(() => current.engine), runtime: facade(() => current.runtime),
    cfg: new Proxy({}, { get: (_, key) => cfg[key] }), prepare,
    dispose: value => value?.runtime.close(value.reused),
    start(fn) { startSources = fn; sources = fn({ engine: current.engine, runtime: current.runtime }); },
    apply(next, prepared = null) {
      resources?.apply(prepared?.resourceToken||resources.prepare(next),next);
      if (prepared) { store.flushQuarantine(); sources?.close(); current.runtime.close(prepared.reused); connect(prepared,true); }
      else {
        cfg = next; current.cfg = next; current.engine.updatePrimary(next.primaryAgent);
        for (const i of current.instances) {
          const updated = next.runtimeInstances.find(r => r.id === i.id);
          if (updated) i.name=updated.name;
          if (updated?.enabled && i.engine) updateAgents(i,updated);
        }
      }
      if (prepared) for (const i of current.instances) { const spec = next.runtimeInstances.find(r => r.id === i.id); if (spec) i.name=spec.name; if (i.engine && spec) updateAgents(i,spec); }
      events.emit('change', { channel: 'settings' });
    },
    refreshAutoAdd(runtimeId) { const item=current.instances.find(i=>i.id===runtimeId),spec=cfg.runtimeInstances.find(i=>i.id===runtimeId);if(item?.engine&&spec)updateAgents(item,spec);events.emit('change',{channel:'settings.auto-add'}); },
    close() { sources?.close(); current.runtime.close(); core.close(); for (const [e, name, fn] of forwards.splice(0)) e.removeListener(name, fn); },
  };
}
module.exports = { createMultiRuntimeController };
