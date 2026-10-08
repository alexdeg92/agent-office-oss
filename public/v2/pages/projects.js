// Projets board (Kanban README; migration-plan.md S15a UI): BoardVM from GET /api/v2/views/projects, kept fresh by the
// `projects` topic. URL: ?filtre=at-risk|with-agent (server filter; 2.x's with-timmy still read), ?q=… (search, view-only),
// ?priorite=Pn (view-only: P0 to Pn, architect-55's P0–P9), ?tri=activite (view-only; the server's order is by priority).
// Moves are optimistic (shown at once, reverted on 409) and have three paths: mouse drag and drop, keyboard
// (Espace / ← → / Espace / Échap), touch long-press (400 ms), and a « Déplacer vers » select on every card (Q01-04).
import { MobileProjects, useSmallProjects } from './projects-mobile.js';
import { assetUrl } from '../config.js';
import { html, Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo } from '../lib.js';
import { useTopic, useCapability } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, agentName } from '../i18n.js';
import { post, toastError } from '../api.js';
import { projectWrite } from '../project-api.js';
import { toast } from '../toast.js';
import { Icon, ErrorState, Ago, Skeleton, StateArt } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { Thumb, Priority, priorityOptions, priorityText, FlagList, AvatarStack } from '../components/project.js';
import { agentFilter, boardFilter } from '../vocab.js';
import { STATUSES, FILTERS, applyOverrides, settledOverrides, findCard, landingIndex, stepStatus, matchesQuery, priorityRank, byActivity } from '../board.js';

const LONG_PRESS_MS = 400;
const statusLabel = (s) => t('projectStatus.' + s);
const enc = encodeURIComponent;

export const boardTopic = (filter) => (filter === 'all' ? 'projects' : `projects?filter=${filter}`);

