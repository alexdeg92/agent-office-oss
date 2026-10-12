import { html, useEffect, useRef, useState } from '../lib.js';
import { apiUrl, config } from '../config.js';
import * as api from '../api.js';
import { Modal } from '../components/modal.js';
import { Icon } from '../components/ui.js';
import { ConnectorBrandMark } from '../pages/connector-brand.js';
import { Button } from '../components/bureau/index.js';
import { CollapsedGroup } from '../components/bureau/collapsed-group.js';
import { ListRow } from '../components/bureau/rows.js';
import { loadStyles as loadBureauStyles } from '../components/bureau/styles.js';
import { s as tr, locale } from './team-strings.js';
import { anonymousPresenceGroups, dedupeHostRows, groupedTeamMembers, isResolvedPresenceName, linkedPresence, unlinkedHostRows } from './team-office-model.js';

export const hostAnnotation = occupant => occupant?.hostAgentId && occupant.hostStatus
  ? tr('team.host.observation', { role: tr('team.host.role.' + occupant.hostRole), status: tr('team.host.status.' + occupant.hostStatus) }) : null;

const PATH = Object.freeze({ teams: '/api/v3/teams', orchestrators: '/api/v3/orchestrators' });
const emptySource = () => ({ data: null, topicId: null, loading: true, error: null, denied: false, unavailable: false });

/** The sources have independent authorization and freshness; names are never used as identity links. */
function useTeamSources() {
  const [state, setState] = useState({ teams: emptySource(), orchestrators: emptySource(), live: false });
  const latest = useRef(state);
  latest.current = state;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (config.apiVersion !== 3) return;
    let active = true;
    let socket = null;
    let reconnectTimer = null;
    let refreshTimers = {};
    let topicOwners = new Map();
    let generation = 0;

    const fetchOne = async (name, previous = null) => {
      try {
        const response = await api.get(PATH[name], { apiVersion: 3, quiet: true, live: true });
        return { data: response.data, topicId: response.meta?.topic?.id || null, loading: false,
          error: null, denied: false, unavailable: false };
      } catch (error) {
        const gone = error?.status === 403 || error?.status === 404;
        return { data: gone ? null : previous?.data || null, topicId: gone ? null : previous?.topicId || null, loading: false, error,
          denied: error?.status === 403, unavailable: error?.status === 404 };
      }
    };
    const refresh = async (name, revocation = false) => {
      const current = await fetchOne(name, latest.current[name]);
      if (!active) return current;
      setState(old => ({ ...old, [name]: current }));
      if (revocation || current.topicId && topicOwners.get(current.topicId) !== name) scheduleReconnect();
      return current;
    };
    const scheduleReconnect = () => {
      if (!active || reconnectTimer) return;
      socket?.close(); socket = null;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 250);
    };
    const onFrame = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (event.type === 'hello') {
        if (Array.isArray(frame.rejected) && frame.rejected.length) {
          const rejected = frame.rejected.map(row => topicOwners.get(row.topic)).filter(Boolean);
          if (rejected.length) { for (const name of new Set(rejected)) void refresh(name, true); return; }
        }
        setState(old => ({ ...old, live: true }));
        return;
      }
      if (!['snapshot', 'delta'].includes(event.type)) return;
      const name = topicOwners.get(frame.topic);
      if (!name) return;
      clearTimeout(refreshTimers[name]);
      refreshTimers[name] = setTimeout(() => { void refresh(name); }, 80);
    };
    const connect = async () => {
      if (!active) return;
      const id = ++generation;
      socket?.close(); socket = null;
      setState(old => ({ ...old, live: false,
        teams: { ...old.teams, loading: old.teams.data == null },
        orchestrators: { ...old.orchestrators, loading: old.orchestrators.data == null } }));
      const [teams, orchestrators] = await Promise.all([
        fetchOne('teams', latest.current.teams), fetchOne('orchestrators', latest.current.orchestrators),
      ]);
      if (!active || id !== generation) return;
      setState(old => ({ ...old, teams, orchestrators, live: false }));
      topicOwners = new Map();
      for (const [name, source] of [['teams', teams], ['orchestrators', orchestrators]]) {
        if (source.topicId && !source.denied && !source.unavailable) topicOwners.set(source.topicId, name);
      }
      const ids = [...topicOwners.keys()];
      if (!ids.length || typeof EventSource !== 'function') return;
      const url = apiUrl('/api/v3/stream?topics=' + ids.map(encodeURIComponent).join(','), 3);
      socket = new EventSource(url, { withCredentials: true });
      for (const type of ['hello', 'snapshot', 'delta']) socket.addEventListener(type, onFrame);
      socket.addEventListener('error', () => { if (active) setState(old => ({ ...old, live: false })); });
    };
    void connect();
    return () => {
      active = false; generation++;
      socket?.close(); clearTimeout(reconnectTimer);
      for (const timer of Object.values(refreshTimers)) clearTimeout(timer);
    };
  }, [retry]);
  return { ...state, retry: () => setRetry(value => value + 1) };
}

