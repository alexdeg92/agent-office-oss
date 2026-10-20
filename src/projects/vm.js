'use strict';
const {projectSourceDescriptors}=require('./source-descriptors');

const { actorKey } = require('./actors');
const {
  PROJECT_STATUSES, PRIORITY_RANK, MONOGRAM_ACCENTS, CARD_FLAG_CAP, CARD_PEOPLE_CAP, BOARD_FILTERS,
} = require('./constants');
const { validation } = require('./errors');
const { riskLabel } = require('./labels');
const { sortFlags } = require('./people');

function personName(personId, persons, portability) {
  const person = personId ? persons.get(personId) : null;
  if (person) return person.name;
  return portability ? { key: 'actor.unknown' } : 'Quelqu’un';
}

function actorVm(actor, persons, liveStates = {}, portability = false) {
  if (!actor || actor.kind === 'system') {
    return { kind: 'system', name: portability ? { key: 'actor.system' } : 'Système' };
  }
  const person = actor.personId ? persons.get(actor.personId) : null;
  const kind = person ? person.kind : (actor.kind === 'agent' ? 'agent' : 'human');
  return {
    id: person ? person.id : actor.personId,
    kind,
    name: person ? person.name : (portability ? { key: 'actor.unknown' } : 'Quelqu’un'),
    avatarUrl: person && person.avatarUrl ? person.avatarUrl : null,
    state: kind === 'agent' ? (liveStates[actor.personId] ?? null) : null,
  };
}

function labelRef(key, params) {
  if (!params) return { key };
  const entries = Object.entries(params).filter(([, value]) => value != null);
  if (!entries.length) return { key };
  return { key, params: Object.fromEntries(entries) };
}

function statusRef(status) {
  return { key: `projectStatus.${status}` };
}

function riskRef(key, staleDays) {
  if (key === 'stale' && Number.isInteger(staleDays)) return { key: `risk.${key}`, params: { n: staleDays } };
  return { key: `risk.${key}` };
}

function isoDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  let text = 'PT';
  if (hours) text += `${hours}H`;
  if (minutes) text += `${minutes}M`;
  if (seconds || text === 'PT') text += `${seconds}S`;
  return text;
}

function jobName(event, jobNames) {
  return (jobNames && jobNames[event.jobId]) || event.jobId;
}

function runKey(kind, status) {
  if (status === 'succeeded' || status === 'failed') return `historyKind.${kind}.${status}`;
  return `historyKind.${kind}.other`;
}

// a session key that has no human label yet: its last segment, short (never the whole key)
function shortKey(key) {
  const last = String(key || '').split(':').pop() || String(key || '');
  return /^[0-9a-f-]{20,}$/i.test(last) ? last.slice(0, 8) : last.slice(0, 40);
}

function historyLabel(group, ctx) {
  const event = group[0];
  const n = group.length;
  switch (event.kind) {
    case 'project-created':
    case 'summary-edited':
    case 'archived':
    case 'restored':
    case 'flags-updated':
      return labelRef(`historyKind.${event.kind}`);
    case 'renamed':
      return labelRef('historyKind.renamed', { from: event.from, to: event.to });
    case 'status':
      return labelRef('historyKind.status', { from: statusRef(event.from), to: statusRef(event.to) });
    case 'priority':
      return labelRef('historyKind.priority', { from: event.from, to: event.to });
    case 'commit':
      return labelRef(n === 1 ? 'historyKind.commit.one' : 'historyKind.commit.other', { n, branch: event.branch });
    case 'flow-run':
    case 'cron-run': {
      const params = { job: jobName(event, ctx.jobNames), n };
      if (n === 1 && Number.isInteger(event.durationMs)) params.duration = isoDuration(event.durationMs);
      return labelRef(runKey(event.kind, event.status), params);
    }
    case 'session': {
      // architect-57: a human label (agent, sub-agent, channel, person) and a real message count; never a raw key or an
      // unfilled {messages} (an unknown count has its own label)
      const info = typeof ctx.sessionInfo === 'function' ? ctx.sessionInfo(event.sessionKey) : null;
      const messages = info && Number.isInteger(info.messages) ? info.messages : Number.isInteger(event.messages) && event.messages > 0 ? event.messages : null;
      const params = { session: (info && info.label) || shortKey(event.sessionKey), tokens: Number.isInteger(event.tokens) ? event.tokens : 0 };
      if (messages != null) params.messages = messages;
      return labelRef(messages != null ? 'historyKind.session' : 'historyKind.session.noCount', params);
    }
    case 'risk-raised':
    case 'risk-cleared':
    case 'risk-acked':
    case 'risk-unacked':
      return labelRef(`historyKind.${event.kind}`, { risk: riskRef(event.key, event.staleDays) });
    case 'flag-added':
    case 'flag-removed':
      if (event.flagKind === 'risk') {
        return labelRef(`historyKind.${event.kind}.risk`, { risk: riskRef(event.key) });
      }
      return labelRef(`historyKind.${event.kind}.label`, { label: event.label || event.key });
    case 'source-linked':
    case 'source-unlinked':
      return labelRef(`historyKind.${event.kind}`, { source: event.ref });
    case 'agent-action':
      return labelRef(`historyKind.agent-action.${event.action}`, {
        subject: event.subjectPersonId ? personName(event.subjectPersonId, ctx.persons, ctx.portability) : null,
      });
    case 'people-override': {
      const key = event.hidden ? 'historyKind.people-override.hidden' : 'historyKind.people-override';
      return labelRef(key, { person: personName(event.personId, ctx.persons, ctx.portability), role: event.role || null });
    }
    default:
      return labelRef(`historyKind.${event.kind}`);
  }
}

