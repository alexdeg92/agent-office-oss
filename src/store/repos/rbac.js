'use strict';
const {withTx} = require('../tx');
// Repository owns SQL; policy only consumes validated current snapshots.
function createRbacRepo(db,{changed:notify=()=>{}}={}) {
  const state=db.prepare('SELECT * FROM authorization_state WHERE singleton=1');
  const userById=db.prepare('SELECT * FROM users WHERE id=?');
  const roleById=db.prepare('SELECT * FROM roles WHERE id=?');
  const permissions=db.prepare('SELECT resource,mode,level FROM role_permissions WHERE role_id=?');
  const overrides=db.prepare('SELECT resource,level FROM user_overrides WHERE user_id=?');
  function snapshot(id) {
    if (typeof id!=='string') return null;
    const user=userById.get(id); if (!user) return null;
    const role=roleById.get(user.role_id); if (!role) return null;
    return {user,role,permissions:Object.fromEntries(permissions.all(role.id).map(g=>[g.resource,{mode:g.mode,level:g.level}])),
      overrides:Object.fromEntries(overrides.all(id).map(g=>[g.resource,g.level])),registryRevision:state.get().registry_revision,
      activeResources:new Set(db.prepare('SELECT key FROM permission_resources WHERE active=1').all().map(d=>d.key))};
  }
  function sync(registry) {
    if(db.isTransaction)throw new Error('registry synchronization requires its own transaction');
    let changed=false;
    const revision=withTx(db,()=>{
      const previous=db.prepare('SELECT * FROM permission_resources').all(), byKey=new Map(previous.map(d=>[d.key,d]));
      const pending=registry.list();
      // Preserve all permission rows. A new descriptor is not a new grant.
      while (pending.length) {
        const at=pending.findIndex(d=>!d.parent || byKey.has(d.parent));
        if (at<0) throw new Error('invalid resource graph');
        const d=pending.splice(at,1)[0], old=byKey.get(d.key);
        if (old && (old.parent!==d.parent || old.namespace!==d.namespace)) throw new Error('resource identity changed');
        if (!old) {db.prepare('INSERT INTO permission_resources(key,parent,namespace,active) VALUES (?,?,?,1)').run(d.key,d.parent,d.namespace);changed=true;}
        else if (!old.active) {db.prepare('UPDATE permission_resources SET active=1 WHERE key=?').run(d.key);changed=true;}
        byKey.set(d.key,d);
      }
      for (const old of previous) if (old.active && !registry.has(old.key)) {db.prepare('UPDATE permission_resources SET active=0 WHERE key=?').run(old.key);changed=true;}
      if(changed) db.prepare('UPDATE authorization_state SET registry_revision=registry_revision+1 WHERE singleton=1').run();
      return state.get().registry_revision;
    });
    if(changed)notify({registry:true});
    return revision;
  }
  return {snapshot,sync,state:()=>state.get(),role:id=>roleById.get(id)||null,
    roles:()=>db.prepare('SELECT * FROM roles ORDER BY builtin DESC,slug').all(),
    fingerprint:id=>{const s=snapshot(id);return s ? [s.user.id,s.user.auth_generation,s.user.role_id,s.role.revision,s.user.permission_revision,s.registryRevision].join(':') : null;}};
}
module.exports={createRbacRepo};
