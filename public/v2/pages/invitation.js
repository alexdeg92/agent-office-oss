import { html, useEffect, useState } from '../lib.js';
import { msg } from '../i18n.js';
import { registerMessages } from '../messages.js';
import * as accessDictionary from '../messages/access-management.js';
import { request } from '../api.js';
import { Button, Field, TextInput } from '../components/bureau/index.js';
import { Frame, Icon } from '../components/ui.js';
import { Logo } from '../components/shell.js';
import { services } from '../services.js';

registerMessages(accessDictionary);

export function InvitationPage() {
  const [token,setToken]=useState(null),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(null),[accepted,setAccepted]=useState(false);
  useEffect(()=>{
    const params=new URLSearchParams(location.hash.slice(1));
    const value=params.get('token');
    history.replaceState(history.state,'',location.pathname+location.search);
    setToken(params.get('purpose')==='invitation'?value:null);
  },[]);
  async function submit(event){event.preventDefault();if(!token||busy||password.length<12||password.length>1024||password!==confirm)return;setBusy(true);setError(null);
    try{await request('POST','/api/auth/invitations/accept',{token,password},{quiet:true,apiVersion:2});setToken(null);setPassword('');setConfirm('');setAccepted(true);}
    catch{setError('access.accept.invalid');}finally{setBusy(false);}
  }
  return html`<div class="bu-login"><div class="bu-login__panel"><${Frame} tag="form" class="bu-login__form" onSubmit=${submit} bodyLabel=${msg('access.accept.title')} foot=${accepted?null:html`<${Button} type="submit" variant="primary" size="lg" label=${msg('access.accept.submit')} busy=${busy} disabled=${busy||!token||password.length<12||password!==confirm}/>`}>
    <${Logo} kind="mark" class="ao-login-mark" alt="Agent Office"/><div><h1 class="bu-login__title">${msg('access.accept.title')}</h1>
      ${accepted?html`<p class="bu-login__sub" role="status">${msg('access.accept.success')}</p><${Button} variant="primary" label=${msg('nav.connexion')} onClick=${()=>services.router.navigate(services.router.href('connexion'))}/>`:null}</div>
    ${!accepted?html`<div class="ao-access__form"><${Field} id="invitation-password" label=${msg('access.accept.password')} required hint="12–1024" control=${p=>html`<${TextInput} ...${p} type="password" autoComplete="new-password" minLength=${12} maxLength=${1024} value=${password} onValueChange=${setPassword} disabled=${busy||!token}/>`}/>
      <${Field} id="invitation-confirm" label=${msg('access.accept.confirm')} required control=${p=>html`<${TextInput} ...${p} type="password" autoComplete="new-password" minLength=${12} maxLength=${1024} value=${confirm} onValueChange=${setConfirm} disabled=${busy||!token} invalid=${Boolean(confirm&&confirm!==password)}/>`}/>
      ${error||!token?html`<div class="bu-banner bu-banner--danger" role="alert"><${Icon} name="alert"/><span class="bu-banner__text">${msg(error||'access.accept.invalid')}</span></div>`:null}</div>`:null}
  </${Frame}></div></div>`;
}