function sameActor(a, b) { return actorKey(a.actor) === actorKey(b.actor); }

function canGroup(a, b) {
  if (a.kind === 'commit' && b.kind === 'commit') return a.branch === b.branch && sameActor(a, b);
  if ((a.kind === 'flow-run' || a.kind === 'cron-run') && a.kind === b.kind) {
    return a.jobId === b.jobId && a.status === b.status;
  }
  return false;
}

function presentHistory(events, options = {}) {
  const persons = options.persons instanceof Map
    ? options.persons
    : new Map((options.persons || []).map((p) => [p.id, p]));
  const ctx = { ...options, persons };
  const groups = [];
  for (const event of events) {
    const prev = groups[groups.length - 1];
    if (prev && canGroup(prev[0], event)) prev.push(event);
    else groups.push([event]);
  }
  const liveStates = options.liveStates || {};
  return groups.map((group) => ({
    id: group[0].id,
    at: group[0].at,
    kind: group[0].kind,
    group: group.length,
    actor: actorVm(group[0].actor, persons, liveStates, options.portability),
    text: historyLabel(group, ctx),
    ...sessionDetail(group[0], ctx),
  }));
}

// architect-57: a session item's details: what the agent did (summary), the counts, and where to open it
function sessionDetail(event, ctx) {
  if (event.kind !== 'session' || typeof event.sessionKey !== 'string') return {};
  const info = typeof ctx.sessionInfo === 'function' ? ctx.sessionInfo(event.sessionKey) : null;
  return { session: {
    key: event.sessionKey,
    label: (info && info.label) || { key: 'historySession.unknown', params: { session: shortKey(event.sessionKey) } },
    summary: (info && info.summary) || null,
    messages: info && Number.isInteger(info.messages) ? info.messages : Number.isInteger(event.messages) && event.messages > 0 ? event.messages : null,
    tokens: info && Number.isInteger(info.tokens) ? info.tokens : Number.isInteger(event.tokens) ? event.tokens : 0,
    route: '/journaux/' + encodeURIComponent(event.sessionKey),
    ...(info && info.people ? { people: info.people, channel: info.channel || null } : {}),
  } };
}

function compareCards(a, b) {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority) return byPriority;
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function graphemes(text, locale = 'fr') {
  return [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(String(text))].map((part) => part.segment);
}

function letterGraphemes(word, locale) {
  return graphemes(word, locale).filter((g) => /^\p{L}/u.test(g));
}

function initials(name, locale) {
  const tag = locale || 'fr-CA';
  const segment = String(tag).toLowerCase().startsWith('fr') ? 'fr' : tag;
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letterWords = words.map((word) => letterGraphemes(word, segment)).filter((letters) => letters.length);
  let picked = [];
  if (letterWords.length >= 2) picked = [letterWords[0][0], letterWords[1][0]];
  else if (letterWords.length === 1) picked = letterWords[0].slice(0, 2);
  if (picked.length) {
    const text = picked.join('').toLocaleUpperCase(tag);
    return text.length <= 8 ? text : '?';
  }
  if (words.length) {
    const first = graphemes(words[0], segment)[0];
    if (first && first.length <= 8) return first;
  }
  return '?';
}