const roleText = (member) => typeof member?.roleLabel === 'string' && member.roleLabel.trim()
  ? member.roleLabel.trim() : tr(({ lead: 'team.role.lead', member: 'team.role.member', unknown: 'team.role.unknown' })[member?.roleKind] || 'team.role.unknown');
const stateKey = (state) => ({ open: 'team.task.open', claimed: 'team.task.claimed', working: 'team.task.working', review: 'team.task.review', done: 'team.task.done', blocked: 'team.task.blocked' })[state] || 'team.task.unknown';
const verdictKey = (verdict) => ({ go: 'team.review.go', 'no-go': 'team.review.noGo', pending: 'team.review.pending', unknown: 'team.review.unknown' })[verdict] || 'team.review.unknown';
const stateSeverity = (state) => ({ blocked: 'warn', review: 'info', done: 'ok', working: 'info', claimed: 'info' })[state] || undefined;
// Runtime identity is adapter-owned open vocabulary. Render the canonical ID as
// a readable label; no provider-name matching or team-specific identity logic.
const runtimeName = (runtime) => String(runtime || tr('team.runtime.other')).replace(/[-_.]+/g, ' ').trim().replace(/\b[a-z]/g, letter => letter.toUpperCase());
const hostStatusKey = (status) => ({ working: 'team.host.working', blocked: 'team.host.blocked', done: 'team.host.done', idle: 'team.host.idle', unknown: 'team.host.unknown' })[status] || 'team.host.unknown';
const hostSeverity = (status) => ({ working: 'info', blocked: 'warn', done: 'ok' })[status];
const taskCounts = (tasks) => tasks.reduce((counts, task) => ({ ...counts, [task.state]: (counts[task.state] || 0) + 1 }), {});
const countLabel = (key, count, loaded) => tr(key, { count: loaded ? count : '…' });

function SourceNote({ state, label, retry }) {
  if (state.denied) return null;
  if (state.loading && !state.data) return html`<div class="bu-card bu-card--sunken ao-team-state" aria-busy="true"><span class="bu-compact-progress" aria-hidden="true"></span><span role="status">${tr('team.loading', { source: label })}</span></div>`;
  if (state.error || state.unavailable || !state.data) return html`<div class="bu-card bu-card--sunken ao-team-state" role="status">
    <span>${tr(state.unavailable ? 'team.unavailable' : 'team.failed', { source: label })}</span>
    <${Button} variant="ghost" size="sm" label=${tr('team.retry')} onPress=${retry} /></div>`;
  return null;
}

function Freshness({ label, sourceState, observedAt, status, live }) {
  const stale = status === 'stale' || !live;
  const text = !live ? tr('team.lastObserved') : status === 'stale' ? tr('team.stale') : tr('team.current');
  return html`<span class=${'bu-chip bu-chip--sm ' + (stale ? 'bu-chip--warning' : 'bu-chip--success')} data-testid=${'team-fresh-' + sourceState}>
    <span class=${'bu-dot ' + (stale ? 'bu-dot--warning' : 'bu-dot--success bu-dot--live')} aria-hidden="true"></span>
    ${label} · ${text}${observedAt ? html` <time datetime=${new Date(observedAt).toISOString()}>${new Date(observedAt).toLocaleTimeString(locale() === 'en' ? 'en-CA' : 'fr-CA', { hour: '2-digit', minute: '2-digit' })}</time>` : null}</span>`;
}

