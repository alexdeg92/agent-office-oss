// Bureau mobile project list, ≤600 px. The page retains the desktop board and its write path.
import { html, useState, useEffect, useLayoutEffect, useRef } from '../lib.js';
import { msg, t } from '../i18n.js';
import { services } from '../services.js';
import { useTopic, runtimeCan } from '../hooks.js';
import { get } from '../api.js';
import { countDiscussion } from './project-count.js';
import { Frame, Icon, Ago, ErrorState, Skeleton } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { ListRow, Menu } from '../components/bureau/index.js';
import { Priority, PStatus, Thumb, priorityOptions } from '../components/project.js';
import { STATUSES, compareCards, byActivity } from '../board.js';
import { agentFilter } from '../vocab.js';
export function useSmallProjects() {
  const [small,setSmall]=useState(() => matchMedia('(max-width: 600px)').matches);
  useEffect(() => {const m=matchMedia('(max-width: 600px)'),change=() => setSmall(m.matches);m.addEventListener('change',change);return () => m.removeEventListener('change',change);},[]);
  return small;
}
const statusLabel=(s) => t('projectStatus.'+s);
export function MobileProjects({ view, query, filter, prioMax, byRecent, writes, onCreate, onMove, vm, announce }) {
  const {router}=services;
  const frame=useRef(null), rail=useRef(null), opener=useRef(null);
  const [sheet,setSheet]=useState(null), [card,setCard]=useState(null), [search,setSearch]=useState(query.q || '');
  const timer=useRef(null), searchTimer=useRef(null), suppressed=useRef(false), start=useRef(null);
  const status=STATUSES.includes(query.etape) ? query.etape : 'all';
  const active=[!!prioMax,byRecent,filter!=='all'].filter(Boolean).length;
  const narrowed=!!query.q || !!prioMax || filter!=='all';
  const cards=view && (status==='all' ? view.flatMap(c => c.shown).sort(byRecent ? byActivity : compareCards) : view.find(c => c.id===status)?.shown || []);
  const count=s => !view ? null : s==='all' ? view.reduce((n,c) => n+c.shown.length,0) : view.find(c => c.id===s)?.shown.length || 0;
  useLayoutEffect(() => {const list=frame.current?.querySelector('.ao-projects-mobile__list');if(list)list.scrollTop=0;},[status,query.q,prioMax,byRecent,filter]);
  function revealChoice(element) {
    if (!rail.current || !element) return;
    const r=rail.current.getBoundingClientRect(), c=element.getBoundingClientRect();
    const delta=c.left<r.left ? c.left-r.left : c.right>r.right ? c.right-r.right : 0;
    if(delta)rail.current.scrollLeft+=delta;
  }
  const selectedLabel=status==='all' ? msg('projects.filterAll') : statusLabel(status);
  useLayoutEffect(() => revealChoice(rail.current?.querySelector('[aria-pressed=true]')),[status,selectedLabel,!!view]);
  useEffect(() => setSearch(query.q || ''),[query.q]);
  useEffect(() => () => {clearTimeout(timer.current);clearTimeout(searchTimer.current);},[]);
  function openMove(c,element) {opener.current=element;setCard(c);setSheet('move');}
  function closeMove() {
    setSheet(null);
    requestAnimationFrame(() => {
      const target=opener.current?.isConnected ? opener.current : frame.current?.querySelector('[data-project-choice][aria-pressed=true]');
      target?.focus();
    });
  }
  function longPress(e,c) {
    if (!writes || e.pointerType!=='touch') return;
    suppressed.current=false;
    start.current={x:e.clientX,y:e.clientY};
    clearTimeout(timer.current);
    const element=e.currentTarget;
    timer.current=setTimeout(() => {suppressed.current=true;openMove(c,element);},450);
  }
  function cancelPress(e) {if (!e || e.type!=='pointermove' || Math.hypot(e.clientX-(start.current?.x || 0),e.clientY-(start.current?.y || 0))>8) clearTimeout(timer.current);}
  return html`<div class="ao-projects-mobile-shell"><${Frame} elementRef=${frame} class="bu-page ao-projects ao-projects--mobile" bodyClass="ao-frame__body--framed" bodyLabel=${msg('nav.projets')} bar=${html`
    <div class="ao-projects-mobile__statuses" ref=${rail} role="group" aria-label=${msg('projects.new.stage')} aria-describedby="projects-count-scope">
      ${['all',...STATUSES].map(s => html`<button key=${s} type="button" class="bu-segmented__opt" data-project-choice=${s} aria-pressed=${status===s ? 'true' : 'false'} onFocus=${e => revealChoice(e.currentTarget)} onClick=${e => {revealChoice(e.currentTarget);router.setQuery({etape:s==='all' ? null : s});}}><span>${s==='all' ? msg('projects.filterAll') : statusLabel(s)}</span><span class="bu-count">${count(s) ?? '—'}</span></button>`)}
    </div>
    <div class="ao-projects-mobile__search"><div class="bu-input-group"><${Icon} name="search" /><input class="bu-input" type="search" aria-label=${msg('projects.searchLabel')} placeholder=${msg('projects.searchPlaceholder')} value=${search} onInput=${(e) => {setSearch(e.currentTarget.value);clearTimeout(searchTimer.current);const q=e.currentTarget.value.trim();searchTimer.current=setTimeout(() => router.setQuery({q:q || null}),200);}} /></div>
      <button type="button" class="bu-btn ao-projects-mobile__filter" aria-label=${msg('projects.mobile.filtersCount',{n:active})} onClick=${() => setSheet('filters')}><${Icon} name="filter" />${msg('projects.mobile.filterButton')}${active ? html`<span class="bu-count" data-active-filters=${active}>${active}</span>` : null}</button>
    </div>
    <p id="projects-count-scope" class=${narrowed ? 'bu-caption bu-text-secondary ao-projects-mobile__scope' : 'bu-sr-only'}>${msg('projects.mobile.countScope')}</p>
    ${!writes ? html`<p class="ao-ro bu-caption bu-text-secondary">${msg('projects.readonly')}</p>` : null}
    <div class="bu-sr-only" aria-live="assertive">${announce}</div>
    `}>
    ${vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!view && !vm.error ? html`<div aria-busy="true"><${Skeleton} kind="title" /><${Skeleton} kind="block" /></div>` : null}
    ${cards ? html`<ul class="ao-projects-mobile__list" data-scroll-body tabindex="0" aria-label=${msg('nav.projets')}>${cards.map(c => html`<${MobileCard} key=${c.id} c=${c} writes=${writes} router=${router} open=${element => openMove(c,element)} longPress=${longPress} cancelPress=${cancelPress} suppressed=${suppressed} />`)}</ul>
      ${!cards.length ? html`<p class="bu-empty" role="status">${msg(narrowed ? 'projects.column.noMatch' : 'projects.column.empty')}</p>` : null}` : null}
    ${sheet==='filters' ? html`<${Filters} filter=${filter} prioMax=${prioMax} byRecent=${byRecent} writes=${writes} onClose=${() => setSheet(null)} />` : null}
    ${sheet==='move' && card ? html`<${Modal} title=${card.name} desc=${msg('projects.moveTo')} onClose=${closeMove}><div class="ao-projects-mobile__destinations">${STATUSES.map(s => html`<button key=${s} class="bu-btn" type="button" disabled=${s===card.status} onClick=${async () => {closeMove();await onMove(card.id,card.status,s,card.revision);if(!opener.current?.isConnected)frame.current?.querySelector('[data-project-choice][aria-pressed=true]')?.focus();}}><${PStatus} status=${s} />${s===card.status ? html`<${Icon} name="check" />` : null}</button>`)}</div></${Modal}>` : null}
  </${Frame}>${writes ? html`<button class="bu-btn bu-btn--primary bu-btn--icon ao-projects-mobile__fab" type="button" aria-label=${msg('projects.create')} onClick=${() => onCreate(status==='all' ? 'idea' : status)}><${Icon} name="add" /></button>` : null}</div>`;
}
function MobileCard({c,writes,router,open,longPress,cancelPress,suppressed}) {
  const thumb=c.cover?.thumbUrl ? {...c.thumb,kind:'cover',url:c.cover.thumbUrl} : c.thumb;
  const title=html`<a class="ao-mobile-card__link" data-card=${c.id} href=${router.href('projet',{projectId:c.id})} onPointerDown=${e => longPress(e,c)} onPointerMove=${cancelPress} onPointerUp=${cancelPress} onPointerCancel=${cancelPress} onPointerLeave=${cancelPress} onContextMenu=${e => {if(writes){e.preventDefault();open(e.currentTarget);}}} onClick=${e => {if(suppressed.current){e.preventDefault();suppressed.current=false;}}}><h3 class="ao-mobile-card__title">${c.name}</h3></a>`;
  return html`<${ListRow} class="bu-card ao-mobile-card" avatar=${html`<${Thumb} thumb=${thumb} id=${c.id} showRepo=${false} />`} title=${title}
    meta=${html`<div class="ao-mobile-card__meta"><${Priority} p=${c.priority} /><${PStatus} status=${c.status} /><${CommentCount} card=${c} /><${Ago} at=${c.lastActivityAt} /></div>`}
    actions=${writes ? html`<${Menu} class="ao-mobile-card__more" label=${msg('projects.mobile.cardActions',{name:c.name})} items=${[{id:'move',label:msg('projects.mobile.move'),onSelect:() => open(document.activeElement)}]} />` : null} />`;
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
function Filters({ filter, prioMax, byRecent, writes, onClose }) {
  const {router}=services;
  const [priority,setPriority]=useState(prioMax || ''), [sort,setSort]=useState(byRecent ? 'activite' : ''), [scope,setScope]=useState(filter==='all' ? '' : filter);
  return html`<${Modal} title=${msg('projects.filterLabel')} onClose=${onClose} footer=${html`<button type="button" class="bu-btn" onClick=${() => {router.setQuery({priorite:null,tri:null,filtre:null});onClose();}}>${msg('projects.mobile.reset')}</button><button type="submit" form="mobile-project-filters" class="bu-btn bu-btn--primary">${msg('projects.mobile.apply')}</button>`}>
    <form class="ao-form" id="mobile-project-filters" onSubmit=${(e) => {e.preventDefault();const f=new FormData(e.currentTarget);router.setQuery({priorite:f.get('priorite') || null,tri:f.get('tri') || null,filtre:f.get('filtre') || null});onClose();}}>
      <div class="bu-field"><label class="bu-field__label" for="mobile-priority">${msg('projects.prio.label')}</label><select class="bu-select" id="mobile-priority" name="priorite" value=${priority} onChange=${e => setPriority(e.currentTarget.value)}><option value="">${msg('projects.prio.all')}</option>${priorityOptions().slice(0,-1).map((p) => html`<option value=${p}>${msg(p==='P0' ? 'projects.prio.only' : 'projects.prio.upTo',{p})}</option>`)}</select></div>
      <div class="bu-field"><label class="bu-field__label" for="mobile-sort">${msg('projects.sort.label')}</label><select class="bu-select" id="mobile-sort" name="tri" value=${sort} onChange=${e => setSort(e.currentTarget.value)}><option value="">${msg('projects.sort.priority')}</option><option value="activite">${msg('projects.sort.activity')}</option></select></div>
      <div class="bu-field"><label class="bu-field__label" for="mobile-filter">${msg('projects.filterLabel')}</label><select class="bu-select" id="mobile-filter" name="filtre" value=${scope} onChange=${e => setScope(e.currentTarget.value)}><option value="">${msg('projects.filterAll')}</option><option value="at-risk">${msg('projects.filterAtRisk')}</option><option value=${agentFilter()}>${msg('projects.filterWithAgent')}</option></select></div>

    </form>
    ${writes ? html`<a class="bu-btn" href=${router.href('importer')}><${Icon} name="import" />${msg('projects.import')}</a>` : null}
  </${Modal}>`;
}
