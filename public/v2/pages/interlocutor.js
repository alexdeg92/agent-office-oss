// Interlocuteur (S12; frontend-22: the original Bureau layout, as in S7a): InterlocutorVM from
// GET /api/v2/views/interlocutors/:id, kept fresh by `interlocutor:<id>`. Header, profile and relationship side by side,
// access (read-only), conversations.
import { html } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Icon, EmptyState, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { displayName, ResolutionNote, policyText } from './access.js';
import { isPerson, channelOf } from '../vocab.js';

const enc = encodeURIComponent;
const yesNo = (v) => (v == null ? '—' : msg(v ? 'common.yes' : 'common.no'));

export function InterlocutorPage({ match }) {
  const { router } = services;
  const id = match.params.interlocutorId;
  const vm = useTopic('interlocutor:' + enc(id), '/api/v2/views/interlocutors/' + enc(id));
  const back = router.href('habilitations');
  const Back = () => html`<a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.habilitations')}</a>`;
  if (vm.data === undefined && vm.error) {
    return html`<div class="bu-page ao-frame ao-frame--detail"><${Back} />
      ${vm.error.code === 'not_found' ? html`<${EmptyState} icon="personne" title=${msg('person.notFound')} text=${msg('person.notFound.text', { agent: agentName() })}><a class="bu-btn" href=${back}>${msg('person.back')}</a></${EmptyState}>`
        : html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`}</div>`;
  }
  if (vm.data === undefined) return html`<div class="bu-page ao-frame ao-frame--detail ao-interlocutor" aria-busy="true"><${Back} /><${Skeleton} kind="title" /><${Skeleton} kind="block" /></div>`;
  const d = vm.data;
  const user = isPerson(d);
  const p = d.profile;
  const name = displayName({ id: d.id, kind: d.kind, channel: d.channel, name: p ? (user ? p.displayName : p.name) : null });
  const sessionHref = (key) => router.href('session', { sessionKey: key });
  const access = d.access || {};

  return html`<div class="bu-page ao-frame ao-frame--detail ao-interlocutor" aria-busy=${vm.resyncing ? 'true' : undefined}>
    <${Back} />
    <header class="bu-detail-header">
      ${p && p.avatarUrl ? html`<span class="bu-avatar bu-avatar--xl"><img src=${p.avatarUrl} alt="" /></span>`
        : html`<span class=${'bu-avatar bu-avatar--xl bu-avatar--human' + (user ? '' : ' ao-avatar-channel')} aria-hidden="true">${user ? name.replace(/^[#@]/, '').slice(0, 2).toUpperCase() : html`<${Icon} name="canal" size="lg" />`}</span>`}
      <div class="ao-interlocutor__headtext">
        <h2 class="bu-detail-header__title" id="il-titre">${name}<span class="bu-tag">${t('interlocutorKind.' + d.kind)}</span><${ResolutionNote} resolution=${d.resolution} /></h2>
        <p class="bu-detail-header__meta">${t('channel.' + channelOf(d))} · <span class="bu-mono-sm">${d.id.split(':').pop()}</span>${user && p && p.username ? ` · @${p.username}` : ''}${!user && p && p.guildName ? ` · ${p.guildName}` : ''}</p>
      </div>
    </header>
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${d.resolution === 'failed' ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('person.failed')}</span></div>` : null}
    ${d.resolution === 'pending' ? html`<div class="bu-banner" role="status"><span class="bu-spinner ao-spin-sm" aria-hidden="true"></span><span class="bu-banner__text">${msg('person.pending')}</span></div>` : null}
    <div class="bu-grid--2 ao-interlocutor__pair">
      <section class="bu-card ao-section" aria-labelledby="il-profile">
        <h3 class="bu-card__title" id="il-profile">${msg('person.profile')}</h3>
        ${!p ? html`<p class="bu-text-secondary">${msg('person.profile.none')}</p>` : user ? html`<dl class="bu-kv">
            <div class="bu-kv__row"><dt>${msg('person.displayName')}</dt><dd>${p.displayName || '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.username')}</dt><dd>${p.username ? '@' + p.username : '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.account')}</dt><dd>${msg(p.isBot ? 'person.bot' : 'person.human')}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.created')}</dt><dd>${p.createdAt ? fmt.date(p.createdAt) : '—'}</dd></div></dl>`
          : html`<dl class="bu-kv">
            <div class="bu-kv__row"><dt>${msg('person.name')}</dt><dd>${p.name ? '#' + String(p.name).replace(/^#+/, '') : '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('access.type')}</dt><dd>${p.type ? t('discordChannelType.' + p.type) : '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.server')}</dt><dd>${p.guildName || '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.topic')}</dt><dd>${p.topic || '—'}</dd></div>
            <div class="bu-kv__row"><dt>${msg('person.created')}</dt><dd>${p.createdAt ? fmt.date(p.createdAt) : '—'}</dd></div></dl>`}
      </section>
      <section class="bu-card ao-section" aria-labelledby="il-rel">
        <h3 class="bu-card__title" id="il-rel">${msg('person.relation', { agent: agentName() })}</h3>
        <dl class="bu-kv">
          <div class="bu-kv__row"><dt>${msg('access.col.sessions')}</dt><dd>${fmt.number(d.stats.sessionCount)}</dd></div>
          <div class="bu-kv__row"><dt>${msg('person.tokens')}</dt><dd>${fmt.number(d.stats.totalTokens)}</dd></div>
          <div class="bu-kv__row"><dt>${msg('person.first')}</dt><dd>${d.stats.firstSeenAt ? fmt.dateTime(d.stats.firstSeenAt) : '—'}</dd></div>
          <div class="bu-kv__row"><dt>${msg('person.last')}</dt><dd>${d.stats.lastSeenAt ? html`<${Ago} at=${d.stats.lastSeenAt} />` : '—'}</dd></div>
        </dl>
      </section>
    </div>
    <section class="bu-card ao-section" aria-labelledby="il-access">
      <h3 class="bu-card__title" id="il-access">${msg('person.access')}</h3>
      <dl class="bu-kv">
        <div class="bu-kv__row"><dt>${msg('person.policy')}</dt><dd>${policyText(access.policy)}</dd></div>
        ${user ? null : html`<div class="bu-kv__row"><dt>${msg('person.channelEnabled')}</dt><dd class=${access.enabled === false ? 'is-warning' : ''}>${yesNo(access.enabled)}</dd></div>
          <div class="bu-kv__row"><dt>${msg('person.mention')}</dt><dd>${yesNo(access.requireMention)}</dd></div>`}
      </dl>
      <p class="bu-caption bu-text-tertiary">${msg('person.accessNote')}</p>
    </section>
    <section class="bu-card ao-section" aria-labelledby="il-sessions">
      <div class="ao-section__head"><h3 class="bu-card__title" id="il-sessions">${msg('person.conversations', { agent: agentName() })}</h3><span class="bu-count">${d.sessions.length}</span><span class="bu-spacer"></span>
        ${d.primarySessionKey ? html`<a class="bu-btn bu-btn--sm" href=${sessionHref(d.primarySessionKey)}><${Icon} name="journaux" />${msg('person.openLast')}</a>` : null}</div>
      ${d.sessions.length ? html`<ul class="bu-list">${d.sessions.map((s) => html`<li key=${s.id}><a class="bu-row" href=${sessionHref(s.id)}>
          <span class="bu-row__main"><span class="bu-row__title bu-mono-sm">${s.id}</span><span class="bu-row__sub">${s.model || msg('carnet.modelUnknown')} · ${fmt.tokens(s.tokens)}</span></span>
          <span class="bu-row__meta">${s.updatedAt ? html`<${Ago} at=${s.updatedAt} />` : '—'}</span><${Icon} name="chevron-right" /></a></li>`)}</ul>`
        : html`<p class="bu-text-secondary">${msg('person.noSessions')}</p>`}
    </section>
  </div>`;
}
