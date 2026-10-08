// Project detail (ProjectHeader README): ProjectVM from GET /api/v2/views/projects/:id, kept fresh by `project:<id>`.
// Desktop: summary + history on the left, repository + people + flags in the aside. Mobile: one column in README order.
// All copy in the registry (project.*), fr and en; every write control follows capabilities.storeWrites (Q03-F09).
import { html, Fragment, useState, useEffect, useRef } from '../lib.js';
import { useTopic, useNow, useCapability, runtimeCan } from '../hooks.js';
import { services } from '../services.js';
import { t, label, msg } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Comments } from './project-comments.js';
import { sessionRow, historyItems } from './project-history.js';
import { ConversationPreview } from '../components/conversation.js';
import { useSmallProjects } from './projects-mobile.js';
import { Modal } from '../components/modal.js';
import { pendingSummary } from './project-thread.js';
import { useOrder, OrderToggle } from '../components/order.js';
import { get } from '../api.js';
import { projectWrite } from '../project-api.js';
import { toast } from '../toast.js';
import { Icon, EmptyState, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { Thumb, Priority, priorityOptions, priorityText, PStatus, Flag, FlagList, Avatar, AvatarStack, StateBadge } from '../components/project.js';
import { STATUSES, labelTone } from '../board.js';

const enc = encodeURIComponent;
const statusLabel = (s) => t('projectStatus.' + s);

/** Every write goes through projectWrite (expectedRevision + one 409 path); this binds the page's project and topic. */
const writer = (p, topic) => (method, path, body, success) =>
  projectWrite({ method, id: p.id, path, body, expectedRevision: p.revision, topics: [topic], success });

export function ProjectPage({ match }) {
  const { router } = services;
  const id = match.params.projectId;
  const topic = 'project:' + id;
  const vm = useTopic(topic, '/api/v2/views/projects/' + enc(id));
  const back = services.lastBoardUrl || router.href('projets');

  useEffect(() => { if (vm.data) document.title = vm.data.name + ' · ' + msg('nav.projets') + ' · Agent Office'; }, [vm.data && vm.data.name]);

  if (vm.data === undefined && vm.error) {
    return html`<div class="bu-page ao-frame ao-frame--detail">
      <a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a>
      ${vm.error.code === 'not_found'
        ? html`<${EmptyState} icon="projets" title=${msg('project.notFound')} text=${msg('project.notFound.text')}><a class="bu-btn" href=${back}>${msg('project.backToBoard')}</a></${EmptyState}>`
        : html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`}
    </div>`;
  }
  if (vm.data === undefined) return html`<${DetailSkeleton} back=${back} />`;
  const p = vm.data;
  const ctx = { p, topic, id, writes: useCapability('storeWrites') };

  return html`<div class="bu-page ao-frame ao-project" aria-busy=${vm.resyncing ? 'true' : undefined}>
    <a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a>
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${!ctx.writes ? html`<p class="ao-ro bu-caption bu-text-secondary" id="projet-lecture"><${Icon} name="info" />${msg('project.readonly')}</p>` : null}
    ${p.archived ? html`<div class="bu-banner"><${Icon} name="info" /><span class="bu-banner__text">${msg('project.archived')}</span></div>` : null}
    <div class="ao-project__grid">
      <div class="ao-project__col ao-project__col--main">
        <${Header} ...${ctx} />
        <${CoverActions} ...${ctx} />
        <${Summary} ...${ctx} />
        <${Comments} ...${ctx} />
        <${History} ...${ctx} />
      </div>
      <aside class="ao-project__col ao-project__col--aside" aria-label=${msg('project.details')}>
        <${Repo} ...${ctx} />
        <${People} people=${p.people} />
        <${Flags} ...${ctx} />
      </aside>
    </div>
  </div>`;
}

function Header({ p, topic, id, writes }) {
  const [moving, setMoving] = useState(false);
  const [statusSheet,setStatusSheet] = useState(false);
  const small = useSmallProjects();
  // Status, priority and the risks lead; labels and features live in the flags section (explorer-qa-02 Q02-07).
  const flags = p.flags.filter((f) => f.kind === 'risk');
  const stack = orderPeople(p.people);
  const write = writer(p, topic);
  async function moveTo(to) {
    if (!to || to === p.status) return;
    const from = p.status;
    setMoving(true);
    await write('PUT', '/status', { status: to }, (data) => ({ level: 'success', message: msg('projects.toast.moved', { stage: statusLabel(to) }), action: { label: msg('common.undo'),
      run: () => projectWrite({ method: 'PUT', id: p.id, path: '/status', body: { status: from }, expectedRevision: data.revision, topics: [topic], success: msg('project.moveUndone', { stage: statusLabel(from) }) }) } }));
    setMoving(false);
  }
  return html`<${Fragment}><header class="bu-project-header">
    <${Thumb} thumb=${p.thumb} id=${p.id} size="lg" />
    <div class="bu-project-header__body">
      <div class="ao-project__chips">${small ? html`<button type="button" class="bu-btn bu-btn--sm ao-project-status" disabled=${!writes || moving} aria-label=${statusLabel(p.status) + ' : ' + msg('project.mobile.status')} onClick=${() => setStatusSheet(true)}><${PStatus} status=${p.status} /><${Icon} name="arrow-down" /></button>` : html`<${PStatus} status=${p.status} />`}<${Priority} p=${p.priority} /><${FlagList} flags=${flags} /></div>
      <h2 class="bu-project-header__title">${p.name}</h2>
      <div class="bu-project-header__meta">
        ${stack.length ? html`<${AvatarStack} people=${stack.slice(0, 4)} hiddenCount=${Math.max(0, stack.length - 4)} size=${null} hiddenNames=${stack.slice(4).map((x) => x.name).join(', ')} />` : null}
        <span>${msg('project.peopleCount', { n: stack.length })}</span>
        <span>${msg('projects.lastActivity')} <${Ago} at=${p.lastActivityAt} /></span>
      </div>
      <div class="bu-btn-group ao-project__actions">
        <label class="bu-sr-only" for="move-to">${msg('project.moveTo')}</label>
        <select class="bu-select ao-move" id="move-to" disabled=${moving || !writes} aria-busy=${moving ? 'true' : undefined}
          onChange=${(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; moveTo(v); }}>
          <option value="" selected>${msg('project.moveTo')}</option>
          ${STATUSES.filter((s) => s !== p.status).map((s) => html`<option value=${s}>${statusLabel(s)}</option>`)}
        </select>
        ${p.repo ? html`<a class="bu-btn" href=${p.repo.url} target="_blank" rel="noopener"><${Icon} name="external" />${msg('project.openRepo')}</a>` : null}
        <a class="bu-btn bu-btn--ghost" href="#drapeaux" onClick=${(e) => { e.preventDefault(); const el = document.getElementById('drapeaux'); el?.scrollIntoView({ block: 'start' }); el?.focus({ preventScroll: true }); }}><${Icon} name="drapeau" />${msg('project.manageFlags')}</a>
      </div>
    </div>
  </header>${statusSheet ? html`<${Modal} title=${msg('project.moveTo')} onClose=${() => setStatusSheet(false)}><div class="ao-projects-mobile__destinations">${STATUSES.map((s) => html`<button class="bu-btn" type="button" disabled=${s===p.status || moving} onClick=${() => {setStatusSheet(false);moveTo(s);}}><${PStatus} status=${s} />${s===p.status ? html`<${Icon} name="check" />` : null}</button>`)}</div></${Modal}>` : null}</${Fragment}>`;
}

function CoverActions({ p, topic, writes }) {
  const [busy, setBusy] = useState(false);
  async function regenerate() {
    setBusy(true);
    try { await writer(p, topic)('POST', '/cover/regenerate', {}, msg('project.cover.requested')); }
    finally { setBusy(false); }
  }
  async function upload(e) {
    const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('image');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
      const context = canvas.getContext('2d'), ratio = Math.max(480 / bitmap.width, 270 / bitmap.height);
      context.drawImage(bitmap, (480 - bitmap.width * ratio) / 2, (270 - bitmap.height * ratio) / 2, bitmap.width * ratio, bitmap.height * ratio); bitmap.close();
      const image = canvas.toDataURL('image/webp', 0.45).split(',')[1];
      if (image.length > 65536) throw new Error('image-size');
      await writer(p, topic)('PUT', '/cover', { image }, msg('project.cover.saved'));
    } catch (_) { toast({ level: 'error', message: msg('project.cover.invalid') }); }
    finally { setBusy(false); }
  }
  if (!writes) return null;
  return html`<div class="bu-btn-group ao-cover-actions" aria-busy=${busy ? 'true' : undefined}>
    <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" disabled=${busy || p.cover?.source === 'upload'} onClick=${regenerate}><${Icon} name="refresh" />${msg('project.cover.regenerate')}</button>
    <label class="bu-btn bu-btn--ghost bu-btn--sm" for=${'cover-upload-' + p.id}><${Icon} name="add" />${msg('project.cover.upload')}</label>
    <input class="bu-sr-only" id=${'cover-upload-' + p.id} type="file" accept="image/png,image/jpeg,image/webp" disabled=${busy} onChange=${upload} />
    ${p.cover?.source === 'upload' ? html`<span class="bu-caption bu-text-secondary">${msg('project.cover.manual')}</span>` : null}
  </div>`;
}

const KIND_ORDER = { human: 0, agent: 1, git: 2 };
function orderPeople(people) {
  // Grouped by kind; within a kind the server's order is kept (it puts the primary agent first).
  return people.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// ---- Résumé ----
function Summary({ p, topic, id, writes }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const openclawWrites = useCapability('openclawWrites');
  const askAllowed = writes && openclawWrites && runtimeCan('projectComments');
  const thread = useTopic('comments:' + enc(id), '/api/v2/views/projects/' + enc(id) + '/comments');
  const waiting = asking || pendingSummary(thread.data?.items || []);
  async function ask() {
    setAsking(true);
    await writer(p, topic)('POST', '/summary/regenerate', {}, msg('project.summary.requested'));
    setAsking(false);
  }
  const askButton = html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" disabled=${!askAllowed || waiting} aria-busy=${waiting ? 'true' : undefined} onClick=${ask}><${Icon} name="agent" />${msg(waiting ? 'project.summary.pending' : 'project.summary.ask')}</button>`;
  const text = p.summary || '';
  const meta = p.summaryMeta;
  async function save(e) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('summary') || '');
    setBusy(true);
    const res = await writer(p, topic)('PATCH', '', { summary: value }, msg('project.summary.saved'));
    setBusy(false);
    if (res.ok) setEditing(false);
  }
  return html`<section class="bu-card ao-section" aria-labelledby="resume">
    <div class="ao-section__head"><h3 class="bu-card__title" id="resume">${msg('project.summary')}</h3><span class="bu-spacer"></span>
      ${!editing && text && writes ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" onClick=${() => setEditing(true)}><${Icon} name="pencil" />${msg('project.edit')}</button>` : null}</div>
    ${editing ? html`<form class="ao-form" onSubmit=${save}>
        <label class="bu-sr-only" for="summary-input">${msg('project.summary.label')}</label>
        <textarea class="bu-textarea ao-summary-input" id="summary-input" name="summary" maxlength="4000" autofocus>${text}</textarea>
        <div class="bu-btn-group"><button type="submit" class="bu-btn bu-btn--primary bu-btn--sm" disabled=${busy} aria-busy=${busy ? 'true' : undefined}>${msg('common.save')}</button>
          <button type="button" class="bu-btn bu-btn--sm" onClick=${() => setEditing(false)}>${msg('common.cancel')}</button></div>
      </form>`
    : text ? html`<div class="bu-summary">
        <div class="bu-btn-group" data-write-actions>${askButton}</div>
        ${text.split(/\n{2,}/).map((para, i) => html`<p key=${i} class="bu-summary__text">${para}</p>`)}
        ${meta ? html`<div class="bu-summary__source">
          <${Avatar} person=${meta.author.kind === 'system' ? { id: 'system', kind: 'human', name: meta.author.name, avatarUrl: null, state: null } : meta.author} size="sm" />
          <span>${msg('project.summary.by', { name: meta.author.name })} · <${Ago} at=${meta.at} /></span>
        </div>` : null}
      </div>`
    : html`<div class="bu-empty bu-empty--compact"><p class="bu-empty__text">${msg('projects.summaryMissing')}</p>
        ${writes ? html`<div class="bu-btn-group"><button type="button" class="bu-btn bu-btn--sm" onClick=${() => setEditing(true)}><${Icon} name="pencil" />${msg('project.summary.write')}</button>
          ${askButton}</div>` : null}</div>`}
  </section>`;
}

// ---- Historique ----
const HISTORY_CLASS = { status: 'status', commit: 'commit', 'flow-run': 'flow', 'cron-run': 'cron', session: 'session', 'risk-raised': 'risk', 'risk-cleared': 'risk',
  'risk-acked': 'flag', 'risk-unacked': 'flag', 'flag-added': 'flag', 'flag-removed': 'flag', 'agent-action': 'agent', priority: 'status', renamed: 'status' };
const HISTORY_ICON = { status: 'arrow-right', commit: 'commit', 'flow-run': 'flux', 'cron-run': 'clock', session: 'discuter', 'risk-raised': 'alert', 'risk-cleared': 'success',
  'risk-acked': 'check', 'risk-unacked': 'alert', 'flag-added': 'drapeau', 'flag-removed': 'drapeau', 'agent-action': 'agent', 'project-created': 'add',
  'summary-edited': 'pencil', 'source-linked': 'link', 'source-unlinked': 'link', priority: 'arrow-right', renamed: 'pencil' };

function HistoryWhen({ at }) {
  const now = useNow(30_000);
  return html`<time class="bu-history__when" datetime=${new Date(at).toISOString()} title=${fmt.dateTime(at, now)}>${now - at < 48 * 3_600_000 ? fmt.relative(at, now) : fmt.date(at, now)}</time>`;
}

/** Bolds the actor's name when the sentence starts with it (HistoryTimeline README: actor first, names bold). */
function Sentence({ text, actor }) {
  // The actor is HistoryItemVM.actor, not a param (project-vm.json): it fills `{actor}` in the label.
  const s = label({ key: text.key, params: { actor: actor && actor.name ? actor.name : '', ...(text.params || {}) } });
  if (actor && actor.name && actor.kind !== 'system' && s.startsWith(actor.name + ' ')) return html`<b>${actor.name}</b>${s.slice(actor.name.length)}`;
  return s;
}

function SessionHistory({ event }) {
  const [open, setOpen] = useState(false);
  const row = sessionRow(event);
  const href = row.key ? services.router.href('session', { sessionKey: row.key }) : null;
  const previewId = 'conversation-' + event.id;
  const content = html`<b class="ao-history-session__who">${row.who}</b>
    ${row.people ? html`<span class="ao-history-session__people">${row.people}${row.channel ? ' · ' + row.channel : ''}</span>` : null}
    <span class="ao-history-session__summary">${row.summary}</span><span class="bu-caption bu-text-secondary">${row.messages}${row.tokens ? ' · ' + row.tokens : ''}</span>
    <${HistoryWhen} at=${event.at} />
    ${href ? html`<span class="ao-history-session__cta">${msg('project.history.open')}<${Icon} name="chevron-right" /></span>` : null}`;
  return html`<div class="ao-history-conversation">${href ? html`<a class="ao-history-session" href=${href}>${content}</a>` : html`<div class="ao-history-session">${content}</div>`}
    ${href ? html`<button type="button" class="ao-history-disclosure" aria-expanded=${String(open)} aria-controls=${previewId} onClick=${() => setOpen(!open)}>
      <${Icon} name="chevron-right" />${msg('project.history.preview')}</button>
      <div id=${previewId} hidden=${!open}>${open ? html`<${ConversationPreview} sessionKey=${row.key} href=${href} />` : null}</div>` : null}
  </div>`;
}

function History({ p, id }) {
  const [order, setOrder] = useOrder('history', 'desc');
  const [extra, setExtra] = useState({ events: [], cursor: undefined, loading: false });
  useEffect(() => setExtra({ events: [], cursor: undefined, loading: false }), [id]);
  const first = p.recentHistory;
  const seen = new Set(first.map((e) => e.id));
  const events = first.concat(extra.events.filter((e) => !seen.has(e.id)));
  const cursor = extra.cursor === undefined ? p.historyNextCursor : extra.cursor;
  async function more() {
    setExtra((x) => ({ ...x, loading: true }));
    try {
      const r = await get(`/api/v2/views/projects/${enc(id)}/history?cursor=${enc(cursor)}`);
      setExtra((x) => ({ events: x.events.concat(r.data.items), cursor: r.data.nextCursor, loading: false }));
    } catch { setExtra((x) => ({ ...x, loading: false })); }
  }
  const loadMore = cursor ? html`<button type="button" class="bu-btn bu-btn--sm ao-more" onClick=${more} disabled=${extra.loading} aria-busy=${extra.loading ? 'true' : undefined}>${msg('common.showMore')}</button>` : null;
  return html`<section class="bu-card ao-section ao-section--history" aria-labelledby="historique">
    <div class="ao-section__head"><h3 class="bu-card__title" id="historique">${msg('project.history')}</h3><span class="bu-count">${events.length}${cursor ? '+' : ''}</span><${OrderToggle} view="history" order=${order} onChange=${setOrder} /></div>
    ${order === 'asc' ? loadMore : null}
    ${events.length ? html`<ol class="bu-history">
      ${historyItems(events, order).map((e) => html`<li key=${e.id} data-history-at=${e.at} class=${'bu-history__item' + (HISTORY_CLASS[e.kind] ? ' bu-history__item--' + HISTORY_CLASS[e.kind] : '')}>
        <span class="bu-history__icon"><${Icon} name=${HISTORY_ICON[e.kind] || 'info'} /></span>
        ${e.kind === 'session' ? html`<${SessionHistory} event=${e} />` : html`<div><p class="bu-history__text"><${Sentence} text=${e.text} actor=${e.actor} /></p><${HistoryWhen} at=${e.at} /></div>`}
      </li>`)}
    </ol>` : html`<p class="bu-text-secondary">${msg('project.history.empty')}</p>`}
    ${order === 'desc' ? loadMore : null}
  </section>`;
}

// ---- Dépôt ----
const CI = { passing: ['success', 'success', 'project.ci.passing'], running: ['info', 'refresh', 'project.ci.running'], failing: ['danger', 'error', 'project.ci.failing'], none: [null, 'info', 'project.ci.none'], unrecognized: ['warning', 'warning', 'project.ci.unknown'] };
const SOURCE_ICON = { github: 'branche', workspace: 'folder', sessionGroup: 'journaux', manual: 'pencil' };
const sourceText = (s) => (s.kind === 'manual' ? msg('project.source.manual') : s.label);

function Repo({ p, topic, id, writes }) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const r = p.repo;
  async function link(e) {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('repo') || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(v);
    if (!m) { setError(msg('project.repo.format')); return; }
    setError(null);
    const res = await writer(p, topic)('POST', '/sources', { source: { kind: 'github', ref: { owner: m[1], repo: m[2] } } }, msg('project.repo.linked'));
    if (res.ok) setLinking(false);
  }
  // A just-linked repo may not be fetched yet (review-03): branch, CI and commits can be missing.
  const commits = (r && r.commits) || [];
  const [tone, icon, ciKey] = r ? CI[(r.ci && r.ci.state) || 'none'] || CI.unrecognized : [];
  return html`<section class="bu-card ao-section ao-section--repo" aria-labelledby="depot">
    <div class="ao-section__head"><h3 class="bu-card__title" id="depot">${msg('project.repo')}</h3></div>
    ${r && r.state === 'pending' ? html`<div class="bu-banner" role="status"><span class="bu-spinner" aria-hidden="true"></span><span class="bu-banner__text">${msg('project.repo.pending')}</span></div>` : null}
    ${r && r.state === 'error' ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${r.lastError ? msg('project.repo.errorReason', { reason: { lower: { key: 'sourceError.' + r.lastError } } }) : msg('project.repo.error')}</span></div>` : null}
    ${r ? html`
      <a class="bu-repo__link" href=${r.url} target="_blank" rel="noopener"><${Icon} name="branche" />${r.owner}/${r.name}<${Icon} name="external" /></a>
      <dl class="bu-kv">
        <div class="bu-kv__row"><dt>${msg('project.repo.branch')}</dt><dd>${r.defaultBranch ? html`<span class="bu-tag">${r.defaultBranch}</span>` : '—'}</dd></div>
        <div class="bu-kv__row"><dt>${msg('project.repo.ci')}</dt><dd><span class=${'bu-chip bu-chip--sm' + (tone ? ' bu-chip--' + tone : '')}><${Icon} name=${icon} />${msg(ciKey)}</span></dd></div>
        <div class="bu-kv__row"><dt>${msg('project.repo.lastCommit')}</dt><dd>${commits.length ? html`<${Ago} at=${commits[0].at} />` : '—'}</dd></div>
      </dl>
      ${commits.length ? html`<ul class="bu-commits">
        ${commits.slice(0, 5).map((c) => html`<li key=${c.sha} class="bu-commit">
          <a class="bu-commit__sha" href=${`${r.url}/commit/${c.sha}`} target="_blank" rel="noopener" title=${msg('project.repo.viewCommit')}>${c.sha.slice(0, 7)}</a>
          <span class="bu-commit__msg" title=${c.message}>${c.message}</span>
          <span class="bu-commit__meta">${c.author} · <${Ago} at=${c.at} /></span>
        </li>`)}
      </ul>
      <a class="bu-card__more" href=${r.defaultBranch ? `${r.url}/commits/${enc(r.defaultBranch)}` : `${r.url}/commits`} target="_blank" rel="noopener">${msg('project.repo.allCommits')}<${Icon} name="arrow-right" /></a>` : html`<p class="bu-caption bu-text-tertiary">${msg('project.repo.noCommits')}</p>`}`
    : linking ? html`<form class="ao-form" onSubmit=${link} novalidate>
        <div class="bu-field"><label class="bu-field__label" for="repo-input">${msg('project.repo.github')}</label>
          <input class="bu-input" id="repo-input" name="repo" placeholder=${msg('project.repo.placeholder')} autocomplete="off" autofocus aria-invalid=${error ? 'true' : undefined} aria-describedby=${error ? 'repo-err' : undefined} />
          ${error ? html`<p class="bu-field__error" id="repo-err"><${Icon} name="alert" />${error}</p>` : null}</div>
        <div class="bu-btn-group"><button type="submit" class="bu-btn bu-btn--primary bu-btn--sm">${msg('project.repo.link')}</button><button type="button" class="bu-btn bu-btn--sm" onClick=${() => setLinking(false)}>${msg('common.cancel')}</button></div>
      </form>`
    : html`<div class="bu-empty bu-empty--compact"><p class="bu-empty__text">${msg('project.repo.none')}</p>
        ${writes ? html`<button type="button" class="bu-btn bu-btn--sm" onClick=${() => setLinking(true)}><${Icon} name="link" />${msg('project.repo.linkGithub')}</button>` : null}</div>`}
    <div class="ao-sources">
      <h4 class="bu-eyebrow">${msg('project.sources')}</h4>
      <ul class="ao-sources__list">${p.sources.map((s) => html`<li key=${s.id} class="bu-source"><${Icon} name=${SOURCE_ICON[s.kind] || 'link'} />${sourceText(s)}</li>`)}</ul>
    </div>
  </section>`;
}

