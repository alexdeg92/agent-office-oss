'use strict';
const crypto=require('node:crypto');
// Boot-only binding. Store a keyed change detector, never the environment credential itself.
function prepareAuthIdentity({cfg,store}) {
  store.users.prepareLegacy(cfg.sessionTtlMs);
  if(!cfg.authDatabase) {
    const email=cfg.loginEmail.trim().toLowerCase();
    const fingerprint=crypto.createHmac('sha256',cfg.sessionSecret)
      .update(JSON.stringify(['agent-office/env-credential/v1',email,cfg.passwordHash?'hash':'password',cfg.passwordHash||cfg.loginPassword]))
      .digest('hex');
    store.users.ensureEnv({email,personId:store.owner.id,fingerprint});
  } else if(!store.users.owner())throw new Error('database identity unavailable');
  return {users:store.users,state:store.rbac.state};
}
module.exports={prepareAuthIdentity};
