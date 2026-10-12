'use strict';
// Derived project output can contain any linked transcript, flow or runtime context.
const PROJECT_CONTEXT_READS=Object.freeze(['logs','flows','settings.runtimes'].map(resource=>Object.freeze({resource,level:'read'})));
function valid(value) {
  return Array.isArray(value)&&value.length>0&&value.length<=16&&value.every(r=>r&&Object.keys(r).length===2&&typeof r.resource==='string'&&/^[a-z][a-z0-9_.-]{0,159}$/.test(r.resource)&&r.level==='read');
}
function encode(value) {
  if(value==null)return null;
  if(!valid(value))throw new TypeError('invalid comment provenance');
  return JSON.stringify(value);
}
function decode(raw,{agent=false}={}) {
  if(raw==null)return agent?PROJECT_CONTEXT_READS:null;
  try {const value=JSON.parse(raw);return valid(value)?value:false;}catch {return false;}
}
function mayRead(store,user,id) {
  const required=store.comments.provenance(id);
  return required===null||Array.isArray(required)&&required.every(r=>store.policy.can(user,r.resource,r.level));
}
module.exports={PROJECT_CONTEXT_READS,encode,decode,mayRead};
