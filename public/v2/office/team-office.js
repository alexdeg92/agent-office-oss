import { html, useEffect, useRef, useState } from '../lib.js';
import { apiUrl, config } from '../config.js';
import * as api from '../api.js';
import { Modal } from '../components/modal.js';
import { Icon } from '../components/ui.js';
import { ProjectMemberRow, loadProjectMemberRowStyles } from '../components/project-member-row.js';
import { project } from './geometry.js';
import { label as labelVM } from '../i18n.js';
import { Button } from '../components/bureau/index.js';
import { ConnectorBrandMark } from '../pages/connector-brand.js';
import { CollapsedGroup } from '../components/bureau/collapsed-group.js';
import { ListRow } from '../components/bureau/rows.js';
import { loadStyles as loadBureauStyles } from '../components/bureau/styles.js';
import { s as tr, locale } from './team-strings.js';
import { s as officeTr } from './strings.js';
import { anonymousPresenceGroups, dedupeHostRows, groupedTeamMembers, isResolvedPresenceName, unlinkedHostRows } from './team-office-model.js';

export const hostAnnotation = occupant => occupant?.hostAgentId && occupant.hostStatus
  ? tr('team.host.observation', { role: tr('team.host.role.' + occupant.hostRole), status: tr('team.host.status.' + occupant.hostStatus) }) : null;

const teamLabel = (label, ref) => ref?.key?.startsWith('team.role.')
  ? (tr(ref.key, ref.params || {}) === ref.key ? label(ref) : tr(ref.key, ref.params || {}))
  : label(ref);

/** Render backend-owned team membership/order; OfficeVM remains the canonical occupant source. */
export function OfficeTeamGroup({ group, occupants, selected, onSelect, unconfirmed, manifest, Avatar, StateChip, nameOf, label, stateTitle, mobileMode = false }) {
  if (!group) return null;
  const byId = new Map((group.members || []).map(member => [member.occupantId, member]));
  const leadOccupant = occupants.get(group.leadOccupantId);
  const accent = ['violet','teal','amber','rose','sky','lime'].includes(group.accentToken) ? group.accentToken : 'violet';
  return html`<article class="bu-card ao-office-team" data-team-group=${group.id} data-team-accent=${accent}>
    <header class="ao-office-team__header"><span class="ao-office-team__accent" aria-hidden="true"></span><div class="ao-office-team__heading"><h3>${label(group.label)}</h3>${leadOccupant ? html`<span class="ao-office-team__lead">${tr('team.groups.lead', { name: nameOf(leadOccupant) })}</span>` : null}</div><span class="bu-chip ao-office-team__count">${label(group.memberCountLabel)}</span></header>
    <ul class="ao-office-team__members">${group.members.map(member => {
      const id = member.occupantId, occupant = occupants.get(id);
      const runtimeText = member.runtimeLabel?.key
        ? (tr(member.runtimeLabel.key, member.runtimeLabel.params || {}) === member.runtimeLabel.key
          ? tr('team.runtime.other') : tr(member.runtimeLabel.key, member.runtimeLabel.params || {}))
        : label(member.runtimeLabel);
      return !occupant || !member ? null : html`<li key=${id}><button type="button" class=${'ao-office-team__member'+(mobileMode?' ao-office-team__member--mobile':'')} data-team-member=${id}
        aria-current=${selected === id ? 'true' : undefined} onClick=${() => onSelect(id)}>
        <${Avatar} o=${occupant} manifest=${manifest} />
        <span class="ao-office-team__copy"><span class="ao-office-team__name" title=${nameOf(occupant)}>${nameOf(occupant)}</span>
          <span class="ao-office-team__meta">${mobileMode ? html`<span>${teamLabel(label, member.roleLabel)}${member.parentLabel ? ` · ${label(member.parentLabel)}` : ''} · ${runtimeText}</span>` : html`<span class="ao-office-team__meta-desktop"><span>${teamLabel(label, member.roleLabel)}</span>${member.parentLabel ? html`<span class="ao-office-team__parent">${label(member.parentLabel)}</span>` : null}</span>`}</span></span>
        <span class=${'ao-office-team__runtime'+(mobileMode?' ao-office-team__runtime--mobile':'')} title=${runtimeText}>${member.runtimeMark ? html`<${ConnectorBrandMark} brand=${member.runtimeMark} className="ao-office-team__mark" label=${runtimeText} />` : null}${mobileMode ? null : html`<span>${runtimeText}</span>`}</span>
        ${mobileMode ? html`<span class=${'ao-office-team__mobile-state ao-office-team__mobile-state--'+member.stateTone}>${label(member.stateLabel)}</span>` : html`<${StateChip} state=${occupant.state} stateKind=${occupant.stateKind} stateLabel=${member.stateLabel} stateActive=${occupant.stateActive} live=${!unconfirmed&&!occupant.presence&&!occupant.sourceStale} title=${unconfirmed||occupant.sourceStale ? label(occupant.stateLastLabel) : stateTitle(occupant)} />`}
      </button></li>`;
    })}</ul>
  </article>`;
}

