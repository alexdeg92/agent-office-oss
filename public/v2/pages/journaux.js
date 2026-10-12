// Journaux (migration-plan.md S10; frontend-22: the original Bureau table, as in S7a): Page<LogRowVM> from
// GET /api/v2/views/logs, first page kept fresh by the `logs` / `logs?kind=<k>` topic (api.md §3.6, §4.1); older pages
// come from the cursor (« Afficher plus »). URL: ?type=<SessionKind>, ?connecteur=<connector id>, ?agent=<agent id>
// (server filters), ?battements=1 (heartbeats included), ?q=… (search in the loaded sessions). T-0058: every row names
// its connector (adapter-declared mark) and agent; the raw session key is only on the session page.
import { assetUrl } from '../config.js';
import { html, useState, useEffect } from '../lib.js';
import { useTopic } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, label, enumOf } from '../i18n.js';
import * as fmt from '../fmt.js';
import { get } from '../api.js';
import { Frame, Icon, ErrorState, Ago, Skeleton, StateArt } from '../components/ui.js';
import { matchesQuery } from '../board.js';
import { ConnectorBrandMark } from './connector-brand.js';
import { Modal } from '../components/modal.js';
import { Button, TextInput, Select, Switch, Field, ListRow } from '../components/bureau/index.js';
import { useSmallWorkspace } from './workspace-mobile.js';
export { loadStyles } from './workspace-mobile.js';
import { registerMessages } from '../messages.js';
import * as logsMessages from '../messages/logs.js';

registerMessages(logsMessages);

const enc = encodeURIComponent;
/** Topic id: query keys sorted, values URL-encoded (api.md §4.1). Heartbeats are hidden unless asked for. */
export function logsQuery(kind, heartbeats, connector = null, agent = null) {
  const q = [...(agent ? [['agent', agent]] : []), ...(connector ? [['connector', connector]] : []), ...(heartbeats ? [['heartbeat', 'include']] : []), ...(kind ? [['kind', kind]] : [])];
  return q.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}
export const logsTopic = (kind, heartbeats = false, connector = null, agent = null) => { const q = logsQuery(kind, heartbeats, connector, agent); return q ? 'logs?' + q : 'logs'; };
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
export function ConnectorMark({ connector, named = true }) {
  if (!connector) return html`<span class="bu-text-tertiary">—</span>`;
  const m = connector.mark || {}, name = m.providerName || connector.name;
  return html`<span class="ao-connector" title=${name}><${ConnectorBrandMark} brand=${m} className="ao-connector__mark" label=${name} />${named ? html`<span class="ao-connector__name">${name}</span>` : html`<span class="bu-sr-only">${name}</span>`}</span>`;
}
const tokensText = (r) => (r.tokensKnown === false ? '—' : fmt.number(r.tokens));
function LiveMark({ row }) {
  if (!row.live) return null;
  if (row.execution?.evidence?.level === 'observed') return html`<span class="bu-chip bu-chip--sm bu-chip--warning ao-livechip"><${Icon} name="info" />${msg('logs.activityObserved')}</span>`;
  return html`<span class="bu-chip bu-chip--sm bu-chip--success ao-livechip"><span class="bu-dot bu-dot--success bu-dot--live" aria-hidden="true"></span>${msg('logs.live')}</span>`;
}

