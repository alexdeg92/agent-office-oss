'use strict';
const {createResourceRegistry}=require('./resources');
// Adapter exports are validated before runtime preparation; preparation never changes live grants.
function createAdapterResourceBinding({store,resolveAdapter}) {
  const prepared=new WeakMap();
  function prepare(cfg) {
    const ids=[...new Set(cfg.runtimeInstances?cfg.runtimeInstances.filter(r=>r.enabled).map(r=>r.adapter):[cfg.runtimeAdapter])].sort();
    const extensions=ids.map(namespace=>{const adapter=resolveAdapter(namespace);return {namespace,resources:adapter.permissionResources===undefined?[]:adapter.permissionResources};});
    const registry=createResourceRegistry(extensions);
    const old=new Map(store.db.prepare('SELECT key,parent,namespace FROM permission_resources').all().map(d=>[d.key,d]));
    for(const d of registry.list()) {
      const previous=old.get(d.key);
      if(previous&&(previous.parent!==d.parent||previous.namespace!==d.namespace))throw new Error('resource identity changed');
    }
    const rows=ids.map(namespace=>Object.freeze({namespace,resources:Object.freeze(registry.list().filter(d=>d.namespace===namespace))}));
    const token=Object.freeze({});prepared.set(token,{cfg,extensions:Object.freeze(rows)});return token;
  }
  function apply(token,cfg) {
    const value=prepared.get(token);if(!value||value.cfg!==cfg)throw new Error('unprepared resource binding');
    if(store.db.isTransaction)throw new Error('resource binding requires its own transaction');
    const previous=store.registry.list().filter(d=>d.namespace!=='core');
    const prior=[...new Set(previous.map(d=>d.namespace))].map(namespace=>({namespace,resources:previous.filter(d=>d.namespace===namespace)}));
    store.registry.replaceAdapters(value.extensions);
    try {store.rbac.sync(store.registry);}catch(error){store.registry.replaceAdapters(prior);throw error;}
  }
  return {prepare,apply};
}
module.exports={createAdapterResourceBinding};