/** Team groups are a separate, server-ordered OfficeVM collection. */
export function OfficeTeamRoster({ teamGroups = [], occupants = [], selected, onSelect, unconfirmed, manifest, Avatar, StateChip, nameOf, label, stateTitle }) {
  if (!teamGroups.length) return null;
  const byId = new Map(occupants.map(occupant => [occupant.id, occupant]));
  return html`<section class="ao-floor-roster ao-floor-roster--teams" aria-label=${tr('team.groups.projects')}>
    <h3 class="ao-floor-roster__team" data-team-roster-heading>${tr('team.groups.projects')}</h3>
    ${teamGroups.map(group => html`<${OfficeTeamGroup} key=${group.id} group=${group} occupants=${byId} selected=${selected} onSelect=${onSelect} unconfirmed=${unconfirmed} manifest=${manifest} Avatar=${Avatar} StateChip=${StateChip} nameOf=${nameOf} label=${label} stateTitle=${stateTitle} />`)}
  </section>`;
}

const awayFloors = (group, floorLabel) => {
  const floors = group.floorLabels || [];
  return floors.length === 1 && JSON.stringify(floors[0]) === JSON.stringify(floorLabel) ? [] : floors;
};

/** Render the exact OfficeVM roster supplied by the server. */
export function OfficeRoster({ all = false, occupants, rosterFloors = [], teamGroups = [], selected, onSelect, unconfirmed, manifest, Avatar, StateChip, nameOf, label, stateTitle, now, groupedFloors = false, groupsFloorId = null, memberFloors = [], onJumpFloor = () => {}, hostAnnotation }) {
  const byId = new Map(occupants.map(occupant => [occupant.id, occupant]));
  const [eggs, setEggs] = useState({});
  useEffect(() => {
    const update = event => setEggs(previous => ({ ...previous, [event.detail.id]: event.detail.kind }));
    document.addEventListener('office-surprise', update);
    return () => document.removeEventListener('office-surprise', update);
  }, []);
  // The backend names a member's floor only when it differs from its group's main floor.
  const floorOf = new Map(memberFloors.map(row => [row.occupantId, row.label]));
  const card = (occupant, floors = floorOf) => html`<li key=${occupant.id} class=${occupant.rosterDepth > 0 ? 'ao-roster__child' : undefined}>
    <button type="button" class=${'bu-roster ao-roster ao-agentcard' + (occupant.presence ? ' is-seen' : '')} data-occupant=${occupant.id} data-presence=${occupant.presence || undefined} data-source-stale=${occupant.sourceStale || undefined}
      aria-current=${selected === occupant.id ? 'true' : undefined} onClick=${() => onSelect(occupant.id)}>
      <${Avatar} o=${occupant} manifest=${manifest} />
      <span class="bu-cell-main" data-by=${occupant.parentName || undefined}><span class="ao-roster__name ao-agentcard__name" title=${nameOf(occupant)}>${nameOf(occupant)}</span>
        <span class="bu-cell-sub ao-roster__summary" data-conversation=${occupant.visitLabel ? true : undefined} data-visit=${occupant.visitPhase || undefined} title=${occupant.summary || undefined}>${occupant.visitLabel ? label(occupant.visitLabel) : occupant.summary && occupant.summary !== occupant.name ? occupant.summary : occupant.project ? officeTr('office.inProject', { project: occupant.project }) : label(occupant.roleLabel)}${occupant.stationUid || occupant.visitPhase || occupant.summary || occupant.project ? '' : ` · ${officeTr('office.noStation')}`}</span>
        ${hostAnnotation?.(occupant) ? html`<span class="bu-cell-sub ao-host-annotation" data-host-agent=${occupant.hostAgentId}>${hostAnnotation(occupant)}</span>` : null}
        ${floors.has(occupant.id) ? html`<span class="bu-cell-sub" data-member-floor=${occupant.id}>${label(floors.get(occupant.id))}</span>` : null}
        ${occupant.presence ? html`<span class="ao-agentcard__seen">${occupant.presenceLabel}</span>` : null}</span>
      ${eggs[occupant.id] && !unconfirmed ? html`<span class="bu-state" data-surprise-status=${eggs[occupant.id]}>${officeTr('egg.'+eggs[occupant.id])}</span>` : html`<${StateChip} state=${occupant.state} stateKind=${occupant.stateKind} stateLabel=${occupant.stateLabel} stateActive=${occupant.stateActive} live=${!unconfirmed && !occupant.presence && !occupant.sourceStale} title=${unconfirmed || occupant.sourceStale ? label(occupant.stateLastLabel) : stateTitle(occupant)} />`}
    </button></li>`;
  if (!occupants.length && !teamGroups.length) return html`<p class="bu-text-secondary">${officeTr('office.empty')}</p>`;
  const teamRoster = html`<${OfficeTeamRoster} teamGroups=${teamGroups} occupants=${occupants} selected=${selected} onSelect=${onSelect} unconfirmed=${unconfirmed} manifest=${manifest} Avatar=${Avatar} StateChip=${StateChip} nameOf=${nameOf} label=${label} stateTitle=${stateTitle} />`;
  // Every floor carries the whole office roster ordered for that floor: render it once, for the selected floor.
  const groups = floor => groupsFloorId == null || floor.id === groupsFloorId ? floor.agentGroups || [] : [];
  // A group's floors are shown when it reaches beyond the selected floor; repeating that floor adds nothing.
  const floorsText = (group, floor) => awayFloors(group, floor?.label).map(label).join(' · ');
  if (groupedFloors && rosterFloors.length) return html`<div class="ao-floor-roster">${rosterFloors.map(floor => {
    const floorItems = (floor.otherItems || []).map(item => item.kind === 'team-header'
      ? html`<li key=${item.id} class="ao-floor-roster__team" data-roster-team-header=${item.id}>${label(item.label)}</li>`
      : byId.has(item.occupantId) ? card(byId.get(item.occupantId)) : null);
    return html`<section key=${floor.id} class="ao-floor-roster__group" data-roster-floor=${floor.id}>
      <button type="button" class="ao-floor-roster__jump" onClick=${() => onJumpFloor(floor.id)}><span>${label(floor.label)}</span><span>${floor.count}</span><${Icon} name="arrow-right" /></button>
      ${groups(floor).length ? html`<h3 class="ao-floor-roster__team" data-floor-groups-label=${floor.id}>${label(floor.agentGroupsLabel)}</h3>` : null}
      ${groups(floor).map(group => html`<section key=${group.id} class="ao-floor-roster__agent-group" data-floor-agent-group=${group.id} data-floor-agent-group-kind=${group.kind} data-team-accent=${group.accentToken || undefined}>
        <h4 class="ao-floor-roster__team" data-floor-agent-group-label>${label(group.label)} <span>${label(group.countLabel)}</span>${floorsText(group, floor) ? html`<small data-floor-agent-group-floors>${floorsText(group, floor)}</small>` : null}${group.sharedLabel ? html`<small data-floor-agent-group-shared>${label(group.sharedLabel)}</small>` : null}</h4>
        <ul class="ao-bureau__roster">${group.occupantIds.map(id => byId.has(id) ? card(byId.get(id), new Map((group.memberFloors || []).map(row => [row.occupantId, row.label]))) : null)}</ul>
      </section>`)}
      ${floorItems.length ? html`<ul class="ao-bureau__roster">${floorItems}</ul>` : null}
    </section>`;
  })}</div>`;
  return html`<div><ul class="ao-bureau__roster">${occupants.map(occupant => card(occupant))}</ul>${teamGroups.length ? teamRoster : null}</div>`;
}

