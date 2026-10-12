'use strict';
const {withTx}=require('../tx');
const {isHash}=require('../../security/password');
const fault=code=>Object.assign(new Error(code),{code});
function createSelfAccount(db,{users,audit,now=Date.now,changed=()=>{}}) {
  function mutate({expectedRevision,displayName,email,passwordHash},ctx,password=false) {
    if(db.isTransaction)throw fault('management-in-transaction');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fault('revision-required');
    if(displayName!==undefined&&(typeof displayName!=='string'||!displayName.trim()||displayName.length>80||/[\x00-\x1f\x7f]/.test(displayName)))throw fault('invalid-name');
    if(email!==undefined&&(typeof email!=='string'||email.length>254||!/^[^@\s]+@[^@\s]+$/.test(email.trim())))throw fault('invalid-email');
    if(password&&!isHash(passwordHash))throw fault('invalid-password');
    let result,rotated;
    withTx(db,()=>{
      if(typeof ctx?.authorize!=='function'||ctx.authorize()?.then)throw fault('unauthorized');
      const user=users.byId(ctx.userId);
      if(!user||user.status!=='active'||user.auth_generation!==ctx.authGeneration)throw fault('unauthorized');
      if(user.credential_source!=='database')throw fault('external-account');
      if(user.permission_revision!==expectedRevision)throw fault('user-revision');
      const person=db.prepare('SELECT name FROM persons WHERE id=?').get(user.person_id),address=email===undefined?user.email:email.trim().toLowerCase();
      const title=displayName===undefined?person.name:displayName.trim();
      const fields=[...(title!==person.name?['profile.name']:[]),...(address!==user.email?['profile.email']:[]),...(password?['profile.password']:[])];
      if(!fields.length)throw fault('empty-change');
      rotated=password||address!==user.email;
      db.prepare('UPDATE persons SET name=?,updated_at=? WHERE id=?').run(title,now(),user.person_id);
      db.prepare('UPDATE users SET email=?,password_hash=?,auth_generation=auth_generation+?,permission_revision=permission_revision+1,updated_at=? WHERE id=?')
        .run(address,password?passwordHash:user.password_hash,rotated?1:0,now(),user.id);
      db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(now(),user.id);
      audit.append({at:now(),requestId:ctx.requestId,actor:{kind:'human',personId:user.person_id},command:password?'settings.password':'settings.owner',target:user.id,outcome:'ok',detail:password?'password-changed':'profile-changed'});
      result={id:user.id,personId:user.person_id,name:title,email:address,revision:expectedRevision+1};
    });
    changed({userId:ctx.userId});return {user:result,rotated};
  }
  return {profile:(input,ctx)=>mutate(input,ctx),password:(input,ctx)=>mutate(input,ctx,true)};
}
module.exports={createSelfAccount};
