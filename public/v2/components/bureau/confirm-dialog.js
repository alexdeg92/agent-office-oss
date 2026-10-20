import {html} from '../../lib.js';
import {msg} from '../../i18n.js';
import {Button} from './forms.js';
import {Modal} from '../modal.js';

/** A controlled confirmation dialog for callers that own the confirmed operation. */
export function ConfirmDialog({open,title,description,confirmLabel,cancelLabel,onConfirm,onCancel,busy=false,error,children,modalClass=''}){
 if(!open)return null;
 const footer=html`<${Button} label=${cancelLabel||msg('common.cancel')} disabled=${busy} onPress=${onCancel} />
  <${Button} label=${confirmLabel} variant="danger" busy=${busy} onPress=${onConfirm} />`;
 return html`<${Modal} title=${title} desc=${description} footer=${footer} class=${modalClass} onClose=${busy?()=>{}:onCancel}>
  ${children}${error?html`<p role="alert" class="bu-field__error">${error}</p>`:null}
 </${Modal}>`;
}