/** The compact legend is rendered in VM order, outside the room artwork. */
export function OfficeTeamLegend({ teamLegend = [], label }) {
  if (!teamLegend.length) return null;
  return html`<div class="ao-team-legend" role="list" aria-label=${tr('team.groups.projects')}>
    ${teamLegend.map(team => html`<span key=${team.teamId} class="bu-chip ao-team-legend__chip" data-team-legend=${team.teamId} data-team-accent=${team.accentToken} role="listitem">
      <span class="ao-team-legend__dot" aria-hidden="true"></span><span>${label(team.label)}</span>
    </span>`)}
  </div>`;
}

/** Compact phone cards use the same backend-owned membership and ordering as the desktop roster. */
export function OfficeMobileTeamRoster({ agentGroups = [], otherItems = [], groupsLabel, floorLabel = null, occupants = [], onTeam, onSelect, manifest, Avatar, StateChip, unconfirmed, stateTitle, label, nameOf }) {
  if (!agentGroups.length) return null;
  const byId = new Map(occupants.map(occupant => [occupant.id, occupant]));
  return html`<section class="ao-mobile-roster ao-mobile-roster--teams" aria-label=${label(groupsLabel)}>
    <h3 class="ao-mobile-team-header">${label(groupsLabel)}</h3>
    ${agentGroups.map(group => {
      const ids = group.occupantIds;
      return html`<button type="button" key=${group.id} class="bu-card ao-mobile-team-preview" data-floor-agent-group=${group.id} data-floor-agent-group-kind=${group.kind} data-floor-agent-group-state=${group.previewState || undefined} data-team-accent=${group.accentToken || undefined} onClick=${() => onTeam({ groupId: group.id, ids, label: group.label, memberFloors: group.memberFloors || [] })}>
        <span class="ao-mobile-team-preview__avatars">${ids.slice(0, 2).map(id => byId.has(id) ? html`<span data-floor-agent-occupant=${id}><${Avatar} o=${byId.get(id)} manifest=${manifest} /></span>` : null)}</span>
        <span class="ao-mobile-team-preview__copy"><strong>${label(group.label)}</strong><span>${label(group.countLabel)}</span>${awayFloors(group, floorLabel).length ? html`<small data-floor-agent-group-floors>${awayFloors(group, floorLabel).map(label).join(' · ')}</small>` : null}${group.sharedLabel ? html`<small data-floor-agent-group-shared>${label(group.sharedLabel)}</small>` : null}</span>
        ${group.previewStateLabel ? html`<${StateChip} state=${group.previewState} stateKind=${group.previewStateKind} stateLabel=${group.previewStateLabel} stateActive=${group.previewStateActive} live=${!unconfirmed} title=${label(group.previewStateLabel)} />` : null}
        <span class="ao-mobile-team-preview__arrow" aria-hidden="true">›</span>
      </button>`;
    })}
    ${otherItems.map(item => item.kind === 'team-header'
      ? html`<h3 key=${item.id} class="ao-mobile-team-header" data-roster-team-header=${item.id}>${label(item.label)}</h3>`
      : byId.has(item.occupantId) ? (() => { const occupant = byId.get(item.occupantId); return html`<button type="button" key=${item.id} class="bu-roster ao-agentcard ao-mobile-other" data-mobile-agent=${occupant.id} onClick=${() => onSelect(occupant.id)}>
          <${Avatar} o=${occupant} manifest=${manifest} /><span class="bu-cell-main"><span class="ao-agentcard__name">${nameOf(occupant)}</span><span class="bu-cell-sub">${occupant.visitLabel ? label(occupant.visitLabel) : label(occupant.roleLabel)}</span></span>
          <${StateChip} state=${occupant.state} stateKind=${occupant.stateKind} stateLabel=${occupant.stateLabel} stateActive=${occupant.stateActive} live=${!unconfirmed && !occupant.presence && !occupant.sourceStale} title=${stateTitle(occupant)} />
        </button>`; })() : null)}
  </section>`;
}

