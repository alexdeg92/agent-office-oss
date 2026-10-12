import { html, useEffect, useRef, useState } from '../lib.js';
import { msg } from '../i18n.js';
import * as fmt from '../fmt.js';
import { settingsLabel, diagnosticText, detectionText, connectorDetectionText } from './settings-labels.js';
import { services } from '../services.js';
import { Icon, EmptyState } from '../components/ui.js';
import * as R from './settings-rules.js';
import { networkOptions } from './network-options.js';
import { ConnectorBrandMark, loadPreparedConnectorBrands } from './connector-brand.js';
import {useSettingsPortraits,SettingsPortrait} from './settings-portraits.js';
import { ListRow, SettingRow, Menu, KeyValue, TextAction, CollapsedGroup, Field, TextInput, TextArea, Select, Checkbox, Button, Switch } from '../components/bureau/index.js';

export { settingsLabel };
export const Intro = ({tab}) => html`<p class="ao-settings__intro">${msg('settings.' + (tab === 'compte' ? 'account' : tab === 'connexion' ? 'connection' : tab) + '.intro')}</p>`;
export function SettingsNotice({text, warning = false, action}) {
  return html`<div class=${'bu-banner' + (warning ? ' bu-banner--warning' : '')} role="status"><${Icon} name=${warning ? 'warning' : 'info'} />
    <span class="bu-banner__text">${text}</span>${action}</div>`;
}

export function RestartAction({capability, state, busy, readonly, label, onRestart, onPoll}) {
  return html`<div class="ao-settings__restart">
    ${state?.status === 'waiting' ? html`<p role="status">${msg('settings.restart.waiting')}</p>`
      : state?.status === 'timeout' ? html`<p role="status">${msg('settings.restart.timeout')}</p><${Button} type="button"  disabled=${busy} onClick=${onPoll} variant="secondary" size="sm" label=${msg('settings.restart.poll')} />`
      : capability?.supported ? html`<${Button} type="button"  disabled=${busy || readonly} onClick=${onRestart} variant="secondary" size="sm" label=${label || msg('settings.restart.action')} />` : null}
    ${capability?.command && (!capability.supported || state?.status === 'timeout') ? html`<p class="bu-caption">${msg('settings.restart.manual')} <code>${capability.command}</code></p>`
      : !capability?.supported || state?.status === 'timeout' ? html`<p class="bu-caption">${capability?.reason ? settingsLabel(capability.reason) : msg('settings.restart.help')}</p>` : null}
  </div>`;
}

export function SettingsField({id, name, definition, field, value, onChange, disabled = false, hint, min, max, maxLength}) {
  const text=name || settingsLabel(definition?.label),locked=disabled || field?.editable!==true;
  const why=field?.reason ? settingsLabel(field.reason) : field?.source==='env' ? msg('settings.env') : '';
  const type=definition?.type || 'text',options=definition?.options || [],rowId=id+'-row';
  const attrs={id,labelledBy:rowId+'-label',describedBy:rowId+'-description',disabled:locked};
  const control=type==='select' ? html`<${Select} ...${attrs} value=${value??''} options=${options.map(o=>({...o,label:settingsLabel(o.label)}))} onValueChange=${onChange} />`
    : type==='boolean' ? html`<${Checkbox} ...${attrs} checked=${!!value} label=${msg(value?'settings.yes':'settings.no')} onCheckedChange=${onChange} />`
    : type==='textarea' ? html`<${TextArea} ...${attrs} rows=${3} value=${value??''} onValueChange=${onChange} />`
    : html`<${TextInput} ...${attrs} type=${type==='number'?'number':type==='url'?'url':'text'} width=${type==='number'?'short':'full'} value=${value??''} min=${min} max=${max} maxLength=${maxLength} autoComplete="off" spellCheck=${type==='url'?false:undefined} onValueChange=${v=>onChange(type==='number'?(v===''?null:Number(v)):v)} />`;
  return html`<${SettingRow} id=${rowId} label=${text} description=${why||hint||msg('settings.source.'+(field?.source||'default'))} class=${'ao-settings__field ao-settings__field--'+type} control=${control} />`;
}

const claudeReasonMessageKey = reasonCode => ({
  'no-recognizable-session-lines':'settings.connection.claudeReasonNoRecords',
  'probe-file-limit':'settings.connection.claudeReasonFileLimit',
  'probe-byte-limit':'settings.connection.claudeReasonByteLimit',
  'project-directory-not-found':'settings.connection.claudeReasonDirectoryMissing',
  'probe-failed':'settings.connection.claudeReasonProbeFailed',
})[reasonCode] || 'settings.connection.claudeReasonGeneric';

function SecretField({definition, field, value, replacing, onChange, disabled, instance = ''}) {
  const id='settings-runtime-'+instance+'-'+definition.id,rowId=id+'-row',locked=disabled || field?.editable!==true;
  const shown=replacing || !field?.tokenSet;
  return html`<${SettingRow} id=${rowId} label=${settingsLabel(definition.label)} description=${msg(field?.tokenSet?'settings.secret.set':'settings.secret.empty')} details=${field?.reason ? html`<p class="bu-caption">${settingsLabel(field.reason)}</p>` : null}
    class="ao-settings__field ao-settings__field--password" control=${html`<div class="ao-settings__secret-control">
      ${shown ? html`<${TextInput} id=${id} labelledBy=${rowId+'-label'} describedBy=${rowId+'-description'} type="password" value=${value||''} disabled=${locked} autoComplete="new-password" spellCheck=${false} onValueChange=${onChange} />` : null}
      ${!shown ? html`<${TextAction} targetName=${settingsLabel(definition.label)} label=${msg('settings.secret.replace')} disabled=${locked} onPress=${()=>onChange('')} />`
        : field?.tokenSet ? html`<${TextAction} targetName=${settingsLabel(definition.label)} label=${msg('settings.secret.keep')} disabled=${locked} onPress=${()=>onChange(null)} />` : null}
    </div>`} />`;
}

