// Compétences (S11; frontend-22: the original Bureau directory, as in 75895f4): SkillListVM from GET /api/v2/views/skills,
// kept fresh by the `skills` topic. Filters in a side panel (selects on narrow screens), a grid or a table.
// URL: ?source=<source>, ?statut=<status>, ?portee=model|command|user, ?q=…, ?vue=liste (display filters only).
// The skill's own page (skill.js) loads its detail lazily, as its own route chunk.
import { html } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Icon, ErrorState, Skeleton } from '../components/ui.js';
import { matchesQuery } from '../board.js';
import * as rules from './skills-rules.js';

const STATUS_TONE = { active: 'success', disabled: null, unavailable: 'warning' };
const STATUS_ICON = { active: 'success', disabled: 'state-idle', unavailable: 'warning' };
const enc = encodeURIComponent;

export const skillTopic = (name) => 'skill:' + enc(name);
export const StatusChip = ({ status }) => html`<span class=${'bu-chip bu-chip--sm' + (STATUS_TONE[status] ? ' bu-chip--' + STATUS_TONE[status] : '')}><${Icon} name=${STATUS_ICON[status] || 'info'} />${t('skillStatus.' + status)}</span>`;
export const visibilityText = (v) => rules.SCOPES.filter((k) => v && v[k]).map((k) => t('skillVisibility.' + k)).join(' · ') || msg('skills.internal');