export const officeTeamOverlay = {
  renderZones(scene, groups) {
    if (!scene.layers?.decal || !scene.proj || !scene.room) return;
    scene.layers.decal.querySelectorAll('[data-team-pod-zone]').forEach(node => node.remove());
    const rows = groups.filter(group => group.pod?.coordinateSpace === 'floor-grid' && group.pod.floorId === group.floorId
      && Array.isArray(group.pod.zone?.polygon) && group.pod.zone.polygon.length >= 3);
    const minX = -scene.room.rows * scene.proj.tileWidth / 2, maxX = scene.room.cols * scene.proj.tileWidth / 2;
    const maxY = (scene.room.cols + scene.room.rows) * scene.proj.tileHeight / 2;
    for (const group of rows) {
      const polygon = group.pod.zone.polygon.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
      if (polygon.length < 3) continue;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('ao-team-pod-zone'); svg.dataset.teamPodZone = group.id; svg.dataset.teamAccent = accentOf(group);
      svg.setAttribute('viewBox', `${minX} 0 ${maxX - minX} ${maxY}`); svg.setAttribute('width', String(maxX - minX)); svg.setAttribute('height', String(maxY));
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      shape.setAttribute('points', polygon.map(point => { const p = project(point.x, point.y, scene.proj); return `${p.sx},${p.sy}`; }).join(' '));
      svg.append(shape); Object.assign(svg.style, { left: `${minX}px`, top: '0px' }); scene.layers.decal.append(svg);
    }
  },
  renderLinks(scene) {
    if (!scene.teamConnectorSvg || scene.teamConnectorSvg.parentElement !== scene.labelsLayer) {
      scene.teamConnectorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      scene.teamConnectorSvg.classList.add('ao-team-links');
      scene.teamConnectorSvg.setAttribute('aria-hidden', 'true');
      scene.labelsLayer.prepend(scene.teamConnectorSvg);
    }
    scene.teamConnectorSvg.replaceChildren();
  },
  positionLinks(scene, groups) {
    if (!scene.teamConnectorSvg || !scene.viewport || !scene.cam || !scene.origin) return;
    const { zoom, x, y } = scene.cam, width = scene.viewport.clientWidth, height = scene.viewport.clientHeight;
    const projectPoint = point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      const p = project(point.x, point.y, scene.proj);
      return { x: (p.sx + scene.origin.x) * zoom + x, y: (p.sy + scene.origin.y) * zoom + y };
    };
    const svg = scene.teamConnectorSvg;
    if (!svg) return;
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.replaceChildren();
    for (const group of groups) for (const link of group.sharedLeadLinks || []) {
      const a = projectPoint(link.fromPoint), b = projectPoint(link.toPoint);
      if (!a || !b) continue;
      // Connector ownership and geometry come from the OfficeVM. The target
      // accent is rendered from its VM row, keyed by the backend link id.
      const target = groups.find(row => row.id === link.teamId) || group;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.dataset.sharedLead = `${group.id}:${link.teamId}`; line.dataset.teamGroup = group.id;
      line.dataset.teamAccent = accentOf(group);
      line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y)); line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y)); svg.append(line);
      for (const [endpoint, point] of [['from', a], ['to', b]]) {
        const endpointGroup = endpoint === 'from' ? group : target;
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        marker.dataset.sharedLeadEndpoint = `${group.id}:${link.teamId}:${endpoint}`;
        marker.dataset.teamGroup = endpointGroup.id; marker.dataset.teamAccent = accentOf(endpointGroup);
        marker.setAttribute('cx', String(point.x)); marker.setAttribute('cy', String(point.y)); marker.setAttribute('r', '4.5');
        svg.append(marker);
      }
    }
  },
};

