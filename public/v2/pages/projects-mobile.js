// Bureau mobile project list, ≤600 px. The page retains the desktop board and its write path.
import { html, useState, useEffect, useLayoutEffect, useRef } from '../lib.js';
import { msg, t } from '../i18n.js';
import { services } from '../services.js';
import { useTopic, runtimeCan } from '../hooks.js';
import { get } from '../api.js';
import { countDiscussion } from './project-count.js';
import { Icon, Ago, ErrorState, Skeleton } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { Priority, PStatus, Avatar, priorityOptions, FlagList } from '../components/project.js';
import { STATUSES, safeImageUrl } from '../board.js';
import { agentFilter } from '../vocab.js';
export function useSmallProjects() {
  const [small,setSmall]=useState(() => matchMedia('(max-width: 600px)').matches);
  useEffect(() => {const m=matchMedia('(max-width: 600px)'),change=() => setSmall(m.matches);m.addEventListener('change',change);return () => m.removeEventListener('change',change);},[]);
  return small;
}
const statusLabel=(s) => t('projectStatus.'+s);
export function MobileProjects({ view, total, query, filter, prioMax, byRecent, writes, onCreate, onMove, vm, announce }) {
  const {router}=services;
  const [mode,setMode]=useState(() => {try {return query.vue==='liste' || (!query.vue && localStorage.getItem('ao.projects.view')==='liste') ? 'liste' : 'tableau';}catch{return 'tableau';}});
  const board=useRef(null);
  const [sheet,setSheet]=useState(null), [card,setCard]=useState(null), [search,setSearch]=useState(query.q || '');
  const timer=useRef(null), searchTimer=useRef(null), suppressed=useRef(false);
  const status=STATUSES.includes(query.etape) ? query.etape : (view?.find((c) => c.id==='in-progress' && c.shown.length) || view?.find((c) => c.shown.length) || view?.[0])?.id;
  const shown=STATUSES.includes(query.etape) ? view?.filter((c) => c.id===query.etape) : view;
  useEffect(() => {if(['tableau','liste'].includes(query.vue))setMode(query.vue);},[query.vue]);
  useLayoutEffect(() => {if(mode!=='tableau' || !board.current || !shown?.length)return;const col=board.current.querySelector('[data-column="'+status+'"]');if(col)board.current.scrollLeft=col.offsetLeft-board.current.firstElementChild.offsetLeft;},[mode,!!view,query.etape]);
  function switchMode(next) {setMode(next);try{localStorage.setItem('ao.projects.view',next);}catch{}router.setQuery({vue:next});}
  function focusColumn(s) {requestAnimationFrame(() => {const col=board.current?.querySelector('[data-column="'+s+'"]');if(col)board.current.scrollTo({left:col.offsetLeft-board.current.firstElementChild.offsetLeft,behavior:'smooth'});});}
  const active=[!!prioMax,byRecent,filter!=='all',STATUSES.includes(query.etape)].filter(Boolean).length;
  useEffect(() => setSearch(query.q || ''),[query.q]);
  useEffect(() => () => {clearTimeout(timer.current);clearTimeout(searchTimer.current);},[]);
  function longPress(e,c) {
    if (!writes || e.pointerType!=='touch') return;
    const {clientX:x,clientY:y}=e;
    clearTimeout(timer.current);
    timer.current=setTimeout(() => {suppressed.current=true;setCard(c);setSheet('move');},450);
    timer.start={x,y};
  }
  function cancelPress(e) {if (!e || e.type!=='pointermove' || Math.hypot(e.clientX-(timer.start?.x || 0),e.clientY-(timer.start?.y || 0))>8) clearTimeout(timer.current);}
  return html`<div class="bu-page ao-projects ao-projects--mobile">
    <header class="ao-projects-mobile__header"><a class="bu-btn bu-btn--ghost bu-btn--icon" aria-label=${msg('nav.bureau')} href=${router.href('bureau')}><${Icon} name="arrow-left" /></a><h1 class="bu-title">${msg('nav.projets')}</h1><span class="bu-count">${total}</span><span class="bu-spacer"></span>
      <button type="button" class="bu-btn bu-btn--ghost bu-btn--icon ao-projects-mobile__filter" aria-label=${msg('projects.mobile.filtersCount',{n:active})} onClick=${() => setSheet('filters')}><${Icon} name="filter" />${active ? html`<span class="bu-count" data-active-filters=${active}>${active}</span>` : null}</button>
      ${writes ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--icon" aria-label=${msg('projects.mobile.more')} onClick=${() => setSheet('more')}><${Icon} name="plus" /></button>` : null}
    </header>
    <div class="ao-projects-mobile__tabs" role="tablist" aria-label=${msg('projects.mobile.view')}>
      ${['tableau','liste'].map((v) => html`<button type="button" role="tab" id=${'projects-tab-'+v} aria-selected=${mode===v ? 'true' : 'false'} aria-controls="projects-mobile-view" tabindex=${mode===v ? 0 : -1} onClick=${() => switchMode(v)} onKeyDown=${(e) => {if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home' ? 'tableau' : e.key==='End' ? 'liste' : mode==='tableau' ? 'liste' : 'tableau';switchMode(next);requestAnimationFrame(() => document.getElementById('projects-tab-'+next)?.focus());}}}>${msg('projects.mobile.'+v)}</button>`)}
    </div>
    <div class="ao-projects-mobile__search"><div class="bu-input-group"><${Icon} name="search" /><input class="bu-input" type="search" aria-label=${msg('projects.searchLabel')} placeholder=${msg('projects.searchPlaceholder')} value=${search} onInput=${(e) => {setSearch(e.currentTarget.value);clearTimeout(searchTimer.current);const q=e.currentTarget.value.trim();searchTimer.current=setTimeout(() => router.setQuery({q:q || null}),200);}} /></div></div>
    ${!writes ? html`<p class="ao-ro bu-caption bu-text-secondary">${msg('projects.readonly')}</p>` : null}
    <div class="bu-sr-only" aria-live="assertive">${announce}</div>
    ${vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!view ? html`<div aria-busy="true"><${Skeleton} kind="title" /><${Skeleton} kind="block" /></div>` : html`
      <div id="projects-mobile-view" role="tabpanel" aria-labelledby=${'projects-tab-'+mode}>
      ${mode==='tableau' ? html`<div class="ao-mobile-board" ref=${board} aria-label=${msg('projects.mobile.tableau')}>
        ${shown.map((col) => html`<section key=${col.id} class="bu-column ao-mobile-column" data-column=${col.id} data-project-status=${col.id} aria-label=${statusLabel(col.id)}>
          <header class="bu-column__head"><span class="bu-dot" aria-hidden="true"></span><h2 class="bu-column__title">${statusLabel(col.id)}</h2><span class="bu-count">${col.shown.length}</span></header>
          <ul class="ao-projects-mobile__list">${col.shown.map((c) => html`<${MobileCard} key=${c.id} c=${c} mode=${mode} writes=${writes} router=${router} open=${() => {setCard(c);setSheet('move');}} longPress=${longPress} cancelPress=${cancelPress} suppressed=${suppressed} />`)}</ul>
          ${!col.shown.length ? html`<p class="bu-column__empty">${msg(query.q || prioMax || filter!=='all' ? 'projects.column.noMatch' : 'projects.column.empty')}</p>` : null}
        </section>`)}
      </div>` : html`<div class="ao-mobile-groups">${shown.map((col) => html`<details key=${col.id} class="bu-card ao-mobile-group" data-column=${col.id} data-project-status=${col.id} open>
        <summary><span class="bu-dot" aria-hidden="true"></span><h2>${statusLabel(col.id)}</h2><span class="bu-count">${col.shown.length}</span><${Icon} name="chevron-right" /></summary>
        <ul class="ao-projects-mobile__list">${col.shown.map((c) => html`<${MobileCard} key=${c.id} c=${c} mode=${mode} writes=${writes} router=${router} open=${() => {setCard(c);setSheet('move');}} longPress=${longPress} cancelPress=${cancelPress} suppressed=${suppressed} />`)}</ul>
        ${!col.shown.length ? html`<p class="bu-caption bu-text-secondary">${msg('projects.column.empty')}</p>` : null}
      </details>`)}</div>`}
      </div>
    `}
    ${writes ? html`<button class="bu-btn bu-btn--primary bu-btn--icon ao-projects-mobile__fab" type="button" aria-label=${msg('projects.create')} onClick=${() => onCreate(status || 'idea')}><${Icon} name="add" /></button>` : null}
    ${sheet==='filters' ? html`<${Filters} query=${query} filter=${filter} prioMax=${prioMax} byRecent=${byRecent} onClose=${() => setSheet(null)} />` : null}
    ${sheet==='more' ? html`<${Modal} title=${msg('projects.mobile.more')} onClose=${() => setSheet(null)}><a class="bu-btn" href=${router.href('importer')}><${Icon} name="import" />${msg('projects.import')}</a><button type="button" class="bu-btn" onClick=${() => {setSheet(null);onCreate(status || 'idea');}}><${Icon} name="add" />${msg('projects.create')}</button></${Modal}>` : null}
    ${sheet==='move' && card ? html`<${Modal} title=${card.name} desc=${msg('projects.moveTo')} onClose=${() => setSheet(null)}><div class="ao-projects-mobile__destinations">${STATUSES.map((s) => html`<button key=${s} class="bu-btn" type="button" disabled=${s===card.status} onClick=${() => {setSheet(null);onMove(card.id,card.status,s,card.revision);focusColumn(s);}}><${PStatus} status=${s} />${s===card.status ? html`<${Icon} name="check" />` : null}</button>`)}</div></${Modal}>` : null}
  </div>`;
}
function MobileCard({c,mode,writes,router,open,longPress,cancelPress,suppressed}) {
  const person=c.people.visible.find((p) => p.kind==='agent') || c.people.visible[0];
  const coverUrl=c.cover?.thumbUrl || (['screenshot','opengraph','cover'].includes(c.thumb.kind) && c.thumb.url);
  return html`<li class=${'bu-card ao-mobile-card ao-mobile-card--'+mode}>
    <a class="ao-mobile-card__link" data-card=${c.id} href=${router.href('projet',{projectId:c.id})} onPointerDown=${(e) => longPress(e,c)} onPointerMove=${cancelPress} onPointerUp=${cancelPress} onPointerCancel=${cancelPress} onContextMenu=${(e) => {if(writes){e.preventDefault();open();}}} onClick=${(e) => {if(suppressed.current){e.preventDefault();suppressed.current=false;}}}>
      ${coverUrl ? html`<${MobileCover} url=${coverUrl} name=${c.name} />` : null}
      <h3 class="ao-mobile-card__title">${c.name}</h3>
      ${mode==='tableau' ? html`<${FlagList} flags=${c.flags.visible} hiddenCount=${c.flags.hiddenCount} />
        <div class="ao-mobile-card__footer"><span class="ao-mobile-card__key"><${Icon} name="projets" />${c.key || c.slug || c.id.replace(/^prj_/,'')}</span><span class="bu-spacer"></span><${CommentCount} card=${c} /><${Priority} p=${c.priority} />${person ? html`<${Avatar} person=${person} size="sm" />` : null}</div>` : html`<div class="ao-mobile-card__meta"><${Priority} p=${c.priority} /><${PStatus} status=${c.status} /><${Ago} at=${c.lastActivityAt} />${person ? html`<${Avatar} person=${person} size="sm" />` : null}</div>`}
    </a>
    ${writes ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--icon ao-mobile-card__more" aria-label=${msg('projects.mobile.cardActions',{name:c.name})} onClick=${open}><${Icon} name="plus" /></button>` : null}
  </li>`;
}
function MobileCover({url,name}) {
  const [failed,setFailed]=useState(null), src=safeImageUrl(url);
  return src && failed!==src ? html`<span class="bu-thumb ao-thumb"><img class="ao-thumb__img" src=${src} alt=${name} width="160" height="90" loading="lazy" decoding="async" onError=${() => setFailed(src)} /></span>` : null;
}
function Count({n}) {
  return html`<span class="ao-mobile-card__comments" data-comment-count=${Number.isInteger(n) ? n : undefined} title=${msg(Number.isInteger(n) ? 'projects.mobile.comments' : 'projects.mobile.commentsUnknown',{n:n || 0})}><${Icon} name="discuter" />${Number.isInteger(n) ? n : '—'}</span>`;
}
function CommentCount({card}) {
  if (Number.isInteger(card.commentCount)) return html`<${Count} n=${card.commentCount} />`;
  return runtimeCan('projectComments') ? html`<${ThreadCount} id=${card.id} />` : html`<${Count} n=${null} />`;
}
function ThreadCount({id}) {
  const url='/api/v2/views/projects/'+encodeURIComponent(id)+'/comments';
  const vm=useTopic('comments:'+encodeURIComponent(id),url), [n,setN]=useState(null);
  useEffect(() => {
    let live=true;setN(null);
    if(vm.data) countDiscussion(vm.data,async (cursor) => (await get(url+'?cursor='+encodeURIComponent(cursor),{quiet:true})).data).then((value) => {if(live)setN(value);},() => {});
    return () => {live=false;};
  },[vm.data]);
  return html`<${Count} n=${n} />`;
}
function Filters({ query, filter, prioMax, byRecent, onClose }) {
  const {router}=services;
  return html`<${Modal} title=${msg('projects.mobile.filters')} onClose=${onClose} footer=${html`<button type="button" class="bu-btn" onClick=${() => {router.setQuery({priorite:null,tri:null,filtre:null,etape:null});onClose();}}>${msg('projects.mobile.reset')}</button><button type="submit" form="mobile-project-filters" class="bu-btn bu-btn--primary">${msg('projects.mobile.apply')}</button>`}>
    <form class="ao-form" id="mobile-project-filters" onSubmit=${(e) => {e.preventDefault();const f=new FormData(e.currentTarget);router.setQuery({priorite:f.get('priorite') || null,tri:f.get('tri') || null,filtre:f.get('filtre') || null,etape:f.get('etape') || null});onClose();}}>
      <div class="bu-field"><label class="bu-field__label" for="mobile-priority">${msg('projects.prio.label')}</label><select class="bu-select" id="mobile-priority" name="priorite" value=${prioMax || ''}><option value="">${msg('projects.prio.all')}</option>${priorityOptions().slice(0,-1).map((p) => html`<option value=${p}>${msg(p==='P0' ? 'projects.prio.only' : 'projects.prio.upTo',{p})}</option>`)}</select></div>
      <div class="bu-field"><label class="bu-field__label" for="mobile-sort">${msg('projects.sort.label')}</label><select class="bu-select" id="mobile-sort" name="tri" value=${byRecent ? 'activite' : ''}><option value="">${msg('projects.sort.priority')}</option><option value="activite">${msg('projects.sort.activity')}</option></select></div>
      <div class="bu-field"><label class="bu-field__label" for="mobile-filter">${msg('projects.filterLabel')}</label><select class="bu-select" id="mobile-filter" name="filtre" value=${filter==='all' ? '' : filter}><option value="">${msg('projects.filterAll')}</option><option value="at-risk">${msg('projects.filterAtRisk')}</option><option value=${agentFilter()}>${msg('projects.filterWithAgent')}</option></select></div>
      <div class="bu-field"><label class="bu-field__label" for="mobile-stage">${msg('projects.new.stage')}</label><select class="bu-select" id="mobile-stage" name="etape" value=${query.etape || ''}><option value="">${msg('projects.mobile.anyStage')}</option>${STATUSES.map((s) => html`<option value=${s}>${statusLabel(s)}</option>`)}</select></div>
    </form>
  </${Modal}>`;
}
