// Journaux (migration-plan.md S10; frontend-22: the original Bureau table, as in S7a): Page<LogRowVM> from
// GET /api/v2/views/logs, first page kept fresh by the `logs` / `logs?kind=<k>` topic (api.md §3.6, §4.1); older pages
// come from the cursor (« Afficher plus »). URL: ?type=<SessionKind> (server filter), ?battements=1 (heartbeats
// included), ?q=… (search in the loaded sessions).
import { assetUrl } from '../config.js';
import { html, useState, useEffect } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, label, enumOf } from '../i18n.js';
import * as fmt from '../fmt.js';
import { get } from '../api.js';
import { Icon, ErrorState, Ago, Skeleton, StateArt } from '../components/ui.js';
import { matchesQuery } from '../board.js';

const enc = encodeURIComponent;
/** Topic id: query keys sorted, values URL-encoded (api.md §4.1). Heartbeats are hidden unless asked for. */
export function logsQuery(kind, heartbeats) {
  const q = [...(heartbeats ? [['heartbeat', 'include']] : []), ...(kind ? [['kind', kind]] : [])];
  return q.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}
export const logsTopic = (kind, heartbeats = false) => { const q = logsQuery(kind, heartbeats); return q ? 'logs?' + q : 'logs'; };
export const modelText = (r) => (r.model ? (r.modelProvider ? `${r.modelProvider}/${r.model}` : r.model) : null);
export const sessionTopic = (key) => 'session:' + enc(key);
// 2.x and 3.0 kinds (api-v3.md D2) both get an icon; an unknown one falls back to a list.
const KIND_ICON = { main: 'agent', primary: 'agent', dashboard: 'monitor', subagent: 'agent', cron: 'clock', scheduled: 'clock', 'chat-direct': 'discuter',
  'conversation-direct': 'discuter', 'chat-group': 'canal', 'conversation-group': 'canal', conversation: 'discuter', acp: 'tool-exec', explicit: 'discuter',
  internal: 'monitor', unrecognized: 'warning' };
const titleOf = (r) => (r.title ? label(r.title) : r.label);

function KindChip({ row }) {
  return html`<span class="bu-tag ao-kind"><${Icon} name=${KIND_ICON[row.kind] || 'list'} />${t('sessionKind.' + row.kind)}${row.runtimeKind ? ' · ' + t('runtimeKind.' + row.runtimeKind) : ''}</span>`;
}
function LiveMark({ row }) {
  if (!row.live) return null;
  return html`<span class="bu-chip bu-chip--sm bu-chip--success ao-livechip"><span class="bu-dot bu-dot--success bu-dot--live" aria-hidden="true"></span>${msg('logs.live')}</span>`;
}