function Members({ data, hostData }) {
  const members = data?.members || [];
  if (!members.length) return html`<p class="bu-text-secondary ao-team-empty">${tr('team.members.empty')}</p>`;
  return html`<ul class="bu-list ao-team-list" aria-label=${tr('team.members.label')}>
    ${groupedTeamMembers(members).map(({ member, depth, parent }) => {
      const role = roleText(member);
      const host = linkedPresence(member, hostData?.agents || []);
      const liveStatus = host ? tr('team.member.liveStatus', { runtime: runtimeName(host.runtimeKind), status: tr(hostStatusKey(host.status)) }) : null;
      const lineage = parent ? tr('team.member.spawnedBy', { name: parent.name }) : null;
      const sessionStatus = member.sessionStatus === 'unknown' ? tr('team.member.sessionUnknown') : null;
      const meta = [lineage, role, liveStatus, sessionStatus].filter(Boolean).join(' · ');
      const runtime = html`<span class="ao-team-runtime" data-runtime-kind=${member.runtimeKind || 'unknown'}
        aria-label=${member.runtimeKind ? member.brand?.providerName || runtimeName(member.runtimeKind) : tr('team.runtime.unknown')}>
        <${ConnectorBrandMark} brand=${member.brand || null} className="ao-team-runtime__brand" label=${member.brand?.providerName || runtimeName(member.runtimeKind)} />
        ${member.runtimeKind ? runtimeName(member.runtimeKind) : tr('team.runtime.unknown')}</span>`;
      const badges = html`${runtime}${member.status === 'inactive' ? html`<span class="bu-chip bu-chip--sm">${tr('team.member.inactive')}</span>` : null}`;
      return html`<${ListRow} key=${member.id} memberId=${member.id} parentMemberId=${parent?.id || undefined} class=${depth ? 'ao-team-member-child' : ''} testId="team-member" title=${member.name} meta=${meta}
        badges=${badges} />`;
    })}
  </ul>`;
}

function HostPresence({ data }) {
  const rows = unlinkedHostRows(data?.agents || []);
  if (!rows.length) return html`<p class="bu-text-secondary ao-team-empty">${tr(data?.orchestrators?.[0]?.sourceStatus === 'stale' ? 'team.host.staleEmpty' : 'team.host.empty')}</p>`;
  const named = rows.filter(agent => isResolvedPresenceName(agent.name));
  return html`<ul class="bu-list ao-team-list" aria-label=${tr('team.host.label')}>
    ${named.map(agent => html`<${ListRow} key=${agent.id} title=${agent.name}
      severity=${hostSeverity(agent.status)} statusLabel=${tr(hostStatusKey(agent.status))}
      meta=${runtimeName(agent.runtimeKind) + ' · ' + tr(hostStatusKey(agent.status))} />`)}
    ${anonymousPresenceGroups(rows).map(({ status, count }) => html`<${ListRow} key=${status} muted
      title=${tr('team.host.unnamedCount', { count })} severity=${hostSeverity(status)} statusLabel=${tr(hostStatusKey(status))}
      meta=${tr('team.host.anonymousStatus', { status: tr(hostStatusKey(status)) })} />`)}
  </ul>`;
}