export function Diagnostics({vm, onFix, onViewDetected, onViewOrchestrator, onFixAll, onRefresh, busy, restartAction}) {
  const issues=vm.diagnostics.filter(d=>['error','warning','warn'].includes(d.level));
  const information=vm.diagnostics.filter(d=>!['error','warning','warn','ok'].includes(d.level));
  const healthy=vm.diagnostics.filter(d=>d.level==='ok');
  const actionLabel=fix=>msg('settings.diagnostic.action.' + ({'integration.install':'install','integration.update':'update','integration.review':'review','runtime.enable':'enable','instance.restart':'restart','client.reload':'reload'}[fix.kind] || 'configure'));
  const row=d=>{
    const text=diagnosticText(d,vm),runtime=vm.runtimes.find(r=>d.id==='runtime:'+r.id);
    const detectedConnector=d.id.startsWith('detected-agents:') ? d.id.slice('detected-agents:'.length) : null;
    const detectedOrchestrator=d.id==='orchestrator:detected';
    const name=runtime?.name || d.label.params?.agent || null;
    const key=d.label.key.replace(/^settings\.diagnostic\./,'');
    const cause=name && dictionaryCause(key) ? msg('settings.diagnostic.cause.'+key) : name ? text.title.replace(name+' · ','') : null;
    const heading=html`<span class="ao-settings__diagnostic-name"><span>${name || text.title}</span></span>`;
    const title=text.detail ? html`<details class="ao-settings__details"><summary>${heading}${cause ? html`<span class="ao-settings__diagnostic-cause">${cause}<${Icon} name="arrow-down" /></span>` : null}</summary><p>${text.detail}</p></details>` : heading;
    const action=detectedOrchestrator ? html`<${TextAction} label=${msg('settings.diagnostic.action.enable')} targetName=${text.title} busy=${busy} onPress=${onViewOrchestrator} />`
      : detectedConnector ? html`<${TextAction} label=${msg('settings.diagnostic.action.view')} targetName=${text.title} busy=${busy} onPress=${()=>onViewDetected(detectedConnector)} />`
      : d.fix && ['error','warning','warn'].includes(d.level) ? d.fix.kind==='instance.restart' && vm.network?.restartRequired ? restartAction : html`<${TextAction} label=${actionLabel(d.fix)} targetName=${name || text.title} busy=${busy} disabled=${vm.readonly} onPress=${()=>onFix(d.fix)} />` : null;
    return html`<${ListRow} key=${d.id} id=${'diagnostic-'+d.id} testId=${'diagnostic-'+d.id} class=${'ao-settings__diagnostic ao-settings__diagnostic--'+d.level}
      severity=${d.level==='warning' ? 'warn' : ['error','warn','info','ok'].includes(d.level) ? d.level : 'unknown'} statusLabel=${msg('settings.status.'+d.level)} title=${title} meta=${cause && !text.detail ? html`<p>${cause}</p>` : null} actions=${action} />`;
  };
  return html`<div class="ao-settings__diagnostics" data-diagnostics>
    <div class="ao-settings__diagnostic-summary"><p role="status">${msg(!vm.diagnostics.length?'settings.diagnostic.empty':issues.length?issues.length===1?'settings.diagnostic.summaryOne':'settings.diagnostic.summary':'settings.diagnostic.allHealthy',{n:issues.length})}</p>
      <div class="bu-btn-group">${R.diagnosticFixes(vm).some(R.automaticFix) ? html`<${Button} type="button"  disabled=${busy || vm.readonly} onClick=${onFixAll} variant="primary" size="sm" label=${msg('settings.fixAll.title')} />` : null}
      <${Menu} label=${msg('settings.diagnostic.options')} items=${[{id:'refresh',label:msg('settings.refresh'),icon:html`<${Icon} name="refresh" />`,disabled:busy,onSelect:onRefresh}]} /></div>
    </div>
    ${issues.length || information.length ? html`<ul class="ao-settings__list">${[...issues,...information].map(row)}</ul>` : null}
    ${healthy.length ? html`<${CollapsedGroup} class="ao-settings__healthy" label=${msg(healthy.length===1?'settings.diagnostic.healthyOne':'settings.diagnostic.healthy',{n:healthy.length})}><ul class="ao-settings__list">${healthy.map(row)}</ul></${CollapsedGroup}>` : null}
  </div>`;
}

const dictionaryCause=key=>['connected','unreachable','refused','unsupported-format','capacity-limited','unauthorized','not-configured','unsupported','agentConfigured','agentFound','integration.missing','integration.outdated','integration.modified','integration.unsupported'].includes(key);