const accentOf = group => ['violet','teal','amber','rose','sky','lime','blue','green','indigo','cyan'].includes(group.accentToken) ? group.accentToken : 'violet';

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
const runtimeName = (runtime) => runtime?.key ? tr(runtime.key, runtime.params || {}) : tr('team.runtime.other');
const hostStatusKey = (status) => ({ working: 'team.host.working', blocked: 'team.host.blocked', done: 'team.host.done', idle: 'team.host.idle', unknown: 'team.host.unknown' })[status] || 'team.host.unknown';
const hostSeverity = (status) => ({ working: 'info', blocked: 'warn', done: 'ok' })[status];
const taskCounts = (tasks) => tasks.reduce((counts, task) => ({ ...counts, [task.state]: (counts[task.state] || 0) + 1 }), {});
const countLabel = (key, count, loaded) => tr(key, { count: loaded ? count : '…' });

function SourceNote({ state, label, retry, failureText }) {
  if (state.denied) return null;
  if (state.loading && !state.data) return html`<div class="bu-card bu-card--sunken ao-team-state" aria-busy="true"><span class="bu-compact-progress" aria-hidden="true"></span><span role="status">${tr('team.loading', { source: label })}</span></div>`;
  if (state.error || state.unavailable || !state.data) return html`<div class="bu-card bu-card--sunken ao-team-state" role="status">
    <span>${state.unavailable ? tr('team.unavailable', { source: label }) : (failureText || tr('team.failed', { source: label }))}</span>
    <${Button} variant="ghost" size="sm" label=${tr('team.retry')} onPress=${retry} /></div>`;
  return null;
}

