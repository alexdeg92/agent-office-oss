// Team project composition. All membership, order, counts and labels come from ProjectVM.
import { html,useLayoutEffect,useRef,useState } from '../lib.js';
import { msg, label } from '../i18n.js';
import { Frame, Icon, Ago } from '../components/ui.js';
import { Priority, Avatar } from '../components/project.js';
import { Button,loadStyles as loadBureauStyles } from '../components/bureau/index.js';
import {PreviewButton} from '../components/bureau/popover.js';
import {Modal} from '../components/modal.js';
import { ProjectMemberRow, loadProjectMemberRowStyles } from '../components/project-member-row.js';
import { buildQuery } from '../config.js';
import { chunkError } from '../build-update.js';
import './project-team-messages.js';

let styles;
export function loadStyles() {
  const sheet=styles ||= new Promise((resolve,reject) => {
    const sheet=document.createElement('link');sheet.rel='stylesheet';
    sheet.href=new URL('./project-team.css'+buildQuery,import.meta.url).href;
    sheet.onload=resolve;sheet.onerror=()=>{sheet.remove();styles=null;reject(chunkError(Error('Project stylesheet unavailable')));};
    document.head.append(sheet);
  });
  return Promise.all([sheet,loadBureauStyles(),loadProjectMemberRowStyles()]);
}

export {ProjectSources} from './project-sources.js';
import {ProjectSources} from './project-sources.js';

function TaskColumn({ column }) {
  return html`<section class="ao-team-column" data-task-column=${column.id} aria-label=${label(column.label)}>
    <header><h4>${label(column.label)}</h4><span class="bu-count">${column.count}</span></header>
    <ul class="ao-team-tasks" data-team-column-scroll tabindex="0" aria-label=${label(column.label)}>${column.tasks.map(task=>html`<li key=${task.id}>
      <article class="bu-card ao-team-task" data-team-task=${task.id} data-task-state=${task.state}>
        <div class="ao-team-task__meta">${task.priority ? html`<${Priority} p=${task.priority} />` : null}
          <span class="ao-team-task__owner"><span>${msg('project.team.owner')}</span> ${task.owner?.name || msg('project.team.unassigned')}</span></div>
        <h5>${task.title}</h5>
        ${task.reviewers.map(reviewer=>html`<p key=${reviewer.id} class="ao-team-task__review" data-verdict=${reviewer.verdict}>
          <span>${reviewer.name || reviewer.id}</span><span>${label(reviewer.verdictLabel)}</span>
        </p>`)}
      </article>
    </li>`)}${column.count===0 ? html`<li class="ao-team-empty">${msg('project.team.emptyColumn')}</li>` : null}</ul>
  </section>`;
}

function Member({ member }) {
  const person=member.identity,portrait=member.portrait;
  return html`<${ProjectMemberRow} id=${member.id} name=${person.name} roleLabel=${member.roleLabel}
    parentLabel=${member.parentLabel} parentId=${member.parentId} parentMemberId=${member.parentId} depth=${member.rosterDepth}
    look=${portrait.look} avatarUrl=${portrait.avatarUrl} sourceLabel=${member.source ? label(member.source.label) : null}
    sourceBrand=${member.source?.brand || null} status=${person.status} statusLabel=${label(person.statusLabel)} />`;
}

function People({ roster,heading=true }) {
  // Key lookup only: group memberIds and server depth provide the presentation tree.
  const members=new Map(roster.members.map(member=>[member.id,member]));
  return html`<section class="ao-team-section ao-team-people" aria-labelledby=${heading?"team-people-title":undefined} aria-label=${heading?undefined:msg("project.people")}>
    ${heading?html`<div class="ao-team-section__head"><h3 id="team-people-title">${msg('project.people')}</h3><span>${label(roster.memberCountLabel)}</span></div>`:null}
    ${roster.groups.map(group=>html`<section class="ao-project-roster" key=${group.id} data-roster-group=${group.id} aria-label=${group.label}>
      <ul>${group.memberIds.map(id=>members.has(id) ? html`<${Member} key=${id} member=${members.get(id)} />` : null)}</ul>
    </section>`)}
  </section>`;
}

