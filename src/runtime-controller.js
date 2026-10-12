'use strict';
// Stable consumers (store/router/SSE) follow a replaceable adapter+engine. Old taps
// retain their old engine and cannot ingest a late reply into the new runtime.
const { EventEmitter } = require('node:events');
const { adapterById } = require('./adapters');
const { createEngine } = require('./engine');
function createRuntimeController({ cfg: initial, store, start = null, cliEnv, authorization = false, resolveAdapter = adapterById }) {
  if (initial.runtimeInstances) return require('./multi-runtime-controller').createMultiRuntimeController({ cfg: initial, store, cliEnv, authorization, resolveAdapter });
  const resources=authorization?require('./security/adapter-resources').createAdapterResourceBinding({store,resolveAdapter}):null;
  let cfg = initial, current, sources = null;
  const events = new EventEmitter();
  const forwards = [];
  const names = new Proxy({}, { get: (_, key) => cfg.agentNames?.[key], ownKeys: () => Object.keys(cfg.agentNames || {}),
    getOwnPropertyDescriptor: (_, key) => Object.hasOwn(cfg.agentNames || {}, key) ? { configurable: true, enumerable: true, value: cfg.agentNames[key] } : undefined });
  const config = new Proxy({}, { get: (_, key) => key === 'agentNames' ? names : cfg[key] });
  const facade = (get, eventsFacade = false) => new Proxy({}, { get: (_, key) => {
    if (eventsFacade && key === 'on') return events.on.bind(events);
    if (eventsFacade && key === 'removeListener') return events.removeListener.bind(events);
    const value = get()?.[key]; return typeof value === 'function' ? value.bind(get()) : value;
  } });
  const engine = facade(() => current.engine, true);
  const commands = facade(() => current.runtime.commands);
  const runtime = new Proxy(facade(() => current.runtime), { get: (target, key) => key === 'commands' ? commands : target[key] });
  function prepare(next) {
    const resourceToken=resources?.prepare(next);
    if (next.runtimeInstances) {
      if (current?.multiController) return { ...current.multiController.prepare(next), resourceToken, multiPrepared: true, multiController: current.multiController };
      const multiController = require('./multi-runtime-controller').createMultiRuntimeController({ cfg: next, store, cliEnv, resolveAdapter });
      const legacy = multiController.engine.instances.find(i => i.id === 'legacy' && i.adapter === current?.cfg.runtimeAdapter);
      if (legacy?.engine && current) {
        legacy.engine.ingestCanonical('agents', current.engine.detectedAgents());
        legacy.engine.ingestCanonical('sessions.snapshot', current.engine.sessions());
        legacy.engine.ingestCanonical('flows', current.engine.cronJobs());
        legacy.engine.ingestCanonical('channels', current.engine.channels());
        legacy.engine.ingestCanonical('skills', current.engine.skills());
      }
      return { engine: multiController.engine, runtime: multiController.runtime, cfg: next, multiController, resourceToken };
    }
    const adapter = resolveAdapter(next.runtimeAdapter);
    const rt = adapter.createRuntime(next, { senderCaptures: store.senderCaptures, cliEnv });
    const e = createEngine({ adapter: rt.definition || adapter.definition, primary: next.primaryAgent, agentNames: next.agentNames,
      hiddenAgents: next.hiddenAgents || [], configuredAgents: next.configuredAgents || null, senderContext: () => ({ operator: store.owner, people: store.persons.senderPeople() }) });
    try { rt.attach(e); } catch (err) { dispose({ runtime: rt }); throw err; }
    return { engine: e, runtime: rt, cfg: next, resourceToken };
  }
  function dispose(value) { if (!value) return; if (value.multiPrepared) return value.multiController.dispose(value); if (value.multiController) return value.multiController.close(); value.runtime.close?.(); value.runtime.gw?.close?.(); }
  function connect(value,bound=false) {
    if(resources&&!bound)resources.apply(value.resourceToken,value.cfg);
    for (const [e, name, fn] of forwards.splice(0)) e.removeListener(name, fn);
    current = value; cfg = value.cfg;
    for (const name of ['change', 'ingested', 'live']) {
      const fn = (...args) => events.emit(name, ...args); current.engine.on(name, fn); forwards.push([current.engine, name, fn]);
    }
    current.engine.quarantine.restore(store.quarantine.loadAll());

    if (start) {
      if (current.multiController) { current.multiController.start(start); sources = null; }
      else sources = start({ engine: current.engine, runtime: current.runtime });
    }
  }
  current = prepare(cfg); connect(current);
  return { engine, runtime, cfg: config, prepare, dispose,
    start(fn) { start = fn; if (current.multiController) current.multiController.start(fn); else sources = start({ engine: current.engine, runtime: current.runtime }); },
    apply(next, prepared = null) {
      resources?.apply(prepared?.resourceToken||resources.prepare(next),next);
      if (prepared?.multiPrepared) { cfg = next; current.cfg = next; current.multiController.apply(next, prepared); events.emit('change', { channel: 'settings' }); return; }
      if (prepared) { store.flushQuarantine(); sources?.close(); dispose(current); connect(prepared,true); }
      else { cfg = next; current.cfg = next; if (current.multiController) current.multiController.apply(next); else current.engine.updateAgents({ names: next.agentNames, hidden: next.hiddenAgents, primary: next.primaryAgent, configured: next.configuredAgents || null }); }
      events.emit('change', { channel: 'settings' });
    },
    close() { sources?.close(); dispose(current); for (const [e, name, fn] of forwards.splice(0)) e.removeListener(name, fn); },
  };
}
module.exports = { createRuntimeController };
