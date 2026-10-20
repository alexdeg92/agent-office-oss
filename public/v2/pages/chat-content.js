import {html,useState} from '../lib.js';
import {label,msg} from '../i18n.js';
import * as fmt from '../fmt.js';
import {Markdown,DataTable} from '../components/markdown.js';
import {AuthorAvatar} from '../components/author-avatar.js';
import {ChatMessage} from '../components/chat-message.js';
import {Modal} from '../components/modal.js';
import {Icon} from '../components/ui.js';
import {apiUrl} from '../config.js';
const attachmentUrl=value=>typeof value==='string'&&value.startsWith('/api/')?apiUrl(value,3):value;
const previewIconName=icon=>icon==='image'?'tool-image':icon==='file-text'||icon==='file'?'tool-file-read':'tool-other';
export function ChatPortrait({portrait}){
 const [failed,setFailed]=useState(false);
 if(portrait?.look)return html`<span class="ao-messenger__portrait" role="img" aria-label=${portrait.alt}><${AuthorAvatar} look=${portrait.look} /></span>`;
 if(portrait?.avatarUrl&&!failed)return html`<img class="ao-messenger__portrait" src=${portrait.avatarUrl} alt=${portrait.alt} onError=${()=>setFailed(true)} />`;
 return html`<span class="ao-messenger__portrait ao-messenger__portrait--fallback" role="img" aria-label=${portrait?.alt||msg('messenger.agents')}><svg class="bu-icon" aria-hidden="true"><use href="#i-agent" /></svg></span>`;
}
function Body({body}){
 if(!body.blocks?.length)return html`<${Markdown} source=${body.text} headingOffset=${3} />`;
 return body.blocks.map((block,n)=>block.type==='text'?html`<${Markdown} key=${n} source=${block.text} headingOffset=${3} />`:block.type==='table'?html`<${DataTable} key=${n} headers=${block.headers} rows=${block.rows} />`:block.type==='team-result'?html`<section key=${n} class="ao-messenger__team-result"><strong>${block.label}</strong>${block.summary?html`<p>${block.summary}</p>`:null}<ul>${block.members.map(member=>html`<li key=${member.id}><${ChatPortrait} portrait=${member.portrait} /><span>${member.name}<small>${label(member.stateLabel)}</small></span></li>`)}</ul></section>`:null);
}
export function ChatAttachmentPreview({file,compact=false,messageMedia=false,onRemove=null,status=null}){
 const [viewer,setViewer]=useState(false),preview=file?.preview||{},kind=preview.kind,thumbnail=preview.thumbnailUrl,openUrl=preview.openUrl;
 const image=kind==='image',pdf=kind==='pdf',accessibleLabel=preview.label?label(preview.label):file?.name||msg('messenger.moreFiles');
 const open=()=>{if(image&&openUrl)setViewer(true);};
 return html`<article class=${'ao-chat-attachment ao-chat-attachment--'+(image?'image':pdf?'pdf':'file')+(compact?' ao-chat-attachment--compact':'')+(messageMedia?' ao-chat-attachment--message':'')} data-preview-kind=${kind||'file'}>
 ${image&&thumbnail?html`<button type="button" class="ao-chat-attachment__image" aria-label=${accessibleLabel} onClick=${open}><img src=${attachmentUrl(thumbnail)} alt=${preview.alt||accessibleLabel} loading="lazy" decoding="async" /></button>`:pdf&&thumbnail?html`<a class="ao-chat-attachment__document-preview" href=${attachmentUrl(openUrl||file.url)} target="_blank" rel="noreferrer" aria-label=${accessibleLabel}><img src=${attachmentUrl(thumbnail)} alt="" loading="lazy" decoding="async" /></a>`:messageMedia&&!thumbnail?html`<a class="ao-chat-attachment__document-file" href=${attachmentUrl(openUrl||file.url)} target="_blank" rel="noreferrer" aria-label=${accessibleLabel}><span class="ao-chat-attachment__document-icon"><${Icon} name=${previewIconName(preview.icon)} /></span><span class="ao-chat-attachment__meta"><strong title=${file?.name||''}>${file?.name||msg('messenger.moreFiles')}</strong><small>${status||fmt.bytes(file?.size||0)}${preview.label?html`<span class="ao-chat-attachment__kind">${label(preview.label)}</span>`:null}</small></span></a>`:html`<a class="ao-chat-attachment__file-icon" data-preview-icon=${preview.icon||'file'} href=${attachmentUrl(openUrl||file.url)} target="_blank" rel="noreferrer" aria-label=${accessibleLabel}><${Icon} name=${previewIconName(preview.icon)} /></a>`}
 ${!(messageMedia&&!thumbnail)?html`<div class="ao-chat-attachment__meta"><strong title=${file?.name||''}>${file?.name||msg('messenger.moreFiles')}</strong><small>${status||fmt.bytes(file?.size||0)}${preview.label?html`<span class="ao-chat-attachment__kind">${label(preview.label)}</span>`:null}</small></div>`:null}
 ${onRemove?html`<button type="button" class="ao-chat-attachment__remove" aria-label=${msg('messenger.remove',{name:file?.name||''})} title=${msg('messenger.remove',{name:file?.name||''})} onClick=${onRemove}><${Icon} name="close" /></button>`:null}
 ${viewer?html`<${Modal} title=${file?.name||accessibleLabel} size="lg" class="ao-chat-attachment-viewer" onClose=${()=>setViewer(false)}><img class="ao-chat-attachment-viewer__image" src=${attachmentUrl(openUrl)} alt=${preview.alt||accessibleLabel} /></${Modal}>`:null}
 </article>`;
}
function AttachmentStrip({attachments,messageMedia=false}){
 if(!attachments?.length)return null;
 return html`<ul class=${'ao-chat-attachment-strip'+(messageMedia?' ao-chat-attachment-strip--message':'')} aria-label=${msg('messenger.moreFiles')}>${attachments.map(file=>html`<li key=${file.id}><${ChatAttachmentPreview} file=${file} messageMedia=${messageMedia} /></li>`)}</ul>`;
}
export function ChatV3Message({message,now,onSendNowQueued,onCancelQueued}){
 const side=message.role==='user'?'user':'agent';
 const body=message.body||{},bodyHasContent=!!String(body.text||'').trim()||(body.blocks||[]).some(block=>block.type==='text'?!!String(block.text||'').trim():true);
 return html`<div class=${'ao-chat__message-group ao-chat__message-group--'+side}>
   <${ChatMessage} m=${message} now=${now} fallbackAuthor=${msg('messenger.agentAuthor')} hideEmptyBubble=${!bodyHasContent&&!!message.attachments?.length} content=${html`<div class="ao-chat__message-content"><${Body} body=${message.body} /></div>`} />
   ${message.role==='user'&&message.statusLabel?html`<div class="ao-chat__queue-state" data-queue-state=${message.status||''} role="status"><span>${message.status==='sent'?html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>`:null}${label(message.statusLabel)}</span>${message.queueActions?html`<span class="ao-chat__queue-actions"><button class="bu-button bu-button--secondary bu-button--sm" type="button" data-queue-cancel=${message.queueActions.turnId} onClick=${()=>onCancelQueued?.(message)}>${label(message.queueActions.cancelLabel)}</button><button class="bu-button bu-button--secondary bu-button--sm" type="button" data-queue-send-now=${message.queueActions.turnId} onClick=${()=>onSendNowQueued?.(message)}>${label(message.queueActions.sendNowLabel)}</button></span>`:null}</div>`:null}
   <${AttachmentStrip} attachments=${message.attachments} messageMedia=${true} />
 </div>`;
}
