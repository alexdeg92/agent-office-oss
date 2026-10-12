'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const authority=new AsyncLocalStorage();
// Trusted service callbacks follow nested controller queues without becoming adapter or wire arguments.
function runAuthorized(authorize,fn) {
  if(!authorize)return fn();
  return authority.run(authorize,()=>{authorize();return fn();});
}
function checkDispatchAuthority() { authority.getStore()?.(); }
module.exports={runAuthorized,checkDispatchAuthority};
