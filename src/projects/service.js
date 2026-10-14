'use strict';

const { ProjectError, validation, projectConflictBody } = require('./errors');
const { PROJECT_STATUSES, HISTORY_PAGE } = require('./constants');
const { proposeCandidates, collectGithubRepos, collectWorkspaceFolders } = require('./discovery');
const { linkProjectActivity, projectsForSlug } = require('./activity');
const { createRepoRefresh } = require('./repo-refresh');
const { createGithubSource } = require('./sources/github');
const {
  buildBoardVM, buildProjectVM, buildCandidatesVM, buildHistoryPage, atRisk, involvesTimmy,
} = require('./vm');

const TOPIC_ORDER = [
  'projects',
  'projects?filter=at-risk',
  'projects?filter=with-timmy',
  'projects?filter=archived',
];
const ACTIVITY_TYPES = new Set(['Session', 'CronRun', 'CronJob', 'Transcript', 'Activity', 'Agent', 'Repo']);

function createProjectService(deps = {}) {
  const repository = deps.repository;
  if (!repository) throw new ProjectError('internal', 'Le service n’a pas de dépôt.');
  const clock = deps.clock || (() => Date.now());
  const ids = deps.ids;
  const primarySource = deps.primaryAgentId != null ? deps.primaryAgentId : repository.primaryAgentId;
  const sources = deps.sources || {};
  const publish = typeof deps.publish === 'function' ? deps.publish : () => {};
  let latestCandidates = [];

  const github = githubAdapter(sources);
  const refresher = github ? createRepoRefresh({
    source: github,
    capture: deps.capturer,
    resolve: sources.resolve,
    now: clock,
  }) : null;

  function mint(prefix) {
    if (ids && typeof ids.mint === 'function') return ids.mint(prefix);
    if (typeof repository.mint === 'function') return repository.mint(prefix);
    throw new ProjectError('internal', 'Aucun générateur d’identifiants.');
  }

  function persons() {
    const stored = repository.listPersons();
    const projected = typeof deps.additionalPersons === 'function' ? deps.additionalPersons() : [];
    const byId = new Map(stored.map(row => [row.id, row]));
    for (const person of projected || []) if (person?.id) byId.set(person.id, person);
    return [...byId.values()];
  }

  function currentPrimaryId() {
    const id = typeof primarySource === 'function' ? primarySource() : primarySource;
    return id || null;
  }

  function primaryPersonId() {
    const agentId = currentPrimaryId();
    if (agentId) {
      const person = persons().find((item) => item && item.kind === 'agent' && item.links && item.links.agentId === agentId && !item.links.subagentId);
      if (person) return person.id;
    }
    return repository.timmyPersonId || null;
  }

  function agentActor() {
    const agentId = currentPrimaryId();
    if (agentId) return { kind: 'agent', agentId };
    const person = persons().find((item) => item && item.id === repository.timmyPersonId);
    const fallback = person && person.links && person.links.agentId;
    if (fallback) return { kind: 'agent', agentId: fallback };
    throw validation('error.project.agent-unknown', 'actor', 'agent-unknown');
  }

  function jobNames() {
    const registry = deps.engineRegistry;
    const jobs = registry && registry.cronJobs;
    if (!jobs) return {};
    const out = {};
    for (const job of jobs.values()) {
      if (job && job.id && job.name) out[job.id] = job.name;
    }
    return out;
  }

  function viewContext(projectId, nextCursor) {
    const project = projectId ? repository.getProject(projectId) : null;
    const registry = readRegistry(deps.engineRegistry);
    const linked = project ? linkProjectActivity({ projects: [{ ...project, archivedAt: null }], sessions: registry.sessions,
      projectHints: registry.projectHints, workspaceRoots: repository.workspaceRoots || [] }).matches : [];
    return {
      linkedSessionKeys: linked.filter((m) => m.kind === 'session').map((m) => m.ref),
      hiddenPeople: (repository.overrides?.get(projectId) || []).filter((o) => o.hidden).map((o) => o.personId),
      persons: persons(),
      timmyPersonId: primaryPersonId(),
      primaryAgentId: currentPrimaryId(),
      portability: repository.portability === true,
      locale: repository.locale || undefined,
      timeZone: repository.timeZone || undefined,
      liveStates: {},
      jobNames: jobNames(),
      nextCursor: nextCursor ?? null,
      sessionCounts: projectId && typeof repository.sourceStats === 'function' ? repository.sourceStats(projectId) : {},
      // architect-57: the history's session rows (label, summary, counts) from the engine (src/api/v2/projects.js)
      coverOf: deps.coverOf || null,
      sessionInfo: deps.engineRegistry && typeof deps.engineRegistry.sessionInfo === 'function' ? (key) => deps.engineRegistry.sessionInfo(key) : null,
    };
  }

  function projectVm(id, { includeRuntime = false } = {}) {
    const project = repository.getProject(id) || (typeof deps.additionalProjects === 'function'
      ? (deps.additionalProjects({ includeRuntime }) || []).find(row => row.id === id && row.runtimeProject) : null);
    if (project && project.runtimeProject) {
      const context = viewContext(id, null);
      context.sessionCounts = { runtime: { sessionCount: project.sessionCount } };
      return buildProjectVM(project, [], context);
    }
    if (!project) repository.getHistory(id, { limit: HISTORY_PAGE }); // preserve the repository's normal not-found error
    const page = repository.getHistory(id, { limit: HISTORY_PAGE });
    return buildProjectVM(project, page.events, viewContext(id, page.nextCursor));
  }

  function signature(project) {
    if (!project) return '';
    const newest = repository.getHistory(project.id, { limit: 1 }).events[0];
    const repo = project.repo;
    return [
      project.revision,
      project.lastActivityAt,
      project.archivedAt,
      project.name,
      project.status,
      project.priority,
      project.summary,
      newest ? newest.id : '',
      project.flags.map((flag) => [
        flag.kind, flag.key, flag.state || '', flag.clearedAt || '', flag.ack ? 1 : 0,
      ].join(':')).join(','),
      project.sources.map((source) => source.id).join(','),
      repo ? [repo.fetchedAt, repo.ci && repo.ci.state, repo.image && repo.image.kind, repo.image && repo.image.url].join(':') : '',
    ].join('\n');
  }

  function addTopics(topics, before, after) {
    const people = new Map(persons().map((person) => [person.id, person]));
    const timmy = primaryPersonId();
    const onBoard = (project) => project && project.archivedAt == null;
    const risky = (project) => onBoard(project) && atRisk(project);
    const timmyOn = (project) => onBoard(project) && involvesTimmy(project, people, timmy);
    const archived = (project) => project && project.archivedAt != null;
    if (onBoard(before) || onBoard(after)) topics.add('projects');
    if (risky(before) || risky(after)) topics.add('projects?filter=at-risk');
    if (timmyOn(before) || timmyOn(after)) topics.add('projects?filter=with-timmy');
    if (archived(before) || archived(after)) topics.add('projects?filter=archived');
  }

  function orderTopics(topics, projectIds) {
    const ordered = TOPIC_ORDER.filter((topic) => topics.has(topic));
    for (const id of projectIds) ordered.push(`project:${id}`);
    return ordered;
  }

  function publishPairs(pairs, at) {
    const topics = new Set();
    const projectIds = [];
    for (const { before, after } of pairs) {
      if (after && typeof deps.onProjectChanged === 'function') deps.onProjectChanged(after, before);
      const id = (after || before).id;
      projectIds.push(id);
      topics.add(`project:${id}`);
      addTopics(topics, before, after);
    }
    projectIds.sort();
    const change = { at, projectIds, topics: orderTopics(topics, projectIds) };
    if (projectIds.length) publish(change);
    return change;
  }

  function withConflict(err, id, requestId) {
    if (err instanceof ProjectError && err.code === 'conflict' && err.revision != null && id) {
      err.body = projectConflictBody({ requestId: requestId || 'req_local', vm: projectVm(id) });
    }
    return err;
  }

  function runCommand({ id, requestId, at, call }) {
    const before = id ? repository.getProject(id) : null;
    const beforeSig = signature(before);
    let returned;
    try {
      returned = call();
    } catch (err) {
      throw withConflict(err, id, requestId);
    }
    const afterId = id || (returned && returned.id);
    const after = afterId ? repository.getProject(afterId) : null;
    if (beforeSig !== signature(after)) publishPairs([{ before, after }], at);
    return {
      ok: true,
      result: null,
      revision: after ? after.revision : null,
      vm: after ? projectVm(after.id) : null,
    };
  }

  function actorOf(input) {
    return input.actor || 'owner';
  }

  function atOf(input) {
    return input.at ?? clock();
  }

  const commands = {
    create(input = {}) {
      const at = atOf(input);
      return runCommand({
        requestId: input.requestId,
        at,
        call: () => repository.createProject({
          name: input.name,
          status: input.status,
          priority: input.priority,
          summary: input.summary,
          sources: input.sources,
          actor: actorOf(input),
          at,
        }),
      });
    },

    edit(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.edit({
          id: input.id,
          expectedRevision: input.expectedRevision,
          name: input.name,
          summary: input.summary,
          priority: input.priority,
          actor: actorOf(input),
          at,
        }),
      });
    },

    setStatus(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.setStatus({
          id: input.id,
          expectedRevision: input.expectedRevision,
          status: input.status,
          actor: actorOf(input),
          at,
        }),
      });
    },

    setArchived(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.setArchived({
          id: input.id,
          expectedRevision: input.expectedRevision,
          archived: input.archived,
          actor: actorOf(input),
          at,
        }),
      });
    },

    addFlag(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.addFlag({
          id: input.id,
          expectedRevision: input.expectedRevision,
          kind: input.kind,
          key: input.key,
          label: input.label,
          actor: actorOf(input),
          at,
        }),
      });
    },

    removeFlag(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.removeFlag({
          id: input.id,
          expectedRevision: input.expectedRevision,
          kind: input.kind,
          key: input.key,
          actor: actorOf(input),
          at,
        }),
      });
    },

    ackRisk(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.ackRisk({
          id: input.id,
          expectedRevision: input.expectedRevision,
          key: input.key,
          ack: input.ack,
          actor: actorOf(input),
          at,
        }),
      });
    },

    linkSource(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.linkSource({
          id: input.id,
          expectedRevision: input.expectedRevision,
          source: input.source,
          actor: actorOf(input),
          at,
        }),
      });
    },

    unlinkSource(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.unlinkSource({
          id: input.id,
          expectedRevision: input.expectedRevision,
          sourceId: input.sourceId,
          actor: actorOf(input),
          at,
        }),
      });
    },

    setPersonOverride(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.setPersonOverride({
          id: input.id,
          expectedRevision: input.expectedRevision,
          personId: input.personId,
          role: input.role,
          hidden: input.hidden,
          actor: actorOf(input),
          at,
        }),
      });
    },

    regenerateSummary(input = {}) {
      let claimed;
      try { claimed = repository.claimSummary({ id: input.id, expectedRevision: input.expectedRevision, mintTurn: () => mint('trn') }); }
      catch (err) {
        if (err.details?.some(d => d.issue === 'turn-pending')) throw err;
        throw withConflict(err, input.id, input.requestId);
      }
      return { ok: true, result: { turnId: claimed.turnId }, revision: claimed.project.revision, vm: projectVm(input.id) };
    },

    // Exact durable identity and revision. Progress from a delegated child may keep the same lock.
    completeSummary(input = {}) {
      let completion;
      const written = runCommand({
        id: input.id, requestId: input.requestId, at: atOf(input),
        call: () => {
          completion = repository.completeSummary({
            id: input.id, turnId: input.turnId, expectedRevision: input.expectedRevision,
            summary: input.summary, actor: actorOf(input), at: atOf(input), keepPending: input.keepPending === true,
          });
          return completion.project;
        },
      });
      if (!completion.applied) written.result = { applied: false };
      return written;
    },

    // Clears only this turn; no public revision/history change.
    abandonSummary(input = {}) {
      repository.abandonSummary({ id: input.id, turnId: input.turnId });
      const project = repository.getProject(input.id);
      return { ok: true, result: null, revision: project.revision, vm: projectVm(input.id) };
    },

    appendHistory(input = {}) {
      const at = atOf(input);
      return runCommand({
        id: input.id,
        requestId: input.requestId,
        at,
        call: () => repository.appendHistory({ ...input, actor: input.actor || agentActor(), at }),
      });
    },

    importCandidates(input = {}) {
      const keys = input.keys;
      if (!Array.isArray(keys) || keys.length < 1) throw validation('La sélection est vide.', 'keys', 'empty-selection');
      const overrides = input.overrides || {};
      if (overrides && typeof overrides === 'object') {
        for (const key of Object.keys(overrides)) {
          if (!keys.includes(key)) throw validation('La surcharge ne porte pas sur un projet sélectionné.', 'overrides', 'override-not-selected');
        }
        for (const key of keys) {
          const override = overrides[key];
          if (!override) continue;
          if (override.name != null && (typeof override.name !== 'string' || override.name.length < 1 || override.name.length > 80)) {
            throw validation('Nom invalide.', 'name', 'validation_failed');
          }
          if (override.status != null && !PROJECT_STATUSES.includes(override.status)) {
            throw validation('Statut invalide.', 'status', 'validation_failed');
          }
        }
      }
      const at = atOf(input);
      const result = repository.importCandidates({
        keys,
        overrides,
        candidates: latestCandidates,
        actor: actorOf(input),
        at,
      });
      const created = result.result.created.map((row) => repository.getProject(row.id));
      if (created.length) publishPairs(created.map((project) => ({ before: null, after: project })), at);
      return result;
    },
  };

  const views = {
    board({ filter = 'all', sourceFilterId = null, allowUnknownSourceFilter = false, includeRuntime = false } = {}) {
      const extras = typeof deps.additionalProjects === 'function' ? deps.additionalProjects({ includeRuntime }) : [];
      return buildBoardVM([...repository.listProjects({ archived: 'all' }), ...(Array.isArray(extras) ? extras : [])], {
        filter,
        coverOf: deps.coverOf || null,
        persons: persons(),
        timmyPersonId: primaryPersonId(),
        primaryAgentId: currentPrimaryId(),
        sourceFilterId,
        allowUnknownSourceFilter,
        portability: repository.portability === true,
        locale: repository.locale || undefined,
      });
    },

    project({ id, includeRuntime = false } = {}) {
      return projectVm(id, { includeRuntime });
    },

    async candidates({authorize=()=>{}}={}) {
      authorize();
      const now = clock();
      const guardedSources={...sources,...(sources.exec?{exec:(...args)=>{authorize();return sources.exec(...args);}}:{})};
      const githubRepos = await loadGithub(guardedSources,authorize);
      authorize();
      const workspaceFolders = await loadWorkspaces(guardedSources, repository.workspaceRootIds === true,authorize);
      authorize();
      const groupsOff = sources.capabilities && sources.capabilities.sessionGroups === false;
      const sessionGroups = groupsOff || typeof sources.sessionGroups !== 'function' ? [] : await sources.sessionGroups();
      authorize();
      latestCandidates = proposeCandidates({
        now,
        github: githubRepos,
        workspaces: workspaceFolders,
        sessionGroups,
        owners: sources.owners || repository.githubOwners,
        workspaceRootIds: repository.workspaceRootIds === true,
        portability: repository.portability === true,
        locale: repository.locale || 'fr',
      });
      // architect-54: a conversation-derived candidate (a room, a ticket, a tag) whose slug an active project already answers
      // to is that project, not a new one (its conversations link to it through the tag or the room)
      const active = repository.listProjects({ archived: 'exclude' });
      const slugOfName = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const derived = (x) => x.kind === 'sessionGroup' && x.ref && (x.ref.by !== 'group' || String(x.ref.groupId).startsWith('projet:'));
      latestCandidates = latestCandidates.filter((c) => {
        if (!(c.sources || []).length || !c.sources.every(derived)) return true;
        const slugs = new Set([slugOfName(c.name)].concat(c.sources.filter((x) => x.ref.by === 'group').map((x) => x.ref.name)));
        const tagSlugs = c.sources.filter((x) => String(x.ref.groupId || '').startsWith('projet:')).map((x) => x.ref.name);
        return ![...slugs].some((sl) => projectsForSlug(active, sl).length) && !tagSlugs.some((sl) => repository.tagSlugOwner && repository.tagSlugOwner(sl));
      });
      return buildCandidatesVM(latestCandidates, { scannedAt: now });
    },

    history({ id, cursor, limit } = {}) {
      const page = repository.getHistory(id, { cursor, limit });
      return buildHistoryPage(page.events, viewContext(id, page.nextCursor));
    },

    localStamp(at) {
      const ctx = viewContext();
      return new Intl.DateTimeFormat(ctx.locale || 'fr', {
        timeZone: ctx.timeZone || 'UTC',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(at);
    },
  };

  async function refresh(changeSet) {
    if (changeSet && Array.isArray(changeSet.changes) && !changeSet.refreshRepos) {
      const relevant = changeSet.changes.some((change) => change && ACTIVITY_TYPES.has(change.type));
      if (!relevant) return { at: clock(), projectIds: [], topics: [] };
    }
    const at = clock();
    const before = repository.listProjects({ archived: 'all' });
    const beforeSig = new Map(before.map((project) => [project.id, signature(project)]));
    if (refresher && !changeSet?.skipRepos) {
      const seen = new Set();
      for (const project of before) {
        if (project.archivedAt != null) continue;
        for (const source of project.sources) {
          if (source.kind !== 'github') continue;
          const key = `${source.ref.owner}/${source.ref.repo}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          await refresher.refresh(repository, { owner: source.ref.owner, name: source.ref.repo, at });
        }
      }
    }
    const registry = readRegistry(deps.engineRegistry);
    autoAddTagged(registry.projectHints, at);
    const projects = repository.listProjects({ archived: 'exclude' });
    const linked = linkProjectActivity({
      projects,
      sessions: registry.sessions,
      cronRuns: registry.cronRuns,
      cronJobs: registry.cronJobs,
      agents: registry.agents,
      workspaceRoots: repository.workspaceRoots || [],
      projectHints: registry.projectHints,
      now: at,
    });
    applyTaggedStatuses(projects, registry.projectHints, at);
    for (const project of projects) {
      const row = linked.byProject[project.id];
      if (!row) continue;
      const ingest = row.ingest || {};
      const hasIngest = ['commits', 'flowRuns', 'cronRuns', 'sessions'].some((key) => (ingest[key] || []).length);
      if (hasIngest) {
        repository.ingestActivity({
          id: project.id,
          actor: 'system',
          component: 'scheduler',
          at,
          ...ingest,
        });
      }
      repository.applyProjectRisks({
        id: project.id,
        actor: 'system',
        component: 'risk-monitor',
        at,
        flows: row.riskInput.flows,
        crons: row.riskInput.crons,
      });
    }
    const after = repository.listProjects({ archived: 'all' });
    const pairs = [];
    for (const project of after) {
      if (beforeSig.get(project.id) === signature(project)) continue;
      pairs.push({ before: before.find((row) => row.id === project.id) || null, after: project });
    }
    if (!pairs.length) return { at, projectIds: [], topics: [] };
    return publishPairs(pairs, at);
  }

  // architect-54 · a project tag's status and priority: for each, the newest tag for a project applies once, as the agent,
  // and never over a change of that field made after it (a manual edit is newer and wins). The agent's P0–P9 is the
  // board's own scale (boardPriority). Value-free failures: the board stays as it was.
  const appliedHints = new Set();
  // architect-55 (PM decision) · AUTO-ADD: a slug the agent tagged that no project answers to (archived ones included)
  // and that no tag ever created a project for becomes a project on the board, with the newest title, status and
  // priority among its tags, created as the agent. Once per slug, for good (repository.createTaggedProject claims it).
  function autoAddTagged(hints, at) {
    const newest = new Map();   // slug → { at, title, status, priority }
    const pick = (cur, h, field) => (h[field] && (!cur[field + 'At'] || (h.at || 0) >= cur[field + 'At']) ? { [field]: h[field], [field + 'At']: h.at || 0 } : {});
    for (const h of hints || []) {
      if (!h || typeof h.slug !== 'string') continue;
      const cur = newest.get(h.slug) || {};
      newest.set(h.slug, Object.assign(cur, pick(cur, h, 'title'), pick(cur, h, 'status'), pick(cur, h, 'priority')));
    }
    if (!newest.size) return;
    const all = repository.listProjects({ archived: 'all' });
    const agentId = currentPrimaryId();
    const { boardPriority } = require('./sources/conversations');
    for (const [slug, v] of newest) {
      if (repository.tagSlugOwner(slug) || projectsForSlug(all, slug).length) continue;
      const name = (v.title || (/^[a-z]{2,10}-\d{1,6}$/.test(slug) ? slug.toUpperCase() : slug.replace(/-/g, ' '))).slice(0, 80);
      try {
        repository.createTaggedProject({ slug, name, status: v.status || 'idea', priority: boardPriority(v.priority) || 'P2',
          actor: agentId ? { kind: 'agent', agentId } : 'system', component: 'engine', at });
      } catch (_) { /* invalid input: no project, nothing claimed */ }
    }
  }
  function lastChangeAt(id, kind) {
    try { const e = repository.getHistory(id, { limit: 100 }).events.find((x) => x.kind === kind); return e ? e.at : null; } catch (_) { return null; }
  }
  function applyTaggedStatuses(projects, hints, at) {
    const { boardPriority } = require('./sources/conversations');
    const fresh = (hints || []).filter((h) => h && !appliedHints.has(h.sessionKey + '\0' + h.id));
    for (const h of hints || []) if (h) appliedHints.add(h.sessionKey + '\0' + h.id);
    const agentId = currentPrimaryId();
    const actor = agentId ? { kind: 'agent', agentId } : 'system';
    for (const [field, kind, valueOf] of [['status', 'status', (h) => h.status], ['priority', 'priority', (h) => boardPriority(h.priority)]]) {
      const newest = new Map();   // projectId → { hint, value }
      for (const h of fresh) {
        const value = valueOf(h);
        if (!value) continue;
        for (const p of projectsForSlug(projects, h.slug)) { const cur = newest.get(p.id); if (!cur || (h.at || 0) > (cur.hint.at || 0)) newest.set(p.id, { hint: h, value }); }
      }
      for (const [id, { hint, value }] of newest) {
        const project = repository.getProject(id);
        if (!project || project[field] === value) continue;
        const since = lastChangeAt(id, kind);
        if (since != null && hint.at != null && hint.at <= since) continue;
        try {
          if (field === 'status') repository.setStatus({ id, expectedRevision: project.revision, status: value, actor, component: 'engine', at });
          else repository.edit({ id, expectedRevision: project.revision, priority: value, actor, component: 'engine', at });
        } catch (_) { /* a concurrent edit wins */ }
      }
    }
  }

  return { views, commands, refresh };
}

function githubAdapter(sources) {
  if (sources.github && typeof sources.github.fetch === 'function') return sources.github;
  if (typeof sources.exec === 'function') return createGithubSource({ exec: sources.exec, owners: sources.owners });
  return null;
}

// architect-54: every owner (not only the first), and one owner's failure (gh missing, logged out, rate-limited) costs
// only that owner's repos: logged (value-free), never a failed candidates list
async function loadGithub(sources,authorize=()=>{}) {
  authorize();
  if (typeof sources.githubRepos === 'function') return sources.githubRepos();
  const owners = Array.isArray(sources.owners) && sources.owners.length ? sources.owners : sources.owner ? [sources.owner] : [];
  if (typeof sources.exec !== 'function' || !owners.length) return [];
  const repos = [];
  for (const [i, owner] of owners.entries()) {
    authorize();
    try { repos.push(...await collectGithubRepos({ exec: sources.exec, owner })); } catch (e) {
      if(e instanceof require('../api/v2/errors').ApiError)throw e;
      if (typeof sources.log === 'function') sources.log(`projects: discovery skipped code-host owner #${i + 1} (${(e && e.code) || 'error'})`);
    }
    authorize();
  }
  return repos;
}

async function loadWorkspaces(sources, workspaceRootIds,authorize=()=>{}) {
  authorize();
  if (typeof sources.workspaceFolders === 'function') return sources.workspaceFolders();
  if (workspaceRootIds && Array.isArray(sources.roots) && typeof sources.exec === 'function') {
    const folders = [];
    for (const root of sources.roots) {
      authorize();
      folders.push(...await collectWorkspaceFolders({
        exec: sources.exec, root: root.path, rootId: root.id,authorize,
      }));
    }
    return folders;
  }
  if (typeof sources.exec === 'function' && sources.root) {
    try { return await collectWorkspaceFolders({ exec: sources.exec, root: sources.root,authorize }); } catch (e) {
      authorize();
      if (typeof sources.log === 'function') sources.log(`projects: discovery skipped the workspace root (${(e && e.code) || 'error'})`);
      return [];
    }
  }
  return [];
}

function readRegistry(registry) {
  const sessions = registry && registry.sessions ? [...registry.sessions.values()] : [];
  const cronJobs = registry && registry.cronJobs ? [...registry.cronJobs.values()] : [];
  const agents = registry && registry.agents ? [...registry.agents.values()] : [];
  const cronRuns = [];
  if (registry && registry.cronRuns) {
    for (const bucket of registry.cronRuns.values()) {
      if (Array.isArray(bucket)) cronRuns.push(...bucket);
      else if (bucket && Array.isArray(bucket.runs)) cronRuns.push(...bucket.runs);
    }
  }
  const projectHints = registry && typeof registry.projectHints !== 'undefined' ? [...(registry.projectHints || [])] : [];
  return { sessions, cronJobs, agents, cronRuns, projectHints };
}

module.exports = { createProjectService, TOPIC_ORDER, ACTIVITY_TYPES };