function SourceWarning({ state, label, retry, stale = false, failureText }) {
  if (state.denied || state.loading && !state.data) return null;
  if (state.error && state.data) return html`<p class="bu-banner bu-banner--warning ao-team-cached" role="status">${tr('team.cached')}</p>`;
  if (state.error) return html`<${SourceNote} state=${state} label=${label} retry=${retry} failureText=${failureText} />`;
  if (stale) return html`<p class="bu-banner bu-banner--warning ao-team-stale" role="status">${label} · ${tr('team.stale')}</p>`;
  return null;
}

function Freshness({ label, sourceState, observedAt, status, live }) {
  const stale = status === 'stale' || !live;
  const text = !live ? tr('team.lastObserved') : status === 'stale' ? tr('team.stale') : tr('team.current');
  return html`<span class=${'bu-chip bu-chip--sm ' + (stale ? 'bu-chip--warning' : 'bu-chip--success')} data-testid=${'team-fresh-' + sourceState}>
    <span class=${'bu-dot ' + (stale ? 'bu-dot--warning' : 'bu-dot--success bu-dot--live')} aria-hidden="true"></span>
    ${label} · ${text}${observedAt ? html` <time datetime=${new Date(observedAt).toISOString()}>${new Date(observedAt).toLocaleTimeString(locale() === 'en' ? 'en-CA' : 'fr-CA', { hour: '2-digit', minute: '2-digit' })}</time>` : null}</span>`;
}

