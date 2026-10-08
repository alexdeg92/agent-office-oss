// Santé système (migration-plan.md S9; frontend-22: the original Bureau layout, as in S7a): HealthVM from
// GET /api/v2/views/health, kept fresh by the `health` topic. A level summary, the stat tiles, channels and data
// sources side by side, then data quality. Selections in the URL: ?gravite=error|warn|info|sourdine (issue filter),
// ?probleme=<id> (expanded issue).
import { html, useEffect, useRef, useState } from '../lib.js';
import { useTopic, useCapability } from '../hooks.js';
import { services } from '../services.js';
import { t, label, msg } from '../i18n.js';
import * as fmt from '../fmt.js';
import { put } from '../api.js';
import { Icon, EmptyState, ErrorState, Ago, Sparkline, Skeleton } from '../components/ui.js';

const LEVEL_TONE = { ok: 'success', warn: 'warning', alert: 'danger' };
const LEVEL_ICON = { ok: 'success', warn: 'warning', alert: 'alert' };
const CARD_ICON = { gateway: 'plug', cpu: 'cpu', memory: 'memory', disk: 'disk', 'event-loop': 'gauge', uptime: 'clock', cron: 'flux', plugins: 'layers' };
const CHANNEL_TONE = { connected: 'success', running: 'info', stopped: null, error: 'danger', 'not-configured': null };
const CHANNEL_ICON = { connected: 'success', running: 'refresh', stopped: 'state-idle', error: 'alert', 'not-configured': 'info' };
const SOURCE_TONE = { fresh: 'success', stale: 'warning', down: 'danger' };
const SOURCE_ICON = { fresh: 'success', stale: 'clock', down: 'alert' };
const SEV_TONE = { error: 'danger', warn: 'warning', info: 'info' };
const SEV_ICON = { error: 'error', warn: 'warning', info: 'info' };
const FILTERS = [['', 'open'], ['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['sourdine', 'muted']];

const Chip = ({ tone, icon, children, small }) => html`<span class=${'bu-chip' + (tone ? ' bu-chip--' + tone : '') + (small ? ' bu-chip--sm' : '')}>${icon ? html`<${Icon} name=${icon} />` : null}${children}</span>`;

export function HealthPage({ match }) {
  const vm = useTopic('health', '/api/v2/views/health');
  if (vm.data === undefined && vm.error) return html`<div class="bu-page ao-frame"><${ErrorState} error=${vm.error} onRetry=${vm.retry} /></div>`;
  if (vm.data === undefined) return html`<${HealthSkeleton} />`;
  const h = vm.data;
  const isEmpty = !h.cards.length && !h.channels.length && !h.sources.length && !h.dataQuality.issues.length;
  const notFresh = h.sources.filter((s) => s.state !== 'fresh');

  return html`<div class="bu-page ao-frame ao-health" aria-busy=${vm.resyncing ? 'true' : undefined}>
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })} ${msg('health.maybeOld')}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${isEmpty ? html`<${EmptyState} icon="sante" title=${msg('health.empty.title')} text=${msg('health.empty.text')} />` : html`
      <${Summary} h=${h} notFresh=${notFresh} />
      <${Cards} h=${h} />
      <div class="bu-grid--2 ao-health__pair">
        <${Channels} channels=${h.channels} />
        <${Sources} sources=${h.sources} />
      </div>
      <${DataQuality} dq=${h.dataQuality} query=${match.query} />`}
  </div>`;
}

function Summary({ h, notFresh }) {
  const text = msg('health.summary.' + h.level);
  // Announce a change of level (a transition), never the first render.
  const prev = useRef(text);
  const [announce, setAnnounce] = useState('');
  useEffect(() => { if (prev.current !== text) { prev.current = text; setAnnounce(text); } }, [text]);
  return html`<div class="ao-health__summary">
    <${Chip} tone=${LEVEL_TONE[h.level]} icon=${LEVEL_ICON[h.level]}>${t('healthLevel.' + h.level)}</${Chip}>
    <span class="bu-text-secondary">${text}</span>
    <span class="bu-sr-only" aria-live="polite">${announce}</span>
    ${notFresh.length ? html`<span class="bu-chip bu-chip--warning" title=${notFresh.map((s) => t('source.' + s.id)).join(', ')}><${Icon} name="clock" />${msg('health.cached', { n: notFresh.length })}</span>` : null}
  </div>`;
}

function cardValue(c) { return 'key' in c.value ? t(c.value.key) : fmt.value(c.value); }

/** A meter's fill comes through the CSSOM (CSP: no style attribute). Only a finite, clamped number reaches it. */
function Meter({ pct, label: name }) {
  return html`<div class="bu-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct} aria-label=${name}>
    <span ref=${(el) => { if (el) el.style.setProperty('--value', pct + '%'); }}></span></div>`;
}

function Cards({ h }) {
  if (!h.cards.length) return null;
  const spark = { cpu: h.series.cpu, memory: h.series.mem };
  return html`<section class="bu-section" aria-labelledby="sante-indicateurs">
    <h2 class="bu-eyebrow" id="sante-indicateurs">${msg('health.cards')}</h2>
    <div class="ao-health__cards">
      ${h.cards.map((c) => {
        const tone = c.level === 'ok' ? '' : ' bu-stat--' + LEVEL_TONE[c.level];
        const pct = 'n' in c.value && c.value.unit === 'percent' && Number.isFinite(c.value.n) ? Math.max(0, Math.min(100, c.value.n)) : null;
        return html`<div key=${c.id} class=${'bu-stat' + tone}>
          <span class="bu-stat__label"><${Icon} name=${CARD_ICON[c.id] || 'info'} />${t('healthCard.' + c.id)}
            ${c.level !== 'ok' ? html`<span class="ao-stat__flag"><${Chip} small tone=${LEVEL_TONE[c.level]} icon=${LEVEL_ICON[c.level]}>${t('healthLevel.' + c.level)}</${Chip}></span>` : null}</span>
          <span class="bu-stat__value">${cardValue(c)}</span>
          ${pct != null ? html`<${Meter} pct=${pct} label=${t('healthCard.' + c.id)} />` : null}
          ${c.sub ? html`<span class="bu-stat__sub">${label(c.sub)}</span>` : null}
          ${spark[c.id] && spark[c.id].length > 1 ? html`<${Sparkline} values=${spark[c.id]} at0=${h.series.at0} stepMs=${h.series.stepMs} label=${t('healthCard.' + c.id)} />` : null}
        </div>`;
      })}
    </div>
  </section>`;
}

function Channels({ channels }) {
  return html`<section class="bu-section" aria-labelledby="sante-canaux">
    <h2 class="bu-eyebrow" id="sante-canaux">${msg('health.channels')}</h2>
    ${channels.length ? html`<ul class="bu-list">
      ${channels.map((c) => html`<li key=${c.id} class="bu-row">
        <span class="bu-icon-tile"><${Icon} name="canal" /></span>
        <span class="bu-row__main"><span class="bu-row__title">${c.label}</span>
          <span class="bu-row__sub">${c.lastError ? c.lastError : msg('health.accounts', { n: c.accounts || 0 })}</span></span>
        <${Chip} tone=${CHANNEL_TONE[c.health]} icon=${CHANNEL_ICON[c.health]}>${t('channelHealth.' + c.health)}</${Chip}>
      </li>`)}
    </ul>` : html`<div class="bu-card bu-card--sunken"><${EmptyState} compact icon="canal" title=${msg('health.channels.none')} text=${msg('health.channels.none.text')} /></div>`}
  </section>`;
}

function Sources({ sources }) {
  return html`<section class="bu-section" id="sante-sources-section" aria-labelledby="sante-sources">
    <h2 class="bu-eyebrow" id="sante-sources">${msg('health.sources')}</h2>
    ${sources.length ? html`<ul class="bu-list">
      ${sources.map((s) => {
        const failing = s.channels.filter((c) => c.state !== 'fresh');
        return html`<li key=${s.id} class="bu-row ao-source-row">
        <span class="bu-row__main"><span class="bu-row__title">${t('source.' + s.id)}</span>
          <span class="bu-row__sub">${s.state === 'fresh' ? html`${msg('health.source.updated')} <${Ago} at=${s.lastOkAt} />`
            : html`${s.lastError ? t('sourceError.' + s.lastError) + ' · ' : ''}${msg('health.source.lastOk')} ${s.lastOkAt ? html`<${Ago} at=${s.lastOkAt} />` : msg('health.source.never')}`}</span>
          ${failing.length ? html`<span class="ao-source-row__channels">${failing.map((c) => html`<span key=${c.channel} class="bu-tag" title=${c.lastError ? t('sourceError.' + c.lastError) : ''}>${c.channel}</span>`)}</span>` : null}</span>
        <${Chip} tone=${SOURCE_TONE[s.state]} icon=${SOURCE_ICON[s.state]}>${t('sourceState.' + s.state)}</${Chip}>
      </li>`; })}
    </ul>` : html`<div class="bu-card bu-card--sunken"><${EmptyState} compact icon="database" title=${msg('health.sources.none')} /></div>`}
  </section>`;
}

function DataQuality({ dq, query }) {
  const { router } = services;
  const writes = useCapability('storeWrites');   // Q03-F09: the mute is a store write
  const filter = FILTERS.some(([v]) => v === query.gravite) ? query.gravite || '' : '';
  const shown = dq.issues.filter((i) => (filter === 'sourdine' ? i.state === 'muted' : i.state === 'open' && (!filter || i.severity === filter)));
  const openTotal = dq.open.error + dq.open.warn + dq.open.info;
  const count = (v) => (v === '' ? openTotal : v === 'sourdine' ? dq.issues.filter((i) => i.state === 'muted').length : dq.open[v]);

  return html`<section class="bu-section" aria-labelledby="sante-qualite">
    <div class="ao-section-head">
      <h2 class="bu-eyebrow" id="sante-qualite">${msg('health.quality')}</h2>
      <span class="ao-dq__counts">
        <${Chip} small tone="danger" icon="error">${msg('health.dq.errors', { n: dq.open.error })}</${Chip}>
        <${Chip} small tone="warning" icon="warning">${msg('health.dq.warns', { n: dq.open.warn })}</${Chip}>
        <${Chip} small tone="info" icon="info">${msg('health.dq.infos', { n: dq.open.info })}</${Chip}>
      </span>
    </div>
    ${!writes && dq.issues.some((i) => i.mutable === true) ? html`<p class="ao-ro bu-caption bu-text-secondary" id="sante-lecture"><${Icon} name="info" />${msg('bulletin.readonlyMute')}</p>` : null}
    <div class="ao-scroll-x"><div class="bu-segmented" role="radiogroup" aria-label=${msg('bulletin.quality.filter')}>
      ${FILTERS.map(([v, k]) => html`<button key=${k} type="button" role="radio" class="bu-segmented__opt" aria-checked=${filter === v ? 'true' : 'false'}
        onClick=${() => router.setQuery({ gravite: v || null, probleme: null })}>${msg('bulletin.quality.f.' + k)}<span class="bu-count">${fmt.number(count(v))}</span></button>`)}
    </div></div>
    ${shown.length ? html`<ul class="bu-list">${shown.map((i) => html`<${Issue} key=${i.id} issue=${i} open=${query.probleme === i.id} writes=${writes} />`)}</ul>`
      : html`<div class="bu-card bu-card--sunken"><${EmptyState} compact icon="success"
          title=${msg(filter === 'sourdine' ? 'bulletin.quality.noneMuted' : 'bulletin.quality.noneOpen')}
          text=${filter === 'sourdine' ? '' : msg('health.dq.noneOpen.text')} /></div>`}
  </section>`;
}

function Issue({ issue: i, open, writes = true }) {
  const { router } = services;
  const canMute = i.mutable === true;
  async function toggleMute() {
    try {
      await put(`/api/v2/health/issues/${encodeURIComponent(i.id)}/muted`, { muted: i.state !== 'muted' });
      if (open) router.setQuery({ probleme: null }); // the issue leaves the current filter
    } catch { /* toasted by api.js */ }
  }
  const panelId = 'probleme-' + i.id;
  return html`<li class="bu-card ao-issue" id=${'issue-' + i.id}>
    <div class="ao-issue__head">
      <${Chip} tone=${SEV_TONE[i.severity]} icon=${SEV_ICON[i.severity]}>${t('issueSeverity.' + i.severity)}</${Chip}>
      <span class="ao-issue__title">
        <span class="bu-heading-sm">${t('issueCode.' + i.code)}</span>
        <span class="bu-caption bu-text-secondary bu-mono-sm">${i.channel}${i.path ? ' · ' + i.path : ''}</span>
      </span>
      <span class="ao-issue__meta bu-caption bu-text-tertiary"><span class="bu-num">×${fmt.number(i.count)}</span> · <${Ago} at=${i.lastSeenAt} /></span>
    </div>
    <div class="ao-issue__foot">
      <span class="bu-spacer"></span>
      <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" aria-expanded=${open ? 'true' : 'false'} aria-controls=${panelId}
        onClick=${() => router.setQuery({ probleme: open ? null : i.id })}>${msg(open ? 'health.issue.hide' : 'bulletin.issue.details')}</button>
      ${canMute ? html`<button type="button" class="bu-btn bu-btn--sm" onClick=${toggleMute} disabled=${!writes} aria-describedby=${writes ? undefined : 'sante-lecture'}>
        <${Icon} name=${i.state === 'muted' ? 'bell' : 'bell-off'} />${msg(i.state === 'muted' ? 'bulletin.issue.unmute' : 'bulletin.issue.mute')}</button>` : null}
    </div>
    ${open ? html`<div id=${panelId} class="ao-issue__detail">
      <dl class="bu-kv">
        <div class="bu-kv__row"><dt>${msg('bulletin.issue.code')}</dt><dd class="bu-mono-sm">${i.code}</dd></div>
        ${i.path ? html`<div class="bu-kv__row"><dt>${msg('bulletin.issue.path')}</dt><dd class="bu-mono-sm">${i.path}</dd></div>` : null}
        <div class="bu-kv__row"><dt>${msg('bulletin.issue.first')}</dt><dd>${fmt.dateTime(i.firstSeenAt)}</dd></div>
        <div class="bu-kv__row"><dt>${msg('bulletin.issue.last')}</dt><dd>${fmt.dateTime(i.lastSeenAt)}</dd></div>
        <div class="bu-kv__row"><dt>${msg('bulletin.issue.state')}</dt><dd>${t('issueState.' + i.state)}</dd></div>
      </dl>
      <p class="bu-caption bu-text-tertiary">${msg('bulletin.issue.privacy')}</p>
    </div>` : null}
  </li>`;
}

function HealthSkeleton() {
  return html`<div class="bu-page ao-frame ao-health" aria-busy="true" aria-label=${msg('health.loading')}>
    <${Skeleton} kind="title" />
    <div class="ao-health__cards">${Array.from({ length: 8 }, (_, k) => html`<div key=${k} class="bu-stat"><${Skeleton} w="40" /><${Skeleton} kind="title" /><${Skeleton} w="60" /></div>`)}</div>
    <div class="bu-grid--2 ao-health__pair"><${Skeleton} kind="block" /><${Skeleton} kind="block" /></div>
    <${Skeleton} kind="block" />
  </div>`;
}