export function Agents({vm, draft, selectedRuntime = draft.runtime, targetAgent = null, onChange, onRuntime, onDetect, disabled, busy}) {
  const [editing,setEditing]=useState(null),portraits=useSettingsPortraits(vm.agents);
  const runtimes=vm.runtimes,runtime=selectedRuntime,set=patch=>onChange({...draft,...patch});
  const update=(index,patch)=>set({agents:draft.agents.map((a,i)=>i===index?{...a,...patch}:a)});
  const add=(id='',name='')=>{set({agents:[...draft.agents,{id,name,hidden:false}]});setEditing(draft.agents.length);};
  const missing=vm.agents.filter(a=>a.runtime===runtime&&!draft.agents.some(row=>row.id===a.agentId));
  if (runtime === 'all') {
    const configured=vm.agents;
    return html`<section class="ao-settings__group ao-settings__all-agents" aria-labelledby="settings-agents">
      <div class="ao-settings__group-head"><h2 class="bu-heading-sm" id="settings-agents">${msg('settings.agents.roster')}</h2>
        <${Field} id="settings-agent-runtime" class="ao-settings__runtime-field" label=${msg('settings.agents.chooseRuntime')} control=${props=>html`<${Select} ...${props} value="all" disabled=${busy||disabled} options=${[{value:'all',label:msg('settings.agents.all')},...runtimes.map(r=>({value:r.id,label:r.name,disabled:!r.supported}))]} onValueChange=${id=>{setEditing(null);onRuntime(id);}} />`} />
      </div>
      ${configured.length?html`<ul class="ao-settings__list ao-settings__roster">${configured.map(agent=>{
        const connector=runtimes.find(item=>item.id===agent.runtime),mark=connector?.brand,providerName=mark?.providerName||connector?.name||agent.runtime,look=R.lookQuery(agent.lookRoute);
        return html`<${ListRow} key=${agent.id} testId=${'settings-agent-all-'+agent.runtime+'-'+agent.agentId} class="ao-settings__all-agent"
          avatar=${html`<span class="ao-settings__branded-portrait"><${SettingsPortrait} look=${portraits.get(`${agent.runtime}:${agent.agentId}`)||(look&&portraits.get(look.agent))} /><${ConnectorBrandMark} brand=${mark} className="ao-settings__connector-mark" label=${providerName} /></span>`}
          title=${agent.name||agent.agentId} badges=${html`<span class="ao-settings__connector-name">${providerName}</span>`}
          muted=${agent.hidden} meta=${html`<span class="bu-caption">${msg(agent.configured?'settings.agents.configured':'settings.agents.detected')} · ${msg(agent.hidden?'settings.agents.hiddenState':'settings.agents.inOffice')}${agent.isPrimary?' · '+msg('settings.agents.primary'):''}</span>`}
          actions=${html`<${TextAction} targetName=${providerName} disabled=${disabled||busy||!connector?.supported} onPress=${()=>onRuntime(agent.runtime)} label=${msg('settings.agents.openConnector')} />`} />`;
      })}</ul>`:html`<p class="bu-text-secondary">${msg('settings.agents.empty')}</p>`}
    </section>
    <section class="ao-settings__group" aria-labelledby="settings-detections"><div class="ao-settings__group-head"><h2 class="bu-heading-sm" id="settings-detections">${msg('settings.agents.detections')}</h2><${Button} type="button" disabled=${disabled} onClick=${onDetect} variant="ghost" size="sm" label=${msg(busy?'settings.agents.detecting':'settings.agents.detect')} icon=${html`<${Icon} name="refresh" />`} /></div>
      ${runtimes.map(r=>{const evidence=detectionText(r);return html`<${SettingRow} key=${r.id} testId=${'settings-runtime-'+r.id} label=${r.name} description=${evidence.checkedAt!==null?html`<time data-detection-checked-at=${evidence.checkedAt} datetime=${new Date(evidence.checkedAt).toISOString()}>${msg('settings.agents.checkedAt',{at:fmt.dateTime(evidence.checkedAt)})}</time>`:evidence.reason} status=${html`<span class="bu-caption">${evidence.badge}</span>`} details=${html`<details class="ao-settings__evidence"><summary aria-label=${msg('settings.agents.details',{name:r.name})}><span>${msg('settings.diagnostic.details')}</span><${Icon} name="arrow-down" /></summary><p class="bu-caption">${evidence.reason}</p>${!r.supported?html`<p class="bu-caption">${msg('settings.connection.connectorComing')}</p>`:null}<${KeyValue} label=${msg('settings.agents.confidence',{value:''})} value=${['config','presence'].includes(r.confidence)?msg('settings.confidence.'+r.confidence):r.confidence} mono=${false} />${r.checkedPaths.map(path=>html`<${KeyValue} key=${path} label=${msg('settings.agents.paths')} value=${path} />`)}</details>`} />`;})}
    </section>`;
  }
  return html`<section class="ao-settings__group" aria-labelledby="settings-agents">
    <div class="ao-settings__group-head"><h2 class="bu-heading-sm" id="settings-agents">${msg('settings.agents.roster')}</h2>
      <${Field} id="settings-agent-runtime" class="ao-settings__runtime-field" label=${msg('settings.agents.chooseRuntime')} control=${props=>html`<${Select} ...${props} value=${runtime} disabled=${busy||disabled} options=${[{value:'all',label:msg('settings.agents.all')},...runtimes.map(r=>({value:r.id,label:r.name,disabled:!r.supported}))]} onValueChange=${id=>{setEditing(null);onRuntime(id);}} />`} />
    </div>
    ${!draft.agents.length?html`<p class="bu-text-secondary">${msg('settings.agents.empty')}</p>`:null}
    <ul class="ao-settings__list ao-settings__roster">${draft.agents.map((a,index)=>{
      const original=vm.agents.find(row=>row.runtime===draft.runtime&&row.agentId===a.id),look=original&&R.lookQuery(original.lookRoute);
      const name=a.name||msg('settings.agents.nameMissing');
      const items=[{id:'rename',label:msg('settings.agents.rename'),disabled,onSelect:()=>setEditing(editing===index?null:index)},
        {id:'primary',label:msg('settings.agents.makePrimary'),disabled:disabled||a.hidden||!a.id||draft.primary===a.id,onSelect:()=>set({primary:a.id})},
        {id:'hidden',label:msg(a.hidden?'settings.agents.show':'settings.agents.hidden'),disabled,onSelect:()=>update(index,{hidden:!a.hidden})},
        ...(look?[{id:'look',kind:'link',label:msg('settings.agents.look'),href:services.router.href('boutique',{},look)}]:[]),
        {id:'separator',kind:'separator'},{id:'remove',label:msg('settings.agents.remove'),danger:true,disabled,onSelect:()=>{set({agents:draft.agents.filter((_,i)=>i!==index),primary:draft.primary===a.id?null:draft.primary});setEditing(null);}}];
      return html`<${ListRow} key=${index} testId=${'settings-agent-row-'+index} avatar=${html`<${SettingsPortrait} look=${look&&portraits.get(look.agent)} />`} title=${name} muted=${a.hidden}
        badges=${html`${draft.primary===a.id?html`<span class="ao-settings__role">${msg('settings.agents.primary')}</span>`:null}${a.hidden?html`<span class="bu-caption">${msg('settings.agents.hiddenState')}</span>`:null}`}
        meta=${html`<${KeyValue} label=${msg('settings.agents.id')} value=${a.id} class="ao-settings__agent-id" />${editing===index?html`<div class="ao-settings__agent-editor">
          ${!original?html`<${SettingsField} id=${'settings-agent-id-'+index} name=${msg('settings.agents.id')} field=${{editable:true,source:'file'}} value=${a.id} disabled=${disabled} onChange=${id=>update(index,{id})} />`:null}
          <${SettingsField} id=${'settings-agent-name-'+index} name=${msg('settings.agents.name')} field=${{editable:true,source:'file'}} value=${a.name} hint=${!a.name.trim()?msg('settings.agents.nameMissing'):null} maxLength="80" disabled=${disabled} onChange=${name=>update(index,{name})} />
          ${original?.detectedName?html`<p class="bu-caption">${msg('settings.agents.detectedName',{name:original.detectedName,source:original.nameSource||'—'})}</p>`:null}
        </div>`:null}`} actions=${html`<${Menu} label=${msg('settings.agents.actions',{name})} items=${items} />`} />`;
    })}</ul>
    ${missing.length?html`<ul class="ao-settings__list ao-settings__roster">${missing.map(a=>html`<${ListRow} key=${a.id} testId=${'settings-unconfigured-agent-'+a.agentId} fixTarget=${!targetAgent || targetAgent===a.agentId}
      avatar=${html`<${SettingsPortrait} />`} title=${a.name||a.agentId} meta=${html`<p>${msg(a.configured?'settings.agents.removing':'settings.agents.notConfigured')}</p>`}
      actions=${html`<${TextAction} targetName=${a.name||a.agentId} disabled=${disabled} onPress=${()=>add(a.agentId,a.name||'')} label=${msg(a.configured?'settings.agents.restore':'settings.agents.fromDetection')} />`} />`)}</ul>`:null}
    <${Button} type="button" disabled=${disabled||!draft.runtime} onClick=${()=>add()} variant="ghost" size="sm" label=${msg('settings.agents.add')} icon=${html`<${Icon} name="add" />`} />
  </section>
  <section class="ao-settings__group" aria-labelledby="settings-detections"><div class="ao-settings__group-head"><h2 class="bu-heading-sm" id="settings-detections">${msg('settings.agents.detections')}</h2><${Button} type="button"  disabled=${disabled} onClick=${onDetect} variant="ghost" size="sm" label=${msg(busy?'settings.agents.detecting':'settings.agents.detect')} icon=${html`<${Icon} name="refresh" />`} /></div>
    ${runtimes.map(r=>{const evidence=detectionText(r);return html`<${SettingRow} key=${r.id} testId=${'settings-runtime-'+r.id} label=${r.name} description=${evidence.checkedAt!==null?html`<time data-detection-checked-at=${evidence.checkedAt} datetime=${new Date(evidence.checkedAt).toISOString()}>${msg('settings.agents.checkedAt',{at:fmt.dateTime(evidence.checkedAt)})}</time>`:evidence.reason}
      status=${html`<span class="bu-caption">${evidence.badge}</span>`} details=${html`<details class="ao-settings__evidence"><summary aria-label=${msg('settings.agents.details',{name:r.name})}><span>${msg('settings.diagnostic.details')}</span><${Icon} name="arrow-down" /></summary><p class="bu-caption">${evidence.reason}</p>${!r.supported?html`<p class="bu-caption">${msg('settings.connection.connectorComing')}</p>`:null}<${KeyValue} label=${msg('settings.agents.confidence',{value:''})} value=${['config','presence'].includes(r.confidence)?msg('settings.confidence.'+r.confidence):r.confidence} mono=${false} />${r.checkedPaths.map(path=>html`<${KeyValue} key=${path} label=${msg('settings.agents.paths')} value=${path} />`)}</details>`} />`;})}
  </section>`;
}

