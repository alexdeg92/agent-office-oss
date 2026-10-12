'use strict';
const crypto=require('node:crypto');
const {mintId}=require('../ids');
const {withTx}=require('../tx');
const {isHash}=require('../../security/password');
const {ROOTS,CHILDREN,LEVELS}=require('../../security/resources');
const fault=code=>Object.assign(new Error(code),{code});
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const EMAIL=/^[^@\s]{1,200}@[^@\s]{1,119}$/;
function createAccessManagement(db,{users,rbac,policy,registry,audit,now=Date.now,changed=()=>{}}) {
  const publicUser=row=>row ? {id:row.id,personId:row.person_id,email:row.email,roleId:row.role_id,status:row.status,credentialSource:row.credential_source,
    revision:row.permission_revision,lastSeenAt:row.last_seen_at,createdAt:row.created_at,
    ...(()=>{const p=db.prepare('SELECT name,avatar_url FROM persons WHERE id=?').get(row.person_id);return {name:p.name,avatarUrl:p.avatar_url};})()} : null;
  function authority(ctx) {
    // Closure supplied by the authenticated service, never a client-supplied confirmation flag.
    if(typeof ctx?.authorize!=='function') throw fault('unauthorized');
    const confirmed=ctx.authorize();
    if(confirmed?.then)throw fault('invalid-authority');
    const actor=users.byId(ctx.userId);
    if(!actor || actor.status!=='active' || actor.auth_generation!==ctx.authGeneration || !policy.can(actor,'users','write')) throw fault('permission-denied');
    return actor;
  }
  function record(ctx,actor,command,target,changes) {
    audit.append({at:now(),requestId:ctx.requestId,actor:{kind:'human',personId:actor.person_id},command,target,outcome:'ok',detail:null});
    const id=db.prepare('SELECT last_insert_rowid() AS id').get().id;
    // Changes contain only validated ids, resources, permission levels/status categories.
    db.prepare('INSERT INTO permission_audit_changes(audit_id,changes_json) VALUES (?,?)').run(id,JSON.stringify(changes));
  }
  function write(ctx,command,target,fn) {
    // This repository owns its commit boundary; never notify from a joined outer transaction.
    if(db.isTransaction)throw fault('management-in-transaction');
    let result,affected;
    withTx(db,()=>{
      const actor=authority(ctx),mutation=fn();
      result=mutation.result;affected=mutation.affected;
      record(ctx,actor,command,target ?? affected?.userId,mutation.changes);
    });
    changed(affected);return result;
  }
  function revision(expected,actual,code) {
    if(!Number.isSafeInteger(expected)||expected<1)throw fault('revision-required');
    if(expected!==actual)throw fault(code);
  }
  function account(id,expected) {
    const row=users.byId(id);if(!row || row.status==='deleted') throw fault('not-found');
    if(expected!==undefined)revision(expected,row.permission_revision,'user-revision');
    return row;
  }
  function role(id,expected) {
    const row=rbac.role(id);if(!row) throw fault('not-found');
    if(expected!==undefined)revision(expected,row.revision,'role-revision');
    if(row.id==='rol_admin') throw fault('admin-immutable');
    return row;
  }
  function mutableUser(id,expected) {const row=account(id);revision(expected,row.permission_revision,'user-revision');return row;}
  function mutableRole(id,expected) {const row=role(id);revision(expected,row.revision,'role-revision');return row;}
  function grants(input,override=false) {
    if(!Array.isArray(input) || input.length>registry.list().length) throw fault('invalid-permissions');
      const seen=new Set();
    return input.map(g=>{
      if(!g || typeof g!=='object' || Object.keys(g).some(k=>!['resource','mode','level'].includes(k)) || seen.has(g.resource)) throw fault('invalid-permissions');
      seen.add(g.resource);const d=registry.get(g.resource);if(!d || !db.prepare('SELECT 1 FROM permission_resources WHERE key=? AND active=1').get(d.key))throw fault('invalid-resource');
      const mode=g.mode || 'explicit';
      if(mode==='inherit-parent' && !override && d.parent && g.level==null) return {resource:g.resource,mode,level:null};
      if(mode!=='explicit' || !LEVELS.includes(g.level))throw fault('invalid-permissions');
      return {resource:g.resource,mode,level:g.level};
    });
  }
  function normalizeEmail(email) {const s=typeof email==='string'?email.trim().toLowerCase():'';if(s.length>320||!EMAIL.test(s))throw fault('invalid-email');return s;}
  function name(value) {if(typeof value!=='string'||!value.trim()||value.length>80||/[\x00-\x1f]/.test(value))throw fault('invalid-name');return value.trim();}
  const roleGrants=id=>db.prepare('SELECT resource,mode,level FROM role_permissions WHERE role_id=? ORDER BY resource').all(id).map(r=>({...r}));
  function replaceRoleGrants(id,next,bump=true) {
    db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(id);
    for(const g of next)db.prepare('INSERT INTO role_permissions(role_id,resource,mode,level) VALUES (?,?,?,?)').run(id,g.resource,g.mode,g.level);
    if(bump)db.prepare('UPDATE roles SET revision=revision+1,updated_at=? WHERE id=?').run(now(),id);
    db.prepare('UPDATE invitations SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE role_id=?)').run(now(),id);
  }
  function revokeInvites(id) {db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(now(),id);}
  function issue(row,purpose,ctx) {
    revokeInvites(row.id);
    const token=(purpose==='invite'?'ao_inv_':'ao_rst_')+crypto.randomBytes(32).toString('base64url'),at=now(),expiresAt=at+(purpose==='invite'?48*3600000:3600000);
    db.prepare('INSERT INTO invitations(id,user_id,purpose,token_hash,created_by,created_at,expires_at,target_generation,target_revision) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(mintId('inv'),row.id,purpose,digest(token),ctx.userId,at,expiresAt,row.auth_generation,row.permission_revision);
    return {token,expiresAt,user:publicUser(row)};
  }
  function mutateRole(id,{expectedRevision,name:label,permissions},ctx,command,{merge=false}={}) {
    const patch=permissions===undefined&&merge?[]:grants(permissions),title=label===undefined?null:name(label);
    return write(ctx,command,id,()=>{mutableRole(id,expectedRevision);const before=roleGrants(id);
      const next=merge ? [...new Map([...before,...patch].map(g=>[g.resource,g])).values()] : patch;
      replaceRoleGrants(id,next);if(title)db.prepare('UPDATE roles SET name=? WHERE id=?').run(title,id);
      return {result:{...rbac.role(id),permissions:next},changes:{roleId:id,before,after:next},affected:{roleId:id}};});
  }
  return {
    list({offset=0,limit=50}={}) {if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw fault('invalid-page');return db.prepare("SELECT * FROM users WHERE status<>'deleted' ORDER BY created_at,id LIMIT ? OFFSET ?").all(limit,offset).map(publicUser);},
    user:id=>{const row=account(id);return {...publicUser(row),overrides:Object.entries(rbac.snapshot(id).overrides).map(([resource,level])=>({resource,level})),effective:policy.permissions(row)};},
    roles:()=>rbac.roles().map(r=>({...r,permissions:r.id==='rol_admin'?registry.list().map(d=>({resource:d.key,mode:'explicit',level:'write'})):roleGrants(r.id)})),
    createRole({name:label,permissions=[]},ctx) {
      const next=grants(permissions),title=name(label),id=mintId('rol');
      return write(ctx,'roles.create',id,()=>{const at=now();db.prepare('INSERT INTO roles(id,slug,name,builtin,created_at,updated_at) VALUES (?,?,?,0,?,?)').run(id,id,title,at,at);replaceRoleGrants(id,next,false);
        return {result:{...rbac.role(id),permissions:next},changes:{roleId:id,before:[],after:next},affected:{roleId:id}};});
    },
    editRole(id,{expectedRevision,name:label,permissions},ctx) {
      return mutateRole(id,{expectedRevision,name:label,permissions},ctx,'roles.edit',{merge:true});
    },
    resetRole(id,{expectedRevision},ctx) {
      const defaults=ROOTS.map(resource=>({resource,mode:'explicit',level:
        id==='rol_editor' ? ['chat','flows','projects','skills','store'].includes(resource)?'write':['office','access','logs','health'].includes(resource)?'read':'none'
        : ['office','chat','flows','projects','skills','health','store'].includes(resource)?'read':'none'}));
      defaults.push(...CHILDREN.map(resource=>({resource,mode:'inherit-parent',level:null})));
      if(!['rol_editor','rol_reader'].includes(id))throw fault('builtin-reset-only');
      return mutateRole(id,{expectedRevision,permissions:defaults},ctx,'roles.reset');
    },
    deleteRole(id,{expectedRevision},ctx) {return write(ctx,'roles.delete',id,()=>{const row=mutableRole(id,expectedRevision);if(row.builtin)throw fault('builtin-role');if(db.prepare('SELECT 1 FROM users WHERE role_id=? LIMIT 1').get(id))throw fault('role-in-use');const before=roleGrants(id);db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(id);db.prepare('DELETE FROM roles WHERE id=?').run(id);return {result:{deleted:true},changes:{roleId:id,before,after:[]},affected:{roleId:id}};});},
    invite({name:label,email,roleId},ctx) {
      const address=normalizeEmail(email),title=name(label);
      return write(ctx,'users.invite',null,()=>{if(!rbac.role(roleId))throw fault('invalid-role');
        if(db.prepare("SELECT 1 FROM users WHERE email=? COLLATE NOCASE AND status<>'deleted' LIMIT 1").get(address))throw fault('email-in-use');
        const at=now(),id=mintId('usr'),personId=mintId('per');
        db.prepare("INSERT INTO persons(id,kind,name,is_owner,created_at,updated_at) VALUES (?,'human',?,0,?,?)").run(personId,title,at,at);
        db.prepare("INSERT INTO users(id,person_id,email,role_id,status,credential_source,created_at,updated_at) VALUES (?,?,?,?,'invited','database',?,?)").run(id,personId,address,roleId,at,at);
        return {result:issue(users.byId(id),'invite',ctx),changes:{userId:id,before:null,after:{roleId,status:'invited'}},affected:{userId:id}};});
    },
    resendInvitation(id,{expectedRevision},ctx) {return write(ctx,'users.resendInvitation',id,()=>{const row=mutableUser(id,expectedRevision);if(row.status!=='invited'||row.credential_source!=='database')throw fault('invitation-required');return {result:issue(row,'invite',ctx),changes:{userId:id,before:null,after:{status:'invitation-issued'}},affected:{userId:id}};});},
    editUser(id,{expectedRevision,roleId,status,name:label},ctx) {
      if(status!==undefined&&!['active','disabled'].includes(status))throw fault('invalid-status');const title=label===undefined?null:name(label);
      return write(ctx,'users.edit',id,()=>{const before=mutableUser(id,expectedRevision);if(before.credential_source==='env'&&(roleId!==undefined&&roleId!==before.role_id||status!==undefined&&status!==before.status))throw fault('external-account');
        if(roleId!==undefined&&!rbac.role(roleId))throw fault('invalid-role');
        if(status==='active'&&before.status==='invited')throw fault('invitation-required');
        const nextRole=roleId??before.role_id,nextStatus=status??before.status;
        const oldOverrides=rbac.snapshot(id).overrides;
        if(nextRole==='rol_admin')db.prepare('DELETE FROM user_overrides WHERE user_id=?').run(id);
        db.prepare('UPDATE users SET role_id=?,status=?,permission_revision=permission_revision+1,auth_generation=auth_generation+?,updated_at=? WHERE id=?')
          .run(nextRole,nextStatus,nextStatus!==before.status?1:0,now(),id);
        if(title)db.prepare('UPDATE persons SET name=?,updated_at=? WHERE id=?').run(title,now(),before.person_id);
        revokeInvites(id);return {result:publicUser(users.byId(id)),changes:{userId:id,before:{roleId:before.role_id,status:before.status,overrides:oldOverrides},after:{roleId:nextRole,status:nextStatus,overrides:rbac.snapshot(id).overrides}},affected:{userId:id}};});
    },
    overrides(id,{expectedRevision,permissions},ctx) {const next=grants(permissions,true);return write(ctx,'users.overrides',id,()=>{const row=mutableUser(id,expectedRevision);if(row.role_id==='rol_admin')throw fault('admin-immutable');const before=rbac.snapshot(id).overrides;
      db.prepare('DELETE FROM user_overrides WHERE user_id=?').run(id);for(const g of next)db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?)').run(id,g.resource,g.level);
      db.prepare('UPDATE users SET permission_revision=permission_revision+1,updated_at=? WHERE id=?').run(now(),id);revokeInvites(id);
      return {result:this.user(id),changes:{userId:id,before:Object.entries(before).map(([resource,level])=>({resource,level})),after:next.map(({resource,level})=>({resource,level}))},affected:{userId:id}};});},
    resetPassword(id,{expectedRevision},ctx) {return write(ctx,'users.passwordReset',id,()=>{const row=mutableUser(id,expectedRevision);if(row.credential_source!=='database'||row.status!=='active')throw fault('external-account');
      db.prepare('UPDATE users SET auth_generation=auth_generation+1,updated_at=? WHERE id=?').run(now(),id);
      return {result:issue(users.byId(id),'password-reset',ctx),changes:{userId:id,before:null,after:{status:'reset-issued'}},affected:{userId:id}};});},
    revoke(id,{expectedRevision},ctx) {return write(ctx,'users.revokeSessions',id,()=>{mutableUser(id,expectedRevision);db.prepare('UPDATE users SET auth_generation=auth_generation+1,updated_at=? WHERE id=?').run(now(),id);revokeInvites(id);return {result:{revoked:true},changes:{userId:id,before:null,after:{status:'sessions-revoked'}},affected:{userId:id}};});},
    deleteUser(id,{expectedRevision},ctx) {return write(ctx,'users.delete',id,()=>{const row=mutableUser(id,expectedRevision);if(row.credential_source==='env')throw fault('external-account');
      db.prepare("UPDATE users SET status='deleted',password_hash=NULL,deleted_at=?,auth_generation=auth_generation+1,permission_revision=permission_revision+1,updated_at=? WHERE id=?").run(now(),now(),id);revokeInvites(id);
      return {result:{deleted:true},changes:{userId:id,before:{status:row.status,roleId:row.role_id},after:{status:'deleted'}},affected:{userId:id}};});},
    accept({token,purpose,passwordHash},ctx) {
      if(db.isTransaction)throw fault('management-in-transaction');
      if(typeof token!=='string'||!new RegExp('^'+(purpose==='invite'?'ao_inv_':'ao_rst_')+'[A-Za-z0-9_-]{43}$').test(token)||!['invite','password-reset'].includes(purpose)||!isHash(passwordHash))throw fault('invalid-link');
      let id;
      withTx(db,()=>{const invite=db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(digest(token));
        if(!invite||invite.purpose!==purpose||invite.consumed_at!==null||invite.revoked_at!==null||invite.expires_at<=now())throw fault('invalid-link');
        const row=users.byId(invite.user_id);if(!row||row.status!==(purpose==='invite'?'invited':'active')||row.credential_source!=='database'||row.auth_generation!==invite.target_generation||row.permission_revision!==invite.target_revision)throw fault('invalid-link');
        db.prepare('UPDATE invitations SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now(),invite.id);
        db.prepare("UPDATE users SET password_hash=?,status='active',auth_generation=auth_generation+1,updated_at=? WHERE id=?").run(passwordHash,now(),row.id);id=row.id;
        record(ctx,row,purpose==='invite'?'users.acceptInvitation':'users.acceptReset',id,{userId:id,before:{status:row.status},after:{status:'active'}});
      });changed({userId:id});return {accepted:true};
    },
  };
}
module.exports={createAccessManagement};
