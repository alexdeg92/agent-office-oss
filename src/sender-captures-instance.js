'use strict';
// Exact native event keys stay adapter-owned; the repository discriminator is a
// stable instance ID. Only the migrated legacy source can read old kind-keyed rows.
function scopedCaptures(repo, instance, adapter) {
  if (!repo) return repo;
  return { ...repo,
    get(_kind, session, event) { const value = repo.get(instance, session, event) || (instance === 'legacy' ? repo.get(adapter, session, event) : null); return value ? { ...value, runtime: adapter } : null; },
    putMany(rows) { return repo.putMany(rows.map(r => ({ ...r, runtime: instance, sender: { ...r.sender, runtime: instance } }))); } };
}
module.exports = { scopedCaptures };