const providerHref=id=>services.router.href('parametres',{}, {onglet:'connexion',connecteur:id || undefined});
function ProviderBadge({provider}) {
  return html`<span class=${'ao-settings__provider-badge ao-settings__provider-badge--'+provider.status}>${provider.status==='connected'?html`<${Icon} name="check" />`:null}${msg('settings.connection.provider.'+provider.status)}</span>`;
}
function ProjectChips({id,definition,field,value,onChange,disabled}) {
  const [entry,setEntry]=useState('');
  const chips=String(value || '').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  const locked=disabled || field?.editable!==true;
  const name=['include','exclude'].includes(definition.id) ? msg('settings.connection.'+definition.id+'Projects') : settingsLabel(definition.label);
  const add=()=>{const next=entry.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);if(!locked&&next.length){onChange([...new Set([...chips,...next])].join('\n'));setEntry('');}};
  return html`<${SettingRow} id=${id+'-row'} class="ao-settings__field ao-settings__field--chips" label=${name} description=${field?.reason?settingsLabel(field.reason):msg('settings.connection.chipsHint')} control=${html`<div class="ao-settings__chips">
    ${chips.length?html`<ul class="ao-settings__chip-list">${chips.map((chip,index)=>html`<li key=${chip}><span>${chip}</span><${Button} type="button" variant="ghost" size="sm" iconOnly label=${msg('settings.connection.removeProject',{name:chip})} icon=${html`<${Icon} name="close" />`} disabled=${locked} onClick=${()=>onChange(chips.filter((_,i)=>i!==index).join('\n'))} /></li>`)}</ul>`:null}
    <div class="bu-btn-group" onKeyDown=${event=>{if(event.key==='Enter'){event.preventDefault();add();}}}><${TextInput} id=${id} labelledBy=${id+'-row-label'} describedBy=${id+'-row-description'} disabled=${locked} value=${entry} autoComplete="off" spellCheck=${false} onValueChange=${setEntry} onBlur=${add} /><${Button} type="button" size="sm" variant="secondary" disabled=${locked || !entry.trim()} label=${msg('settings.connection.addProject')} onClick=${add} /></div>
  </div>`} />`;
}
export function Connection({vm,draft,providerQuery,target,onChange,onTest,onAutoAdd,onTestHerdr,herdrTest,testResult,disabled,busy,highlightHerdr=false,renderIntegrations,integrationRuntime}) {
  const [prepared,setPrepared]=useState(()=>new Map());
  const herdrCard=useRef(null);
  useEffect(()=>{
    if (!highlightHerdr || !herdrCard.current) return;
    herdrCard.current.scrollIntoView({block:'center',behavior:'instant'});
    herdrCard.current.querySelector('h2')?.focus({preventScroll:true});
  },[highlightHerdr]);
  useEffect(()=>{let live=true;loadPreparedConnectorBrands().then(brands=>{if(live)setPrepared(brands);}).catch(()=>{});return()=>{live=false;};},[]);
  const providers=R.connectionProviders(draft,vm).map(p=>{
    const brand=p.brand?.logo ? p.brand : prepared.get(p.id) || prepared.get(p.id.replace(/-cli$/,'')) || p.brand;
    return {...p,brand,name:brand?.providerName || p.name};
  }),selectedProvider=providerQuery || (highlightHerdr?'herdr':null),provider=R.connectionProvider(providers,selectedProvider);
  const connected=providers.filter(p=>p.status==='connected').length;
  if (!selectedProvider) return html`<header class="ao-settings__providers-heading"><div><span class="ao-settings__providers-eyebrow">${msg('settings.tab.connexion')}</span><h2 id="settings-providers-title" tabindex="-1">${msg('settings.connection.providers')}</h2><p>${msg('settings.connection.providersHint')}</p></div><span class="ao-settings__providers-summary"><span aria-hidden="true"></span>${msg(connected===1?'settings.connection.connectedOne':'settings.connection.connectedCount',{n:connected})}</span></header>
    <div class="ao-settings__providers" aria-labelledby="settings-providers-title">${providers.map(p=>html`<a key=${p.id} class="ao-settings__provider" data-provider=${p.id} href=${providerHref(p.id)}>
      <${ConnectorBrandMark} brand=${p.brand} className="ao-settings__provider-logo" label=${p.name} />
      <span class="ao-settings__provider-copy"><strong>${p.name}</strong><span class="ao-settings__provider-description">${msg(p.kind==='source'?'settings.herdr.description':p.rows.some(r=>r.fields.some(f=>f.type==='url'))?'settings.connection.gatewayDescription':p.rows.some(r=>r.supported)?'settings.connection.localDescription':'settings.connection.unavailableDescription')}</span></span>
      <${ProviderBadge} provider=${p} /><span class="ao-settings__provider-meta"><span>${p.kind==='source'?msg('settings.herdr.source'):msg(p.instances===1?'settings.connection.oneInstance':'settings.connection.instances',{n:p.instances})}</span><span class="ao-settings__provider-action">${msg(p.kind==='source'||p.rows.some(r=>r.supported)?'settings.connection.configure':'settings.connection.discover')}<${Icon} name="arrow-right" /></span></span>
    </a>`)}</div>
    <p class="bu-caption ao-settings__providers-note">${msg('settings.connection.providersNote')}</p>`;
  return html`<a class="ao-settings__provider-back" data-connector-back href=${providerHref()}><${Icon} name="arrow-left" />${msg('settings.connection.back')}</a>
    ${!provider ? html`<p role="status">${msg('settings.connection.unknown')}</p>` : html`<header class="ao-settings__provider-heading"><${ConnectorBrandMark} brand=${provider.brand} className="ao-settings__provider-logo" label=${provider.name} /><div><h2 tabindex="-1" id="settings-provider-title">${provider.name}</h2><p>${msg(provider.kind==='source'?'settings.herdr.description':'settings.connection.providerSettingsHint')}</p></div><${ProviderBadge} provider=${provider} /></header>
      ${renderIntegrations&&provider.kind!=='source'?html`<${TextAction} label=${msg('settings.connection.viewIntegrations')} targetName=${provider.name} href=${services.router.href('parametres',{}, {onglet:'connexion',connecteur:provider.id,section:'integrations',runtime:integrationRuntime || undefined})} />`:null}
      ${provider.kind==='source'?html`<${HerdrConnection} elementRef=${herdrCard} vm=${vm} draft=${draft} onChange=${onChange} onTest=${onTestHerdr} testResult=${herdrTest} disabled=${disabled} busy=${busy} />`:html`<${Intro} tab="connexion" />
        <${ConnectionInstances} vm=${vm} draft=${draft} rows=${provider.rows} target=${target} onChange=${onChange} onTest=${onTest} onAutoAdd=${onAutoAdd} testResult=${testResult} disabled=${disabled} busy=${busy} />
        <a class="ao-settings__provider-back" href=${services.router.href('parametres',{}, {onglet:'agents',connecteur:provider.rows[0].id})}>${msg('settings.connection.manageAgents')}<${Icon} name="arrow-right" /></a>`}
      <section class="ao-settings__group ao-settings__provider-integrations" id="settings-provider-integrations" aria-labelledby="settings-provider-integrations-title">
       <h2 class="bu-heading-sm" id="settings-provider-integrations-title" tabindex="-1">${msg('settings.tab.integrations')}</h2>
       ${renderIntegrations?.(provider)}
      </section>`}`;
}