function monogramAccent(id) {
  let hash = 0;
  for (const ch of String(id || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MONOGRAM_ACCENTS[hash % MONOGRAM_ACCENTS.length];
}

function thumbOf(project, locale, cover = null) {
  const repo = project.repo;
  const image = repo && repo.image;
  const usable = image && image.url && (image.kind === 'opengraph' || image.kind === 'screenshot');
  return {
    kind: cover ? 'cover' : usable ? image.kind : 'monogram',
    url: cover ? cover.url : usable ? image.url : null,
    repoLabel: repo ? `${repo.owner}/${repo.name}` : null,
    initials: initials(project.name, locale),
    accent: monogramAccent(project.id),
  };
}

function projectImage(project, locale) {
  const thumb = thumbOf(project, locale);
  return { kind: thumb.kind, url: thumb.url, initials: thumb.initials, accent: thumb.accent };
}

function flagLabel(flag, portability) {
  if (flag.kind === 'label') return flag.label;
  if (flag.kind === 'risk') return portability ? riskRef(flag.key, flag.staleDays) : riskLabel(flag.key, flag.staleDays);
  return flag.key;
}

function flagVm(flag, portability) {
  const vm = { kind: flag.kind, key: flag.key, label: flagLabel(flag, portability) };
  if (flag.kind === 'risk') {
    vm.severity = flag.severity;
    vm.acked = flag.ack != null;
    vm.removable = flag.key === 'blocked' && flag.origin === 'manual';
  } else if (flag.kind === 'feature') {
    vm.state = flag.state;
  } else if (flag.kind === 'label') {
    vm.removable = true;
  }
  return vm;
}

function cardFlags(flags, portability) {
  const risks = flags.filter((f) => f.kind === 'risk' && f.clearedAt == null && f.ack == null);
  const rest = flags.filter((f) => f.kind !== 'risk');
  const shown = rest.slice(0, CARD_FLAG_CAP);
  return {
    visible: risks.concat(shown).map((flag) => flagVm(flag, portability)),
    hiddenCount: rest.length - shown.length,
  };
}

function personMap(persons) {
  return persons instanceof Map ? persons : new Map((persons || []).map((p) => [p.id, p]));
}

function chips(project, persons, liveStates) {
  return project.people.map((pp) => {
    const person = persons.get(pp.personId);
    if (!person) return null;
    const state = person.kind === 'agent' ? (liveStates[pp.personId] ?? pp.liveState ?? null) : null;
    return { id: person.id, kind: person.kind, name: person.name, avatarUrl: person.avatarUrl, state, role: pp.role, origin: pp.origin, commitCount: pp.commitCount };
  }).filter(Boolean);
}

function involvesTimmy(project, persons, timmyPersonId, agentId) {
  return project.people.some((pp) => {
    if (!agentId && timmyPersonId && pp.personId === timmyPersonId) return true;
    const person = persons.get(pp.personId);
    if (!person || person.kind !== 'agent' || (person.links && person.links.subagentId)) return false;
    return Boolean(person.links && person.links.agentId === (agentId || 'main'));
  });
}

function atRisk(project) {
  return project.flags.some((f) => f.kind === 'risk' && f.clearedAt == null);
}

function buildBoardVM(projects, options = {}) {
  const filter = options.filter || 'all';
  const allowed = BOARD_FILTERS.includes(filter) || (options.portability && filter === 'with-agent');
  if (!allowed) throw validation('Filtre invalide.', 'filter');
  const persons = personMap(options.persons);
  const liveStates = options.liveStates || {};
  const agentFilter = filter === 'with-timmy' || filter === 'with-agent';
  const matchesBoardFilter = (project) => {
    const archived = project.archivedAt != null;
    if (filter === 'archived') return archived;
    if (archived) return false;
    if (filter === 'at-risk') return atRisk(project);
    if (agentFilter) return involvesTimmy(project, persons, options.timmyPersonId, options.primaryAgentId || undefined);
    return true;
  };
  const descriptorsOf = project => projectSourceDescriptors(project, options);
  const search = typeof options.search === 'string' ? options.search.trim().slice(0, 120) : '';
  const stage = typeof options.stage === 'string' && options.stage !== 'all' ? options.stage : null;
  if (stage && !PROJECT_STATUSES.includes(stage)) throw validation('Étape invalide.', 'stage');
  const matchesSearch = project => !search || String(project.name || '').toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const eligible = projects.filter(matchesBoardFilter).filter(matchesSearch);
  const sourceCounts = new Map();
  for (const project of eligible) for (const source of descriptorsOf(project)) {
    const previous = sourceCounts.get(source.id);
    if (previous) previous.count++;
    else sourceCounts.set(source.id, { id: source.id, label: source.label, source, count: 1 });
  }
  const sourceFilters = [...sourceCounts.values()].sort((a, b) => a.label.key.localeCompare(b.label.key) || a.id.localeCompare(b.id))
    .map(row => ({ id: row.id, label: row.label, count: row.count, selected: row.id === (options.sourceFilterId || null), source: row.source }));
  if (options.sourceFilterId && !sourceCounts.has(options.sourceFilterId) && !options.allowUnknownSourceFilter) throw validation('Filtre de source invalide.', 'source');
  const sourceSelected = eligible.filter(project => !options.sourceFilterId || descriptorsOf(project).some(source => source.id === options.sourceFilterId));
  // Private projection metadata: security projection needs to subtract restricted
  // cards from every stage count, including stages omitted by the selected-stage
  // query. A global symbol/non-enumerable property keeps it out of the wire VM.
  const accessRow = project => ({
    status: project.status,
    runtime: descriptorsOf(project).some(source => source.kind === 'runtime'),
    team: project.origin === 'orchestrator-team' || project.teamProject != null,
    sourceIds: descriptorsOf(project).map(source => source.id),
  });
  const boardAccess = { stageRows: sourceSelected.map(accessRow), sourceRows: eligible.map(accessRow) };
  const selected = stage ? sourceSelected.filter(project => project.status === stage) : sourceSelected;
  const v3 = options.apiVersion === 3;
  const columns = PROJECT_STATUSES.map((status) => {
    const cards = selected.filter((p) => p.status === status).sort(compareCards).map((project) => {
      const cover = (typeof options.coverOf === 'function' ? options.coverOf(project.id) : project.cover) || null;
      const people = chips(project, persons, liveStates).map(({ id, kind, name, avatarUrl, state }) => ({ id, kind, name, avatarUrl, state }));
      return {
        id: project.id,
        name: project.name,
        priority: project.priority,
        revision: project.revision,
        status: project.status,
        thumb: thumbOf(project, options.locale, cover),
        cover,
        flags: cardFlags(project.flags, options.portability),
        people: { visible: people.slice(0, CARD_PEOPLE_CAP), hiddenCount: Math.max(0, people.length - CARD_PEOPLE_CAP) },
        lastActivityAt: project.lastActivityAt,
        ...(project.teamProject ? { origin: 'orchestrator-team', teamProject: {
          teamId: project.teamProject.teamId, label: project.teamProject.label,
          readOnly: project.teamProject.readOnly, taskCount: project.teamProject.taskCount,
        } } : {}),
        sourceDescriptors: descriptorsOf(project), statusLabel: statusRef(project.status),
        counts: projectCounts(project, people), capabilities: projectCapabilities(project),
      };
    });
    return { id: status, ...(v3 ? { label: statusRef(status), taskCount: cards.length,
      summaryLabel: labelRef('project.board.column.summary', { n: cards.length }) } : {}), count: cards.length, cards };
  });
  const vm = { columns, filter, sourceFilterId: options.sourceFilterId || null, sourceFilters,
    emptyStateLabel: selected.length ? null : { key: options.sourceFilterId ? 'project.empty.source' : 'project.empty.board' } };
  if (v3) {
    const stageCounts = PROJECT_STATUSES.map(id => ({ id, count: sourceSelected.filter(project => project.status === id).length }));
    vm.controls = {
      search: { options: [{ id: 'project-name', label: labelRef('project.control.search.name') }],
        counts: [{ id: 'matches', count: sourceSelected.length }], selected: search || null },
      stage: { options: [{ id: 'all', label: labelRef('project.control.stage.all') },
        ...PROJECT_STATUSES.map(id => ({ id, label: statusRef(id) }))],
      counts: [{ id: 'all', count: sourceSelected.length }, ...stageCounts], selected: stage || 'all' },
    };
    Object.defineProperty(vm, Symbol.for('agent-office.projects.boardAccess'), { value: boardAccess });
  }
  return vm;
}

function projectCounts(project, cardPeople = []) {
  const sessions = Number.isSafeInteger(project.sessionCount) ? project.sessionCount : null;
  const agents = Number.isSafeInteger(project.agentCount) ? project.agentCount
    : Number.isSafeInteger(project.teamProject?.roster?.memberCount) ? project.teamProject.roster.memberCount
    : Array.isArray(cardPeople) ? cardPeople.filter(person => person.kind === 'agent').length : null;
  const activity = Number.isSafeInteger(project.activityCount) ? project.activityCount : null;
  return { sessions, agents, activity };
}

function projectCapabilities(project) {
  return { read: true, write: project.readOnly !== true, comments: project.commentCapability || 'read-write',
    history: project.historyCapability || 'read-write', repository: project.repo ? 'read-only' : 'unsupported' };
}

// Ordered display projection; consumers never turn capability scalars into labels.
function projectCapabilityRows(capabilities) {
  return ['read', 'write', 'comments', 'history', 'repository'].map(id => ({
    id, label: { key: 'project.team.capability.' + id },
    valueLabel: { key: 'project.team.availability.' + String(capabilities[id]) },
  }));
}

function sourceLabel(source) {
  if (source.kind === 'github') return `${source.ref.owner}/${source.ref.repo}`;
  if (source.kind === 'workspace') return source.ref.rootId ? `${source.ref.rootId}/${source.ref.path}` : source.ref.path;
  if (source.kind === 'sessionGroup') {
    if (source.ref && source.ref.by === 'group') return source.ref.name;
    if (source.ref && source.ref.by === 'interlocutor') return source.ref.interlocutorId;
    return 'sessions';
  }
  return 'manuel';
}

function repoVm(project, locale) {
  const source = project.sources.filter((s) => s.kind === 'github')
    .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))[0];
  if (!source) return null;
  const status = project.repoStatus || { state: project.repo ? 'ok' : 'pending', lastError: null };
  if (!project.repo) {
    return {
      state: status.state,
      url: `https://github.com/${source.ref.owner}/${source.ref.repo}`,
      owner: source.ref.owner,
      name: source.ref.repo,
      image: projectImage(project, locale),
      defaultBranch: null,
      branch: null,
      ci: null,
      commits: [],
      fetchedAt: null,
      lastError: status.lastError,
    };
  }
  return {
    state: status.state === 'error' ? 'error' : 'ok',
    url: project.repo.url,
    owner: project.repo.owner,
    name: project.repo.name,
    image: projectImage(project, locale),
    branch: project.repo.defaultBranch,
    defaultBranch: project.repo.defaultBranch,
    ci: project.repo.ci,
    commits: project.repo.commits.map((commit) => ({
      sha: commit.sha,
      at: commit.at,
      author: commit.author && commit.author.name ? commit.author.name : String(commit.author || ''),
      message: commit.message,
    })),
    fetchedAt: project.repo.fetchedAt,
    lastError: status.state === 'error' ? status.lastError : null,
  };
}