function Capabilities({ rows=[],id='team-capabilities-title' }) {
  return html`<section class="ao-team-section ao-team-capabilities" aria-labelledby=${id}>
    <h3 id=${id}>${msg('project.team.functions')}</h3>
    <dl>${rows.map(row=>html`<div key=${row.id} data-capability-row=${row.id}>
      <dt>${label(row.label)}</dt><dd>${label(row.valueLabel)}</dd>
    </div>`)}</dl>
  </section>`;
}

export function TeamProjectDetail({ p,back,error,onRetry }) {
  const team=p.teamProject,[dialog,setDialog]=useState(null);
  const boardRef=useRef(null),stageRef=useRef(null),initialized=useRef(null);
  const [visibleColumn,setVisibleColumn]=useState(team.defaultColumnId||null);
  function moveToColumn(id,smooth=false){
    const rail=boardRef.current,column=[...rail.querySelectorAll('[data-task-column]')].find(node=>node.dataset.taskColumn===id);
    if(!column)return;
    rail.scrollTo({left:rail.scrollLeft+column.getBoundingClientRect().left-rail.getBoundingClientRect().left,
      behavior:smooth&&!matchMedia('(prefers-reduced-motion:reduce)').matches?'smooth':'auto'});
  }
  useLayoutEffect(()=>{
    const rail=boardRef.current,phone=matchMedia('(max-width:820px)');
    const initial=()=>{if(phone.matches&&team.defaultColumnId&&initialized.current!==team.teamId){initialized.current=team.teamId;moveToColumn(team.defaultColumnId);}};
    // Selection tracks viewport geometry only. Membership/order/defaults stay in the VM.
    const sync=()=>{
      if(!phone.matches)return;
      const left=rail.getBoundingClientRect().left;let distance=Infinity,visible=null;
      for(const node of rail.querySelectorAll('[data-task-column]')){const d=Math.abs(node.getBoundingClientRect().left-left);if(d<distance){distance=d;visible=node.dataset.taskColumn;}}
      setVisibleColumn(visible);
    };
    initial();sync();rail.addEventListener('scroll',sync,{passive:true});
    const resize=()=>{initial();sync();};phone.addEventListener('change',resize);
    const observer=new ResizeObserver(resize);observer.observe(rail);
    return()=>{rail.removeEventListener('scroll',sync);phone.removeEventListener('change',resize);observer.disconnect();};
  },[team.teamId,team.defaultColumnId]);
  useLayoutEffect(()=>{
    const rail=stageRef.current;if(!rail?.getClientRects().length)return;
    const chip=[...rail.querySelectorAll('[data-stage-choice]')].find(node=>node.dataset.stageChoice===visibleColumn)?.closest('button');
    if(!chip)return;
    const box=chip.getBoundingClientRect(),viewport=rail.getBoundingClientRect();
    if(box.left<viewport.left)rail.scrollLeft+=box.left-viewport.left;
    else if(box.right>viewport.right)rail.scrollLeft+=box.right-viewport.right;
  },[visibleColumn]);
  return html`<${Frame} class="bu-page ao-page ao-project ao-team-project ao-team-project--kanban" bodyClass="ao-frame__body--framed"
    head=${html`<div class="ao-team-project__fixed">
      <div class="ao-team-project__header">
        <a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a>
        <div class="ao-team-project__title"><${ProjectSources} sources=${p.sourceDescriptors} />
          <div class="ao-team-project__heading"><h2>${p.name}</h2>
            ${team.readOnly ? html`<span class="ao-team-readonly"><${Icon} name="info" />${msg('project.team.readonly')}</span>` : null}
          </div>
          <div class="ao-team-project__meta"><span class="bu-pstatus">${label(p.statusLabel)}</span><${Priority} p=${p.priority} />
            <p>${label(team.summaryLabel)}</p><span>${msg('projects.lastActivity')} <${Ago} at=${p.lastActivityAt} /></span>
          </div>
        </div>
        <div class="ao-team-project__actions">
          <${PreviewButton} label=${msg('project.team.sourceAccess')} icon=${html`<${Icon} name="info" />`} onPress=${()=>setDialog('access')}>
            <${Capabilities} rows=${p.capabilityRows} id="team-preview-access-title" />
          </${PreviewButton}>
          <${PreviewButton} label=${msg('project.people')} mobileLabel=${team.mobilePeopleLabel?label(team.mobilePeopleLabel):null} count=${team.roster.memberCount} icon=${html`<${Icon} name="personne" />`} onPress=${()=>setDialog('people')}>
            <h3>${msg('project.people')}</h3><p>${label(team.roster.memberCountLabel)}</p><p>${team.label}</p>
          </${PreviewButton}>
        </div>
      </div>
      ${error ? html`<div class="bu-banner bu-banner--warning" role="status"><span class="bu-banner__text">${msg('common.updateFailed',{error:error.message})}</span><${Button} label=${msg('common.retry')} size="sm" onPress=${onRetry} /></div>` : null}
    </div>`}
    bar=${html`<div ref=${stageRef} class="ao-team-stages" role="group" aria-label=${msg('project.team.tasks')}>
      ${team.columns.map(column=>html`<${Button} key=${column.id} size="sm" pressed=${visibleColumn===column.id} testId=${'team-stage:'+column.id} onPress=${()=>moveToColumn(column.id,true)}>
        <span data-stage-choice=${column.id}>${label(column.label)}</span><span class="bu-count">${column.count}</span>
      </${Button}>`)}
    </div>`}>
    <div ref=${boardRef} class="ao-team-kanban" data-visible-column=${visibleColumn} role="region" aria-label=${msg('project.team.tasks')} tabindex="0">
      ${team.columns.map(column=>html`<${TaskColumn} key=${column.id} column=${column} />`)}
    </div>
    ${dialog?html`<${Modal} title=${dialog==='access'?msg('project.team.sourceAccess'):msg('project.people')} desc=${dialog==='people'?label(team.roster.memberCountLabel):null} onClose=${()=>setDialog(null)} size="md" class=${'ao-team-info-dialog'+(dialog==='people'?' ao-team-info-dialog--people':'')}>
      ${dialog==='access'?html`<${Capabilities} rows=${p.capabilityRows} />`:html`<${People} roster=${team.roster} heading=${false} />`}
    </${Modal}>`:null}
  </${Frame}>`;
}