function Members({ data, office }) {
  const members = data?.members || [];
  if (!members.length) return html`<p class="bu-text-secondary ao-team-empty">${tr('team.members.empty')}</p>`;
  return html`<ul class="bu-list ao-team-list" aria-label=${tr('team.members.label')}>
    ${groupedTeamMembers(members).map(({ member, depth, parent }) => {
      const role = roleText(member);
      const occupant = (office?.occupants || []).find(row => row.memberId === member.id);
      const provider = runtimeName(member.runtimeLabel);
      const qualifier = member.runtimeQualifierLabel ? runtimeName(member.runtimeQualifierLabel) : null;
      const statusLabel = occupant ? labelVM(occupant.stateLabel)
        : member.statusLabel?.key ? tr(member.statusLabel.key, member.statusLabel.params || {}) : '';
      const status = occupant?.state || 'unknown';
      return html`<${ProjectMemberRow} key=${member.id} id=${member.id} name=${member.name}
        roleLabel=${role} parentLabel=${parent?.name || null} parentId=${parent?.id || null} parentMemberId=${parent?.id || null} depth=${depth}
        look=${occupant?.look || null} avatarState=${occupant?.state || null} sourceLabel=${[provider, qualifier].filter(Boolean).join(' · ')}
        sourceBrand=${member.brand || null} status=${status} statusLabel=${statusLabel}
        testId="team-member" className=${depth ? 'ao-team-member-child' : ''} />`;
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

export function TeamOffice({hint=false, office=null, mobileOnly=false, showFloorPanel=true, sheet:sharedSheet=null, onSheetChange=null}={}) {
  useEffect(() => { void Promise.all([loadBureauStyles(), loadProjectMemberRowStyles()]).catch(api.toastError); }, []);
  const sources = useTeamSources();
  const [localSheet, setLocalSheet] = useState(null);
  const sheet = typeof onSheetChange === 'function' ? sharedSheet : localSheet;
  const setSheet = typeof onSheetChange === 'function' ? onSheetChange : setLocalSheet;
  if (config.apiVersion !== 3) return hint ? html`<aside class="bu-card ao-team-herdr-hint" data-testid="team-herdr-opt-in-hint">${tr('team.herdr.enableGrouping')}</aside>` : null;
  const team = sources.teams.data;
  const hosts = sources.orchestrators.data;
  const members = team?.members || [];
  const tasks = team?.tasks || [];
  const teamSnapshotStale = team?.team?.status === 'stale';
  const teamSnapshotUnhealthy = !!sources.teams.error || teamSnapshotStale;
  const hostSnapshotStale = (hosts?.orchestrators || []).some(row => row.sourceStatus === 'stale');
  // Exact-linked host observations annotate existing occupants and do not count as additional people.
  const hostRows = unlinkedHostRows(hosts?.agents || []);
  const hasHostPresences = (hosts?.agents || []).length > 0;
  const hidden = sources.teams.denied && sources.orchestrators.denied;
  if (!showFloorPanel && !hint) {
    if (hidden) return null;
    const hasSourceWarning = (!sources.teams.denied && (sources.teams.error || teamSnapshotStale))
      || (!sources.orchestrators.denied && (sources.orchestrators.error || hostSnapshotStale));
    if (!hasSourceWarning) return null;
    return html`<section class=${'ao-team-office ao-team-office--warnings-only'+(mobileOnly?' ao-team-office--mobile-only':'')} aria-label=${tr('team.office.label')} data-testid="team-office">
      <${SourceWarning} state=${sources.teams} label=${tr('team.source.team')} retry=${sources.retry} stale=${teamSnapshotStale} failureText=${tr('team.failed.team')} />
      <${SourceWarning} state=${sources.orchestrators} label=${tr('team.source.herdr')} retry=${sources.retry} stale=${hostSnapshotStale} />
    </section>`;
  }
  if (hidden && !hint) return null;
  return html`<section class=${'ao-team-office'+(mobileOnly?' ao-team-office--mobile-only':'')} aria-label=${tr('team.office.label')} data-testid="team-office">
    ${team || hosts ? html`<header class="ao-team-office__header">
      <div><p class="bu-eyebrow">${team ? tr('team.office.eyebrow') : tr('team.source.herdr')}</p><h2>${team?.team?.label || tr('team.host.label')}</h2></div>
      <div class="ao-team-office__freshness">
        ${!sources.teams.denied && team ? html`<${Freshness} label=${tr('team.source.team')} sourceState="teams" observedAt=${team.team?.observedAt || team.observedAt} status=${team.team?.status} live=${sources.live} />` : null}
        ${!sources.orchestrators.denied && hasHostPresences ? html`<${Freshness} label=${tr('team.source.herdr')} sourceState="herdr" observedAt=${hosts.orchestrators?.[0]?.observedAt || hosts.observedAt} status=${hosts.orchestrators?.[0]?.sourceStatus} live=${sources.live} />` : null}
      </div>
    </header>` : null}
    ${mobileOnly ? null : html`<div class="ao-team-office__desktop">
      <${SourceCard} title=${countLabel('team.members.heading', members.length, !!team)} state=${sources.teams} retry=${sources.retry} class="members">
        ${hint ? html`<p class="bu-caption ao-team-herdr-hint" data-testid="team-herdr-opt-in-hint">${tr('team.herdr.enableGrouping')}</p>` : null}
        <${Members} data=${team} office=${office} />
      </${SourceCard}>
      <${SourceCard} title=${countLabel('team.board.heading', tasks.length, !!team)} state=${sources.teams} retry=${sources.retry} class="board">
        <${Board} data=${team} />
      </${SourceCard}>
      ${hasHostPresences || !hosts ? html`<${SourceCard} title=${countLabel('team.host.heading', hostRows.length, !!hosts)} state=${sources.orchestrators} retry=${sources.retry} class="herdr">
        ${hosts?.orchestrators?.length ? html`<p class="ao-team-host-label">${runtimeName(hosts.orchestrators[0].kind)} · ${tr('team.host.readOnly')}</p>` : null}
        <${HostPresence} data=${hosts} />
      </${SourceCard}>` : null}
    </div>`}
    <div class="ao-team-office__mobile">
      ${sources.teams.denied ? null : html`<${Button} variant="secondary" testId="team-open-members" label=${countLabel('team.members.heading', members.length, !!team)} onPress=${() => setSheet('members')} />`}
      ${sources.orchestrators.denied || !hasHostPresences ? null : html`<span class="bu-chip bu-chip--sm ao-team-mobile-host" data-testid="team-mobile-host">${countLabel('team.host.heading', hostRows.length, !!hosts)}</span>`}
      ${sources.teams.denied ? null : html`<${Button} variant="primary" testId="team-open-board" label=${countLabel('team.board.open', tasks.length, !!team)} onPress=${() => setSheet('board')} />`}
      ${!sources.teams.denied && team && teamSnapshotUnhealthy ? html`<p class="bu-banner bu-banner--warning ao-team-cached" role="status">${tr(sources.teams.error ? 'team.cached' : 'team.stale')}</p>` : null}
      ${!sources.teams.denied && team && !teamSnapshotUnhealthy && !members.length ? html`<p class="bu-text-secondary ao-team-empty" role="status">${tr('team.members.empty')}</p>` : null}
      ${!sources.teams.denied && !team ? html`<${SourceNote} state=${sources.teams} label=${tr('team.source.team')} retry=${sources.retry} failureText=${tr('team.failed.team')} />` : null}
      ${!sources.orchestrators.denied && !hosts ? html`<${SourceNote} state=${sources.orchestrators} label=${tr('team.source.herdr')} retry=${sources.retry} />` : null}
    </div>
    ${sheet ? html`<${Modal} size="md" class="ao-team-members-sheet" title=${sheet === 'board' ? countLabel('team.board.heading', tasks.length, !!team) : countLabel('team.members.heading', members.length, !!team)} onClose=${() => setSheet(null)}>
      ${sheet === 'board' ? html`<${Board} data=${team} />` : html`<${Members} data=${team} office=${office} />${sources.orchestrators.denied || !hasHostPresences ? null : html`<section class="ao-team-sheet-host"><h3 class="bu-heading-sm">${tr('team.host.heading', { count: hostRows.length })}</h3><${HostPresence} data=${hosts} /></section>`}`}
    </${Modal}>` : null}
  </section>`;
}