export function SkillsPage({ match }) {
  const { router } = services;
  const vm = useTopic('skills', '/api/v2/views/skills');
  const q = match.query;
  const all = vm.data ? vm.data.skills : null;
  const sources = all ? [...new Set(all.map((s) => s.source))] : [];
  const source = sources.includes(q.source) ? q.source : null;
  const status = rules.STATUSES.includes(q.statut) ? q.statut : null;
  const scope = rules.SCOPES.includes(q.portee) ? q.portee : null;
  const view = q.vue === 'liste' ? 'liste' : 'grille';
  const search = q.q || '';
  const set = (patch) => router.setQuery(patch);

  if (vm.data === undefined && vm.error) return html`<div class="bu-page ao-page"><${ErrorState} error=${vm.error} onRetry=${vm.retry} /></div>`;
  const keep = (s, except) => (except === 'source' || !source || s.source === source) && (except === 'status' || !status || s.status === status)
    && (except === 'scope' || !scope || (s.visibility && s.visibility[scope])) && matchesQuery(s.id + ' ' + (s.description || ''), search);
  const shown = all ? all.filter((s) => keep(s)) : [];
  const count = (dim, pred) => (all ? all.filter((s) => keep(s, dim) && pred(s)).length : 0);
  const href = (s) => router.href('competence', { skillName: s.id });
  const groups = all ? [
    [msg('skills.filter.source'), 'source', source, [['', msg('skills.filter.allSources'), count('source', () => true)], ...sources.map((k) => [k, t('skillSource.' + k), count('source', (s) => s.source === k)])]],
    [msg('skills.filter.status'), 'statut', status, [['', msg('skills.filter.all'), count('status', () => true)], ...rules.STATUSES.map((k) => [k, t('skillStatus.' + k), count('status', (s) => s.status === k)])]],
    [msg('skills.filter.scope'), 'portee', scope, [['', msg('skills.filter.allScopes'), count('scope', () => true)], ...rules.SCOPES.map((k) => [k, t('skillVisibility.' + k), count('scope', (s) => s.visibility && s.visibility[k])])]],
  ] : [];

  return html`<div class="bu-page ao-page ao-page--wide ao-skills" aria-busy=${vm.resyncing || !all ? 'true' : undefined}>
    <div class="ao-skills__layout">
      <aside class="ao-skills__aside" aria-label=${msg('skills.filters')}>${groups.map(([title, param, value, options]) => html`<div key=${param} class="bu-filter">
        <h3 class="bu-eyebrow">${title}</h3>
        <ul class="bu-filter__list">${options.map(([v, text, n]) => html`<li key=${v || 'all'}><button type="button" class="bu-filter__item" aria-current=${(value || '') === v ? 'true' : undefined}
          onClick=${() => set({ [param]: v || null })}><span>${text}</span><span class="bu-count">${n}</span></button></li>`)}</ul>
      </div>`)}</aside>
      <div class="ao-skills__main">
        <div class="bu-toolbar">

          ${vm.data ? html`<span class="bu-caption bu-text-tertiary">${msg('skills.count', { n: vm.data.counts.active, total: fmt.number(vm.data.counts.total) })}</span>` : null}
          <span class="bu-spacer"></span>
          <div class="bu-input-group ao-skills__search"><${Icon} name="search" />
            <input class="bu-input bu-input--sm" type="search" placeholder=${msg('skills.search.cards')} aria-label=${msg('skills.search.aria')} value=${search}
              onInput=${(e) => set({ q: e.currentTarget.value.trim() || null })} /></div>
          <div class="bu-segmented" role="radiogroup" aria-label=${msg('skills.view.label')}>
            ${[['grille', 'skills.view.grid', 'layers'], ['liste', 'skills.view.list', 'list']].map(([v, k, i]) => html`<button key=${v} type="button" role="radio" class="bu-segmented__opt" aria-checked=${view === v ? 'true' : 'false'}
              onClick=${() => set({ vue: v === 'grille' ? null : v })}><${Icon} name=${i} />${msg(k)}</button>`)}
          </div>
        </div>
        <div class="ao-skills__mfilters">${groups.map(([title, param, value, options]) => html`<label key=${param} class="ao-skills__mfilter"><span class="bu-sr-only">${title}</span>
          <select class="bu-select bu-input--sm" onChange=${(e) => set({ [param]: e.currentTarget.value || null })}>
            ${options.map(([v, text, n]) => html`<option key=${v || 'all'} value=${v} selected=${(value || '') === v}>${v ? text : msg('skills.filterOption', { filter: title, value: text.toLowerCase() })} (${n})</option>`)}
          </select></label>`)}</div>
        ${vm.error && all ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
        ${!all ? html`<div class="ao-skills__grid" aria-label=${msg('skills.loading')}>${[0, 1, 2, 3, 4, 5].map((k) => html`<div key=${k} class="bu-card"><${Skeleton} kind="title" /><${Skeleton} /><${Skeleton} w="60" /></div>`)}</div>`
          : !all.length ? html`<div class="bu-empty"><div class="bu-empty__art"><${Icon} name="competences" /></div><p class="bu-empty__title">${msg('skills.empty.head')}</p>
              <p class="bu-empty__text">${msg('skills.empty.text')}</p></div>`
          : !shown.length ? html`<div class="bu-card bu-card--sunken"><div class="bu-empty bu-empty--compact"><p class="bu-empty__title">${msg('skills.noMatch')}</p>
              <p class="bu-empty__text">${msg('skills.noMatch.text')}</p>
              <button type="button" class="bu-btn bu-btn--sm" onClick=${() => set({ source: null, statut: null, portee: null, q: null })}>${msg('skills.showAll')}</button></div></div>`
          : view === 'grille' ? html`<ul class="ao-skills__grid">${shown.map((s) => html`<li key=${s.id}><a class="bu-card bu-card--interactive ao-skill-card" href=${href(s)}>
              <div class="bu-card__header"><span class="bu-icon-tile ao-emoji" aria-hidden="true">${s.emoji || html`<${Icon} name="competences" />`}</span>
                <h3 class="bu-card__title ao-skill-card__name" title=${s.id}>${s.id}</h3><span class="bu-spacer"></span><${StatusChip} status=${s.status} /></div>
              <p class="bu-card__desc">${s.description}</p>
              <div class="bu-card__footer"><span>${t('skillSource.' + s.source)}</span><span class="bu-truncate">${visibilityText(s.visibility)}</span></div>
            </a></li>`)}</ul>`
          : html`<div class="bu-table ao-skills__table" role="table" aria-label=${msg('skills.table')}>
              <div class="bu-table__head" role="row"><span role="columnheader">${msg('skills.col.skill')}</span><span role="columnheader">${msg('skills.col.description')}</span><span role="columnheader">${msg('skills.col.source')}</span><span role="columnheader">${msg('skills.col.status')}</span></div>
              ${shown.map((s) => html`<a key=${s.id} class="bu-table__row" role="row" href=${href(s)}>
                <span role="cell" class="ao-skill-row__name"><span aria-hidden="true">${s.emoji || ''}</span> ${s.id}</span>
                <span role="cell" class="bu-truncate bu-text-secondary">${s.description}</span>
                <span role="cell" class="bu-caption">${t('skillSource.' + s.source)}</span>
                <span role="cell"><${StatusChip} status=${s.status} /></span></a>`)}
            </div>`}
      </div>
    </div>
  </div>`;
}
