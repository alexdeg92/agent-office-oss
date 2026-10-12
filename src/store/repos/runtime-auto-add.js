'use strict';
const { withTx } = require('../db');
const { INSTANCE_ID, validNativeId } = require('../../runtime-ids');
const LIMIT = 2000, NEW_MS = 86400000;
function createRuntimeAutoAddRepo(db, { now = () => Date.now(), onInvalid = () => {} } = {}) {
  const getRow = db.prepare('SELECT enabled, added, excluded, updated_at FROM runtime_auto_add WHERE runtime_id = ?');
  const put = db.prepare(`INSERT INTO runtime_auto_add(runtime_id,enabled,added,excluded,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(runtime_id) DO UPDATE SET enabled=excluded.enabled, added=excluded.added, excluded=excluded.excluded, updated_at=excluded.updated_at`);
  function validId(id) { if (!INSTANCE_ID.test(id || '')) throw Object.assign(new Error('invalid runtime id'), { code: 'EIDENTITY' }); }
  function validAgent(id) { if (!validNativeId(id)) throw Object.assign(new Error('invalid agent id'), { code: 'EIDENTITY' }); }
  function decode(id, row, defaultEnabled) {
    if (!row) return { runtimeId:id, enabled:!!defaultEnabled, managed:false, added:[], excluded:[], updatedAt:null };
    try {
      const added=JSON.parse(row.added), excluded=JSON.parse(row.excluded);
      if (![0,1].includes(row.enabled) || !Array.isArray(added) || added.length>LIMIT || !Array.isArray(excluded) || excluded.length>LIMIT
        || !added.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&validNativeId(x.id)&&Number.isSafeInteger(x.at)&&x.at>=0)
        || new Set(added.map(x=>x.id)).size!==added.length || !excluded.every(validNativeId) || new Set(excluded).size!==excluded.length) throw Error();
      return { runtimeId:id, enabled:row.enabled===1, managed:true, added, excluded, updatedAt:row.updated_at };
    } catch { onInvalid('runtime_auto_add'); return { runtimeId:id, enabled:false, managed:true, added:[], excluded:[], updatedAt:row.updated_at, invalid:true }; }
  }
  function read(id, defaultEnabled=false) { validId(id); return decode(id,getRow.get(id),defaultEnabled); }
  function healthy(state) { if(state.invalid) throw Object.assign(new Error('runtime auto-add policy requires explicit recovery'),{code:'EPOLICYINVALID'}); }
  function write(id, state) { put.run(id,state.enabled?1:0,JSON.stringify(state.added),JSON.stringify(state.excluded),now()); return state; }
  function setEnabled(id, enabled, defaultEnabled=false) {
    if(typeof enabled!=='boolean') throw Object.assign(new Error('invalid auto-add setting'),{code:'EINVAL'});
    return withTx(db,()=>{const state=read(id,defaultEnabled);healthy(state);state.enabled=enabled;return write(id,state);});
  }
  function autoAdd(id, agentId, defaultEnabled=false) {
    validAgent(agentId);
    return withTx(db,()=>{const state=read(id,defaultEnabled);healthy(state);if(!state.enabled)return {status:'disabled',state};if(state.excluded.includes(agentId))return {status:'excluded',state};if(state.added.some(x=>x.id===agentId))return {status:'already-added',state};if(state.added.length>=LIMIT)return {status:'capacity',state};state.added.push({id:agentId,at:now()});write(id,state);return {status:'added',state};});
  }
  function markAdded(id, agentId, defaultEnabled=false) {
    validAgent(agentId);
    return withTx(db,()=>{const state=read(id,defaultEnabled);healthy(state);if(state.excluded.includes(agentId))return {status:'excluded',state};if(state.added.some(x=>x.id===agentId))return {status:'already-added',state};if(state.added.length>=LIMIT)return {status:'capacity',state};state.added.push({id:agentId,at:now()});write(id,state);return {status:'added',state};});
  }
  function exclude(id, agentId, defaultEnabled=false) {
    validAgent(agentId);
    return withTx(db,()=>{const state=read(id,defaultEnabled);healthy(state);state.added=state.added.filter(x=>x.id!==agentId);if(!state.excluded.includes(agentId)){if(state.excluded.length>=LIMIT)return {status:'capacity',state};state.excluded.push(agentId);}write(id,state);return {status:'excluded',state};});
  }
  function allow(id, agentId, defaultEnabled=false) {
    validAgent(agentId);
    return withTx(db,()=>{const state=read(id,defaultEnabled);healthy(state);state.excluded=state.excluded.filter(x=>x!==agentId);if(!state.added.some(x=>x.id===agentId)){if(state.added.length>=LIMIT)return {status:'capacity',state};state.added.push({id:agentId,at:now()});}write(id,state);return {status:'allowed',state};});
  }
  function isNew(state, agentId, at=now()) { const found=state.added.find(x=>x.id===agentId); return !!found && at>=found.at && at-found.at<NEW_MS; }
  return { get:read, setEnabled, autoAdd, markAdded, exclude, allow, isNew, NEW_MS, LIMIT };
}
module.exports={createRuntimeAutoAddRepo,LIMIT,NEW_MS};