function HerdrConnection({elementRef,vm,draft,onChange,onTest,testResult,disabled,busy}) {
  const status=testResult?.status || vm.herdr?.status || 'not-checked';
  const statusKey=status==='available' && testResult?.agentCount==null?'settings.herdr.available':'settings.herdr.status.'+status;
  return html`<section ref=${elementRef} class=${'ao-settings__group'+(vm.herdr?.found&&!vm.herdr?.enabled?' ao-settings__group--detected':'')} data-testid="settings-herdr-card" data-runtime-connection="herdr" aria-labelledby="settings-connection-herdr">
    <div class="ao-settings__row"><h2 class="bu-heading-sm" id="settings-connection-herdr" tabindex="-1">${msg('settings.herdr.source')}</h2>
      <${Switch} id="settings-enabled-herdr" testId="settings-herdr-enabled" checked=${!!draft.herdrEnabled} disabled=${disabled || !vm.herdr?.found && !vm.herdr?.enabled}
        label=${msg('settings.connection.enabled')} onCheckedChange=${enabled=>onChange({...draft,herdrEnabled:enabled,herdrTouched:true})} /></div>
    <div class="bu-btn-group"><${Button} type="button" testId="settings-herdr-test" disabled=${disabled || busy} onClick=${onTest} variant="secondary" size="md" label=${msg('settings.herdr.test')} icon=${html`<${Icon} name="plug" />`} /></div>
    <p class="bu-text-secondary" data-testid="settings-herdr-detection">${msg(statusKey,{count:testResult?.agentCount})}</p>
    <p class="bu-caption">${msg('settings.herdr.defaultHint')}</p>
    <p class="bu-caption">${msg('settings.herdr.readOnly')}</p>
  </section>`;
}