// ---- Personnes impliquées ----
function People({ people }) {
  const groups = [
    ['human', msg('project.people.humans'), people.filter((x) => x.kind === 'human')],
    ['agent', msg('project.people.agents'), orderPeople(people.filter((x) => x.kind === 'agent'))],
    ['git', msg('project.people.git'), people.filter((x) => x.kind === 'git')],
  ].filter(([, , list]) => list.length);
  return html`<section class="bu-card ao-section ao-section--people" aria-labelledby="personnes">
    <div class="ao-section__head"><h3 class="bu-card__title" id="personnes">${msg('project.people')}</h3><span class="bu-count">${people.length}</span></div>
    ${groups.length ? groups.map(([kind, title, list]) => html`<div key=${kind} class="bu-people__group">
      <h4 class="bu-eyebrow">${title}</h4>
      <ul class="bu-people">${list.map((x) => html`<li key=${x.id} class="bu-person">
        <${Avatar} person=${x} />
        <span class="ao-person__text"><span class="bu-person__name">${x.name}</span>${x.role ? html`<span class="bu-person__role">${x.role}</span>` : null}</span>
        ${kind === 'agent' && x.state ? html`<${StateBadge} state=${x.state} />`
          : kind === 'git' && x.commitCount != null ? html`<span class="bu-mono-sm bu-text-tertiary">${msg('project.people.commits', { n: x.commitCount })}</span>` : null}
      </li>`)}</ul>
    </div>`) : html`<p class="bu-text-secondary">${msg('project.people.none')}</p>`}
  </section>`;
}