export function JournauxPage({ match }) {
  const { router } = services;
  const small = useSmallWorkspace();
  const [filters, setFilters] = useState(false);
  const kinds = enumOf('sessionKind');
  const kind = match.query.type && (kinds.length ? kinds.includes(match.query.type) : true) ? match.query.type : null;
  const heartbeats = match.query.battements === '1';
  const q = match.query.q || '';
  const connector = match.query.connecteur || null, agent = match.query.agent || null;
  const topic = logsTopic(kind, heartbeats, connector, agent);
  const query = logsQuery(kind, heartbeats, connector, agent);
  const vm = useTopic(topic, '/api/v2/views/logs' + (query ? '?' + query : ''));
  const [more, setMore] = useState({ items: [], cursor: undefined, loading: false, error: null });
  useEffect(() => setMore({ items: [], cursor: undefined, loading: false, error: null }), [topic]);
  useEffect(() => { services.lastLogsUrl = location.pathname + location.search; });

  const first = vm.data ? vm.data.items : null;
  const seen = new Set(first ? first.map((r) => r.id) : []);
  const loaded = first ? first.concat(more.items.filter((r) => !seen.has(r.id))) : null;
  const rows = loaded && q ? loaded.filter((r) => matchesQuery([titleOf(r), r.label, r.id, r.agent?.name, r.connector?.name].filter(Boolean).join(' '), q)) : loaded;
  const facets = vm.data?.facets || { connectors: [], agents: [] };
  const filtered = !!(kind || q || connector || agent);
  const cursor = more.cursor === undefined ? vm.data && vm.data.nextCursor : more.cursor;

  async function loadMore() {
    setMore((m) => ({ ...m, loading: true, error: null }));
    try {
      const r = await get('/api/v2/views/logs?' + (query ? query + '&' : '') + 'cursor=' + enc(cursor), { quiet: true });
      setMore((m) => ({ items: m.items.concat(r.data.items), cursor: r.data.nextCursor, loading: false, error: null }));
    } catch (error) { setMore((m) => ({ ...m, loading: false, error })); }
  }
  const href = (row) => router.href('session', { sessionKey: row.id });

  const active = [kind, connector, agent, heartbeats].filter(Boolean).length;
  const filterValues = { connector, agent, kind, heartbeats };
  return html`<${Frame} class="bu-page ao-page ao-logs ao-workspace" aria-busy=${vm.resyncing || (!loaded && !vm.error) ? 'true' : undefined}
    bodyLabel=${msg('logs.table')} head=${html`<div class="ao-workspace__toolbar">
      <${TextInput} class="ao-logs__search ao-workspace__search" type="search" value=${q} placeholder=${msg('carnet.searchPlaceholder')}
        label=${msg('carnet.search')} onValueChange=${value => router.setQuery({ q: value.trim() || null })} />
      ${small ? html`<${Button} label=${msg(active ? 'workspace.filtersActive' : 'workspace.filters', { n: active })}
        icon=${html`<${Icon} name="filter" />`} onPress=${() => setFilters(true)} />` : null}
    </div>
    ${loaded ? html`<p class="ao-workspace__count" role="status">${msg(q ? 'carnet.matches' : cursor ? 'logs.countMore' : 'logs.count', { n: q ? rows.length : loaded.length, q })}</p>` : null}`}
    bar=${!small ? html`<div class="ao-logs__filters"><${LogsFilters} facets=${facets} kinds=${kinds} values=${filterValues}
      onChange=${patch => router.setQuery({ ...(patch.connector !== undefined ? { connecteur: patch.connector || null, agent: null } : {}),
        ...(patch.agent !== undefined ? { agent: patch.agent || null } : {}), ...(patch.kind !== undefined ? { type: patch.kind || null } : {}),
        ...(patch.heartbeats !== undefined ? { battements: patch.heartbeats ? '1' : null } : {}) })} /></div>` : null}>
    ${vm.data === undefined && vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${vm.error && loaded ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('common.updateFailed', { error: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('common.retry')}</button></div>` : null}
    ${!rows ? vm.error ? null : html`<${LogsSkeleton} />` : !rows.length ? html`<div class="bu-empty">
        ${filtered ? html`<${StateArt} slug="no-logs-filter" />` : html`<img class="ao-illus" src=${assetUrl('bureau/assets/Illustrations/empty-journal.webp')} alt="" width="400" height="300" />`}
        <p class="bu-empty__title">${msg(filtered ? 'carnet.empty.filtered' : 'carnet.empty')}</p>
        <p class="bu-empty__text">${msg(filtered ? 'carnet.emptyFiltered.text' : 'carnet.empty.text')}</p>
        ${filtered ? html`<button type="button" class="bu-btn" onClick=${() => router.setQuery({ type: null, q: null, connecteur: null, agent: null })}>${msg('carnet.allTypes')}</button>` : null}
      </div>` : html`
      <div class="bu-table ao-logs__table" role="table" aria-label=${msg('logs.table')}>
        <div class="bu-table__head" role="row"><span role="columnheader">${msg('logs.col.connector')}</span><span role="columnheader">${msg('logs.col.session')}</span><span role="columnheader">${msg('logs.col.agent')}</span><span role="columnheader">${msg('logs.col.model')}</span><span role="columnheader" class="bu-cell-end">${msg('logs.col.tokens')}</span><span role="columnheader" class="bu-cell-end">${msg('logs.col.updated')}</span></div>
        ${rows.map((r) => html`<a key=${r.id} class="bu-table__row" role="row" href=${href(r)}>
          <span role="cell" class="ao-logs__connector"><${ConnectorMark} connector=${r.connector} /></span>
          <span role="cell" class="bu-cell-main"><span class="ao-logs__label">${titleOf(r)}${r.heartbeat ? html` <span class="bu-tag">${msg('carnet.heartbeat')}</span>` : null}<${LiveMark} row=${r} /></span>
            <span class="ao-logs__meta"><${KindChip} row=${r} />${r.channel ? html`<span class="bu-caption bu-text-tertiary">${t('channel.' + r.channel)}</span>` : null}</span></span>
          <span role="cell" class="ao-logs__agent">${r.agent ? r.agent.name : '—'}</span>
          <span role="cell" class="bu-cell-num ao-logs__model" title=${modelText(r) || ''}>${modelText(r) || '—'}</span>
          <span role="cell" class="bu-cell-num bu-cell-end" title=${r.tokensKnown === false ? msg('logs.tokensUnknown') : undefined}>${tokensText(r)}</span>
          <span role="cell" class="bu-cell-end bu-caption bu-text-tertiary">${r.updatedAt ? html`<${Ago} at=${r.updatedAt} />` : '—'}</span>
        </a>`)}
      </div>
      <ul class="ao-logs__cards ao-workspace__list">
        ${rows.map(r => html`<${ListRow} key=${r.id} icon=${html`<${Icon} name=${KIND_ICON[r.kind] || 'list'} />`}
          title=${html`<a class="ao-workspace__link" href=${href(r)}>${titleOf(r)}</a>`}
          meta=${html`<div class="ao-workspace__meta"><${ConnectorMark} connector=${r.connector} />${r.agent ? html`<span>${r.agent.name}</span>` : null}</div>
            <div class="ao-workspace__meta"><${KindChip} row=${r} />${r.heartbeat ? html`<span class="bu-tag">${msg('carnet.heartbeat')}</span>` : null}<${LiveMark} row=${r} /></div>
            <div>${[modelText(r) || '—', r.tokensKnown === false ? null : fmt.tokens(r.tokens)].filter(Boolean).join(' · ')} · ${r.updatedAt ? html`<${Ago} at=${r.updatedAt} />` : '—'}</div>`} />`)}
      </ul>
      ${more.error ? html`<p class="bu-field__error" role="alert"><${Icon} name="alert" />${more.error.message}</p>` : null}
      ${cursor ? html`<button type="button" class="bu-btn ao-more" onClick=${loadMore} disabled=${more.loading} aria-busy=${more.loading ? 'true' : undefined}>${msg('logs.more')}</button>` : null}`}
    ${small && filters ? html`<${LogsFilterSheet} facets=${facets} kinds=${kinds} values=${filterValues} onClose=${() => setFilters(false)}
      onApply=${v => { router.setQuery({ connecteur: v.connector || null, agent: v.agent || null, type: v.kind || null, battements: v.heartbeats ? '1' : null }); setFilters(false); }} />` : null}
  </${Frame}>`;
}

function LogsFilters({ facets, kinds, values, onChange, labelled = false }) {
  const agents = values.connector ? facets.agents.filter(a => a.connectorId === values.connector) : facets.agents;
  const select = (id, name, options, value, change) => labelled
    ? html`<${Field} id=${id} label=${name} control=${props => html`<${Select} ...${props} width="full" value=${value || ''} options=${options} onValueChange=${change} />`} />`
    : html`<${Select} id=${id} label=${name} width="content" value=${value || ''} options=${options} onValueChange=${change} />`;
  return html`
    ${facets.connectors.length > 1 || values.connector ? select('logs-connector', msg('logs.filter.connector'), [{ value: '', label: msg('logs.allConnectors') }, ...facets.connectors.map(c => ({ value: c.id, label: c.name }))], values.connector, connector => onChange({ connector, agent: null })) : null}
    ${agents.length > 1 || values.agent ? select('logs-agent', msg('logs.filter.agent'), [{ value: '', label: msg('logs.allAgents') }, ...agents.map(a => ({ value: a.id, label: a.name }))], values.agent, agent => onChange({ agent })) : null}
    ${select('logs-kind', msg('carnet.type'), [{ value: '', label: msg('carnet.allTypes') }, ...kinds.map(k => ({ value: k, label: t('sessionKind.' + k) }))], values.kind, kind => onChange({ kind }))}
    <${Switch} label=${msg('carnet.heartbeats')} checked=${values.heartbeats} onCheckedChange=${heartbeats => onChange({ heartbeats })} />`;
}

function LogsFilterSheet({ facets, kinds, values, onClose, onApply }) {
  const [draft, setDraft] = useState(values);
  return html`<${Modal} title=${msg('workspace.filters')} onClose=${onClose} class="ao-logs__filter-sheet"
    footer=${html`<${Button} label=${msg('workspace.reset')} onPress=${() => setDraft({ connector: null, agent: null, kind: null, heartbeats: false })} />
      <${Button} label=${msg('workspace.apply')} variant="primary" onPress=${() => onApply(draft)} />`}>
    <div class="ao-logs__filter-fields"><${LogsFilters} facets=${facets} kinds=${kinds} values=${draft} labelled=${true}
      onChange=${patch => setDraft(v => ({ ...v, ...patch }))} /></div>
  </${Modal}>`;
}

function LogsSkeleton() {
  return html`<div class="bu-card" aria-busy="true" aria-label=${msg('carnet.loading')}>${[0, 1, 2, 3, 4, 5].map((k) => html`<div key=${k} class="ao-skel-row"><${Skeleton} w="30" /><${Skeleton} w="40" /><${Skeleton} w="30" /></div>`)}</div>`;
}