function ConnectionInstances({vm, draft, rows, target, onChange, onTest, onAutoAdd, testResult, disabled, busy}) {
  const value=(runtime,id,v) => onChange({...draft,values:{...draft.values,[runtime.id]:{...draft.values[runtime.id],[id]:v}}});
  const secret=(runtime,id,v) => {
    const secrets={...draft.secrets[runtime.id]};
    if (v == null) delete secrets[id]; else secrets[id]=v;
    onChange({...draft,secrets:{...draft.secrets,[runtime.id]:secrets}});
  };
  return html`${rows.map(runtime => html`<section key=${runtime.id} class="ao-settings__group" data-runtime-connection=${runtime.id} data-fix-target=${target === runtime.id ? 'true' : undefined} aria-labelledby=${'settings-connection-' + runtime.id}>
      <div class="ao-settings__row"><h2 class="bu-heading-sm" tabindex="-1" id=${'settings-connection-' + runtime.id}>${draft.names?.[runtime.id] ?? runtime.name}</h2>
        <${Switch} id=${'settings-enabled-'+runtime.id} checked=${!!draft.enabled[runtime.id]} disabled=${disabled||!runtime.supported} label=${msg('settings.connection.enabled')} onCheckedChange=${checked=>onChange({...draft,enabled:{...draft.enabled,[runtime.id]:checked}})} /></div>
      ${!runtime.supported ? html`<p class="bu-text-secondary">${connectorDetectionText(runtime)}</p><p class="bu-caption">${settingsLabel(runtime.reason)}</p>` : html`
        <${SettingsField} id=${'settings-label-' + runtime.id} name=${msg('settings.connection.instanceName')} field=${{editable:true,source:runtime.candidate?'default':'file'}}
          value=${draft.names?.[runtime.id] ?? runtime.name} maxLength="80" disabled=${disabled} onChange=${name=>onChange({...draft,names:{...draft.names,[runtime.id]:name}})} />
        <div class="ao-settings__fields">${runtime.fields.map(f => f.writeOnly
          ? html`<${SecretField} key=${f.id} instance=${runtime.id} definition=${f} field=${runtime.values[f.id]} value=${draft.secrets[runtime.id]?.[f.id]}
            replacing=${Object.hasOwn(draft.secrets[runtime.id] || {},f.id)} disabled=${disabled} onChange=${v => secret(runtime,f.id,v)} />`
          : f.control === 'chips' ? html`<${ProjectChips} key=${f.id} id=${'settings-runtime-' + runtime.id + '-' + f.id} definition=${f} field=${runtime.values[f.id]} value=${draft.values[runtime.id]?.[f.id]} disabled=${disabled} onChange=${v => value(runtime,f.id,v)} />`
          : html`<${SettingsField} key=${f.id} id=${'settings-runtime-' + runtime.id + '-' + f.id} definition=${f} field=${runtime.values[f.id]} value=${draft.values[runtime.id]?.[f.id]} disabled=${disabled} onChange=${v => value(runtime,f.id,v)} />`)}</div>
        <div class="bu-btn-group"><${Button} type="button"  id=${'settings-check-' + runtime.id} disabled=${disabled || busy} onClick=${() => onTest(runtime.id)} variant="secondary" size="md" label=${msg(busy ? 'settings.connection.testing' : 'settings.connection.test')} icon=${html`<${Icon} name="plug" />`} /></div>
        ${runtime.autoAdd && !runtime.candidate && (runtime.enabled ?? runtime.selected) ? html`<${SettingRow} label=${msg('settings.connection.autoAdd')} description=${msg('settings.connection.autoAddHint')} control=${html`<${Switch} id=${'settings-auto-add-'+runtime.id} checked=${runtime.autoAdd.enabled} disabled=${disabled || busy} label=${html`<span class="bu-sr-only">${msg('settings.connection.autoAdd')}</span>`} onCheckedChange=${enabled=>onAutoAdd(runtime.id,enabled)} />`} />` : null}
        <details class="ao-settings__instance-options"><summary>${msg('settings.connection.instanceOptions')}<${Icon} name="arrow-down" /></summary><p class="bu-caption">${msg('settings.connection.disconnectHint')}</p><${Button} type="button" variant="danger" size="sm" disabled=${disabled || !draft.enabled[runtime.id]} label=${msg('settings.connection.disconnect')} onClick=${()=>onChange({...draft,enabled:{...draft.enabled,[runtime.id]:false}})} /></details>
        <${Button} type="button"  testId=${'settings-add-runtime-'+runtime.id} disabled=${disabled || busy || R.connectionRows(draft,vm).filter(r => r.supported && (!r.candidate || draft.enabled[r.id])).length >= 32} onClick=${() => onChange(R.addRuntime(draft, vm, runtime))} variant="secondary" size="sm" label=${msg('settings.connection.add')} icon=${html`<${Icon} name="add" />`} />
        ${testResult?.[runtime.id] ? html`<${SettingsNotice} warning=${!testResult[runtime.id].ok} text=${msg((() => {
          const result=testResult[runtime.id],claude=runtime.adapter==='claude-code';
          if (result.ok) return claude && Number.isSafeInteger(result.projectCount)
            ? result.status==='capacity-limited' ? 'settings.connection.claudeProjectsLimited' : 'settings.connection.claudeProjects'
            : 'settings.connection.ready';
          if (claude && Number.isSafeInteger(result.fileCount) && result.reasonCode) return result.status==='unsupported-format'
            ? 'settings.connection.claudeUnsupported' : result.status==='not-verified' ? 'settings.connection.claudeUnverified' : 'settings.connection.failed';
          return 'settings.connection.failed';
        })(), (() => { const result=testResult[runtime.id]; return !result.ok && runtime.adapter==='claude-code' && Number.isSafeInteger(result.fileCount) && result.reasonCode
          ? {n:result.fileCount,reason:msg(claudeReasonMessageKey(result.reasonCode))} : result.ok && runtime.adapter==='claude-code' && Number.isSafeInteger(result.projectCount) ? {n:result.projectCount} : {}; })())} />` : null}`}
    </section>`)}`;
}