// Runtime/connector projects use the same supplied sources/capabilities, with
// their server-owned people/activity rows rather than editable local controls.
export function ConnectorProjectDetail({p,back,error,onRetry}) {
  return html`<${Frame} class="bu-page ao-page ao-project ao-team-project ao-source-project" bodyLabel=${msg('project.details')}
    head=${html`<div class="ao-team-project__header"><a class="bu-backlink" href=${back}><${Icon} name="arrow-left"/>${msg('nav.projets')}</a>
      <div class="ao-team-project__title"><${ProjectSources} sources=${p.sourceDescriptors}/><div class="ao-team-project__tags"><span class="bu-pstatus">${label(p.statusLabel)}</span><${Priority} p=${p.priority}/><span class="ao-team-readonly"><${Icon} name="info"/>${msg('project.team.readonly')}</span></div><h2>${p.name}</h2></div></div>`}>
    ${error?html`<div class="bu-banner bu-banner--warning" role="status"><span>${msg('common.updateFailed',{error:error.message})}</span><${Button} label=${msg('common.retry')} onPress=${onRetry}/></div>`:null}
    <p class="bu-banner ao-team-readonly-banner" role="status"><${Icon} name="info"/><span>${msg('project.source.readonlyText')}</span></p>
    <div class="ao-team-project__grid">
      <section class="ao-team-section ao-team-overview"><h3>${msg('project.summary')}</h3><p>${p.summary}</p><dl class="ao-source-project__counts">${['sessions','agents','activity'].map(key=>html`<div key=${key}><dt>${msg('project.source.count.'+key)}</dt><dd data-project-count=${key}>${p.counts[key]??'—'}</dd></div>`)}</dl></section>
      ${p.capabilities.history!=='unsupported'?html`<section class="ao-team-section ao-team-board"><h3>${msg('project.history')}</h3><ul class="ao-source-project__history">${p.recentHistory.map(row=>html`<li key=${row.id} data-activity-id=${row.id}><span>${label(row.text)}</span><${Ago} at=${row.at}/></li>`)}</ul></section>`:null}
      <section class="ao-team-section ao-team-people"><h3>${msg('project.people')}</h3><ul class="ao-project-roster ao-source-project__people">${p.people.map(person=>html`<li key=${person.id} class="ao-project-member" data-source-person=${person.id}><${Avatar} person=${person}/><span class="ao-project-member__copy"><strong>${person.name}</strong>${person.role?html`<span>${person.role}</span>`:null}</span></li>`)}</ul></section>
      <${Capabilities} rows=${p.capabilityRows}/>
    </div>
  </${Frame}>`;
}
