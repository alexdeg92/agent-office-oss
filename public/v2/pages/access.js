// Habilitations (S12; frontend-22: the original Bureau layout, as in S7a): AccessVM from GET /api/v2/views/access,
// kept fresh by `access`. Policy tiles, the instance's agents, then the interlocutors observed as a table.
// URL: ?type=personnes|canaux, ?q=…, ?tri=vu|sessions|jetons|nom (display filter and sort of the server's list).
import { assetUrl } from '../config.js';
import { html } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, label, agentName, getLang } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Icon, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { matchesQuery } from '../board.js';
import * as rules from './access-rules.js';
import { isPerson, isRoom, channelOf } from '../vocab.js';
import { loadAccessStyles } from './access-styles.js';

export const loadStyles=loadAccessStyles;

const TYPES = { personnes: isPerson, canaux: isRoom };   // D5: either contract's kinds
const SORTS = { vu: (a, b) => (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1), sessions: (a, b) => b.sessionCount - a.sessionCount,
  jetons: (a, b) => b.totalTokens - a.totalTokens, nom: (a, b) => displayName(a).localeCompare(displayName(b), getLang()) };
const text = (x) => (x && typeof x === 'object' && 'msg' in x ? msg(x.msg, x.params) : label(x));

/** An interlocutor's name (one « # » for channels; a short-id fallback when the runtime gave none). */
export const displayName = (i) => text(rules.interlocutorName(i));
export const ResolutionNote = ({ resolution }) => (resolution === 'resolved' || resolution === 'unresolvable' ? null   // D5: no name will come; the id is shown
  : html`<span class=${'bu-chip bu-chip--sm' + (resolution === 'failed' ? ' bu-chip--warning' : '')}>${resolution === 'pending' ? html`<span class="bu-spinner ao-spin-sm" aria-hidden="true"></span>` : html`<${Icon} name="warning" />`}${t('resolution.' + resolution)}</span>`);
export const policyText = (p) => (p ? t('accessPolicy.' + p) : '—');