export function JournauxPage({ match }) {
  const { router } = services;
  const kinds = enumOf('sessionKind');
  const kind = match.query.type && (kinds.length ? kinds.includes(match.query.type) : true) ? match.query.type : null;
  const heartbeats = match.query.battements === '1';
  const q = match.query.q || '';
  const topic = logsTopic(kind, heartbeats);
  const query = logsQuery(kind, heartbeats);
  const vm = useTopic(topic, '/api/v2/views/logs' + (query ? '?' + query : ''));
  const [more, setMore] = useState({ items: [], cursor: undefined, loading: false, error: null });
  useEffect(() => setMore({ items: [], cursor: undefined, loading: false, error: null }), [topic]);
  useEffect(() => { services.lastLogsUrl = location.pathname + location.search; });

  if (vm.data === undefined && vm.error) return html`<div class="bu-page ao-frame"><${ErrorState} error=${vm.error} onRetry=${vm.retry} /></div>`;
  const first = vm.data ? vm.data.items : null;
  const seen = new Set(first ? first.map((r) => r.id) : []);
  const loaded = first ? first.concat(more.items.filter((r) => !seen.has(r.id))) : null;
  const rows = loaded && q ? loaded.filter((r) => matchesQuery(titleOf(r) + ' ' + r.label + ' ' + r.id, q)) : loaded;
  const cursor = more.cursor === undefined ? vm.data && vm.data.nextCursor : more.cursor;

  async function loadMore() {
    setMore((m) => ({ ...m, loading: true, error: null }));
    try {
      const r = await get('/api/v2/views/logs?' + (query ? query + '&' : '') + 'cursor=' + enc(cursor), { quiet: true });
      setMore((m) => ({ items: m.items.concat(r.data.items), cursor: r.data.nextCursor, loading: false, error: null }));
    } catch (error) { setMore((m) => ({ ...m, loading: false, error })); }
  }
  const href = (row) => router.href('session', { sessionKey: row.id });

  return html`<div class="bu-page ao-frame ao-logs" aria-busy=${vm.resyncing || !loaded ? 'true' : undefined}>
    <div class="bu-toolbar">
      <h2 class="bu-title ao-logs__title">${msg('nav.journaux')}</h2>
      ${loaded ? html`<span class="bu-caption bu-text-tertiary">${msg(cursor ? 'logs.countMore' : 'logs.count', { n: loaded.length })}</span>` : null}
      <span class="bu-spacer"></span>
      <div class="bu-input-group ao-logs__search"><${Icon} name="search" />
        <input class="bu-input bu-input--sm" type="search" value=${q} placeholder=${msg('carnet.searchPlaceholder')} aria-label=${msg('carnet.search')}
          onInput=${(e) => router.setQuery({ q: e.currentTarget.value.trim() || null })} /></div>
      <label class="bu-switch ao-logs__hb"><input type="checkbox" role="switch" checked=${heartbeats} onChange=${(e) => router.setQuery({ battements: e.currentTarget.checked ? '1' : null })} />${msg('carnet.heartbeats')}</label>
      <label class="bu-sr-only" for="logs-kind">${msg('carnet.type')}</label>
      <select class="bu-select bu-input--sm ao-logs__kind" id="logs-kind" onChange=${(e) => router.setQuery({ type: e.currentTarget.value || null })}>
        <option value="" selected=${!kind}>${msg('carnet.allTypes')}</option>
        ${kinds.map((k) => html`<option key=${k} value=${k} selected=${k === kind}>${t('sessionKind.' + k)}</option>`)}
      </select>
    </div>
    ${vm.error && loaded ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${q && rows ? html`<p class="bu-caption bu-text-secondary ao-logs__matches" role="status">${msg('carnet.matches', { n: rows.length, q })}</p>` : null}
    ${!rows ? html`<${LogsSkeleton} />` : !rows.length ? html`<div class="bu-empty">
        ${kind || q ? html`<${StateArt} slug="no-logs-filter" />` : html`<img class="ao-illus" src=${assetUrl('bureau/assets/Illustrations/empty-journal.webp')} alt="" width="400" height="300" />`}
        <p class="bu-empty__title">${msg(kind || q ? 'carnet.empty.filtered' : 'carnet.empty')}</p>
        <p class="bu-empty__text">${msg(kind || q ? 'carnet.emptyFiltered.text' : 'carnet.empty.text')}</p>
        ${kind || q ? html`<button type="button" class="bu-btn" onClick=${() => router.setQuery({ type: null, q: null })}>${msg('carnet.allTypes')}</button>` : null}
      </div>` : html`
      <div class="bu-table ao-logs__table" role="table" aria-label=${msg('logs.table')}>
        <div class="bu-table__head" role="row"><span role="columnheader">${msg('logs.col.type')}</span><span role="columnheader">${msg('logs.col.session')}</span><span role="columnheader">${msg('logs.col.model')}</span><span role="columnheader" class="bu-cell-end">${msg('logs.col.tokens')}</span><span role="columnheader" class="bu-cell-end">${msg('logs.col.updated')}</span></div>
        ${rows.map((r) => html`<a key=${r.id} class="bu-table__row" role="row" href=${href(r)}>
          <span role="cell" class="ao-logs__type"><${KindChip} row=${r} />${r.channel ? html`<span class="bu-caption bu-text-tertiary">${t('channel.' + r.channel)}</span>` : null}</span>
          <span role="cell" class="bu-cell-main"><span class="ao-logs__label">${titleOf(r)}${r.heartbeat ? html` <span class="bu-tag">${msg('carnet.heartbeat')}</span>` : null}<${LiveMark} row=${r} /></span><span class="bu-cell-sub">${r.id}</span></span>
          <span role="cell" class="bu-cell-num ao-logs__model" title=${modelText(r) || ''}>${modelText(r) || '—'}</span>
          <span role="cell" class="bu-cell-num bu-cell-end">${fmt.number(r.tokens)}</span>
          <span role="cell" class="bu-cell-end bu-caption bu-text-tertiary">${r.updatedAt ? html`<${Ago} at=${r.updatedAt} />` : '—'}</span>
        </a>`)}
      </div>
      <ul class="bu-list ao-logs__cards">
        ${rows.map((r) => html`<li key=${r.id}><a class="bu-row" href=${href(r)}>
          <span class="bu-row__main"><span class="bu-row__title">${titleOf(r)}</span>
            <span class="ao-logs__meta"><${KindChip} row=${r} />${r.heartbeat ? html`<span class="bu-tag">${msg('carnet.heartbeat')}</span>` : null}<${LiveMark} row=${r} /></span>
            <span class="bu-row__sub">${modelText(r) || '—'} · ${fmt.tokens(r.tokens)} · ${r.updatedAt ? html`<${Ago} at=${r.updatedAt} />` : '—'}</span></span>
          <${Icon} name="chevron-right" />
        </a></li>`)}
      </ul>
      ${more.error ? html`<p class="bu-field__error" role="alert"><${Icon} name="alert" />${more.error.message}</p>` : null}
      ${cursor ? html`<button type="button" class="bu-btn ao-more" onClick=${loadMore} disabled=${more.loading} aria-busy=${more.loading ? 'true' : undefined}>${msg('logs.more')}</button>` : null}`}
  </div>`;
}

function LogsSkeleton() {
  return html`<div class="bu-card" aria-busy="true" aria-label=${msg('carnet.loading')}>${[0, 1, 2, 3, 4, 5].map((k) => html`<div key=${k} class="ao-skel-row"><${Skeleton} w="30" /><${Skeleton} w="40" /><${Skeleton} w="30" /></div>`)}</div>`;
}