function TaskRow({ task, members }) {
  const owner = members.get(task.ownerMemberId)?.name || tr('team.task.unassigned');
  const reviewers = (task.reviewerMemberIds || []).map(id => members.get(id)?.name).filter(Boolean);
  const latest = [...(task.reviews || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const meta = [owner, task.priority == null ? null : tr('team.task.priority', { priority: task.priority }), latest ? tr(verdictKey(latest.verdict)) : null].filter(Boolean).join(' · ');
  return html`<details class="ao-team-task" data-testid="team-task">
    <summary class="bu-list-row" aria-label=${task.title + ', ' + tr(stateKey(task.state))}>
      <span class=${'bu-list-row__icon bu-list-row__icon--' + (stateSeverity(task.state) || 'unknown')} aria-hidden="true"><${Icon} name=${task.state === 'done' ? 'success' : task.state === 'blocked' ? 'warning' : 'info'} /></span>
      <span class="bu-list-row__text"><span class="bu-list-row__title">${task.title}</span><span class="bu-list-row__meta">${meta}</span></span>
    </summary>
    <div class="ao-team-task__detail"><p class="ao-team-task__full-title">${task.title}</p><p>${tr('team.task.state', { state: tr(stateKey(task.state)) })}</p>
      <p>${tr('team.task.owner', { owner })}</p>
      ${reviewers.length ? html`<p>${tr('team.task.reviewers', { reviewers: reviewers.join(', ') })}</p>` : null}
      ${(task.reviews || []).length ? html`<ul class="ao-team-review-list">${task.reviews.map(review => html`<li key=${review.id}>${members.get(review.reviewerMemberId)?.name || tr('team.review.reviewerUnknown')} · ${tr(verdictKey(review.verdict))}</li>`)}</ul>` : html`<p>${tr('team.review.none')}</p>`}
      ${task.updatedAt ? html`<p><time datetime=${new Date(task.updatedAt).toISOString()}>${tr('team.task.updated')} ${new Date(task.updatedAt).toLocaleString(locale() === 'en' ? 'en-CA' : 'fr-CA')}</time></p>` : null}
    </div>
  </details>`;
}

function Board({ data }) {
  const tasks = data?.tasks || [];
  const members = new Map((data?.members || []).map(member => [member.id, member]));
  const partial = data?.diagnostics?.quality === 'partial';
  const partialLabel = data?.diagnostics?.partialLabel;
  if (!tasks.length) return html`${partial ? html`<p class="bu-banner bu-banner--warning ao-team-partial" role="status" data-team-quality=${data?.diagnostics?.quality}>${partialLabel ? tr(partialLabel.key, partialLabel.params || {}) : ''}</p>` : null}<p class="bu-text-secondary ao-team-empty">${tr('team.board.empty')}</p>`;
  const counts = taskCounts(tasks);
  const activeStates = ['working', 'review', 'blocked', 'claimed', 'open'];
  const groups = activeStates.map(state => ({ state, tasks: tasks.filter(task => task.state === state) })).filter(group => group.tasks.length);
  const done = tasks.filter(task => task.state === 'done');
  return html`${partial ? html`<p class="bu-banner bu-banner--warning ao-team-partial" role="status" data-team-quality=${data?.diagnostics?.quality}>${partialLabel ? tr(partialLabel.key, partialLabel.params || {}) : ''}</p>` : null}<div class="ao-team-board__scroll" data-testid="team-board-list">
    ${groups.map(group => html`<section class="ao-team-task-group" key=${group.state} aria-label=${tr(stateKey(group.state))}>
      <h4 class="ao-team-task-group__title">${tr(stateKey(group.state))}<span class="bu-chip bu-chip--sm">${counts[group.state]}</span></h4>
      <div>${group.tasks.map(task => html`<${TaskRow} key=${task.id} task=${task} members=${members} />`)}</div>
    </section>`)}
    ${done.length ? html`<${CollapsedGroup} label=${tr('team.task.doneCount', { count: done.length })}>
      ${done.map(task => html`<${TaskRow} key=${task.id} task=${task} members=${members} />`)}
    </${CollapsedGroup}>` : null}
  </div>`;
}

function SourceCard({ title, state, retry, children, class: cls = '' }) {
  if (state.denied) return null;
  const unavailable = !state.data && (state.loading || state.error || state.unavailable);
  return html`<section class=${'bu-card ao-team-card ' + cls} aria-label=${title} data-testid=${'team-panel-' + cls}>
    <header class="ao-team-card__head"><h3 class="bu-card__title">${title}</h3></header>
    ${unavailable ? html`<${SourceNote} state=${state} label=${title} retry=${retry} />` : state.error ? html`<p class="bu-banner bu-banner--warning ao-team-cached" role="status">${tr('team.cached')}</p>${children}` : children}
  </section>`;
}

export function TeamOffice({hint=false}={}) {
  useEffect(() => { void loadBureauStyles().catch(api.toastError); }, []);
  const sources = useTeamSources();
  const [sheet, setSheet] = useState(null);
  if (config.apiVersion !== 3) return hint ? html`<aside class="bu-card ao-team-herdr-hint" data-testid="team-herdr-opt-in-hint">${tr('team.herdr.enableGrouping')}</aside>` : null;
  const team = sources.teams.data;
  const hosts = sources.orchestrators.data;
  const members = team?.members || [];
  const tasks = team?.tasks || [];
  // Exact-linked host observations annotate existing occupants and do not count as additional people.
  const hostRows = unlinkedHostRows(hosts?.agents || []);
  const hidden = sources.teams.denied && sources.orchestrators.denied;
  if (hidden && !hint) return null;
  return html`<section class="ao-team-office" aria-label=${tr('team.office.label')} data-testid="team-office">
    ${team || hosts ? html`<header class="ao-team-office__header">
      <div><p class="bu-eyebrow">${team ? tr('team.office.eyebrow') : tr('team.source.herdr')}</p><h2>${team?.team?.label || tr('team.host.label')}</h2></div>
      <div class="ao-team-office__freshness">
        ${!sources.teams.denied && team ? html`<${Freshness} label=${tr('team.source.team')} sourceState="teams" observedAt=${team.team?.observedAt || team.observedAt} status=${team.team?.status} live=${sources.live} />` : null}
        ${!sources.orchestrators.denied && hosts ? html`<${Freshness} label=${tr('team.source.herdr')} sourceState="herdr" observedAt=${hosts.orchestrators?.[0]?.observedAt || hosts.observedAt} status=${hosts.orchestrators?.[0]?.sourceStatus} live=${sources.live} />` : null}
      </div>
    </header>` : null}
    <div class="ao-team-office__desktop">
      <${SourceCard} title=${countLabel('team.members.heading', members.length, !!team)} state=${sources.teams} retry=${sources.retry} class="members">
        ${hint ? html`<p class="bu-caption ao-team-herdr-hint" data-testid="team-herdr-opt-in-hint">${tr('team.herdr.enableGrouping')}</p>` : null}
        <${Members} data=${team} hostData=${hosts} />
      </${SourceCard}>
      <${SourceCard} title=${countLabel('team.board.heading', tasks.length, !!team)} state=${sources.teams} retry=${sources.retry} class="board">
        <${Board} data=${team} />
      </${SourceCard}>
      <${SourceCard} title=${countLabel('team.host.heading', hostRows.length, !!hosts)} state=${sources.orchestrators} retry=${sources.retry} class="herdr">
        ${hosts?.orchestrators?.length ? html`<p class="ao-team-host-label">${runtimeName(hosts.orchestrators[0].kind)} · ${tr('team.host.readOnly')}</p>` : null}
        <${HostPresence} data=${hosts} />
      </${SourceCard}>
    </div>
    <div class="ao-team-office__mobile">
      ${sources.teams.denied ? null : html`<${Button} variant="secondary" testId="team-open-members" label=${countLabel('team.members.heading', members.length, !!team)} onPress=${() => setSheet('members')} />`}
      ${sources.orchestrators.denied ? null : html`<span class="bu-chip bu-chip--sm ao-team-mobile-host" data-testid="team-mobile-host">${countLabel('team.host.heading', hostRows.length, !!hosts)}</span>`}
      ${sources.teams.denied ? null : html`<${Button} variant="primary" testId="team-open-board" label=${countLabel('team.board.open', tasks.length, !!team)} onPress=${() => setSheet('board')} />`}
      ${!sources.teams.denied && !team ? html`<${SourceNote} state=${sources.teams} label=${tr('team.source.team')} retry=${sources.retry} />` : null}
      ${!sources.orchestrators.denied && !hosts ? html`<${SourceNote} state=${sources.orchestrators} label=${tr('team.source.herdr')} retry=${sources.retry} />` : null}
    </div>
    ${sheet ? html`<${Modal} size="md" title=${sheet === 'board' ? countLabel('team.board.heading', tasks.length, !!team) : countLabel('team.members.heading', members.length, !!team)} onClose=${() => setSheet(null)}>
      ${sheet === 'board' ? html`<${Board} data=${team} />` : html`<${Members} data=${team} hostData=${hosts} />${sources.orchestrators.denied ? null : html`<section class="ao-team-sheet-host"><h3 class="bu-heading-sm">${tr('team.host.heading', { count: hostRows.length })}</h3><${HostPresence} data=${hosts} /></section>`}`}
    </${Modal}>` : null}
  </section>`;
}