const option=(value,key) => ({value,label:{key}});
export function Instance({vm, draft, onChange, disabled}) {
  const patch=(area,key,value) => onChange({...draft,[area]:{...draft[area],[key]:value}});
  return html`<${Intro} tab="instance" />
    ${vm.instance ? html`<section class="ao-settings__group"><div class="ao-settings__fields">
      ${['name','locale','timeZone'].map(key => html`<${SettingsField} key=${key} id=${'settings-instance-' + key} name=${msg('settings.instance.' + key)}
        definition=${key === 'locale' ? {type:'select',options:[option('fr','settings.locale.fr'),option('en','settings.locale.en')]} : null}
        field=${vm.instance[key]} value=${draft.instance?.[key]??''} maxLength=${key === 'name' ? '80' : undefined} disabled=${disabled} onChange=${value => patch('instance',key,value)} />`)}
    </div></section>` : null}
    ${vm.network ? html`<section class="ao-settings__group" aria-labelledby="settings-network"><h2 class="bu-heading-sm" id="settings-network">${msg('settings.instance.network')}</h2><div class="ao-settings__fields">
      <${SettingsField} id="settings-network-mode" name=${msg('settings.instance.mode')} definition=${{type:'select',options:networkOptions()}}
        field=${vm.network.mode} value=${draft.network?.mode??''} disabled=${disabled} onChange=${value => patch('network','mode',value)} />
      <${SettingsField} id="settings-network-port" name=${msg('settings.instance.port')} definition=${{type:'number'}} field=${vm.network.port} value=${draft.network?.port??''} min="1" max="65535" disabled=${disabled} onChange=${value => patch('network','port',value)} />
      <${SettingsField} id="settings-network-publicUrl" name=${msg('settings.instance.publicUrl')} definition=${{type:'url'}} field=${vm.network.publicUrl} value=${draft.network?.publicUrl??''} disabled=${disabled} onChange=${value => patch('network','publicUrl',value)} />
      <${SettingsField} id="settings-network-host" name=${msg('settings.instance.host')} field=${vm.network.host} value=${vm.network.host.value} disabled />
    </div><p class="bu-caption bu-text-secondary">${msg('settings.instance.active')} : <code class="bu-mono-sm">${vm.network.active.host}:${vm.network.active.port}</code></p></section>` : null}`;
}