export function AccessPage({ match }) {
  const { router } = services;
  const vm = useTopic('access', '/api/v2/views/access');
  const q = match.query;
  const type = TYPES[q.type] ? q.type : null;
  const sort = SORTS[q.tri] ? q.tri : 'vu';
  const search = q.q || '';
  if (vm.data === undefined && vm.error) return html`<div class="bu-page ao-page"><${ErrorState} error=${vm.error} onRetry=${vm.retry} /></div>`;
  const d = vm.data;
  const all = d ? d.interlocutors : null;
  const shown = all ? all.filter((i) => (!type || TYPES[type](i)) && matchesQuery(displayName(i) + ' ' + i.id, search)).sort(SORTS[sort]) : [];
  const href = (i) => router.href('interlocuteur', { interlocutorId: i.id });
  const count = (k) => (all ? all.filter((i) => !k || TYPES[k](i)).length : 0);
  const kindTag = (i) => html`<span class="bu-tag"><${Icon} name=${isRoom(i) ? 'canal' : 'personne'} />${t('interlocutorKind.' + i.kind)}</span>`;

  return html`<div class="bu-page ao-page ao-access" aria-busy=${vm.resyncing || !d ? 'true' : undefined}>

    ${vm.error && d ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${!d ? html`<div aria-busy="true" aria-label=${msg('access.loading')}><${Skeleton} kind="block" /><${Skeleton} kind="block" /></div>` : html`
    <section class="bu-section" aria-labelledby="ac-pol">
      <h3 class="bu-eyebrow" id="ac-pol">${msg('access.policies')}</h3>
      <div class="ao-access__policies">
        <div class="bu-stat bu-stat--compact"><span class="bu-stat__label"><${Icon} name="discuter" />${msg('access.dm')}</span><span class="bu-stat__value">${policyText(d.policy.dm)}</span></div>
        <div class="bu-stat bu-stat--compact"><span class="bu-stat__label"><${Icon} name="canal" />${msg('access.groups')}</span><span class="bu-stat__value">${policyText(d.policy.group)}</span></div>
        <div class="bu-stat bu-stat--compact"><span class="bu-stat__label"><${Icon} name="check" />${msg('access.channelsOn')}</span><span class="bu-stat__value bu-num">${fmt.number(d.policy.channelsEnabled)} / ${fmt.number(d.policy.channelsTotal)}</span></div>
        <div class="bu-stat bu-stat--compact"><span class="bu-stat__label"><${Icon} name="tool-exec" />${msg('access.exec')}</span><span class="bu-stat__value">${d.policy.execSecurity ? t('execSecurity.' + d.policy.execSecurity) : '—'}</span></div>
      </div>
    </section>
    <section class="bu-section" aria-labelledby="ac-agents">
      <h3 class="bu-eyebrow" id="ac-agents">${msg('access.agents')}</h3>
      ${d.agents.length ? html`<ul class="ao-access__agents">${d.agents.map((a) => html`<li key=${a.id} class="bu-row">
        <span class="bu-avatar bu-avatar--agent bu-avatar--lg" aria-hidden="true"><${Icon} name="agent" /></span>
        <span class="bu-row__main"><span class="bu-row__title">${a.name}${a.isPrimary ? html` <span class="bu-chip bu-chip--sm bu-chip--accent">${msg('access.primary')}</span>` : null}</span>
          <span class="bu-row__sub">${msg('access.agentLine', { id: a.id, model: text(rules.agentExecution(a)) })}</span></span></li>`)}</ul>` : html`<p class="bu-text-secondary">${msg('access.agents.none')}</p>`}
    </section>
    <section class="bu-section" aria-labelledby="ac-people">
      <div class="bu-toolbar">
        <h3 class="bu-eyebrow" id="ac-people">${msg('access.people', { agent: agentName() })}</h3><span class="bu-count">${shown.length}</span>
        <span class="bu-spacer"></span>
        <div class="bu-input-group ao-access__search"><${Icon} name="search" />
          <input class="bu-input bu-input--sm" type="search" placeholder=${msg('access.searchPlaceholder')} aria-label=${msg('access.search')} value=${search}
            onInput=${(e) => router.setQuery({ q: e.currentTarget.value.trim() || null })} /></div>
        <div class="bu-segmented" role="radiogroup" aria-label=${msg('access.type')}>
          ${[['', 'access.type.all'], ['personnes', 'access.type.people'], ['canaux', 'access.type.channels']].map(([v, k]) => html`<button key=${v} type="button" role="radio" class="bu-segmented__opt" aria-checked=${(type || '') === v ? 'true' : 'false'}
            onClick=${() => router.setQuery({ type: v || null })}>${msg(k)}<span class="bu-count">${count(v)}</span></button>`)}
        </div>
        <label class="bu-sr-only" for="ac-sort">${msg('access.sort')}</label>
        <select class="bu-select bu-input--sm ao-access__sort" id="ac-sort" onChange=${(e) => router.setQuery({ tri: e.currentTarget.value === 'vu' ? null : e.currentTarget.value })}>
          ${['vu', 'sessions', 'jetons', 'nom'].map((k) => html`<option key=${k} value=${k} selected=${sort === k}>${msg('access.sort.' + k)}</option>`)}
        </select>
      </div>
      ${!all.length ? html`<div class="bu-card bu-card--sunken"><div class="bu-empty"><img class="ao-illus" src=${assetUrl('bureau/assets/Illustrations/no-interlocutors.webp')} alt="" width="400" height="300" />
          <p class="bu-empty__title">${msg('access.empty', { agent: agentName() })}</p><p class="bu-empty__text">${msg('access.empty.text')}</p></div></div>`
        : !shown.length ? html`<div class="bu-card bu-card--sunken"><div class="bu-empty bu-empty--compact"><p class="bu-empty__title">${msg('access.noMatch')}</p></div></div>`
        : html`<div class="bu-table ao-access__table" role="table" aria-label=${msg('access.tableLabel')}>
            <div class="bu-table__head" role="row"><span role="columnheader">${msg('logs.col.type')}</span><span role="columnheader">${msg('access.col.who')}</span><span role="columnheader">${msg('access.col.channel')}</span><span role="columnheader" class="bu-cell-end">${msg('access.col.sessions')}</span><span role="columnheader" class="bu-cell-end">${msg('logs.col.tokens')}</span><span role="columnheader">${msg('access.col.access')}</span><span role="columnheader" class="bu-cell-end">${msg('access.col.seen')}</span></div>
            ${shown.map((i) => html`<a key=${i.id} class="bu-table__row" role="row" href=${href(i)}>
              <span role="cell">${kindTag(i)}</span>
              <span role="cell" class="bu-cell-main"><span class="ao-access__name">${displayName(i)} <${ResolutionNote} resolution=${i.resolution} /></span><span class="bu-cell-sub">${i.id}</span></span>
              <span role="cell" class="bu-caption">${t('channel.' + channelOf(i))}</span>
              <span role="cell" class="bu-cell-num bu-cell-end">${fmt.number(i.sessionCount)}</span>
              <span role="cell" class="bu-cell-num bu-cell-end">${fmt.number(i.totalTokens)}</span>
              <span role="cell" class="bu-caption">${policyText(i.access && i.access.policy)}${i.access && i.access.enabled === false ? ' · ' + msg('access.off') : ''}</span>
              <span role="cell" class="bu-cell-end bu-caption bu-text-tertiary">${i.lastSeenAt ? html`<${Ago} at=${i.lastSeenAt} />` : '—'}</span></a>`)}
          </div>
          <ul class="bu-list ao-access__cards">${shown.map((i) => html`<li key=${i.id}><a class="bu-row" href=${href(i)}>
            <span class=${'bu-avatar bu-avatar--human' + (isRoom(i) ? ' ao-avatar-channel' : '')} aria-hidden="true">${isRoom(i) ? html`<${Icon} name="canal" />` : displayName(i).replace(/^[#@]/, '').slice(0, 2).toUpperCase()}</span>
            <span class="bu-row__main"><span class="bu-row__title">${displayName(i)}</span>
              <span class="bu-row__sub">${msg('access.sessions', { n: i.sessionCount })} · ${fmt.tokens(i.totalTokens)} · ${i.lastSeenAt ? html`<${Ago} at=${i.lastSeenAt} />` : '—'}</span></span>
            <${ResolutionNote} resolution=${i.resolution} /><${Icon} name="chevron-right" /></a></li>`)}</ul>`}
    </section>`}
  </div>`;
}
