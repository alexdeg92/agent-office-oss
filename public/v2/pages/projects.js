// Server-projected v3 board. Query controls send selections; columns/cards keep VM order.
import { html, useState, useEffect, useRef } from '../lib.js';
import { useCapability } from '../hooks.js';
import { services } from '../services.js';
import { msg, label } from '../i18n.js';
import { post, toastError } from '../api.js';
import { projectWrite } from '../project-api.js';
import { toast } from '../toast.js';
import { Frame, Icon, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { Thumb, Priority, priorityOptions, priorityText } from '../components/project.js';
import { Button, TextInput, Select, Menu, loadStyles as loadBureauStyles } from '../components/bureau/index.js';
import { useProjectTopic } from './project-live.js';
import { ProjectSources } from './project-sources.js';
import { ConnectorBrandMark } from './connector-brand.js';
import { buildQuery } from '../config.js';
import { chunkError } from '../build-update.js';
import './projects-board-messages.js';
import {useSmallProjects} from './projects-mobile.js';

let styles;
export function loadStyles() {
  const sheet=styles ||= new Promise((resolve,reject)=>{
    const node=document.createElement('link');node.rel='stylesheet';node.href=new URL('./projects-board.css'+buildQuery,import.meta.url).href;
    node.onload=resolve;node.onerror=()=>{node.remove();styles=null;reject(chunkError(Error('Project stylesheet unavailable')));};document.head.append(node);
  });
  return Promise.all([sheet,loadBureauStyles()]);
}
export function boardTopic(filter='all', query={}) {
  const values={filter:filter==='all'?null:filter,search:query.q||null,source:query.source||null,stage:query.etape||null};
  const params=Object.entries(values).filter(([,value])=>value!==null).map(([key,value])=>key+'='+encodeURIComponent(value)).join('&');
  return 'projects'+(params?'?'+params:'');
}
export function ProjectsPage({match}) {
  const small=useSmallProjects();
  const {router}=services, filter=match.query.filtre||'all';
  const topic=boardTopic(filter,match.query), vm=useProjectTopic(topic,'/api/v3/views/'+topic,{keepPrevious:true});
  const writes=useCapability('storeWrites');
  const [creating,setCreating]=useState(null),[busy,setBusy]=useState(null),[search,setSearch]=useState(''),[picked,setPicked]=useState(null);
  const searchTimer=useRef(null),press=useRef(null),suppressed=useRef(false),drag=useRef(null),rail=useRef(null);
  const [edges,setEdges]=useState({left:false,right:false});
  const measureRail=()=>{const node=rail.current;if(node)setEdges({left:node.scrollLeft>1,right:node.scrollLeft+node.clientWidth<node.scrollWidth-1});};
  useEffect(()=>{const node=rail.current;if(!node)return;measureRail();const observer=new ResizeObserver(measureRail);observer.observe(node);return()=>observer.disconnect();},[vm.data?.sourceFilters]);
  useEffect(()=>{services.lastBoardUrl=location.pathname+location.search;},[match]);
  useEffect(()=>{if(vm.data)setSearch(vm.data.controls.search.selected||'');},[vm.data?.controls.search.selected]);
  useEffect(()=>()=>{clearTimeout(searchTimer.current);clearTimeout(press.current);},[]);
  const choose=(query)=>router.setQuery(query);
  async function move(card,to) {
    if(to===card.status)return;
    setBusy(card.id);setPicked(null);
    const result=await projectWrite({method:'PUT',id:card.id,path:'/status',body:{status:to},expectedRevision:card.revision,
      apiVersion:3,stream:vm.stream,topics:[topic],success:data=>({level:'success',message:msg('projects.toast.moved',{stage:label(vm.data.columns.find(column=>column.id===to)?.label)}),
        action:data.vm?{label:msg('common.undo'),run:()=>move(data.vm,card.status)}:null})});
    if(result.ok)vm.stream?.resync(topic);
    setBusy(null);
  }
  if(!vm.data)return html`<${Frame} class="bu-page ao-projects ao-projects-server">${vm.error?html`<${ErrorState} error=${vm.error} onRetry=${vm.retry}/>`:html`<div aria-busy="true"><${Skeleton} kind="title"/><${Skeleton} kind="block"/></div>`}</${Frame}>`;
  const board=vm.data, stage=board.controls.stage, searchControl=board.controls.search;
  return html`<${Frame} class="bu-page ao-projects ao-projects-server" bodyClass="ao-frame__body--framed" bodyLabel=${msg('nav.projets')} aria-busy=${vm.loading?'true':undefined}
    head=${html`<div class="ao-projects-server__header">
      <div class="ao-projects-server__actions"><${TextInput} type="search" width="full" label=${label(searchControl.options[0]?.label)} placeholder=${msg('projects.searchShort')} value=${search} maxLength=${120}
        onValueChange=${value=>{setSearch(value);clearTimeout(searchTimer.current);searchTimer.current=setTimeout(()=>choose({q:value||null}),200);}}/>
        ${writes?html`<${Button} label=${msg('projects.create')} variant="primary" icon=${html`<${Icon} name="add"/>`} onPress=${()=>setCreating(board.columns[0].id)}/>`:null}</div></div>`}
    bar=${html`<div class="ao-projects-server__filters"><div class="ao-projects-source-scroll" data-overflow-left=${edges.left} data-overflow-right=${edges.right}><nav ref=${rail} onScroll=${measureRail} class="ao-projects-source-rail" aria-label=${msg('projects.sources.filter')}>
      <button class="bu-segmented__opt ao-source-choice" type="button" data-project-source="all" aria-pressed=${board.sourceFilterId===null?'true':'false'} onClick=${()=>choose({source:null})}><${Icon} name="layers"/><span>${msg('projects.sources.all')}</span></button>
      ${board.sourceFilters.map(source=>html`<button key=${source.id} class="bu-segmented__opt ao-source-choice" type="button" data-project-source=${source.id} aria-pressed=${source.selected?'true':'false'} onClick=${()=>choose({source:source.id})}>
        ${source.source.brand?html`<${ConnectorBrandMark} brand=${source.source.brand} label=${label(source.label)}/>`:html`<${Icon} name="projets"/>`}<span>${label(source.label)}</span><span class="bu-count">${source.count}</span></button>`)}
    </nav></div><${Select} id="project-stage" label=${msg('projects.new.stage')} value=${stage.selected} options=${stage.options.map(option=>({value:option.id,label:label(option.label)}))} onValueChange=${value=>choose({etape:value==='all'?null:value})}/></div>`}>
    ${vm.error?html`<div role="status" class="bu-banner bu-banner--warning"><span>${msg('common.updateFailed',{error:vm.error.message})}</span><${Button} label=${msg('common.retry')} onPress=${vm.retry}/></div>`:null}
    ${board.emptyStateLabel?html`<p class="bu-empty" role="status">${label(board.emptyStateLabel)}</p>`:null}
    <div class="ao-projects-server__board ao-board" data-scroll-body tabindex="0">${board.columns.map(column=>html`<section key=${column.id} class="ao-projects-server__column" data-column=${column.id} data-column-empty=${column.count===0?'true':undefined} aria-label=${label(column.label)}
      onDragOver=${event=>{if(drag.current){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDrop=${event=>{event.preventDefault();if(drag.current)void move(drag.current,column.id);}}>
      <header><h3>${label(column.label)}</h3><span class="bu-count" data-column-count=${column.count}>${column.count}</span></header>
      <ul class="bu-column__list" tabindex="0">${column.cards.map(card=>html`<li key=${card.id}><article class=${'bu-card ao-projects-server__card'+(small?' ao-mobile-card':'')} data-card=${card.id} draggable=${!small&&writes&&card.capabilities.write&&busy===null}
        onDragStart=${event=>{event.dataTransfer.setData('text/plain',card.id);drag.current=card;}} onDragEnd=${()=>{drag.current=null;}}
        tabindex="0" onKeyDown=${event=>{if(event.key==='Escape')setPicked(null);if(event.target===event.currentTarget&&(event.key===' '||event.key==='Spacebar')&&writes&&card.capabilities.write){event.preventDefault();setPicked(card);}}}>
        ${card.cover?html`<${Thumb} thumb=${{kind:"cover",url:small&&card.cover.thumbUrl?card.cover.thumbUrl:card.cover.url,repoLabel:card.thumb.repoLabel}} id=${card.id} showRepo=${false}/>`:null}
        <div class="ao-projects-server__card-meta"><${ProjectSources} sources=${card.sourceDescriptors}/><${Priority} p=${card.priority}/></div>
        <a class="ao-projects-server__link" href=${router.href('projet',{projectId:card.id})}
          onPointerDown=${event=>{if(event.pointerType==='touch'&&writes&&card.capabilities.write){suppressed.current=false;press.current=setTimeout(()=>{suppressed.current=true;setPicked(card);},450);}}}
          onPointerUp=${()=>clearTimeout(press.current)} onPointerCancel=${()=>clearTimeout(press.current)} onPointerMove=${()=>clearTimeout(press.current)}
          onClick=${event=>{if(suppressed.current){event.preventDefault();suppressed.current=false;}}}><h4>${card.name}</h4></a>
        <div class="ao-projects-server__card-foot">
          ${writes&&card.capabilities.write?html`<${Menu} class="ao-projects-move" testId=${'project-move:'+card.id} label=${msg('projects.moveLabel',{name:card.name})} triggerLabel=${msg('projects.moveShort')} disabled=${busy===card.id}
            items=${board.columns.map(column=>({id:column.id,label:label(column.label),disabled:busy===card.id||card.status===column.id,onSelect:()=>void move(card,column.id)}))}/>`:null}
          <span class="ao-projects-server__activity" title=${msg('projects.lastActivity')}><${Icon} name="clock"/><${Ago} at=${card.lastActivityAt}/></span>
        </div>
      </article></li>`)} </ul></section>`)}</div>
    ${picked?html`<${Modal} title=${picked.name} desc=${msg('projects.moveTo')} onClose=${()=>setPicked(null)}><div class="ao-projects-server__destinations">${board.columns.map(column=>html`<${Button} key=${column.id} label=${label(column.label)} disabled=${picked.status===column.id} onPress=${()=>void move(picked,column.id)}/>` )}</div></${Modal}>`:null}
    ${creating?html`<${CreateProject} status=${creating} columns=${board.columns} onClose=${()=>setCreating(null)}/>`:null}
  </${Frame}>`;
}

function CreateProject({ status, columns, onClose }) {
  const { router } = services;
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { name: String(f.get('name') || '').trim(), status: f.get('status'), priority: f.get('priority') };
    const summary = String(f.get('summary') || '').trim();
    if (summary) body.summary = summary;
    if (!body.name) { setErrors({ name: msg('projects.new.nameRequired') }); return; }
    setBusy(true); setErrors({});
    try {
      const r = await post('/api/v3/projects', body, { quiet: true, apiVersion: 3 });
      toast({ level: 'success', message: msg('projects.new.created') });
      onClose();
      const id = r && r.data && r.data.result && r.data.result.id;
      if (id) router.navigate(router.href('projet', { projectId: id }));
    } catch (err) {
      setBusy(false);
      if (err.code === 'validation_failed' && err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.field, err.message])));
      else if (err.code !== 'unauthorized') toastError(err);
    }
  }
  const fieldErr = (k) => (errors[k] ? html`<p class="bu-field__error" id=${'np-' + k + '-err'}><${Icon} name="alert" />${errors[k]}</p>` : null);
  return html`<${Modal} title=${msg('projects.create')} desc=${msg('projects.new.desc')} onClose=${onClose}
    footer=${html`<button type="button" class="bu-btn" onClick=${onClose}>${msg('common.cancel')}</button><button type="submit" form="new-project" class="bu-btn bu-btn--primary" aria-busy=${busy ? 'true' : undefined} disabled=${busy}>${msg('projects.new.submit')}</button>`}>
    <form id="new-project" class="ao-form" onSubmit=${submit} novalidate>
      <div class="bu-field"><label class="bu-field__label" for="np-name">${msg('projects.new.name')} <span class="bu-field__req" aria-hidden="true">*</span></label>
        <input class="bu-input" id="np-name" name="name" maxlength="80" required autofocus autocomplete="off" aria-invalid=${errors.name ? 'true' : undefined} aria-describedby=${errors.name ? 'np-name-err' : undefined} />${fieldErr('name')}</div>
      <div class="bu-form-row">
        <div class="bu-field"><label class="bu-field__label" for="np-status">${msg('projects.new.stage')}</label>
          <select class="bu-select" id="np-status" name="status">${columns.map((column) => html`<option value=${column.id} selected=${column.id === status}>${label(column.label)}</option>`)}</select></div>
        <div class="bu-field"><label class="bu-field__label" for="np-priority">${msg('projects.new.priority')}</label>
          <select class="bu-select" id="np-priority" name="priority">${priorityOptions().map((p) => html`<option value=${p} selected=${p === 'P2'}>${priorityText(p)}</option>`)}</select></div>
      </div>
      <div class="bu-field"><label class="bu-field__label" for="np-summary">${msg('projects.new.summary')}</label>
        <textarea class="bu-textarea" id="np-summary" name="summary" maxlength="4000" placeholder=${msg('projects.new.summaryPlaceholder')}></textarea>
        <p class="bu-field__hint">${msg('projects.new.summaryHint')}</p></div>
    </form>
  </${Modal}>`;
}
