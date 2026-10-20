'use strict';
const RANK = Object.freeze({none:0,read:1,write:2});
function effective(snapshot, registry, key, visited = new Set()) {
  const resource = registry.get(key);
  if (!resource || !snapshot || !snapshot.activeResources.has(key) || snapshot.user.status!=='active' || visited.has(key)) return 'none';
  if (snapshot.role.id==='rol_admin') return 'write';
  if (resource.adminOnly) return 'none';
  visited.add(key);
  const parent = resource.parent ? effective(snapshot,registry,resource.parent,visited) : null;
  if (resource.parent && RANK[parent]<RANK.read) return 'none';
  if (Object.hasOwn(snapshot.overrides,key)) return snapshot.overrides[key];
  const grant = snapshot.permissions[key];
  if (!grant) return 'none';
  if (grant.mode==='explicit' && Object.hasOwn(RANK,grant.level)) return grant.level;
  return resource.parent && grant.mode==='inherit-parent' ? parent : 'none';
}
function createPolicy({snapshot,registry}) {
  function permissions(user) {
    const current=snapshot(typeof user==='string' ? user : user?.id);
    return Object.fromEntries(registry.list().map(d=>[d.key,effective(current,registry,d.key)]));
  }
  function can(user,key,level) {
    if (level!=='read' && level!=='write') return false;
    const current=snapshot(typeof user==='string' ? user : user?.id);
    return RANK[effective(current,registry,key)]>=RANK[level];
  }
  return Object.freeze({can,permissions});
}
module.exports = {RANK,effective,createPolicy};