function buildCandidatesVM(candidates, { scannedAt, generatedAt } = {}) {
  return {
    scannedAt: scannedAt ?? generatedAt ?? null,
    statusOptions: PROJECT_STATUSES.map(id => ({ id, label: statusRef(id) })),
    candidates: (candidates || []).map((candidate) => ({
      id: candidate.key,
      key: candidate.key,
      name: candidate.name,
      summary: candidate.summary || '',
      suggestedStatus: candidate.suggestedStatus || candidate.status,
      confidence: candidate.confidence,
      reason: candidate.reason,
      labels: (candidate.labels || []).map((label) => (typeof label === 'string' ? label : label.label)),
      sources: (candidate.sources || []).map((source) => ({
        kind: source.kind,
        label: source.label || sourceLabel(source),
        ref: source.ref === undefined ? null : source.ref,
      })),
      lastActivityAt: Number.isInteger(candidate.lastActivityAt) ? candidate.lastActivityAt : null,
    })),
  };
}

function buildHistoryPage(events, options = {}) {
  return {
    items: presentHistory(events, options),
    nextCursor: options.nextCursor ?? null,
  };
}

function buildProjectVM(project, historyEvents, options = {}) {
  const cover = (typeof options.coverOf === 'function' ? options.coverOf(project.id) : project.cover) || null;
  const persons = personMap(options.persons);
  const liveStates = options.liveStates || {};
  const stats = options.sessionCounts || {};
  const people = chips(project, persons, liveStates);
  // Conversations can precede persisted people membership (a freshly discovered project, or a cached Discord name).
  // Include all linked sessions, plus recorded sessions, without losing manual roles or hidden-person overrides.
  const keys = new Set([...(options.linkedSessionKeys || []), ...(historyEvents || []).filter((e) => e.kind === 'session').map((e) => e.sessionKey)]);
  for (const key of keys) {
    const info = options.sessionInfo?.(key);
    for (const candidate of info?.people || []) {
      const known = [...persons.values()].find((p) => p.kind === candidate.kind && (p.id === candidate.id ||
        (p.links?.discordUserId && candidate.id === 'discord-user:' + p.links.discordUserId) ||
        (p.links?.agentId && candidate.id === `agent:${p.links.agentId}${p.links.subagentId ? ':subagent:' + p.links.subagentId : ''}`) ||
        (candidate.id.startsWith('sender:') && p.name === candidate.name)));
      const id = known?.id || candidate.id;
      if (options.hiddenPeople?.includes(id) || people.some((p) => p.id === id)) continue;
      const role = info.channel || (candidate.id.includes(':subagent:') ? (options.locale === 'en' ? 'Sub-agent' : 'Sous-agent') : null);
      people.push({ ...candidate, id, role, origin: 'derived', commitCount: null });
    }
  }
  const summaryMeta = project.summaryMeta ? {
    author: actorVm(project.summaryMeta.author, persons, liveStates, options.portability),
    at: project.summaryMeta.at,
  } : null;
  const sourceDescriptors = projectSourceDescriptors(project, options);
  const sessionCount = Object.values(stats).reduce((sum, value) => sum + (Number.isSafeInteger(value?.sessionCount) ? value.sessionCount : 0), 0);
  return {
    id: project.id,
    revision: project.revision,
    name: project.name,
    status: project.status,
    priority: project.priority,
    archived: project.archivedAt != null,
    summary: project.summary,
    summaryMeta,
    thumb: thumbOf(project, options.locale, cover),
    cover,
    flags: sortFlags(project.flags.filter((f) => f.kind !== 'risk' || f.clearedAt == null)).map((flag) => flagVm(flag, options.portability)),
    sources: project.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: sourceLabel(source),
      ref: source.kind === 'manual' ? null : source.ref,
      addedAt: source.addedAt,
      sessionCount: stats[source.id] && Number.isInteger(stats[source.id].sessionCount) ? stats[source.id].sessionCount : null,
    })),
    sourceDescriptors,
    statusLabel: statusRef(project.status),
    statusTransitions: projectCapabilities(project).write ? PROJECT_STATUSES.filter(id => id !== project.status).map(id => ({ id, label: statusRef(id) })) : [],
    counts: { sessions: Object.keys(stats).length ? sessionCount : null,
      agents: people.filter(person => person.kind === 'agent').length,
      activity: Number.isSafeInteger(project.activityCount) ? project.activityCount : null },
    capabilities: projectCapabilities(project),
    capabilityRows: projectCapabilityRows(projectCapabilities(project)),
    repo: repoVm(project, options.locale),
    people,
    recentHistory: presentHistory(historyEvents || [], options),
    historyNextCursor: options.nextCursor ?? null,
    lastActivityAt: project.lastActivityAt,
    createdAt: project.createdAt,
    ...(project.teamProject ? { teamProject: project.teamProject } : {}),
  };
}

module.exports = {
  buildBoardVM, buildProjectVM, buildCandidatesVM, buildHistoryPage, presentHistory, compareCards, projectCapabilities, projectCapabilityRows, sourceLabel, initials, monogramAccent, thumbOf,
  atRisk, involvesTimmy,
};