// ---- Drapeaux ----
function Flags({ p, topic, id, writes }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(null);
  const by = (k) => p.flags.filter((f) => f.kind === k);
  const risks = by('risk'), features = by('feature'), labels = by('label');
  const blocked = risks.some((f) => f.key === 'blocked');
  const write = writer(p, topic);
  const run = async (key, method, path, body, success) => { setBusy(key); const res = await write(method, path, body, success); setBusy(null); return res; };

  return html`<section class="bu-card ao-section ao-section--flags" id="drapeaux" tabindex="-1" aria-labelledby="drapeaux-titre">
    <div class="ao-section__head"><h3 class="bu-card__title" id="drapeaux-titre">${msg('project.flags')}</h3></div>
    <div class="bu-flags">
      <div class="bu-flags__group"><h4 class="bu-eyebrow">${msg('project.flags.priority')}</h4>
        <div class="ao-flag-row"><${Priority} p=${p.priority} />
          <label class="bu-sr-only" for="prio">${msg('project.flags.changePriority')}</label>
          <select class="bu-select bu-input--sm ao-prio" id="prio" value=${p.priority} disabled=${busy === 'prio' || !writes}
            onChange=${(e) => run('prio', 'PATCH', '', { priority: e.currentTarget.value }, msg('project.flags.priorityChanged'))}>
            ${priorityOptions().map((x) => html`<option value=${x} selected=${x === p.priority}>${priorityText(x)}</option>`)}
          </select></div>
      </div>

      <div class="bu-flags__group"><h4 class="bu-eyebrow">${msg('project.flags.risks')}</h4>
        ${risks.length ? html`<ul class="ao-flag-list">${risks.map((f) => html`<li key=${f.key} class="ao-flag-row">
          <${Flag} flag=${f} />
          <span class="bu-caption bu-text-tertiary">${msg(f.acked ? 'project.risk.acked' : 'project.risk.open')}</span>
          <span class="bu-spacer"></span>
          ${f.removable && writes ? html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" disabled=${busy === 'rm:blocked'}
              onClick=${() => run('rm:blocked', 'DELETE', '/flags/risk/blocked', {}, msg('project.risk.unblocked'))}>${msg('project.risk.unblock')}</button>` : null}
          ${writes ? html`<button type="button" class="bu-btn bu-btn--sm" disabled=${busy === 'ack:' + f.key} aria-busy=${busy === 'ack:' + f.key ? 'true' : undefined}
            onClick=${() => run('ack:' + f.key, 'PUT', `/flags/risk/${enc(f.key)}/ack`, { ack: !f.acked }, msg(f.acked ? 'project.risk.unackedToast' : 'project.risk.ackedToast'))}>
            <${Icon} name=${f.acked ? 'bell' : 'check'} />${msg(f.acked ? 'project.risk.unack' : 'project.risk.ack')}</button>` : null}
        </li>`)}</ul>` : html`<p class="bu-caption bu-text-tertiary">${msg('project.risk.none')}</p>`}
        ${!blocked && writes ? html`<div><button type="button" class="bu-btn bu-btn--danger-ghost bu-btn--sm" disabled=${busy === 'blocked'}
          onClick=${() => run('blocked', 'POST', '/flags', { kind: 'risk', key: 'blocked' }, msg('project.risk.blockedToast'))}><${Icon} name="warning" />${msg('project.risk.markBlocked')}</button></div>` : null}
      </div>

      ${features.length ? html`<div class="bu-flags__group"><h4 class="bu-eyebrow">${msg('project.flags.features')}</h4>
        <ul class="bu-labels">${features.map((f) => html`<li key=${f.key}><${Flag} flag=${f} /></li>`)}</ul>
        <p class="bu-caption bu-text-tertiary">${msg('project.flags.featuresNote')}</p></div>` : null}

      <div class="bu-flags__group"><h4 class="bu-eyebrow">${msg('project.flags.labels')}</h4>
        ${labels.length ? html`<ul class="bu-labels">${labels.map((f) => html`<li key=${f.key} class="ao-label-edit">
          <span class=${'bu-label-chip bu-label-chip--' + labelTone(f.key)}>${f.label}</span>
          ${f.removable === false || !writes ? null : html`<button type="button" class="ao-label-edit__x" aria-label=${msg('project.label.remove', { label: f.label })} title=${msg('project.label.removeShort')} disabled=${busy === 'rm:' + f.key}
            onClick=${() => run('rm:' + f.key, 'DELETE', `/flags/label/${enc(f.key)}`, {}, msg('project.label.removed'))}><${Icon} name="close" /></button>`}
        </li>`)}</ul>` : null}
        ${!writes ? null : html`<form class="ao-label-add" onSubmit=${async (e) => { e.preventDefault(); const v = label.trim(); if (!v) return; const res = await run('add', 'POST', '/flags', { kind: 'label', label: v }, msg('project.label.added')); if (res.ok) setLabel(''); }}>
          <label class="bu-sr-only" for="label-input">${msg('project.label.new')}</label>
          <input class="bu-input bu-input--sm" id="label-input" placeholder=${msg('project.label.placeholder')} maxlength="32" value=${label} onInput=${(e) => setLabel(e.currentTarget.value)} />
          <button type="submit" class="bu-btn bu-btn--sm" disabled=${!label.trim() || busy === 'add'}><${Icon} name="add" />${msg('project.label.add')}</button>
        </form>`}
      </div>
    </div>
  </section>`;
}

function DetailSkeleton({ back }) {
  return html`<div class="bu-page ao-frame ao-project" aria-busy="true" aria-label=${msg('project.loading')}>
    <a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a>
    <div class="bu-project-header"><${Skeleton} kind="block" w="cover" /><div class="bu-project-header__body"><${Skeleton} w="30" /><${Skeleton} kind="title" /><${Skeleton} w="50" /></div></div>
    <div class="ao-project__grid"><div class="ao-project__col"><${Skeleton} kind="block" /><${Skeleton} kind="block" /></div><div class="ao-project__col"><${Skeleton} kind="block" /><${Skeleton} kind="block" /></div></div>
  </div>`;
}