export function ProjectsPage({ match }) {
  const small = useSmallProjects();
  const { router } = services;
  const filter = (FILTERS.includes(match.query.filtre) && boardFilter(match.query.filtre)) || 'all';
  const q = match.query.q || '';
  const prioMax = priorityOptions().includes(match.query.priorite) ? match.query.priorite : null;   // P0 … prioMax
  const byRecent = match.query.tri === 'activite';
  const narrowed = !!(q || prioMax);
  const topic = boardTopic(filter);
  const vm = useTopic(topic, '/api/v2/views/projects' + (filter === 'all' ? '' : '?filter=' + filter));
  const [overrides, setOverrides] = useState(() => new Map());
  const [drag, setDrag] = useState(null);           // { id, from, over, mode: 'mouse' | 'keyboard' | 'touch' }
  const [announce, setAnnounce] = useState('');
  const [creating, setCreating] = useState(null);   // status preset for « Nouveau projet »
  const writes = useCapability('storeWrites');       // Q03-F09: a read-only store offers no write path that can only 403
  const [arrived, setArrived] = useState(() => new Set());
  const boardRef = useRef(null);
  const prevStatus = useRef(new Map());
  const suppressClick = useRef(false);
  const dragRef = useRef(null);
  dragRef.current = drag;

  useEffect(() => { services.lastBoardUrl = location.pathname + location.search; });

  // Drop optimistic moves once the server's VM shows them; flag cards that someone else moved (an agent) so they arrive visibly.
  useEffect(() => {
    if (!vm.data) return;
    const done = settledOverrides(vm.data.columns, overrides);
    if (done.length) setOverrides((m) => { const n = new Map(m); for (const id of done) n.delete(id); return n; });
    const moved = new Set();
    for (const col of vm.data.columns) for (const c of col.cards) {
      const before = prevStatus.current.get(c.id);
      if (before && before !== col.id && !overrides.has(c.id)) moved.add(c.id);
      prevStatus.current.set(c.id, col.id);
    }
    if (moved.size) { setArrived(moved); setTimeout(() => setArrived(new Set()), 1600); }
  }, [vm.data]);

  const columns = useMemo(() => (vm.data ? applyOverrides(vm.data.columns, overrides) : null), [vm.data, overrides]);

  // Keep keyboard focus on the picked card while it travels between columns.
  useLayoutEffect(() => {
    if (drag && drag.mode === 'keyboard') document.querySelector(`[data-card="${CSS.escape(drag.id)}"]`)?.focus();
  }, [drag && drag.over]);

  async function move(id, from, to, revision, { undo = false } = {}) {
    setDrag(null);
    if (to === from) { setAnnounce(msg('projects.a11y.putBack')); return; }
    const found = columns && findCard(columns, id);
    const name = found ? found.card.name : msg('projects.theProject');
    const expectedRevision = revision ?? (found ? found.card.revision : 0);
    setOverrides((m) => new Map(m).set(id, { status: to, at: Date.now() }));
    setAnnounce(msg('projects.a11y.dropped', { name, stage: statusLabel(to) }));
    const res = await projectWrite({ method: 'PUT', id, path: '/status', body: { status: to }, expectedRevision, topics: [topic],
      success: (data) => ({ level: 'success', message: undo ? msg('projects.toast.undone', { name, stage: statusLabel(to) }) : msg('projects.toast.moved', { stage: statusLabel(to) }),
        action: undo ? null : { label: msg('common.undo'), run: () => move(id, to, from, data.revision, { undo: true }) } }) });
    if (!res.ok) {
      setOverrides((m) => { const n = new Map(m); n.delete(id); return n; });
      setAnnounce(msg('projects.a11y.refused', { name, stage: statusLabel(from) }));
    }
  }

  // ---- keyboard path ----
  function onCardKey(e, card, status) {
    const picked = drag && drag.mode === 'keyboard' && drag.id === card.id;
    if (!writes && (e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); setAnnounce(msg('projects.readonly')); return; }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (picked) move(card.id, drag.from, drag.over);
      else if (!drag) {
        setDrag({ id: card.id, from: status, over: status, mode: 'keyboard' });
        setAnnounce(`${card.name} saisi. Colonne ${statusLabel(status)}. Flèches gauche et droite pour changer de colonne, Espace pour déposer, Échap pour annuler.`);
      }
    } else if (picked && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const over = stepStatus(drag.over, e.key === 'ArrowLeft' ? -1 : 1);
      setDrag({ ...drag, over });
      setAnnounce(msg(over === drag.from ? 'projects.a11y.columnOrigin' : 'projects.a11y.column', { stage: statusLabel(over) }));
    } else if (picked && e.key === 'Escape') {
      e.preventDefault();
      setDrag(null);
      setAnnounce(msg('projects.a11y.cancelled', { name: card.name, stage: statusLabel(drag.from) }));
    } else if (picked && e.key === 'Enter') {
      e.preventDefault();
      move(card.id, drag.from, drag.over);
    }
  }

  // ---- mouse (HTML5 drag and drop) ----
  function onDragStart(e, card, status) {
    if (!writes) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
    // Let the browser snapshot the card before it turns into a ghost.
    setTimeout(() => setDrag({ id: card.id, from: status, over: status, mode: 'mouse' }), 0);
  }
  function onColumnDragOver(e, status) {
    if (!drag || drag.mode !== 'mouse') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drag.over !== status) setDrag({ ...drag, over: status });
  }
  function onColumnDrop(e, status) {
    if (!drag || drag.mode !== 'mouse') return;
    e.preventDefault();
    move(drag.id, drag.from, status);
  }

  // ---- touch: long-press picks the card up, the finger chooses the column, lifting drops it ----
  const press = useRef(null);
  function onPointerDown(e, card, status) {
    if (!writes || e.pointerType !== 'touch' || drag) return;
    const start = { x: e.clientX, y: e.clientY };
    press.current = { start, timer: setTimeout(() => {
      press.current = null;
      suppressClick.current = true;
      if (navigator.vibrate) navigator.vibrate(10);
      setDrag({ id: card.id, from: status, over: status, mode: 'touch' });
      setAnnounce(`${card.name} saisi. Glissez vers une colonne, puis relâchez.`);
    }, LONG_PRESS_MS) };
  }
  function cancelPress(e) {
    if (!press.current) return;
    if (e && e.type === 'pointermove' && Math.hypot(e.clientX - press.current.start.x, e.clientY - press.current.start.y) < 8) return;
    clearTimeout(press.current.timer);
    press.current = null;
  }
  useEffect(() => {
    if (!drag || drag.mode !== 'touch') return;
    const block = (ev) => ev.preventDefault();
    const onMove = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const col = el && el.closest('[data-column]');
      if (col) setDrag((d) => (d && d.over !== col.dataset.column ? { ...d, over: col.dataset.column } : d));
      const b = boardRef.current;
      if (b) { const r = b.getBoundingClientRect(); if (ev.clientX < r.left + 40) b.scrollLeft -= 16; else if (ev.clientX > r.right - 40) b.scrollLeft += 16; }
    };
    const onUp = () => { const d = dragRef.current; if (d) move(d.id, d.from, d.over); else setDrag(null); };
    const onCancel = () => setDrag(null);
    document.addEventListener('touchmove', block, { passive: false });
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    return () => {
      document.removeEventListener('touchmove', block);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    };
  }, [drag && drag.mode, drag && drag.id]);

  // ---- render ----
  if (vm.data === undefined && vm.error) return html`<div class="bu-page"><${ErrorState} error=${vm.error} onRetry=${vm.retry} /></div>`;
  const total = columns ? columns.reduce((n, c) => n + c.count, 0) : 0;
  const boardEmpty = columns && total === 0 && filter === 'all';

  // What each column shows, including the drag preview.
  const view = columns && columns.map((col) => {
    let cards = col.cards;
    let slot = -1;
    if (drag) {
      const found = findCard(columns, drag.id);
      if (found && drag.mode === 'keyboard' && drag.over !== drag.from) {
        const travelling = { ...found.card, lastActivityAt: Date.now() };
        if (col.id === drag.from) cards = cards.filter((c) => c.id !== drag.id);
        if (col.id === drag.over) { cards = cards.slice(); cards.splice(byRecent ? 0 : landingIndex(cards, travelling), 0, travelling); }
      } else if (found && drag.mode !== 'keyboard' && col.id === drag.over && drag.over !== drag.from) {
        slot = byRecent ? 0 : landingIndex(cards, { ...found.card, lastActivityAt: Date.now() });   // a moved card is the most recent
      }
    }
    if (byRecent) cards = cards.slice().sort(byActivity);
    const shown = narrowed ? cards.filter((c) => (!q || matchesQuery(c.name, q)) && (!prioMax || priorityRank(c.priority) <= priorityRank(prioMax))) : cards;
    if (slot > shown.length) slot = shown.length;
    return { ...col, shown, slot };
  });

  const matched = narrowed && view ? view.reduce((n, c) => n + c.shown.length, 0) : null;
  const goTo = (id) => { const el = boardRef.current && boardRef.current.querySelector(`[data-column="${id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); };

  if (small) return html`<${Fragment}><${MobileProjects} view=${view} total=${total} query=${match.query} filter=${filter} prioMax=${prioMax} byRecent=${byRecent} writes=${writes} onCreate=${setCreating} onMove=${move} vm=${vm} announce=${announce} />${creating ? html`<${CreateProject} status=${creating} onClose=${() => setCreating(null)} />` : null}</${Fragment}>`;

  return html`<div class="bu-page ao-projects">
    <div class="bu-toolbar ao-projects__bar">
      <h2 class="bu-title ao-projects__title">${msg('nav.projets')}</h2>${columns ? html`<span class="bu-count">${total}</span>` : null}
      <span class="bu-spacer"></span>
      ${boardEmpty ? null : html`<${Search} value=${q} onChange=${(v) => router.setQuery({ q: v || null })} />
      <div class="ao-scroll-x"><div class="bu-segmented" role="group" aria-label=${msg('projects.filterLabel')}>
        ${[['all', msg('projects.filterAll'), null], ['at-risk', msg('projects.filterAtRisk'), 'warning'], [agentFilter(), msg('projects.filterWithAgent'), 'agent']].map(([v, label, icon]) => html`
          <button key=${v} type="button" class="bu-segmented__opt" aria-pressed=${filter === v ? 'true' : 'false'}
            onClick=${() => router.setQuery({ filtre: v === 'all' ? null : v })}>${icon ? html`<${Icon} name=${icon} />` : null}${label}</button>`)}
      </div></div>
      <${Order} prioMax=${prioMax} byRecent=${byRecent} onChange=${(qs) => router.setQuery(qs)} />
      ${columns ? html`<label class="ao-projects__goto"><span>${msg('projects.goTo')}</span>
        <select class="bu-select bu-input--sm" onChange=${(e) => goTo(e.currentTarget.value)}>
          ${columns.map((c) => html`<option key=${c.id} value=${c.id}>${msg('projects.stageOption', { stage: statusLabel(c.id), n: c.count })}</option>`)}
        </select></label>` : null}`}
      ${writes && !boardEmpty ? html`<a class="bu-btn bu-btn--sm" href=${router.href('importer')}><${Icon} name="import" />${msg('projects.import')}</a>
      <button type="button" class="bu-btn bu-btn--primary bu-btn--sm" onClick=${() => setCreating('idea')}><${Icon} name="add" />${msg('projects.create')}</button>` : null}
    </div>
    ${!writes ? html`<p class="ao-ro bu-caption bu-text-secondary" id="projets-lecture"><${Icon} name="info" />${msg('projects.readonly')}</p>` : null}
    ${matched != null ? html`<p class="bu-caption bu-text-secondary ao-projects__matches" role="status">${q ? msg('projects.matches', { n: matched, q }) : msg('projects.prio.matches', { n: matched, range: prioRange(prioMax) })}</p>` : null}
    <p class="bu-sr-only" id="board-help">${msg('projects.a11y.help')}</p>
    <div class="bu-sr-only" aria-live="assertive" aria-atomic="true">${announce}</div>
    ${vm.error && columns ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${!columns ? html`<${BoardSkeleton} />` : boardEmpty ? html`<${EmptyBoard} writes=${writes} onCreate=${() => setCreating('idea')} importHref=${router.href('importer')} />` : html`
    <div class="bu-board ao-board" ref=${boardRef} aria-busy=${vm.resyncing ? 'true' : undefined}>
      ${view.map((col, ci) => html`<section key=${col.id} class=${'bu-column' + (drag && drag.over === col.id && drag.over !== drag.from ? ' is-drop-target' : '')}
          data-project-status=${col.id} data-column=${col.id} aria-label=${statusLabel(col.id)}
          onDragOver=${(e) => onColumnDragOver(e, col.id)} onDrop=${(e) => onColumnDrop(e, col.id)}>
        <header class="bu-column__head"><span class="bu-dot"></span><h3 class="bu-column__title">${statusLabel(col.id)}</h3>
          <span class="bu-count">${narrowed ? col.shown.length : col.count}</span><span class="bu-spacer"></span>
          ${!writes ? null : html`<button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${msg('projects.addIn', { stage: statusLabel(col.id) })} title=${msg('projects.addIn', { stage: statusLabel(col.id) })} onClick=${() => setCreating(col.id)}><${Icon} name="add" /></button>`}
        </header>
        <ul class="bu-column__list">
          ${col.shown.map((card, i) => html`
            ${col.slot === i ? html`<li key="slot" class="bu-drop-slot" aria-hidden="true"></li>` : null}
            <li key=${card.id}><${Card} card=${card} status=${col.id} writes=${writes} drag=${drag} arrived=${arrived.has(card.id)}
              href=${router.href('projet', { projectId: card.id })}
              onKeyDown=${(e) => onCardKey(e, card, col.id)}
              onDragStart=${(e) => onDragStart(e, card, col.id)} onDragEnd=${() => setDrag((d) => (d && d.mode === 'mouse' ? null : d))}
              onPointerDown=${(e) => onPointerDown(e, card, col.id)} onPointerMove=${cancelPress} onPointerUp=${cancelPress}
              onClick=${(e) => { if (suppressClick.current || (drag && drag.mode === 'keyboard')) { e.preventDefault(); suppressClick.current = false; } }} />
              <${MoveTo} card=${card} status=${col.id} disabled=${!!drag || !writes} onMove=${(to) => move(card.id, col.id, to)} /></li>`)}
          ${col.slot >= col.shown.length ? html`<li key="slot" class="bu-drop-slot" aria-hidden="true"></li>` : null}
          ${!col.shown.length && col.slot < 0 ? html`<li class="bu-column__empty">${msg(narrowed ? 'projects.column.noMatch' : 'projects.column.empty')}</li>` : null}
        </ul>
      </section>`)}
    </div>`}
    ${creating ? html`<${CreateProject} status=${creating} onClose=${() => setCreating(null)} />` : null}
  </div>`;
}

function Card({ card, status, drag, arrived, href, writes = true, ...on }) {
  const isDragged = drag && drag.id === card.id;
  const cls = ['bu-pcard', 'ao-pcard',
    isDragged && drag.mode === 'keyboard' ? 'is-picked is-dragging' : '',
    isDragged && drag.mode !== 'keyboard' ? 'is-ghost' : '',
    arrived ? 'ao-arrived' : ''].filter(Boolean).join(' ');
  return html`<a class=${cls} href=${href} data-card=${card.id} data-project-status=${status} draggable=${writes ? 'true' : 'false'}
      aria-roledescription=${msg('projects.a11y.card')} aria-describedby="board-help" aria-grabbed=${isDragged ? 'true' : undefined}
      onKeyDown=${on.onKeyDown} onDragStart=${on.onDragStart} onDragEnd=${on.onDragEnd} onClick=${on.onClick}
      onPointerDown=${on.onPointerDown} onPointerMove=${on.onPointerMove} onPointerUp=${on.onPointerUp} onContextMenu=${(e) => { if (drag) e.preventDefault(); }}>
    <${Thumb} thumb=${card.thumb} id=${card.id} />
    <div class="bu-pcard__top"><${Priority} p=${card.priority} /><h4 class="bu-pcard__name">${card.name}</h4></div>
    <${FlagList} flags=${card.flags.visible} hiddenCount=${card.flags.hiddenCount} />
    <div class="bu-pcard__foot">
      <${AvatarStack} people=${card.people.visible} hiddenCount=${card.people.hiddenCount} />
      <span class="bu-pcard__when" title=${msg('projects.lastActivity')}><${Ago} at=${card.lastActivityAt} /></span>
    </div>
  </a>`;
}

const prioRange = (p) => (p === 'P0' ? msg('projects.prio.only') : msg('projects.prio.upTo', { p }));

/** Priority filter (P0 to Pn) and sort, both view-only; option text names the control, the label is for screen readers. */
function Order({ prioMax, byRecent, onChange }) {
  const levels = priorityOptions();
  return html`<div class="ao-projects__order">
    <label class="bu-sr-only" for="projets-priorite">${msg('projects.prio.label')}</label>
    <select class="bu-select bu-input--sm" id="projets-priorite" onChange=${(e) => onChange({ priorite: e.currentTarget.value || null })}>
      <option value="" selected=${!prioMax}>${msg('projects.prio.all')}</option>
      ${levels.slice(0, -1).map((p) => html`<option key=${p} value=${p} selected=${p === prioMax}>${prioRange(p)}</option>`)}
    </select>
    <label class="bu-sr-only" for="projets-tri">${msg('projects.sort.label')}</label>
    <select class="bu-select bu-input--sm" id="projets-tri" onChange=${(e) => onChange({ tri: e.currentTarget.value || null })}>
      <option value="" selected=${!byRecent}>${msg('projects.sort.priority')}</option>
      <option value="activite" selected=${byRecent}>${msg('projects.sort.activity')}</option>
    </select>
  </div>`;
}

function Search({ value, onChange }) {
  const [v, setV] = useState(value);
  const timer = useRef(null);
  useEffect(() => setV(value), [value]);
  return html`<div class="bu-input-group ao-projects__search"><${Icon} name="search" />
    <input class="bu-input bu-input--sm" type="search" placeholder=${msg('projects.searchPlaceholder')} aria-label=${msg('projects.searchLabel')} value=${v}
      onInput=${(e) => { setV(e.currentTarget.value); clearTimeout(timer.current); const next = e.currentTarget.value; timer.current = setTimeout(() => onChange(next.trim()), 200); }} />
  </div>`;
}

function EmptyBoard({ writes, onCreate, importHref }) {
  return html`<div class="bu-empty ao-empty-illus">
    <${StateArt} slug="no-projects" />
    <p class="bu-empty__title">${msg('projects.empty.title')}</p>
    <p class="bu-empty__text">${msg('projects.empty.text', { agent: agentName() })}</p>
    ${writes ? html`<div class="bu-btn-group ao-empty-actions">
      <a class="bu-btn bu-btn--primary" href=${importHref}><${Icon} name="import" />${msg('projects.import')}</a>
      <button type="button" class="bu-btn" onClick=${onCreate}><${Icon} name="add" />${msg('projects.create')}</button>
    </div>` : null}
  </div>`;
}

/** The explicit move control (Q01-04): every stage is a destination without drag, long-press or shortcuts. */
function MoveTo({ card, status, disabled, onMove }) {
  return html`<label class="ao-pcard__move"><span>${msg('projects.moveTo')}</span>
    <select class="bu-select bu-input--sm" aria-label=${msg('projects.moveLabel', { name: card.name })} disabled=${disabled}
      onChange=${(e) => { const to = e.currentTarget.value; if (to !== status) onMove(to); }}>
      ${STATUSES.map((st) => html`<option key=${st} value=${st} selected=${st === status}>${statusLabel(st)}</option>`)}
    </select></label>`;
}

function BoardSkeleton() {
  return html`<div class="bu-board ao-board" aria-busy="true" aria-label=${msg('projects.loading')}>
    ${STATUSES.map((s, i) => html`<section key=${s} class="bu-column" data-project-status=${s}>
      <header class="bu-column__head"><span class="bu-dot"></span><h3 class="bu-column__title">${statusLabel(s)}</h3></header>
      <ul class="bu-column__list">${Array.from({ length: 3 - (i % 2) }, (_, k) => html`<li key=${k} class="bu-pcard"><${Skeleton} kind="block" /><${Skeleton} kind="title" /><${Skeleton} w="60" /></li>`)}</ul>
    </section>`)}
  </div>`;
}

function CreateProject({ status, onClose }) {
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
      const r = await post('/api/v2/projects', body, { quiet: true });
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
          <select class="bu-select" id="np-status" name="status">${STATUSES.map((s) => html`<option value=${s} selected=${s === status}>${statusLabel(s)}</option>`)}</select></div>
        <div class="bu-field"><label class="bu-field__label" for="np-priority">${msg('projects.new.priority')}</label>
          <select class="bu-select" id="np-priority" name="priority">${priorityOptions().map((p) => html`<option value=${p} selected=${p === 'P2'}>${priorityText(p)}</option>`)}</select></div>
      </div>
      <div class="bu-field"><label class="bu-field__label" for="np-summary">${msg('projects.new.summary')}</label>
        <textarea class="bu-textarea" id="np-summary" name="summary" maxlength="4000" placeholder=${msg('projects.new.summaryPlaceholder')}></textarea>
        <p class="bu-field__hint">${msg('projects.new.summaryHint')}</p></div>
    </form>
  </${Modal}>`;
}
