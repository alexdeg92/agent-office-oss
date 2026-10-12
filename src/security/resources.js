'use strict';
// ADR-002 canonical registry. A descriptor is never itself a permission grant.
const ROOTS = ['office','chat','flows','projects','access','logs','skills','health','store','orchestrators','teams',
  'settings.runtimes','settings.integrations','settings.instance','settings.network','settings.restart','users','gateway.restart'];
const CHILDREN = ['flows.create','flows.edit','flows.run','flows.enable','flows.delete','projects.comment','projects.regenerate'];
const PRIVILEGED = new Set(['users','gateway.restart','orchestrators','teams', ...ROOTS.filter(k => k.startsWith('settings.'))]);
const CORE = Object.freeze([...ROOTS.map(key => ({key,parent:null})), ...CHILDREN.map(key => ({key,parent:key.split('.')[0]}))]
  .map(row => Object.freeze({...row, namespace:'core', labelKey:'permissions.'+row.key, privileged:PRIVILEGED.has(row.key)})));
const LEVELS = Object.freeze(['none','read','write']);
function createResourceRegistry(extensions = []) {
  const descriptors = new Map(CORE.map(d => [d.key,d]));
  function register(rows, namespace) {
    if (!Array.isArray(rows) || !/^[a-z][a-z0-9-]{0,40}$/.test(namespace)) throw new Error('invalid resource extension');
    const staged = new Map(descriptors);
    for (const row of rows) {
      const keyPattern=namespace==='core' ? /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/ : new RegExp('^adapter\\.'+namespace+'\\.[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)*$');
      if (!row || typeof row.key!=='string' || !keyPattern.test(row.key)
        || row.key.length>128 || staged.has(row.key) || typeof row.labelKey!=='string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(row.labelKey)
        || row.parent != null && (typeof row.parent!=='string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)*$/.test(row.parent)) || typeof row.privileged!=='boolean') throw new Error('invalid resource declaration');
      staged.set(row.key,Object.freeze({key:row.key,parent:row.parent ?? null,namespace,labelKey:row.labelKey,privileged:row.privileged}));
    }
    for (const d of staged.values()) {
      const seen = new Set([d.key]); let parent=d.parent;
      while (parent) { const p=staged.get(parent); if (!p || seen.has(parent) || p.namespace!==d.namespace) throw new Error('invalid resource parent'); seen.add(parent); parent=p.parent; }
    }
    for (const [key,d] of staged) descriptors.set(key,d);
  }
  for (const {namespace,resources} of extensions) register(resources,namespace);
  function replaceAdapters(extensions) {
    const extraCore=[...descriptors.values()].filter(d=>d.namespace==='core'&&!CORE.some(c=>c.key===d.key));
    const staged=createResourceRegistry([{namespace:'core',resources:extraCore},...extensions]);
    descriptors.clear();for(const d of staged.list())descriptors.set(d.key,d);
  }
  return Object.freeze({get:key=>descriptors.get(key)||null,has:key=>descriptors.has(key),list:()=>[...descriptors.values()],register,replaceAdapters});
}
module.exports = {CORE,ROOTS,CHILDREN,LEVELS,createResourceRegistry};
