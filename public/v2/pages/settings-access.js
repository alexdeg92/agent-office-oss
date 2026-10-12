import { html, useEffect, useState } from '../lib.js';
import { registerMessages } from '../messages.js';
import * as dictionary from '../messages/access-management.js';
import { buildQuery } from '../config.js';
import { intlLocale, msg } from '../i18n.js';
import { request } from '../api.js';
import { reauthenticate } from '../settings-api.js';
import { services } from '../services.js';
import { Button, Field, ListRow, Select, SettingRow, TextInput } from '../components/bureau/index.js';
import { Modal } from '../components/modal.js';
import { canManageUsers } from './settings-rules.js';
registerMessages(dictionary);
let styles;
export function loadStyles(){
  if(!globalThis.document)return Promise.resolve();
  return styles ||= new Promise((resolve,reject)=>{
    const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('./settings-access.css'+buildQuery,import.meta.url).href;
    sheet.onload=resolve;sheet.onerror=()=>{sheet.remove();styles=null;reject(Error('Settings access stylesheet unavailable'));};
    document.head.append(sheet);
  }).catch(error=>{styles=null;throw error;});
}
const API={quiet:true,apiVersion:3};
const get=(path)=>request('GET','/api/v3/'+path,undefined,API).then(r=>r.data);
const write=(method,path,body)=>request(method,'/api/v3/'+path,body,API).then(r=>r.data);
const errKey=error=>error?.details?.some(d=>d.issue==='email-in-use')?'access.result.emailInUse':error?.code==='conflict'?'access.result.conflict':error?.details?.some(d=>d.issue==='last-active-admin')?'access.result.lastAdmin':error?.details?.some(d=>d.issue==='reauth-required')?'access.result.reauth':error?.details?.some(d=>d.issue==='external-account')?'access.result.external':'access.result.generic';
const roleNames=roles=>Object.fromEntries((roles||[]).map(r=>[r.id,r.name]));
const levels=['none','read','write'];
const levelLabel=level=>msg('access.permissions.'+level);
const permissionLabel=item=>{const label=msg(item.labelKey);return label===msg('common.translationMissing')||label===item.labelKey?item.key:label;};
function roleLevels(role,resources){
  const grants=Object.fromEntries((role?.permissions||[]).map(g=>[g.resource,g]));
  const resolve=(key,seen=new Set())=>{if(seen.has(key))return 'none';seen.add(key);const grant=grants[key];if(grant?.mode!=='inherit-parent')return grant?.level||'none';const parent=resources.find(r=>r.key===key)?.parent;return parent?resolve(parent,seen):'none';};
  return Object.fromEntries(resources.map(r=>[r.key,resolve(r.key)]));
}
function rolePermissionsAfterEdit(role,resources,resource,level){
  const grants=new Map((role?.permissions||[]).map(g=>[g.resource,g]));
  const changed=[];
  if(level==='__allRead'){
    for(const item of resources){
      const area=item.parent||item.key.split('.').slice(0,-1).join('.')||item.namespace||'core';
      if(area!==resource)continue;
      const next=item.parent?{resource:item.key,mode:'inherit-parent',level:null}:{resource:item.key,mode:'explicit',level:'read'};
      const before=grants.get(item.key);
      if(before?.mode!==next.mode||before?.level!==next.level)changed.push(next);
    }
    return changed;
  }
  const before=grants.get(resource),next={resource,mode:'explicit',level};
  if(before?.mode!==next.mode||before?.level!==next.level)changed.push(next);
  return changed;
}
function confirmationFields(pending,roles,resources) {
  const changes=pending.changes||{},roleName=id=>roles.find(role=>role.id===id)?.name||msg('access.roles.unknown');
  const fields=[];
  if(typeof changes.name==='string')fields.push([msg('access.confirm.name'),changes.name]);
  if(typeof changes.email==='string')fields.push([msg('access.confirm.email'),changes.email]);
  if(typeof changes.roleId==='string')fields.push([msg('access.confirm.role'),roleName(changes.roleId)]);
  if(typeof changes.status==='string')fields.push([msg('access.users.state'),msg('access.users.'+changes.status)]);
  if(Array.isArray(changes.permissions)){
    if(changes.permissions.length){
      for(const grant of changes.permissions){
        const descriptor=resources.find(item=>item.key===grant.resource);
        const resource=descriptor?permissionLabel(descriptor):grant.resource;
        const requested=grant.mode==='inherit-parent'?msg('access.confirm.inheritParent'):
          levels.includes(grant.level)?levelLabel(grant.level):msg('access.confirm.unknownLevel');
        fields.push([resource,requested]);
      }
    }else fields.push([msg('access.confirm.permissions'),msg(pending.action==='users.overrides'?'access.confirm.resetOverrides':'access.confirm.noPermissionChanges')]);
  }
  if(pending.action==='users.delete')fields.push([msg('access.users.state'),msg('access.confirm.accountRemoved')]);
  return fields;
}
const displayTime=value=>value?new Intl.DateTimeFormat(intlLocale(),{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):msg('access.users.neverSeen');
const tokenLink=(purpose,token)=>{const url=new URL(services.router.href('invitation'),location.href);url.hash=new URLSearchParams({purpose,token}).toString();return url.href;};

function AccessConfirm({pending,roles,resources,busy,error,onClose,onSubmit}) {
  const [password,setPassword]=useState('');
  const [name,setName]=useState(pending.changes.name||pending.name);
  const fields=confirmationFields(pending,roles||[],resources||[]);
  return html`<${Modal} title=${msg('access.confirm.title')} desc=${msg('access.confirm.text')} onClose=${()=>!busy&&onClose()}
    footer=${html`<${Button} label=${msg('common.cancel')} variant="secondary" disabled=${busy} onClick=${onClose}/><${Button} label=${msg('access.confirm.apply')} variant="primary" busy=${busy} disabled=${busy||!password||(pending.action==='roles.create'&&!name.trim())} onClick=${()=>onSubmit(password,pending.action==='roles.create'?{name:name.trim()}:undefined)}/>`}>
    <dl class="ao-access__review"><dt>${msg('access.confirm.target')}</dt><dd>${pending.action==='roles.create'?name:pending.name}</dd><dt>${msg('access.confirm.change')}</dt><dd>${fields.length?html`<dl class="ao-access__review-fields">${fields.map(([label,value])=>html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`:msg('access.confirm.noDetails')}</dd></dl>
    ${pending.action==='roles.create'?html`<${Field} id="access-role-create-name" label=${msg('access.roles.name')} required control=${p=>html`<${TextInput} ...${p} maxLength=${80} value=${name} onValueChange=${setName}/>`}/>`:null}
    <${Field} id="access-confirm-password" label=${msg('access.confirm.password')} required control=${props=>html`<${TextInput} ...${props} type="password" autoComplete="current-password" maxLength=${1024} value=${password} onValueChange=${setPassword} disabled=${busy}/>`}/>
    ${error?html`<p class="bu-field__error" role="alert">${msg(error)}</p>`:null}
  </${Modal}>`;
}

function InviteDialog({roles,busy,error,onClose,onContinue}) {
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[roleId,setRole]=useState(roles.find(r=>r.id==='rol_reader')?.id||roles.find(r=>r.id!=='rol_admin')?.id||'');
  const options=roles.filter(r=>r.id!=='rol_admin').map(r=>({value:r.id,label:r.name}));
  return html`<${Modal} title=${msg('access.invite.title')} onClose=${()=>!busy&&onClose()} footer=${html`<${Button} label=${msg('common.cancel')} variant="secondary" disabled=${busy} onClick=${onClose}/><${Button} label=${msg('access.invite.send')} variant="primary" disabled=${busy||!name.trim()||!email.trim()||!roleId} onClick=${()=>onContinue({name:name.trim(),email:email.trim(),roleId})}/>`}>
    <div class="ao-access__form"><${Field} id="access-invite-name" label=${msg('access.invite.name')} required control=${p=>html`<${TextInput} ...${p} autoComplete="name" maxLength=${80} value=${name} onValueChange=${setName}/>`}/>
    <${Field} id="access-invite-email" label=${msg('access.invite.email')} required control=${p=>html`<${TextInput} ...${p} type="email" autoComplete="email" maxLength=${254} value=${email} onValueChange=${setEmail}/>`}/>
    <${Field} id="access-invite-role" label=${msg('access.invite.role')} required control=${p=>html`<${Select} ...${p} value=${roleId} options=${options} onValueChange=${setRole}/>`}/></div>
    ${error?html`<p class="bu-field__error" role="alert">${msg(error)}</p>`:null}</${Modal}>`;
}

function Matrix({resources,permissions,onChange,readOnly=false,overrides=null}) {
  if(!resources.length)return html`<p class="bu-caption">${msg('access.permissions.registryEmpty')}</p>`;
  const areas=new Map();
  for(const item of resources){const key=item.parent||(item.key.includes('.')?item.key.split('.')[0]:item.key);if(!areas.has(key))areas.set(key,[]);areas.get(key).push(item);}
  const areaLabel=(area,items)=>{
    const descriptor=resources.find(item=>item.key===area);
    if(descriptor)return permissionLabel(descriptor);
    const localized=msg('permissions.'+area);
    if(localized!==msg('common.translationMissing')&&localized!=='permissions.'+area)return localized;
    const namespaceLabel=msg('permissions.group.'+area);
    return namespaceLabel!==msg('common.translationMissing')&&namespaceLabel!=='permissions.group.'+area?namespaceLabel:permissionLabel(items[0]);
  };
  return html`<div class="ao-access__matrix" role="group" aria-label=${msg('access.roles.heading')}>
    ${[...areas.entries()].map(([area,items])=>html`<section class="ao-access__area" key=${area} aria-labelledby=${'access-area-'+area.replace(/[^a-z0-9_-]/gi,'-')}>
      <h3 class="bu-heading-sm" id=${'access-area-'+area.replace(/[^a-z0-9_-]/gi,'-')}>${areaLabel(area,items)}</h3>
      ${items.map(item=>{const current=permissions[item.key]||'none',override=overrides?.[item.key];return html`<${SettingRow} key=${item.key} label=${permissionLabel(item)}
        description=${item.available===false?msg('access.permissions.unavailable'):item.privileged?msg('access.permissions.privileged'):overrides?msg(override?'access.users.overridden':'access.users.inherited'):null}
        control=${html`<div class="ao-access__levels" role="group" aria-label=${item.key}>
          ${levels.map(level=>html`<${Button} key=${level} size="sm" variant=${current===level?'primary':'secondary'} disabled=${readOnly||item.available===false} pressed=${current===level} label=${levelLabel(level)} onClick=${()=>onChange(item.key,level)}/>`)}
        </div>`}/>`;})}
      ${overrides||readOnly?null:html`<${Button} size="sm" variant="ghost" label=${msg('access.permissions.allRead')} onClick=${()=>onChange(area,'__allRead')}/>`}
    </section>`)}
  </div>`;
}

export function SettingsAccess({tab,me}) {
  const [users,setUsers]=useState([]),[usersNext,setUsersNext]=useState(null),[roles,setRoles]=useState([]),[resources,setResources]=useState([]),[selected,setSelected]=useState(null),[detail,setDetail]=useState(null),[roleId,setRoleId]=useState(null),[roleDraft,setRoleDraft]=useState(null);
  const [error,setError]=useState(null),[notice,setNotice]=useState(null),[busy,setBusy]=useState(false),[dialog,setDialog]=useState(null),[invite,setInvite]=useState(false),[link,setLink]=useState(null),[copied,setCopied]=useState(false);
  const [page,setPage]=useState('list');
  const canManage=canManageUsers(me);
  async function refresh() {
    if(!canManage){setUsers([]);setRoles([]);setResources([]);setDetail(null);setRoleDraft(null);return;}
    setBusy(true);setError(null);
    try {const [u,r,p]=await Promise.all([get('users?offset=0&limit=100'),get('roles?offset=0&limit=100'),get('permissions/resources')]);setUsers(u.items||[]);setUsersNext(u.nextOffset);setRoles(r.items||[]);setResources(p.items||[]);
      if(selected){const fresh=await get('users/'+encodeURIComponent(selected));setDetail(fresh);}
      if(roleId){const fresh=(r.items||[]).find(x=>x.id===roleId);setRoleDraft(fresh||null);}
    } catch(e){setError(errKey(e));} finally{setBusy(false);}
  }
  useEffect(()=>{let live=true;if(!canManage){setUsers([]);setUsersNext(null);setRoles([]);setResources([]);setDetail(null);setRoleDraft(null);return()=>{live=false;};} (async()=>{try{const [u,r,p]=await Promise.all([get('users?offset=0&limit=100'),get('roles?offset=0&limit=100'),get('permissions/resources')]);if(!live)return;setUsers(u.items||[]);setUsersNext(u.nextOffset);setRoles(r.items||[]);setResources(p.items||[]);}catch(e){if(live)setError(errKey(e));}})();return()=>{live=false;setSelected(null);setDetail(null);setRoleDraft(null);setLink(null);};},[tab,canManage,me?.user?.id,me?.permissionRevision?.user,me?.permissionRevision?.permissions]);
  async function loadMoreUsers(){if(usersNext==null||busy)return;setBusy(true);try{const next=await get('users?offset='+usersNext+'&limit=100');setUsers(items=>[...items,...(next.items||[])]);setUsersNext(next.nextOffset);}catch(e){setError(errKey(e));}finally{setBusy(false);}}
  async function selectUser(id) {setSelected(id);setPage('detail');setDetail(null);setError(null);try{setDetail(await get('users/'+encodeURIComponent(id)));}catch(e){setError(errKey(e));}}
  async function selectRole(id) {setRoleId(id);setPage('role');setError(null);setRoleDraft(roles.find(r=>r.id===id)||null);}
  function begin(action,target,name,revision,changes,method,path) {setError(null);setDialog({action,target,name,revision,changes,method,path});}
  async function apply(password,editedChanges) {
    if(!dialog||busy)return;setBusy(true);setError(null);
    try {await reauthenticate(password);const d=dialog,changes={...d.changes,...editedChanges};const target=d.action==='roles.create'?'new-role':d.target,name=d.action==='roles.create'?changes.name:d.name;const body={...changes,expectedRevision:d.revision,confirmation:{action:d.action,target,name,revision:d.revision,changes}};
      const result=await write(d.method,d.path,body);setDialog(null);setNotice('access.result.saved');
      if(result?.result?.token){setLink(tokenLink('invitation',result.result.token));setInvite(false);}
      if(d.action==='users.delete'){setSelected(null);setDetail(null);setPage('list');}
      const freshMe=await request('GET','/api/v2/me',undefined,{quiet:true,apiVersion:2}).then(r=>r.data).catch(()=>null);
      const previous=services.me,changed=previous&&freshMe&&(previous.user?.id!==freshMe.user?.id||JSON.stringify(previous.permissionRevision)!==JSON.stringify(freshMe.permissionRevision));
      if(changed)services.stream?.invalidateAuth();services.me=freshMe;window.dispatchEvent(new CustomEvent('agent-office:me',{detail:freshMe}));if(changed)services.stream?.start();
      await refresh();
    }catch(e){setError(errKey(e));}finally{setBusy(false);}
  }
  if(!canManage)return html`<p role="alert">${msg('access.result.notAdmin')}</p>`;
  const names=roleNames(roles);
  if(tab==='users') {
    const user=detail;
    const roleOptions=roles.map(r=>({value:r.id,label:r.name}));
    const isExternal=user&&user.credentialSource!=='database';
    const activeAdmins=users.filter(u=>u.roleId==='rol_admin'&&u.status==='active').length;
    const adminLast=user?.roleId==='rol_admin'&&activeAdmins<=1&&(usersNext!=null||activeAdmins===1);
    const overrideMap=Object.fromEntries((user?.overrides||[]).map(x=>[x.resource,x.level]));
    const updateOverride=(resource,level)=>{const map={...overrideMap};if(resource==='*')return;map[resource]=level;const permissions=Object.entries(map).map(([key,value])=>({resource:key,level:value}));begin('users.overrides',user.id,user.name,user.revision,{permissions},'PUT','users/'+encodeURIComponent(user.id)+'/overrides');};
    return html`<section class="ao-access" aria-labelledby="access-users-heading">
      <div class="ao-access__heading"><h1 class="bu-heading-lg" id="access-users-heading">${msg('settings.tab.users')}</h1><span class="bu-caption">${msg(users.length===1?'access.users.countOne':'access.users.countOther',{n:users.length})}</span><${Button} label=${msg('access.users.invite')} variant="primary" disabled=${busy} onClick=${()=>{setError(null);setInvite(true);}}/></div>
      ${error&&!dialog?html`<p class="bu-banner bu-banner--danger" role="alert">${msg(error)}</p>`:null}${notice?html`<p class="bu-banner" role="status">${msg(notice)}</p>`:null}
      <div class=${'ao-access__users'+(page==='detail'?' ao-access__users--detail':'')}>
       <div class="ao-access__list"><h2 class="bu-heading-sm">${msg('settings.tab.users')}</h2><ul class="bu-list">${users.length?users.map(u=>html`<${ListRow} key=${u.id} selected=${selected===u.id} title=${u.name||u.email} meta=${u.email+' · '+(names[u.roleId]||u.roleId)+' · '+displayTime(u.lastSeenAt)} severity=${u.status==='active'?'ok':u.status==='invited'?'info':'warn'} statusLabel=${msg('access.users.'+(u.status==='active'?'active':u.status==='invited'?'invited':'disabled'))} actions=${html`<${Button} size="sm" label=${msg('access.open')} onClick=${()=>selectUser(u.id)}/>`}/>`):html`<li class="bu-caption">${msg('access.users.empty')}</li>`}</ul>${usersNext!=null?html`<${Button} size="sm" variant="secondary" busy=${busy} label=${msg('access.users.more')} onClick=${loadMoreUsers}/>`:null}</div>
       ${user?html`<section class="ao-access__detail" aria-labelledby="access-user-name"><div class="ao-access__detail-head"><${Button} class="ao-access__back" variant="ghost" size="sm" label=${msg('access.back')} onClick=${()=>setPage('list')}/><h2 class="bu-heading-lg" id="access-user-name">${user.name}</h2><span class="bu-caption">${user.email}</span></div>
        ${isExternal?html`<p class="bu-banner" role="note">${msg('access.users.externalProtected')}</p>`:null}
        ${adminLast?html`<p class="bu-caption">${msg('access.users.adminProtected')}</p>`:null}<${SettingRow} label=${msg('access.users.role')} control=${p=>html`<${Select} ...${p} value=${user.roleId} options=${roleOptions} disabled=${busy||isExternal||adminLast} onValueChange=${next=>begin('users.edit',user.id,user.name,user.revision,{roleId:next},'PATCH','users/'+encodeURIComponent(user.id))}/>`}/>
        <${SettingRow} label=${msg('access.users.state')} control=${html`<div class="ao-access__actions"><${Button} size="sm" variant="secondary" label=${msg(user.status==='active'?'access.users.disable':'access.users.enable')} disabled=${busy||isExternal||adminLast} onClick=${()=>begin('users.edit',user.id,user.name,user.revision,{status:user.status==='active'?'disabled':'active'},'PATCH','users/'+encodeURIComponent(user.id))}/>
        ${user.status==='invited'?html`<${Button} size="sm" label=${msg('access.users.resend')} disabled=${busy} onClick=${()=>begin('users.resendInvitation',user.id,user.name,user.revision,{},'POST','users/'+encodeURIComponent(user.id)+'/invitation')}/>`:null}
        <${Button} size="sm" variant="danger" label=${msg(user.status==='invited'?'access.users.revokeInvitation':'access.users.remove')} disabled=${busy||isExternal||adminLast} onClick=${()=>begin('users.delete',user.id,user.name,user.revision,{},'DELETE','users/'+encodeURIComponent(user.id))}/></div>`}/>
        <${SettingRow} label=${msg('access.users.lastSeen')} meta=${displayTime(user.lastSeenAt)}/>
        <h3 class="bu-heading-sm">${msg('access.users.overrides')}</h3><p class="bu-caption">${msg('access.users.inherited')} · ${names[user.roleId]||user.roleId}</p>
        <${Matrix} resources=${resources} permissions=${user.effective||{}} overrides=${overrideMap} onChange=${(resource,level)=>updateOverride(resource,level)}/>
        <${Button} size="sm" variant="ghost" label=${msg('access.users.reset')} disabled=${busy||!user.overrides?.length} onClick=${()=>begin('users.overrides',user.id,user.name,user.revision,{permissions:[]},'PUT','users/'+encodeURIComponent(user.id)+'/overrides')}/>
       </section>`:html`<div class="ao-access__empty"><p class="bu-caption">${page==='detail'&&selected&&!error?msg('access.users.loadingDetail'):users.length?msg('access.users.selectPerson'):msg('access.users.empty')}</p></div>`}
      </div>
      ${invite?html`<${InviteDialog} roles=${roles} busy=${busy} error=${error} onClose=${()=>setInvite(false)} onContinue=${data=>{setInvite(false);const normalized={...data,email:data.email.trim().toLowerCase()};begin('users.invite',normalized.email,normalized.name,0,normalized,'POST','users/invitations');}}/>`:null}
      ${link?html`<${Modal} title=${msg('access.invite.linkTitle')} desc=${msg('access.invite.linkText')} onClose=${()=>{setLink(null);setCopied(false);}} footer=${html`<${Button} label=${msg('common.close')} onClick=${()=>{setLink(null);setCopied(false);}}/>`}><p class="ao-access__link" dir="ltr">${link}</p><${Button} label=${msg(copied?'access.invite.copied':'access.invite.copy')} variant="primary" onClick=${async()=>{await navigator.clipboard.writeText(link);setCopied(true);}}/></${Modal}>`:null}
      ${dialog?html`<${AccessConfirm} pending=${dialog} roles=${roles} resources=${resources} busy=${busy} error=${error} onClose=${()=>setDialog(null)} onSubmit=${apply}/>`:null}
    </section>`;
  }
  const role=roleDraft;
  const savedRole=roles.find(item=>item.id===role?.id)||role;
  const permissionMap=roleLevels(role,resources);
  const editPermission=(resource,level)=>{
    const permissions=rolePermissionsAfterEdit(role,resources,resource,level);
    if(!permissions.length)return;
    begin(role?.builtin?'roles.reset':'roles.edit',role.id,role.name,role.revision,{permissions},role.builtin?'POST':'PUT','roles/'+encodeURIComponent(role.id)+(role.builtin?'/reset':''));
  };
  return html`<section class="ao-access" aria-labelledby="access-roles-heading"><div class="ao-access__heading"><h1 class="bu-heading-lg" id="access-roles-heading">${msg('settings.tab.roles')}</h1><${Button} label=${msg('access.roles.create')} variant="primary" disabled=${busy} onClick=${()=>begin('roles.create','new-role','Nouveau rôle',0,{name:'Nouveau rôle',permissions:resources.map(r=>({resource:r.key,mode:'explicit',level:'none'}))},'POST','roles')}/></div>
    ${error?html`<p class="bu-banner bu-banner--danger" role="alert">${msg(error)}</p>`:null}${notice?html`<p class="bu-banner" role="status">${msg(notice)}</p>`:null}
    <div class="ao-access__users${page==='role'?' ao-access__users--detail':''}"><div class="ao-access__list"><ul class="bu-list">${roles.length?roles.map(r=>html`<${ListRow} key=${r.id} selected=${roleId===r.id} title=${r.name} meta=${msg(r.builtin?'access.roles.builtin':'access.roles.custom')} actions=${html`<${Button} size="sm" label=${msg('access.open')} onClick=${()=>selectRole(r.id)}/>`}/>`):html`<li class="bu-caption">${msg('access.roles.empty')}</li>`}</ul></div>
    ${role?html`<section class="ao-access__detail" aria-labelledby="access-role-name"><div class="ao-access__detail-head"><${Button} class="ao-access__back" variant="ghost" size="sm" label=${msg('access.back')} onClick=${()=>setPage('list')}/><h2 class="bu-heading-lg" id="access-role-name">${role.name}</h2>${role.builtin?html`<p class="bu-caption">${msg('access.roles.readOnly')}</p>`:null}</div>
      ${!role.builtin?html`<${SettingRow} label=${msg('access.roles.rename')} control=${html`<${TextInput} value=${role.name} onValueChange=${name=>setRoleDraft({...roleDraft,name})}/>`}/><div class="ao-access__actions"><${Button} size="sm" label=${msg('access.roles.rename')} disabled=${busy||role.name===savedRole?.name} onClick=${()=>begin('roles.edit',role.id,savedRole.name,savedRole.revision,{name:role.name},'PUT','roles/'+encodeURIComponent(role.id))}/><${Button} size="sm" variant="secondary" label=${msg('access.roles.duplicate')} onClick=${()=>begin('roles.create','new-role',role.name,0,{name:role.name+' (copie)',permissions:role.permissions.map(p=>({...p}))},'POST','roles')}/></div>`:html`<${Button} size="sm" variant="secondary" label=${msg('access.roles.duplicate')} onClick=${()=>begin('roles.create','new-role',role.name,0,{name:role.name+' (copie)',permissions:role.permissions.map(p=>({...p}))},'POST','roles')}/>`}
      <${Matrix} resources=${resources} permissions=${permissionMap} readOnly=${role.builtin} onChange=${editPermission}/>
      ${!role.builtin?html`<${Button} variant="danger" size="sm" label=${msg('access.roles.delete')} disabled=${users.some(u=>u.roleId===role.id)} onClick=${()=>begin('roles.delete',role.id,role.name,role.revision,{},'DELETE','roles/'+encodeURIComponent(role.id))}/>`:null}
    </section>`:html`<div class="ao-access__empty"><p class="bu-caption">${msg('access.roles.empty')}</p></div>`}</div>
    ${dialog?html`<${AccessConfirm} pending=${dialog} roles=${roles} resources=${resources} busy=${busy} error=${error} onClose=${()=>setDialog(null)} onSubmit=${apply}/>`:null}</section>`;
}