export function Account({vm, draft, onChange, disabled}) {
  const identity=(key,value) => onChange({...draft,owner:{...draft.owner,[key]:value}});
  return html`<${Intro} tab="compte" />
    <section class="ao-settings__group"><div class="ao-settings__fields">
      ${['displayName','email'].map(key => html`<${SettingsField} key=${key} id=${'settings-owner-' + key} name=${msg('settings.account.' + key)} field=${vm.owner[key]}
        value=${draft.owner[key]} disabled=${disabled} maxLength=${key === 'displayName' ? '80' : undefined} onChange=${value => identity(key,value)} />`)}
    </div>${vm.owner.reason ? html`<p class="bu-field__hint">${settingsLabel(vm.owner.reason)}</p>` : null}</section>
    <section class="ao-settings__group" aria-labelledby="settings-password-title"><h2 class="bu-heading-sm" id="settings-password-title">${msg('settings.account.password')}</h2>
      <p class="bu-caption bu-text-secondary" id="settings-password-hint">${msg('settings.account.passwordHint')}</p>
      <div class="ao-settings__fields">${[['password','newPassword'],['confirmation','confirmPassword']].map(([key,text])=>html`<${Field} key=${key} id=${'settings-'+key} label=${msg('settings.account.'+text)} control=${props=>html`<${TextInput} ...${props} type="password" autoComplete="new-password" maxLength=${1024} value=${draft[key]} describedBy="settings-password-hint" disabled=${disabled||!vm.owner.passwordChangeEnabled} onValueChange=${value=>onChange({...draft,[key]:value})} />`} />`)}</div>
    </section>`;
}

export function Integrations({vm, plan, runtimes, target = null, onChange, onPlan, disabled, results, canRead=true}) {
  const patch=next => onChange({...plan,...next});
  const supported=(runtimes || vm.runtimes).filter(r => r.supported);
  if(!canRead)return html`<p class="bu-caption">${msg('settings.integrations.noPermission')}</p>`;
  if(!supported.length)return html`<p class="bu-caption">${msg('settings.integrations.providerUnavailable')}</p>`;
  return html`<${Intro} tab="integrations" />
    <div class="ao-settings__fields">
      ${supported.length>1?html`<${Field} id="settings-integration-runtime" label=${msg('settings.connection.instancesLabel')} control=${props=>html`<${Select} ...${props} value=${plan.runtime} disabled=${disabled} options=${supported.map(r=>({value:r.id,label:r.name}))} onValueChange=${runtime=>patch({runtime,result:null,agentIds:[],confirmed:false})} />`} />`:html`<${KeyValue} label=${msg('settings.connection.instancesLabel')} value=${supported[0].name} mono=${false} />`}
      <${Field} id="settings-integration-action" label=${msg('settings.integrations.plan')} control=${props=>html`<${Select} ...${props} value=${plan.action} disabled=${disabled} options=${[{value:'install',label:msg('settings.integrations.install')+' / '+msg('settings.integrations.repair')},{value:'uninstall',label:msg('settings.integrations.uninstall')}]} onValueChange=${action=>patch({action,confirmed:false})} />`} />
    </div>
    <div class="bu-btn-group"><${Button} type="button"  id="settings-plan" disabled=${disabled || !plan.runtime} onClick=${onPlan} variant="secondary" size="md" label=${msg('settings.integrations.plan')} /></div>
    <ul class="ao-settings__list">${vm.agents.filter(a => a.runtime === plan.runtime).flatMap(a => a.integrations.map(i => html`<${ListRow} key=${a.id+i.id} fixTarget=${target===`integration:${a.runtime}:${a.agentId}:${i.id}`} title=${a.name||a.agentId} meta=${i.id} badges=${html`<span class="bu-caption">${msg('settings.integrations.'+i.status)}</span>`} />`))}</ul>
    ${plan.result ? html`<section class="ao-settings__group ao-settings__plan" aria-labelledby="settings-plan-files"><h2 class="bu-heading-sm" id="settings-plan-files">${msg('settings.integrations.files')}</h2>
      ${plan.result.agents.length ? plan.result.agents.map(a => html`<div key=${a.id}>
        <${Checkbox} testId=${'settings-plan-agent-'+a.id} checked=${plan.agentIds.includes(a.id)} disabled=${disabled||['conflict','unsupported'].includes(a.status)} label=${html`<span>${a.id} <span class="bu-caption">${msg('settings.integrations.'+a.status)}</span></span>`} onCheckedChange=${checked=>patch({agentIds:checked?[...plan.agentIds,a.id]:plan.agentIds.filter(id=>id!==a.id),confirmed:false})} />
        <ul class="ao-settings__paths">${(plan.action === 'uninstall' ? a.uninstallFiles : a.files).map(p => html`<li key=${p}><code class="bu-mono-sm">${p}</code></li>`)}</ul>
      </div>`) : html`<p class="bu-text-secondary">${msg('settings.integrations.noChanges')}</p>`}
      <p class="bu-caption ao-settings__backup">${msg('settings.integrations.backup',{path:plan.result.backupDir || '—'})}</p>
      <${Checkbox} id="settings-plan-confirm" checked=${plan.confirmed} disabled=${disabled||!plan.agentIds.length} label=${msg('settings.integrations.confirm')} onCheckedChange=${confirmed=>patch({confirmed})} />
    </section>` : null}
    ${results ? html`<div class=${'bu-banner' + (results.agents.some(a => ['failed','conflict'].includes(a.status)) ? ' bu-banner--warning' : '')} role="status" data-settings-result>
      <${Icon} name="info" /><div class="bu-banner__text"><p>${msg(results.agents.some(a => ['failed','conflict'].includes(a.status)) ? 'settings.integrations.result.partial' : 'settings.integrations.applied')}</p>
      <ul class="ao-settings__paths">${results.agents.map(a => html`<li key=${a.id}>${a.id} · ${a.reason ? settingsLabel(a.reason) : msg('settings.integrations.' + (a.status === 'absent' ? 'missing' : a.status))}
        ${a.backup ? html`<p class="bu-caption ao-settings__backup">${msg('settings.integrations.backup',{path:a.backup})}</p>` : null}</li>`)}</ul></div></div>` : null}
  `;
}
